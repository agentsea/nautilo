import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  memories,
  memoryNamespaces,
  memoryScopes,
  or,
  sql,
} from "@nautilo/db";

import type {
  AgentMemoryEmbedding,
  AgentMemorySearchCandidate,
  ProtectedAgentMemoryFallbackSearchPort,
  ProtectedAgentMemoryProductPort,
  ProtectedMemoryCandidate,
  ProtectedMemorySessionOpenedItem,
} from "../../memory/active-memory-composition.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
  ProtectedMemoryUnavailableReason,
} from "../../memory/active-memory-repository.ts";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
} from "../../memory/foreground-embedding-processor.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import { resolveRequiredMemoryNamespaceIds } from
  "../../memory/required-namespace-set.ts";
import {
  assertConversationProductCanonicalTransactionRunner,
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import { readCryptoStorageInteger } from
  "../storage/postgres-lattice-storage.ts";
import {
  readCurrentTaskScopeMemoryMetadata,
  type TaskScopeCoordinates,
  type TaskScopeMemoryMetadata,
} from "../task/task-scope-memory-metadata.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MAX_CANDIDATES = 64;

type NamespaceAuthority = Extract<
  ProtectedMemoryAuthority,
  { mode: "namespace" }
>;
type ScopeAuthority = Extract<ProtectedMemoryAuthority, { mode: "scope" }>;
type CanonicalTransaction = Parameters<
  Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]
>[0];
type CanonicalExecutor = Parameters<
  Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]
>[1];

const taskMemoryReadReceipt = Symbol("task-memory-read-receipt");

type TaskMemoryReadReceipt<Value> = Readonly<{
  value: Value;
  [taskMemoryReadReceipt]: true;
}>;

/**
 * Trusted Task authority owner. The owner must keep its locks held while
 * `use` ranks, validates, and loads bodies on the supplied product
 * transaction, then return the exact receipt from that one callback use.
 */
export type TaskMemoryReadBoundary = Readonly<{
  withCurrentRead<Value>(input: Readonly<{
    transaction: CanonicalTransaction;
    executor: CanonicalExecutor;
    authority: ProtectedMemoryAuthority;
    use(): Promise<TaskMemoryReadReceipt<Value>>;
  }>): Promise<TaskMemoryReadReceipt<Value>>;
}>;

export type TaskMemoryReadBinding =
  | Readonly<{
      mode: "namespace";
      authority: NamespaceAuthority;
    }>
  | Readonly<{
      mode: "scope";
      authority: ScopeAuthority;
      coordinates: TaskScopeCoordinates;
      readableNamespaceIds: readonly string[];
    }>;

export interface ProtectedTaskMemoryReadPort
  extends ProtectedAgentMemoryFallbackSearchPort {
  searchProtectedCandidates(
    input: Parameters<ProtectedAgentMemoryProductPort["searchCandidates"]>[0],
  ): ReturnType<ProtectedAgentMemoryProductPort["searchCandidates"]>;

  loadExactProtectedSources(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    memoryIds: readonly string[];
    signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<readonly ProtectedMemoryCandidate[]>>;
}

type ValidatedEmbedding = AgentMemoryEmbedding & Readonly<{
  provider: "openai" | "openrouter" | "venice";
  contractVersion: typeof MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION;
}>;

type AuthorizedMemory = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string | null;
  mappingState: "unmapped" | "verified" | "stale";
  readNamespaceId: string;
  requiredNamespaceIds: readonly string[];
}>;

type RankedMemory = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  mappingState: "unmapped" | "verified" | "stale";
  importance: number;
  tier: number;
  score: number;
  distance: number;
  createdAt: Date;
  ordinaryTypePresent: boolean;
  ordinaryContentPresent: boolean;
}>;

function unavailable<Value>(
  reason: ProtectedMemoryUnavailableReason,
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function exactKeys(value: object, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}

function canonicalIds(
  values: readonly string[],
  allowEmpty: boolean,
): readonly string[] | null {
  if ((!allowEmpty && values.length === 0)
    || values.some((value) => !UUID.test(value))
    || values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    return null;
  }
  return Object.freeze([...values]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function snapshotNamespaceAuthority(
  value: ProtectedMemoryAuthority,
): NamespaceAuthority | null {
  if (value.mode !== "namespace"
    || !exactKeys(
      value,
      "agentId,mode,mutableNamespaceIds,readableNamespaceIds,subjectUserId,writableNamespaceId",
    )
    || !UUID.test(value.subjectUserId)
    || !UUID.test(value.agentId)) return null;
  const readableNamespaceIds = canonicalIds(value.readableNamespaceIds, false);
  const mutableNamespaceIds = canonicalIds(value.mutableNamespaceIds, true);
  if (readableNamespaceIds === null || mutableNamespaceIds === null
    || !mutableNamespaceIds.every(id => readableNamespaceIds.includes(id))
    || (value.writableNamespaceId !== null
      && (!UUID.test(value.writableNamespaceId)
        || !mutableNamespaceIds.includes(value.writableNamespaceId)))) return null;
  return Object.freeze({
    ...value,
    readableNamespaceIds,
    mutableNamespaceIds,
  });
}

function snapshotScopeAuthority(
  value: ProtectedMemoryAuthority,
): ScopeAuthority | null {
  return value.mode === "scope"
      && exactKeys(
        value,
        "agentId,mode,originWritableNamespaceId,scopeId,subjectUserId",
      )
      && UUID.test(value.subjectUserId)
      && UUID.test(value.agentId)
      && UUID.test(value.scopeId)
      && UUID.test(value.originWritableNamespaceId)
    ? Object.freeze({ ...value })
    : null;
}

function sameAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId) return false;
  return left.mode === "scope" && right.mode === "scope"
    ? left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId
    : left.mode === "namespace" && right.mode === "namespace"
      && left.writableNamespaceId === right.writableNamespaceId
      && sameIds(left.readableNamespaceIds, right.readableNamespaceIds)
      && sameIds(left.mutableNamespaceIds, right.mutableNamespaceIds);
}

function validCoordinates(value: TaskScopeCoordinates): boolean {
  return exactKeys(
    value,
    "agentId,memoryRoomId,originWritableNamespaceId,requesterUserId,scopeId,taskId",
  )
    && UUID.test(value.taskId)
    && UUID.test(value.requesterUserId)
    && UUID.test(value.agentId)
    && UUID.test(value.scopeId)
    && UUID.test(value.memoryRoomId)
    && UUID.test(value.originWritableNamespaceId);
}

function validEmbedding(value: AgentMemoryEmbedding): value is ValidatedEmbedding {
  return value.dimensions === MEMORY_EMBEDDING_DIMENSIONS
    && value.contractVersion === MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION
    && value.vector.length === MEMORY_EMBEDDING_DIMENSIONS
    && value.vector.every(Number.isFinite)
    && (value.provider === "openai"
      || value.provider === "openrouter"
      || value.provider === "venice")
    && PORTABLE.test(value.canonicalModel);
}

function snapshotEmbedding(value: ValidatedEmbedding): ValidatedEmbedding {
  return Object.freeze({ ...value, vector: Object.freeze([...value.vector]) });
}

function rowString(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not text`);
  return value;
}

function rowNullableString(
  row: ConversationProductDatabaseRow,
  field: string,
): string | null {
  return row[field] === null ? null : rowString(row, field);
}

function rowFiniteNumber(
  row: ConversationProductDatabaseRow,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} is not a finite number`);
  }
  return value;
}

function rowInteger(
  row: ConversationProductDatabaseRow,
  field: string,
): number {
  return readCryptoStorageInteger(
    row as Parameters<typeof readCryptoStorageInteger>[0],
    field,
  );
}

function rowBoolean(row: ConversationProductDatabaseRow, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new TypeError(`${field} is not boolean`);
  return value;
}

function rowNullableBytes(
  row: ConversationProductDatabaseRow,
  field: string,
): Uint8Array | null {
  const value = row[field];
  if (value === null) return null;
  if (!ArrayBuffer.isView(value)) throw new TypeError(`${field} is not binary`);
  return new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).slice();
}

function rowDate(row: ConversationProductDatabaseRow, field: string): Date {
  const raw = row[field];
  const date = raw instanceof Date
    ? new Date(raw.getTime())
    : typeof raw === "string" ? new Date(raw) : null;
  if (date === null || !Number.isFinite(date.getTime())) {
    throw new TypeError(`${field} is not a timestamp`);
  }
  return date;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function representation(
  memory: AuthorizedMemory,
  row: RankedMemory,
): AgentMemorySearchCandidate["representation"] | "excluded" | null {
  if (memory.mappingState !== row.mappingState
    || memory.contentRevision !== row.contentRevision
    || memory.cryptoAccessRevision !== row.cryptoAccessRevision
    || row.ordinaryTypePresent !== row.ordinaryContentPresent) return null;
  if (memory.mappingState === "stale") return "excluded";
  if (memory.mappingState === "unmapped") {
    return row.ordinaryTypePresent ? "ordinary_only" : "excluded";
  }
  return row.ordinaryTypePresent ? "dual" : "protected_only";
}

function rankedMemory(row: ConversationProductDatabaseRow): RankedMemory | null {
  const mappingState = rowString(row, "crypto_mapping_state");
  const importance = rowFiniteNumber(row, "importance");
  const tier = rowInteger(row, "tier");
  const score = rowFiniteNumber(row, "similarity");
  const distance = rowFiniteNumber(row, "distance");
  const result = Object.freeze({
    memoryId: rowString(row, "memory_id"),
    contentRevision: rowInteger(row, "content_revision"),
    cryptoAccessRevision: rowInteger(row, "crypto_access_revision"),
    mappingState,
    importance,
    tier,
    score,
    distance,
    createdAt: rowDate(row, "created_at"),
    ordinaryTypePresent: rowBoolean(row, "ordinary_type_present"),
    ordinaryContentPresent: rowBoolean(row, "ordinary_content_present"),
  });
  return UUID.test(result.memoryId)
      && (mappingState === "unmapped" || mappingState === "verified"
        || mappingState === "stale")
      && importance >= 0 && importance <= 1
      && tier >= 1 && tier <= 3
      && score >= -1 && score <= 1
      && distance >= 0
    ? result as RankedMemory
    : null;
}

function toProtectedCandidate(
  memory: AuthorizedMemory,
  row: RankedMemory,
): ProtectedMemoryCandidate | null {
  const mode = representation(memory, row);
  return mode !== "excluded" && mode !== null && mode !== "ordinary_only"
      && memory.cryptoObjectId !== null
    ? Object.freeze({
        memoryId: memory.memoryId,
        contentRevision: memory.contentRevision,
        cryptoAccessRevision: memory.cryptoAccessRevision,
        cryptoObjectId: memory.cryptoObjectId,
        readNamespaceId: memory.readNamespaceId,
        requiredNamespaceIds: memory.requiredNamespaceIds,
        importance: row.importance,
        tier: row.tier,
        score: row.score,
        createdAt: row.createdAt,
      })
    : null;
}

function toSearchCandidate(
  memory: AuthorizedMemory,
  row: RankedMemory,
): AgentMemorySearchCandidate | "excluded" | null {
  const mode = representation(memory, row);
  if (mode === null || mode === "excluded") return mode;
  const common = {
    memoryId: memory.memoryId,
    contentRevision: memory.contentRevision,
    cryptoAccessRevision: memory.cryptoAccessRevision,
    readNamespaceId: memory.readNamespaceId,
    requiredNamespaceIds: memory.requiredNamespaceIds,
    importance: row.importance,
    tier: row.tier,
    score: row.score,
    createdAt: row.createdAt,
  };
  return mode === "ordinary_only"
    ? Object.freeze({ ...common, representation: mode, cryptoObjectId: null })
    : memory.cryptoObjectId === null ? null : Object.freeze({
        ...common,
        representation: mode,
        cryptoObjectId: memory.cryptoObjectId,
      });
}

function validSearchCandidateSnapshot(
  value: AgentMemorySearchCandidate,
): boolean {
  const required = canonicalIds(value.requiredNamespaceIds, false);
  return required !== null
    && UUID.test(value.memoryId)
    && Number.isSafeInteger(value.contentRevision)
    && value.contentRevision >= (value.representation === "ordinary_only" ? 0 : 1)
    && Number.isSafeInteger(value.cryptoAccessRevision)
    && value.cryptoAccessRevision >= 0
    && UUID.test(value.readNamespaceId)
    && required.includes(value.readNamespaceId)
    && (value.representation === "ordinary_only"
      ? value.cryptoObjectId === null
      : value.cryptoObjectId === deriveMemoryCryptoObjectIdV1({
          memoryId: value.memoryId,
          contentRevision: value.contentRevision,
        }));
}

export class PostgresTaskMemoryReadPort implements ProtectedTaskMemoryReadPort {
  readonly #canonicalRunner: ConversationProductCanonicalTransactionRunner;
  readonly #binding: TaskMemoryReadBinding;
  readonly #boundary: TaskMemoryReadBoundary;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    canonicalRunner: ConversationProductCanonicalTransactionRunner;
    binding: TaskMemoryReadBinding;
    boundary: TaskMemoryReadBoundary;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    assertConversationProductCanonicalTransactionRunner(
      input.handle,
      input.canonicalRunner,
    );
    if (input.handle.role !== "nautilo") {
      throw new TypeError("Task Memory reader requires a direct nautilo handle");
    }
    if (typeof input.boundary?.withCurrentRead !== "function") {
      throw new TypeError("Task Memory read boundary is invalid");
    }
    if (input.binding.mode === "namespace") {
      const authority = snapshotNamespaceAuthority(input.binding.authority);
      if (authority === null) {
        throw new TypeError("Task Namespace Memory authority is invalid");
      }
      this.#binding = Object.freeze({ mode: "namespace", authority });
    } else {
      const authority = snapshotScopeAuthority(input.binding.authority);
      const readableNamespaceIds = canonicalIds(
        input.binding.readableNamespaceIds,
        false,
      );
      if (authority === null || !validCoordinates(input.binding.coordinates)
        || input.binding.coordinates.requesterUserId !== authority.subjectUserId
        || input.binding.coordinates.agentId !== authority.agentId
        || input.binding.coordinates.scopeId !== authority.scopeId
        || input.binding.coordinates.originWritableNamespaceId
          !== authority.originWritableNamespaceId
        || readableNamespaceIds === null
        || !readableNamespaceIds.includes(authority.originWritableNamespaceId)) {
        throw new TypeError("Task Scope Memory binding is invalid");
      }
      this.#binding = Object.freeze({
        mode: "scope",
        authority,
        coordinates: Object.freeze({ ...input.binding.coordinates }),
        readableNamespaceIds,
      });
    }
    this.#canonicalRunner = input.canonicalRunner;
    this.#boundary = Object.freeze({ ...input.boundary });
  }

  #authority(value: ProtectedMemoryAuthority): ProtectedMemoryAuthority | null {
    const authority = value.mode === "namespace"
      ? snapshotNamespaceAuthority(value)
      : snapshotScopeAuthority(value);
    return authority !== null && sameAuthority(authority, this.#binding.authority)
      ? authority
      : null;
  }

  async #identityCurrent(
    transaction: ConversationProductPostgresTransaction,
    authority: ProtectedMemoryAuthority,
  ): Promise<boolean> {
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        current_user: sql<string>`current_user::text`.as("current_user"),
        session_user: sql<string>`session_user::text`.as("session_user"),
        current_user_id: sql<string>`app_current_user_id()::text`
          .as("current_user_id"),
        current_agent_id: sql<string | null>`app_current_agent_id()::text`
          .as("current_agent_id"),
      }).from(sql`(values (1)) as identity_probe`).limit(2),
    );
    const row = rows[0];
    return rows.length === 1 && row !== undefined
      && row.current_user === "nautilo"
      && row.session_user === "nautilo"
      && row.current_user_id === authority.subjectUserId
      && (row.current_agent_id === null
        || row.current_agent_id === authority.agentId);
  }

  async #transaction<Value>(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    signal?: AbortSignal;
    use(
      transaction: ConversationProductPostgresTransaction,
    ): Promise<ProtectedMemoryResult<Value>>;
  }>): Promise<ProtectedMemoryResult<Value>> {
    input.signal?.throwIfAborted();
    return this.#canonicalRunner.transaction(async (canonical, transaction) => {
      let ownerOpen = true;
      let useCalls = 0;
      let completedReceipt: TaskMemoryReadReceipt<
        ProtectedMemoryResult<Value>
      > | null = null;
      const getCompletedReceipt = () => completedReceipt;
      let ownerReceipt: TaskMemoryReadReceipt<ProtectedMemoryResult<Value>>;
      try {
        ownerReceipt = await this.#boundary.withCurrentRead({
          transaction: canonical,
          executor: transaction,
          authority: input.authority,
          use: async () => {
            useCalls += 1;
            if (useCalls !== 1 || !ownerOpen) {
              throw new TypeError("Task Memory read callback is one-use");
            }
            input.signal?.throwIfAborted();
            if (!await this.#identityCurrent(transaction, input.authority)) {
              const receipt: TaskMemoryReadReceipt<
                ProtectedMemoryResult<Value>
              > = Object.freeze({
                value: unavailable<Value>("authorization_required"),
                [taskMemoryReadReceipt]: true as const,
              });
              completedReceipt = receipt;
              return receipt;
            }
            if (!ownerOpen) {
              throw new TypeError(
                "Task Memory read callback escaped its authority owner",
              );
            }
            const result = await input.use(transaction);
            if (!ownerOpen) {
              throw new TypeError(
                "Task Memory read callback escaped its authority owner",
              );
            }
            input.signal?.throwIfAborted();
            const receipt: TaskMemoryReadReceipt<
              ProtectedMemoryResult<Value>
            > = Object.freeze({
              value: result,
              [taskMemoryReadReceipt]: true as const,
            });
            completedReceipt = receipt;
            return receipt;
          },
        });
      } finally {
        ownerOpen = false;
      }
      const completed = getCompletedReceipt();
      if (
        useCalls !== 1
        || completed === null
        || ownerReceipt !== completed
      ) {
        throw new TypeError(
          "Task Memory read authority owner returned a manufactured result",
        );
      }
      return completed.value;
    }, { isolationLevel: "serializable" });
  }

  async #ordinaryEdges(
    transaction: ConversationProductPostgresTransaction,
    memoryIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]> | null> {
    if (memoryIds.length === 0) return new Map();
    // The parent Memory rows are already SHARE-locked in canonical UUID order.
    // Read their child edges from the serializable snapshot: locking an edge
    // here can deadlock with detach, whose invalidation trigger updates parent.
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        memory_id: memoryNamespaces.memoryId,
        namespace_id: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(inArray(
        memoryNamespaces.memoryId,
        [...memoryIds],
      )).orderBy(
        asc(memoryNamespaces.memoryId),
        asc(memoryNamespaces.namespaceId),
      ),
    );
    const result = new Map<string, string[]>();
    for (const row of rows) {
      if (!memoryIds.includes(row.memory_id) || !UUID.test(row.namespace_id)) {
        return null;
      }
      const entries = result.get(row.memory_id) ?? [];
      if (entries.length > 0 && entries[entries.length - 1]! >= row.namespace_id) {
        return null;
      }
      entries.push(row.namespace_id);
      result.set(row.memory_id, entries);
    }
    return new Map([...result].map(([memoryId, namespaceIds]) => [
      memoryId,
      Object.freeze(namespaceIds),
    ]));
  }

  async #namespaceInventory(
    transaction: ConversationProductPostgresTransaction,
    authority: NamespaceAuthority,
    memoryIds: readonly string[],
  ): Promise<ReadonlyMap<string, AuthorizedMemory> | null> {
    if (memoryIds.length === 0) return new Map();
    const scopeOriginCount = sql<number>`(
      SELECT count(*)::int FROM ${memoryScopes}
       WHERE ${memoryScopes.memoryId} = ${memories.id}
         AND ${memoryScopes.origin} = 'scope'
    )`;
    const rows = await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_object_id: memories.cryptoObjectId,
        crypto_mapping_state: memories.cryptoMappingState,
        crypto_required_namespace_fingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scope_origin_namespace_id: memories.scopeOriginNamespaceId,
        scope_origin_count: scopeOriginCount.as("scope_origin_count"),
      }).from(memories).where(inArray(memories.id, [...memoryIds]))
        .orderBy(asc(memories.id)).for("share", { of: memories }),
    );
    if (rows.length !== memoryIds.length) return null;
    const edges = await this.#ordinaryEdges(transaction, memoryIds);
    if (edges === null) return null;
    const result = new Map<string, AuthorizedMemory>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const memoryId = rowString(row, "memory_id");
      if (memoryId !== memoryIds[index]) return null;
      const ordinaryNamespaceIds = edges.get(memoryId) ?? [];
      const scopeOriginCountValue = rowInteger(
        row,
        "scope_origin_count",
      );
      const scopeOriginNamespaceId = rowNullableString(
        row,
        "scope_origin_namespace_id",
      );
      if (scopeOriginCountValue > 1
        || (scopeOriginCountValue === 0) !== (scopeOriginNamespaceId === null)
        || scopeOriginNamespaceId !== null && !UUID.test(scopeOriginNamespaceId)) {
        return null;
      }
      let requiredNamespaceIds: readonly string[];
      try {
        requiredNamespaceIds = resolveRequiredMemoryNamespaceIds({
          namespaceIds: ordinaryNamespaceIds,
          scopeOrigins: scopeOriginCountValue === 1 ? ["scope"] : [],
          originWritableNamespaceId: scopeOriginNamespaceId,
        });
      } catch {
        return null;
      }
      const readNamespaceId = ordinaryNamespaceIds.find(id =>
        authority.readableNamespaceIds.includes(id));
      if (readNamespaceId === undefined) continue;
      const mappingState = rowString(row, "crypto_mapping_state");
      const cryptoObjectId = rowNullableString(row, "crypto_object_id");
      const fingerprint = rowNullableBytes(
        row,
        "crypto_required_namespace_fingerprint",
      );
      const contentRevision = rowInteger(row, "content_revision");
      const cryptoAccessRevision = rowInteger(
        row,
        "crypto_access_revision",
      );
      if (mappingState === "unmapped") {
        if (cryptoObjectId !== null || fingerprint !== null) return null;
      } else if (mappingState === "verified" || mappingState === "stale") {
        if (contentRevision < 1 || cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
          memoryId,
          contentRevision,
        }) || fingerprint === null || fingerprint.length !== 32) return null;
        if (mappingState === "verified") {
          const expected = fingerprintRequiredMemoryNamespaces(requiredNamespaceIds);
          const matches = sameBytes(expected, fingerprint);
          expected.fill(0);
          if (!matches) return null;
        }
      } else return null;
      result.set(memoryId, Object.freeze({
        memoryId,
        contentRevision,
        cryptoAccessRevision,
        cryptoObjectId,
        mappingState,
        readNamespaceId,
        requiredNamespaceIds: Object.freeze([...requiredNamespaceIds]),
      }));
    }
    return result;
  }

  #scopeInventory(
    metadata: readonly TaskScopeMemoryMetadata[],
  ): ReadonlyMap<string, AuthorizedMemory> | null {
    const binding = this.#binding;
    if (binding.mode !== "scope") return null;
    const result = new Map<string, AuthorizedMemory>();
    let previous: string | undefined;
    for (const entry of metadata) {
      if (previous !== undefined && previous >= entry.memoryId) return null;
      previous = entry.memoryId;
      if (entry.origin === "scope" && entry.scopeOriginNamespaceId === null) {
        const legacyUnavailable = entry.mappingState === "unmapped"
          && entry.cryptoObjectId === null
          && entry.requiredNamespaceFingerprint === null
          && entry.requiredNamespaceIds.length === 0
          && entry.ordinaryNamespaceIds.length === 0;
        if (legacyUnavailable) continue;
        return null;
      }
      const required = canonicalIds(entry.requiredNamespaceIds, false);
      const ordinary = canonicalIds(entry.ordinaryNamespaceIds, true);
      if (required === null || ordinary === null) return null;
      let readNamespaceId: string | undefined;
      if (entry.origin === "scope") {
        if (entry.scopeOriginNamespaceId === null
          || !binding.readableNamespaceIds.includes(
            entry.scopeOriginNamespaceId,
          )
          || !required.includes(entry.scopeOriginNamespaceId)) {
          continue;
        }
        readNamespaceId = entry.scopeOriginNamespaceId;
      } else {
        readNamespaceId = ordinary.find(id =>
          binding.readableNamespaceIds.includes(id));
        if (readNamespaceId === undefined || !required.includes(readNamespaceId)) {
          continue;
        }
      }
      if (entry.mappingState === "unmapped") {
        if (entry.cryptoObjectId !== null
          || entry.requiredNamespaceFingerprint !== null) return null;
      } else if (entry.mappingState === "verified" || entry.mappingState === "stale") {
        if (entry.contentRevision < 1
          || entry.cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
            memoryId: entry.memoryId,
            contentRevision: entry.contentRevision,
          })
          || !(entry.requiredNamespaceFingerprint instanceof Uint8Array)
          || entry.requiredNamespaceFingerprint.length !== 32) return null;
        if (entry.mappingState === "verified") {
          const expected = fingerprintRequiredMemoryNamespaces(required);
          const matches = sameBytes(expected, entry.requiredNamespaceFingerprint);
          expected.fill(0);
          if (!matches) return null;
        }
      } else return null;
      result.set(entry.memoryId, Object.freeze({
        memoryId: entry.memoryId,
        contentRevision: entry.contentRevision,
        cryptoAccessRevision: entry.cryptoAccessRevision,
        cryptoObjectId: entry.cryptoObjectId,
        mappingState: entry.mappingState,
        readNamespaceId,
        requiredNamespaceIds: required,
      }));
    }
    return result;
  }

  async #currentInventory(
    transaction: ConversationProductPostgresTransaction,
    authority: ProtectedMemoryAuthority,
    memoryIds?: readonly string[],
  ): Promise<ReadonlyMap<string, AuthorizedMemory> | null> {
    if (this.#binding.mode === "namespace" && authority.mode === "namespace") {
      if (memoryIds === undefined) return null;
      return this.#namespaceInventory(transaction, authority, memoryIds);
    }
    if (this.#binding.mode !== "scope" || authority.mode !== "scope") return null;
    const metadata = await readCurrentTaskScopeMemoryMetadata({
      transaction,
      coordinates: this.#binding.coordinates,
    });
    return metadata === null ? null : this.#scopeInventory(metadata);
  }

  async #rankRows(input: Readonly<{
    transaction: ConversationProductPostgresTransaction;
    authority: ProtectedMemoryAuthority;
    embedding?: ValidatedEmbedding;
    memoryIds?: readonly string[];
    limit: number;
    includeArchive: boolean;
    fallback: boolean;
    cursor?: Readonly<{ distance: number; memoryId: string }>;
  }>): Promise<readonly RankedMemory[] | null> {
    const distance = input.embedding === undefined
      ? sql<number>`0::double precision`
      : sql<number>`${memories.embedding} <=> ${
          vectorLiteral(input.embedding.vector)
        }::vector`;
    const namespaceVisible = input.authority.mode === "namespace"
      ? exists(conversationProductTypedDb.select({
          memory_id: memoryNamespaces.memoryId,
        }).from(memoryNamespaces).where(and(
          eq(memoryNamespaces.memoryId, memories.id),
          inArray(
            memoryNamespaces.namespaceId,
            [...input.authority.readableNamespaceIds],
          ),
        )))
      : undefined;
    // Keep semantic ranking as a snapshot read. Namespace inventory takes the
    // selected Memory SHARE locks in UUID order immediately afterward; locking
    // this distance-ordered query would invert that canonical row order.
    // Scope inventory already holds its whole bag in UUID order.
    const rows = await executeTypedConversationProductQuery(
      input.transaction,
      conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_mapping_state: memories.cryptoMappingState,
        importance: memories.importance,
        tier: memories.tier,
        created_at: memories.createdAt,
        ordinary_type_present: sql<boolean>`${memories.type} IS NOT NULL`
          .as("ordinary_type_present"),
        ordinary_content_present: sql<boolean>`${memories.content} IS NOT NULL`
          .as("ordinary_content_present"),
        distance: distance.as("distance"),
        similarity: sql<number>`1 - (${distance})`.as("similarity"),
      }).from(memories).where(and(
        input.memoryIds === undefined
          ? namespaceVisible
          : inArray(memories.id, [...input.memoryIds]),
        input.embedding === undefined ? undefined : and(
          eq(memories.embeddingRevision, memories.contentRevision),
          eq(memories.embeddingProvider, input.embedding.provider),
          eq(memories.embeddingModel, input.embedding.canonicalModel),
          eq(memories.embeddingDimensions, input.embedding.dimensions),
          eq(memories.embeddingContractVersion, input.embedding.contractVersion),
          isNotNull(memories.embedding),
        ),
        input.includeArchive ? undefined : lt(memories.tier, 3),
        input.fallback ? or(
          and(
            eq(memories.cryptoMappingState, "verified"),
            gt(memories.contentRevision, 0),
            isNotNull(memories.cryptoObjectId),
            isNotNull(memories.cryptoRequiredNamespaceFingerprint),
          ),
          and(
            eq(memories.cryptoMappingState, "unmapped"),
            isNull(memories.cryptoObjectId),
            isNull(memories.cryptoRequiredNamespaceFingerprint),
            isNotNull(memories.type),
            isNotNull(memories.content),
          ),
        ) : and(
          eq(memories.cryptoMappingState, "verified"),
          gt(memories.contentRevision, 0),
          isNotNull(memories.cryptoObjectId),
          isNotNull(memories.cryptoRequiredNamespaceFingerprint),
        ),
        input.cursor === undefined ? undefined : or(
          gt(distance, input.cursor.distance),
          and(eq(distance, input.cursor.distance),
            gt(memories.id, input.cursor.memoryId)),
        ),
      )).orderBy(asc(distance), asc(memories.id)).limit(input.limit),
    );
    const result: RankedMemory[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const ranked = rankedMemory(row);
      if (ranked === null || seen.has(ranked.memoryId)) return null;
      seen.add(ranked.memoryId);
      result.push(ranked);
    }
    return Object.freeze(result);
  }

  async #search(
    input: Parameters<ProtectedAgentMemoryProductPort["searchCandidates"]>[0],
    fallback: boolean,
  ): Promise<ProtectedMemoryResult<readonly (
    ProtectedMemoryCandidate | AgentMemorySearchCandidate
  )[]>> {
    const authority = this.#authority(input.authority);
    if (authority === null || !validEmbedding(input.embedding)
      || !Number.isSafeInteger(input.limit) || input.limit < 1
      || input.limit > MAX_CANDIDATES
      || typeof input.includeArchive !== "boolean") {
      return unavailable("authorization_required");
    }
    const embedding = snapshotEmbedding(input.embedding);
    return this.#transaction({
      authority,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      use: async transaction => {
        const selected: Array<ProtectedMemoryCandidate | AgentMemorySearchCandidate> = [];
        let inventory = this.#binding.mode === "scope"
          ? await this.#currentInventory(transaction, authority)
          : undefined;
        if (inventory === null) return unavailable("authorization_required");
        let cursor: Readonly<{ distance: number; memoryId: string }> | undefined;
        for (;;) {
          const rows = await this.#rankRows({
            transaction,
            authority,
            embedding,
            ...(inventory === undefined ? {} : {
              memoryIds: Object.freeze([...inventory.keys()]),
            }),
            limit: input.limit,
            includeArchive: input.includeArchive,
            fallback,
            ...(cursor === undefined ? {} : { cursor }),
          });
          input.signal?.throwIfAborted();
          if (rows === null) return unavailable("integrity_failure");
          if (rows.length === 0) break;
          const last = rows[rows.length - 1]!;
          if (cursor !== undefined && (last.distance < cursor.distance
            || last.distance === cursor.distance
              && last.memoryId <= cursor.memoryId)) {
            return unavailable("integrity_failure");
          }
          cursor = Object.freeze({
            distance: last.distance,
            memoryId: last.memoryId,
          });
          if (inventory === undefined) {
            inventory = await this.#currentInventory(
              transaction,
              authority,
              Object.freeze(rows.map(row => row.memoryId).sort()),
            );
            if (inventory === null) return unavailable("integrity_failure");
          }
          for (const row of rows) {
            const memory = inventory.get(row.memoryId);
            if (memory === undefined) continue;
            const candidate = fallback
              ? toSearchCandidate(memory, row)
              : toProtectedCandidate(memory, row);
            if (candidate === null) return unavailable("integrity_failure");
            if (candidate !== "excluded") selected.push(candidate);
            if (selected.length === input.limit) break;
          }
          if (selected.length === input.limit || rows.length < input.limit
            || this.#binding.mode === "scope") break;
          inventory = undefined;
        }
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze(selected),
        });
      },
    });
  }

  searchProtectedCandidates(
    input: Parameters<ProtectedAgentMemoryProductPort["searchCandidates"]>[0],
  ): ReturnType<ProtectedAgentMemoryProductPort["searchCandidates"]> {
    return this.#search(input, false) as ReturnType<
      ProtectedAgentMemoryProductPort["searchCandidates"]
    >;
  }

  searchCandidates(
    input: Parameters<ProtectedAgentMemoryFallbackSearchPort["searchCandidates"]>[0],
  ): ReturnType<ProtectedAgentMemoryFallbackSearchPort["searchCandidates"]> {
    return this.#search(input, true) as ReturnType<
      ProtectedAgentMemoryFallbackSearchPort["searchCandidates"]
    >;
  }

  async loadExactProtectedSources(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    memoryIds: readonly string[];
    signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<readonly ProtectedMemoryCandidate[]>> {
    const authority = this.#authority(input.authority);
    const memoryIds = canonicalIds(input.memoryIds, false);
    if (authority === null || memoryIds === null) {
      return unavailable("authorization_required");
    }
    return this.#transaction({
      authority,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      use: async transaction => {
        const inventory = await this.#currentInventory(
          transaction,
          authority,
          memoryIds,
        );
        if (inventory === null
          || memoryIds.some(memoryId => !inventory.has(memoryId))) {
          return unavailable("authorization_required");
        }
        const rows = await this.#rankRows({
          transaction,
          authority,
          memoryIds,
          limit: memoryIds.length,
          includeArchive: true,
          fallback: false,
        });
        if (rows === null || rows.length !== memoryIds.length) {
          return unavailable("stale_revision");
        }
        const result: ProtectedMemoryCandidate[] = [];
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]!;
          if (row.memoryId !== memoryIds[index]) {
            return unavailable("integrity_failure");
          }
          const candidate = toProtectedCandidate(inventory.get(row.memoryId)!, row);
          if (candidate === null) return unavailable("stale_revision");
          result.push(candidate);
        }
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze(result),
        });
      },
    });
  }

  async loadExactOrdinary(
    input: Parameters<ProtectedAgentMemoryFallbackSearchPort["loadExactOrdinary"]>[0],
  ): ReturnType<ProtectedAgentMemoryFallbackSearchPort["loadExactOrdinary"]> {
    const authority = this.#authority(input.authority);
    const seen = new Set<string>();
    const candidates = input.candidates.map(candidate => Object.freeze({
      ...candidate,
      requiredNamespaceIds: Object.freeze([...candidate.requiredNamespaceIds]),
      createdAt: new Date(candidate.createdAt),
    }));
    const invalidCandidate = candidates.some(candidate => {
      if (seen.has(candidate.memoryId)
        || !validSearchCandidateSnapshot(candidate)) return true;
      seen.add(candidate.memoryId);
      return false;
    });
    if (authority === null || invalidCandidate) {
      return unavailable("authorization_required");
    }
    if (candidates.length === 0) {
      return Object.freeze({ status: "success", value: Object.freeze([]) });
    }
    const memoryIds = [...candidates.map(candidate => candidate.memoryId)].sort();
    return this.#transaction({
      authority,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      use: async transaction => {
        const inventory = await this.#currentInventory(
          transaction,
          authority,
          memoryIds,
        );
        if (inventory === null
          || memoryIds.some(memoryId => !inventory.has(memoryId))) {
          return unavailable("stale_revision");
        }
        const rows = await this.#rankRows({
          transaction,
          authority,
          memoryIds,
          limit: memoryIds.length,
          includeArchive: true,
          fallback: true,
        });
        if (rows === null || rows.length !== memoryIds.length) {
          return unavailable("stale_revision");
        }
        const current = new Map<string, AgentMemorySearchCandidate>();
        for (const row of rows) {
          const candidate = toSearchCandidate(inventory.get(row.memoryId)!, row);
          if (candidate === null) return unavailable("integrity_failure");
          if (candidate !== "excluded") current.set(row.memoryId, candidate);
        }
        for (const candidate of candidates) {
          const value = current.get(candidate.memoryId);
          if (value === undefined
            || value.representation !== candidate.representation
            || value.contentRevision !== candidate.contentRevision
            || value.cryptoAccessRevision !== candidate.cryptoAccessRevision
            || value.cryptoObjectId !== candidate.cryptoObjectId
            || value.readNamespaceId !== candidate.readNamespaceId
            || !sameIds(value.requiredNamespaceIds,
              candidate.requiredNamespaceIds)) {
            return unavailable("stale_revision");
          }
        }
        const bodyRows = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            memory_id: sql`${memories.id}`.as("memory_id"),
            content_revision: memories.contentRevision,
            type: memories.type,
            content: memories.content,
          }).from(memories).where(inArray(memories.id, memoryIds))
            .orderBy(asc(memories.id)),
        );
        input.signal?.throwIfAborted();
        if (bodyRows.length !== memoryIds.length) {
          return unavailable("stale_revision");
        }
        const byId = new Map(bodyRows.map(row => [row.memory_id, row]));
        const opened: ProtectedMemorySessionOpenedItem[] = [];
        for (const candidate of candidates) {
          const row = byId.get(candidate.memoryId);
          if (row === undefined
            || rowInteger(row, "content_revision")
              !== candidate.contentRevision
            || typeof row.type !== "string" || typeof row.content !== "string") {
            return unavailable("stale_revision");
          }
          opened.push(Object.freeze({
            memoryId: candidate.memoryId,
            contentRevision: candidate.contentRevision,
            type: row.type,
            content: row.content,
          }));
        }
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze(opened),
        });
      },
    });
  }
}
