import { randomUUID } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import type {
  ProtectedMemoryCreatePlanSlotResponseV1,
} from "@nautilo/api-client";
import {
  createHumanMemoryOrdinaryFallbackReplayAdmissionV1,
  type AuthenticatedHumanMemoryOrdinaryFallbackRequestV1,
  type HumanMemoryOrdinaryFallbackReplayAdmissionV1,
} from "../../memory/human-memory-ordinary-fallback-request.ts";
import {
  and,
  eq,
  inArray,
  memories,
  memoryCryptoOperations,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  sql,
  type HumanMemoryProductOutcomeV1,
} from "@nautilo/db";

import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import { resolveRequiredMemoryNamespaceIds } from "../../memory/required-namespace-set.ts";
import type {
  MemoryForegroundEmbeddingResult,
} from "../../memory/foreground-embedding-processor.ts";
import type {
  HumanMemoryProductAllocationCertificate,
  HumanMemoryPreparedAuthorityContext,
  HumanMemoryReservedReplayAdmission,
  PreparedHumanMemoryUpdate,
} from "./human-memory-prepared-update.ts";
import { createHumanMemoryReservedReplayAdmission } from
  "./human-memory-prepared-update.ts";
import {
  HumanMemoryPreparedRouteError,
  humanMemoryPreparedAuthorizationError,
  humanMemoryPreparedIntegrityError,
} from "./human-memory-prepared-route-error.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  assertConversationProductCanonicalTransactionRunner,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
  type ConversationProductCanonicalTransactionRunner,
} from "../message/postgres-conversation-product-store.ts";

const DIGEST_DOMAIN = "nautilo/lattice-bridge/human-memory-reservation/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function staleRevision(message: string): HumanMemoryPreparedRouteError {
  return new HumanMemoryPreparedRouteError("stale_revision", message);
}

export type HumanMemoryProductAuthority = Readonly<{
  userId: string;
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
}>;

export type HumanMemoryActualEmbedding = Extract<
  MemoryForegroundEmbeddingResult,
  Readonly<{ status: "embedded" }>
>["embedding"];
export type HumanMemoryAuthoredPublication = Readonly<{
  formatVersion: 1;
  type: string;
  content: string;
  importance?: number;
}>;
export type HumanMemoryOrdinaryFallbackReason =
  | "encryption_pending"
  | "target_encryption_not_ready";

export type HumanMemoryProductProjection = Readonly<{
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  importance: number;
  tier: number;
  createdAt: Date;
  updatedAt: Date;
  namespaceIds: readonly string[];
  requiredNamespaceIds: readonly string[];
  scopeOrigin: "seed" | "scope" | undefined;
}>;

export type HumanMemoryProductInspection =
  | Readonly<{
      kind: "new";
      expectedAccessRevision: number;
    }>
  | Readonly<{
      kind: "replay";
      certificate: HumanMemoryProductAllocationCertificate;
      alreadyPublished: boolean;
      projection?: HumanMemoryProductProjection;
      ordinaryFallbackReason?: HumanMemoryOrdinaryFallbackReason;
    }>;

export type HumanMemoryReservationReplay = Readonly<{
  admission: HumanMemoryReservedReplayAdmission;
  completedProjection?: HumanMemoryProductProjection;
}>;

export type HumanMemoryOrdinaryFallbackAdmission = Readonly<{
  authenticated: AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
  expectedAccessRevision: number;
}>;

export type HumanMemoryOrdinaryFallbackReplay = Readonly<{
  replayAdmission: HumanMemoryOrdinaryFallbackReplayAdmissionV1;
  completed?: Readonly<{
    projection: HumanMemoryProductProjection;
    reason: HumanMemoryOrdinaryFallbackReason;
  }>;
}>;

export interface HumanMemoryProductUpdatePort {
  lookupOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    operationId: string;
    memoryId: string;
    requestDigest: Uint8Array;
  }>): Promise<HumanMemoryOrdinaryFallbackReplay | null>;
  admitOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    authenticated: AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
  }>): Promise<HumanMemoryOrdinaryFallbackAdmission>;
  publishOrdinaryFallbackIntent(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    admission: HumanMemoryOrdinaryFallbackAdmission;
    embedding: HumanMemoryActualEmbedding;
  }>): Promise<HumanMemoryProductProjection>;
  lookupReservation(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    operationId: string;
    memoryId: string;
    operationRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryReservationReplay | null>;
  inspect(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    prepared: PreparedHumanMemoryUpdate;
    operationRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryProductInspection>;
  allocate(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    prepared: PreparedHumanMemoryUpdate;
    operationRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryProductAllocationCertificate>;
  authorizeCurrent(
    authority: HumanMemoryProductAuthority,
    certificate: HumanMemoryProductAllocationCertificate,
  ): Promise<boolean>;
  publish(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    authored: HumanMemoryAuthoredPublication;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
  }>): Promise<HumanMemoryProductProjection>;
  publishOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    authored: HumanMemoryAuthoredPublication;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
    reason: HumanMemoryOrdinaryFallbackReason;
  }>): Promise<HumanMemoryProductProjection>;
}

export type HumanMemoryProductCreateAuthority = HumanMemoryProductAuthority &
  Readonly<{
    memoryMode: "namespace" | "scope";
    scopeId: string | null;
    originWritableNamespaceId: string | null;
  }>;

export type HumanMemoryProductCreateInspection =
  | Readonly<{
      kind: "new";
      expectedAccessRevision: 0;
      planIssuedAt: number;
      planDeadlineAt: number;
    }>
  | Readonly<{
      kind: "replay";
      certificate: HumanMemoryProductAllocationCertificate;
      alreadyPublished: boolean;
      projection?: HumanMemoryProductProjection;
      ordinaryFallbackReason?: HumanMemoryOrdinaryFallbackReason;
      planIssuedAt: number;
      planDeadlineAt: number;
    }>;

export interface HumanMemoryProductCreatePort {
  lookupOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    operationId: string;
    memoryId: string;
    requestDigest: Uint8Array;
  }>): Promise<HumanMemoryOrdinaryFallbackReplay | null>;
  admitOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    authenticated: AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
  }>): Promise<HumanMemoryOrdinaryFallbackAdmission>;
  publishOrdinaryFallbackIntent(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    admission: HumanMemoryOrdinaryFallbackAdmission;
    embedding: HumanMemoryActualEmbedding;
  }>): Promise<HumanMemoryProductProjection>;
  lookupReservation(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    operationId: string;
    memoryId: string;
    operationRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryReservationReplay | null>;
  reserveCreatePlan(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    now: number;
  }>): Promise<Omit<ProtectedMemoryCreatePlanSlotResponseV1, "targetAuthorities">>;
  inspectCreate(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    prepared: PreparedHumanMemoryUpdate;
    operationRequestDigest: Uint8Array;
    now: number;
  }>): Promise<HumanMemoryProductCreateInspection>;
  allocateCreate(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    prepared: PreparedHumanMemoryUpdate;
    operationRequestDigest: Uint8Array;
    now: number;
  }>): Promise<HumanMemoryProductAllocationCertificate>;
  authorizeCurrent(
    authority: HumanMemoryProductCreateAuthority,
    certificate: HumanMemoryProductAllocationCertificate,
  ): Promise<boolean>;
  publish(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    authored: HumanMemoryAuthoredPublication;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
  }>): Promise<HumanMemoryProductProjection>;
  publishOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductCreateAuthority;
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    authored: HumanMemoryAuthoredPublication;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
    reason: HumanMemoryOrdinaryFallbackReason;
  }>): Promise<HumanMemoryProductProjection>;
}

export type HumanMemoryPublicationBoundary = Readonly<{
  fence(input: Readonly<{
    transaction: Parameters<Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]>[0];
    authority: HumanMemoryProductAuthority;
    mutation: boolean;
  }>): Promise<void>;
  withLocks<Result>(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
    certificate: HumanMemoryProductAllocationCertificate;
  }>, publish: (lockCryptoAuthority: () => Promise<void>) => Promise<Result>): Promise<Result>;
  withOrdinaryLocks<Result>(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    authenticatedAuthority: Readonly<{
      subjectHumanId: string;
      committerDeviceId: string;
      committerDeviceSigningKeyGeneration: number;
      hostAuthorizationRevision: number;
      policyRevision: number;
    }>;
  }>, publish: (lockDeviceAuthority: () => Promise<void>) => Promise<Result>): Promise<Result>;
  policyRevision: number;
  representation: "protected_only" | "ordinary_and_protected";
  allowOrdinaryFallback: boolean;
}>;

type HumanMemoryPublicationInput = Readonly<{
  authority: HumanMemoryProductAuthority | HumanMemoryProductCreateAuthority;
  certificate: HumanMemoryProductAllocationCertificate;
  embedding: HumanMemoryActualEmbedding;
  authored: HumanMemoryAuthoredPublication;
  preparedAuthority: HumanMemoryPreparedAuthorityContext;
}>;

type HumanMemoryPublicationOutcome =
  | Readonly<{ kind: "protected" }>
  | Readonly<{
      kind: "ordinary_fallback";
      reason: HumanMemoryOrdinaryFallbackReason;
    }>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validEmbedding(value: HumanMemoryActualEmbedding): boolean {
  return value.dimensions === 1536
    && value.processorContractVersion === 1
    && value.vector.length === 1536
    && value.vector.every(Number.isFinite);
}

function rowString(row: ConversationProductDatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  return value;
}

function rowNullableString(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  return row[name] === null ? null : rowString(row, name);
}

function rowStringArray(
  row: Readonly<Record<string, unknown>>,
  name: string,
): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${name} must be a text array`);
  }
  return value as string[];
}

function ordinaryFallbackReason(operation: ConversationProductDatabaseRow):
HumanMemoryOrdinaryFallbackReason | undefined {
  if (rowString(operation, "completion") !== "ordinary_fallback") return undefined;
  const value = rowNullableString(operation, "ordinary_fallback_reason");
  if (value !== "encryption_pending" && value !== "target_encryption_not_ready") {
    throw new Error("Human Memory ordinary fallback reason is invalid");
  }
  return value;
}

function rowInteger(row: ConversationProductDatabaseRow, name: string): number {
  const raw = row[name];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function rowNumber(row: ConversationProductDatabaseRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function rowBytes(row: ConversationProductDatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be bytea`);
  return value.slice();
}

function rowDate(row: ConversationProductDatabaseRow, name: string): Date {
  const raw = row[name];
  // Drizzle's postgres-js adapter preserves raw timestamps as strings.
  const value = typeof raw === "string" ? new Date(raw) : raw;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a timestamp`);
  }
  return new Date(value);
}

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function parseTextArray(value: unknown, label: string): readonly string[] {
  const parsed: unknown = typeof value === "string"
    ? JSON.parse(value) as unknown
    : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be a text array`);
  }
  return Object.freeze(Array.from(parsed, (entry: unknown) => String(entry)).sort());
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  new DataView(output.buffer).setUint32(0, bytes.length, false);
  output.set(bytes, 4);
  return output;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function humanMemoryAllocationRequestDigest(input: Readonly<{
  operationRequestDigest: Uint8Array;
}>): Uint8Array {
  if (input.operationRequestDigest.length !== 32) {
    throw new TypeError("Human Memory operation request digest is invalid");
  }
  const encoder = new TextEncoder();
  const bytes = concat([
    frame(encoder.encode(DIGEST_DOMAIN)),
    frame(input.operationRequestDigest),
  ]);
  try {
    return Uint8Array.from(sha256(bytes));
  } finally {
    bytes.fill(0);
  }
}

function humanMemoryCreatePlanDigest(input: Readonly<{
  operationId: string;
  memoryId: string;
  authority: HumanMemoryProductCreateAuthority;
  requiredNamespaceIds: readonly string[];
  issuedAt: number;
  deadlineAt: number;
}>): Uint8Array {
  const encoder = new TextEncoder();
  const coordinates = createAuthorityCoordinates(input.authority);
  if (
    coordinates === null
    || coordinates.requiredNamespaceIds.length
      !== input.requiredNamespaceIds.length
    || coordinates.requiredNamespaceIds.some((id, index) =>
      id !== input.requiredNamespaceIds[index]
    )
  ) throw new TypeError("Human Memory create plan authority is invalid");
  const fields = [
    "nautilo/lattice-bridge/human-memory-create-plan/v1",
    input.operationId,
    input.memoryId,
    input.authority.userId,
    coordinates.productAuthority.mode,
    coordinates.productAuthority.mode === "scope"
      ? coordinates.productAuthority.scopeId
      : "",
    coordinates.productAuthority.mode === "scope"
      ? coordinates.productAuthority.originWritableNamespaceId
      : "",
    ...input.requiredNamespaceIds,
    String(input.issuedAt),
    String(input.deadlineAt),
  ].map((value) => frame(encoder.encode(value)));
  const bytes = concat(fields);
  try {
    return Uint8Array.from(sha256(bytes));
  } finally {
    bytes.fill(0);
  }
}

function authorityAllows(
  authority: HumanMemoryProductAuthority,
  required: readonly string[],
): boolean {
  if (
    "memoryMode" in authority
    && authority.memoryMode === "scope"
    && "originWritableNamespaceId" in authority
  ) {
    return typeof authority.originWritableNamespaceId === "string"
      && required.length === 1
      && required[0] === authority.originWritableNamespaceId;
  }
  return required.every((id) =>
    authority.mutableNamespaceIds.includes(id)
    && authority.writableNamespaceIds.includes(id)
  );
}

function mutationAuthorityAllows(
  authority: HumanMemoryProductAuthority,
  required: readonly string[],
): boolean {
  if (
    "memoryMode" in authority
    && authority.memoryMode === "scope"
    && "originWritableNamespaceId" in authority
  ) {
    return typeof authority.originWritableNamespaceId === "string"
      && required.length === 1
      && required[0] === authority.originWritableNamespaceId;
  }
  return required.every((id) => authority.mutableNamespaceIds.includes(id));
}

function canonicalUuidIds(ids: readonly string[]): boolean {
  return ids.length >= 1
    && ids.length <= 256
    && ids.every((id) => UUID.test(id))
    && ids.every((id, index) => index === 0 || ids[index - 1]! < id);
}

function createAuthorityCoordinates(
  authority: HumanMemoryProductCreateAuthority,
): Readonly<{
  productAuthority: ProtectedMemoryCreatePlanSlotResponseV1["productAuthority"];
  requiredNamespaceIds: readonly string[];
}> | null {
  if (authority.memoryMode === "scope") {
    if (
      authority.scopeId === null
      || !UUID.test(authority.scopeId)
      || authority.originWritableNamespaceId === null
      || !UUID.test(authority.originWritableNamespaceId)
    ) return null;
    return Object.freeze({
      productAuthority: Object.freeze({
        mode: "scope" as const,
        scopeId: authority.scopeId,
        originWritableNamespaceId: authority.originWritableNamespaceId,
      }),
      requiredNamespaceIds: Object.freeze([
        authority.originWritableNamespaceId,
      ]),
    });
  }
  if (
    authority.scopeId !== null
    || authority.originWritableNamespaceId !== null
    || authority.writableNamespaceIds.length !== 1
    || !canonicalUuidIds(authority.writableNamespaceIds)
    || !authority.mutableNamespaceIds.includes(authority.writableNamespaceIds[0]!)
  ) return null;
  return Object.freeze({
    productAuthority: Object.freeze({ mode: "namespace" as const }),
    requiredNamespaceIds: Object.freeze([...authority.writableNamespaceIds]),
  });
}

async function loadProduct(
  tx: ConversationProductPostgresTransaction,
  memoryId: string,
): Promise<Readonly<{
  row: ConversationProductDatabaseRow;
  namespaceIds: readonly string[];
  requiredNamespaceIds: readonly string[];
  scopeOrigin: "seed" | "scope" | undefined;
}>> {
  const row = oneOrNull(await tx.query(
    `SELECT m.id AS memory_id, m.creation_key, m.content_revision,
            m.crypto_access_revision,
            m.crypto_object_id, m.crypto_required_namespace_fingerprint,
            m.scope_origin_namespace_id, m.importance, m.tier,
            m.created_at, m.updated_at, m.embedding, m.embedding_revision,
            m.embedding_provider, m.embedding_model,
            m.embedding_dimensions, m.embedding_contract_version,
            COALESCE((SELECT array_to_json(array_agg(mn.namespace_id::text ORDER BY mn.namespace_id::text))::text
                        FROM memory_namespaces mn WHERE mn.memory_id = m.id), '[]') AS namespace_ids,
            COALESCE((SELECT array_to_json(array_agg(ms.origin ORDER BY ms.origin))::text
                        FROM memory_scopes ms WHERE ms.memory_id = m.id), '[]') AS scope_origins
       FROM memories m WHERE m.id = $1 LIMIT 2 FOR UPDATE`,
    [memoryId],
  ), "Human Memory product");
  if (row === null) throw staleRevision("Human Memory product is unavailable");
  const namespaceIds = parseTextArray(row["namespace_ids"], "Memory Namespace set");
  const scopeOrigins = parseTextArray(
    row["scope_origins"],
    "Memory scope origins",
  ) as readonly ("seed" | "scope")[];
  const requiredNamespaceIds = resolveRequiredMemoryNamespaceIds({
    namespaceIds,
    scopeOrigins,
    originWritableNamespaceId: rowNullableString(row, "scope_origin_namespace_id"),
  });
  return Object.freeze({
    row,
    namespaceIds,
    requiredNamespaceIds,
    scopeOrigin: scopeOrigins.includes("scope") ? "scope"
      : scopeOrigins.includes("seed") ? "seed" : undefined,
  });
}

function projectProduct(
  product: Awaited<ReturnType<typeof loadProduct>>,
): HumanMemoryProductProjection {
  return Object.freeze({
    memoryId: rowString(product.row, "memory_id"),
    contentRevision: rowInteger(product.row, "content_revision"),
    cryptoAccessRevision: rowInteger(product.row, "crypto_access_revision"),
    importance: rowNumber(product.row, "importance"),
    tier: rowInteger(product.row, "tier"),
    createdAt: rowDate(product.row, "created_at"),
    updatedAt: rowDate(product.row, "updated_at"),
    namespaceIds: product.namespaceIds,
    requiredNamespaceIds: product.requiredNamespaceIds,
    scopeOrigin: product.scopeOrigin,
  });
}

function parseHumanProductOutcome(value: unknown): HumanMemoryProductProjection {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError("Human Memory product outcome is invalid");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Human Memory product outcome is missing");
  }
  const outcome = value as Partial<HumanMemoryProductOutcomeV1>;
  const namespaceIds = outcome.namespaceIds;
  const requiredNamespaceIds = outcome.requiredNamespaceIds;
  if (outcome.formatVersion !== 1 || typeof outcome.memoryId !== "string"
    || !UUID.test(outcome.memoryId)
    || !Number.isSafeInteger(outcome.contentRevision) || outcome.contentRevision! < 1
    || !Number.isSafeInteger(outcome.cryptoAccessRevision) || outcome.cryptoAccessRevision! < 0
    || typeof outcome.importance !== "number" || !Number.isFinite(outcome.importance)
    || outcome.importance < 0 || outcome.importance > 1
    || typeof outcome.tier !== "number" || ![1, 2, 3].includes(outcome.tier)
    || typeof outcome.createdAt !== "string" || Number.isNaN(Date.parse(outcome.createdAt))
    || typeof outcome.updatedAt !== "string" || Number.isNaN(Date.parse(outcome.updatedAt))
    || !Array.isArray(namespaceIds) || namespaceIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || namespaceIds.some((id, index) => index > 0 && namespaceIds[index - 1]! >= id)
    || !Array.isArray(requiredNamespaceIds) || requiredNamespaceIds.length < 1
    || requiredNamespaceIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || requiredNamespaceIds.some((id, index) => index > 0 && requiredNamespaceIds[index - 1]! >= id)
    || (outcome.scopeOrigin !== null && outcome.scopeOrigin !== "seed"
      && outcome.scopeOrigin !== "scope")) {
    throw new TypeError("Human Memory product outcome is invalid");
  }
  return Object.freeze({
    memoryId: outcome.memoryId,
    contentRevision: outcome.contentRevision!,
    cryptoAccessRevision: outcome.cryptoAccessRevision!,
    importance: outcome.importance,
    tier: outcome.tier,
    createdAt: new Date(outcome.createdAt),
    updatedAt: new Date(outcome.updatedAt),
    namespaceIds: Object.freeze(namespaceIds.map((id: unknown) => {
      if (typeof id !== "string") throw new TypeError("Human Memory outcome Namespace is invalid");
      return id;
    })),
    requiredNamespaceIds: Object.freeze(requiredNamespaceIds.map((id: unknown) => {
      if (typeof id !== "string") throw new TypeError("Human Memory outcome Namespace is invalid");
      return id;
    })),
    scopeOrigin: outcome.scopeOrigin ?? undefined,
  });
}

function humanProductOutcome(
  projection: HumanMemoryProductProjection,
): HumanMemoryProductOutcomeV1 {
  return Object.freeze({
    formatVersion: 1,
    memoryId: projection.memoryId,
    contentRevision: projection.contentRevision,
    cryptoAccessRevision: projection.cryptoAccessRevision,
    importance: projection.importance,
    tier: projection.tier,
    createdAt: projection.createdAt.toISOString(),
    updatedAt: projection.updatedAt.toISOString(),
    namespaceIds: [...projection.namespaceIds],
    requiredNamespaceIds: [...projection.requiredNamespaceIds],
    scopeOrigin: projection.scopeOrigin ?? null,
  });
}

function certificate(input: Readonly<{
  prepared: PreparedHumanMemoryUpdate;
  expectedAccessRevision: number;
  operationRequestDigest: Uint8Array;
  allocationRequestDigest: Uint8Array;
}>): HumanMemoryProductAllocationCertificate {
  return Object.freeze({
    operationId: input.prepared.operationId,
    memoryId: input.prepared.memoryId,
    expectedContentRevision: input.prepared.expectedContentRevision,
    nextContentRevision: input.prepared.nextContentRevision,
    objectId: input.prepared.objectId,
    anchorNamespaceId: input.prepared.requiredNamespaceIds[0]!,
    requiredNamespaceFingerprint: fingerprintRequiredMemoryNamespaces(
      input.prepared.requiredNamespaceIds,
    ),
    expectedAccessRevision: input.expectedAccessRevision,
    operationRequestDigest: input.operationRequestDigest.slice(),
    allocationRequestDigest: input.allocationRequestDigest.slice(),
  });
}

export class PostgresHumanMemoryProductUpdate
  implements HumanMemoryProductUpdatePort, HumanMemoryProductCreatePort {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #canonicalRunner: ConversationProductCanonicalTransactionRunner;
  readonly #publication: HumanMemoryPublicationBoundary;
  readonly #createMemoryId: () => string;
  readonly #createOperationId: () => string;
  readonly #createPlanTtlMs: number;

  constructor(
    handle: ConversationProductPostgresHandle,
    options: Readonly<{
      canonicalRunner: ConversationProductCanonicalTransactionRunner;
      publication: HumanMemoryPublicationBoundary;
      createMemoryId?: () => string;
      createOperationId?: () => string;
      createPlanTtlMs?: number;
    }>,
  ) {
    assertVerifiedConversationProductPostgresHandle(handle);
    assertConversationProductCanonicalTransactionRunner(
      handle,
      options.canonicalRunner,
    );
    if (handle.role !== "nautilo") {
      throw new TypeError("Human Memory product updates require the nautilo role");
    }
    this.#handle = handle;
    this.#canonicalRunner = options.canonicalRunner;
    this.#publication = options.publication;
    if (typeof options.publication?.fence !== "function"
      || typeof options.publication.withLocks !== "function") {
      throw new TypeError("Human Memory publication guard is required");
    }
    this.#createMemoryId = options.createMemoryId ?? randomUUID;
    this.#createOperationId = options.createOperationId
      ?? (() => `human-memory-create:${randomUUID()}`);
    this.#createPlanTtlMs = options.createPlanTtlMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#createPlanTtlMs)
      || this.#createPlanTtlMs < 1
      || this.#createPlanTtlMs > 300_000
    ) throw new TypeError("Human Memory create-plan TTL is invalid");
  }

  #transaction<Result>(authority: HumanMemoryProductAuthority, callback: (
    tx: ConversationProductPostgresTransaction,
  ) => Promise<Result>): Promise<Result> {
    return this.#handle.transaction(async (transaction) => {
      await this.#assertTransactionAuthority(transaction, authority);
      return callback(transaction);
    }, { isolationLevel: "serializable" });
  }

  async #assertTransactionAuthority(
    transaction: ConversationProductPostgresTransaction,
    authority: HumanMemoryProductAuthority,
  ): Promise<void> {
    const identity = oneOrNull(await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.select({
        current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
        current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
      }).from(sql`(values (1)) as identity_probe`).limit(2),
    ), "Human Memory transaction identity");
    if (
      identity === null
      || rowNullableString(identity, "current_user_id") !== authority.userId
      || rowNullableString(identity, "current_agent_id") !== null
    ) throw humanMemoryPreparedAuthorizationError(
      "Human Memory transaction authority changed",
    );
  }

  lookupReservation(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    operationId: string;
    memoryId: string;
    operationRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryReservationReplay | null> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.memoryId)
      || input.operationRequestDigest.length !== 32) return Promise.resolve(null);
    return this.#transaction(input.authority, async (tx) => {
      const row = oneOrNull(await tx.query(
        `SELECT operation_id, memory_id, request_digest, completion, disposition,
                expected_content_revision, result_content_revision,
                human_product_outcome
           FROM memory_crypto_operations
          WHERE operation_id = $1 AND memory_id = $2 LIMIT 2 FOR UPDATE`,
        [input.operationId, input.memoryId]), "Human Memory reservation replay");
      if (row === null) return null;
      const createReservation = rowInteger(row, "expected_content_revision") === 0
        && rowInteger(row, "result_content_revision") === 1;
      let requestMatches: boolean;
      if (createReservation) {
        const allocation = oneOrNull(await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.select({
            allocation_request_digest:
              memoryCryptoRevisions.allocationRequestDigest,
          }).from(memoryCryptoRevisions).where(and(
            eq(memoryCryptoRevisions.memoryId, input.memoryId),
            eq(memoryCryptoRevisions.contentRevision, 1),
          )).limit(2).for("update", { of: memoryCryptoRevisions }),
        ), "Human Memory create reservation allocation");
        const allocationDigest = humanMemoryAllocationRequestDigest(input);
        try {
          requestMatches = allocation !== null && bytesEqual(
            rowBytes(allocation, "allocation_request_digest"), allocationDigest,
          );
        } finally {
          allocationDigest.fill(0);
        }
      } else {
        requestMatches = bytesEqual(
          rowBytes(row, "request_digest"), input.operationRequestDigest,
        );
      }
      if (!requestMatches
        || !((rowString(row, "completion") === "pending"
              && rowString(row, "disposition") === "active")
          || (["complete", "ordinary_fallback"].includes(rowString(row, "completion"))
              && rowString(row, "disposition") === "complete"))) {
        return null;
      }
      const admission = createHumanMemoryReservedReplayAdmission(input);
      if (rowString(row, "completion") === "pending") {
        return Object.freeze({ admission });
      }
      const projection = parseHumanProductOutcome(row["human_product_outcome"]);
      if (projection.memoryId !== input.memoryId
        || projection.contentRevision !== rowInteger(row, "result_content_revision")
        || !(createReservation ? authorityAllows : mutationAuthorityAllows)(
          input.authority, projection.requiredNamespaceIds,
        )) return null;
      return Object.freeze({ admission,
        completedProjection: projection });
    });
  }

  async lookupOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority;
    operationId: string;
    memoryId: string;
    requestDigest: Uint8Array;
  }>): Promise<HumanMemoryOrdinaryFallbackReplay | null> {
    if (!PORTABLE_ID.test(input.operationId) || !UUID.test(input.memoryId)
      || input.requestDigest.length !== 32) return null;
    return this.#transaction(input.authority, async (tx) => {
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          foreground_stable_request_digest:
            memoryCryptoOperations.foregroundStableRequestDigest,
          foreground_required_namespace_ids:
            memoryCryptoOperations.foregroundRequiredNamespaceIds,
          foreground_mutation_kind:
            memoryCryptoOperations.foregroundMutationKind,
          completion: memoryCryptoOperations.completion,
          disposition: memoryCryptoOperations.disposition,
          ordinary_fallback_reason: memoryCryptoOperations.ordinaryFallbackReason,
          human_product_outcome: memoryCryptoOperations.humanProductOutcome,
        }).from(memoryCryptoOperations).where(and(
          eq(memoryCryptoOperations.operationId, input.operationId),
          eq(memoryCryptoOperations.memoryId, input.memoryId),
        )).limit(2).for("update", { of: memoryCryptoOperations }));
      if (rows.length > 1) {
        throw new Error("Human Memory ordinary fallback replay returned duplicate rows");
      }
      const row = rows[0];
      if (row === undefined || row.foreground_stable_request_digest === null
        || !bytesEqual(row.foreground_stable_request_digest,
          input.requestDigest)) return null;
      const required = row.foreground_required_namespace_ids;
      if (required === null) return null;
      if (row.foreground_mutation_kind !== "save"
        && row.foreground_mutation_kind !== "replace") return null;
      const replayIsCreate = row.foreground_mutation_kind === "save";
      if (!(replayIsCreate ? authorityAllows : mutationAuthorityAllows)(
        input.authority, required,
      )) return null;
      const replayAdmission =
        createHumanMemoryOrdinaryFallbackReplayAdmissionV1(input);
      if (row.completion === "ordinary_fallback"
        && row.disposition === "complete") {
        if (row.ordinary_fallback_reason !== "target_encryption_not_ready") {
          throw new TypeError("Human Memory ordinary replay reason is invalid");
        }
        return Object.freeze({ replayAdmission, completed: Object.freeze({
          projection: parseHumanProductOutcome(row["human_product_outcome"]),
          reason: row.ordinary_fallback_reason,
        }) });
      }
      return row.completion === "pending" && row.disposition === "active"
        ? Object.freeze({ replayAdmission }) : null;
    });
  }

  async admitOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority | HumanMemoryProductCreateAuthority;
    authenticated: AuthenticatedHumanMemoryOrdinaryFallbackRequestV1;
  }>): Promise<HumanMemoryOrdinaryFallbackAdmission> {
    const { request, requestDigest } = input.authenticated;
    const create = request.purpose === "memory.ordinary_fallback.create";
    if (!this.#publication.allowOrdinaryFallback
      || this.#publication.representation !== "ordinary_and_protected"
      || request.policyRevision !== this.#publication.policyRevision
      || requestDigest.length !== 32
      || !(create ? authorityAllows : mutationAuthorityAllows)(
        input.authority, request.requiredNamespaceIds,
      )) {
      throw humanMemoryPreparedAuthorizationError(
        "Human Memory ordinary fallback authority is incomplete",
      );
    }
    const authenticatedAuthority = {
      subjectHumanId: request.subjectHumanId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
      policyRevision: request.policyRevision,
    };
    return this.#publication.withOrdinaryLocks({ authority: input.authority,
      authenticatedAuthority }, (lockDeviceAuthority) =>
      this.#canonicalRunner.transaction(async (canonical, tx) => {
      await this.#assertTransactionAuthority(tx, input.authority);
      await this.#publication.fence({ transaction: canonical,
        authority: input.authority, mutation: true });
      await lockDeviceAuthority();
      const existing = oneOrNull(await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          operation_id: memoryCryptoOperations.operationId,
          memory_id: memoryCryptoOperations.memoryId,
          anchor_namespace_id: memoryCryptoOperations.anchorNamespaceId,
          expected_content_revision:
            memoryCryptoOperations.expectedContentRevision,
          result_content_revision: memoryCryptoOperations.resultContentRevision,
          expected_access_revision: memoryCryptoOperations.expectedAccessRevision,
          request_digest: memoryCryptoOperations.requestDigest,
          completion: memoryCryptoOperations.completion,
          disposition: memoryCryptoOperations.disposition,
          created_at: memoryCryptoOperations.createdAt,
          foreground_stable_request_digest:
            memoryCryptoOperations.foregroundStableRequestDigest,
          foreground_mutation_kind: memoryCryptoOperations.foregroundMutationKind,
          foreground_required_namespace_ids:
            memoryCryptoOperations.foregroundRequiredNamespaceIds,
        }).from(memoryCryptoOperations).where(eq(
          memoryCryptoOperations.operationId, request.operationId,
        )).limit(2).for("update", { of: memoryCryptoOperations })),
      "Human Memory ordinary admission");
      if (existing !== null
        && existing["foreground_stable_request_digest"] !== null) {
        if (rowString(existing, "memory_id") !== request.memoryId
          || rowInteger(existing, "expected_content_revision")
            !== request.expectedContentRevision
          || rowInteger(existing, "result_content_revision")
            !== request.nextContentRevision
          || rowInteger(existing, "expected_access_revision")
            !== request.expectedCryptoAccessRevision
          || rowString(existing, "foreground_mutation_kind")
            !== (create ? "save" : "replace")
          || !bytesEqual(rowBytes(existing, "foreground_stable_request_digest"),
            requestDigest)
          || !sameIds(rowStringArray(existing,
            "foreground_required_namespace_ids"), request.requiredNamespaceIds)) {
          throw humanMemoryPreparedIntegrityError(
            "Human Memory ordinary replay conflicts",
          );
        }
        if (rowString(existing, "completion") !== "pending"
          || rowString(existing, "disposition") !== "active") {
          throw staleRevision("Human Memory ordinary admission is stale");
        }
        return Object.freeze({ authenticated: input.authenticated,
          expectedAccessRevision: request.expectedCryptoAccessRevision });
      }
      if (create) {
        if (existing === null || !("memoryMode" in input.authority)
          || request.planIssuedAt === null || request.planDeadlineAt === null) {
          throw staleRevision("Human Memory ordinary create plan is unavailable");
        }
        const planDigest = humanMemoryCreatePlanDigest({
          operationId: request.operationId, memoryId: request.memoryId,
          authority: input.authority,
          requiredNamespaceIds: request.requiredNamespaceIds,
          issuedAt: request.planIssuedAt, deadlineAt: request.planDeadlineAt,
        });
        const matches = rowString(existing, "memory_id") === request.memoryId
          && rowInteger(existing, "expected_content_revision") === 0
          && rowInteger(existing, "result_content_revision") === 1
          && rowInteger(existing, "expected_access_revision") === 0
          && rowString(existing, "completion") === "pending"
          && rowString(existing, "disposition") === "blocked"
          && rowDate(existing, "created_at").getTime() === request.planIssuedAt
          && bytesEqual(rowBytes(existing, "request_digest"), planDigest);
        planDigest.fill(0);
        if (!matches) throw humanMemoryPreparedIntegrityError(
          "Human Memory ordinary create plan conflicts",
        );
        const activated = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.update(memoryCryptoOperations).set({
            foregroundStableRequestDigest: requestDigest,
            foregroundMutationKind: "save",
            foregroundRequiredNamespaceIds: [...request.requiredNamespaceIds],
            disposition: "active", updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memoryCryptoOperations.operationId, request.operationId),
            eq(memoryCryptoOperations.completion, "pending"),
            eq(memoryCryptoOperations.disposition, "blocked"),
          )).returning({ sequence: memoryCryptoOperations.sequence }));
        if (activated.length !== 1) throw staleRevision(
          "Human Memory ordinary create admission lost its CAS",
        );
      } else {
        if (existing !== null) throw humanMemoryPreparedIntegrityError(
          "Human Memory ordinary update operation conflicts",
        );
        const product = await loadProduct(tx, request.memoryId);
        if (rowInteger(product.row, "content_revision")
            !== request.expectedContentRevision
          || rowInteger(product.row, "crypto_access_revision")
            !== request.expectedCryptoAccessRevision
          || !sameIds(product.requiredNamespaceIds,
            request.requiredNamespaceIds)) {
          throw staleRevision("Human Memory ordinary update is stale");
        }
        await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.insert(memoryCryptoOperations).values({
            operationId: request.operationId, memoryId: request.memoryId,
            anchorNamespaceId: request.requiredNamespaceIds[0]!,
            operationType: "update",
            expectedContentRevision: request.expectedContentRevision,
            resultContentRevision: request.nextContentRevision,
            expectedAccessRevision: request.expectedCryptoAccessRevision,
            requestDigest, foregroundStableRequestDigest: requestDigest,
            foregroundMutationKind: "replace",
            foregroundRequiredNamespaceIds: [...request.requiredNamespaceIds],
            disposition: "active",
          }));
      }
      return Object.freeze({ authenticated: input.authenticated,
        expectedAccessRevision: request.expectedCryptoAccessRevision });
    }, { isolationLevel: "serializable" }));
  }

  async reserveCreatePlan(
    input: Parameters<HumanMemoryProductCreatePort["reserveCreatePlan"]>[0],
  ): ReturnType<HumanMemoryProductCreatePort["reserveCreatePlan"]> {
    const coordinates = createAuthorityCoordinates(input.authority);
    if (
      coordinates === null
      || !Number.isSafeInteger(input.now)
      || input.now < 0
    ) throw humanMemoryPreparedAuthorizationError(
      "Human Memory create authority is incomplete",
    );
    const memoryId = this.#createMemoryId();
    const operationId = this.#createOperationId();
    if (!UUID.test(memoryId) || !PORTABLE_ID.test(operationId)) {
      throw new TypeError("Human Memory create identifiers are invalid");
    }
    const deadlineAt = input.now + this.#createPlanTtlMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new TypeError("Human Memory create deadline is invalid");
    }
    const planDigest = humanMemoryCreatePlanDigest({
      operationId,
      memoryId,
      authority: input.authority,
      requiredNamespaceIds: coordinates.requiredNamespaceIds,
      issuedAt: input.now,
      deadlineAt,
    });
    try {
      await this.#transaction(input.authority, async (tx) => {
        await executeTypedConversationProductQuery(
          tx,
          conversationProductTypedDb.insert(memoryCryptoOperations).values({
            operationId,
            memoryId,
            anchorNamespaceId: coordinates.requiredNamespaceIds[0]!,
            operationType: "update",
            expectedContentRevision: 0,
            resultContentRevision: 1,
            expectedAccessRevision: 0,
            requestDigest: planDigest,
            completion: "pending",
            disposition: "blocked",
            nextAttemptAt: null,
            createdAt: new Date(input.now),
            updatedAt: new Date(input.now),
          }),
        );
      });
    } finally {
      planDigest.fill(0);
    }
    return Object.freeze({
      dtoVersion: 1 as const,
      memoryId,
      operationId,
      expectedContentRevision: 0 as const,
      nextContentRevision: 1 as const,
      productAuthority: coordinates.productAuthority,
      requiredNamespaceIds: [...coordinates.requiredNamespaceIds],
      issuedAt: input.now,
      deadlineAt,
    });
  }

  async inspectCreate(
    input: Parameters<HumanMemoryProductCreatePort["inspectCreate"]>[0],
  ): ReturnType<HumanMemoryProductCreatePort["inspectCreate"]> {
    const coordinates = createAuthorityCoordinates(input.authority);
    if (coordinates === null) {
      throw humanMemoryPreparedAuthorizationError(
        "Human Memory create authority is incomplete",
      );
    }
    return this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `SELECT operation_id, memory_id, anchor_namespace_id, operation_type,
                expected_content_revision, result_content_revision,
                expected_access_revision, request_digest, completion,
                disposition, created_at, human_product_outcome,
                ordinary_fallback_reason
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.prepared.operationId],
      ), "Human Memory create operation");
      if (operation === null) {
        throw staleRevision("Human Memory create plan is unavailable or expired");
      }
      const issuedAt = rowDate(operation, "created_at").getTime();
      const deadlineAt = issuedAt + this.#createPlanTtlMs;
      const expectedPlanDigest = humanMemoryCreatePlanDigest({
        operationId: input.prepared.operationId,
        memoryId: input.prepared.memoryId,
        authority: input.authority,
        requiredNamespaceIds: input.prepared.requiredNamespaceIds,
        issuedAt,
        deadlineAt,
      });
      const disposition = rowString(operation, "disposition");
      let planMatches: boolean;
      try {
        planMatches = rowString(operation, "memory_id")
            === input.prepared.memoryId
          && rowString(operation, "anchor_namespace_id")
            === input.prepared.requiredNamespaceIds[0]
          && rowString(operation, "operation_type") === "update"
          && rowInteger(operation, "expected_content_revision") === 0
          && rowInteger(operation, "result_content_revision") === 1
          && bytesEqual(rowBytes(operation, "request_digest"), expectedPlanDigest);
      } finally {
        expectedPlanDigest.fill(0);
      }
      if (!planMatches) throw humanMemoryPreparedIntegrityError(
        "Human Memory create replay conflicts",
      );
      if (disposition === "blocked") {
        const product = oneOrNull(await tx.query(
          "SELECT id FROM memories WHERE id = $1 LIMIT 2 FOR UPDATE",
          [input.prepared.memoryId],
        ), "Human Memory unallocated create product");
        if (input.now > deadlineAt || product !== null) {
          throw staleRevision("Human Memory create plan is unavailable or expired");
        }
        return Object.freeze({
          kind: "new" as const,
          expectedAccessRevision: 0 as const,
          planIssuedAt: issuedAt,
          planDeadlineAt: deadlineAt,
        });
      }
      if (disposition !== "active" && disposition !== "complete") {
        throw humanMemoryPreparedIntegrityError(
          "Human Memory create operation lifecycle conflicts",
        );
      }
      const allocation = oneOrNull(await tx.query(
        `SELECT crypto_object_id, allocation_request_digest,
                required_namespace_fingerprint
           FROM memory_crypto_revisions
          WHERE memory_id = $1 AND content_revision = 1
          LIMIT 2 FOR UPDATE`,
        [input.prepared.memoryId],
      ), "Human Memory create allocation");
      if (allocation === null) {
        throw humanMemoryPreparedIntegrityError(
          "Human Memory create replay allocation is missing",
        );
      }
      const allocationDigest = humanMemoryAllocationRequestDigest({
        operationRequestDigest: input.operationRequestDigest,
      });
      const fingerprint = fingerprintRequiredMemoryNamespaces(
        input.prepared.requiredNamespaceIds,
      );
      if (
        rowString(allocation, "crypto_object_id") !== input.prepared.objectId
        || !bytesEqual(
          rowBytes(allocation, "required_namespace_fingerprint"),
          fingerprint,
        )
        || !bytesEqual(
          rowBytes(allocation, "allocation_request_digest"),
          allocationDigest,
        )
      ) throw humanMemoryPreparedIntegrityError(
        "Human Memory create replay allocation conflicts",
      );
      if (disposition === "active") {
        return Object.freeze({
          kind: "replay" as const,
          certificate: certificate({
            prepared: input.prepared,
            expectedAccessRevision: 0,
            operationRequestDigest: input.operationRequestDigest,
            allocationRequestDigest: allocationDigest,
          }),
          alreadyPublished: false,
          planIssuedAt: issuedAt,
          planDeadlineAt: deadlineAt,
        });
      }
      const projection = parseHumanProductOutcome(operation["human_product_outcome"]);
      const fallbackReason = ordinaryFallbackReason(operation);
      if (
        projection.memoryId !== input.prepared.memoryId
        || projection.contentRevision !== 1
        || projection.requiredNamespaceIds.length !== coordinates.requiredNamespaceIds.length
        || projection.requiredNamespaceIds.some((id, index) =>
          id !== coordinates.requiredNamespaceIds[index]
          || id !== input.prepared.requiredNamespaceIds[index]
        )
      ) throw humanMemoryPreparedIntegrityError(
        "Human Memory create replay publication conflicts",
      );
      return Object.freeze({
        kind: "replay" as const,
        certificate: certificate({
          prepared: input.prepared,
          expectedAccessRevision: 0,
          operationRequestDigest: input.operationRequestDigest,
          allocationRequestDigest: allocationDigest,
        }),
        alreadyPublished: ["complete", "ordinary_fallback"]
          .includes(rowString(operation, "completion")),
        projection,
        ...(fallbackReason === undefined ? {} : {
          ordinaryFallbackReason: fallbackReason,
        }),
        planIssuedAt: issuedAt,
        planDeadlineAt: deadlineAt,
      });
    });
  }

  async allocateCreate(
    input: Parameters<HumanMemoryProductCreatePort["allocateCreate"]>[0],
  ): ReturnType<HumanMemoryProductCreatePort["allocateCreate"]> {
    const coordinates = createAuthorityCoordinates(input.authority);
    if (coordinates === null) {
      throw humanMemoryPreparedAuthorizationError(
        "Human Memory create authority is incomplete",
      );
    }
    const allocationDigest = humanMemoryAllocationRequestDigest(input);
    return this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        `SELECT operation_id, memory_id, anchor_namespace_id, operation_type,
                expected_content_revision, result_content_revision,
                expected_access_revision, request_digest, completion,
                disposition, created_at
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.prepared.operationId],
      ), "Human Memory create allocation operation");
      if (operation === null) {
        throw staleRevision("Human Memory create allocation plan is missing");
      }
      const issuedAt = rowDate(operation, "created_at").getTime();
      const deadlineAt = issuedAt + this.#createPlanTtlMs;
      const expectedPlanDigest = humanMemoryCreatePlanDigest({
        operationId: input.prepared.operationId,
        memoryId: input.prepared.memoryId,
        authority: input.authority,
        requiredNamespaceIds: input.prepared.requiredNamespaceIds,
        issuedAt,
        deadlineAt,
      });
      let reservationMatches: boolean;
      try {
        reservationMatches = input.now <= deadlineAt
          && rowString(operation, "memory_id") === input.prepared.memoryId
          && rowString(operation, "anchor_namespace_id")
            === input.prepared.requiredNamespaceIds[0]
          && rowString(operation, "operation_type") === "update"
          && rowInteger(operation, "expected_content_revision") === 0
          && rowInteger(operation, "result_content_revision") === 1
          && rowInteger(operation, "expected_access_revision") === 0
          && rowString(operation, "completion") === "pending"
          && rowString(operation, "disposition") === "blocked"
          && bytesEqual(
            rowBytes(operation, "request_digest"),
            expectedPlanDigest,
          );
      } finally {
        expectedPlanDigest.fill(0);
      }
      if (!reservationMatches) {
        throw staleRevision(
          "Human Memory create allocation authority became stale",
        );
      }
      const existing = oneOrNull(await tx.query(
        "SELECT id FROM memories WHERE id = $1 LIMIT 2 FOR UPDATE",
        [input.prepared.memoryId],
      ), "Human Memory create product");
      if (existing !== null) {
        throw staleRevision("Human Memory create product raced a replay");
      }
      const fingerprint = fingerprintRequiredMemoryNamespaces(
        input.prepared.requiredNamespaceIds,
      );
      await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(memoryCryptoRevisions).values({
          memoryId: input.prepared.memoryId,
          contentRevision: 1,
          anchorNamespaceId: input.prepared.requiredNamespaceIds[0]!,
          cryptoObjectId: input.prepared.objectId,
          payloadVersion: 1,
          allocationRequestDigest: allocationDigest,
          requiredNamespaceFingerprint: fingerprint,
        }),
      );
      const activated = await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.update(memoryCryptoOperations).set({
          disposition: "active",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(
          eq(memoryCryptoOperations.operationId, input.prepared.operationId),
          eq(memoryCryptoOperations.memoryId, input.prepared.memoryId),
          eq(memoryCryptoOperations.completion, "pending"),
          eq(memoryCryptoOperations.disposition, "blocked"),
        )).returning({ sequence: memoryCryptoOperations.sequence }),
      );
      if (activated.length !== 1) {
        throw staleRevision(
          "Human Memory create reservation activation lost its CAS",
        );
      }
      return certificate({
        prepared: input.prepared,
        expectedAccessRevision: 0,
        operationRequestDigest: input.operationRequestDigest,
        allocationRequestDigest: allocationDigest,
      });
    });
  }

  async inspect(input: Parameters<HumanMemoryProductUpdatePort["inspect"]>[0]) {
    return this.#transaction(input.authority, async (tx): Promise<HumanMemoryProductInspection> => {
      const operation = oneOrNull(await tx.query(
        `SELECT operation_id, memory_id, operation_type,
                expected_content_revision, result_content_revision,
                expected_access_revision, request_digest, completion,
                disposition, human_product_outcome, ordinary_fallback_reason
           FROM memory_crypto_operations
          WHERE operation_id = $1 LIMIT 2 FOR UPDATE`,
        [input.prepared.operationId],
      ), "Human Memory operation");
      if (operation === null) {
        const product = await loadProduct(tx, input.prepared.memoryId);
        if (!mutationAuthorityAllows(input.authority, product.requiredNamespaceIds)) {
          throw humanMemoryPreparedAuthorizationError(
            "Human Memory product authority is incomplete",
          );
        }
        if (
          rowInteger(product.row, "content_revision")
            !== input.prepared.expectedContentRevision
          || rowInteger(product.row, "crypto_access_revision") < 0
          || !bytesEqual(
            rowBytes(product.row, "crypto_required_namespace_fingerprint"),
            fingerprintRequiredMemoryNamespaces(product.requiredNamespaceIds),
          )
          || rowString(product.row, "crypto_object_id")
            !== deriveMemoryCryptoObjectIdV1({
              memoryId: input.prepared.memoryId,
              contentRevision: input.prepared.expectedContentRevision,
            })
          || product.requiredNamespaceIds.length
            !== input.prepared.requiredNamespaceIds.length
          || product.requiredNamespaceIds.some((id, index) =>
            id !== input.prepared.requiredNamespaceIds[index]
          )
        ) throw staleRevision("Human Memory product revision is stale");
        return Object.freeze({
          kind: "new" as const,
          expectedAccessRevision: rowInteger(
            product.row,
            "crypto_access_revision",
          ),
        });
      }
      if (
        rowString(operation, "memory_id") !== input.prepared.memoryId
        || rowString(operation, "operation_type") !== "update"
        || rowInteger(operation, "expected_content_revision")
          !== input.prepared.expectedContentRevision
        || rowInteger(operation, "result_content_revision")
          !== input.prepared.nextContentRevision
        || !bytesEqual(rowBytes(operation, "request_digest"), input.operationRequestDigest)
      ) throw humanMemoryPreparedIntegrityError(
        "Human Memory operation replay conflicts",
      );
      const allocation = oneOrNull(await tx.query(
        `SELECT crypto_object_id, allocation_request_digest,
                required_namespace_fingerprint, completion
           FROM memory_crypto_revisions
          WHERE memory_id = $1 AND content_revision = $2 LIMIT 2 FOR UPDATE`,
        [input.prepared.memoryId, input.prepared.nextContentRevision],
      ), "Human Memory allocation");
      if (allocation === null) throw humanMemoryPreparedIntegrityError(
        "Human Memory replay allocation is missing",
      );
      const allocationDigest = humanMemoryAllocationRequestDigest({
        operationRequestDigest: input.operationRequestDigest,
      });
      if (
        rowString(allocation, "crypto_object_id") !== input.prepared.objectId
        || !bytesEqual(
          rowBytes(allocation, "required_namespace_fingerprint"),
          fingerprintRequiredMemoryNamespaces(input.prepared.requiredNamespaceIds),
        )
        || !bytesEqual(
          rowBytes(allocation, "allocation_request_digest"),
          allocationDigest,
        )
      ) throw humanMemoryPreparedIntegrityError(
        "Human Memory replay allocation conflicts",
      );
      const operationComplete = ["complete", "ordinary_fallback"]
        .includes(rowString(operation, "completion"));
      if (!operationComplete && rowString(operation, "disposition") !== "active") {
        throw staleRevision("Human Memory pending reservation is inactive");
      }
      if (operationComplete) {
        const projection = parseHumanProductOutcome(operation["human_product_outcome"]);
        const fallbackReason = ordinaryFallbackReason(operation);
        if (projection.memoryId !== input.prepared.memoryId
          || projection.contentRevision !== input.prepared.nextContentRevision
          || !mutationAuthorityAllows(input.authority, projection.requiredNamespaceIds)
          || projection.requiredNamespaceIds.length !== input.prepared.requiredNamespaceIds.length
          || projection.requiredNamespaceIds.some((id, index) =>
            id !== input.prepared.requiredNamespaceIds[index])) {
          throw humanMemoryPreparedIntegrityError(
            "Human Memory replay publication state conflicts",
          );
        }
        return Object.freeze({
          kind: "replay" as const,
          certificate: certificate({
            prepared: input.prepared,
            expectedAccessRevision: rowInteger(operation, "expected_access_revision"),
            operationRequestDigest: input.operationRequestDigest,
            allocationRequestDigest: allocationDigest,
          }),
          alreadyPublished: true,
          projection,
          ...(fallbackReason === undefined ? {} : {
            ordinaryFallbackReason: fallbackReason,
          }),
        });
      }
      const product = await loadProduct(tx, input.prepared.memoryId);
      if (!mutationAuthorityAllows(input.authority, product.requiredNamespaceIds)) {
        throw humanMemoryPreparedAuthorizationError(
          "Human Memory product authority is incomplete",
        );
      }
      if (
        rowInteger(product.row, "content_revision")
          !== input.prepared.expectedContentRevision
        || product.requiredNamespaceIds.length
          !== input.prepared.requiredNamespaceIds.length
        || product.requiredNamespaceIds.some((id, index) =>
          id !== input.prepared.requiredNamespaceIds[index])
      ) throw humanMemoryPreparedIntegrityError(
        "Human Memory replay publication state conflicts",
      );
      return Object.freeze({
        kind: "replay" as const,
        certificate: certificate({
          prepared: input.prepared,
          expectedAccessRevision: rowInteger(operation, "expected_access_revision"),
          operationRequestDigest: input.operationRequestDigest,
          allocationRequestDigest: allocationDigest,
        }),
        alreadyPublished: false,
      });
    });
  }

  async allocate(input: Parameters<HumanMemoryProductUpdatePort["allocate"]>[0]) {
    const allocationDigest = humanMemoryAllocationRequestDigest(input);
    return this.#transaction(input.authority, async (tx) => {
      const operation = oneOrNull(await tx.query(
        "SELECT operation_id FROM memory_crypto_operations WHERE operation_id = $1 LIMIT 2 FOR UPDATE",
        [input.prepared.operationId],
      ), "Human Memory new operation");
      if (operation !== null) throw staleRevision(
        "Human Memory allocation raced a replay",
      );
      const product = await loadProduct(tx, input.prepared.memoryId);
      const fingerprint = fingerprintRequiredMemoryNamespaces(
        input.prepared.requiredNamespaceIds,
      );
      if (
        !mutationAuthorityAllows(input.authority, product.requiredNamespaceIds)
        || rowInteger(product.row, "content_revision")
          !== input.prepared.expectedContentRevision
        || rowString(product.row, "crypto_object_id")
          !== deriveMemoryCryptoObjectIdV1({
            memoryId: input.prepared.memoryId,
            contentRevision: input.prepared.expectedContentRevision,
          })
        || !bytesEqual(
          rowBytes(product.row, "crypto_required_namespace_fingerprint"),
          fingerprintRequiredMemoryNamespaces(product.requiredNamespaceIds),
        )
        || product.requiredNamespaceIds.length
          !== input.prepared.requiredNamespaceIds.length
        || product.requiredNamespaceIds.some((id, index) =>
          id !== input.prepared.requiredNamespaceIds[index]
        )
      ) throw staleRevision("Human Memory allocation authority became stale");
      const expectedAccessRevision = rowInteger(
        product.row,
        "crypto_access_revision",
      );
      await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(memoryCryptoOperations).values({
          operationId: input.prepared.operationId,
          memoryId: input.prepared.memoryId,
          anchorNamespaceId: input.prepared.requiredNamespaceIds[0]!,
          operationType: "update",
          expectedContentRevision: input.prepared.expectedContentRevision,
          resultContentRevision: input.prepared.nextContentRevision,
          expectedAccessRevision,
          requestDigest: input.operationRequestDigest,
          disposition: "active",
        }),
      );
      await executeTypedConversationProductQuery(
        tx,
        conversationProductTypedDb.insert(memoryCryptoRevisions).values({
          memoryId: input.prepared.memoryId,
          contentRevision: input.prepared.nextContentRevision,
          anchorNamespaceId: input.prepared.requiredNamespaceIds[0]!,
          cryptoObjectId: input.prepared.objectId,
          payloadVersion: 1,
          allocationRequestDigest: allocationDigest,
          requiredNamespaceFingerprint: fingerprint,
        }),
      );
      return certificate({
        prepared: input.prepared,
        expectedAccessRevision,
        operationRequestDigest: input.operationRequestDigest,
        allocationRequestDigest: allocationDigest,
      });
    });
  }

  async authorizeCurrent(
    authority: HumanMemoryProductAuthority,
    value: HumanMemoryProductAllocationCertificate,
  ): Promise<boolean> {
    return this.#transaction(authority,
      (tx) => this.#authorizeInTransaction(tx, authority, value));
  }

  async publish(
    input: HumanMemoryPublicationInput,
  ): Promise<HumanMemoryProductProjection> {
    return this.#publishOutcome(input, { kind: "protected" });
  }

  async #mutateProduct(
    tx: ConversationProductPostgresTransaction,
    input: Readonly<{
      authority: HumanMemoryProductAuthority | HumanMemoryProductCreateAuthority;
      memoryId: string;
      operationId: string;
      expectedContentRevision: number;
      nextContentRevision: number;
      expectedAccessRevision: number;
      requiredNamespaceIds?: readonly string[];
      authored: HumanMemoryAuthoredPublication;
      embedding: HumanMemoryActualEmbedding;
      retainOrdinary: boolean;
      resetAccessRevision: boolean;
      priorMapping: "required" | "if-present";
      isCreate: boolean;
    }>,
  ): Promise<void> {
    if (input.isCreate) {
      if (!("memoryMode" in input.authority)) {
        throw humanMemoryPreparedAuthorizationError(
          "Human Memory create authority is stale",
        );
      }
      const coordinates = createAuthorityCoordinates(input.authority);
      if (coordinates === null
        || (input.requiredNamespaceIds !== undefined
          && !sameIds(coordinates.requiredNamespaceIds,
            input.requiredNamespaceIds))) {
        throw humanMemoryPreparedAuthorizationError(
          "Human Memory create authority is stale",
        );
      }
      await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.insert(memories).values({
          id: input.memoryId, tier: 1,
          type: input.retainOrdinary ? input.authored.type : null,
          content: input.retainOrdinary ? input.authored.content : null,
          importance: input.authored.importance ?? 0.5,
          embedding: [...input.embedding.vector], creationKey: input.operationId,
          contentRevision: 1, cryptoAccessRevision: 0,
          embeddingRevision: 1, embeddingProvider: input.embedding.provider,
          embeddingModel: input.embedding.canonicalModel,
          embeddingDimensions: input.embedding.dimensions,
          embeddingContractVersion: input.embedding.processorContractVersion,
          scopeOriginNamespaceId: coordinates.productAuthority.mode === "scope"
            ? coordinates.productAuthority.originWritableNamespaceId : null,
        }));
      if (coordinates.productAuthority.mode === "scope") {
        await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.insert(memoryScopes).values({
            memoryId: input.memoryId,
            scopeId: coordinates.productAuthority.scopeId, origin: "scope",
          }));
      } else {
        for (const namespaceId of coordinates.requiredNamespaceIds) {
          await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.insert(memoryNamespaces).values({
              memoryId: input.memoryId, namespaceId,
            }));
        }
      }
      return;
    }
    const current = await loadProduct(tx, input.memoryId);
    if (rowInteger(current.row, "content_revision")
        !== input.expectedContentRevision
      || (input.requiredNamespaceIds !== undefined
        && !sameIds(current.requiredNamespaceIds, input.requiredNamespaceIds))
      || (!input.resetAccessRevision
        && rowInteger(current.row, "crypto_access_revision")
          !== input.expectedAccessRevision)) {
      throw staleRevision("Human Memory publication is stale");
    }
    const priorObjectId = rowNullableString(current.row, "crypto_object_id");
    const advanced = await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.update(memories).set({
        type: input.retainOrdinary ? input.authored.type : null,
        content: input.retainOrdinary ? input.authored.content : null,
        ...(input.authored.importance === undefined
          ? {} : { importance: input.authored.importance }),
        contentRevision: input.nextContentRevision,
        cryptoObjectId: null, cryptoRequiredNamespaceFingerprint: null,
        cryptoMappingState: "unmapped",
        ...(input.resetAccessRevision ? { cryptoAccessRevision: 0 } : {}),
        embedding: [...input.embedding.vector],
        embeddingRevision: input.nextContentRevision,
        embeddingProvider: input.embedding.provider,
        embeddingModel: input.embedding.canonicalModel,
        embeddingDimensions: input.embedding.dimensions,
        embeddingContractVersion: input.embedding.processorContractVersion,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(and(eq(memories.id, input.memoryId),
        eq(memories.contentRevision, input.expectedContentRevision),
        ...(input.resetAccessRevision ? [] : [
          eq(memories.cryptoAccessRevision, input.expectedAccessRevision),
        ]))).returning({ id: memories.id }));
    if (advanced.length !== 1) throw staleRevision(
      "Human Memory publication lost its product CAS",
    );
    if (priorObjectId !== null || input.priorMapping === "required") {
      const prior = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.update(memoryCryptoRevisions).set({
          disposition: "superseded", updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(and(eq(memoryCryptoRevisions.memoryId, input.memoryId),
          eq(memoryCryptoRevisions.contentRevision,
            input.expectedContentRevision),
          eq(memoryCryptoRevisions.completion, "complete"),
          eq(memoryCryptoRevisions.disposition, "mapped")))
          .returning({ sequence: memoryCryptoRevisions.sequence }));
      if (prior.length !== 1) throw staleRevision(
        "Human Memory publication lost its prior mapping",
      );
    }
  }

  async publishOrdinaryFallbackIntent(input: Readonly<{
    authority: HumanMemoryProductAuthority | HumanMemoryProductCreateAuthority;
    admission: HumanMemoryOrdinaryFallbackAdmission;
    embedding: HumanMemoryActualEmbedding;
  }>): Promise<HumanMemoryProductProjection> {
    const { request, requestDigest } = input.admission.authenticated;
    if (!validEmbedding(input.embedding)
      || requestDigest.length !== 32
      || request.expectedCryptoAccessRevision
        !== input.admission.expectedAccessRevision) {
      throw humanMemoryPreparedIntegrityError(
        "Human Memory ordinary publication payload is invalid",
      );
    }
    const authenticatedAuthority = {
      subjectHumanId: request.subjectHumanId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
      policyRevision: request.policyRevision,
    };
    return this.#publication.withOrdinaryLocks({ authority: input.authority,
      authenticatedAuthority }, (lockDeviceAuthority) =>
      this.#canonicalRunner.transaction(async (canonical, tx) => {
        await this.#publication.fence({ transaction: canonical,
          authority: input.authority, mutation: true });
        await lockDeviceAuthority();
        const operation = oneOrNull(await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            foreground_stable_request_digest:
              memoryCryptoOperations.foregroundStableRequestDigest,
            foreground_mutation_kind: memoryCryptoOperations.foregroundMutationKind,
            foreground_required_namespace_ids:
              memoryCryptoOperations.foregroundRequiredNamespaceIds,
            expected_content_revision:
              memoryCryptoOperations.expectedContentRevision,
            result_content_revision: memoryCryptoOperations.resultContentRevision,
            expected_access_revision: memoryCryptoOperations.expectedAccessRevision,
            completion: memoryCryptoOperations.completion,
            disposition: memoryCryptoOperations.disposition,
          }).from(memoryCryptoOperations).where(and(
            eq(memoryCryptoOperations.operationId, request.operationId),
            eq(memoryCryptoOperations.memoryId, request.memoryId),
          )).limit(2).for("update", { of: memoryCryptoOperations })),
        "Human Memory ordinary publication admission");
        if (operation === null
          || rowString(operation, "completion") !== "pending"
          || rowString(operation, "disposition") !== "active"
          || !bytesEqual(rowBytes(operation,
            "foreground_stable_request_digest"), requestDigest)
          || rowString(operation, "foreground_mutation_kind") !==
            (request.purpose === "memory.ordinary_fallback.create"
              ? "save" : "replace")
          || !sameIds(rowStringArray(operation,
            "foreground_required_namespace_ids"), request.requiredNamespaceIds)
          || rowInteger(operation, "expected_content_revision")
            !== request.expectedContentRevision
          || rowInteger(operation, "result_content_revision")
            !== request.nextContentRevision
          || rowInteger(operation, "expected_access_revision")
            !== request.expectedCryptoAccessRevision
          || !(request.purpose === "memory.ordinary_fallback.create"
            ? authorityAllows : mutationAuthorityAllows)(
              input.authority, request.requiredNamespaceIds,
            )) {
          throw staleRevision("Human Memory ordinary publication is stale");
        }
        await this.#mutateProduct(tx, { authority: input.authority,
          memoryId: request.memoryId, operationId: request.operationId,
          expectedContentRevision: request.expectedContentRevision,
          nextContentRevision: request.nextContentRevision,
          expectedAccessRevision: request.expectedCryptoAccessRevision,
          requiredNamespaceIds: request.requiredNamespaceIds,
          authored: request, embedding: input.embedding, retainOrdinary: true,
          resetAccessRevision: false, priorMapping: "if-present",
          isCreate: request.purpose === "memory.ordinary_fallback.create" });
        const projection = projectProduct(await loadProduct(tx, request.memoryId));
        const completed = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.update(memoryCryptoOperations).set({
            completion: "ordinary_fallback", disposition: "complete",
            ordinaryFallbackReason: request.reason,
            ordinaryFallbackCompletedAt: sql`CURRENT_TIMESTAMP`,
            semanticChangeKind: request.purpose === "memory.ordinary_fallback.update"
              ? "replace" : null,
            semanticChangeAcknowledgedAt: null,
            humanProductOutcome: humanProductOutcome(projection),
            nextAttemptAt: null, updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(
            eq(memoryCryptoOperations.operationId, request.operationId),
            eq(memoryCryptoOperations.memoryId, request.memoryId),
            eq(memoryCryptoOperations.completion, "pending"),
            eq(memoryCryptoOperations.disposition, "active"),
            eq(memoryCryptoOperations.foregroundStableRequestDigest,
              requestDigest),
          )).returning({ sequence: memoryCryptoOperations.sequence }));
        if (completed.length !== 1) throw staleRevision(
          "Human Memory ordinary completion receipt is stale",
        );
        return projection;
      }, { isolationLevel: "serializable" }));
  }

  async publishOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryProductAuthority | HumanMemoryProductCreateAuthority;
    certificate: HumanMemoryProductAllocationCertificate;
    embedding: HumanMemoryActualEmbedding;
    authored: HumanMemoryAuthoredPublication;
    preparedAuthority: HumanMemoryPreparedAuthorityContext;
    reason: HumanMemoryOrdinaryFallbackReason;
  }>): Promise<HumanMemoryProductProjection> {
    if (!this.#publication.allowOrdinaryFallback
      || this.#publication.representation !== "ordinary_and_protected") {
      throw humanMemoryPreparedAuthorizationError(
        "Human Memory ordinary fallback is forbidden by policy",
      );
    }
    return this.#publishOutcome(input, {
      kind: "ordinary_fallback",
      reason: input.reason,
    });
  }

  async #publishOutcome(
    input: HumanMemoryPublicationInput,
    outcome: HumanMemoryPublicationOutcome,
  ): Promise<HumanMemoryProductProjection> {
    const { authority, certificate: value, embedding, authored } = input;
    if (authored.formatVersion !== 1 || typeof authored.type !== "string"
      || typeof authored.content !== "string"
      || (authored.importance !== undefined
        && (typeof authored.importance !== "number"
          || !Number.isFinite(authored.importance)
          || authored.importance < 0
          || authored.importance > 1))
      || embedding.dimensions !== 1536
      || embedding.processorContractVersion !== 1
      || embedding.vector.length !== 1536
      || embedding.vector.some((entry) => !Number.isFinite(entry))) {
      throw humanMemoryPreparedIntegrityError(
        "Human Memory publication payload is invalid",
      );
    }
    if (input.preparedAuthority.operationId !== value.operationId
      || input.preparedAuthority.memoryId !== value.memoryId
      || input.preparedAuthority.objectId !== value.objectId) {
      throw humanMemoryPreparedIntegrityError(
        "Human Memory publication prepared reservation is invalid",
      );
    }
    return this.#publication.withLocks({ authority,
      preparedAuthority: input.preparedAuthority, certificate: value,
    }, (lockCryptoAuthority) => this.#canonicalRunner.transaction(
      async (canonical, tx) => {
        await this.#publication.fence({ transaction: canonical, authority,
          mutation: true });
        await lockCryptoAuthority();
        if (!await this.#authorizeInTransaction(tx, authority, value)) {
          throw staleRevision("Human Memory publication allocation is stale");
        }
        const protectedOutcome = outcome.kind === "protected";
        const retainOrdinary = !protectedOutcome
          || this.#publication.representation === "ordinary_and_protected";
        await this.#mutateProduct(tx, { authority,
          memoryId: value.memoryId, operationId: value.operationId,
          expectedContentRevision: value.expectedContentRevision,
          nextContentRevision: value.nextContentRevision,
          expectedAccessRevision: value.expectedAccessRevision,
          authored, embedding, retainOrdinary,
          resetAccessRevision: protectedOutcome, priorMapping: "required",
          isCreate: value.expectedContentRevision === 0 });
        if (protectedOutcome) {
          const completed = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.update(memoryCryptoRevisions).set({
              completion: "complete", disposition: "mapped",
              cryptoCompletedAt:
                sql`COALESCE(${memoryCryptoRevisions.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
              nextAttemptAt: null, updatedAt: sql`CURRENT_TIMESTAMP`,
            }).where(and(eq(memoryCryptoRevisions.memoryId, value.memoryId),
              eq(memoryCryptoRevisions.contentRevision, value.nextContentRevision),
              inArray(memoryCryptoRevisions.completion, ["pending", "complete"])))
              .returning({ sequence: memoryCryptoRevisions.sequence }));
          if (completed.length !== 1) {
            throw staleRevision("Human Memory crypto completion receipt is stale");
          }
          const mapped = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.update(memories).set({
              cryptoObjectId: value.objectId,
              cryptoRequiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
              cryptoMappingState: "verified", cryptoAccessRevision: 0,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            }).where(and(eq(memories.id, value.memoryId),
              eq(memories.contentRevision, value.nextContentRevision),
              sql`(
                (${memories.cryptoObjectId} IS NULL
                  AND ${memories.cryptoRequiredNamespaceFingerprint} IS NULL)
                OR (${memories.cryptoObjectId} = ${value.objectId}
                  AND ${memories.cryptoRequiredNamespaceFingerprint}
                    = ${value.requiredNamespaceFingerprint})
              )`)).returning({ id: memories.id }));
          if (mapped.length !== 1) throw staleRevision(
            "Human Memory mapping lost its CAS",
          );
        } else {
          const abandoned = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.update(memoryCryptoRevisions).set({
              disposition: "superseded", updatedAt: sql`CURRENT_TIMESTAMP`,
            }).where(and(eq(memoryCryptoRevisions.memoryId, value.memoryId),
              eq(memoryCryptoRevisions.contentRevision, value.nextContentRevision),
              eq(memoryCryptoRevisions.cryptoObjectId, value.objectId),
              eq(memoryCryptoRevisions.allocationRequestDigest, value.allocationRequestDigest),
              eq(memoryCryptoRevisions.disposition, "active")))
              .returning({ sequence: memoryCryptoRevisions.sequence }));
          if (abandoned.length !== 1) {
            throw staleRevision("Human Memory fallback allocation changed");
          }
        }
        const projection = projectProduct(await loadProduct(tx, value.memoryId));
        const operation = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.update(memoryCryptoOperations).set({
            completion: protectedOutcome ? "complete" : "ordinary_fallback",
            disposition: "complete",
            ...(protectedOutcome ? {
              cryptoCompletedAt:
                sql`COALESCE(${memoryCryptoOperations.cryptoCompletedAt}, CURRENT_TIMESTAMP)`,
            } : {
              ordinaryFallbackReason: outcome.reason,
              ordinaryFallbackCompletedAt: sql`CURRENT_TIMESTAMP`,
            }),
            semanticChangeKind: value.expectedContentRevision > 0 ? "replace" : null,
            semanticChangeAcknowledgedAt: null,
            humanProductOutcome: humanProductOutcome(projection), nextAttemptAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          }).where(and(eq(memoryCryptoOperations.operationId, value.operationId),
            eq(memoryCryptoOperations.memoryId, value.memoryId),
            ...(protectedOutcome ? [
              inArray(memoryCryptoOperations.completion, ["pending", "complete"]),
            ] : [
              ...(value.expectedContentRevision === 0 ? [] : [
                eq(memoryCryptoOperations.requestDigest, value.operationRequestDigest),
              ]),
              eq(memoryCryptoOperations.completion, "pending"),
              eq(memoryCryptoOperations.disposition, "active"),
            ])))
            .returning({ sequence: memoryCryptoOperations.sequence }));
        if (operation.length !== 1) {
          throw staleRevision(protectedOutcome
            ? "Human Memory operation completion receipt is stale"
            : "Human Memory fallback receipt changed");
        }
        return projection;
      }, { isolationLevel: "serializable" }));
  }

  async #authorizeInTransaction(
    tx: ConversationProductPostgresTransaction,
    authority: HumanMemoryProductAuthority,
    value: HumanMemoryProductAllocationCertificate,
  ): Promise<boolean> {
    const rows = await tx.query(
      `SELECT o.request_digest, o.expected_access_revision,
              o.memory_id, o.anchor_namespace_id, o.created_at,
              r.crypto_object_id, r.allocation_request_digest,
              r.required_namespace_fingerprint, o.completion AS operation_completion,
              o.disposition AS operation_disposition
         FROM memory_crypto_operations o
         JOIN memory_crypto_revisions r
           ON r.memory_id = o.memory_id
          AND r.content_revision = o.result_content_revision
        WHERE o.operation_id = $1 AND o.memory_id = $2 LIMIT 2 FOR UPDATE`,
      [value.operationId, value.memoryId],
    );
    const row = oneOrNull(rows, "Human Memory publication certificate");
    if (row === null
      || rowInteger(row, "expected_access_revision") !== value.expectedAccessRevision
      || rowString(row, "operation_completion") !== "pending"
      || rowString(row, "operation_disposition") !== "active"
    ) return false;
    if (rowString(row, "crypto_object_id") !== value.objectId
      || !this.#operationDigestMatches(authority, value, row)
      || !bytesEqual(rowBytes(row, "allocation_request_digest"), value.allocationRequestDigest)
      || !bytesEqual(rowBytes(row, "required_namespace_fingerprint"), value.requiredNamespaceFingerprint)) {
      return false;
    }
    if (value.expectedContentRevision === 0) {
      if (!("memoryMode" in authority)) return false;
      const coordinates = createAuthorityCoordinates(
        authority as HumanMemoryProductCreateAuthority,
      );
      return coordinates !== null
        && value.anchorNamespaceId === coordinates.requiredNamespaceIds[0]
        && bytesEqual(value.requiredNamespaceFingerprint,
          fingerprintRequiredMemoryNamespaces(coordinates.requiredNamespaceIds));
    }
    const product = await loadProduct(tx, value.memoryId);
    return mutationAuthorityAllows(authority, product.requiredNamespaceIds)
      && rowInteger(product.row, "content_revision") === value.expectedContentRevision
      && rowInteger(product.row, "crypto_access_revision") === value.expectedAccessRevision
      && value.anchorNamespaceId === product.requiredNamespaceIds[0]
      && bytesEqual(value.requiredNamespaceFingerprint,
        fingerprintRequiredMemoryNamespaces(product.requiredNamespaceIds));
  }

  #operationDigestMatches(
    authority: HumanMemoryProductAuthority,
    value: HumanMemoryProductAllocationCertificate,
    row: ConversationProductDatabaseRow,
  ): boolean {
    if (rowString(row, "memory_id") !== value.memoryId
      || rowString(row, "anchor_namespace_id") !== value.anchorNamespaceId) {
      return false;
    }
    if (value.expectedContentRevision === 0) {
      if (!("memoryMode" in authority)) return false;
      const coordinates = createAuthorityCoordinates(
        authority as HumanMemoryProductCreateAuthority,
      );
      if (coordinates === null) return false;
      const createdAt = rowDate(row, "created_at").getTime();
      const expected = humanMemoryCreatePlanDigest({
        operationId: value.operationId,
        memoryId: value.memoryId,
        authority: authority as HumanMemoryProductCreateAuthority,
        requiredNamespaceIds: coordinates.requiredNamespaceIds,
        issuedAt: createdAt,
        deadlineAt: createdAt + this.#createPlanTtlMs,
      });
      try {
        return bytesEqual(rowBytes(row, "request_digest"), expected);
      } finally {
        expected.fill(0);
      }
    }
    return bytesEqual(
      rowBytes(row, "request_digest"), value.operationRequestDigest,
    );
  }
}
