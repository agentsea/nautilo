import { createHash } from "node:crypto";
import { MemoryMutationAuthorityError } from "./memory-mutation-error";
import { encodeMemoryListCursor } from "@nautilo/types";
export { encodeMemoryListCursor, decodeMemoryListCursor } from "@nautilo/types";
import * as dbModule from "@nautilo/db";
import {
  agentDb as db,
  memories,
  memoryCryptoOperations,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryEmbeddingValues,
  memoryEmbeddingCompatibilityCondition,
  eq,
  and,
  sql,
  desc,
  ilike,
  inArray,
  notInArray,
  lte,
  lt,
  or,
  isNull,
  type RoomLockTransaction,
} from "@nautilo/db";
import {
  withAgentTrustContext,
  withSerializableAgentTrustContext,
  type TrustAgentTx,
} from "./trust-agent-db";
import {
  assertNamespaceWriteAccess,
  emitMemoryAudit,
  memoryAuditMetaFromTrust,
  withMemoryAudit,
} from "./memory-write-access";
import { embedTextWithProvenance, type EmbeddingWithProvenanceV1 } from "./embeddings";
import { fromRuntimeConfig } from "@nautilo/config";
import { log } from "@nautilo/logger";
import { emitAuthoredMemorySemanticChange } from "./authored-memory-semantic-change";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const DEFAULT_IMPORTANCE: Record<string, number> = {
  identity: 1.0,
  goal: 0.9,
  decision: 0.8,
  preference: 0.7,
  fact: 0.6,
  event: 0.5,
  observation: 0.4,
  todo: 0.3,
};

/** Opaque checkpoint keys are UUID/hash-sized; reject unbounded caller input. */
const MAX_FORCE_CREATE_KEY_LENGTH = 256;
/** PostgreSQL `real` is float4, so replay values need float4-safe equality. */
const FORCE_CREATE_IMPORTANCE_EPSILON = 0.000001;

/** Input trust shape for memory-store APIs; `userId` is required at runtime (fail-closed via `withAgentTrustContext`). */
export interface MemoryTrustContext {
  userId?: string | undefined;
  agentId?: string | undefined;
  auditActorId?: string | null | undefined;
  auditIp?: string | undefined;
  auditUserAgent?: string | undefined;
}

function asMemoryDb(tx: TrustAgentTx): typeof db {
  return tx as unknown as typeof db;
}

function withMemoryTrustContext<T>(
  trust: MemoryTrustContext | undefined,
  fn: (handle: typeof db) => Promise<T>,
): Promise<T> {
  return withAgentTrustContext(
    {
      userId: trust?.userId ?? "",
      ...(trust?.agentId ? { agentId: trust.agentId } : {}),
    },
    async (tx) => fn(asMemoryDb(tx)),
  );
}

export interface SaveMemoryOptions {
  /** Authenticated speaker users.id; set by product/runtime paths. */
  userId?: string;
  /**
   * M042A: which agent is saving this memory. Required. `saveMemory` uses it
   * in the vector dedup pre-check (M076) so one agent cannot update another
   * agent’s memory in the same namespace.
   */
  agentId: string;
  type: string;
  content: string;
  importance?: number;
  /** M076: pinned to `memory_namespaces`; equals writableNamespaces[0] from the envelope. */
  namespaceId?: string;
}

/**
 * Frozen, server-owned input for the only projection write seam.  None of
 * these fields comes from model arguments on approval resume.
 */
export interface AtomicProjectionMemoryOptions extends MemoryTrustContext {
  userId: string;
  agentId: string;
  requesterActorId: string;
  sourceFingerprints: readonly Readonly<{ id: string; contentHash: string }>[];
  /** Exact readable authority captured before approval. */
  frozenReadableNamespaceIds: readonly string[];
  frozenReadableAuthorityFingerprint: string;
  /** Current envelope authority, supplied by the resumed foreground turn. */
  currentReadableNamespaceIds: readonly string[];
  content: string;
  contentHash: string;
  type: string;
  importance: number;
  roomId: string;
  namespaceId: string;
  roomLabel: string;
  roomKind: string;
  audienceFingerprint: string;
  creationKey: string;
  expiresAt: number;
}

export type AtomicProjectionMemoryResult =
  | Readonly<{ status: "created"; memoryId: string }>
  | Readonly<{ status: "replayed"; memoryId: string }>
  | Readonly<{ status: "stale"; reason: ProjectionStaleReason }>
  | Readonly<{
      status: "idempotency_conflict";
      reason: "creation_key_mismatch";
    }>;

export type ProjectionStaleReason =
  | "expired"
  | "snapshot_tampered"
  | "requester_actor_changed"
  | "capability_lost"
  | "destination_changed"
  | "destination_membership_changed"
  | "source_authority_changed"
  | "source_changed"
  | "serialization_conflict";

/** Canonical D476 destination authority lock, reusable by protected Memory
 * publication inside its existing serializable product transaction. */
export async function lockAtomicProjectionDestinationAuthority(
  handle: Pick<typeof db, "execute" | "select"> & RoomLockTransaction,
  input: Pick<
    AtomicProjectionMemoryOptions,
    | "roomId"
    | "namespaceId"
    | "roomLabel"
    | "roomKind"
    | "requesterActorId"
    | "userId"
    | "audienceFingerprint"
  >,
): Promise<Exclude<
  ProjectionStaleReason,
  | "expired"
  | "snapshot_tampered"
  | "source_authority_changed"
  | "source_changed"
  | "serialization_conflict"
> | null> {
  await dbModule.acquireRoomWriteLock(handle, input.roomId);
  const room = await dbModule.findProjectionRoomByIdWith(handle, input.roomId);
  if (
    !room ||
    room.archivedAt !== null ||
    room.namespaceId !== input.namespaceId ||
    room.label !== input.roomLabel ||
    room.kind !== input.roomKind ||
    !isKnownProjectionRoomKind(room.kind)
  )
    return "destination_changed";
  const actorRows = rowsFromExecute(
    await handle.execute<{ id: string }>(sql`
    SELECT id FROM actors
    WHERE id = ${input.requesterActorId}::uuid
      AND owner_id = ${input.userId}::uuid AND kind = 'user'
    FOR UPDATE
  `),
  );
  if (actorRows.length !== 1) return "requester_actor_changed";
  type LockedMember = { actorId: string; actorKind: string; ownerId: string };
  const members = rowsFromExecute(
    await handle.execute<LockedMember>(sql`
    SELECT rm.actor_id AS "actorId", a.kind AS "actorKind", a.owner_id AS "ownerId"
    FROM room_members rm INNER JOIN actors a ON a.id = rm.actor_id
    WHERE rm.room_id = ${input.roomId}::uuid
    ORDER BY a.kind, a.owner_id, rm.actor_id FOR UPDATE OF rm, a
  `),
  );
  const inventory = members
    .map((member) => `${member.actorKind}:${member.ownerId}:${member.actorId}`)
    .join("\n");
  if (
    !members.some(
      (member) =>
        member.actorId === input.requesterActorId &&
        member.actorKind === "user" &&
        member.ownerId === input.userId,
    ) ||
    fingerprintProjectionAudience(input.roomId, inventory) !==
      input.audienceFingerprint
  )
    return "destination_membership_changed";
  const capabilities = rowsFromExecute(
    await handle.execute<{ groupId: string }>(sql`
    SELECT gm.group_id AS "groupId"
    FROM group_members gm INNER JOIN groups g ON g.id = gm.group_id
    INNER JOIN group_roles gr ON gr.group_id = g.id
    INNER JOIN roles r ON r.id = gr.role_id
    INNER JOIN role_capabilities rc ON rc.role_id = r.id
    INNER JOIN capabilities c ON c.id = rc.capability_id
    WHERE gm.user_id = ${input.userId}::uuid AND c.slug = 'manage_memories'
    ORDER BY gm.group_id, gr.role_id, rc.capability_id
    FOR SHARE OF gm, g, gr, r, rc, c
  `),
  );
  return capabilities.length === 0 ? "capability_lost" : null;
}

export interface SearchMemoryOptions {
  signal?: AbortSignal;
  /** Authenticated speaker users.id; set by product/runtime paths. */
  userId?: string;
  /**
   * M042A: when set, only memories for this agent (or legacy NULL agent_id) match.
   */
  agentId?: string;
  query: string;
  limit?: number;
  includeArchive?: boolean;
  /** Namespace overlap filter. Empty array ⇒ no readable memories (M081). */
  namespaceIds?: string[];
  /** D234 — `text` skips vector; `vector` skips text fallback. */
  mode?: "text" | "vector";
}

export interface MemoryListItem {
  id: string;
  type: string | null;
  content: string | null;
  importance: number;
  tier: number;
  createdAt: Date;
  updatedAt: Date;
  namespaceIds: string[];
}

export interface MemoryDetail extends MemoryListItem {
  demotedAt: Date | null;
  demotedFrom: number | null;
}

export type HardDeleteMemoryResult =
  | { status: "deleted" }
  | { status: "detached_only" }
  | { status: "blocked"; namespaceCount: number; namespaceIds: string[] };

export interface ListMemoriesOptions {
  namespaceIds: string[];
  /**
   * D328 — exclude memories attached to ANY of these namespaces. Used for the
   * "private only" audience filter: list memories in your private namespace(s)
   * but drop any also attached to a shared namespace (audience > you).
   */
  excludeNamespaceIds?: string[];
  userId?: string;
  agentId?: string;
  limit?: number;
  cursor?: { createdAt: Date; id: string };
  includeArchive?: boolean;
}

export interface MemoryResult {
  id: string;
  type: string;
  content: string;
  importance: number;
  tier: number;
  score: number;
  createdAt: Date;
}

export interface PromptBriefMemory {
  id: string;
  type: string;
  content: string;
  importance: number;
  tier: 1;
  createdAt: Date;
}

export interface StagedPromptBriefMemories {
  readonly memories: readonly PromptBriefMemory[];
  readonly overflowIds: readonly string[];
}

export interface PromptBriefMemoryStructural {
  readonly representation: "structural";
  readonly id: string;
  readonly contentRevision: number;
  readonly type: null;
  readonly importance: number;
  readonly tier: 1;
  readonly createdAt: Date;
}

export interface PromptBriefMemoryStructuralCursor {
  readonly importance: number;
  readonly createdAt: Date;
  readonly id: string;
}

export interface PromptBriefMemoryStructuralPage {
  readonly memories: readonly PromptBriefMemoryStructural[];
  readonly nextCursor?: PromptBriefMemoryStructuralCursor;
}

export function matchesPromptBriefMemoryStructuralSelection(
  selection: PromptBriefMemoryStructural,
  row: Readonly<{ id: string; contentRevision: number; importance: number;
    createdAt: Date }>,
): boolean {
  return row.id === selection.id
    && row.contentRevision === selection.contentRevision
    && row.importance === selection.importance
    && row.createdAt.getTime() === selection.createdAt.getTime();
}

// A physical working-set batch only. It is not an eligibility or account cap;
// callers keyset through every page under the invocation deadline.
const PROTECTED_PROMPT_MEMORY_PAGE_SIZE = 64;

type ExecuteResultRows<T> = T[] | { rows: T[] };

function rowsFromExecute<T>(result: ExecuteResultRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

export async function saveMemory(
  opts: SaveMemoryOptions,
): Promise<{ id: string; action: "created" | "updated"; similarity?: number }> {
  const auditMeta = memoryAuditMetaFromTrust(opts);
  try {
    const embedding = await embedTextWithProvenance(opts.content);
    const result = await withSerializableAgentTrustContext(
      { userId: opts.userId ?? "", agentId: opts.agentId },
      (tx) => saveMemoryWithDb(asMemoryDb(tx), opts, { embedding }),
    );
    emitMemoryAudit({
      kind: "memory.edit",
      memoryId: result.id,
      action: "save",
      outcome: "success",
      ...(opts.namespaceId ? { namespaceId: opts.namespaceId } : {}),
      actorId: auditMeta.actorId ?? null,
      ip: auditMeta.ip ?? "",
      userAgent: auditMeta.userAgent,
    });
    if (result.action === "updated") {
      await emitAuthoredMemorySemanticChange(result.id, "replace");
    }
    return result;
  } catch (err) {
    emitMemoryAudit({
      kind: "memory.edit",
      memoryId: "unknown",
      action: "save",
      outcome: "failure",
      errorKind: err instanceof Error ? err.name : "Error",
      ...(opts.namespaceId ? { namespaceId: opts.namespaceId } : {}),
      actorId: auditMeta.actorId ?? null,
      ip: auditMeta.ip ?? "",
      userAgent: auditMeta.userAgent,
    });
    throw err;
  }
}

type ForceCreatedMemory = {
  id: string;
  content: string;
  type: string;
  importance: number;
  namespaceIds: string[] | null;
};

function assertForceCreateReplayMatches(
  existing: ForceCreatedMemory,
  opts: Pick<AtomicProjectionMemoryOptions, "content" | "namespaceId" | "type">,
  importance: number,
): void {
  const namespaceIds = existing.namespaceIds ?? [];
  const exactDestination =
    namespaceIds.length === 1 && namespaceIds[0] === opts.namespaceId;
  if (
    existing.content !== opts.content ||
    existing.type !== opts.type ||
    !forceCreateImportanceMatches(existing.importance, importance) ||
    !exactDestination
  ) {
    throw new Error(
      "force-create creation key mismatch with frozen projection",
    );
  }
}

function forceCreateImportanceMatches(
  existing: number,
  expected: number,
): boolean {
  if (!Number.isFinite(existing) || !Number.isFinite(expected)) return false;
  return (
    Math.abs(existing - expected) <=
    FORCE_CREATE_IMPORTANCE_EPSILON *
      Math.max(1, Math.abs(existing), Math.abs(expected))
  );
}

const PROJECTION_CREATION_KEY_PATTERN =
  /^projection:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertForceCreateKey(creationKey: string): void {
  if (
    typeof creationKey !== "string" ||
    creationKey.length > MAX_FORCE_CREATE_KEY_LENGTH ||
    !PROJECTION_CREATION_KEY_PATTERN.test(creationKey)
  ) {
    throw new Error("force-create creation key must use projection:<UUID>");
  }
}

const PROJECTION_AUDIENCE_FINGERPRINT_PREFIX = "d476:room-audience:v1\u0000";
const PROJECTION_AUTHORITY_FINGERPRINT_PREFIX =
  "d476:readable-authority:v1\u0000";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable server-only fingerprint for the exact readable Namespace envelope. */
export function fingerprintProjectionReadableAuthority(
  namespaceIds: readonly string[],
): string {
  return createHash("sha256")
    .update(
      `${PROJECTION_AUTHORITY_FINGERPRINT_PREFIX}${canonicalIds(namespaceIds).join("\u0000")}`,
      "utf8",
    )
    .digest("hex");
}

function fingerprintProjectionAudience(
  roomId: string,
  membershipRows: string,
): string {
  return createHash("sha256")
    .update(
      `${PROJECTION_AUDIENCE_FINGERPRINT_PREFIX}${roomId}\u0000${membershipRows}`,
      "utf8",
    )
    .digest("hex");
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function hasSameIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = canonicalIds(left);
  const b = canonicalIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function isKnownProjectionRoomKind(kind: string): boolean {
  return (
    kind === "private" ||
    kind === "group" ||
    kind === "multi_agent" ||
    kind === "open"
  );
}

function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "40001") return true;
  return (
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    (candidate.cause as { code?: unknown }).code === "40001"
  );
}

function isCreationKeyRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (
    candidate.code === "23505" &&
    candidate.constraint === "uq_memories_creation_key"
  )
    return true;
  return (
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    isCreationKeyRace(candidate.cause)
  );
}

/**
 * Revalidates a frozen projection and creates its destination-only Memory in
 * one serializable agent-role transaction.  The Room row is locked first;
 * every room-membership writer uses that same lock.  Serializable isolation
 * additionally turns a bypassing membership/capability phantom into a retry
 * or fail-closed stale result rather than an authorized write.
 */
export async function executeAtomicProjectionMemory(
  opts: AtomicProjectionMemoryOptions,
): Promise<AtomicProjectionMemoryResult> {
  const auditMeta = memoryAuditMetaFromTrust(opts);
  try {
    const result = await executeAtomicProjectionMemoryWithoutAudit(opts);
    const succeeded =
      result.status === "created" || result.status === "replayed";
    emitMemoryAudit({
      kind: "memory.edit",
      memoryId: succeeded ? result.memoryId : "unknown",
      action: "save",
      outcome: succeeded ? "success" : "failure",
      ...(!succeeded ? { errorKind: `Projection_${result.reason}` } : {}),
      namespaceId: opts.namespaceId,
      actorId: auditMeta.actorId ?? null,
      ip: auditMeta.ip ?? "",
      userAgent: auditMeta.userAgent,
    });
    return result;
  } catch (error) {
    emitMemoryAudit({
      kind: "memory.edit",
      memoryId: "unknown",
      action: "save",
      outcome: "failure",
      errorKind: error instanceof Error ? error.name : "Error",
      namespaceId: opts.namespaceId,
      actorId: auditMeta.actorId ?? null,
      ip: auditMeta.ip ?? "",
      userAgent: auditMeta.userAgent,
    });
    throw error;
  }
}

async function executeAtomicProjectionMemoryWithoutAudit(
  opts: AtomicProjectionMemoryOptions,
): Promise<AtomicProjectionMemoryResult> {
  if (opts.expiresAt <= Date.now())
    return { status: "stale", reason: "expired" };
  if (
    !isKnownProjectionRoomKind(opts.roomKind) ||
    !opts.content ||
    sha256(opts.content) !== opts.contentHash ||
    !hasSameIds(
      opts.frozenReadableNamespaceIds,
      opts.currentReadableNamespaceIds,
    ) ||
    fingerprintProjectionReadableAuthority(opts.frozenReadableNamespaceIds) !==
      opts.frozenReadableAuthorityFingerprint ||
    opts.sourceFingerprints.length === 0 ||
    new Set(opts.sourceFingerprints.map((source) => source.id)).size !==
      opts.sourceFingerprints.length
  ) {
    return { status: "stale", reason: "snapshot_tampered" };
  }
  try {
    assertForceCreateKey(opts.creationKey);
  } catch {
    return { status: "stale", reason: "snapshot_tampered" };
  }

  // Preserve crash-safe replay without touching the embedding provider. This
  // lookup is only an optimization: the serializable transaction below still
  // revalidates every authority and checks the key again before returning it.
  const preexistingId = await withMemoryTrustContext(
    { userId: opts.userId, agentId: opts.agentId },
    (handle) =>
      dbModule.findMemoryIdByCreationKeyWith(handle, opts.creationKey),
  );
  // Embedding is intentionally outside the Room/source lock window. The
  // authoritative transaction starts only after it is ready, then locks and
  // revalidates immediately before the insert. Reusing this value also means
  // a SERIALIZABLE retry never produces a second embedding request.
  const embedding = preexistingId ? null : await embedTextWithProvenance(opts.content);

  // A serialization retry is safe: the creation key makes a retry return the
  // original row, and `embedding` is immutable across attempts.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withSerializableAgentTrustContext(
        { userId: opts.userId, agentId: opts.agentId },
        async (tx) =>
          executeAtomicProjectionMemoryInTx(asMemoryDb(tx), opts, embedding),
      );
    } catch (error) {
      const retryable =
        isSerializationFailure(error) || isCreationKeyRace(error);
      if (retryable && attempt === 0) continue;
      if (retryable) {
        return { status: "stale", reason: "serialization_conflict" };
      }
      throw error;
    }
  }
  return { status: "stale", reason: "serialization_conflict" };
}

async function executeAtomicProjectionMemoryInTx(
  handle: typeof db,
  opts: AtomicProjectionMemoryOptions,
  embedding: EmbeddingWithProvenanceV1 | null,
): Promise<AtomicProjectionMemoryResult> {
  if (opts.expiresAt <= Date.now())
    return { status: "stale", reason: "expired" };
  const destinationStale = await lockAtomicProjectionDestinationAuthority(
    handle,
    opts,
  );
  if (destinationStale !== null) {
    return { status: "stale", reason: destinationStale };
  }

  const sourceIds = opts.sourceFingerprints
    .map((source) => source.id)
    .sort((left, right) => left.localeCompare(right));
  type LockedSource = { id: string; content: string };
  const sourceRows = rowsFromExecute(
    await handle.execute<LockedSource>(sql`
    SELECT id, content
    FROM memories
    WHERE id = ANY(ARRAY[${sql.join(
      sourceIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])
    ORDER BY id
    FOR UPDATE
  `),
  );
  type LockedSourceEdge = { memoryId: string; namespaceId: string };
  const sourceEdges = rowsFromExecute(
    await handle.execute<LockedSourceEdge>(sql`
    SELECT memory_id AS "memoryId", namespace_id AS "namespaceId"
    FROM memory_namespaces
    WHERE memory_id = ANY(ARRAY[${sql.join(
      sourceIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])
    ORDER BY memory_id, namespace_id
    FOR UPDATE
  `),
  );
  const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
  const sourceNamespaces = new Map<string, string[]>();
  for (const edge of sourceEdges) {
    const namespacesForSource = sourceNamespaces.get(edge.memoryId) ?? [];
    namespacesForSource.push(edge.namespaceId);
    sourceNamespaces.set(edge.memoryId, namespacesForSource);
  }
  for (const frozen of opts.sourceFingerprints) {
    const source = sourceById.get(frozen.id);
    if (!source || sha256(source.content) !== frozen.contentHash) {
      return { status: "stale", reason: "source_changed" };
    }
    const currentlyReadable = sourceNamespaces
      .get(frozen.id)
      ?.some((namespaceId) =>
        opts.frozenReadableNamespaceIds.includes(namespaceId),
      );
    if (!currentlyReadable)
      return { status: "stale", reason: "source_authority_changed" };
  }

  const importance = opts.importance;
  const existing = await getForceCreatedMemoryByKeyForUpdate(
    handle,
    opts.creationKey,
  );
  if (existing) {
    try {
      assertForceCreateReplayMatches(existing, opts, importance);
      return { status: "replayed", memoryId: existing.id };
    } catch {
      return {
        status: "idempotency_conflict",
        reason: "creation_key_mismatch",
      };
    }
  }

  // No embedding provider work occurs while the Room/membership/source locks
  // are held. A preflight replay has no embedding; if that row vanished before
  // this serializable revalidation, fail closed rather than write a new row.
  if (!embedding) return { status: "stale", reason: "serialization_conflict" };
  const id = crypto.randomUUID();
  // Do not use INSERT ... RETURNING here. The memories SELECT policy requires
  // a readable Namespace edge, which intentionally does not exist until the
  // next statement. Both statements remain atomic inside this serializable
  // transaction, while the base INSERT policy only requires authenticated
  // trust context (the same lifecycle used by saveMemory).
  await handle.insert(memories).values({
    id, tier: 1, type: opts.type, content: opts.content, importance,
    ...memoryEmbeddingValues(embedding, 0), creationKey: opts.creationKey,
  });
  await handle.insert(memoryNamespaces).values({
    memoryId: id,
    namespaceId: opts.namespaceId,
  });
  return { status: "created", memoryId: id };
}

async function getForceCreatedMemoryByKeyForUpdate(
  handle: typeof db,
  creationKey: string,
): Promise<ForceCreatedMemory | null> {
  const rows = rowsFromExecute(
    await handle.execute<{
      id: string;
      content: string;
      type: string;
      importance: number;
    }>(sql`
    SELECT id, content, type, importance
    FROM memories
    WHERE creation_key = ${creationKey}
    FOR UPDATE
  `),
  );
  const memory = rows[0];
  if (!memory) return null;
  const edges = rowsFromExecute(
    await handle.execute<{ namespaceId: string }>(sql`
    SELECT namespace_id AS "namespaceId"
    FROM memory_namespaces
    WHERE memory_id = ${memory.id}::uuid
    ORDER BY namespace_id
    FOR UPDATE
  `),
  );
  return { ...memory, namespaceIds: edges.map((edge) => edge.namespaceId) };
}

export async function saveMemoryWithDb(
  handle: typeof db,
  opts: SaveMemoryOptions,
  prepared?: {
    embedding: EmbeddingWithProvenanceV1;
    id?: string;
    expectedDedupId?: string | null;
  },
): Promise<{ id: string; action: "created" | "updated"; similarity?: number }> {
  const { type, content, namespaceId } = opts;
  const importance = opts.importance ?? DEFAULT_IMPORTANCE[type] ?? 0.6;
  const embedding = prepared?.embedding ?? (await embedTextWithProvenance(content));
  const top = await findMemorySaveTargetWithDb(handle, opts, embedding);
  if (top) {
    if (
      prepared &&
      "expectedDedupId" in prepared &&
      prepared.expectedDedupId !== top.id
    )
      throw new Error("memory_dedup_changed");
    log(
      `[memory-store] Dedup: updating existing memory ${top.id} (similarity: ${top.score.toFixed(3)})`,
    );
    await handle.update(memories).set({
      content, type, importance,
      ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
      updatedAt: new Date(),
    }).where(eq(memories.id, top.id));
    return { id: top.id, action: "updated", similarity: top.score };
  }

  if (prepared?.expectedDedupId) throw new Error("memory_dedup_changed");
  const id = prepared?.id ?? crypto.randomUUID();

  await handle.insert(memories).values({
    id, tier: 1, type, content, importance, ...memoryEmbeddingValues(embedding, 0),
  });

  if (namespaceId) {
    await attachMemoryToNamespaceWithDb(handle, id, namespaceId);
  }

  log(`[memory-store] Saved memory ${id}`);
  return { id, action: "created" };
}

export type ForegroundMemoryOrdinaryFallbackInput = Readonly<{
  operationId: string;
  agentId: string;
  memoryId: string;
  expectedContentRevision: number;
  resultContentRevision: number;
  expectedAccessRevision: number;
  expectedCryptoObjectId: string | null;
  expectedRequiredNamespaceFingerprint: Uint8Array | null;
  reservationDigest: Uint8Array;
  reservedCryptoObjectId: string;
  action: "save" | "replace";
  type?: string;
  content: string;
  importance: number;
  namespaceId?: string;
  expectedDedupId?: string | null;
  embedding: readonly number[];
  embeddingProvider: "openai" | "openrouter" | "venice";
  embeddingModel: string;
  embeddingDimensions: 1536;
  embeddingContractVersion: number;
  reason: "encryption_pending" | "target_encryption_not_ready";
}>;

/** Atomic ordinary Shadow fallback; caller owns canonical policy/authority fences. */
export async function commitForegroundMemoryOrdinaryFallback(
  transaction: CanonicalTranscriptTx,
  input: ForegroundMemoryOrdinaryFallbackInput,
): Promise<
  Readonly<{ id: string; action: "created" | "updated"; similarity?: number }>
> {
  if (
    typeof transaction !== "object" ||
    transaction === null ||
    !("execute" in transaction) ||
    !("select" in transaction) ||
    !("insert" in transaction) ||
    !("update" in transaction)
  ) {
    throw new TypeError(
      "Foreground Memory fallback requires an actual canonical Drizzle transaction",
    );
  }
  // This conversion is confined to the canonical Memory owner. The transaction
  // is never returned or accepted from an unverified product caller.
  const handle = asMemoryDb(transaction);
  if (input.embeddingContractVersion !== 1) throw new TypeError("Unsupported Memory embedding contract");
  const preparedEmbedding: EmbeddingWithProvenanceV1 = {
    vector: input.embedding, provider: input.embeddingProvider,
    canonicalModel: input.embeddingModel, dimensions: input.embeddingDimensions,
    contractVersion: input.embeddingContractVersion,
  };
  const finalEmbeddingValues = memoryEmbeddingValues(preparedEmbedding, input.resultContentRevision);
  let result: Readonly<{
    id: string;
    action: "created" | "updated";
    similarity?: number;
  }>;
  if (input.action === "save") {
    if (input.type === undefined)
      throw new TypeError("Memory fallback save type is missing");
    result = await saveMemoryWithDb(
      handle,
      {
        agentId: input.agentId,
        type: input.type,
        content: input.content,
        importance: input.importance,
        ...(input.namespaceId === undefined
          ? {}
          : { namespaceId: input.namespaceId }),
      },
      {
        embedding: preparedEmbedding,
        id: input.memoryId,
        expectedDedupId: input.expectedDedupId ?? null,
      },
    );
  } else {
    await replaceMemoryWithDb(
      handle,
      input.memoryId,
      input.content,
      undefined,
      preparedEmbedding,
    );
    result = Object.freeze({ id: input.memoryId, action: "updated" as const });
  }
  if (result.id !== input.memoryId)
    throw new MemoryMutationAuthorityError("source_changed");
  const now = new Date();
  const product = await handle
    .update(memories)
    .set({
      contentRevision: input.resultContentRevision,
      cryptoObjectId: null,
      cryptoRequiredNamespaceFingerprint: null,
      cryptoMappingState: "unmapped",
      ...finalEmbeddingValues,
      updatedAt: now,
    })
    .where(
      and(
        eq(memories.id, input.memoryId),
        eq(memories.contentRevision, input.expectedContentRevision),
        eq(memories.cryptoAccessRevision, input.expectedAccessRevision),
        input.expectedCryptoObjectId === null
          ? isNull(memories.cryptoObjectId)
          : eq(memories.cryptoObjectId, input.expectedCryptoObjectId),
        input.expectedRequiredNamespaceFingerprint === null
          ? isNull(memories.cryptoRequiredNamespaceFingerprint)
          : eq(
              memories.cryptoRequiredNamespaceFingerprint,
              input.expectedRequiredNamespaceFingerprint,
            ),
      ),
    )
    .returning({ id: memories.id });
  if (product.length !== 1)
    throw new MemoryMutationAuthorityError("source_changed");
  const abandoned = await handle
    .update(memoryCryptoRevisions)
    .set({
      disposition: "superseded",
      updatedAt: now,
    })
    .where(
      and(
        eq(memoryCryptoRevisions.memoryId, input.memoryId),
        eq(memoryCryptoRevisions.contentRevision, input.resultContentRevision),
        eq(memoryCryptoRevisions.cryptoObjectId, input.reservedCryptoObjectId),
        eq(
          memoryCryptoRevisions.allocationRequestDigest,
          input.reservationDigest,
        ),
        eq(memoryCryptoRevisions.disposition, "active"),
      ),
    )
    .returning({ sequence: memoryCryptoRevisions.sequence });
  if (abandoned.length !== 1)
    throw new MemoryMutationAuthorityError("source_changed");
  const receipt = await handle
    .update(memoryCryptoOperations)
    .set({
      completion: "ordinary_fallback",
      disposition: "complete",
      ordinaryFallbackCompletedAt: now,
      ordinaryFallbackReason: input.reason,
      semanticChangeKind: input.expectedContentRevision > 0 ? "replace" : null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(memoryCryptoOperations.operationId, input.operationId),
        eq(memoryCryptoOperations.memoryId, input.memoryId),
        eq(
          memoryCryptoOperations.expectedContentRevision,
          input.expectedContentRevision,
        ),
        eq(
          memoryCryptoOperations.resultContentRevision,
          input.resultContentRevision,
        ),
        eq(memoryCryptoOperations.requestDigest, input.reservationDigest),
        eq(memoryCryptoOperations.completion, "pending"),
        eq(memoryCryptoOperations.disposition, "active"),
      ),
    )
    .returning({ sequence: memoryCryptoOperations.sequence });
  if (receipt.length !== 1)
    throw new MemoryMutationAuthorityError("source_changed");
  return result;
}

export async function searchMemory(
  opts: SearchMemoryOptions,
): Promise<MemoryResult[]> {
  return withMemoryTrustContext(
    { userId: opts.userId, agentId: opts.agentId },
    (handle) => searchMemoryWithDb(handle, opts),
  );
}

async function searchMemoryWithDb(
  handle: typeof db,
  opts: SearchMemoryOptions,
): Promise<MemoryResult[]> {
  const config = fromRuntimeConfig();
  const namespaceIds = opts.namespaceIds ?? [];
  if (namespaceIds.length === 0) return [];

  const {
    query,
    limit = config.nautilo_memory_search_limit,
    includeArchive = false,
    agentId,
    mode,
  } = opts;

  if (mode === "text") {
    return searchByText(
      handle,
      query,
      limit,
      includeArchive,
      namespaceIds,
      agentId,
    );
  }

  const embedding = await embedTextWithProvenance(query, opts.signal);

  const results = await searchByVector(
    handle,
    embedding,
    limit,
    includeArchive,
    namespaceIds,
    agentId,
  );

  if (mode === "vector") {
    return results;
  }

  if (results.length === 0) {
    return searchByText(
      handle,
      query,
      limit,
      includeArchive,
      namespaceIds,
      agentId,
    );
  }

  return results;
}

export async function replaceMemory(
  memoryId: string,
  newContent: string,
  mutableNamespaceIds?: string[],
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) =>
    withMemoryAudit(
      { kind: "memory.edit", memoryId, action: "replace" },
      memoryAuditMetaFromTrust(trust),
      () =>
        replaceMemoryWithDb(handle, memoryId, newContent, mutableNamespaceIds),
    ),
  );
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "replace");
}

export async function replaceMemoryWithDb(
  handle: typeof db,
  memoryId: string,
  newContent: string,
  mutableNamespaceIds?: string[],
  preparedEmbedding?: EmbeddingWithProvenanceV1,
): Promise<boolean> {
  if (mutableNamespaceIds && mutableNamespaceIds.length > 0) {
    const memoryNamespaceIds = await getMemoryNamespacesWithDb(
      handle,
      memoryId,
    );
    assertNamespaceWriteAccess(
      memoryNamespaceIds,
      mutableNamespaceIds,
      memoryId,
    );
  }

  const existing = await handle
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);
  const prevContent = existing[0]?.content;
  if (prevContent === newContent) {
    await handle
      .update(memories)
      .set({ updatedAt: new Date() })
      .where(eq(memories.id, memoryId));
    log(
      `[memory-store] Replaced memory ${memoryId} (content unchanged, skipped re-embed)`,
    );
    return false;
  }

  const embedding = preparedEmbedding ?? (await embedTextWithProvenance(newContent));

  await handle.update(memories).set({
    content: newContent,
    ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
    updatedAt: new Date(),
  }).where(eq(memories.id, memoryId));

  log(`[memory-store] Replaced memory ${memoryId}`);
  return existing.length === 1;
}

export async function demoteMemory(
  memoryId: string,
  mutableNamespaceIds?: string[],
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) =>
    withMemoryAudit(
      { kind: "memory.delete", memoryId, mode: "archive" },
      memoryAuditMetaFromTrust(trust),
      () => demoteMemoryWithDb(handle, memoryId, mutableNamespaceIds),
    ),
  );
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "demote");
}

export async function demoteMemoryWithDb(
  handle: typeof db,
  memoryId: string,
  mutableNamespaceIds?: string[],
): Promise<boolean> {
  const rows = await handle
    .select({ tier: memories.tier })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`Memory ${memoryId} not found`);

  const memoryNamespaceIds = await getMemoryNamespacesWithDb(handle, memoryId);
  assertNamespaceWriteAccess(memoryNamespaceIds, mutableNamespaceIds, memoryId);

  if (row.tier >= 3) return false;

  await handle
    .update(memories)
    .set({
      demotedFrom: row.tier,
      tier: row.tier + 1,
      demotedAt: new Date(),
    })
    .where(eq(memories.id, memoryId));

  log(
    `[memory-store] Demoted memory ${memoryId} from tier ${row.tier} to ${row.tier + 1}`,
  );
  return true;
}

/**
 * Move a memory directly into the archived tier.
 *
 * Unlike `demoteMemory`, which intentionally advances one tier for prompt
 * overflow and agent-managed tiering, a user-facing archive action must hide
 * the memory from default list/search results in one operation.
 */
export async function archiveMemory(
  memoryId: string,
  mutableNamespaceIds?: string[],
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) =>
    withMemoryAudit(
      { kind: "memory.delete", memoryId, mode: "archive" },
      memoryAuditMetaFromTrust(trust),
      async () => {
        const rows = await handle
          .select({ tier: memories.tier })
          .from(memories)
          .where(eq(memories.id, memoryId))
          .limit(1);

        const row = rows[0];
        if (!row) throw new Error(`Memory ${memoryId} not found`);

        const memoryNamespaceIds = await getMemoryNamespacesWithDb(
          handle,
          memoryId,
        );
        assertNamespaceWriteAccess(
          memoryNamespaceIds,
          mutableNamespaceIds,
          memoryId,
        );

        if (row.tier >= 3) return false;

        await handle
          .update(memories)
          .set({
            demotedFrom: row.tier,
            tier: 3,
            demotedAt: new Date(),
          })
          .where(eq(memories.id, memoryId));

        log(`[memory-store] Archived memory ${memoryId} from tier ${row.tier}`);
        return true;
      },
    ),
  );
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "archive");
}

export async function promoteMemory(
  memoryId: string,
  mutableNamespaceIds?: string[],
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) =>
    withMemoryAudit(
      { kind: "memory.edit", memoryId, action: "promote" },
      memoryAuditMetaFromTrust(trust),
      () => promoteMemoryWithDb(handle, memoryId, mutableNamespaceIds),
    ),
  );
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "restore");
}

export async function promoteMemoryWithDb(
  handle: typeof db,
  memoryId: string,
  mutableNamespaceIds?: string[],
): Promise<boolean> {
  const rows = await handle
    .select({ tier: memories.tier })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`Memory ${memoryId} not found`);

  const memoryNamespaceIds = await getMemoryNamespacesWithDb(handle, memoryId);
  assertNamespaceWriteAccess(memoryNamespaceIds, mutableNamespaceIds, memoryId);

  if (row.tier <= 1) return false;
  if (row.tier !== 2) {
    throw new Error(
      `Memory ${memoryId} is in tier ${row.tier}; only tier 2 memories can be promoted`,
    );
  }

  await handle
    .update(memories)
    .set({
      tier: 1,
      demotedFrom: null,
      demotedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(memories.id, memoryId));

  log(`[memory-store] Promoted memory ${memoryId} from tier 2 to tier 1`);
  return true;
}

export async function getPromptBrief(
  namespaceIds: string[],
  agentId?: string,
  userId?: string,
): Promise<string> {
  return withMemoryTrustContext({ userId, agentId }, (handle) =>
    getPromptBriefWithDb(handle, namespaceIds, agentId, userId),
  );
}

async function selectPromptBriefRows(
  handle: typeof db,
  namespaceIds: readonly string[],
): Promise<PromptBriefMemory[]> {
  if (namespaceIds.length === 0) return [];
  const rows = await handle
    .selectDistinct({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      importance: memories.importance,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
    .where(
      and(
        eq(memories.tier, 1),
        inArray(memoryNamespaces.namespaceId, [...namespaceIds]),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt));
  return rows.map((row) => {
    if (row.content === null || row.type === null) {
      throw new Error("Prompt brief Memory ordinary content is unavailable");
    }
    return { ...row, type: row.type, content: row.content, tier: 1 as const };
  });
}

function packPromptBriefRows(
  rows: readonly PromptBriefMemory[],
  stopAtFirstOverflow = false,
): Readonly<{
  selected: readonly PromptBriefMemory[];
  overflowIds: readonly string[];
}> {
  const limit = fromRuntimeConfig().nautilo_memory_brief_char_limit;
  let total = 0;
  const selected: PromptBriefMemory[] = [];
  const overflowIds: string[] = [];
  for (const row of rows) {
    const line = `- [${row.type}] ${row.content}`;
    if (total + line.length + 1 > limit) {
      if (stopAtFirstOverflow) break;
      overflowIds.push(row.id);
      continue;
    }
    selected.push(row);
    total += line.length + 1;
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    overflowIds: Object.freeze(overflowIds),
  });
}

/** Exact bounded Memory rows used by the foreground prompt brief. */
export async function selectPromptBriefMemories(
  namespaceIds: readonly string[],
  agentId?: string,
  userId?: string,
): Promise<readonly PromptBriefMemory[]> {
  return withMemoryTrustContext({ userId, agentId }, async (handle) => {
    const { selected, overflowIds } = packPromptBriefRows(
      await selectPromptBriefRows(handle, namespaceIds),
    );
    // Prompt selection has always advanced tier-1 Memories that no longer fit
    // the brief. Returning structured rows for the protected-context gateway
    // must preserve that lifecycle side effect instead of silently changing
    // which Memories appear on later turns.
    for (const memoryId of overflowIds) {
      await demoteMemory(memoryId, undefined, { userId, agentId });
    }
    return selected;
  });
}

/**
 * Select a protected foreground brief without mutating Memory tiers. A Strict
 * authority wait may repeat the whole executor, so callers must commit the
 * returned overflow only after the selected protected bytes verify.
 */
export async function stagePromptBriefMemories(
  namespaceIds: readonly string[],
  agentId?: string,
  userId?: string,
): Promise<StagedPromptBriefMemories> {
  return withMemoryTrustContext({ userId, agentId }, async (handle) => {
    const { selected, overflowIds } = packPromptBriefRows(
      await selectPromptBriefRows(handle, namespaceIds),
    );
    return Object.freeze({ memories: selected, overflowIds });
  });
}

/** Body-free ranked page for Full protected prompt selection. */
export async function stagePromptBriefMemoryStructuralPage(
  namespaceIds: readonly string[],
  cursor?: PromptBriefMemoryStructuralCursor,
  agentId?: string,
  userId?: string,
): Promise<PromptBriefMemoryStructuralPage> {
  if (namespaceIds.length === 0) return Object.freeze({ memories: [] });
  return withMemoryTrustContext({ userId, agentId }, async (handle) => {
    const after =
      cursor === undefined
        ? undefined
        : or(
            lt(memories.importance, cursor.importance),
            and(
              eq(memories.importance, cursor.importance),
              lt(memories.createdAt, cursor.createdAt),
            ),
            and(
              eq(memories.importance, cursor.importance),
              eq(memories.createdAt, cursor.createdAt),
              lt(memories.id, cursor.id),
            ),
          );
    const rows = await handle
      .selectDistinct({
        id: memories.id,
        contentRevision: memories.contentRevision,
        importance: memories.importance,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
      .where(
        and(
          eq(memories.tier, 1),
          inArray(memoryNamespaces.namespaceId, [...namespaceIds]),
          after,
        ),
      )
      .orderBy(
        desc(memories.importance),
        desc(memories.createdAt),
        desc(memories.id),
      )
      .limit(PROTECTED_PROMPT_MEMORY_PAGE_SIZE);
    const selected = rows.map((row) =>
      Object.freeze({
        representation: "structural" as const,
        ...row,
        type: null,
        tier: 1 as const,
      }),
    );
    const last = selected.at(-1);
    return Object.freeze({
      memories: Object.freeze(selected),
      ...(last === undefined ||
      selected.length < PROTECTED_PROMPT_MEMORY_PAGE_SIZE
        ? {}
        : {
            nextCursor: Object.freeze({
              importance: last.importance,
              createdAt: last.createdAt,
              id: last.id,
            }),
          }),
    });
  });
}

/** Load ordinary bodies for exactly the already-authorized structural selection. */
export async function loadPromptBriefMemoryOrdinarySelections(
  namespaceIds: readonly string[],
  selections: readonly PromptBriefMemoryStructural[],
  agentId?: string,
  userId?: string,
): Promise<readonly PromptBriefMemory[]> {
  if (namespaceIds.length === 0 || selections.length === 0) return [];
  return withMemoryTrustContext({ userId, agentId }, async (handle) => {
    const ids = selections.map((selection) => selection.id);
    const rows = await handle
      .selectDistinct({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        importance: memories.importance,
        createdAt: memories.createdAt,
        tier: memories.tier,
      })
      .from(memories)
      .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
      .where(
        and(
          inArray(memories.id, ids),
          inArray(memoryNamespaces.namespaceId, [...namespaceIds]),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selections.flatMap((selection) => {
      const row = byId.get(selection.id);
      if (
        row === undefined ||
        row.content === null ||
        row.type === null ||
        row.tier !== 1
      ) {
        return [];
      }
      if (!matchesPromptBriefMemoryStructuralSelection(selection, row)) return [];
      return [
        { ...row, type: row.type, content: row.content, tier: 1 as const },
      ];
    });
  });
}

/** Apply the existing rendered-length packing after protected bodies open. */
export function packOpenedPromptBriefMemories(
  rows: readonly (Omit<PromptBriefMemory, "tier"> & {
    readonly tier: number;
  })[],
): StagedPromptBriefMemories {
  const normalized = rows.map((row): PromptBriefMemory => {
    if (row.tier !== 1) throw new Error("Protected prompt Memory tier changed");
    return { ...row, tier: 1 };
  });
  const packed = packPromptBriefRows(normalized);
  return Object.freeze({
    memories: packed.selected,
    overflowIds: packed.overflowIds,
  });
}

/** Preserve the existing overflow lifecycle after protected selection wins. */
export async function commitPromptBriefMemoryOverflow(
  overflowIds: readonly string[],
  agentId?: string,
  userId?: string,
): Promise<void> {
  for (const memoryId of [...new Set(overflowIds)]) {
    await demoteMemory(memoryId, undefined, { userId, agentId });
  }
}

async function getPromptBriefWithDb(
  handle: typeof db,
  namespaceIds: string[],
  agentId?: string,
  userId?: string,
): Promise<string> {
  // M127: `agentId` is preserved on the signature for `withMemoryTrustContext`
  // routing, but row-level Memory access is namespace-only — no per-row
  // agent narrowing here.
  void agentId;
  const rows = await selectPromptBriefRows(handle, namespaceIds);
  if (rows.length === 0) return "";
  const { selected, overflowIds } = packPromptBriefRows(rows);
  for (const memoryId of overflowIds) {
    await demoteMemory(memoryId, undefined, { userId, agentId });
  }
  return selected.map((row) => `- [${row.type}] ${row.content}`).join("\n");
}

/** D234 — side-effect-free brief for the Memory Library UI (no demote-on-render). */
export async function getPromptBriefReadOnly(
  namespaceIds: string[],
  agentId?: string,
  userId?: string,
): Promise<string> {
  return withMemoryTrustContext({ userId, agentId }, (handle) =>
    getPromptBriefReadOnlyWithDb(handle, namespaceIds, agentId),
  );
}

async function getPromptBriefReadOnlyWithDb(
  handle: typeof db,
  namespaceIds: string[],
  agentId?: string,
): Promise<string> {
  void agentId;
  const { selected } = packPromptBriefRows(
    await selectPromptBriefRows(handle, namespaceIds),
    true,
  );
  return selected.map((row) => `- [${row.type}] ${row.content}`).join("\n");
}

export async function listMemories(
  opts: ListMemoriesOptions,
): Promise<{ items: MemoryListItem[]; nextCursor: string | null }> {
  return withMemoryTrustContext(
    { userId: opts.userId, agentId: opts.agentId },
    (handle) => listMemoriesWithDb(handle, opts),
  );
}

async function listMemoriesWithDb(
  handle: typeof db,
  opts: ListMemoriesOptions,
): Promise<{ items: MemoryListItem[]; nextCursor: string | null }> {
  const namespaceIds = opts.namespaceIds;
  if (namespaceIds.length === 0) return { items: [], nextCursor: null };

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const tierFilter = opts.includeArchive ? undefined : lte(memories.tier, 2);

  const cursorFilter = opts.cursor
    ? or(
        lt(memories.createdAt, opts.cursor.createdAt),
        and(
          eq(memories.createdAt, opts.cursor.createdAt),
          lt(memories.id, opts.cursor.id),
        ),
      )
    : undefined;

  const rows = await handle
    .selectDistinct({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      importance: memories.importance,
      tier: memories.tier,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
    .where(
      and(
        inArray(memoryNamespaces.namespaceId, namespaceIds),
        ...(tierFilter ? [tierFilter] : []),
        ...(cursorFilter ? [cursorFilter] : []),
        ...(opts.excludeNamespaceIds && opts.excludeNamespaceIds.length > 0
          ? [
              notInArray(
                memories.id,
                handle
                  .select({ id: memoryNamespaces.memoryId })
                  .from(memoryNamespaces)
                  .where(
                    inArray(
                      memoryNamespaces.namespaceId,
                      opts.excludeNamespaceIds,
                    ),
                  ),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items: MemoryListItem[] = [];
  for (const row of page) {
    const nsIds = await getMemoryNamespacesWithDb(handle, row.id);
    const visibleNs = nsIds.filter((ns) => namespaceIds.includes(ns));
    if (visibleNs.length === 0) continue;
    items.push({
      id: row.id,
      type: row.type,
      content: row.content,
      importance: row.importance,
      tier: row.tier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      namespaceIds: visibleNs,
    });
  }

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = page[page.length - 1];
    if (last) nextCursor = encodeMemoryListCursor(last.createdAt, last.id);
  }

  return { items, nextCursor };
}

/**
 * D328 — true total for a namespace-filtered memory list (the count the UI
 * banners should show, independent of pagination). Same filter as
 * {@link listMemories} (namespaceIds + optional excludeNamespaceIds + tier),
 * counting distinct memories.
 */
export async function countMemories(
  opts: ListMemoriesOptions,
): Promise<number> {
  return withMemoryTrustContext(
    { userId: opts.userId, agentId: opts.agentId },
    (handle) => countMemoriesWithDb(handle, opts),
  );
}

async function countMemoriesWithDb(
  handle: typeof db,
  opts: ListMemoriesOptions,
): Promise<number> {
  const namespaceIds = opts.namespaceIds;
  if (namespaceIds.length === 0) return 0;
  const tierFilter = opts.includeArchive ? undefined : lte(memories.tier, 2);
  const [row] = await handle
    .select({ count: sql<number>`count(distinct ${memories.id})` })
    .from(memories)
    .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
    .where(
      and(
        inArray(memoryNamespaces.namespaceId, namespaceIds),
        ...(tierFilter ? [tierFilter] : []),
        ...(opts.excludeNamespaceIds && opts.excludeNamespaceIds.length > 0
          ? [
              notInArray(
                memories.id,
                handle
                  .select({ id: memoryNamespaces.memoryId })
                  .from(memoryNamespaces)
                  .where(
                    inArray(
                      memoryNamespaces.namespaceId,
                      opts.excludeNamespaceIds,
                    ),
                  ),
              ),
            ]
          : []),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function getMemoryById(
  memoryId: string,
  readableNamespaceIds: string[],
  trust?: MemoryTrustContext,
): Promise<MemoryDetail | null | "forbidden"> {
  if (readableNamespaceIds.length === 0) return "forbidden";
  return withMemoryTrustContext(trust, async (handle) => {
    const rows = await handle
      .select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        importance: memories.importance,
        tier: memories.tier,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
        demotedAt: memories.demotedAt,
        demotedFrom: memories.demotedFrom,
      })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const nsIds = await getMemoryNamespacesWithDb(handle, memoryId);
    const visibleNs = nsIds.filter((ns) => readableNamespaceIds.includes(ns));
    if (visibleNs.length === 0) {
      return nsIds.length > 0 ? "forbidden" : null;
    }

    return {
      id: row.id,
      type: row.type,
      content: row.content,
      importance: row.importance,
      tier: row.tier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      demotedAt: row.demotedAt,
      demotedFrom: row.demotedFrom,
      namespaceIds: visibleNs,
    };
  });
}

export async function updateMemory(
  memoryId: string,
  patch: { content?: string; importance?: number; namespaceId?: string },
  mutableNamespaceIds?: string[],
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) =>
    withMemoryAudit(
      {
        kind: "memory.edit",
        memoryId,
        action: "patch",
        ...(patch.namespaceId ? { namespaceId: patch.namespaceId } : {}),
      },
      memoryAuditMetaFromTrust(trust),
      async () => {
        const memoryNamespaceIds = await getMemoryNamespacesWithDb(
          handle,
          memoryId,
        );
        assertNamespaceWriteAccess(
          memoryNamespaceIds,
          mutableNamespaceIds,
          memoryId,
        );

        const rows = await handle
          .select({
            content: memories.content,
            importance: memories.importance,
          })
          .from(memories)
          .where(eq(memories.id, memoryId))
          .limit(1);
        const row = rows[0];
        if (!row) throw new Error(`Memory ${memoryId} not found`);

        const nextImportance = patch.importance ?? row.importance;
        const contentChanged =
          patch.content !== undefined && patch.content !== row.content;
        const importanceChanged =
          patch.importance !== undefined && patch.importance !== row.importance;
        let scopeChanged = false;

        if (patch.content !== undefined && contentChanged) {
          const nextContent = patch.content;
          const embedding = await embedTextWithProvenance(nextContent);
          await handle.update(memories).set({
            content: nextContent, importance: nextImportance,
            ...memoryEmbeddingValues(embedding, sql`${memories.contentRevision}`),
            updatedAt: new Date(),
          }).where(eq(memories.id, memoryId));
        } else if (importanceChanged) {
          await handle
            .update(memories)
            .set({ importance: nextImportance, updatedAt: new Date() })
            .where(eq(memories.id, memoryId));
        }

        if (
          patch.namespaceId &&
          mutableNamespaceIds?.includes(patch.namespaceId)
        ) {
          const overlap = memoryNamespaceIds.some((ns) =>
            mutableNamespaceIds.includes(ns),
          );
          if (!overlap) {
            throw new Error(
              `Memory ${memoryId} is in a namespace you cannot write to`,
            );
          }
          for (const ns of memoryNamespaceIds) {
            if (mutableNamespaceIds.includes(ns) && ns !== patch.namespaceId) {
              await handle
                .delete(memoryNamespaces)
                .where(
                  and(
                    eq(memoryNamespaces.memoryId, memoryId),
                    eq(memoryNamespaces.namespaceId, ns),
                  ),
                );
              scopeChanged = true;
            }
          }
          scopeChanged =
            (await attachMemoryToNamespaceWithDb(
              handle,
              memoryId,
              patch.namespaceId,
            )) || scopeChanged;
        }
        return {
          semanticChanged: contentChanged || importanceChanged,
          scopeChanged,
        };
      },
    ),
  );
  if (changed.semanticChanged) {
    await emitAuthoredMemorySemanticChange(memoryId, "replace");
  } else if (changed.scopeChanged) {
    await emitAuthoredMemorySemanticChange(memoryId, "scope");
  }
}

export async function hardDeleteMemory(
  memoryId: string,
  detachNamespaceId: string,
  mutableNamespaceIds: string[],
  trust?: MemoryTrustContext,
  options?: { confirmShared?: boolean },
): Promise<HardDeleteMemoryResult> {
  const result = await withMemoryTrustContext(trust, async (handle) => {
    const memoryNamespaceIds = await getMemoryNamespacesWithDb(
      handle,
      memoryId,
    );
    if (memoryNamespaceIds.length === 0) {
      throw new Error(`Memory ${memoryId} has no namespace attachments`);
    }
    assertNamespaceWriteAccess(
      memoryNamespaceIds,
      mutableNamespaceIds,
      memoryId,
    );

    if (memoryNamespaceIds.length > 1 && !options?.confirmShared) {
      return {
        status: "blocked" as const,
        namespaceCount: memoryNamespaceIds.length,
        namespaceIds: memoryNamespaceIds,
      };
    }

    if (!mutableNamespaceIds.includes(detachNamespaceId)) {
      throw new Error(
        `Namespace ${detachNamespaceId} is not writable in this context`,
      );
    }
    if (!memoryNamespaceIds.includes(detachNamespaceId)) {
      throw new Error(
        `Memory ${memoryId} is not attached to namespace ${detachNamespaceId}`,
      );
    }

    return withMemoryAudit(
      {
        kind: "memory.delete",
        memoryId,
        mode: "hard",
        namespaceId: detachNamespaceId,
      },
      memoryAuditMetaFromTrust(trust),
      async () => {
        await handle
          .delete(memoryNamespaces)
          .where(
            and(
              eq(memoryNamespaces.memoryId, memoryId),
              eq(memoryNamespaces.namespaceId, detachNamespaceId),
            ),
          );

        const remaining = await getMemoryNamespacesWithDb(handle, memoryId);
        if (remaining.length > 0) {
          return { status: "detached_only" as const };
        }

        await handle.delete(memories).where(eq(memories.id, memoryId));
        return { status: "deleted" as const };
      },
    );
  });
  if (result.status === "deleted" || result.status === "detached_only") {
    await emitAuthoredMemorySemanticChange(memoryId, "delete");
  }
  return result;
}

async function searchByVector(
  handle: typeof db,
  embedding: EmbeddingWithProvenanceV1,
  limit: number,
  includeArchive = false,
  namespaceIds: string[],
  agentId?: string,
  excludeMemoryIds: string[] = [],
): Promise<MemoryResult[]> {
  if (namespaceIds.length === 0) return [];
  // Access remains namespace-only; the caller's trust context owns agent routing.
  void agentId;
  const distance = sql<number>`${memories.embedding} <=> ${vectorLiteral(embedding.vector)}::vector`;
  const ranked = handle.selectDistinctOn([memories.id], {
    id: memories.id, type: memories.type, content: memories.content,
    importance: memories.importance, tier: memories.tier, createdAt: memories.createdAt,
    score: sql<number>`1 - (${distance})`.as("similarity"),
  }).from(memories).innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
    .where(and(
      inArray(memoryNamespaces.namespaceId, namespaceIds),
      includeArchive ? undefined : lte(memories.tier, 2),
      excludeMemoryIds.length ? notInArray(memories.id, excludeMemoryIds) : undefined,
      memoryEmbeddingCompatibilityCondition(embedding),
    )).orderBy(memories.id, distance).as("ranked");
  const rows = await handle.select().from(ranked).orderBy(desc(ranked.score)).limit(limit);
  return rows.map((row) => {
    if (row.content === null || row.type === null) {
      throw new Error(`Memory ${row.id} ordinary content is unavailable`);
    }
    return { ...row, content: row.content, type: row.type };
  });
}

async function searchByText(
  handle: typeof db,
  query: string,
  limit: number,
  includeArchive = false,
  namespaceIds: string[],
  agentId?: string,
): Promise<MemoryResult[]> {
  if (namespaceIds.length === 0) return [];
  // M127: row-level Memory access is namespace-only — `agentId` stays
  // on the signature for trust-context routing only.
  void agentId;

  const rows = await handle
    .selectDistinct({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      importance: memories.importance,
      tier: memories.tier,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
    .where(
      and(
        ilike(memories.content, `%${query}%`),
        ...(includeArchive ? [] : [lte(memories.tier, 2)]),
        inArray(memoryNamespaces.namespaceId, namespaceIds),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(limit);

  return rows.map((r) => {
    if (r.content === null || r.type === null) {
      throw new Error(`Memory ${r.id} ordinary content is unavailable`);
    }
    return {
      id: r.id,
      type: r.type,
      content: r.content,
      importance: r.importance,
      tier: r.tier,
      score: 0,
      createdAt: r.createdAt,
    };
  });
}

function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

export {
  assertNamespaceWriteAccess,
  setMemoryAuditSink,
  emitMemoryAudit,
} from "./memory-write-access";

export async function attachMemoryToNamespace(
  memoryId: string,
  namespaceId: string,
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, (handle) =>
    attachMemoryToNamespaceWithDb(handle, memoryId, namespaceId),
  );
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "scope");
}

async function attachMemoryToNamespaceWithDb(
  handle: typeof db,
  memoryId: string,
  namespaceId: string,
): Promise<boolean> {
  const inserted = await handle
    .insert(memoryNamespaces)
    .values({ memoryId, namespaceId })
    .onConflictDoNothing()
    .returning({ memoryId: memoryNamespaces.memoryId });
  return inserted.length === 1;
}

export async function detachMemoryFromNamespace(
  memoryId: string,
  namespaceId: string,
  trust?: MemoryTrustContext,
): Promise<void> {
  const changed = await withMemoryTrustContext(trust, async (handle) => {
    const deleted = await handle
      .delete(memoryNamespaces)
      .where(
        and(
          eq(memoryNamespaces.memoryId, memoryId),
          eq(memoryNamespaces.namespaceId, namespaceId),
        ),
      )
      .returning({ memoryId: memoryNamespaces.memoryId });
    return deleted.length === 1;
  });
  if (changed) await emitAuthoredMemorySemanticChange(memoryId, "scope");
}

export async function getMemoryNamespaces(
  memoryId: string,
  trust?: MemoryTrustContext,
): Promise<string[]> {
  return withMemoryTrustContext(trust, (handle) =>
    getMemoryNamespacesWithDb(handle, memoryId),
  );
}

async function getMemoryNamespacesWithDb(
  handle: typeof db,
  memoryId: string,
): Promise<string[]> {
  const rows = await handle
    .select({ namespaceId: memoryNamespaces.namespaceId })
    .from(memoryNamespaces)
    .where(eq(memoryNamespaces.memoryId, memoryId));
  return rows.map((r) => r.namespaceId);
}

/** Read-only preview; publication repeats this lookup in its serializable transaction. */
export async function findMemorySaveTarget(
  opts: SaveMemoryOptions,
  embedding: EmbeddingWithProvenanceV1,
  excludeMemoryIds: string[] = [],
): Promise<MemoryResult | null> {
  return withMemoryTrustContext(opts, (handle) =>
    findMemorySaveTargetWithDb(handle, opts, embedding, excludeMemoryIds),
  );
}

async function findMemorySaveTargetWithDb(
  handle: typeof db,
  opts: SaveMemoryOptions,
  embedding: EmbeddingWithProvenanceV1,
  excludeMemoryIds: string[] = [],
): Promise<MemoryResult | null> {
  const rows = await searchByVector(
    handle,
    embedding,
    1,
    false,
    opts.namespaceId ? [opts.namespaceId] : [],
    opts.agentId,
    excludeMemoryIds,
  );
  const top = rows[0];
  if (
    !top ||
    top.score < fromRuntimeConfig().nautilo_memory_dedup_similarity_threshold
  )
    return null;
  if (opts.namespaceId) {
    const namespaces = await getMemoryNamespacesWithDb(handle, top.id);
    try {
      assertNamespaceWriteAccess(namespaces, [opts.namespaceId], top.id);
    } catch {
      return null;
    }
  }
  return top;
}
