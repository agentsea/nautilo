import {
  agentScopes,
  and,
  asc,
  eq,
  inArray,
  memories,
  memoryNamespaces,
  memoryScopes,
  rooms,
  sql,
  tasks,
} from "@nautilo/db";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import {
  resolveRequiredMemoryNamespaceIds,
} from "../../memory/required-namespace-set.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import { readCryptoStorageInteger } from
  "../storage/postgres-lattice-storage.ts";
import {
  findCurrentReadableNamespaceCandidates,
} from "../delivery/namespace-readable-policy.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface TaskScopeCoordinates {
  readonly taskId: string;
  readonly requesterUserId: string;
  readonly agentId: string;
  readonly scopeId: string;
  readonly memoryRoomId: string;
  readonly originWritableNamespaceId: string;
}

export interface TaskScopeMemoryMetadata {
  readonly memoryId: string;
  /** The exact edge into this Scope. Seed remains read-only provenance. */
  readonly origin: "seed" | "scope";
  readonly contentRevision: number;
  readonly cryptoObjectId: string | null;
  readonly cryptoAccessRevision: number;
  readonly mappingState: "unmapped" | "verified" | "stale";
  /** Complete current encryption audience, without grant filtering. */
  readonly requiredNamespaceIds: readonly string[];
  /** Complete ordinary Namespace edges, retained separately for seed reads. */
  readonly ordinaryNamespaceIds: readonly string[];
  readonly scopeOriginNamespaceId: string | null;
  readonly requiredNamespaceFingerprint: Uint8Array | null;
}

type TaskScopeMemoryMetadataInput = Readonly<{
  transaction: ConversationProductPostgresTransaction;
  coordinates: TaskScopeCoordinates;
}>;

export interface TaskScopeMemoryNamespaceInventory {
  readonly scopeId: string;
  readonly originWritableNamespaceId: string;
  readonly readableNamespaceIds: readonly string[];
}

export interface TaskScopeMemoryBinding {
  readonly scopeId: string;
  readonly memoryRoomId: string;
  readonly originWritableNamespaceId: string;
  readonly readableNamespaceIds: readonly string[];
}

/** Copy one exact fixed Scope inventory before it crosses an async boundary. */
export function copyTaskScopeMemoryBinding(
  value: TaskScopeMemoryBinding,
): TaskScopeMemoryBinding {
  const readable = value.readableNamespaceIds;
  if (Object.keys(value).sort().join(",")
      !== "memoryRoomId,originWritableNamespaceId,readableNamespaceIds,scopeId"
    || !UUID.test(value.scopeId)
    || !UUID.test(value.memoryRoomId)
    || !UUID.test(value.originWritableNamespaceId)
    || !Array.isArray(readable as unknown)
    || readable.length === 0
    || readable.some((namespaceId, index) =>
      !UUID.test(namespaceId)
      || index > 0 && readable[index - 1]! >= namespaceId)
    || !readable.includes(value.originWritableNamespaceId)) {
    throw new TypeError("Task Scope Memory binding is invalid");
  }
  return Object.freeze({
    scopeId: value.scopeId,
    memoryRoomId: value.memoryRoomId,
    originWritableNamespaceId: value.originWritableNamespaceId,
    readableNamespaceIds: Object.freeze([...readable]),
  });
}

type TaskScopeMemoryNamespaceInventoryInput = Readonly<{
  transaction: ConversationProductPostgresTransaction;
  coordinates: TaskScopeCoordinates;
  sourceRoomId: string;
  requesterHumanId: string;
}>;

function exactCoordinates(value: TaskScopeCoordinates): boolean {
  return Object.keys(value).sort().join(",")
      === "agentId,memoryRoomId,originWritableNamespaceId,requesterUserId,scopeId,taskId"
    && UUID.test(value.taskId)
    && UUID.test(value.requesterUserId)
    && UUID.test(value.agentId)
    && UUID.test(value.scopeId)
    && UUID.test(value.memoryRoomId)
    && UUID.test(value.originWritableNamespaceId);
}

function canonicalIds(values: readonly string[]): readonly string[] | null {
  if (values.some((value) => !UUID.test(value))) return null;
  const sorted = [...values].sort();
  if (sorted.some((value, index) => index > 0 && sorted[index - 1] === value)) {
    return null;
  }
  return Object.freeze(sorted);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function rowInteger(row: object, field: string): number {
  return readCryptoStorageInteger(
    row as Parameters<typeof readCryptoStorageInteger>[0],
    field,
  );
}

function rowNullableBytes(row: object, field: string): Uint8Array | null {
  const value = (row as Readonly<Record<string, unknown>>)[field];
  if (value === null) return null;
  if (!ArrayBuffer.isView(value)) throw new TypeError(`${field} is not binary`);
  return new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).slice();
}

async function queryTaskScopeMemoryMetadata(
  input: TaskScopeMemoryMetadataInput,
  locked: boolean,
  mutationMemoryId?: string,
): Promise<readonly TaskScopeMemoryMetadata[] | null> {
  if (!exactCoordinates(input.coordinates)
    || mutationMemoryId !== undefined && !UUID.test(mutationMemoryId)) return null;
  const coordinates = Object.freeze({ ...input.coordinates });

  const identityRows = await executeTypedConversationProductQuery(
    input.transaction,
    conversationProductTypedDb.select({
      current_user: sql<string>`current_user::text`.as("current_user"),
      session_user: sql<string>`session_user::text`.as("session_user"),
      current_user_id: sql<string>`app_current_user_id()::text`
        .as("current_user_id"),
      current_agent_id: sql<string | null>`app_current_agent_id()::text`
        .as("current_agent_id"),
    }).from(sql`(values (1)) as identity_probe`).limit(2),
  );
  const identity = identityRows[0];
  if (identityRows.length !== 1 || identity === undefined
    || identity.current_user !== "nautilo"
    || identity.session_user !== "nautilo"
    || identity.current_user_id !== coordinates.requesterUserId
    || (identity.current_agent_id !== null
      && identity.current_agent_id !== coordinates.agentId)) return null;

  const taskQuery = conversationProductTypedDb.select({
      id: tasks.id,
      requestor_id: tasks.requestorId,
      agent_id: tasks.agentId,
      use_scope: tasks.useScope,
      scope_id: tasks.scopeId,
    }).from(tasks).where(eq(tasks.id, coordinates.taskId))
      .limit(2);
  const taskRows = await executeTypedConversationProductQuery(
    input.transaction,
    locked ? taskQuery.for("share") : taskQuery,
  );
  const task = taskRows[0];
  if (taskRows.length !== 1 || task === undefined
    || task.id !== coordinates.taskId
    || task.requestor_id !== coordinates.requesterUserId
    || task.agent_id !== coordinates.agentId
    || task.use_scope !== true
    || task.scope_id !== coordinates.scopeId) return null;

  // Task precedes Scope in the repository-wide lifecycle lock order. A caller
  // may already hold the Task row through its wider publication boundary;
  // reacquiring SHARE remains a no-op and never inverts a Scope closer.
  const scopeQuery = conversationProductTypedDb.select({
      id: agentScopes.id,
      parent_agent_id: agentScopes.parentAgentId,
      speaker_user_id: agentScopes.speakerUserId,
      lifecycle_state: agentScopes.lifecycleState,
      revision: agentScopes.revision,
    }).from(agentScopes).where(eq(agentScopes.id, coordinates.scopeId))
      .limit(2);
  const scopeRows = await executeTypedConversationProductQuery(
    input.transaction,
    locked ? scopeQuery.for("share") : scopeQuery,
  );
  const scope = scopeRows[0];
  if (scopeRows.length !== 1 || scope === undefined
    || scope.id !== coordinates.scopeId
    || scope.parent_agent_id !== coordinates.agentId
    || scope.speaker_user_id !== coordinates.requesterUserId
    || scope.lifecycle_state !== "open"
    || rowInteger(scope, "revision") < 0) return null;

  // The caller already holds this canonical Room lock. This is only the
  // current identity/Namespace proof and deliberately acquires no later lock.
  const roomRows = await executeTypedConversationProductQuery(
    input.transaction,
    conversationProductTypedDb.select({
      id: rooms.id,
      namespace_id: rooms.namespaceId,
    }).from(rooms).where(eq(rooms.id, coordinates.memoryRoomId)).limit(2),
  );
  const room = roomRows[0];
  if (roomRows.length !== 1 || room === undefined
    || room.id !== coordinates.memoryRoomId
    || room.namespace_id !== coordinates.originWritableNamespaceId) {
    return null;
  }

  const bagQuery = conversationProductTypedDb.select({
      id: memories.id,
      origin: memoryScopes.origin,
      content_revision: memories.contentRevision,
      crypto_object_id: memories.cryptoObjectId,
      crypto_access_revision: memories.cryptoAccessRevision,
      crypto_mapping_state: memories.cryptoMappingState,
      crypto_required_namespace_fingerprint:
        memories.cryptoRequiredNamespaceFingerprint,
      scope_origin_namespace_id: memories.scopeOriginNamespaceId,
    }).from(memoryScopes).innerJoin(
      memories,
      eq(memories.id, memoryScopes.memoryId),
    ).where(and(eq(memoryScopes.scopeId, coordinates.scopeId),
      mutationMemoryId === undefined ? undefined : eq(memories.id, mutationMemoryId)))
      .orderBy(asc(memories.id));
  const bagRows = await executeTypedConversationProductQuery(
    input.transaction,
    mutationMemoryId !== undefined
      ? bagQuery.for("update", { of: [memoryScopes, memories] })
      : locked ? bagQuery.for("share", { of: [memoryScopes, memories] }) : bagQuery,
  );
  if (bagRows.length === 0) return Object.freeze([]);
  const memoryIds = canonicalIds(bagRows.map((row) => row.id));
  if (memoryIds === null
    || bagRows.some((row, index) => row.id !== memoryIds[index])) {
    return null;
  }

  const ordinaryQuery = conversationProductTypedDb.select({
      memory_id: memoryNamespaces.memoryId,
      namespace_id: memoryNamespaces.namespaceId,
    }).from(memoryNamespaces).where(inArray(
      memoryNamespaces.memoryId,
      [...memoryIds],
    )).orderBy(
      asc(memoryNamespaces.memoryId),
      asc(memoryNamespaces.namespaceId),
    );
  const ordinaryRows = await executeTypedConversationProductQuery(
    input.transaction,
    locked
      ? ordinaryQuery.for("share", { of: memoryNamespaces })
      : ordinaryQuery,
  );
  const allScopeQuery = conversationProductTypedDb.select({
      memory_id: memoryScopes.memoryId,
      scope_id: memoryScopes.scopeId,
      origin: memoryScopes.origin,
    }).from(memoryScopes).where(inArray(
      memoryScopes.memoryId,
      [...memoryIds],
    )).orderBy(
      asc(memoryScopes.memoryId),
      asc(memoryScopes.scopeId),
    );
  // Do not lock foreign Scope edges after holding the owning Memory row: Scope
  // close takes its edge before that Memory and the reverse order deadlocks.
  // Foreign seed additions do not change the required audience. Origin
  // promotion/deletion must first take the Memory UPDATE lock, which conflicts
  // with the locked reader's bag-Memory SHARE lock.
  const allScopeRows = await executeTypedConversationProductQuery(
    input.transaction,
    allScopeQuery,
  );

  const ordinaryByMemory = new Map<string, string[]>();
  for (const row of ordinaryRows) {
    if (!memoryIds.includes(row.memory_id) || !UUID.test(row.namespace_id)) {
      return null;
    }
    const entries = ordinaryByMemory.get(row.memory_id) ?? [];
    if (entries.length > 0 && entries[entries.length - 1]! >= row.namespace_id) {
      return null;
    }
    entries.push(row.namespace_id);
    ordinaryByMemory.set(row.memory_id, entries);
  }
  const scopesByMemory = new Map<
    string,
    Array<Readonly<{ scopeId: string; origin: "seed" | "scope" }>>
  >();
  for (const row of allScopeRows) {
    if (!memoryIds.includes(row.memory_id) || !UUID.test(row.scope_id)
      || (row.origin !== "seed" && row.origin !== "scope")) return null;
    const entries = scopesByMemory.get(row.memory_id) ?? [];
    if (entries.length > 0 && entries[entries.length - 1]!.scopeId
      >= row.scope_id) return null;
    entries.push(Object.freeze({ scopeId: row.scope_id, origin: row.origin }));
    scopesByMemory.set(row.memory_id, entries);
  }

  const result: TaskScopeMemoryMetadata[] = [];
  for (const row of bagRows) {
    const contentRevision = rowInteger(row, "content_revision");
    const cryptoAccessRevision = rowInteger(row, "crypto_access_revision");
    if (row.origin !== "seed" && row.origin !== "scope") return null;
    if (contentRevision < 0 || cryptoAccessRevision < 0
      || (row.scope_origin_namespace_id !== null
        && !UUID.test(row.scope_origin_namespace_id))) return null;
    const allScopeEdges = scopesByMemory.get(row.id) ?? [];
    const currentEdges = allScopeEdges.filter((edge) =>
      edge.scopeId === coordinates.scopeId);
    if (currentEdges.length !== 1 || currentEdges[0]!.origin !== row.origin
      || row.origin === "scope"
        && row.scope_origin_namespace_id === null) return null;

    const ordinaryNamespaceIds = canonicalIds(
      ordinaryByMemory.get(row.id) ?? [],
    );
    if (ordinaryNamespaceIds === null) return null;
    let requiredNamespaceIds: readonly string[];
    try {
      requiredNamespaceIds = resolveRequiredMemoryNamespaceIds({
        namespaceIds: ordinaryNamespaceIds,
        scopeOrigins: allScopeEdges.map((edge) => edge.origin),
        originWritableNamespaceId: row.scope_origin_namespace_id,
      });
    } catch {
      return null;
    }

    let fingerprint: Uint8Array | null;
    try {
      fingerprint = rowNullableBytes(
        row,
        "crypto_required_namespace_fingerprint",
      );
    } catch {
      return null;
    }
    if (row.crypto_object_id === null) {
      if (row.crypto_mapping_state !== "unmapped" || fingerprint !== null) {
        return null;
      }
    } else {
      if ((row.crypto_mapping_state !== "verified"
          && row.crypto_mapping_state !== "stale")
        || contentRevision < 1
        || fingerprint === null || fingerprint.length !== 32
        || row.crypto_object_id !== deriveMemoryCryptoObjectIdV1({
          memoryId: row.id,
          contentRevision,
        })) return null;
      if (row.crypto_mapping_state === "verified") {
        const currentFingerprint = fingerprintRequiredMemoryNamespaces(
          requiredNamespaceIds,
        );
        const matches = sameBytes(fingerprint, currentFingerprint);
        currentFingerprint.fill(0);
        if (!matches) return null;
      }
    }
    const ordinary = [...ordinaryNamespaceIds];
    const required = [...requiredNamespaceIds];
    Object.freeze(ordinary);
    Object.freeze(required);
    result.push(Object.freeze({
      memoryId: row.id,
      origin: row.origin,
      contentRevision,
      cryptoObjectId: row.crypto_object_id,
      cryptoAccessRevision,
      mappingState: row.crypto_mapping_state,
      requiredNamespaceIds: required,
      ordinaryNamespaceIds: ordinary,
      scopeOriginNamespaceId: row.scope_origin_namespace_id,
      requiredNamespaceFingerprint: fingerprint === null
        ? null
        : fingerprint.slice(),
    }));
  }
  return Object.freeze(result);
}

/**
 * Discover detached, content-free planning metadata for a Task Scope without
 * taking product locks. This is not grant authority. The caller must filter
 * candidates through current canonical Namespace admission, acquire the
 * canonical Namespace/Room locks, then call the locked reader and compare the
 * selected inventory before using it.
 */
export function discoverTaskScopeMemoryMetadata(
  input: TaskScopeMemoryMetadataInput,
): Promise<readonly TaskScopeMemoryMetadata[] | null> {
  return queryTaskScopeMemoryMetadata(input, false);
}

/**
 * Read content-free Memory metadata for one exact Task Scope.
 *
 * The caller must already hold current Task evidence plus the canonical policy,
 * Namespace, and Memory Room locks in this serializable, directly authenticated
 * `nautilo` product transaction. `nautilo_agent` is rejected because RLS could
 * truncate foreign audience edges. This helper opens no transaction and takes
 * no Room lock. Its lock order is Task, Scope, sorted Scope-bag Memories, then
 * sorted ordinary edges. It reads all Scope edges without locking them to avoid
 * the Scope-close edge/Memory lock cycle; origin promotion or deletion must
 * retain the owning Memory-row UPDATE lock contract so this complete audience
 * stays stable.
 */
export function readCurrentTaskScopeMemoryMetadata(
  input: TaskScopeMemoryMetadataInput,
): Promise<readonly TaskScopeMemoryMetadata[] | null> {
  return queryTaskScopeMemoryMetadata(input, true);
}

/** Selected repair source only: take its UPDATE lock directly, without
 * SHARE-locking an overlapping bag and later upgrading one Memory. The caller
 * holds the same policy/Room/Scope/Task boundary as the read-only inventory. */
export function readCurrentTaskScopeMemoryMutationMetadata(
  input: TaskScopeMemoryMetadataInput & Readonly<{ memoryId: string }>,
): Promise<readonly TaskScopeMemoryMetadata[] | null> {
  return queryTaskScopeMemoryMetadata(input, true, input.memoryId);
}

async function queryTaskScopeMemoryNamespaceInventory(
  input: TaskScopeMemoryNamespaceInventoryInput,
  locked: boolean,
): Promise<TaskScopeMemoryNamespaceInventory | null> {
  if (!UUID.test(input.sourceRoomId) || !UUID.test(input.requesterHumanId)) {
    return null;
  }
  const metadata = await queryTaskScopeMemoryMetadata({
    transaction: input.transaction,
    coordinates: input.coordinates,
  }, locked);
  if (metadata === null) return null;

  // A Scope can be reused across Tasks whose current writable origins differ.
  // Each Scope-authored Memory retains its own durable origin as a read
  // candidate. Seed Memories remain selected only through ordinary edges;
  // their complete required audience stays in metadata for locked comparison.
  const candidates = new Set<string>([
    input.coordinates.originWritableNamespaceId,
  ]);
  for (const memory of metadata) {
    if (memory.origin === "scope") {
      if (memory.scopeOriginNamespaceId === null) return null;
      candidates.add(memory.scopeOriginNamespaceId);
    } else {
      for (const namespaceId of memory.ordinaryNamespaceIds) {
        candidates.add(namespaceId);
      }
    }
  }
  const candidateIds = [...candidates].sort();
  const readable = await findCurrentReadableNamespaceCandidates(
    input.transaction,
    {
      sourceRoomId: input.sourceRoomId,
      sourceHumanIds: [input.requesterHumanId],
      namespaceIds: candidateIds,
    },
  );
  const canonicalReadable = canonicalIds(readable);
  if (canonicalReadable === null
    || canonicalReadable.length !== readable.length
    || canonicalReadable.some((id, index) => id !== readable[index])
    || canonicalReadable.some((id) => !candidates.has(id))
    || !canonicalReadable.includes(
      input.coordinates.originWritableNamespaceId,
    )) return null;
  const readableNamespaceIds = [...canonicalReadable];
  Object.freeze(readableNamespaceIds);
  return Object.freeze({
    scopeId: input.coordinates.scopeId,
    originWritableNamespaceId:
      input.coordinates.originWritableNamespaceId,
    readableNamespaceIds,
  });
}

/**
 * Detached Namespace planning inventory for a Task Scope. It takes no locks,
 * grants no access, and intentionally excludes full-audience-only Namespace
 * IDs from seed candidates. The caller must use canonical Namespace admission
 * before treating any returned ID as selected.
 */
export function discoverTaskScopeMemoryNamespaceInventory(
  input: TaskScopeMemoryNamespaceInventoryInput,
): Promise<TaskScopeMemoryNamespaceInventory | null> {
  return queryTaskScopeMemoryNamespaceInventory(input, false);
}

/**
 * Re-read the Scope inventory after canonical Namespace and Room locks. The
 * final caller must compare this exact readable set with the fixed bound set;
 * the canonical Namespace owner must prove every selected Namespace.
 */
export function readCurrentTaskScopeMemoryNamespaceInventory(
  input: TaskScopeMemoryNamespaceInventoryInput,
): Promise<TaskScopeMemoryNamespaceInventory | null> {
  return queryTaskScopeMemoryNamespaceInventory(input, true);
}
