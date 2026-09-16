import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { EmbeddingWithProvenanceV1 } from "@nautilo/types";
import { agentScopes } from "../schema/agent-scopes";
import { memories } from "../schema/memories";
import { memoryNamespaces } from "../schema/memory-namespaces";
import { memoryScopes } from "../schema/memory-scopes";
import { actors } from "../schema/trust";
import { rooms } from "../schema/rooms";
import { memoryEmbeddingValues } from "./memory-embedding";
import type { ProfileMigrationTx } from "./profile-migration-primitives";

/**
 * D425 Wave 1B — narrow, transaction-aware private-memory migration
 * primitives for the portable Genie profile importer.
 *
 * Wave 1A (`./profile-migration-primitives.ts`) introduced the
 * caller-owned-transaction pattern for profile / identity / handle
 * writes. Wave 1B extends that pattern to the *private memory* surface
 * with two narrow primitives — no broad memory-store refactor:
 *
 *   1. **Source eligibility** — `isMemoryEligibleForPrivateExportInTx`
 *      (+ the pure `evaluatePrivateMemoryEligibility` it delegates to).
 *      Walks EVERY `memory_namespaces` and `memory_scopes` edge of a
 *      source memory and accepts it iff it is purely private to the
 *      exporting owner: at least one edge; every namespace edge belongs
 *      to a Room whose human-member set is exactly the exporting owner's
 *      single human actor; every scope edge belongs to
 *      `(ownerUserId, personalAgentId)`. Any shared / foreign edge
 *      rejects the whole memory (R3/R7 — shared memories never enter a
 *      bundle).
 *   2. **Import-only insert** — `insertPrivateMemoryInTx` inserts a
 *      caller-supplied target embedding + content as a fresh `memories`
 *      row and creates its `memory_namespaces` junction, inside the
 *      caller's transaction. It does NOT call embedding / network code
 *      inside the transaction (the caller pre-computes the embedding).
 *   3. **Replay-safe import** — `replayPrivateMemoriesInTx` acquires a
 *      transaction-scoped advisory lock for the canonical target namespace,
 *      compares canonical portable-record fingerprints under that lock, and
 *      inserts only records not already present. This is deliberately a
 *      namespace-scoped operation: no schema-level fingerprint column or
 *      broad Memory-store dedup policy is introduced.
 *
 * The pure record encoder `encodePrivateMemoryRecord` projects a source
 * memory row onto the existing `MemoryRecord` contract
 * (`recordKind: "memory"`, `scope: "private"`, `type`, `content`, `createdAt`)
 * with NO source IDs and NO embedding — only the contract fields
 * survive.
 *
 * Scope guard: this module is private-memory-migration-only. It wires
 * NO import endpoint, touches NO avatar / storage / CLI / schema /
 * migration, and does NOT recreate `memory_scopes` junctions on import
 * (the task narrows the import primitive to the namespace junction; the
 * importer / a later wave owns scope-junction replay).
 */

/** Re-exported transaction handle type (sibling to the Wave 1A module). */
export type { ProfileMigrationTx };

// ---------------------------------------------------------------------------
// Record encoding — pure projection onto the MemoryRecord contract
// ---------------------------------------------------------------------------

/**
 * Source memory projection input — only the contract-relevant fields.
 * The DB-fetcher reads a `memories` row and trims to this shape before
 * encoding; IDs / embedding / tier / importance are deliberately
 * dropped (R3/R7: never portable).
 */
export interface PrivateMemoryRecordInput {
  /** Confidential Memory type, preserved exactly across portability. */
  type: string;
  /** Logical memory text only. */
  content: string;
  /** Source `created_at`; preserved for ordering provenance. */
  createdAt: Date | string | null;
}

/**
 * The semantic record shape, compatible with the existing `MemoryRecord`
 * contract (`packages/profile-portability/src/semantic/types.ts`):
 * `recordKind: "memory"`, `scope: "private"`, `type`, `content`, `createdAt`.
 * Inlined here (not imported from profile-portability) so `@nautilo/db`
 * stays free of the portability-package dependency; structurally
 * identical.
 */
export interface PrivateMemoryRecord {
  readonly recordKind: "memory";
  readonly scope: "private";
  readonly type: string;
  readonly content: string;
  readonly createdAt: string | null;
}

/**
 * Project a source memory row onto the portable `MemoryRecord` contract.
 * Pure / synchronous / no DB. Preserves ONLY the contract fields — no
 * IDs, no embedding, no tier / importance. `type` is required to match the
 * current semantic v1.1 Memory contract and is bounded to 1-256 UTF-8 bytes.
 * `createdAt` is
 * normalized to an ISO string when it is a `Date`; a raw string is
 * passed through; `null` stays `null`.
 */
export function encodePrivateMemoryRecord(
  input: PrivateMemoryRecordInput,
): PrivateMemoryRecord {
  const typeLength = new TextEncoder().encode(input.type).length;
  if (typeLength < 1 || typeLength > 256) {
    throw new Error("encodePrivateMemoryRecord: type must be 1-256 UTF-8 bytes");
  }
  const createdAt = normalizeCreatedAt(input.createdAt);
  return {
    recordKind: "memory",
    scope: "private",
    type: input.type,
    content: input.content,
    createdAt,
  };
}

function normalizeCreatedAt(
  value: Date | string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const str = String(value).trim();
  return str === "" ? null : str;
}

// ---------------------------------------------------------------------------
// Eligibility — pure evaluator (unit-testable) + transaction-aware fetcher
// ---------------------------------------------------------------------------

/**
 * A `memory_namespaces` edge resolved against the Room that owns the
 * namespace. The fetcher joins `rooms.namespace_id → namespaces.id`
 * (REL-NSP-RMS 1:1) and carries the Room's denormalized human-member
 * actor-id set so the pure evaluator can apply the "exactly the
 * exporting owner's human actor" rule without a DB.
 */
export interface PrivateMemoryNamespaceEdge {
  readonly namespaceId: string;
  /** The Room that owns this namespace, or null if the namespace is orphaned. */
  readonly roomId: string | null;
  /** The Room's `human_actor_ids`; null when the namespace has no Room. */
  readonly humanActorIds: readonly string[] | null;
}

/**
 * A `memory_scopes` edge resolved against the `agent_scopes` row that
 * owns the scope. The fetcher carries `(parent_agent_id, speaker_user_id)`
 * so the pure evaluator can apply the "belongs to
 * `(ownerUserId, personalAgentId)`" rule without a DB.
 */
export interface PrivateMemoryScopeEdge {
  readonly scopeId: string;
  readonly parentAgentId: string | null;
  readonly speakerUserId: string | null;
}

/**
 * Fully-resolved eligibility input — everything the pure evaluator needs
 * to decide with zero DB access. The transaction-aware fetcher
 * (`isMemoryEligibleForPrivateExportInTx`) assembles this.
 */
export interface PrivateMemoryEligibilityInput {
  readonly memoryId: string;
  readonly ownerUserId: string;
  readonly personalAgentId: string;
  /** The exporting owner's single human actor id, or null if not uniquely resolvable. */
  readonly ownerHumanActorId: string | null;
  readonly namespaceEdges: readonly PrivateMemoryNamespaceEdge[];
  readonly scopeEdges: readonly PrivateMemoryScopeEdge[];
}

export type PrivateMemoryEligibilityReason =
  | "no_edges"
  | "owner_human_actor_unresolved"
  | "namespace_no_room"
  | "namespace_shared_or_foreign"
  | "scope_shared_or_foreign";

export interface PrivateMemoryEligibilityResult {
  readonly eligible: boolean;
  readonly memoryId: string;
  readonly namespaceEdgeCount: number;
  readonly scopeEdgeCount: number;
  readonly reason?: PrivateMemoryEligibilityReason;
}

/**
 * Pure eligibility decision. Implements the Wave 1B rule:
 *
 *   - at least one edge (namespace OR scope); a memory with no edges is
 *     rejected (it is not provably private to anyone);
 *   - the exporting owner must resolve to EXACTLY ONE human actor;
 *   - every namespace edge belongs to a Room whose `human_actor_ids` is
 *     exactly `[ownerHumanActorId]` — a private Room of the owner only;
 *   - every scope edge belongs to `(ownerUserId, personalAgentId)`;
 *   - the FIRST shared / foreign edge rejects the whole memory.
 *
 * Pure / synchronous / no DB — exhaustively unit-testable.
 */
export function evaluatePrivateMemoryEligibility(
  input: PrivateMemoryEligibilityInput,
): PrivateMemoryEligibilityResult {
  const namespaceEdgeCount = input.namespaceEdges.length;
  const scopeEdgeCount = input.scopeEdges.length;
  const base = {
    memoryId: input.memoryId,
    namespaceEdgeCount,
    scopeEdgeCount,
  };

  if (namespaceEdgeCount + scopeEdgeCount === 0) {
    return { eligible: false, ...base, reason: "no_edges" };
  }

  if (!input.ownerHumanActorId) {
    return { eligible: false, ...base, reason: "owner_human_actor_unresolved" };
  }

  for (const edge of input.namespaceEdges) {
    if (!edge.roomId || !edge.humanActorIds) {
      return { eligible: false, ...base, reason: "namespace_no_room" };
    }
    if (
      edge.humanActorIds.length !== 1 ||
      edge.humanActorIds[0] !== input.ownerHumanActorId
    ) {
      return { eligible: false, ...base, reason: "namespace_shared_or_foreign" };
    }
  }

  for (const edge of input.scopeEdges) {
    if (
      edge.parentAgentId !== input.personalAgentId ||
      edge.speakerUserId !== input.ownerUserId
    ) {
      return { eligible: false, ...base, reason: "scope_shared_or_foreign" };
    }
  }

  return { eligible: true, ...base };
}

// ---------------------------------------------------------------------------
// Eligibility — transaction-aware fetcher
// ---------------------------------------------------------------------------

/**
 * Resolve EVERY `memory_namespaces` + `memory_scopes` edge of `memoryId`
 * against the Room / agent_scope that owns each edge, plus the exporting
 * owner's single human actor, and decide private-export eligibility via
 * `evaluatePrivateMemoryEligibility`. Runs entirely inside the caller's
 * transaction (read-only).
 */
export async function isMemoryEligibleForPrivateExportInTx(
  tx: ProfileMigrationTx,
  args: {
    memoryId: string;
    ownerUserId: string;
    personalAgentId: string;
  },
): Promise<PrivateMemoryEligibilityResult> {
  // 1. The exporting owner's human actor — require exactly one.
  const ownerActorRows = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, args.ownerUserId), eq(actors.kind, "user")))
    .limit(2);
  const ownerHumanActorId =
    ownerActorRows.length === 1 ? (ownerActorRows[0]?.id ?? null) : null;

  // 2. Namespace edges → resolved against the owning Room.
  const namespaceRows = await tx
    .select({ namespaceId: memoryNamespaces.namespaceId })
    .from(memoryNamespaces)
    .where(eq(memoryNamespaces.memoryId, args.memoryId));
  const namespaceEdges: PrivateMemoryNamespaceEdge[] = [];
  for (const row of namespaceRows) {
    const [room] = await tx
      .select({
        id: rooms.id,
        humanActorIds: rooms.humanActorIds,
      })
      .from(rooms)
      .where(eq(rooms.namespaceId, row.namespaceId))
      .limit(1);
    namespaceEdges.push({
      namespaceId: row.namespaceId,
      roomId: room?.id ?? null,
      humanActorIds: room?.humanActorIds ?? null,
    });
  }

  // 3. Scope edges → resolved against the owning agent_scope.
  const scopeRows = await tx
    .select({ scopeId: memoryScopes.scopeId })
    .from(memoryScopes)
    .where(eq(memoryScopes.memoryId, args.memoryId));
  const scopeEdges: PrivateMemoryScopeEdge[] = [];
  for (const row of scopeRows) {
    const [scope] = await tx
      .select({
        parentAgentId: agentScopes.parentAgentId,
        speakerUserId: agentScopes.speakerUserId,
      })
      .from(agentScopes)
      .where(eq(agentScopes.id, row.scopeId))
      .limit(1);
    scopeEdges.push({
      scopeId: row.scopeId,
      parentAgentId: scope?.parentAgentId ?? null,
      speakerUserId: scope?.speakerUserId ?? null,
    });
  }

  return evaluatePrivateMemoryEligibility({
    memoryId: args.memoryId,
    ownerUserId: args.ownerUserId,
    personalAgentId: args.personalAgentId,
    ownerHumanActorId,
    namespaceEdges,
    scopeEdges,
  });
}

// ---------------------------------------------------------------------------
// Import — transaction-aware insert + replay-safe namespace operation
// ---------------------------------------------------------------------------

/**
 * Deterministic identity of the ID-free portable Memory record. It is SHA-256
 * over the same canonical JSON shape that crosses the portability boundary:
 * `content`, `createdAt`, `recordKind`, `scope`, `type` (lexicographic key
 * order; no source IDs, embeddings, tiers, or target-local metadata).
 *
 * This is intentionally exact, never fuzzy: two records with distinct type,
 * content, or normalized createdAt retain distinct identities. Keeping the
 * encoder local avoids making `@nautilo/db` depend on profile-portability.
 */
export function fingerprintPrivateMemoryRecord(
  input: PrivateMemoryRecordInput | PrivateMemoryRecord,
): string {
  const record = encodePrivateMemoryRecord({
    type: input.type,
    content: input.content,
    createdAt: input.createdAt,
  });
  return createHash("sha256")
    .update(canonicalPrivateMemoryRecordJson(record), "utf8")
    .digest("hex");
}

function canonicalPrivateMemoryRecordJson(record: PrivateMemoryRecord): string {
  // The keys are already in lexicographic order, matching canonicalJson in
  // profile-portability. A private Memory record contains only strings/null,
  // so this narrow encoder is sufficient and keeps the DB package dependency
  // direction intact.
  return "{"
    + `"content":${canonicalJsonString(record.content)},`
    + `"createdAt":${record.createdAt === null ? "null" : canonicalJsonString(record.createdAt)},`
    + '"recordKind":"memory","scope":"private",'
    + `"type":${canonicalJsonString(record.type)}`
    + "}";
}

function canonicalJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += value[i]!;
  }
  return out + '"';
}

/**
 * Arguments for `insertPrivateMemoryInTx`. The caller pre-computes the
 * target embedding OUTSIDE the transaction (and outside this helper) and
 * hands it in; this helper does NO embedding / network work.
 */
export interface InsertPrivateMemoryInTxArgs {
  /** Logical memory text. */
  content: string;
  /**
   * Caller-supplied target embedding and its actual provider provenance.
   * `null` inserts a memory with no embedding tuple. Never computed here.
   */
  embedding: EmbeddingWithProvenanceV1 | null;
  /**
   * The target namespace to junction the new memory into. At least one is
   * required — a memory with no namespace edge is not provably private
   * and is rejected at export eligibility anyway.
   */
  targetNamespaceId: string;
  /** Optional source `type` (defaults to `general`, matching the schema default). */
  type?: string;
  /** Optional importance (defaults to the schema default of 0.5). */
  importance?: number;
  /**
   * Optional source `created_at` to preserve ordering provenance. When
   * omitted the schema `defaultNow()` applies.
   */
  createdAt?: Date;
  /**
   * Optional durable creation receipt. Replay uses a private namespaced form
   * of this existing unique column so a portable record whose `createdAt` is
   * null retains its exact identity even though `memories.created_at` itself
   * is non-null and defaults at insertion time.
   */
  creationKey?: string;
}

export interface InsertPrivateMemoryInTxResult {
  /** The freshly minted `memories.id`. */
  memoryId: string;
  /** The namespace the new memory was junctioned to. */
  namespaceId: string;
}

/** The exact portable fields needed for a replay-safe target insertion. */
export type ReplayPrivateMemoryRecordInTxArgs = InsertPrivateMemoryInTxArgs;

export interface PrivateMemoryReplayResult {
  /** Records newly inserted into the canonical target namespace. */
  readonly added: number;
  /** Exact canonical records already present (including earlier bundle rows). */
  readonly alreadyPresent: number;
}

function privateMemoryReplayCreationKeyPrefix(targetNamespaceId: string): string {
  return `profile-bundle-private-memory:v1:${targetNamespaceId}:`;
}

function privateMemoryReplayCreationKey(
  targetNamespaceId: string,
  fingerprint: string,
): string {
  return privateMemoryReplayCreationKeyPrefix(targetNamespaceId) + fingerprint;
}

/**
 * Read exact portable-record identities currently attached to one target
 * namespace. Protected records are intentionally excluded: their legacy
 * columns are not a safe portable-content assertion, so callers must not use
 * them to suppress an embedding or import.
 */
export async function listPrivateMemoryFingerprintsInNamespaceInTx(
  tx: ProfileMigrationTx,
  targetNamespaceId: string,
): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({
      type: memories.type,
      content: memories.content,
      createdAt: memories.createdAt,
      creationKey: memories.creationKey,
    })
    .from(memoryNamespaces)
    .innerJoin(memories, eq(memories.id, memoryNamespaces.memoryId))
    .where(and(
      eq(memoryNamespaces.namespaceId, targetNamespaceId),
      isNull(memories.cryptoObjectId),
    ));
  const fingerprints = new Set<string>();
  const replayKeyPrefix = privateMemoryReplayCreationKeyPrefix(targetNamespaceId);
  for (const row of rows) {
    // A prior replay stores the exact original portable identity in the
    // existing unique `creation_key`. This matters for `createdAt: null`,
    // whose DB row necessarily receives a non-null default timestamp.
    const receiptFingerprint = row.creationKey?.startsWith(replayKeyPrefix)
      ? row.creationKey.slice(replayKeyPrefix.length)
      : null;
    if (receiptFingerprint && /^[0-9a-f]{64}$/.test(receiptFingerprint)) {
      fingerprints.add(receiptFingerprint);
      continue;
    }
    if (row.content === null || row.type === null) {
      throw new Error(
        "Private Memory fingerprint unavailable: ordinary content is absent",
      );
    }
    // A malformed/untrusted prefix is never treated as a receipt. Project
    // and fingerprint the actual row instead, preserving exact semantics.
    fingerprints.add(fingerprintPrivateMemoryRecord({
      ...row, type: row.type, content: row.content,
    }));
  }
  return fingerprints;
}

/**
 * Replay portable Memory records in the target's canonical private namespace.
 * The namespace-scoped advisory xact lock is the authoritative concurrency
 * gate: lookup and insert occur under one lock and one caller-owned
 * transaction, so later plans, overlapping backups, retries, and concurrent
 * commits cannot both insert the same exact portable record. No migration is
 * required because this lock serializes the otherwise-unindexed predicate.
 */
export async function replayPrivateMemoriesInTx(
  tx: ProfileMigrationTx,
  args: {
    readonly targetNamespaceId: string;
    readonly records: readonly ReplayPrivateMemoryRecordInTxArgs[];
  },
): Promise<PrivateMemoryReplayResult> {
  if (!args.targetNamespaceId) {
    throw new Error("replayPrivateMemoriesInTx: targetNamespaceId is required");
  }
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`profile-bundle-private-memory:${args.targetNamespaceId}`}::text, 0)
    )
  `);

  const present = new Set(
    await listPrivateMemoryFingerprintsInNamespaceInTx(tx, args.targetNamespaceId),
  );
  let added = 0;
  let alreadyPresent = 0;
  for (const record of args.records) {
    const fingerprint = fingerprintPrivateMemoryRecord({
      type: record.type ?? "general",
      content: record.content,
      createdAt: record.createdAt ?? null,
    });
    if (present.has(fingerprint)) {
      alreadyPresent += 1;
      continue;
    }
    await insertPrivateMemoryInTx(tx, {
      ...record,
      // The existing unique receipt closes the representation gap for a
      // portable `createdAt: null` without a migration. The advisory lock is
      // still required because legacy rows have no receipt to constrain.
      creationKey: privateMemoryReplayCreationKey(args.targetNamespaceId, fingerprint),
    });
    present.add(fingerprint);
    added += 1;
  }
  return { added, alreadyPresent };
}

/**
 * Insert a fresh private memory + its `memory_namespaces` junction inside
 * the caller's transaction. Import-only and deliberately narrow:
 *
 *   - NO embedding / network code runs here — the caller passes the
 *     pre-computed target embedding (or `null`).
 *   - NO deduplication — a new `memories.id` is always minted; an existing
 *     near-duplicate is never updated.
 *   - NO update of existing target memories — this is a pure INSERT path.
 *   - Only the `memory_namespaces` junction is created. `memory_scopes`
 *     junction replay is intentionally out of scope for Wave 1B (the task
 *     narrows the import primitive to the namespace junction); the
 *     importer / a later wave owns scope-junction replay.
 *
 * A failure on either the memory INSERT or the junction INSERT rolls back
 * with the caller's transaction, leaving no inserted rows / junctions.
 */
export async function insertPrivateMemoryInTx(
  tx: ProfileMigrationTx,
  args: InsertPrivateMemoryInTxArgs,
): Promise<InsertPrivateMemoryInTxResult> {
  if (!args.content) {
    throw new Error("insertPrivateMemoryInTx: content cannot be empty");
  }
  if (!args.targetNamespaceId) {
    throw new Error(
      "insertPrivateMemoryInTx: targetNamespaceId is required (a memory with no namespace edge is not provably private)",
    );
  }

  // Fresh INSERT — never an upsert, never an update. The `memories.id`
  // defaultRandom() mints a new id; `RETURNING id` reads it back so the
  // caller can compose further writes (e.g. scope-junction replay).
  //
  const type = args.type ?? "general";
  const importance = args.importance ?? 0.5;
  const embeddingValues = args.embedding === null
    ? {
        embedding: null,
        embeddingRevision: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimensions: null,
        embeddingContractVersion: null,
      }
    : memoryEmbeddingValues(args.embedding, 0);
  const [inserted] = await tx
    .insert(memories)
    .values({
      tier: 1,
      type,
      content: args.content,
      importance,
      contentRevision: 0,
      ...embeddingValues,
      ...(args.creationKey === undefined ? {} : { creationKey: args.creationKey }),
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
    })
    .returning({ id: memories.id });
  const memoryId = inserted?.id;
  if (!memoryId) {
    throw new Error("insertPrivateMemoryInTx: memories insert returned no row");
  }

  // Junction row. PK is (memory_id, namespace_id); the memory is freshly
  // minted so there is no conflict path, but `ON CONFLICT DO NOTHING` keeps
  // the helper idempotent if a caller ever re-runs against the same pair.
  await tx
    .insert(memoryNamespaces)
    .values({
      memoryId,
      namespaceId: args.targetNamespaceId,
    })
    .onConflictDoNothing();

  return { memoryId, namespaceId: args.targetNamespaceId };
}
