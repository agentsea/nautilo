import { randomUUID } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
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
  memoryCryptoOperations,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  sql,
} from "@nautilo/db";

import type {
  AgentMemoryEmbedding,
  ProtectedAgentMemoryProductPort,
  ProtectedMemoryCandidate,
  ProtectedMemorySaveCandidateSelection,
  ForegroundMemoryMutationReplay,
  ProtectedMemoryMutationPlan,
  ProtectedMemoryMutationTarget,
} from "../../memory/active-memory-composition.ts";
import type {
  ProtectedMemoryAuthority,
  ProtectedMemoryResult,
} from "../../memory/active-memory-repository.ts";
import type {
  ProtectedAgentBackgroundMemoryTierPlan,
} from "../../memory/agent-background-memory-work.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type AtomicMemoryCryptoCompletionPort,
} from "../../memory/memory-repository.ts";
import { resolveRequiredMemoryNamespaceIds } from "../../memory/required-namespace-set.ts";
import type { MemoryPayloadV1 } from "../../memory/memory-payload-v1.ts";
import type { PreparedMemoryCryptoRevision } from "../../memory/memory-repository.ts";
import {
  assertConversationProductCanonicalTransactionRunner,
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import {
  backgroundMemoryOutputRequestDigest,
  backgroundMemoryTierRequestDigest,
} from "./background-memory-product-digest.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAX_CANDIDATES = 64;
const VECTOR_DIMENSIONS = 1536;
const DEFAULT_DEDUP_THRESHOLD = 0.9;
const encoder = new TextEncoder();

export type ProtectedAgentBackgroundMemoryOutputPlanInput = Readonly<{
  action: "create" | "replace";
  publicationIdempotencyId: string;
  descriptorHash: Uint8Array;
  authority: ProtectedMemoryAuthority;
  memoryId: string;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  nextContentRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
  createdAt: number;
  embedding: AgentMemoryEmbedding;
  importance: number;
  signal?: AbortSignal;
}>;

type SnapshottedBackgroundMemoryOutputPlanInput = Omit<
  ProtectedAgentBackgroundMemoryOutputPlanInput,
  "signal"
>;

type OperationRow = Readonly<{
  operationId: string;
  memoryId: string;
  anchorNamespaceId: string;
  operationType: "update" | "metadata";
  expectedContentRevision: number;
  resultContentRevision: number | null;
  expectedAccessRevision: number;
  requestDigest: Uint8Array;
  completion: "pending" | "complete" | "ordinary_fallback";
  ordinaryFallbackReason: "encryption_pending" | "target_encryption_not_ready" | null;
  foregroundStableRequestDigest: Uint8Array | null;
  foregroundMutationKind: ForegroundMemoryMutationReplay["mutationKind"] | null;
  foregroundRequiredNamespaceIds: readonly string[] | null;
  foregroundSaveSimilarity: number | null;
  createdAt: number;
}>;

function unavailable<Value>(
  reason: "authorization_required" | "embedding_unavailable"
    | "incomplete_access_set" | "integrity_failure" | "stale_revision"
    | "deleted" | "target_encryption_not_ready",
): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

function rowString(row: ConversationProductDatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function rowNullableString(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function rowNumber(row: ConversationProductDatabaseRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} is not numeric`);
  }
  return value;
}

function rowInteger(row: ConversationProductDatabaseRow, name: string): number {
  const value = rowNumber(row, name);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is not an integer`);
  return value;
}

function rowBytes(row: ConversationProductDatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} is not binary`);
  return value.slice();
}

function rowNullableBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array | null {
  return row[name] === null ? null : rowBytes(row, name);
}

function rowNullableNumber(
  row: ConversationProductDatabaseRow,
  name: string,
): number | null {
  return row[name] === null ? null : rowNumber(row, name);
}

function rowNullableUuidArray(
  row: ConversationProductDatabaseRow,
  name: string,
): readonly string[] | null {
  const value = row[name];
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${name} is not a UUID array`);
  }
  return canonicalIds(value as string[]);
}

function rowDate(row: ConversationProductDatabaseRow, name: string): Date {
  const value = row[name];
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)
    ? new Date(value)
    : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${name} is not a timestamp`);
  }
  return parsed;
}

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function canonicalIds(value: readonly string[]): readonly string[] | null {
  if (
    value.length < 1
    || value.length > 256
    || value.some((entry) => !UUID.test(entry))
    || value.some((entry, index) => index > 0 && value[index - 1]! >= entry)
  ) return null;
  return Object.freeze([...value]);
}

function canonicalAuthorityIds(value: readonly string[]): readonly string[] | null {
  if (
    value.length < 1
    || value.some((entry) => !UUID.test(entry))
    || value.some((entry, index) => index > 0 && value[index - 1]! >= entry)
  ) return null;
  return Object.freeze([...value]);
}

function vectorLiteral(value: readonly number[]): string {
  return `[${value.join(",")}]`;
}

function validEmbedding(value: AgentMemoryEmbedding): boolean {
  return value.dimensions === VECTOR_DIMENSIONS
    && value.vector.length === VECTOR_DIMENSIONS
    && value.vector.every(Number.isFinite)
    && (value.provider === "openai" || value.provider === "openrouter" || value.provider === "venice")
    && PORTABLE.test(value.canonicalModel)
    && value.contractVersion === 1;
}

function validImportance(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function digest(value: unknown): Uint8Array {
  return sha256(encoder.encode(JSON.stringify(value)));
}

function requestDigest(input: Readonly<{
  kind: "save" | "replace" | "metadata";
  operationId: string;
  authority: ProtectedMemoryAuthority;
  embedding?: AgentMemoryEmbedding;
  importance?: number;
  mutationCommitment?: Uint8Array;
  memoryId?: string;
  action?: "promote" | "demote";
}>): Uint8Array {
  return digest({
    kind: input.kind,
    operationId: input.operationId,
    authority: input.authority,
    ...(input.embedding === undefined
      ? {}
      : {
          embedding: {
            vector: input.embedding.vector,
            provider: input.embedding.provider,
            canonicalModel: input.embedding.canonicalModel,
            dimensions: input.embedding.dimensions,
            contractVersion: input.embedding.contractVersion,
          },
        }),
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    ...(input.mutationCommitment === undefined
      ? {}
      : { mutationCommitment: [...input.mutationCommitment] }),
    ...(input.memoryId === undefined ? {} : { memoryId: input.memoryId }),
    ...(input.action === undefined ? {} : { action: input.action }),
  });
}

function foregroundStableRequestDigest(input: Readonly<{
  operationId: string;
  mutationKind: ForegroundMemoryMutationReplay["mutationKind"];
  authority: ProtectedMemoryAuthority;
  memoryId?: string;
  importance?: number;
  mutationCommitment?: Uint8Array;
}>): Uint8Array {
  const logicalWritableNamespaceId = input.authority.mode === "scope"
    ? input.authority.originWritableNamespaceId
    : input.authority.writableNamespaceId;
  return digest({
    version: 1,
    operationId: input.operationId,
    mutationKind: input.mutationKind,
    subjectUserId: input.authority.subjectUserId,
    agentId: input.authority.agentId,
    ...(input.mutationKind === "save"
      ? { logicalWritableNamespaceId, importance: input.importance }
      : { memoryId: input.memoryId }),
    ...(input.mutationCommitment === undefined ? {} : {
      mutationCommitment: [...input.mutationCommitment],
    }),
  });
}

function snapshotAuthority(
  authority: ProtectedMemoryAuthority,
): ProtectedMemoryAuthority {
  return authority.mode === "scope"
    ? Object.freeze({ ...authority })
    : Object.freeze({
        ...authority,
        readableNamespaceIds: Object.freeze([
          ...authority.readableNamespaceIds,
        ]),
        mutableNamespaceIds: Object.freeze([
          ...authority.mutableNamespaceIds,
        ]),
      });
}

function snapshotBackgroundOutputInput(
  input: ProtectedAgentBackgroundMemoryOutputPlanInput,
): SnapshottedBackgroundMemoryOutputPlanInput | null {
  if (
    !(input.descriptorHash instanceof Uint8Array)
    || !Array.isArray(input.requiredNamespaceIds as unknown)
    || !Array.isArray(input.embedding.vector as unknown)
  ) return null;
  return Object.freeze({
    publicationIdempotencyId: input.publicationIdempotencyId,
    action: input.action,
    descriptorHash: Uint8Array.from(input.descriptorHash),
    authority: snapshotAuthority(input.authority),
    memoryId: input.memoryId,
    expectedContentRevision: input.expectedContentRevision,
    expectedCryptoAccessRevision: input.expectedCryptoAccessRevision,
    nextContentRevision: input.nextContentRevision,
    cryptoObjectId: input.cryptoObjectId,
    requiredNamespaceIds: Object.freeze([...input.requiredNamespaceIds]),
    createdAt: input.createdAt,
    embedding: Object.freeze({
      vector: Object.freeze([...input.embedding.vector]),
      provider: input.embedding.provider,
      canonicalModel: input.embedding.canonicalModel,
      dimensions: input.embedding.dimensions,
      contractVersion: input.embedding.contractVersion,
    }),
    importance: input.importance,
  });
}

function assertOperationId(value: string): void {
  if (!PORTABLE.test(value) || encoder.encode(value).length > 128) {
    throw new TypeError("Memory operation ID is invalid");
  }
}

function parseOperation(row: ConversationProductDatabaseRow): OperationRow {
  const type = rowString(row, "operation_type");
  const completion = rowString(row, "completion");
  if (
    (type !== "update" && type !== "metadata")
    || (completion !== "pending" && completion !== "complete"
      && completion !== "ordinary_fallback")
  ) throw new TypeError("Memory operation row is invalid");
  const foregroundMutationKind = rowNullableString(
    row,
    "foreground_mutation_kind",
  );
  if (foregroundMutationKind !== null && ![
    "save", "replace", "promote", "demote",
  ].includes(foregroundMutationKind)) {
    throw new TypeError("Memory foreground mutation kind is invalid");
  }
  return Object.freeze({
    operationId: rowString(row, "operation_id"),
    memoryId: rowString(row, "memory_id"),
    anchorNamespaceId: rowString(row, "anchor_namespace_id"),
    operationType: type,
    expectedContentRevision: rowInteger(row, "expected_content_revision"),
    resultContentRevision: row["result_content_revision"] === null
      ? null
      : rowInteger(row, "result_content_revision"),
    expectedAccessRevision: rowInteger(row, "expected_access_revision"),
    requestDigest: rowBytes(row, "request_digest"),
    completion,
    foregroundStableRequestDigest: rowNullableBytes(
      row,
      "foreground_stable_request_digest",
    ),
    foregroundMutationKind: foregroundMutationKind as OperationRow["foregroundMutationKind"],
    foregroundRequiredNamespaceIds: rowNullableUuidArray(
      row,
      "foreground_required_namespace_ids",
    ),
    foregroundSaveSimilarity: rowNullableNumber(
      row,
      "foreground_save_similarity",
    ),
    ordinaryFallbackReason: (() => {
      const value = rowNullableString(row, "ordinary_fallback_reason");
      if (value !== null && value !== "encryption_pending"
        && value !== "target_encryption_not_ready") {
        throw new TypeError("Memory ordinary fallback reason is invalid");
      }
      return value;
    })(),
    createdAt: rowDate(row, "created_at").getTime(),
  });
}

function validAuthority(authority: ProtectedMemoryAuthority): boolean {
  if (!UUID.test(authority.subjectUserId) || !UUID.test(authority.agentId)) {
    return false;
  }
  if (authority.mode === "scope") {
    return UUID.test(authority.scopeId)
      && UUID.test(authority.originWritableNamespaceId);
  }
  return canonicalAuthorityIds(authority.readableNamespaceIds) !== null
    && canonicalAuthorityIds(authority.mutableNamespaceIds) !== null
    && (authority.writableNamespaceId === null
      || UUID.test(authority.writableNamespaceId));
}

function exactAuthorityIds(
  authority: ProtectedMemoryAuthority,
  kind: "read" | "write",
): readonly string[] | null {
  if (authority.mode === "scope") {
    return UUID.test(authority.originWritableNamespaceId)
      ? Object.freeze([authority.originWritableNamespaceId])
      : null;
  }
  return canonicalAuthorityIds(
    kind === "read"
      ? authority.readableNamespaceIds
      : authority.mutableNamespaceIds,
  );
}

function newWriteIds(
  authority: ProtectedMemoryAuthority,
): readonly string[] | null {
  if (authority.mode === "scope") {
    return UUID.test(authority.originWritableNamespaceId)
      ? Object.freeze([authority.originWritableNamespaceId])
      : null;
  }
  return authority.writableNamespaceId !== null
      && authority.mutableNamespaceIds.includes(authority.writableNamespaceId)
    ? Object.freeze([authority.writableNamespaceId])
    : null;
}

function authorityAllowsMutationSet(
  authority: ProtectedMemoryAuthority,
  namespaceIds: readonly string[],
): boolean {
  const exact = canonicalIds(namespaceIds);
  if (exact === null) return false;
  if (authority.mode === "scope") {
    return exact.length === 1
      && exact[0] === authority.originWritableNamespaceId;
  }
  return exact.every((entry) => authority.mutableNamespaceIds.includes(entry));
}

/** Trusted composition boundary; authority and policy are checked before locks. */
export type AgentMemoryPublicationBoundary = Readonly<{
  beforeLocks(input: Readonly<{
    transaction: Parameters<Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]>[0];
    authority: ProtectedMemoryAuthority;
    mutation: boolean;
  }>): Promise<void>;
}> & (
  | Readonly<{ representation: "protected_only" }>
  | Readonly<{
      representation: "ordinary_and_protected";
      /** Must return the authenticated payload owned by this prepared handle. */
      readPreparedPayload(revision: PreparedMemoryCryptoRevision): MemoryPayloadV1;
    }>
);

export class PostgresAgentMemoryProductPort
  implements ProtectedAgentMemoryProductPort {
  readonly #canonicalRunner: ConversationProductCanonicalTransactionRunner;
  readonly #readableNamespaceIds: readonly string[];
  readonly #cryptoCompletion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
  readonly #dedupThreshold: number;
  readonly #createMemoryId: () => string;
  readonly #publication: AgentMemoryPublicationBoundary;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    canonicalRunner: ConversationProductCanonicalTransactionRunner;
    readableNamespaceIds: readonly string[];
    cryptoCompletion: Pick<AtomicMemoryCryptoCompletionPort, "complete">;
    publication: AgentMemoryPublicationBoundary;
    dedupThreshold?: number;
    createMemoryId?: () => string;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    assertConversationProductCanonicalTransactionRunner(
      input.handle,
      input.canonicalRunner,
    );
    if (input.handle.role !== "nautilo_agent") {
      throw new TypeError(
        "Agent Memory product port requires a direct nautilo_agent handle",
      );
    }
    const readable = canonicalAuthorityIds(input.readableNamespaceIds);
    if (readable === null) {
      throw new TypeError("Agent Memory bound readable Namespace set is invalid");
    }
    const threshold = input.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      throw new TypeError("Agent Memory dedup threshold is invalid");
    }
    this.#canonicalRunner = input.canonicalRunner;
    if (typeof input.publication?.beforeLocks !== "function"
      || !["protected_only", "ordinary_and_protected"].includes(input.publication.representation)
      || (input.publication.representation === "ordinary_and_protected"
        && typeof input.publication.readPreparedPayload !== "function")) {
      throw new TypeError("Agent Memory publication requires a policy and authority boundary");
    }
    this.#publication = Object.freeze({ ...input.publication });
    this.#readableNamespaceIds = readable;
    this.#cryptoCompletion = input.cryptoCompletion;
    this.#dedupThreshold = threshold;
    this.#createMemoryId = input.createMemoryId ?? randomUUID;
  }

  async #transaction<Value>(
    authority: ProtectedMemoryAuthority,
    execute: (transaction: ConversationProductPostgresTransaction) => Promise<Value>,
    mutation = true,
  ): Promise<Value> {
    return this.#canonicalRunner.transaction(async (canonical, transaction) => {
      const identity = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
          current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
        }).from(sql`(values (1)) as identity_probe`).limit(2),
      ), "Agent Memory transaction identity");
      if (
        identity === null
        || rowNullableString(identity, "current_user_id")
          !== authority.subjectUserId
        || rowNullableString(identity, "current_agent_id") !== authority.agentId
      ) throw new Error("Agent Memory transaction authority changed");
      await this.#publication.beforeLocks({ transaction: canonical, authority, mutation });
      return execute(transaction);
    }, { isolationLevel: "serializable" });
  }

  async #scopeOpenForMutation(
    transaction: ConversationProductPostgresTransaction,
    authority: ProtectedMemoryAuthority,
  ): Promise<boolean> {
    if (authority.mode !== "scope") return true;
    const rows = await transaction.query(
      `/* agent-memory:protected-scope-mutation-admission */
       SELECT lifecycle_state
         FROM agent_scopes
        WHERE id = $1::uuid AND parent_agent_id = $2::uuid
          AND speaker_user_id = $3::uuid
        LIMIT 2 FOR UPDATE`,
      [authority.scopeId, authority.agentId, authority.subjectUserId],
    );
    return rows.length === 1
      && rowString(rows[0]!, "lifecycle_state") === "open";
  }

  #authorityReadable(authority: ProtectedMemoryAuthority): boolean {
    if (!validAuthority(authority)) return false;
    if (authority.mode === "scope") {
      return this.#readableNamespaceIds.includes(
        authority.originWritableNamespaceId,
      );
    }
    const readable = canonicalAuthorityIds(authority.readableNamespaceIds);
    const mutable = canonicalAuthorityIds(authority.mutableNamespaceIds);
    return readable !== null
      && mutable !== null
      && readable.every((entry) => this.#readableNamespaceIds.includes(entry))
      && mutable.every((entry) => readable.includes(entry))
      && (authority.writableNamespaceId === null
        || mutable.includes(authority.writableNamespaceId));
  }

  async #requiredNamespaceIds(
    transaction: ConversationProductPostgresTransaction,
    memoryId: string,
    scopeOriginNamespaceId: string | null,
  ): Promise<readonly string[]> {
    const [namespaceRows, scopeRows] = await Promise.all([
      executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          namespace_id: memoryNamespaces.namespaceId,
        }).from(memoryNamespaces).where(eq(
          memoryNamespaces.memoryId,
          memoryId,
        )).orderBy(asc(memoryNamespaces.namespaceId)),
      ),
      executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          origin: memoryScopes.origin,
        }).from(memoryScopes).where(eq(
          memoryScopes.memoryId,
          memoryId,
        )).orderBy(asc(memoryScopes.scopeId)),
      ),
    ]);
    return resolveRequiredMemoryNamespaceIds({
      namespaceIds: namespaceRows.map((row) => rowString(row, "namespace_id")),
      scopeOrigins: scopeRows.map((row) => {
        const origin = rowString(row, "origin");
        if (origin !== "seed" && origin !== "scope") {
          throw new TypeError("Memory scope origin is invalid");
        }
        return origin;
      }),
      originWritableNamespaceId: scopeOriginNamespaceId,
    });
  }

  async #candidateRows(
    transaction: ConversationProductPostgresTransaction,
    input: Readonly<{
      authority: ProtectedMemoryAuthority;
      embedding: AgentMemoryEmbedding;
      limit: number;
      includeArchive: boolean;
      mutationOnly: boolean;
      includeOrdinaryOnly?: boolean;
    }>,
  ): Promise<readonly ConversationProductDatabaseRow[]> {
    const authorityIds = exactAuthorityIds(
      input.authority,
      input.mutationOnly ? "write" : "read",
    );
    if (authorityIds === null) return [];
    const visibleIds = input.authority.mode === "scope"
      ? this.#readableNamespaceIds
      : authorityIds.filter((entry) => this.#readableNamespaceIds.includes(entry));
    if (visibleIds.length === 0) return [];
    const provider = input.embedding.provider;
    if (provider !== "openai" && provider !== "openrouter" && provider !== "venice") {
      throw new TypeError("Agent Memory embedding provider is invalid");
    }
    const distance = sql<number>`${memories.embedding} <=> ${
      vectorLiteral(input.embedding.vector)
    }::vector`;
    const visible = input.authority.mode === "scope"
      ? exists(conversationProductTypedDb.select({ id: memoryScopes.memoryId })
        .from(memoryScopes).where(and(
          eq(memoryScopes.memoryId, memories.id),
          eq(memoryScopes.scopeId, input.authority.scopeId),
          input.mutationOnly ? eq(memoryScopes.origin, "scope") : undefined,
        )))
      : exists(conversationProductTypedDb.select({ id: memoryNamespaces.memoryId })
        .from(memoryNamespaces).where(and(
          eq(memoryNamespaces.memoryId, memories.id),
          inArray(memoryNamespaces.namespaceId, [...visibleIds]),
        )));
    return executeTypedConversationProductQuery(transaction,
      conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_object_id: memories.cryptoObjectId,
        crypto_mapping_state: memories.cryptoMappingState,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_required_namespace_fingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scope_origin_namespace_id: memories.scopeOriginNamespaceId,
        importance: memories.importance,
        tier: memories.tier,
        created_at: memories.createdAt,
        similarity: sql<number>`1 - (${distance})`.as("similarity"),
      }).from(memories).where(and(
        input.includeOrdinaryOnly ? undefined : isNotNull(memories.cryptoObjectId),
        gt(memories.contentRevision, 0),
        eq(memories.embeddingRevision, memories.contentRevision),
        eq(memories.embeddingProvider, provider),
        eq(memories.embeddingModel, input.embedding.canonicalModel),
        eq(memories.embeddingDimensions, input.embedding.dimensions),
        eq(memories.embeddingContractVersion, input.embedding.contractVersion),
        isNotNull(memories.embedding),
        input.includeArchive ? undefined : lt(memories.tier, 3),
        visible,
      )).orderBy(asc(distance), asc(memories.id)).limit(input.limit));
  }

  async #candidateFromRow(
    transaction: ConversationProductPostgresTransaction,
    authority: ProtectedMemoryAuthority,
    row: ConversationProductDatabaseRow,
  ): Promise<ProtectedMemoryCandidate | null> {
    const memoryId = rowString(row, "memory_id");
    const objectId = rowNullableString(row, "crypto_object_id");
    const fingerprint = row["crypto_required_namespace_fingerprint"];
    const required = await this.#requiredNamespaceIds(
      transaction,
      memoryId,
      rowNullableString(row, "scope_origin_namespace_id"),
    );
    if (
      objectId === null
      || !(fingerprint instanceof Uint8Array)
      || !sameBytes(fingerprint, fingerprintRequiredMemoryNamespaces(required))
    ) throw new Error("Agent Memory candidate authority is incoherent");
    const permitted = authority.mode === "scope"
      ? this.#readableNamespaceIds
      : authority.readableNamespaceIds;
    const readNamespaceId = required.find((entry) =>
      permitted.includes(entry) && this.#readableNamespaceIds.includes(entry)
    );
    if (readNamespaceId === undefined) return null;
    const importance = rowNumber(row, "importance");
    if (!validImportance(importance)) {
      throw new Error("Agent Memory candidate importance is invalid");
    }
    return Object.freeze({
      memoryId,
      contentRevision: rowInteger(row, "content_revision"),
      cryptoAccessRevision: rowInteger(row, "crypto_access_revision"),
      cryptoObjectId: objectId,
      readNamespaceId,
      requiredNamespaceIds: required,
      importance,
      tier: rowInteger(row, "tier"),
      score: rowNumber(row, "similarity"),
      createdAt: rowDate(row, "created_at"),
    });
  }

  async searchCandidates(input: Parameters<
    ProtectedAgentMemoryProductPort["searchCandidates"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["searchCandidates"]> {
    if (
      !this.#authorityReadable(input.authority)
      || !validEmbedding(input.embedding)
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > MAX_CANDIDATES
      || input.signal?.aborted === true
    ) return unavailable("authorization_required");
    return this.#transaction(input.authority, async (transaction) => {
      const rows = await this.#candidateRows(transaction, {
        authority: input.authority,
        embedding: input.embedding,
        limit: input.limit,
        includeArchive: input.includeArchive,
        mutationOnly: false,
      });
      const candidates: ProtectedMemoryCandidate[] = [];
      for (const row of rows) {
        const candidate = await this.#candidateFromRow(
          transaction,
          input.authority,
          row,
        );
        if (candidate !== null) candidates.push(candidate);
      }
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze(candidates),
      });
    }, false);
  }

  async loadExactProjectionSources(input: Readonly<{
    authority: ProtectedMemoryAuthority;
    memoryIds: readonly string[];
    signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<readonly ProtectedMemoryCandidate[]>> {
    const ids = canonicalIds(input.memoryIds);
    if (!this.#authorityReadable(input.authority) || ids === null
      || input.signal?.aborted === true) return unavailable("authorization_required");
    return this.#transaction(input.authority, async (transaction) => {
      const rows = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_object_id: memories.cryptoObjectId,
        crypto_required_namespace_fingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scope_origin_namespace_id: memories.scopeOriginNamespaceId,
        importance: memories.importance,
        tier: memories.tier,
        created_at: memories.createdAt,
        similarity: sql<number>`0::double precision`.as("similarity"),
        }).from(memories).where(inArray(memories.id, ids)).orderBy(memories.id)
          .for("share", { of: memories }));
      const candidates: ProtectedMemoryCandidate[] = [];
      for (const row of rows) {
        const candidate = await this.#candidateFromRow(
          transaction, input.authority, row,
        );
        if (candidate !== null) candidates.push(candidate);
      }
      return candidates.length === ids.length
        && candidates.every((candidate, index) => candidate.memoryId === ids[index])
        ? Object.freeze({ status: "success" as const,
            value: Object.freeze(candidates) })
        : unavailable<readonly ProtectedMemoryCandidate[]>("authorization_required");
    }, false);
  }

  async selectSaveCandidate(input: Parameters<
    ProtectedAgentMemoryProductPort["selectSaveCandidate"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["selectSaveCandidate"]> {
    if (!this.#authorityReadable(input.authority)
      || !validEmbedding(input.embedding)
      || input.signal?.aborted === true) return unavailable("embedding_unavailable");
    return this.#transaction(input.authority, async (transaction) => {
      const rows = await this.#candidateRows(transaction, {
        authority: input.authority,
        embedding: input.embedding,
        limit: 1,
        includeArchive: false,
        mutationOnly: true,
        includeOrdinaryOnly: true,
      });
      const row = rows[0];
      if (row === undefined || rowNumber(row, "similarity") < this.#dedupThreshold) {
        return Object.freeze({ status: "success" as const, value: null });
      }
      const memoryId = rowString(row, "memory_id");
      const required = await this.#requiredNamespaceIds(
        transaction, memoryId, rowNullableString(row, "scope_origin_namespace_id"),
      );
      if (!authorityAllowsMutationSet(input.authority, required)) {
        return Object.freeze({ status: "success" as const, value: null });
      }
      const importance = rowNumber(row, "importance");
      const score = rowNumber(row, "similarity");
      const createdAt = rowDate(row, "created_at");
      if (!validImportance(importance)) return unavailable("integrity_failure");
      const value: ProtectedMemorySaveCandidateSelection = Object.freeze({
        memoryId,
        contentRevision: rowInteger(row, "content_revision"),
        score,
        repairRequired: rowNullableString(row, "crypto_object_id") === null
          || rowString(row, "crypto_mapping_state") !== "verified",
        repair: Object.freeze({
          representation: "structural" as const,
          id: memoryId,
          type: null,
          importance,
          tier: rowInteger(row, "tier"),
          createdAt,
          score,
        }),
      });
      return Object.freeze({ status: "success" as const, value });
    }, false);
  }

  async #existingOperation(
    transaction: ConversationProductPostgresTransaction,
    operationId: string,
  ): Promise<OperationRow | null> {
    const row = oneOrNull(await transaction.query(
      `SELECT operation_id, memory_id, operation_type,
              anchor_namespace_id,
              expected_content_revision, result_content_revision,
              expected_access_revision, request_digest, completion,
              foreground_stable_request_digest, foreground_mutation_kind,
              foreground_required_namespace_ids, foreground_save_similarity,
              ordinary_fallback_reason,
              created_at
         FROM memory_crypto_operations
        WHERE operation_id = $1
        LIMIT 2
        FOR UPDATE`,
      [operationId],
    ), "Agent Memory operation replay");
    return row === null ? null : parseOperation(row);
  }

  async replayCompleted(input: Parameters<
    ProtectedAgentMemoryProductPort["replayCompleted"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["replayCompleted"]> {
    assertOperationId(input.operationId);
    if (!this.#authorityReadable(input.authority) || input.signal?.aborted === true) {
      return unavailable("authorization_required");
    }
    if ((input.mutationKind === "save"
      && (!validImportance(input.importance ?? Number.NaN)
        || input.mutationCommitment?.length !== 32))
      || (input.mutationKind === "replace"
        && (!UUID.test(input.memoryId ?? "")
          || input.mutationCommitment?.length !== 32))
      || ((input.mutationKind === "promote" || input.mutationKind === "demote")
        && !UUID.test(input.memoryId ?? ""))) {
      return unavailable("integrity_failure");
    }
    const expected = foregroundStableRequestDigest(input);
    return this.#transaction(input.authority, async (transaction) => {
      const operation = await this.#existingOperation(transaction, input.operationId);
      if (operation === null || (operation.completion !== "complete"
        && operation.completion !== "ordinary_fallback")) {
        return Object.freeze({ status: "success" as const, value: null });
      }
      const readable = exactAuthorityIds(input.authority, "read");
      if (
        operation.foregroundStableRequestDigest === null
        || operation.foregroundMutationKind !== input.mutationKind
        || operation.foregroundRequiredNamespaceIds === null
        || !sameBytes(operation.foregroundStableRequestDigest, expected)
        || readable === null
        || !operation.foregroundRequiredNamespaceIds.some((id) => readable.includes(id))
      ) return unavailable("authorization_required");
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          mutationKind: input.mutationKind,
          memoryId: operation.memoryId,
          action: operation.expectedContentRevision === 0 ? "created" : "updated",
          ...(operation.foregroundSaveSimilarity === null
            ? {} : { similarity: operation.foregroundSaveSimilarity }),
          ...(operation.ordinaryFallbackReason === null
            ? {} : { fallbackReason: operation.ordinaryFallbackReason }),
        }),
      });
    }, false);
  }

  async #replayPlan(
    transaction: ConversationProductPostgresTransaction,
    operation: OperationRow,
    expectedDigest: Uint8Array,
    authority: ProtectedMemoryAuthority,
    replayImportance: number | null,
    mutationCommitment: Uint8Array,
    mutationKind: ProtectedMemoryMutationPlan["mutationKind"],
  ): Promise<ProtectedMemoryResult<ProtectedMemoryMutationPlan>> {
    if (
      operation.operationType !== "update"
      || operation.resultContentRevision === null
      || !sameBytes(operation.requestDigest, expectedDigest)
    ) return unavailable("integrity_failure");
    const product = oneOrNull(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        memory_id: sql`${memories.id}`.as("memory_id"),
        content_revision: memories.contentRevision,
        crypto_access_revision: memories.cryptoAccessRevision,
        crypto_object_id: memories.cryptoObjectId,
        crypto_mapping_state: memories.cryptoMappingState,
        scope_origin_namespace_id: memories.scopeOriginNamespaceId,
        importance: memories.importance,
      }).from(memories).where(eq(memories.id, operation.memoryId)).limit(2),
    ), "Agent Memory replay product");
    const completed = operation.completion === "complete";
    if (product === null && (completed || operation.expectedContentRevision > 0)) {
      return unavailable("deleted");
    }
    if (!completed && operation.expectedContentRevision === 0 && product !== null) {
      return unavailable("stale_revision");
    }
    if (product !== null && (completed
      ? rowInteger(product, "content_revision") !== operation.resultContentRevision
        || rowNullableString(product, "crypto_object_id") !== deriveMemoryCryptoObjectIdV1({
          memoryId: operation.memoryId,
          contentRevision: operation.resultContentRevision,
        })
        || rowString(product, "crypto_mapping_state") !== "verified"
      : rowInteger(product, "content_revision") !== operation.expectedContentRevision
        || rowInteger(product, "crypto_access_revision") !== operation.expectedAccessRevision
    )) return unavailable("stale_revision");
    const required = product === null
      ? Object.freeze([operation.anchorNamespaceId])
      : await this.#requiredNamespaceIds(
          transaction,
          operation.memoryId,
          rowNullableString(product, "scope_origin_namespace_id"),
        );
    if (!authorityAllowsMutationSet(authority, required)) {
      return unavailable("incomplete_access_set");
    }
    const allocation = oneOrNull(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        crypto_object_id: memoryCryptoRevisions.cryptoObjectId,
        required_namespace_fingerprint:
          memoryCryptoRevisions.requiredNamespaceFingerprint,
      }).from(memoryCryptoRevisions).where(and(
        eq(memoryCryptoRevisions.memoryId, operation.memoryId),
        eq(
          memoryCryptoRevisions.contentRevision,
          operation.resultContentRevision,
        ),
      )).limit(2),
    ), "Agent Memory replay allocation");
    const expectedObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: operation.memoryId,
      contentRevision: operation.resultContentRevision,
    });
    if (
      allocation === null
      || rowString(allocation, "crypto_object_id") !== expectedObjectId
      || !sameBytes(
        rowBytes(allocation, "required_namespace_fingerprint"),
        fingerprintRequiredMemoryNamespaces(required),
      )
    ) return unavailable("integrity_failure");
    return Object.freeze({
      status: "success" as const,
      value: Object.freeze({
        operationId: operation.operationId,
        action: operation.expectedContentRevision === 0 ? "created" : "updated",
        mutationKind,
        memoryId: operation.memoryId,
        contentRevision: operation.resultContentRevision,
        cryptoAccessRevision: 0,
        expectedPriorAccessRevision: operation.expectedAccessRevision,
        cryptoObjectId: expectedObjectId,
        requiredNamespaceIds: required,
        reservationDigest: operation.requestDigest,
        mutationCommitment: mutationCommitment.slice(),
        importance: replayImportance ?? (product === null
          ? (() => { throw new Error("Agent Memory replay importance is unavailable"); })()
          : rowNumber(product, "importance")),
        createdAt: operation.createdAt,
      }),
    });
  }

  async #insertPlan(
    transaction: ConversationProductPostgresTransaction,
    input: Readonly<{
      operationId: string;
      requestDigest: Uint8Array;
      memoryId: string;
      expectedContentRevision: number;
      expectedAccessRevision: number;
      requiredNamespaceIds: readonly string[];
      embedding: AgentMemoryEmbedding;
      importance: number;
      mutationCommitment: Uint8Array;
      mutationKind: ProtectedMemoryMutationPlan["mutationKind"];
      foregroundStableRequestDigest?: Uint8Array;
      similarity?: number;
      authority: ProtectedMemoryAuthority;
      createdAt: number;
    }>,
  ): Promise<ProtectedMemoryMutationPlan> {
    const nextRevision = input.expectedContentRevision + 1;
    const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: input.memoryId,
      contentRevision: nextRevision,
    });
    const fingerprint = fingerprintRequiredMemoryNamespaces(
      input.requiredNamespaceIds,
    );
    await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.insert(memoryCryptoOperations).values({
        operationId: input.operationId,
        memoryId: input.memoryId,
        anchorNamespaceId: input.requiredNamespaceIds[0]!,
        operationType: "update",
        expectedContentRevision: input.expectedContentRevision,
        resultContentRevision: nextRevision,
        expectedAccessRevision: input.expectedAccessRevision,
        requestDigest: input.requestDigest,
        foregroundStableRequestDigest: input.foregroundStableRequestDigest,
        foregroundMutationKind: input.mutationKind === "background"
          ? undefined : input.mutationKind,
        foregroundRequiredNamespaceIds: input.mutationKind === "background"
          ? undefined : [...input.requiredNamespaceIds],
        foregroundSaveSimilarity: input.mutationKind === "save"
          ? input.similarity ?? null : null,
        createdAt: new Date(input.createdAt),
        updatedAt: new Date(input.createdAt),
      }),
    );
    await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.insert(memoryCryptoRevisions).values({
        memoryId: input.memoryId,
        contentRevision: nextRevision,
        anchorNamespaceId: input.requiredNamespaceIds[0]!,
        cryptoObjectId,
        payloadVersion: 1,
        allocationRequestDigest: input.requestDigest,
        requiredNamespaceFingerprint: fingerprint,
      }),
    );
    return Object.freeze({
      operationId: input.operationId,
      action: input.expectedContentRevision === 0 ? "created" : "updated",
      mutationKind: input.mutationKind,
      memoryId: input.memoryId,
      contentRevision: nextRevision,
      cryptoAccessRevision: 0,
      expectedPriorAccessRevision: input.expectedAccessRevision,
      cryptoObjectId,
      requiredNamespaceIds: input.requiredNamespaceIds,
      reservationDigest: input.requestDigest.slice(),
      mutationCommitment: input.mutationCommitment.slice(),
      importance: input.importance,
      ...(input.similarity === undefined ? {} : { similarity: input.similarity }),
      createdAt: input.createdAt,
    });
  }

  async planSave(input: Parameters<
    ProtectedAgentMemoryProductPort["planSave"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["planSave"]> {
    assertOperationId(input.operationId);
    if (
      !this.#authorityReadable(input.authority)
      ||
      !validEmbedding(input.embedding)
      || !validImportance(input.importance)
      || input.mutationCommitment.length !== 32
      || input.signal?.aborted === true
    ) return unavailable("embedding_unavailable");
    const stableDigest = foregroundStableRequestDigest({
      operationId: input.operationId,
      mutationKind: "save",
      authority: input.authority,
      importance: input.importance,
      mutationCommitment: input.mutationCommitment,
    });
    // Provider output is transient and may legitimately drift across a retry.
    // The durable foreground reservation binds the exact mutation intent.
    const expectedDigest = stableDigest;
    return this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) {
        return unavailable("stale_revision");
      }
      const existing = await this.#existingOperation(transaction, input.operationId);
      if (existing !== null) {
        return this.#replayPlan(
          transaction,
          existing,
          expectedDigest,
          input.authority,
          input.importance,
          input.mutationCommitment,
          "save",
        );
      }
      const rows = await this.#candidateRows(transaction, {
        authority: input.authority,
        embedding: input.embedding,
        limit: 1,
        includeArchive: false,
        mutationOnly: true,
      });
      let candidate: ProtectedMemoryCandidate | null = null;
      if (rows[0] !== undefined) {
        candidate = await this.#candidateFromRow(
          transaction,
          input.authority,
          rows[0],
        );
      }
      const deduplicate = candidate !== null
        && candidate.score >= this.#dedupThreshold
        && authorityAllowsMutationSet(
          input.authority,
          candidate.requiredNamespaceIds,
        );
      if (input.selectedCandidate !== undefined
        && input.selectedCandidate !== null && (!deduplicate
        || candidate === null
        || candidate.memoryId !== input.selectedCandidate.memoryId
        || candidate.contentRevision !== input.selectedCandidate.contentRevision)) {
        return unavailable("stale_revision");
      }
      if (input.selectedCandidate === null && deduplicate) {
        return unavailable("stale_revision");
      }
      const required = deduplicate
        ? candidate!.requiredNamespaceIds
        : newWriteIds(input.authority);
      if (required === null) {
        return unavailable("incomplete_access_set");
      }
      const memoryId = deduplicate
        ? candidate!.memoryId
        : this.#createMemoryId();
      if (!UUID.test(memoryId)) throw new TypeError("Generated Memory ID is invalid");
      const expectedContentRevision = deduplicate
        ? candidate!.contentRevision
        : 0;
      const expectedAccessRevision = deduplicate
        ? rows[0] === undefined
          ? 0
          : rowInteger(rows[0], "crypto_access_revision")
        : 0;
      return Object.freeze({
        status: "success" as const,
        value: await this.#insertPlan(transaction, {
          operationId: input.operationId,
          requestDigest: expectedDigest,
          memoryId,
          expectedContentRevision,
          expectedAccessRevision,
          requiredNamespaceIds: required,
          embedding: input.embedding,
          importance: input.importance,
          mutationCommitment: input.mutationCommitment,
          mutationKind: "save",
          foregroundStableRequestDigest: stableDigest,
          ...(deduplicate && candidate !== null
            ? { similarity: candidate.score } : {}),
          authority: input.authority,
          createdAt: Date.now(),
        }),
      });
    });
  }

  async planProjectionCreate(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    embedding: AgentMemoryEmbedding;
    importance: number;
    mutationCommitment: Uint8Array;
    signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<ProtectedMemoryMutationPlan>> {
    assertOperationId(input.operationId);
    if (!this.#authorityReadable(input.authority)
      || !validEmbedding(input.embedding) || !validImportance(input.importance)
      || input.mutationCommitment.length !== 32 || input.signal?.aborted === true) {
      return unavailable("embedding_unavailable");
    }
    const stableDigest = foregroundStableRequestDigest({
      operationId: input.operationId, mutationKind: "save",
      authority: input.authority, importance: input.importance,
      mutationCommitment: input.mutationCommitment,
    });
    return this.#transaction(input.authority, async (transaction) => {
      const existing = await this.#existingOperation(transaction, input.operationId);
      if (existing !== null) return this.#replayPlan(transaction, existing,
        stableDigest, input.authority, input.importance,
        input.mutationCommitment, "save");
      const required = newWriteIds(input.authority);
      if (required === null) return unavailable("incomplete_access_set");
      const memoryId = this.#createMemoryId();
      if (!UUID.test(memoryId)) throw new TypeError("Generated Memory ID is invalid");
      return Object.freeze({ status: "success" as const,
        value: await this.#insertPlan(transaction, {
          operationId: input.operationId, requestDigest: stableDigest,
          memoryId, expectedContentRevision: 0, expectedAccessRevision: 0,
          requiredNamespaceIds: required, embedding: input.embedding,
          importance: input.importance,
          mutationCommitment: input.mutationCommitment, mutationKind: "save",
          foregroundStableRequestDigest: stableDigest,
          authority: input.authority, createdAt: Date.now(),
        }) });
    });
  }

  async #loadMutableTarget(
    transaction: ConversationProductPostgresTransaction,
    authority: ProtectedMemoryAuthority,
    memoryId: string,
  ): Promise<Readonly<{
    target: ProtectedMemoryMutationTarget;
    importance: number;
    accessRevision: number;
    tier: number;
  }> | null> {
    const row = oneOrNull(await transaction.query(
      `SELECT id AS memory_id, content_revision, crypto_object_id,
              crypto_access_revision, crypto_required_namespace_fingerprint,
              scope_origin_namespace_id, importance, tier
         FROM memories
        WHERE id = $1
        LIMIT 2
        FOR UPDATE`,
      [memoryId],
    ), "Agent Memory mutation target");
    if (row === null) return null;
    const required = await this.#requiredNamespaceIds(
      transaction,
      memoryId,
      rowNullableString(row, "scope_origin_namespace_id"),
    );
    const allowed = exactAuthorityIds(authority, "write");
    const objectId = rowNullableString(row, "crypto_object_id");
    const fingerprint = row["crypto_required_namespace_fingerprint"];
    if (
      allowed === null
      || objectId === null
      || !(fingerprint instanceof Uint8Array)
      || !sameBytes(fingerprint, fingerprintRequiredMemoryNamespaces(required))
      || !required.every((entry) => allowed.includes(entry))
    ) return null;
    if (authority.mode === "scope") {
      const origins = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          origin: memoryScopes.origin,
        }).from(memoryScopes).where(and(
          eq(memoryScopes.memoryId, memoryId),
          eq(memoryScopes.scopeId, authority.scopeId),
        )).limit(2),
      );
      if (
        origins.length !== 1
        || rowString(origins[0]!, "origin") !== "scope"
      ) return null;
    }
    return Object.freeze({
      target: Object.freeze({
        memoryId,
        contentRevision: rowInteger(row, "content_revision"),
        cryptoAccessRevision: rowInteger(row, "crypto_access_revision"),
        cryptoObjectId: objectId,
        requiredNamespaceIds: required,
      }),
      importance: (() => {
        const importance = rowNumber(row, "importance");
        if (!validImportance(importance)) {
          throw new Error("Agent Memory mutation importance is invalid");
        }
        return importance;
      })(),
      accessRevision: rowInteger(row, "crypto_access_revision"),
      tier: rowInteger(row, "tier"),
    });
  }

  async planReplace(input: Parameters<
    ProtectedAgentMemoryProductPort["planReplace"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["planReplace"]> {
    assertOperationId(input.operationId);
    if (
      !this.#authorityReadable(input.authority)
      || !UUID.test(input.memoryId)
      || !validEmbedding(input.embedding)
      || input.mutationCommitment.length !== 32
      || input.signal?.aborted === true
    ) {
      return unavailable("embedding_unavailable");
    }
    const stableDigest = foregroundStableRequestDigest({
      operationId: input.operationId,
      mutationKind: "replace",
      authority: input.authority,
      memoryId: input.memoryId,
      mutationCommitment: input.mutationCommitment,
    });
    const expectedDigest = stableDigest;
    return this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) {
        return unavailable("stale_revision");
      }
      const existing = await this.#existingOperation(transaction, input.operationId);
      if (existing !== null) {
        const replay = await this.#replayPlan(
          transaction,
          existing,
          expectedDigest,
          input.authority,
          null,
          input.mutationCommitment,
          "replace",
        );
        if (replay.status === "unavailable") return replay;
        const previousRevision = replay.value.contentRevision - 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            ...replay.value,
            action: "updated" as const,
            previous: Object.freeze({
              memoryId: replay.value.memoryId,
              contentRevision: previousRevision,
              cryptoAccessRevision: existing.expectedAccessRevision,
              cryptoObjectId: deriveMemoryCryptoObjectIdV1({
                memoryId: replay.value.memoryId,
                contentRevision: previousRevision,
              }),
              requiredNamespaceIds: replay.value.requiredNamespaceIds,
            }),
          }),
        });
      }
      const current = await this.#loadMutableTarget(
        transaction,
        input.authority,
        input.memoryId,
      );
      if (current === null) return unavailable("stale_revision");
      const plan = await this.#insertPlan(transaction, {
        operationId: input.operationId,
        requestDigest: expectedDigest,
        memoryId: input.memoryId,
        expectedContentRevision: current.target.contentRevision,
        expectedAccessRevision: current.accessRevision,
        requiredNamespaceIds: current.target.requiredNamespaceIds,
        embedding: input.embedding,
        importance: current.importance,
        mutationCommitment: input.mutationCommitment,
        mutationKind: "replace",
        foregroundStableRequestDigest: stableDigest,
        authority: input.authority,
        createdAt: Date.now(),
      });
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          ...plan,
          action: "updated" as const,
          previous: current.target,
        }),
      });
    });
  }

  /**
   * Reserve exactly one signed background output. Unlike foreground save,
   * this path never performs semantic deduplication or chooses an identity.
   */
  async planBackgroundOutput(
    input: ProtectedAgentBackgroundMemoryOutputPlanInput,
  ): Promise<ProtectedMemoryResult<ProtectedMemoryMutationPlan>> {
    const snapshot = snapshotBackgroundOutputInput(input);
    if (snapshot === null) return unavailable("authorization_required");
    assertOperationId(snapshot.publicationIdempotencyId);
    const required = canonicalIds(snapshot.requiredNamespaceIds);
    if (
      !this.#authorityReadable(snapshot.authority)
      || snapshot.descriptorHash.length !== 32
      || !UUID.test(snapshot.memoryId)
      || !Number.isSafeInteger(snapshot.expectedContentRevision)
      || snapshot.expectedContentRevision < 0
      || !Number.isSafeInteger(snapshot.nextContentRevision)
      || snapshot.nextContentRevision
        !== snapshot.expectedContentRevision + 1
      || !Number.isSafeInteger(snapshot.expectedCryptoAccessRevision)
      || snapshot.expectedCryptoAccessRevision < 0
      || (snapshot.action === "create"
        ? snapshot.expectedContentRevision !== 0
          || snapshot.expectedCryptoAccessRevision !== 0
        : snapshot.expectedContentRevision < 1)
      || !Number.isSafeInteger(snapshot.createdAt)
      || snapshot.createdAt < 0
      || !validEmbedding(snapshot.embedding)
      || !validImportance(snapshot.importance)
      || required === null
      || !authorityAllowsMutationSet(snapshot.authority, required)
      || snapshot.cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
        memoryId: snapshot.memoryId,
        contentRevision: snapshot.nextContentRevision,
      })
      || input.signal?.aborted === true
    ) return unavailable("authorization_required");
    const expectedDigest = backgroundMemoryOutputRequestDigest(snapshot);
    return this.#transaction(snapshot.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, snapshot.authority)) {
        return unavailable("stale_revision");
      }
      const existing = await this.#existingOperation(
        transaction,
        snapshot.publicationIdempotencyId,
      );
      if (existing !== null) {
        const replay = await this.#replayPlan(
          transaction,
          existing,
          expectedDigest,
          snapshot.authority,
          snapshot.importance,
          snapshot.descriptorHash,
          "background",
        );
        if (replay.status === "unavailable") return replay;
        return replay.value.memoryId === snapshot.memoryId
            && replay.value.contentRevision === snapshot.nextContentRevision
            && replay.value.cryptoObjectId === snapshot.cryptoObjectId
            && replay.value.createdAt === snapshot.createdAt
            && equalStrings(replay.value.requiredNamespaceIds, required)
          ? replay
          : unavailable("integrity_failure");
      }

      let expectedAccessRevision = 0;
      if (snapshot.expectedContentRevision === 0) {
        const occupied = oneOrNull(await transaction.query(
          `SELECT id FROM memories WHERE id = $1 LIMIT 2 FOR UPDATE`,
          [snapshot.memoryId],
        ), "Agent background Memory identity reservation");
        if (occupied !== null) return unavailable("stale_revision");
      } else {
        const current = await this.#loadMutableTarget(
          transaction,
          snapshot.authority,
          snapshot.memoryId,
        );
        if (
          current === null
          || current.target.contentRevision
            !== snapshot.expectedContentRevision
          || current.target.cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
            memoryId: snapshot.memoryId,
            contentRevision: snapshot.expectedContentRevision,
          })
          || !equalStrings(current.target.requiredNamespaceIds, required)
          || current.accessRevision
            !== snapshot.expectedCryptoAccessRevision
        ) return unavailable("stale_revision");
        expectedAccessRevision = current.accessRevision;
      }
      const plan = await this.#insertPlan(transaction, {
        operationId: snapshot.publicationIdempotencyId,
        requestDigest: expectedDigest,
        memoryId: snapshot.memoryId,
        expectedContentRevision: snapshot.expectedContentRevision,
        expectedAccessRevision,
        requiredNamespaceIds: required,
        embedding: snapshot.embedding,
        importance: snapshot.importance,
        mutationCommitment: snapshot.descriptorHash,
        mutationKind: "background",
        authority: snapshot.authority,
        createdAt: snapshot.createdAt,
      });
      return plan.contentRevision === snapshot.nextContentRevision
          && plan.cryptoObjectId === snapshot.cryptoObjectId
        ? Object.freeze({ status: "success" as const, value: plan })
        : unavailable("integrity_failure");
    });
  }

  async planBackgroundTier(
    input: ProtectedAgentBackgroundMemoryTierPlan,
  ): Promise<ProtectedMemoryResult<ProtectedAgentBackgroundMemoryTierPlan>> {
    const descriptorHash = Uint8Array.from(input.descriptorHash);
    const requiredNamespaceIds = canonicalIds(input.requiredNamespaceIds);
    const authority = snapshotAuthority(input.authority);
    const plan = Object.freeze({
      ...input,
      descriptorHash,
      authority,
      requiredNamespaceIds: requiredNamespaceIds ?? Object.freeze([]),
    });
    assertOperationId(plan.operationIdempotencyId);
    const validTransition = plan.action === "promote"
      ? plan.expectedTier === 2 && plan.nextTier === 1
      : (plan.expectedTier === 1 && plan.nextTier === 2)
        || (plan.expectedTier === 2 && plan.nextTier === 3);
    if (
      !this.#authorityReadable(authority)
      || descriptorHash.length !== 32
      || !UUID.test(plan.memoryId)
      || !Number.isSafeInteger(plan.contentRevision)
      || plan.contentRevision < 1
      || !Number.isSafeInteger(plan.cryptoAccessRevision)
      || plan.cryptoAccessRevision < 0
      || plan.cryptoObjectId !== deriveMemoryCryptoObjectIdV1({
        memoryId: plan.memoryId,
        contentRevision: plan.contentRevision,
      })
      || requiredNamespaceIds === null
      || !authorityAllowsMutationSet(authority, requiredNamespaceIds)
      || !validTransition
    ) return unavailable("authorization_required");
    const expectedDigest = backgroundMemoryTierRequestDigest(plan);
    return this.#transaction(authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, authority)) {
        return unavailable("stale_revision");
      }
      const existing = await this.#existingOperation(
        transaction,
        plan.operationIdempotencyId,
      );
      if (existing !== null) {
        return existing.operationType === "metadata"
            && existing.memoryId === plan.memoryId
            && existing.expectedContentRevision === plan.contentRevision
            && existing.expectedAccessRevision === plan.cryptoAccessRevision
            && sameBytes(existing.requestDigest, expectedDigest)
            && existing.completion === "complete"
          ? Object.freeze({ status: "success" as const, value: plan })
          : unavailable("integrity_failure");
      }
      const current = await this.#loadMutableTarget(
        transaction,
        authority,
        plan.memoryId,
      );
      return current !== null
          && current.target.contentRevision === plan.contentRevision
          && current.target.cryptoObjectId === plan.cryptoObjectId
          && current.accessRevision === plan.cryptoAccessRevision
          && current.tier === plan.expectedTier
          && equalStrings(
            current.target.requiredNamespaceIds,
            requiredNamespaceIds,
          )
        ? Object.freeze({ status: "success" as const, value: plan })
        : unavailable("stale_revision");
    });
  }

  async commitBackgroundTier(
    input: Readonly<{
      plan: ProtectedAgentBackgroundMemoryTierPlan;
      signal?: AbortSignal;
    }>,
  ): Promise<"applied" | "replayed" | "stale" | "deleted"> {
    if (input.signal?.aborted === true) return "stale";
    const preflight = await this.planBackgroundTier(input.plan);
    if (preflight.status === "unavailable") return "stale";
    const plan = preflight.value;
    const expectedDigest = backgroundMemoryTierRequestDigest(plan);
    return this.#transaction(plan.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, plan.authority)) {
        return "stale" as const;
      }
      const existing = await this.#existingOperation(
        transaction,
        plan.operationIdempotencyId,
      );
      if (existing !== null) {
        return existing.operationType === "metadata"
            && existing.memoryId === plan.memoryId
            && existing.expectedContentRevision === plan.contentRevision
            && existing.expectedAccessRevision === plan.cryptoAccessRevision
            && sameBytes(existing.requestDigest, expectedDigest)
            && existing.completion === "complete"
          ? "replayed" as const
          : "stale" as const;
      }
      const current = await this.#loadMutableTarget(
        transaction,
        plan.authority,
        plan.memoryId,
      );
      if (
        current === null
        || current.target.contentRevision !== plan.contentRevision
        || current.target.cryptoObjectId !== plan.cryptoObjectId
        || current.accessRevision !== plan.cryptoAccessRevision
        || current.tier !== plan.expectedTier
        || !equalStrings(
          current.target.requiredNamespaceIds,
          plan.requiredNamespaceIds,
        )
      ) return "stale";
      const updated = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.update(memories).set({
          tier: plan.nextTier,
          demotedFrom: plan.nextTier > plan.expectedTier
            ? plan.expectedTier
            : null,
          demotedAt: plan.nextTier > plan.expectedTier
            ? sql`CURRENT_TIMESTAMP`
            : null,
          promotedAt: plan.nextTier < plan.expectedTier
            ? sql`CURRENT_TIMESTAMP`
            : null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memories.id, plan.memoryId),
          eq(memories.contentRevision, plan.contentRevision),
          eq(memories.cryptoAccessRevision, plan.cryptoAccessRevision),
          eq(memories.tier, plan.expectedTier),
          eq(memories.cryptoObjectId, plan.cryptoObjectId),
        )).returning({ id: memories.id }),
      );
      if (oneOrNull(updated, "Agent background Memory tier CAS") === null) {
        return "stale";
      }
      await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.insert(memoryCryptoOperations).values({
          operationId: plan.operationIdempotencyId,
          memoryId: plan.memoryId,
          anchorNamespaceId: plan.requiredNamespaceIds[0]!,
          operationType: "metadata",
          expectedContentRevision: plan.contentRevision,
          resultContentRevision: null,
          expectedAccessRevision: plan.cryptoAccessRevision,
          resultAccessRevision: null,
          requestDigest: expectedDigest,
          completion: "complete",
          disposition: "complete",
          cryptoCompletedAt: sql`CURRENT_TIMESTAMP`,
          nextAttemptAt: null,
        }),
      );
      return "applied";
    });
  }

  async publishPrepared(input: Parameters<
    ProtectedAgentMemoryProductPort["publishPrepared"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["publishPrepared"]> {
    const required = canonicalIds(input.plan.requiredNamespaceIds);
    if (
      !this.#authorityReadable(input.authority)
      || !validEmbedding(input.embedding)
      || input.signal?.aborted === true
      || required === null
      || !authorityAllowsMutationSet(input.authority, required)
      || input.prepared.memoryId !== input.plan.memoryId
      || input.prepared.contentRevision !== input.plan.contentRevision
      || input.prepared.objectId !== input.plan.cryptoObjectId
      || input.prepared.requiredNamespaceIds.length !== required.length
      || input.prepared.requiredNamespaceIds.some((entry, index) =>
        entry !== required[index]
      )
    ) {
      return "stale";
    }
    const exactFingerprint = fingerprintRequiredMemoryNamespaces(
      input.plan.requiredNamespaceIds,
    );
    const recomputedReservation = input.plan.mutationKind === "background"
      ? input.plan.reservationDigest
      : foregroundStableRequestDigest({
          operationId: input.plan.operationId,
          mutationKind: input.plan.mutationKind,
          authority: input.authority,
          ...(input.plan.mutationKind === "save"
            ? { importance: input.plan.importance }
            : { memoryId: input.plan.memoryId }),
          mutationCommitment: input.plan.mutationCommitment,
        });
    if (!sameBytes(recomputedReservation, input.plan.reservationDigest)) {
      return "stale";
    }
    const reservationValid = await this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) return false;
      const operation = await this.#existingOperation(transaction, input.plan.operationId);
      if (
        operation === null
        || operation.operationType !== "update"
        || operation.memoryId !== input.plan.memoryId
        || operation.resultContentRevision !== input.plan.contentRevision
        || operation.expectedContentRevision + 1 !== input.plan.contentRevision
        || operation.expectedAccessRevision !== input.plan.expectedPriorAccessRevision
        || !sameBytes(operation.requestDigest, input.plan.reservationDigest)
      ) return false;
      const allocation = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          crypto_object_id: memoryCryptoRevisions.cryptoObjectId,
          required_namespace_fingerprint: memoryCryptoRevisions.requiredNamespaceFingerprint,
          allocation_request_digest: memoryCryptoRevisions.allocationRequestDigest,
        }).from(memoryCryptoRevisions).where(and(
          eq(memoryCryptoRevisions.memoryId, input.plan.memoryId),
          eq(memoryCryptoRevisions.contentRevision, input.plan.contentRevision),
        )).limit(2),
      ), "Agent Memory publication reservation");
      return allocation !== null
        && rowString(allocation, "crypto_object_id") === input.plan.cryptoObjectId
        && sameBytes(rowBytes(allocation, "required_namespace_fingerprint"), exactFingerprint)
        && sameBytes(rowBytes(allocation, "allocation_request_digest"), operation.requestDigest);
    });
    if (!reservationValid) return "stale";
    await this.#cryptoCompletion.complete(input.prepared);
    // No crypto/provider work is allowed under the final product locks. Only
    // the exact verified preparation may supply an ordinary Shadow sibling.
    const ordinary = this.#publication.representation === "ordinary_and_protected"
      ? this.#publication.readPreparedPayload(input.prepared)
      : null;
    return this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) {
        return "stale" as const;
      }
      const operation = await this.#existingOperation(transaction, input.plan.operationId);
      if (
        operation === null
        || operation.operationType !== "update"
        || operation.memoryId !== input.plan.memoryId
        || operation.resultContentRevision !== input.plan.contentRevision
        || operation.expectedContentRevision + 1 !== input.plan.contentRevision
        || operation.expectedAccessRevision !== input.plan.expectedPriorAccessRevision
        || !sameBytes(operation.requestDigest, input.plan.reservationDigest)
      ) return "stale" as const;

      const allocation = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          crypto_object_id: memoryCryptoRevisions.cryptoObjectId,
          required_namespace_fingerprint: memoryCryptoRevisions.requiredNamespaceFingerprint,
          allocation_request_digest: memoryCryptoRevisions.allocationRequestDigest,
          completion: memoryCryptoRevisions.completion,
          disposition: memoryCryptoRevisions.disposition,
        }).from(memoryCryptoRevisions).where(and(
          eq(memoryCryptoRevisions.memoryId, input.plan.memoryId),
          eq(memoryCryptoRevisions.contentRevision, input.plan.contentRevision),
        )).limit(2).for("update"),
      ), "Agent Memory publication allocation");
      if (
        allocation === null
        || rowString(allocation, "crypto_object_id") !== input.plan.cryptoObjectId
        || !sameBytes(rowBytes(allocation, "required_namespace_fingerprint"), exactFingerprint)
        || !sameBytes(rowBytes(allocation, "allocation_request_digest"), operation.requestDigest)
      ) return "stale" as const;

      if (operation.completion === "complete") {
        const [current] = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({
            content_revision: memories.contentRevision,
            crypto_object_id: memories.cryptoObjectId,
            crypto_mapping_state: memories.cryptoMappingState,
          }).from(memories).where(eq(memories.id, input.plan.memoryId)).limit(1),
        );
        return current !== undefined
            && rowInteger(current, "content_revision") === input.plan.contentRevision
            && rowNullableString(current, "crypto_object_id") === input.plan.cryptoObjectId
            && rowString(current, "crypto_mapping_state") === "verified"
          ? "replayed" as const
          : "stale" as const;
      }

      if (operation.expectedContentRevision === 0) {
        const occupied = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.select({ id: memories.id })
            .from(memories).where(eq(memories.id, input.plan.memoryId)).limit(1).for("update"),
        );
        if (occupied.length !== 0) return "stale" as const;
        await executeTypedConversationProductQuery(transaction,
          conversationProductTypedDb.insert(memories).values({
            id: input.plan.memoryId,
            tier: 1,
            type: ordinary?.type ?? null,
            content: ordinary?.content ?? null,
            importance: input.plan.importance,
            embedding: [...input.embedding.vector],
            contentRevision: input.plan.contentRevision,
            cryptoAccessRevision: 0,
            cryptoObjectId: null,
            cryptoRequiredNamespaceFingerprint: null,
            cryptoMappingState: "unmapped",
            embeddingRevision: input.plan.contentRevision,
            embeddingProvider: input.embedding.provider as "openai" | "openrouter" | "venice",
            embeddingModel: input.embedding.canonicalModel,
            embeddingDimensions: input.embedding.dimensions,
            embeddingContractVersion: input.embedding.contractVersion,
            scopeOriginNamespaceId: input.authority.mode === "scope"
              ? input.authority.originWritableNamespaceId : null,
            createdAt: new Date(input.plan.createdAt),
          }));
        if (input.authority.mode === "scope") {
          await executeTypedConversationProductQuery(transaction,
            conversationProductTypedDb.insert(memoryScopes).values({
              memoryId: input.plan.memoryId,
              scopeId: input.authority.scopeId,
              origin: "scope",
            }));
        } else {
          await executeTypedConversationProductQuery(transaction,
            conversationProductTypedDb.insert(memoryNamespaces).values(
              required.map((namespaceId) => ({ memoryId: input.plan.memoryId, namespaceId })),
            ));
        }
        // Namespace attachment triggers intentionally stale an already-verified
        // mapping. Attach the complete product audience first, then publish the
        // exact crypto mapping as the final product-row transition.
        const mappedProduct = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.update(memories).set({
            cryptoObjectId: input.plan.cryptoObjectId,
            cryptoRequiredNamespaceFingerprint: exactFingerprint,
            cryptoMappingState: "verified",
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memories.id, input.plan.memoryId),
            eq(memories.contentRevision, input.plan.contentRevision),
            isNull(memories.cryptoObjectId),
            eq(memories.cryptoMappingState, "unmapped"),
          )).returning({ id: memories.id }),
        );
        if (oneOrNull(mappedProduct, "Agent Memory create mapping CAS") === null) {
          return "stale" as const;
        }
      } else {
        const current = await this.#loadMutableTarget(transaction, input.authority, input.plan.memoryId);
        if (
          current === null
          || current.target.contentRevision !== operation.expectedContentRevision
          || current.accessRevision !== operation.expectedAccessRevision
          || !equalStrings(current.target.requiredNamespaceIds, required)
        ) return "stale" as const;
        const updated = await executeTypedConversationProductQuery(transaction,
          conversationProductTypedDb.update(memories).set({
            type: ordinary?.type ?? null,
            content: ordinary?.content ?? null,
            importance: input.plan.importance,
            embedding: [...input.embedding.vector],
            contentRevision: input.plan.contentRevision,
            cryptoObjectId: input.plan.cryptoObjectId,
            cryptoRequiredNamespaceFingerprint: exactFingerprint,
            cryptoMappingState: "verified",
            embeddingRevision: input.plan.contentRevision,
            embeddingProvider: input.embedding.provider as "openai" | "openrouter" | "venice",
            embeddingModel: input.embedding.canonicalModel,
            embeddingDimensions: input.embedding.dimensions,
            embeddingContractVersion: input.embedding.contractVersion,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memories.id, input.plan.memoryId),
            eq(memories.contentRevision, operation.expectedContentRevision),
            eq(memories.cryptoAccessRevision, operation.expectedAccessRevision),
            eq(memories.cryptoObjectId, current.target.cryptoObjectId),
          )).returning({ id: memories.id }));
        if (oneOrNull(updated, "Agent Memory publication CAS") === null) return "stale" as const;
        await executeTypedConversationProductQuery(transaction,
          conversationProductTypedDb.update(memoryCryptoRevisions).set({
            disposition: "superseded",
            nextAttemptAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memoryCryptoRevisions.memoryId, input.plan.memoryId),
            eq(memoryCryptoRevisions.contentRevision, operation.expectedContentRevision),
            eq(memoryCryptoRevisions.disposition, "mapped"),
          )));
      }

      const mapped = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.update(memoryCryptoRevisions).set({
          completion: "complete",
          disposition: "mapped",
          cryptoCompletedAt: sql`COALESCE(${memoryCryptoRevisions.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
          nextAttemptAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memoryCryptoRevisions.memoryId, input.plan.memoryId),
          eq(memoryCryptoRevisions.contentRevision, input.plan.contentRevision),
          eq(memoryCryptoRevisions.cryptoObjectId, input.plan.cryptoObjectId),
          eq(memoryCryptoRevisions.completion, "pending"),
          eq(memoryCryptoRevisions.disposition, "active"),
        )).returning({ sequence: memoryCryptoRevisions.sequence }));
      if (oneOrNull(mapped, "Agent Memory mapped reservation") === null) {
        throw new Error("Agent Memory publication lost its reserved revision");
      }
      const receipt = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.update(memoryCryptoOperations).set({
          completion: "complete",
          disposition: "complete",
          semanticChangeKind: input.plan.mutationKind !== "background"
            && operation.expectedContentRevision > 0 ? "replace" : null,
          cryptoCompletedAt: sql`CURRENT_TIMESTAMP`,
          nextAttemptAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memoryCryptoOperations.operationId, input.plan.operationId),
          eq(memoryCryptoOperations.completion, "pending"),
          eq(memoryCryptoOperations.disposition, "active"),
        )).returning({ operation_id: memoryCryptoOperations.operationId }));
      if (oneOrNull(receipt, "Agent Memory publication receipt") === null) {
        throw new Error("Agent Memory publication lost its operation receipt");
      }
      return "published" as const;
    });
  }

  async resolveTierTarget(input: Parameters<
    ProtectedAgentMemoryProductPort["resolveTierTarget"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["resolveTierTarget"]> {
    assertOperationId(input.operationId);
    if (
      !this.#authorityReadable(input.authority)
      || !UUID.test(input.memoryId)
      || input.signal?.aborted === true
    ) return unavailable("stale_revision");
    return this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) {
        return unavailable("stale_revision");
      }
      const current = await this.#loadMutableTarget(
        transaction,
        input.authority,
        input.memoryId,
      );
      return current === null
        ? unavailable("stale_revision")
        : Object.freeze({ status: "success" as const, value: current.target });
    });
  }

  async commitTier(input: Parameters<
    ProtectedAgentMemoryProductPort["commitTier"]
  >[0]): ReturnType<ProtectedAgentMemoryProductPort["commitTier"]> {
    assertOperationId(input.operationId);
    if (
      !this.#authorityReadable(input.authority)
      || input.signal?.aborted === true
      || canonicalIds(input.target.requiredNamespaceIds) === null
      || !authorityAllowsMutationSet(
        input.authority,
        input.target.requiredNamespaceIds,
      )
    ) return "stale";
    const expectedDigest = requestDigest({
      kind: "metadata",
      operationId: input.operationId,
      authority: input.authority,
      memoryId: input.target.memoryId,
      action: input.action,
    });
    const stableDigest = foregroundStableRequestDigest({
      operationId: input.operationId,
      mutationKind: input.action,
      authority: input.authority,
      memoryId: input.target.memoryId,
    });
    return this.#transaction(input.authority, async (transaction) => {
      if (!await this.#scopeOpenForMutation(transaction, input.authority)) {
        return "stale" as const;
      }
      const existing = await this.#existingOperation(transaction, input.operationId);
      if (existing !== null) {
        return existing.operationType === "metadata"
            && existing.memoryId === input.target.memoryId
            && sameBytes(existing.requestDigest, expectedDigest)
            && existing.completion === "complete"
          ? "replayed" as const
          : "stale" as const;
      }
      const current = await this.#loadMutableTarget(
        transaction,
        input.authority,
        input.target.memoryId,
      );
      if (
        current === null
        || current.target.contentRevision !== input.target.contentRevision
        || current.target.cryptoObjectId !== input.target.cryptoObjectId
        || current.target.requiredNamespaceIds.length
          !== input.target.requiredNamespaceIds.length
        || current.target.requiredNamespaceIds.some((entry, index) =>
          entry !== input.target.requiredNamespaceIds[index]
        )
      ) return "stale";
      const updated = await transaction.query(
        input.action === "demote"
          ? `UPDATE memories
                SET demoted_from = tier,
                    tier = LEAST(3, tier + 1),
                    demoted_at = CASE WHEN tier < 3 THEN CURRENT_TIMESTAMP ELSE demoted_at END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND content_revision = $2 AND crypto_object_id = $3
              RETURNING id`
          : `UPDATE memories
                SET tier = 1, demoted_from = NULL, demoted_at = NULL,
                    promoted_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND content_revision = $2 AND crypto_object_id = $3
                AND tier IN (1, 2)
              RETURNING id`,
        [
          input.target.memoryId,
          input.target.contentRevision,
          input.target.cryptoObjectId,
        ],
      );
      if (oneOrNull(updated, "Agent Memory tier mutation") === null) {
        return "stale" as const;
      }
      await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.insert(memoryCryptoOperations).values({
          operationId: input.operationId,
          memoryId: input.target.memoryId,
          anchorNamespaceId: input.target.requiredNamespaceIds[0]!,
          operationType: "metadata",
          expectedContentRevision: input.target.contentRevision,
          resultContentRevision: null,
          expectedAccessRevision: current.accessRevision,
          resultAccessRevision: null,
          requestDigest: expectedDigest,
          foregroundStableRequestDigest: stableDigest,
          foregroundMutationKind: input.action,
          foregroundRequiredNamespaceIds: [
            ...input.target.requiredNamespaceIds,
          ],
          completion: "complete",
          disposition: "complete",
          semanticChangeKind: input.action === "promote" ? "restore" : "demote",
          cryptoCompletedAt: sql`CURRENT_TIMESTAMP`,
          nextAttemptAt: null,
        }),
      );
      return "applied" as const;
    });
  }
}
