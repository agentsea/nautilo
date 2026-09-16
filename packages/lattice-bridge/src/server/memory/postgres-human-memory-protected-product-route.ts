import {
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryDetailResponseV1Schema,
  protectedMemoryListResponseV1Schema,
  protectedMemorySearchResponseV1Schema,
  type ProtectedMemoryDtoV1,
  type ProtectedMemoryProjectionV1,
  type ProtectedMemoryUnavailableResponseV1,
} from "@nautilo/api-client";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeMemoryListCursor, encodeMemoryListCursor } from "@nautilo/types";
import { decodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";
import {
  alias,
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  memories,
  memoryCryptoOperations,
  memoryNamespaces,
  memoryScopes,
  notExists,
  or,
  sql,
} from "@nautilo/db";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
} from "../../memory/memory-repository.ts";
import type {
  HumanMemoryProtectedProductRoutePort,
  HumanMemoryProtectedRouteAuthority,
  HumanMemoryProtectedTierAction,
  HumanMemoryProtectedTierReceipt,
  ResolveHumanMemoryNamespaceAuthority,
} from "./human-memory-protected-route-ports.ts";
import type {
  PostgresHumanMemoryCryptoCompletion,
  VerifiedHumanMemoryCryptoRevisionContent,
} from "./postgres-human-memory-crypto-completion.ts";
import {
  assertConversationProductCanonicalTransactionRunner,
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresScalar,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import type { HumanMemoryPublicationBoundary } from "./postgres-human-memory-product-update.ts";
import { encodeMemoryPayloadV1 } from "../../memory/memory-payload-v1.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const encoder = new TextEncoder();
const MAX_PAGE = 256;
const MAX_BRIEF = 64;
const memory = alias(memories, "m");

const structuralProductColumns = {
  memory_id: sql`${memory.id}`.as("memory_id"),
  content_revision: memory.contentRevision,
  crypto_access_revision: memory.cryptoAccessRevision,
  crypto_object_id: memory.cryptoObjectId,
  crypto_mapping_state: memory.cryptoMappingState,
  ordinary_body_missing: sql<boolean>`${or(isNull(memory.type), isNull(memory.content))}`.as("ordinary_body_missing"),
  crypto_required_namespace_fingerprint: memory.cryptoRequiredNamespaceFingerprint,
  importance: memory.importance, tier: memory.tier,
  created_at: memory.createdAt, updated_at: memory.updatedAt,
  demoted_at: memory.demotedAt, demoted_from: memory.demotedFrom,
  namespace_ids: sql<string>`COALESCE((
    SELECT json_agg(mn.namespace_id::text ORDER BY mn.namespace_id)
      FROM memory_namespaces mn WHERE mn.memory_id = ${memory.id}
  ), '[]'::json)::text`.as("namespace_ids"),
  scope_edges: sql<string>`COALESCE((
    SELECT json_agg(json_build_object('scopeId', ms.scope_id::text, 'origin', ms.origin)
      ORDER BY ms.scope_id) FROM memory_scopes ms WHERE ms.memory_id = ${memory.id}
  ), '[]'::json)::text`.as("scope_edges"),
};

function selectedNamespace(ids: readonly string[]) {
  return exists(conversationProductTypedDb.select({ id: memoryNamespaces.memoryId })
    .from(memoryNamespaces).where(and(eq(memoryNamespaces.memoryId, memory.id),
      inArray(memoryNamespaces.namespaceId, [...ids]))));
}

function currentReadAuthority(authority: HumanMemoryProtectedRouteAuthority) {
  return authority.memoryMode === "scope"
    ? exists(conversationProductTypedDb.select({ id: memoryScopes.memoryId })
      .from(memoryScopes).where(and(eq(memoryScopes.memoryId, memory.id),
        eq(memoryScopes.scopeId, authority.scopeId!))))
    : selectedNamespace(authority.readableNamespaceIds);
}

type ScopeEdge = Readonly<{
  scopeId: string;
  origin: "seed" | "scope";
}>;

type ProductSnapshot = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string | null;
  requiredNamespaceFingerprint: Uint8Array | null;
  cryptoMappingState: typeof memories.$inferSelect.cryptoMappingState;
  ordinaryBodyMissing: boolean;
  importance: number;
  tier: number;
  createdAt: Date;
  updatedAt: Date;
  demotedAt: Date | null;
  demotedFrom: number | null;
  namespaceIds: readonly string[];
  scopeEdges: readonly ScopeEdge[];
  score?: number;
}>;

type ProtectedProductSnapshot = ProductSnapshot & Readonly<{
  cryptoObjectId: string;
  requiredNamespaceFingerprint: Uint8Array;
}>;

function hasProtectedMapping(product: ProductSnapshot): product is ProtectedProductSnapshot {
  return product.cryptoObjectId !== null
    && product.requiredNamespaceFingerprint !== null
    && product.cryptoMappingState === "verified";
}

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function rowString(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowNumber(row: ConversationProductDatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be numeric`);
  }
  return value;
}

function rowInteger(row: ConversationProductDatabaseRow, field: string): number {
  const value = rowNumber(row, field);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be integer`);
  return value;
}

function rowDate(row: ConversationProductDatabaseRow, field: string): Date {
  const raw = row[field];
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be timestamp`);
  }
  return new Date(value);
}

function rowNullableDate(
  row: ConversationProductDatabaseRow,
  field: string,
): Date | null {
  return row[field] === null ? null : rowDate(row, field);
}

function rowNullableInteger(
  row: ConversationProductDatabaseRow,
  field: string,
): number | null {
  return row[field] === null ? null : rowInteger(row, field);
}

function rowBytes(row: ConversationProductDatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return value.slice();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function parseJson(row: ConversationProductDatabaseRow, field: string): unknown {
  try {
    return JSON.parse(rowString(row, field)) as unknown;
  } catch (cause) {
    throw new TypeError(`${field} must be canonical JSON`, { cause });
  }
}

function canonicalIds(values: unknown): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new TypeError("Memory Namespace inventory is invalid");
  }
  const entries: readonly unknown[] = values;
  const ids: string[] = [];
  for (const value of entries) {
    if (typeof value !== "string" || !UUID.test(value)) {
      throw new TypeError("Memory Namespace inventory is invalid");
    }
    ids.push(value);
  }
  const sorted = ids.sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError("Memory Namespace inventory is invalid");
  }
  return Object.freeze(sorted);
}

function parseScopeEdges(value: unknown): readonly ScopeEdge[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError("Memory scope inventory is invalid");
  }
  const entries: readonly unknown[] = value;
  const result = entries.map((entry) => {
    if (
      typeof entry !== "object" || entry === null
      || !("scopeId" in entry) || typeof entry.scopeId !== "string"
      || !UUID.test(entry.scopeId)
      || !("origin" in entry)
      || (entry.origin !== "seed" && entry.origin !== "scope")
      || Object.keys(entry).some((key) => key !== "scopeId" && key !== "origin")
    ) throw new TypeError("Memory scope inventory is invalid");
    return Object.freeze({ scopeId: entry.scopeId, origin: entry.origin });
  }).sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  if (new Set(result.map((entry) => entry.scopeId)).size !== result.length) {
    throw new TypeError("Memory scope inventory is invalid");
  }
  return Object.freeze(result);
}

function snapshot(row: ConversationProductDatabaseRow): ProductSnapshot {
  const memoryId = rowString(row, "memory_id");
  const contentRevision = rowInteger(row, "content_revision");
  const cryptoAccessRevision = rowInteger(row, "crypto_access_revision");
  const cryptoObjectId = row["crypto_object_id"] === null
    ? null : rowString(row, "crypto_object_id");
  const cryptoMappingState = rowString(row, "crypto_mapping_state");
  if (cryptoMappingState !== "unmapped" && cryptoMappingState !== "verified"
    && cryptoMappingState !== "stale") {
    throw new TypeError("Memory mapping state is invalid");
  }
  const importance = rowNumber(row, "importance");
  const tier = rowInteger(row, "tier");
  if (typeof row["ordinary_body_missing"] !== "boolean") throw new TypeError("Memory representation presence is invalid");
  if (
    !UUID.test(memoryId) || contentRevision < 0 || cryptoAccessRevision < 0
    || (cryptoObjectId !== null && (contentRevision < 1
      || cryptoObjectId !== deriveMemoryCryptoObjectIdV1({ memoryId, contentRevision })))
    || importance < 0 || importance > 1 || tier < 1 || tier > 3
  ) throw new TypeError("Protected Memory product coordinates are invalid");
  const score = row["score"] === undefined ? undefined : rowNumber(row, "score");
  if (score !== undefined && (score < -1 || score > 1)) {
    throw new TypeError("Protected Memory score is invalid");
  }
  return Object.freeze({
    memoryId,
    contentRevision,
    cryptoAccessRevision,
    cryptoObjectId,
    cryptoMappingState,
    ordinaryBodyMissing: row["ordinary_body_missing"],
    requiredNamespaceFingerprint: row["crypto_required_namespace_fingerprint"] === null
      ? null : rowBytes(
      row,
      "crypto_required_namespace_fingerprint",
    ),
    importance,
    tier,
    createdAt: rowDate(row, "created_at"),
    updatedAt: rowDate(row, "updated_at"),
    demotedAt: rowNullableDate(row, "demoted_at"),
    demotedFrom: rowNullableInteger(row, "demoted_from"),
    namespaceIds: canonicalIds(parseJson(row, "namespace_ids")),
    scopeEdges: parseScopeEdges(parseJson(row, "scope_edges")),
    ...(score === undefined ? {} : { score }),
  });
}

function scopeEdge(
  product: ProductSnapshot,
  authority: HumanMemoryProtectedRouteAuthority,
): ScopeEdge | null {
  if (authority.memoryMode !== "scope" || authority.scopeId === null) return null;
  return product.scopeEdges.find((edge) => edge.scopeId === authority.scopeId)
    ?? null;
}

function canRead(
  product: ProductSnapshot,
  authority: HumanMemoryProtectedRouteAuthority,
): boolean {
  return authority.memoryMode === "scope"
    ? scopeEdge(product, authority) !== null
    : product.namespaceIds.some((namespaceId) =>
      authority.readableNamespaceIds.includes(namespaceId)
    );
}

function canMutate(
  product: ProductSnapshot,
  authority: HumanMemoryProtectedRouteAuthority,
): boolean {
  if (authority.memoryMode === "scope") {
    const edge = scopeEdge(product, authority);
    return edge?.origin === "scope"
      && product.namespaceIds.length === 0
      && authority.originWritableNamespaceId !== null;
  }
  return product.namespaceIds.some((namespaceId) =>
    authority.mutableNamespaceIds.includes(namespaceId)
  );
}

function productFingerprintAuthentic(
  product: ProductSnapshot,
  authority: HumanMemoryProtectedRouteAuthority,
): boolean {
  const requiredNamespaceIds = authority.memoryMode === "scope"
    ? authority.originWritableNamespaceId === null
      ? null
      : [authority.originWritableNamespaceId]
    : product.namespaceIds;
  if (!hasProtectedMapping(product)
    || requiredNamespaceIds === null || requiredNamespaceIds.length === 0) {
    return false;
  }
  const expected = fingerprintRequiredMemoryNamespaces(requiredNamespaceIds);
  try {
    return sameBytes(expected, product.requiredNamespaceFingerprint);
  } finally {
    expected.fill(0);
  }
}

function reference(product: ProtectedProductSnapshot): MemoryCryptoRevisionReference {
  return Object.freeze({
    memoryId: product.memoryId,
    contentRevision: product.contentRevision,
    objectId: product.cryptoObjectId,
    expectedAccessRevision: product.cryptoAccessRevision,
    expectedActiveNamespaceFingerprint:
      product.requiredNamespaceFingerprint.slice(),
  });
}

function bytesToBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function wipeReadable(readable: VerifiedHumanMemoryCryptoRevisionContent): void {
  readable.payloadBytes.fill(0);
  readable.accessManifestBytes.fill(0);
  readable.accessManifestProofBytes.forEach((bytes) => bytes.fill(0));
  readable.accessSignerEvidence.forEach((entry) =>
    (entry.kind === "human_device" || entry.kind === "evidence_issuer_human_device"
      ? entry.signingPublicKey
      : entry.kind === "foreground_agent_accepted_execution"
      ? entry.planBytes
      : entry.evidenceBytes).fill(0)
  );
  readable.accessSignerEvidence.forEach((entry) => {
    if (entry.kind === "foreground_agent_accepted_execution") {
      entry.planDigest.fill(0);
    }
  });
  for (const envelope of readable.namespaceEnvelopes) {
    envelope.envelopeBytes.fill(0);
  }
}

function snapshotMatches(left: ProductSnapshot, right: ProductSnapshot): boolean {
  return left.memoryId === right.memoryId
    && left.contentRevision === right.contentRevision
    && left.cryptoAccessRevision === right.cryptoAccessRevision
    && left.cryptoObjectId === right.cryptoObjectId
    && left.cryptoMappingState === right.cryptoMappingState
    && left.ordinaryBodyMissing === right.ordinaryBodyMissing
    && (left.requiredNamespaceFingerprint === null || right.requiredNamespaceFingerprint === null
      ? left.requiredNamespaceFingerprint === right.requiredNamespaceFingerprint
      : sameBytes(left.requiredNamespaceFingerprint, right.requiredNamespaceFingerprint))
    && left.importance === right.importance
    && left.tier === right.tier
    && left.updatedAt.getTime() === right.updatedAt.getTime()
    && sameStrings(left.namespaceIds, right.namespaceIds)
    && JSON.stringify(left.scopeEdges) === JSON.stringify(right.scopeEdges);
}

function structuralProjection(product: ProductSnapshot,
  authority: HumanMemoryProtectedRouteAuthority): ProtectedMemoryProjectionV1 | null {
  const requiredNamespaceIds = product.namespaceIds.length > 0
    ? product.namespaceIds
    : authority.originWritableNamespaceId === null ? [] : [authority.originWritableNamespaceId];
  if (requiredNamespaceIds.length === 0) return null;
  return {
    memoryId: product.memoryId, contentRevision: product.contentRevision,
    cryptoAccessRevision: product.cryptoAccessRevision,
    importance: product.importance, tier: product.tier,
    createdAt: product.createdAt.toISOString(), updatedAt: product.updatedAt.toISOString(),
    namespaceIds: [...product.namespaceIds], requiredNamespaceIds: [...requiredNamespaceIds],
    readAuthorities: [], demotedAt: product.demotedAt?.toISOString() ?? null,
    demotedFrom: product.demotedFrom,
  };
}

function transitionAllowed(
  action: HumanMemoryProtectedTierAction,
  expectedTier: 1 | 2 | 3,
  nextTier: 1 | 2 | 3,
): boolean {
  if (action === "archive") {
    return (expectedTier === 1 || expectedTier === 2) && nextTier === 3;
  }
  if (action === "restore") {
    return expectedTier === 3 && (nextTier === 1 || nextTier === 2);
  }
  if (action === "promote") return expectedTier === 2 && nextTier === 1;
  return (expectedTier === 1 && nextTier === 2)
    || (expectedTier === 2 && nextTier === 3);
}

function expectedTierOperation(action: HumanMemoryProtectedTierAction) {
  return action === "archive" ? "archive" as const
    : action === "restore" ? "restore" as const
    : "tier_transition" as const;
}

function appliedTierStatus(action: HumanMemoryProtectedTierAction) {
  return action === "archive" ? "archived" as const
    : action === "restore" ? "restored" as const
    : action === "promote" ? "promoted" as const
    : "demoted" as const;
}

function transitionDigest(input: Readonly<{
  authority: HumanMemoryProtectedRouteAuthority;
  subjectHumanId: string;
  operationId: string;
  memoryId: string;
  anchorNamespaceId: string;
  action: HumanMemoryProtectedTierAction;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  expectedTier: 1 | 2 | 3;
  nextTier: 1 | 2 | 3;
}>): Uint8Array {
  return sha256(encoder.encode(JSON.stringify({
    contract: "kentauros/human-memory-protected-tier/v1",
    subjectHumanId: input.subjectHumanId,
    userId: input.authority.userId,
    actorId: input.authority.actorId,
    memoryMode: input.authority.memoryMode,
    scopeId: input.authority.scopeId,
    operationId: input.operationId,
    memoryId: input.memoryId,
    anchorNamespaceId: input.anchorNamespaceId,
    action: input.action,
    expectedContentRevision: input.expectedContentRevision,
    expectedCryptoAccessRevision: input.expectedCryptoAccessRevision,
    expectedTier: input.expectedTier,
    nextTier: input.nextTier,
  })));
}

async function assertProductIdentity(
  transaction: ConversationProductPostgresTransaction,
  userId: string,
): Promise<void> {
  const rows = await executeTypedConversationProductQuery(
    transaction,
    conversationProductTypedDb.select({
      current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
      current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
    }).from(sql`(values (1)) as identity_probe`).limit(2),
  );
  if (
    rows.length !== 1 || rows[0]?.["current_user_id"] !== userId
    || rows[0]?.["current_agent_id"] !== null
  ) throw new TypeError("Human Memory product identity is unavailable");
}

const PRODUCT_COLUMNS = `m.id::text AS memory_id,
  m.content_revision, m.crypto_access_revision, m.crypto_object_id, m.crypto_mapping_state,
  (m.type IS NULL OR m.content IS NULL) AS ordinary_body_missing,
  m.crypto_required_namespace_fingerprint, m.importance, m.tier,
  m.created_at, m.updated_at, m.demoted_at, m.demoted_from,
  COALESCE((SELECT json_agg(mn.namespace_id::text ORDER BY mn.namespace_id)
    FROM memory_namespaces mn WHERE mn.memory_id = m.id), '[]'::json)::text AS namespace_ids,
  COALESCE((SELECT json_agg(json_build_object('scopeId', ms.scope_id::text,
    'origin', ms.origin) ORDER BY ms.scope_id)
    FROM memory_scopes ms WHERE ms.memory_id = m.id), '[]'::json)::text AS scope_edges`;

function authorityPredicate(
  authority: HumanMemoryProtectedRouteAuthority,
  start: number,
): Readonly<{ sql: string; parameters: readonly ConversationProductPostgresScalar[] }> {
  if (authority.memoryMode === "scope") {
    return Object.freeze({
      sql: `EXISTS (SELECT 1 FROM memory_scopes auth_scope
        WHERE auth_scope.memory_id = m.id AND auth_scope.scope_id = $${start}::uuid)`,
      parameters: [authority.scopeId],
    });
  }
  return Object.freeze({
    sql: `EXISTS (SELECT 1 FROM memory_namespaces auth_namespace
      WHERE auth_namespace.memory_id = m.id
        AND auth_namespace.namespace_id = ANY($${start}::uuid[]))`,
    parameters: [`{${authority.readableNamespaceIds.join(",")}}`],
  });
}

function boundedLimit(value: number | undefined, maximum = MAX_PAGE): number {
  if (value === undefined) return Math.min(50, maximum);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError("Protected Memory limit is invalid");
  }
  return value;
}

async function withProductTransaction<Result>(
  handle: ConversationProductPostgresHandle,
  userId: string,
  callback: (transaction: ConversationProductPostgresTransaction) => Promise<Result>,
): Promise<Result> {
  return handle.transaction(async (transaction) => {
    await assertProductIdentity(transaction, userId);
    return callback(transaction);
  }, { isolationLevel: "serializable" });
}

export function createPostgresHumanMemoryProtectedProductRoutePort(input: Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
  publication: Pick<HumanMemoryPublicationBoundary,
    "fence" | "representation" | "allowOrdinaryFallback" | "policyRevision">;
  cryptoCompletion: Pick<PostgresHumanMemoryCryptoCompletion, "read">;
  resolveHumanId: (userId: string) => Promise<string | null>;
  resolveNamespaceAuthority: ResolveHumanMemoryNamespaceAuthority;
  issueReadObservation?: (request: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    memoryId: string;
    cryptoObjectId: string;
    contentRevision: number;
    cryptoAccessRevision: number;
  }>) => Promise<ProtectedMemoryDtoV1["readObservationAdmission"]>;
}>): HumanMemoryProtectedProductRoutePort {
  assertVerifiedConversationProductPostgresHandle(input.handle);
  assertConversationProductCanonicalTransactionRunner(input.handle, input.canonicalRunner);
  if (input.handle.role !== "nautilo") {
    throw new TypeError("Human Memory product route requires the ordinary nautilo role");
  }

  async function snapshotById(
    memoryId: string,
    authority: HumanMemoryProtectedRouteAuthority,
  ): Promise<ProductSnapshot | null> {
    if (!UUID.test(memoryId)) throw new TypeError("Memory ID is invalid");
    const rows = await withProductTransaction(
      input.handle,
      authority.userId,
      (transaction) => executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select(structuralProductColumns).from(memory).where(and(
          eq(memory.id, memoryId),
          currentReadAuthority(authority),
        )).limit(2),
      ),
    );
    if (rows.length > 1) throw new Error("Protected Memory snapshot duplicated");
    return rows[0] === undefined ? null : snapshot(rows[0]);
  }

  async function protectedDto(
    product: ProductSnapshot,
    authority: HumanMemoryProtectedRouteAuthority,
  ): Promise<ProtectedMemoryDtoV1 | ProtectedMemoryUnavailableResponseV1> {
    if (!canRead(product, authority)) return unavailable("authorization_required");
    if (!hasProtectedMapping(product)) {
      // Ordinary history is a real row, not a malformed encrypted object or
      // an empty library. Do not select content/type here, including in Full.
      const projection = structuralProjection(product, authority);
      if (projection === null) return unavailable("target_encryption_not_ready");
      return {
        dtoVersion: 1,
        projection,
        protectedPayload: input.publication.representation === "protected_only"
          ? { status: "unavailable", reason: "protected_representation_missing" }
          : { status: "pending", reason: "backfill_pending" },
      };
    }
    const expectedFingerprint = product.requiredNamespaceFingerprint.slice();
    let readable: VerifiedHumanMemoryCryptoRevisionContent | null = null;
    try {
      readable = await input.cryptoCompletion.read(reference(product));
      if (
        readable === null
        || readable.memoryId !== product.memoryId
        || readable.contentRevision !== product.contentRevision
        || readable.objectId !== product.cryptoObjectId
        || readable.accessRevision !== product.cryptoAccessRevision
        || !sameBytes(
          fingerprintRequiredMemoryNamespaces(readable.requiredNamespaceIds),
          expectedFingerprint,
        )
        || readable.namespaceEnvelopes.length !== readable.requiredNamespaceIds.length
        || readable.namespaceEnvelopes.some((entry, index) =>
          entry.namespaceId !== readable!.requiredNamespaceIds[index]
        )
      ) return unavailable("integrity_failure");
      const current = await snapshotById(product.memoryId, authority);
      if (current === null || !snapshotMatches(product, current)) {
        return unavailable("stale_revision");
      }
      const selectedScope = scopeEdge(product, authority);
      if (authority.memoryMode === "scope") return unavailable("target_encryption_not_ready");
      const subjectHumanId = await input.resolveHumanId(authority.userId);
      if (subjectHumanId === null) return unavailable("authorization_required");
      const authorities = new Map<string, Awaited<ReturnType<
        ResolveHumanMemoryNamespaceAuthority
      >>>();
      for (const entry of readable.namespaceEnvelopes) {
        const envelope = decodeNamespaceObjectEnvelopeV2(entry.envelopeBytes);
        if (envelope.context.namespaceId !== entry.namespaceId) {
          return unavailable("integrity_failure");
        }
        if (!authority.readableNamespaceIds.includes(entry.namespaceId)) continue;
        authorities.set(entry.namespaceId, await input.resolveNamespaceAuthority({
          subjectUserId: authority.userId,
          subjectHumanId,
          preferredSourceRoomId: authority.sourceRoomId,
          namespaceId: entry.namespaceId,
          requested: [{ generation: envelope.context.keyGeneration,
            accessRevision: envelope.context.bindingRevisionAtWrap }],
        }));
      }
      const readAuthorities = readable.requiredNamespaceIds.flatMap((namespaceId) => {
        const resolved = authorities.get(namespaceId);
        return resolved === undefined || resolved === null ? [] : [resolved];
      });
      const projection: ProtectedMemoryProjectionV1 = {
        ...(input.publication.representation === "ordinary_and_protected" && product.ordinaryBodyMissing
          ? { representationRepair: "protected_to_ordinary" as const } : {}),
        memoryId: product.memoryId,
        contentRevision: product.contentRevision,
        cryptoAccessRevision: product.cryptoAccessRevision,
        importance: product.importance,
        tier: product.tier,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
        namespaceIds: [...product.namespaceIds],
        requiredNamespaceIds: [...readable.requiredNamespaceIds],
        readAuthorities,
        ...(readable.requiredNamespaceIds.every((namespaceId) =>
          authority.mutableNamespaceIds.includes(namespaceId)
          && authorities.get(namespaceId) !== null
          && authorities.get(namespaceId) !== undefined
        ) ? { mutationAuthorities: readable.requiredNamespaceIds.map((namespaceId) =>
          authorities.get(namespaceId)!
        ) } : {}),
        ...(selectedScope === null ? {} : { scopeOrigin: selectedScope.origin }),
        demotedAt: product.demotedAt?.toISOString() ?? null,
        demotedFrom: product.demotedFrom,
      };
      if (readAuthorities.length === 0) return Object.freeze({
        dtoVersion: 1,
        projection,
        protectedPayload: Object.freeze({
          status: "pending" as const,
          reason: "shadow_pending" as const,
        }),
      });
      const readObservationAdmission = await input.issueReadObservation?.({
        authority, memoryId: product.memoryId, cryptoObjectId: product.cryptoObjectId,
        contentRevision: product.contentRevision, cryptoAccessRevision: product.cryptoAccessRevision,
      });
      return Object.freeze({
        dtoVersion: 1,
        ...(readObservationAdmission === undefined ? {} : { readObservationAdmission }),
        projection,
        protectedPayload: Object.freeze({
          status: "encrypted",
          cryptoObjectId: product.cryptoObjectId,
          payloadVersion: 1,
          encryptedPayloadBytesBase64url: bytesToBase64url(readable.payloadBytes),
          accessManifestBytesBase64url:
            bytesToBase64url(readable.accessManifestBytes),
          accessManifestProofBytesBase64url:
            readable.accessManifestProofBytes.map(bytesToBase64url),
          accessSignerEvidence: readable.accessSignerEvidence.map((entry) =>
            entry.kind === "human_device"
              ? {
                kind: entry.kind,
                subjectHumanId: entry.subjectHumanId,
                committerDeviceId: entry.committerDeviceId,
                hostAuthorizationRevision: entry.hostAuthorizationRevision,
                signingPublicKeyBase64url:
                  bytesToBase64url(entry.signingPublicKey),
              }
              : entry.kind === "evidence_issuer_human_device"
              ? {
                kind: entry.kind,
                subjectHumanId: entry.subjectHumanId,
                deviceId: entry.deviceId,
                hostAuthorizationRevision: entry.hostAuthorizationRevision,
                signingPublicKeyBase64url:
                  bytesToBase64url(entry.signingPublicKey),
              }
              : entry.kind === "foreground_agent_accepted_execution"
              ? {
                kind: entry.kind,
                planBytesBase64url: bytesToBase64url(entry.planBytes),
                planDigestBase64url: bytesToBase64url(entry.planDigest),
              }
              : {
                kind: entry.kind,
                evidenceBytesBase64url: bytesToBase64url(entry.evidenceBytes),
              }
          ),
          namespaceEnvelopes: readable.namespaceEnvelopes.map((entry) => ({
            namespaceId: entry.namespaceId,
            envelopeBytesBase64url: bytesToBase64url(entry.envelopeBytes),
          })),
        }),
      });
    } finally {
      expectedFingerprint.fill(0);
      if (readable !== null) wipeReadable(readable);
    }
  }

  async function dto(
    product: ProductSnapshot,
    authority: HumanMemoryProtectedRouteAuthority,
  ): Promise<ProtectedMemoryDtoV1 | ProtectedMemoryUnavailableResponseV1> {
    const result = await protectedDto(product, authority);
    if ("status" in result) return result;
    const encrypted = result.protectedPayload.status === "encrypted";
    // Strict compares only a digest. Fallback carries an explicitly ordinary
    // sibling, usable only after a typed protected-availability failure. Full
    // must not select that body at all.
    if (input.publication.representation !== "ordinary_and_protected"
      || product.ordinaryBodyMissing
      || (!encrypted && !input.publication.allowOrdinaryFallback)) return result;
    const sibling = await readOrdinarySibling(product, authority);
    if ("status" in sibling) return sibling;
    return Object.freeze({ ...result,
      ...(encrypted ? { shadowComparison: sibling.shadowComparison } : {}),
      ...(input.publication.allowOrdinaryFallback ? {
        ordinaryFallback: { policyRevision: input.publication.policyRevision,
          payload: sibling.payload },
      } : {}),
    });
  }

  async function readOrdinarySibling(
    product: ProductSnapshot,
    authority: HumanMemoryProtectedRouteAuthority,
  ): Promise<Readonly<{
    payload: NonNullable<ProtectedMemoryDtoV1["ordinaryFallback"]>["payload"];
    shadowComparison: NonNullable<ProtectedMemoryDtoV1["shadowComparison"]>;
  }> | ProtectedMemoryUnavailableResponseV1> {
    return input.canonicalRunner.transaction(async (canonical, transaction) => {
      await assertProductIdentity(transaction, authority.userId);
      await input.publication.fence({ transaction: canonical, authority, mutation: false });
      const rows = await executeTypedConversationProductQuery(transaction,
        conversationProductTypedDb.select({ type: memory.type, content: memory.content })
          .from(memory).where(and(eq(memory.id, product.memoryId),
            eq(memory.contentRevision, product.contentRevision),
            product.cryptoObjectId === null ? isNull(memory.cryptoObjectId)
              : eq(memory.cryptoObjectId, product.cryptoObjectId),
            eq(memory.cryptoAccessRevision, product.cryptoAccessRevision),
            eq(memory.cryptoMappingState, product.cryptoMappingState),
            currentReadAuthority(authority))).limit(2));
      if (rows.length !== 1) return unavailable("stale_revision");
      const row = rows[0]!;
      if (typeof row["type"] !== "string" || typeof row["content"] !== "string") {
        return unavailable("stale_revision");
      }
      const authored = { formatVersion: 1 as const,
        type: row["type"], content: row["content"] };
      let payload: Uint8Array;
      try {
        payload = encodeMemoryPayloadV1(authored);
      } catch { return unavailable("integrity_failure"); }
      try {
        return { payload: authored,
          shadowComparison: { algorithm: "sha256-memory-payload-v1" as const,
            digestBase64url: bytesToBase64url(sha256(payload)) } };
      } finally { payload.fill(0); }
    }, { isolationLevel: "serializable" });
  }

  async function rowDto(product: ProductSnapshot, authority: HumanMemoryProtectedRouteAuthority) {
    const result = await dto(product, authority);
    if (!("status" in result)) return result;
    // Keep expected row-local failures in the page rather than losing other
    // independently authorized rows. Unknown transport exceptions still surface.
    const projection = structuralProjection(product, authority);
    return projection === null ? result : {
      dtoVersion: 1 as const, projection,
      protectedPayload: { status: "unavailable" as const, reason: result.reason },
    };
  }

  async function queryList(
    common: Readonly<{
      authority: HumanMemoryProtectedRouteAuthority;
      namespaceIds: readonly string[];
      includeArchive: boolean;
      limit: number;
      cursor?: Readonly<{ createdAt: Date; id: string }>;
      excludeNamespaceIds?: readonly string[];
      semantic?: Readonly<{
        vector: readonly number[];
        provider: "openai" | "openrouter" | "venice";
        model: string;
        dimensions: number;
        contractVersion: number;
      }>;
    }>,
  ): Promise<readonly ProductSnapshot[]> {
    const semantic = common.semantic;
    // pgvector distance is a PostgreSQL expression; selection, filters and
    // continuation remain schema-owned Drizzle rather than raw SQL statements.
    const score = semantic === undefined ? null
      : sql<number>`1 - (${memory.embedding} <=> ${`[${semantic.vector.join(",")}]`}::vector)`;
    const excluded = common.excludeNamespaceIds;
    const cursor = common.cursor;
    const query = conversationProductTypedDb.select({
      ...structuralProductColumns,
      ...(score === null ? {} : { score: score.as("score") }),
    }).from(memory).where(and(
      currentReadAuthority(common.authority),
      common.authority.memoryMode === "scope" ? undefined : selectedNamespace(common.namespaceIds),
      common.includeArchive ? undefined : lt(memory.tier, 3),
      semantic === undefined ? undefined : and(
        isNotNull(memory.embedding), eq(memory.embeddingRevision, memory.contentRevision),
        eq(memory.embeddingProvider, semantic.provider), eq(memory.embeddingModel, semantic.model),
        eq(memory.embeddingDimensions, semantic.dimensions),
        eq(memory.embeddingContractVersion, semantic.contractVersion)),
      cursor === undefined ? undefined : or(lt(memory.createdAt, cursor.createdAt),
        and(eq(memory.createdAt, cursor.createdAt), lt(memory.id, cursor.id))),
      excluded === undefined || excluded.length === 0 ? undefined
        : notExists(conversationProductTypedDb.select({ id: memoryNamespaces.memoryId })
          .from(memoryNamespaces).where(and(eq(memoryNamespaces.memoryId, memory.id),
            inArray(memoryNamespaces.namespaceId, [...excluded])))),
    )).orderBy(...(score === null
      ? [desc(memory.createdAt), desc(memory.id)]
      : [desc(score), asc(memory.id)])).limit(common.limit);
    const rows = await withProductTransaction(
      input.handle,
      common.authority.userId,
      (transaction) => executeTypedConversationProductQuery(transaction, query),
    );
    return Object.freeze(rows.map(snapshot));
  }

  const port: HumanMemoryProtectedProductRoutePort = {
    async list(request) {
      const limit = boundedLimit(request.limit);
      const cursor = request.cursor === undefined ? undefined : decodeMemoryListCursor(request.cursor);
      if (cursor === null || (cursor !== undefined && !UUID.test(cursor.id))) {
        throw new TypeError("Protected Memory cursor is invalid");
      }
      const products = await queryList({
        authority: request.authority,
        namespaceIds: request.namespaceIds,
        includeArchive: request.includeArchive,
        limit: limit + 1,
        ...(cursor === undefined ? {} : { cursor }),
        ...(request.excludeNamespaceIds === undefined ? {} : {
          excludeNamespaceIds: request.excludeNamespaceIds,
        }),
      });
      const items: ProtectedMemoryDtoV1[] = [];
      const page = products.slice(0, limit);
      for (const product of page) {
        const projected = await rowDto(product, request.authority);
        if ("status" in projected) return projected;
        items.push(projected);
      }
      return protectedMemoryListResponseV1Schema.parse({
        dtoVersion: 1,
        items,
        nextCursor: products.length > limit && page.length > 0
          ? encodeMemoryListCursor(page.at(-1)!.createdAt, page.at(-1)!.memoryId)
          : null,
        memoryMode: request.authority.memoryMode,
      });
    },

    async detail(request) {
      const product = await snapshotById(request.memoryId, request.authority);
      if (product === null) return unavailable("deleted");
      const projected = await dto(product, request.authority);
      if ("status" in projected) return projected;
      const mutable = canMutate(product, request.authority);
      return protectedMemoryDetailResponseV1Schema.parse({
        dtoVersion: 1,
        memory: projected,
        memoryMode: request.authority.memoryMode,
        actionAuthority: {
          canEdit: mutable,
          canArchive: mutable,
          canManageAccess: request.authority.memoryMode === "namespace" && mutable,
        },
      });
    },

    async searchSemantic(request) {
      const products = await queryList({
        authority: request.authority,
        namespaceIds: request.namespaceIds,
        includeArchive: request.includeArchive,
        limit: boundedLimit(request.limit),
        semantic: {
          vector: request.embedding.vector,
          provider: request.embedding.provider,
          model: request.embedding.canonicalModel,
          dimensions: request.embedding.dimensions,
          contractVersion: request.embedding.processorContractVersion,
        },
      });
      const items = [];
      for (const product of products) {
        const projected = await rowDto(product, request.authority);
        if ("status" in projected) return projected;
        items.push({ memory: projected, score: product.score });
      }
      return protectedMemorySearchResponseV1Schema.parse({
        dtoVersion: 1,
        items,
        memoryMode: request.authority.memoryMode,
        queryDisclosure: "embedding_provider",
      });
    },

    async brief(request) {
      const products = await queryList({
        authority: request.authority,
        namespaceIds: request.namespaceIds,
        includeArchive: false,
        limit: MAX_BRIEF,
      });
      const items: ProtectedMemoryDtoV1[] = [];
      for (const product of products) {
        const projected = await rowDto(product, request.authority);
        if ("status" in projected) return projected;
        items.push(projected);
      }
      return protectedMemoryBriefResponseV1Schema.parse({
        dtoVersion: 1,
        items,
        memoryMode: request.authority.memoryMode,
      });
    },

    async transitionTier(request) {
      if (
        !UUID.test(request.memoryId)
        || !PORTABLE_ID.test(request.operationId)
        || encoder.encode(request.operationId).length > 128
        || !Number.isSafeInteger(request.expectedContentRevision)
        || request.expectedContentRevision < 1
        || !Number.isSafeInteger(request.expectedCryptoAccessRevision)
        || request.expectedCryptoAccessRevision < 0
        || !transitionAllowed(request.action, request.expectedTier, request.nextTier)
      ) return unavailable("authorization_required");
      return input.canonicalRunner.transaction(
        async (canonical, transaction) => {
          await assertProductIdentity(transaction, request.authority.userId);
          await input.publication.fence({
            transaction: canonical, authority: request.authority, mutation: true,
          });
          const prior = await transaction.query(
            `/* human-protected-memory:tier-replay */
             SELECT operation_id, memory_id::text AS memory_id,
                    anchor_namespace_id::text AS anchor_namespace_id,
                    operation_type, expected_content_revision,
                    expected_access_revision, request_digest,
                    completion, disposition
               FROM memory_crypto_operations
              WHERE operation_id = $1
              LIMIT 2 FOR UPDATE`,
            [request.operationId],
          );
          if (prior.length > 1) throw new Error("Memory tier receipt duplicated");
          if (prior.length === 1) {
            const row = prior[0]!;
            const anchorNamespaceId = rowString(row, "anchor_namespace_id");
            const anchorAuthorized = request.authority.memoryMode === "scope"
              ? anchorNamespaceId === request.authority.originWritableNamespaceId
              : request.authority.mutableNamespaceIds.includes(anchorNamespaceId)
                && request.authority.readableNamespaceIds.includes(anchorNamespaceId);
            const digest = transitionDigest({ ...request, anchorNamespaceId });
            const exact = anchorAuthorized
              && row["operation_id"] === request.operationId
              && row["memory_id"] === request.memoryId
              && row["operation_type"] === "metadata"
              && row["expected_content_revision"]
                === request.expectedContentRevision
              && row["expected_access_revision"]
                === request.expectedCryptoAccessRevision
              && row["request_digest"] instanceof Uint8Array
              && sameBytes(row["request_digest"], digest)
              && row["completion"] === "complete"
              && row["disposition"] === "complete";
            digest.fill(0);
            return exact
              ? Object.freeze({
                  operation: expectedTierOperation(request.action),
                  operationId: request.operationId,
                  memoryId: request.memoryId,
                  response: Object.freeze({
                    operationId: request.operationId,
                    status: "replayed" as const,
                    contentRevision: request.expectedContentRevision,
                    cryptoAccessRevision: request.expectedCryptoAccessRevision,
                    previousTier: request.expectedTier,
                    nextTier: request.nextTier,
                  }),
                })
              : unavailable("integrity_failure");
          }

          const predicate = authorityPredicate(request.authority, 2);
          const rows = await transaction.query(
            `/* human-protected-memory:lock-tier */
             SELECT ${PRODUCT_COLUMNS} FROM memories m
              WHERE m.id = $1::uuid AND ${predicate.sql}
              LIMIT 2 FOR UPDATE`,
            [request.memoryId, ...predicate.parameters],
          );
          if (rows.length === 0) return unavailable("deleted");
          if (rows.length > 1) throw new Error("Memory tier target duplicated");
          const product = snapshot(rows[0]!);
          if (!canMutate(product, request.authority)) {
            return unavailable("authorization_required");
          }
          if (!hasProtectedMapping(product)) return unavailable("target_encryption_not_ready");
          if (!productFingerprintAuthentic(product, request.authority)) {
            return unavailable("integrity_failure");
          }
          if (
            product.contentRevision !== request.expectedContentRevision
            || product.cryptoAccessRevision !== request.expectedCryptoAccessRevision
            || product.tier !== request.expectedTier
          ) return unavailable("stale_revision");
          const anchorNamespaceId = request.authority.memoryMode === "scope"
            ? request.authority.originWritableNamespaceId
            : product.namespaceIds.find((namespaceId) =>
                request.authority.mutableNamespaceIds.includes(namespaceId)
                && request.authority.readableNamespaceIds.includes(namespaceId)
              ) ?? null;
          if (anchorNamespaceId === null || !UUID.test(anchorNamespaceId)) {
            return unavailable("authorization_required");
          }
          const digest = transitionDigest({ ...request, anchorNamespaceId });
          try {
            const updated = await executeTypedConversationProductQuery(
              transaction,
              conversationProductTypedDb.update(memories).set({
                tier: request.nextTier,
                demotedFrom: request.nextTier > request.expectedTier
                  ? request.expectedTier : null,
                demotedAt: request.nextTier > request.expectedTier
                  ? sql`current_timestamp` : null,
                promotedAt: request.nextTier < request.expectedTier
                  ? sql`current_timestamp` : sql`${memories.promotedAt}`,
                updatedAt: sql`current_timestamp`,
              }).where(and(
                eq(memories.id, request.memoryId),
                eq(memories.contentRevision, request.expectedContentRevision),
                eq(
                  memories.cryptoAccessRevision,
                  request.expectedCryptoAccessRevision,
                ),
                eq(memories.cryptoObjectId, product.cryptoObjectId),
                eq(
                  memories.cryptoRequiredNamespaceFingerprint,
                  product.requiredNamespaceFingerprint,
                ),
                eq(memories.tier, request.expectedTier),
              )).returning({
                memory_id: sql`${memories.id}`.as("memory_id"),
              }),
            );
            if (
              updated.length !== 1
              || updated[0]?.["memory_id"] !== request.memoryId
            ) return unavailable("stale_revision");
            await executeTypedConversationProductQuery(
              transaction,
              conversationProductTypedDb.insert(memoryCryptoOperations).values({
                operationId: request.operationId,
                memoryId: request.memoryId,
                anchorNamespaceId,
                operationType: "metadata",
                expectedContentRevision: request.expectedContentRevision,
                resultContentRevision: null,
                expectedAccessRevision: request.expectedCryptoAccessRevision,
                resultAccessRevision: null,
                requestDigest: digest,
                completion: "complete",
                disposition: "complete",
                semanticChangeKind: request.action === "promote"
                  ? "restore" : request.action === "demote" ? "demote"
                  : request.action,
                semanticChangeAcknowledgedAt: null,
                cryptoCompletedAt: sql`current_timestamp`,
                nextAttemptAt: null,
              }),
            );
          } finally {
            digest.fill(0);
          }
          const receipt: HumanMemoryProtectedTierReceipt = Object.freeze({
            operation: expectedTierOperation(request.action),
            operationId: request.operationId,
            memoryId: request.memoryId,
            response: Object.freeze({
              operationId: request.operationId,
              status: appliedTierStatus(request.action),
              contentRevision: request.expectedContentRevision,
              cryptoAccessRevision: request.expectedCryptoAccessRevision,
              previousTier: request.expectedTier,
              nextTier: request.nextTier,
            }),
          });
          return receipt;
        }, { isolationLevel: "serializable" },
      );
    },
  };
  return Object.freeze(port);
}
