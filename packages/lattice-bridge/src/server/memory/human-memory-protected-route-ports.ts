import {
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryDetailResponseV1Schema,
  protectedMemoryListResponseV1Schema,
  protectedMemorySearchResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
  type ProtectedMemoryBriefResponseV1,
  type ProtectedMemoryDetailResponseV1,
  type ProtectedMemoryListResponseV1,
  type ProtectedMemorySearchResponseV1,
  type ProtectedMemoryUnavailableResponseV1,
  type ProtectedMemoryAccessOperationV1,
  type ProtectedMemoryAccessPlanResponseV1,
  type ProtectedMemoryAccessUpdateResponseV1,
  type ProtectedMemoryPreparedAccessRequestV1,
} from "@nautilo/api-client";

import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
  MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
  MEMORY_QUERY_EMBEDDING_MAX_BYTES,
  type MemoryForegroundEmbeddingProcessor,
  type MemoryForegroundEmbeddingResult,
} from "../../memory/foreground-embedding-processor.ts";
import type {
  HumanMemoryPreparedCreateRoutePort,
} from "./human-memory-prepared-create-composition.ts";
import type {
  HumanMemoryPreparedUpdateRoutePort,
  ResolveHumanMemoryRouteHumanId,
} from "./human-memory-prepared-update-composition.ts";
import type {
  AuthenticatedHumanMemoryExactAccessPrepared,
} from "./postgres-human-memory-exact-access-crypto.ts";
import type {
  HumanMemoryExactAccessAuthority,
} from "./human-memory-exact-access.ts";
import type {
  HumanMemoryExactAccessCommitResult,
  HumanMemoryExactAccessCryptoObservation,
  HumanMemoryExactAccessCryptoReceipt,
  HumanMemoryExactAccessPlan,
  HumanMemoryExactAccessPlanResult,
  HumanMemoryExactAccessPublicationAuthority,
  HumanMemoryExactAccessReconcileResult,
  HumanMemoryExactAccessReplayLookup,
  HumanMemoryExactAccessReplayAdmission,
  HumanMemoryExactAccessTarget,
} from "./postgres-human-memory-exact-access-product.ts";
import { isHumanMemoryCryptoServiceUnavailable } from
  "./human-memory-crypto-availability.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const encoder = new TextEncoder();

export type HumanMemoryProtectedRouteAuthority = Readonly<{
  userId: string;
  actorId: string | null;
  agentId: string | null;
  memoryMode: "namespace" | "scope";
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
  scopeId: string | null;
  originWritableNamespaceId: string | null;
  sourceRoomId: string | null;
}>;

export type HumanMemoryNamespaceAuthorityV1 =
  ProtectedMemoryDetailResponseV1["memory"]["projection"]["readAuthorities"][number];
export type ResolveHumanMemoryNamespaceAuthority = (input: Readonly<{
  subjectUserId: string;
  subjectHumanId: string;
  preferredSourceRoomId: string | null;
  namespaceId: string;
  requested: readonly Readonly<{ generation: number; accessRevision: number }>[];
}>) => Promise<HumanMemoryNamespaceAuthorityV1 | null>;

type ProtectedReadResult<Response> =
  | Response
  | ProtectedMemoryUnavailableResponseV1;

export type HumanMemoryProtectedTierAction =
  | "archive"
  | "promote"
  | "demote"
  | "restore";

export type HumanMemoryProtectedTierReceipt = Readonly<{
  operation: "archive" | "tier_transition" | "restore";
  operationId: string;
  memoryId: string;
  response: Readonly<{
    operationId: string;
    status: "archived" | "promoted" | "demoted" | "restored" | "replayed";
    contentRevision: number;
    cryptoAccessRevision: number;
    previousTier: 1 | 2 | 3;
    nextTier: 1 | 2 | 3;
  }>;
}>;

export type HumanMemoryProtectedSemanticEmbedding = Extract<
  MemoryForegroundEmbeddingResult,
  Readonly<{ status: "embedded" }>
>["embedding"];

type ProductCommon = Readonly<{
  subjectHumanId: string;
  authority: HumanMemoryProtectedRouteAuthority;
}>;

/**
 * Content-free product seam for the dormant Human route composition. Reads
 * return ciphertext DTOs only. Semantic search receives a detached vector,
 * never the Human query. Mutations retain product-policy ownership and must
 * reconcile crypto access through their existing durable product adapters.
 */
export interface HumanMemoryProtectedProductRoutePort {
  list(input: ProductCommon & Readonly<{
    namespaceIds: readonly string[];
    excludeNamespaceIds?: readonly string[];
    cursor?: string;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryListResponseV1>>;
  detail(input: ProductCommon & Readonly<{
    memoryId: string;
    canManageMemories: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryDetailResponseV1>>;
  searchSemantic(input: ProductCommon & Readonly<{
    namespaceIds: readonly string[];
    embedding: HumanMemoryProtectedSemanticEmbedding;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemorySearchResponseV1>>;
  brief(input: ProductCommon & Readonly<{
    namespaceIds: readonly string[];
    readonly: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryBriefResponseV1>>;
  transitionTier(input: ProductCommon & Readonly<{
    operationId: string;
    memoryId: string;
    action: HumanMemoryProtectedTierAction;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2 | 3;
    nextTier: 1 | 2 | 3;
  }>): Promise<ProtectedReadResult<HumanMemoryProtectedTierReceipt>>;
}

export type HumanMemoryProtectedExactAccessProductPort = Readonly<{
  resolveTarget(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    memoryId: string;
    operation: ProtectedMemoryAccessOperationV1;
  }>): Promise<HumanMemoryExactAccessTarget | ProtectedMemoryUnavailableResponseV1
    | HumanMemoryExactAccessReadinessRequired>;
  plan(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    target: HumanMemoryExactAccessTarget;
  }>): Promise<HumanMemoryExactAccessPlanResult>;
  reserve(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    signedRequestDigest: Uint8Array;
  }>): Promise<"reserved" | "replayed">;
  lookupReplay(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    subjectHumanId: string;
    signedRequestDigest: Uint8Array;
  }>): Promise<HumanMemoryExactAccessReplayLookup>;
  commit(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    receipt: HumanMemoryExactAccessCryptoReceipt;
  }>): Promise<HumanMemoryExactAccessCommitResult>;
  commitOrdinaryFallback(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    plan: HumanMemoryExactAccessPlan;
    preparedAuthority: HumanMemoryExactAccessPublicationAuthority;
    signedRequestDigest: Uint8Array;
    reason: "encryption_pending" | "target_encryption_not_ready";
  }>): Promise<HumanMemoryExactAccessCommitResult>;
  reconcile(input: Readonly<{
    authority: HumanMemoryExactAccessAuthority;
    operationId: string;
    memoryId: string;
    crypto: HumanMemoryExactAccessCryptoObservation;
  }>): Promise<HumanMemoryExactAccessReconcileResult>;
}>;

export type HumanMemoryExactAccessReadinessRequired = Readonly<{
  kind: "namespace_readiness_required";
  anchorNamespaceId: string;
  namespaceIds: readonly string[];
}>;

export type HumanMemoryProtectedExactAccessCryptoPort = Readonly<{
  digestSignedRequest(prepared: ProtectedMemoryPreparedAccessRequestV1): Uint8Array;
  authenticate(input: Readonly<{
    plan: HumanMemoryExactAccessPlan;
    prepared: ProtectedMemoryPreparedAccessRequestV1;
    replayAdmission?: HumanMemoryExactAccessReplayAdmission;
  }>): Promise<Readonly<{
    handle: AuthenticatedHumanMemoryExactAccessPrepared;
    signedRequestDigest: Uint8Array;
    publicationAuthority: HumanMemoryExactAccessPublicationAuthority;
  }>>;
  complete(handle: AuthenticatedHumanMemoryExactAccessPrepared):
    Promise<HumanMemoryExactAccessCryptoReceipt>;
  observe(objectId: string): Promise<HumanMemoryExactAccessCryptoObservation>;
}>;

export interface HumanMemoryProtectedRoutePorts {
  planCreate(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
  }>): ReturnType<HumanMemoryPreparedCreateRoutePort["planCreate"]>;
  createPrepared(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    prepared: Parameters<
      HumanMemoryPreparedCreateRoutePort["createPrepared"]
    >[0]["prepared"];
  }>): ReturnType<HumanMemoryPreparedCreateRoutePort["createPrepared"]>;
  updatePrepared(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    memoryId: string;
    prepared: Parameters<
      HumanMemoryPreparedUpdateRoutePort["updatePrepared"]
    >[0]["prepared"];
  }>): ReturnType<HumanMemoryPreparedUpdateRoutePort["updatePrepared"]>;
  list(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    namespaceIds: readonly string[];
    excludeNamespaceIds?: readonly string[];
    cursor?: string;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryListResponseV1>>;
  detail(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    memoryId: string;
    canManageMemories: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryDetailResponseV1>>;
  search(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    namespaceIds: readonly string[];
    query: string;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemorySearchResponseV1>>;
  brief(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    namespaceIds: readonly string[];
    readonly: boolean;
  }>): Promise<ProtectedReadResult<ProtectedMemoryBriefResponseV1>>;
  archive(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    operationId: string;
    memoryId: string;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2;
  }>): Promise<ProtectedReadResult<HumanMemoryProtectedTierReceipt>>;
  transitionTier(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    operationId: string;
    memoryId: string;
    action: "promote" | "demote";
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2;
    nextTier: 1 | 2 | 3;
  }>): Promise<ProtectedReadResult<HumanMemoryProtectedTierReceipt>>;
  restore(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    operationId: string;
    memoryId: string;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 3;
    nextTier: 1 | 2;
  }>): Promise<ProtectedReadResult<HumanMemoryProtectedTierReceipt>>;
  planAccess(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    memoryId: string;
    operation: ProtectedMemoryAccessOperationV1;
  }>): Promise<ProtectedMemoryAccessPlanResponseV1 | ProtectedMemoryUnavailableResponseV1>;
  commitAccess(input: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    memoryId: string;
    prepared: ProtectedMemoryPreparedAccessRequestV1;
  }>): Promise<ProtectedMemoryAccessUpdateResponseV1 | ProtectedMemoryUnavailableResponseV1>;
}

declare const HUMAN_MEMORY_PROTECTED_ROUTE_TEST_AUTHORITY: unique symbol;
export type HumanMemoryProtectedRouteTestAuthority = Readonly<{
  [HUMAN_MEMORY_PROTECTED_ROUTE_TEST_AUTHORITY]: true;
}>;

const testAuthorities = new WeakSet<object>();

function unavailable(
  reason: ProtectedMemoryUnavailableResponseV1["reason"],
): ProtectedMemoryUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function isUnavailable(
  value: unknown,
): value is ProtectedMemoryUnavailableResponseV1 {
  return protectedMemoryUnavailableResponseV1Schema.safeParse(value).success;
}

function normalizePortableId(label: string, value: string): string {
  if (
    typeof value !== "string"
    || !PORTABLE_ID.test(value)
    || encoder.encode(value).length > 128
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function normalizeNamespaceIds(
  label: string,
  values: readonly string[],
  allowEmpty: boolean,
): readonly string[] {
  if (
    !Array.isArray(values)
    || (!allowEmpty && values.length === 0)
  ) throw new TypeError(`${label} is invalid`);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !UUID.test(value)) {
      throw new TypeError(`${label} is invalid`);
    }
    return value;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze(normalized);
}

function normalizeAuthority(
  value: HumanMemoryProtectedRouteAuthority,
): HumanMemoryProtectedRouteAuthority {
  normalizePortableId("Human Memory route user", value.userId);
  if (value.memoryMode !== "namespace" && value.memoryMode !== "scope") {
    throw new TypeError("Human Memory route mode is invalid");
  }
  if (value.sourceRoomId !== null && !UUID.test(value.sourceRoomId)) {
    throw new TypeError("Human Memory source Room is invalid");
  }
  const readableNamespaceIds = normalizeNamespaceIds(
    "Human Memory readable Namespaces",
    value.readableNamespaceIds,
    true,
  );
  const mutableNamespaceIds = normalizeNamespaceIds(
    "Human Memory mutable Namespaces",
    value.mutableNamespaceIds,
    true,
  );
  const writableNamespaceIds = normalizeNamespaceIds(
    "Human Memory writable Namespaces",
    value.writableNamespaceIds,
    true,
  );
  if (value.memoryMode === "scope") {
    if (
      value.scopeId === null
      || !UUID.test(value.scopeId)
      || value.originWritableNamespaceId === null
      || !UUID.test(value.originWritableNamespaceId)
      || readableNamespaceIds.length !== 0
      || mutableNamespaceIds.length !== 0
      || writableNamespaceIds.length !== 0
    ) throw new TypeError("Human Memory scope route authority is invalid");
  } else if (
    value.scopeId !== null
    || value.originWritableNamespaceId !== null
  ) throw new TypeError("Human Memory Namespace route authority is invalid");
  return Object.freeze({
    ...value,
    readableNamespaceIds,
    mutableNamespaceIds,
    writableNamespaceIds,
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: HumanMemoryProtectedRouteAuthority,
  right: HumanMemoryProtectedRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.actorId === right.actorId
    && left.agentId === right.agentId
    && left.memoryMode === right.memoryMode
    && left.scopeId === right.scopeId
    && left.originWritableNamespaceId === right.originWritableNamespaceId
    && left.sourceRoomId === right.sourceRoomId
    && sameStrings(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameStrings(left.mutableNamespaceIds, right.mutableNamespaceIds)
    && sameStrings(left.writableNamespaceIds, right.writableNamespaceIds);
}

function subsetOf(values: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}

function exactResponseMode(
  response: Readonly<{ memoryMode: "namespace" | "scope" }>,
  authority: HumanMemoryProtectedRouteAuthority,
): void {
  if (response.memoryMode !== authority.memoryMode) {
    throw new TypeError("Protected Human Memory response mode was substituted");
  }
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

function expectedTierStatus(action: HumanMemoryProtectedTierAction) {
  return action === "archive" ? "archived" as const
    : action === "restore" ? "restored" as const
    : action === "promote" ? "promoted" as const
    : "demoted" as const;
}

function exactAccessPlan(
  plan: HumanMemoryExactAccessPlan,
  prepared: ProtectedMemoryPreparedAccessRequestV1,
): boolean {
  return plan.operationId === prepared.operationId
    && plan.memoryId === prepared.memoryId
    && plan.cryptoObjectId === prepared.cryptoObjectId
    && plan.expectedContentRevision === prepared.expectedContentRevision
    && plan.expectedCryptoAccessRevision === prepared.expectedCryptoAccessRevision
    && plan.nextCryptoAccessRevision === prepared.nextCryptoAccessRevision
    && sameStrings(plan.currentNamespaceIds, prepared.currentNamespaceIds)
    && sameStrings(plan.targetNamespaceIds, prepared.targetNamespaceIds);
}

function accessPlanResponse(
  plan: HumanMemoryExactAccessPlan,
  deadlineAt: number,
  currentAuthorities: readonly HumanMemoryNamespaceAuthorityV1[],
  targetAuthorities: readonly HumanMemoryNamespaceAuthorityV1[],
): ProtectedMemoryAccessPlanResponseV1 {
  const authority = (value: HumanMemoryNamespaceAuthorityV1) => ({
    ...value,
    retainedGenerations: value.retainedGenerations.map((entry) => ({ ...entry })),
  });
  return Object.freeze({
    dtoVersion: 1,
    status: "planned",
    planVersion: 1,
    operationId: plan.operationId,
    memoryId: plan.memoryId,
    expectedContentRevision: plan.expectedContentRevision,
    expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
    cryptoObjectId: plan.cryptoObjectId,
    currentNamespaceIds: [...plan.currentNamespaceIds],
    targetNamespaceIds: [...plan.targetNamespaceIds],
    addedNamespaceIds: [...plan.addedNamespaceIds],
    removedNamespaceIds: [...plan.removedNamespaceIds],
    currentAuthorities: currentAuthorities.map(authority),
    targetAuthorities: targetAuthorities.map(authority),
    deadlineAt,
  });
}

/**
 * Assemble every dormant Human Memory route port behind one exact test-only
 * target. No production switch, vault, key, plaintext store, or fallback is
 * created here.
 */
export type HumanMemoryProtectedRouteAssembly = Readonly<{
  target: HumanMemoryProtectedRouteAuthority;
  now: () => number;
  createRequestId: () => string;
  createAccessOperationId: () => string;
  accessDeadlineAt: () => number;
  queryProvider: "openai" | "openrouter" | "venice";
  queryModel: string;
  resolveHumanId: ResolveHumanMemoryRouteHumanId;
  foregroundEmbeddingProcessor: MemoryForegroundEmbeddingProcessor;
  product: HumanMemoryProtectedProductRoutePort;
  preparedCreate: HumanMemoryPreparedCreateRoutePort;
  preparedUpdate: HumanMemoryPreparedUpdateRoutePort;
  exactAccessProduct: HumanMemoryProtectedExactAccessProductPort;
  exactAccessCrypto: HumanMemoryProtectedExactAccessCryptoPort;
  resolveNamespaceAuthority: ResolveHumanMemoryNamespaceAuthority;
}>;

export function createHumanMemoryProtectedRoutePorts(input: HumanMemoryProtectedRouteAssembly & Readonly<{
  authority: HumanMemoryProtectedRouteTestAuthority;
}>): HumanMemoryProtectedRoutePorts {
  if (!testAuthorities.has(input.authority)) {
    throw new TypeError("Protected Human Memory route assembler requires test authority");
  }
  return createHumanMemoryProtectedRoutePortsFromTrustedPorts(input);
}

/** Request-scoped production assembly: the server supplies current product
 * authority and verified storage/processor ports, never a serialized token. */
export function createHumanMemoryProtectedRoutePortsFromTrustedPorts(
  input: HumanMemoryProtectedRouteAssembly,
): HumanMemoryProtectedRoutePorts {
  const target = normalizeAuthority(input.target);
  normalizePortableId("Human Memory query model", input.queryModel);

  const common = async (
    rawAuthority: HumanMemoryProtectedRouteAuthority,
  ): Promise<ProductCommon | null> => {
    let authority: HumanMemoryProtectedRouteAuthority;
    try {
      authority = normalizeAuthority(rawAuthority);
    } catch {
      return null;
    }
    if (!sameAuthority(authority, target) || authority.agentId !== null) {
      return null;
    }
    const subjectHumanId = await input.resolveHumanId(authority.userId);
    if (subjectHumanId === null) return null;
    normalizePortableId("Human Memory Human", subjectHumanId);
    return Object.freeze({ subjectHumanId, authority });
  };

  const selectedNamespaces = (
    authority: HumanMemoryProtectedRouteAuthority,
    namespaceIds: readonly string[],
  ): readonly string[] | null => {
    let normalized: readonly string[];
    try {
      normalized = normalizeNamespaceIds(
        "Human Memory selected Namespaces",
        namespaceIds,
        authority.memoryMode === "scope",
      );
    } catch {
      return null;
    }
    if (authority.memoryMode === "scope") {
      return normalized.length === 0 ? normalized : null;
    }
    return subsetOf(normalized, authority.readableNamespaceIds)
      ? normalized
      : null;
  };

  const mutateTier = async (operation: Readonly<{
    authority: HumanMemoryProtectedRouteAuthority;
    operationId: string;
    memoryId: string;
    action: HumanMemoryProtectedTierAction;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2 | 3;
    nextTier: 1 | 2 | 3;
  }>): Promise<ProtectedReadResult<HumanMemoryProtectedTierReceipt>> => {
    const productCommon = await common(operation.authority);
    if (
      productCommon === null
      || !PORTABLE_ID.test(operation.operationId)
      || !UUID.test(operation.memoryId)
      || !Number.isSafeInteger(operation.expectedContentRevision)
      || operation.expectedContentRevision < 1
      || !Number.isSafeInteger(operation.expectedCryptoAccessRevision)
      || operation.expectedCryptoAccessRevision < 0
      || !transitionAllowed(
        operation.action,
        operation.expectedTier,
        operation.nextTier,
      )
    ) return unavailable("authorization_required");
    const result = await input.product.transitionTier({
      ...productCommon,
      operationId: operation.operationId,
      memoryId: operation.memoryId,
      action: operation.action,
      expectedContentRevision: operation.expectedContentRevision,
      expectedCryptoAccessRevision: operation.expectedCryptoAccessRevision,
      expectedTier: operation.expectedTier,
      nextTier: operation.nextTier,
    });
    if (isUnavailable(result)) return result;
    const expectedOperation = expectedTierOperation(operation.action);
    const expectedStatus = expectedTierStatus(operation.action);
    if (
      result.operation !== expectedOperation
      || result.operationId !== operation.operationId
      || result.memoryId !== operation.memoryId
      || result.response.operationId !== operation.operationId
      || (result.response.status !== expectedStatus
        && result.response.status !== "replayed")
      || result.response.contentRevision !== operation.expectedContentRevision
      || result.response.cryptoAccessRevision
        !== operation.expectedCryptoAccessRevision
      || result.response.previousTier !== operation.expectedTier
      || result.response.nextTier !== operation.nextTier
    ) throw new TypeError("Protected Human Memory tier receipt was substituted");
    return result;
  };

  const ports: HumanMemoryProtectedRoutePorts = {
    async planCreate(operation) {
      if (await common(operation.authority) === null) {
        return unavailable("authorization_required");
      }
      return input.preparedCreate.planCreate(operation);
    },
    async createPrepared(operation) {
      if (await common(operation.authority) === null) {
        return unavailable("authorization_required");
      }
      return input.preparedCreate.createPrepared(operation);
    },
    async updatePrepared(operation) {
      if (await common(operation.authority) === null) {
        return unavailable("authorization_required");
      }
      return input.preparedUpdate.updatePrepared(operation);
    },
    async list(operation) {
      const productCommon = await common(operation.authority);
      if (productCommon === null) return unavailable("authorization_required");
      const namespaceIds = selectedNamespaces(
        productCommon.authority,
        operation.namespaceIds,
      );
      if (namespaceIds === null) return unavailable("authorization_required");
      let excludeNamespaceIds: readonly string[] | undefined;
      if (operation.excludeNamespaceIds !== undefined) {
        excludeNamespaceIds = selectedNamespaces(
          productCommon.authority,
          operation.excludeNamespaceIds,
        ) ?? undefined;
        if (excludeNamespaceIds === undefined) {
          return unavailable("authorization_required");
        }
      }
      const result = await input.product.list({
        ...productCommon,
        namespaceIds,
        ...(excludeNamespaceIds === undefined ? {} : { excludeNamespaceIds }),
        ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
        includeArchive: operation.includeArchive,
      });
      if (isUnavailable(result)) return result;
      const parsed = protectedMemoryListResponseV1Schema.parse(result);
      exactResponseMode(parsed, productCommon.authority);
      return parsed;
    },
    async detail(operation) {
      const productCommon = await common(operation.authority);
      if (productCommon === null) return unavailable("authorization_required");
      const result = await input.product.detail({
        ...productCommon,
        memoryId: operation.memoryId,
        canManageMemories: operation.canManageMemories,
      });
      if (isUnavailable(result)) return result;
      const parsed = protectedMemoryDetailResponseV1Schema.parse(result);
      exactResponseMode(parsed, productCommon.authority);
      if (parsed.memory.projection.memoryId !== operation.memoryId) {
        throw new TypeError("Protected Human Memory detail was substituted");
      }
      return parsed;
    },
    async search(operation) {
      const productCommon = await common(operation.authority);
      if (productCommon === null) return unavailable("authorization_required");
      const namespaceIds = selectedNamespaces(
        productCommon.authority,
        operation.namespaceIds,
      );
      if (namespaceIds === null) return unavailable("authorization_required");
      const queryBytes = encoder.encode(operation.query);
      if (
        queryBytes.length < 1
        || queryBytes.length > MEMORY_QUERY_EMBEDDING_MAX_BYTES
      ) return unavailable("embedding_unavailable");
      const issuedAt = input.now();
      const requestId = input.createRequestId();
      const embedded = await input.foregroundEmbeddingProcessor.embed({
        authenticatedSubjectId: productCommon.subjectHumanId,
        request: Object.freeze({
          contractVersion: MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
          purpose: "memory.query_embedding" as const,
          subjectId: productCommon.subjectHumanId,
          requestId,
          plaintext: operation.query,
          provider: input.queryProvider,
          model: input.queryModel,
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          issuedAt,
          deadlineAt: issuedAt + MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
          publication: null,
        }),
      });
      if (embedded.status !== "embedded") {
        return unavailable("embedding_unavailable");
      }
      const result = await input.product.searchSemantic({
        ...productCommon,
        namespaceIds,
        embedding: embedded.embedding,
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
        includeArchive: operation.includeArchive,
      });
      if (isUnavailable(result)) return result;
      const parsed = protectedMemorySearchResponseV1Schema.parse(result);
      exactResponseMode(parsed, productCommon.authority);
      return parsed;
    },
    async brief(operation) {
      const productCommon = await common(operation.authority);
      if (productCommon === null) return unavailable("authorization_required");
      const namespaceIds = selectedNamespaces(
        productCommon.authority,
        operation.namespaceIds,
      );
      if (namespaceIds === null) return unavailable("authorization_required");
      const result = await input.product.brief({
        ...productCommon,
        namespaceIds,
        readonly: operation.readonly,
      });
      if (isUnavailable(result)) return result;
      const parsed = protectedMemoryBriefResponseV1Schema.parse(result);
      exactResponseMode(parsed, productCommon.authority);
      return parsed;
    },
    archive(operation) {
      return mutateTier({ ...operation, action: "archive", nextTier: 3 });
    },
    transitionTier(operation) {
      return mutateTier(operation);
    },
    restore(operation) {
      return mutateTier({ ...operation, action: "restore" });
    },
    async planAccess(operation) {
      const commonInput = await common(operation.authority);
      if (
        commonInput === null
        || commonInput.authority.memoryMode !== "namespace"
      ) return unavailable("authorization_required");
      const operationId = input.createAccessOperationId();
      if (!PORTABLE_ID.test(operationId) || !UUID.test(operation.memoryId)) {
        return unavailable("integrity_failure");
      }
      const authority: HumanMemoryExactAccessAuthority = Object.freeze({
        userId: commonInput.authority.userId,
        actorId: commonInput.authority.actorId,
        agentId: null,
        subjectHumanId: commonInput.subjectHumanId,
        readableNamespaceIds: commonInput.authority.readableNamespaceIds,
        mutableNamespaceIds: commonInput.authority.mutableNamespaceIds,
        writableNamespaceIds: commonInput.authority.writableNamespaceIds,
      });
      const targetSet = await input.exactAccessProduct.resolveTarget({
        authority,
        memoryId: operation.memoryId,
        operation: operation.operation,
      });
      if ("dtoVersion" in targetSet) return targetSet;
      if (targetSet.kind === "namespace_readiness_required") {
        const requiredNamespaceIds = normalizeNamespaceIds(
          "Human Memory access readiness Namespaces",
          targetSet.namespaceIds,
          false,
        );
        if (!commonInput.authority.readableNamespaceIds.includes(
          targetSet.anchorNamespaceId,
        )) return unavailable("authorization_required");
        const anchorAuthority = await input.resolveNamespaceAuthority({
          subjectUserId: commonInput.authority.userId,
          subjectHumanId: commonInput.subjectHumanId,
          preferredSourceRoomId: null,
          namespaceId: targetSet.anchorNamespaceId,
          requested: [],
        });
        if (anchorAuthority === null) {
          return unavailable("target_encryption_not_ready");
        }
        return Object.freeze({
          dtoVersion: 1 as const,
          status: "readiness_required" as const,
          reason: "target_encryption_not_ready" as const,
          memoryId: operation.memoryId,
          sourceRoomId: anchorAuthority.sourceRoomId,
          requiredNamespaceIds: [...requiredNamespaceIds],
        });
      }
      const plan = await input.exactAccessProduct.plan({
        authority,
        operationId,
        memoryId: operation.memoryId,
        target: targetSet,
      });
      if (plan.status === "unavailable") return unavailable(plan.reason);
      if (plan.status === "unchanged") {
        return Object.freeze({
          dtoVersion: 1 as const,
          status: "unchanged" as const,
          memoryId: plan.memoryId,
          cryptoAccessRevision: plan.cryptoAccessRevision,
          requiredNamespaceIds: [...plan.requiredNamespaceIds],
        });
      }
      const observed = await input.exactAccessCrypto.observe(plan.cryptoObjectId);
      if ((observed.status !== "current" && observed.status !== "target")
        || observed.objectId !== plan.cryptoObjectId
        || observed.accessRevision !== plan.expectedCryptoAccessRevision
        || !sameStrings(observed.namespaceIds, plan.currentNamespaceIds)) {
        return unavailable("target_encryption_not_ready");
      }
      const currentAuthorities = [];
      for (const namespaceId of plan.currentNamespaceIds) {
        const coordinates = observed.namespaceEnvelopeCoordinates.filter((entry) =>
          entry.namespaceId === namespaceId
        );
        if (coordinates.length !== 1) return unavailable("integrity_failure");
        const resolved = await input.resolveNamespaceAuthority({
          subjectUserId: commonInput.authority.userId,
          subjectHumanId: commonInput.subjectHumanId,
          preferredSourceRoomId: commonInput.authority.sourceRoomId,
          namespaceId, requested: coordinates,
        });
        if (resolved === null) return unavailable("target_encryption_not_ready");
        currentAuthorities.push(resolved);
      }
      const targetAuthorities = [];
      const missingTargetNamespaceIds = [];
      for (const namespaceId of plan.targetNamespaceIds) {
        const retained = currentAuthorities.find((entry) =>
          entry.namespaceId === namespaceId
        );
        if (retained !== undefined) {
          targetAuthorities.push(retained);
          continue;
        }
        const resolved = await input.resolveNamespaceAuthority({
          subjectUserId: commonInput.authority.userId,
          subjectHumanId: commonInput.subjectHumanId,
          preferredSourceRoomId: commonInput.authority.sourceRoomId,
          namespaceId, requested: [],
        });
        if (resolved === null) {
          if (plan.addedNamespaceIds.includes(namespaceId)) {
            missingTargetNamespaceIds.push(namespaceId);
            continue;
          }
          return unavailable("target_encryption_not_ready");
        }
        targetAuthorities.push(resolved);
      }
      if (missingTargetNamespaceIds.length > 0) {
        const anchorAuthority = currentAuthorities.find((entry) =>
          entry.namespaceId === plan.anchorNamespaceId
        );
        if (anchorAuthority === undefined) {
          return unavailable("target_encryption_not_ready");
        }
        return Object.freeze({ dtoVersion: 1 as const,
          status: "readiness_required" as const,
          reason: "target_encryption_not_ready" as const,
          memoryId: operation.memoryId,
          sourceRoomId: anchorAuthority.sourceRoomId,
          requiredNamespaceIds: missingTargetNamespaceIds });
      }
      return accessPlanResponse(plan, input.accessDeadlineAt(),
        currentAuthorities, targetAuthorities);
    },
    async commitAccess(operation) {
      const commonInput = await common(operation.authority);
      if (
        commonInput === null
        || commonInput.authority.memoryMode !== "namespace"
      ) return unavailable("authorization_required");
      const prepared = operation.prepared;
      if (prepared.memoryId !== operation.memoryId) {
        return unavailable("integrity_failure");
      }
      const authority: HumanMemoryExactAccessAuthority = Object.freeze({
        userId: commonInput.authority.userId,
        actorId: commonInput.authority.actorId,
        agentId: null,
        subjectHumanId: commonInput.subjectHumanId,
        readableNamespaceIds: commonInput.authority.readableNamespaceIds,
        mutableNamespaceIds: commonInput.authority.mutableNamespaceIds,
        writableNamespaceIds: commonInput.authority.writableNamespaceIds,
      });
      const digest = input.exactAccessCrypto.digestSignedRequest(prepared);
      let expectedDigest: Uint8Array | undefined;
      let replayAdmission: HumanMemoryExactAccessReplayAdmission | undefined;
      try {
        if (!(digest instanceof Uint8Array) || digest.length !== 32) {
          return unavailable("integrity_failure");
        }
        const replay = await input.exactAccessProduct.lookupReplay({
          authority,
          operationId: prepared.operationId,
          memoryId: prepared.memoryId,
          subjectHumanId: authority.subjectHumanId,
          signedRequestDigest: digest,
        });
        if (replay.status === "conflict") return unavailable("integrity_failure");
        if (replay.status === "completed") {
          return Object.freeze({
            dtoVersion: 1 as const,
            status: "replayed" as const,
            operationId: prepared.operationId,
            memoryId: prepared.memoryId,
            cryptoAccessRevision: replay.cryptoAccessRevision,
            requiredNamespaceIds: [...replay.requiredNamespaceIds],
          });
        }
        if (replay.status === "ordinary_fallback") {
          return Object.freeze({ dtoVersion: 1 as const,
            status: "ordinary_fallback" as const,
            operationId: prepared.operationId, memoryId: prepared.memoryId,
            cryptoAccessRevision: replay.cryptoAccessRevision,
            requiredNamespaceIds: [...prepared.targetNamespaceIds],
            reason: replay.reason });
        }
        if (replay.status === "pending") {
          replayAdmission = replay.replayAdmission;
          const observed = await input.exactAccessCrypto.observe(replay.cryptoObjectId);
          const reconciled = await input.exactAccessProduct.reconcile({
            authority,
            operationId: prepared.operationId,
            memoryId: prepared.memoryId,
            crypto: observed,
          });
          if (reconciled.status === "completed") return Object.freeze({
                dtoVersion: 1 as const,
                status: "replayed" as const,
                operationId: prepared.operationId,
                memoryId: prepared.memoryId,
                cryptoAccessRevision: reconciled.cryptoAccessRevision,
                requiredNamespaceIds: [...reconciled.requiredNamespaceIds],
              });
          if (reconciled.status !== "pending") return unavailable(
            reconciled.status === "stale" ? "stale_revision"
              : reconciled.status === "denied" ? "authorization_required"
              : "integrity_failure",
          );
        }
        expectedDigest = digest.slice();
      } finally {
        digest.fill(0);
      }
      const plan = await input.exactAccessProduct.plan({
        authority,
        operationId: prepared.operationId,
        memoryId: operation.memoryId,
        target: { kind: "replace_exact", namespaceIds: prepared.targetNamespaceIds },
      });
      if (plan.status === "unavailable") return unavailable(plan.reason);
      if (plan.status === "unchanged") return unavailable("stale_revision");
      if (!exactAccessPlan(plan, prepared)) return unavailable("stale_revision");
      let authenticated: Awaited<ReturnType<
        HumanMemoryProtectedExactAccessCryptoPort["authenticate"]
      >>;
      try {
        authenticated = await input.exactAccessCrypto.authenticate({
          plan,
          prepared,
          ...(replayAdmission === undefined ? {} : { replayAdmission }),
        });
      } catch {
        expectedDigest?.fill(0);
        return unavailable("integrity_failure");
      }
      try {
        if (
          expectedDigest === undefined
          || authenticated.signedRequestDigest.length !== expectedDigest.length
          || !expectedDigest.every((byte, index) =>
            byte === authenticated.signedRequestDigest[index]
          )
        ) return unavailable("integrity_failure");
        await input.exactAccessProduct.reserve({
          authority,
          plan,
          signedRequestDigest: authenticated.signedRequestDigest,
        });
        let receipt: HumanMemoryExactAccessCryptoReceipt;
        try {
          receipt = await input.exactAccessCrypto.complete(authenticated.handle);
        } catch (error) {
          if (!isHumanMemoryCryptoServiceUnavailable(error)) throw error;
          const committed = await input.exactAccessProduct.commitOrdinaryFallback({
            authority,
            plan,
            preparedAuthority: authenticated.publicationAuthority,
            signedRequestDigest: authenticated.signedRequestDigest,
            reason: "encryption_pending",
          });
          if (committed.status !== "ordinary_fallback" || committed.reason === undefined) {
            return unavailable("integrity_failure");
          }
          return Object.freeze({
            dtoVersion: 1 as const,
            status: committed.status,
            operationId: committed.operationId,
            memoryId: committed.memoryId,
            cryptoAccessRevision: committed.cryptoAccessRevision,
            requiredNamespaceIds: [...committed.requiredNamespaceIds],
            reason: committed.reason,
          });
        }
        const committed = await input.exactAccessProduct.commit({
          authority,
          plan,
          receipt,
        });
        if (committed.status === "ordinary_fallback") {
          if (committed.reason === undefined) return unavailable("integrity_failure");
          return Object.freeze({ dtoVersion: 1 as const, status: committed.status,
            operationId: committed.operationId, memoryId: committed.memoryId,
            cryptoAccessRevision: committed.cryptoAccessRevision,
            requiredNamespaceIds: [...committed.requiredNamespaceIds],
            reason: committed.reason });
        }
        return Object.freeze({
          dtoVersion: 1 as const,
          status: committed.status,
          operationId: committed.operationId,
          memoryId: committed.memoryId,
          cryptoAccessRevision: committed.cryptoAccessRevision,
          requiredNamespaceIds: [...committed.requiredNamespaceIds],
        });
      } finally {
        expectedDigest?.fill(0);
        authenticated.signedRequestDigest.fill(0);
      }
    },
  };
  return Object.freeze(ports);
}

/** Test/developer-only authority; no production activation path calls this. */
export function __mintHumanMemoryProtectedRouteTestAuthorityForTesting():
HumanMemoryProtectedRouteTestAuthority {
  const authority = Object.freeze({}) as HumanMemoryProtectedRouteTestAuthority;
  testAuthorities.add(authority);
  return authority;
}
