import type {
  ProtectedMemoryBriefResponseV1,
  ProtectedMemoryAccessOperationV1,
  ProtectedMemoryAccessPlanResponseV1,
  ProtectedMemoryAccessUpdateResponseV1,
  ProtectedMemoryDetailResponseV1,
  ProtectedMemoryListResponseV1,
  ProtectedMemoryCreatePlanResponseV1,
  ProtectedMemorySubmittedCreateRequestV1,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemorySubmittedUpdateRequestV1,
  ProtectedMemoryPreparedUpdateResponseV1,
  ProtectedMemorySearchResponseV1,
  ProtectedMemoryUnavailableResponseV1,
  MemoryProcessorRecipientV1,
  ProtectedMemoryRepairPlanResponseV1,
  ProtectedMemoryPreparedRepairRequestV1,
  ProtectedMemoryRepairResponseV1,
} from "@nautilo/api-client";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

export type ProtectedMemoryMode = "namespace" | "scope";

export type ProtectedMemoryRouteAuthority = Readonly<{
  userId: string;
  actorId: string | null;
  agentId: string | null;
  memoryMode: ProtectedMemoryMode;
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
  scopeId: string | null;
  originWritableNamespaceId: string | null;
  sourceRoomId: string | null;
}>;

export type ProtectedMemoryRouteTarget = Readonly<{
  userId: string;
  actorId?: string | null;
  agentId?: string | null;
  memoryMode: ProtectedMemoryMode;
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
  scopeId?: string | null;
  originWritableNamespaceId?: string | null;
  sourceRoomId?: string | null;
}>;

type ProtectedMemoryReadResult<Response> =
  | Response
  | ProtectedMemoryUnavailableResponseV1;

export type ProtectedMemoryTierReceipt = Readonly<{
  followUpPending?: true;
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

export interface ProtectedMemoryRoutePorts {
  readonly repair?: Readonly<{
    plan(input: Readonly<{ authority: ProtectedMemoryRouteAuthority; memoryId: string }>): Promise<ProtectedMemoryRepairPlanResponseV1>;
    commit(input: Readonly<{ authority: ProtectedMemoryRouteAuthority; memoryId: string;
      prepared: ProtectedMemoryPreparedRepairRequestV1 }>): Promise<ProtectedMemoryRepairResponseV1>;
  }>;
  readonly embeddingConfiguration?: MemoryProcessorRecipientV1["embedding"];
  planCreate(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
  }>): Promise<
    ProtectedMemoryReadResult<ProtectedMemoryCreatePlanResponseV1>
  >;

  createPrepared(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    prepared: ProtectedMemorySubmittedCreateRequestV1;
  }>): Promise<
    ProtectedMemoryReadResult<ProtectedMemoryPreparedUpdateResponseV1>
  >;

  list(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    namespaceIds: readonly string[];
    excludeNamespaceIds?: readonly string[];
    cursor?: string;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryListResponseV1>>;

  detail(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    memoryId: string;
    canManageMemories: boolean;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryDetailResponseV1>>;

  search(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    namespaceIds: readonly string[];
    query: string;
    limit?: number;
    includeArchive: boolean;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemorySearchResponseV1>>;

  brief(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    namespaceIds: readonly string[];
    readonly: boolean;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryBriefResponseV1>>;

  updatePrepared(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    memoryId: string;
    prepared: ProtectedMemorySubmittedUpdateRequestV1;
  }>): Promise<
    ProtectedMemoryReadResult<ProtectedMemoryPreparedUpdateResponseV1>
  >;

  archive(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    operationId: string;
    memoryId: string;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2;
  }>): Promise<
    ProtectedMemoryReadResult<ProtectedMemoryTierReceipt>
  >;

  transitionTier(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    operationId: string;
    memoryId: string;
    action: "promote" | "demote";
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 1 | 2;
    nextTier: 1 | 2 | 3;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryTierReceipt>>;

  restore(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    operationId: string;
    memoryId: string;
    expectedContentRevision: number;
    expectedCryptoAccessRevision: number;
    expectedTier: 3;
    nextTier: 1 | 2;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryTierReceipt>>;

  planAccess(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    memoryId: string;
    operation: ProtectedMemoryAccessOperationV1;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryAccessPlanResponseV1>>;

  commitAccess(input: Readonly<{
    authority: ProtectedMemoryRouteAuthority;
    memoryId: string;
    prepared: ProtectedMemoryPreparedAccessRequestV1;
  }>): Promise<ProtectedMemoryReadResult<ProtectedMemoryAccessUpdateResponseV1>>;
}

/** The live factory is evaluated for every authenticated request. No Human's
 * keys, policy or Namespace inventory is captured in app-global composition. */
export type ProtectedMemoryRouteFactory = (
  authority: ProtectedMemoryRouteAuthority,
  envelope: MemoryAccessEnvelope | null,
) => Promise<ProtectedMemoryRoutePorts | null>;

export type ProtectedMemoryCompositionSource =
  | ProtectedMemoryRouteComposition
  | ProtectedMemoryRouteFactory;

export async function resolveCurrentProtectedMemoryRoutePorts(input: Readonly<{
  composition?: ProtectedMemoryCompositionSource;
  authority: ProtectedMemoryRouteTarget;
  envelope?: MemoryAccessEnvelope | null;
}>) {
  if (typeof input.composition !== "function") {
    return resolveProtectedMemoryRoutePorts({
      ...(input.composition === undefined ? {} : { composition: input.composition }),
      authority: input.authority,
    });
  }
  const authority = normalizeTarget(input.authority);
  const ports = await input.composition(authority, input.envelope ?? null);
  if (ports === null) return null;
  assertPorts(ports);
  return Object.freeze({ authority, ports });
}

const protectedMemoryTestShadowAuthorityBrand: unique symbol = Symbol(
  "protected-memory-test-shadow-authority",
);
export type ProtectedMemoryTestShadowAuthority = Readonly<{
  [protectedMemoryTestShadowAuthorityBrand]: true;
}>;

const protectedMemoryCompositionBrand: unique symbol = Symbol(
  "protected-memory-route-composition",
);
export type ProtectedMemoryRouteComposition = Readonly<{
  mode: "protected_test_shadow";
  target: ProtectedMemoryRouteAuthority;
  ports: ProtectedMemoryRoutePorts;
  [protectedMemoryCompositionBrand]: true;
}>;

const recognizedAuthorities = new WeakSet<object>();
const recognizedCompositions = new WeakSet<object>();

const authorityMismatchResponse: ProtectedMemoryUnavailableResponseV1 =
  Object.freeze({
    dtoVersion: 1,
    status: "unavailable",
    reason: "authorization_required",
  });

const unavailableForAuthorityMismatch = (): Promise<
  ProtectedMemoryUnavailableResponseV1
> => Promise.resolve(authorityMismatchResponse);

const authorityMismatchPorts: ProtectedMemoryRoutePorts = Object.freeze({
  planCreate: unavailableForAuthorityMismatch,
  createPrepared: unavailableForAuthorityMismatch,
  list: unavailableForAuthorityMismatch,
  detail: unavailableForAuthorityMismatch,
  search: unavailableForAuthorityMismatch,
  brief: unavailableForAuthorityMismatch,
  updatePrepared: unavailableForAuthorityMismatch,
  archive: unavailableForAuthorityMismatch,
  transitionTier: unavailableForAuthorityMismatch,
  restore: unavailableForAuthorityMismatch,
  planAccess: unavailableForAuthorityMismatch,
  commitAccess: unavailableForAuthorityMismatch,
});

function normalizeNamespaceIds(
  label: string,
  namespaceIds: readonly string[],
): readonly string[] {
  const normalized = Array.from(namespaceIds, (namespaceId) => {
    if (typeof namespaceId !== "string" || namespaceId.length < 1) {
      throw new TypeError(`${label} contains an invalid Namespace id`);
    }
    return namespaceId;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} contains duplicate Namespace ids`);
  }
  return Object.freeze(normalized.sort());
}

function normalizeTarget(
  target: ProtectedMemoryRouteTarget,
): ProtectedMemoryRouteAuthority {
  if (typeof target.userId !== "string" || target.userId.length < 1) {
    throw new TypeError("Protected Memory target requires a user id");
  }
  if (target.memoryMode !== "namespace" && target.memoryMode !== "scope") {
    throw new TypeError("Protected Memory target mode is invalid");
  }
  return Object.freeze({
    userId: target.userId,
    actorId: target.actorId ?? null,
    agentId: target.agentId ?? null,
    memoryMode: target.memoryMode,
    readableNamespaceIds: normalizeNamespaceIds(
      "Protected Memory readable authority",
      target.readableNamespaceIds,
    ),
    mutableNamespaceIds: normalizeNamespaceIds(
      "Protected Memory mutable authority",
      target.mutableNamespaceIds,
    ),
    writableNamespaceIds: normalizeNamespaceIds(
      "Protected Memory writable authority",
      target.writableNamespaceIds,
    ),
    scopeId: target.scopeId ?? null,
    originWritableNamespaceId: target.originWritableNamespaceId ?? null,
    sourceRoomId: target.sourceRoomId ?? null,
  });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: ProtectedMemoryRouteAuthority,
  right: ProtectedMemoryRouteAuthority,
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

function assertPorts(ports: ProtectedMemoryRoutePorts): void {
  for (const operation of [
    "planCreate",
    "createPrepared",
    "list",
    "detail",
    "search",
    "brief",
    "updatePrepared",
    "archive",
    "transitionTier",
    "restore",
    "planAccess",
    "commitAccess",
  ] as const) {
    if (typeof ports[operation] !== "function") {
      throw new TypeError(
        `Protected Memory composition requires a ${operation} port`,
      );
    }
  }
}

export function createProtectedMemoryTestShadowComposition(input: Readonly<{
  authority: ProtectedMemoryTestShadowAuthority;
  target: ProtectedMemoryRouteTarget;
  ports: ProtectedMemoryRoutePorts;
}>): ProtectedMemoryRouteComposition {
  if (!recognizedAuthorities.has(input.authority)) {
    throw new TypeError(
      "Protected Memory test-shadow composition requires recognized test authority",
    );
  }
  assertPorts(input.ports);
  const ports: ProtectedMemoryRoutePorts = Object.freeze({
    ...(input.ports.repair === undefined ? {} : { repair: input.ports.repair }),
    planCreate: input.ports.planCreate.bind(input.ports),
    createPrepared: input.ports.createPrepared.bind(input.ports),
    list: input.ports.list.bind(input.ports),
    detail: input.ports.detail.bind(input.ports),
    search: input.ports.search.bind(input.ports),
    brief: input.ports.brief.bind(input.ports),
    updatePrepared: input.ports.updatePrepared.bind(input.ports),
    archive: input.ports.archive.bind(input.ports),
    transitionTier: input.ports.transitionTier.bind(input.ports),
    restore: input.ports.restore.bind(input.ports),
    planAccess: input.ports.planAccess.bind(input.ports),
    commitAccess: input.ports.commitAccess.bind(input.ports),
  });
  const composition = Object.freeze({
    mode: "protected_test_shadow" as const,
    target: normalizeTarget(input.target),
    ports,
    [protectedMemoryCompositionBrand]: true as const,
  });
  recognizedCompositions.add(composition);
  return composition;
}

function resolveProtectedMemoryRoutePorts(input: Readonly<{
  composition?: ProtectedMemoryRouteComposition;
  authority: ProtectedMemoryRouteTarget;
}>): Readonly<{
  authority: ProtectedMemoryRouteAuthority;
  ports: ProtectedMemoryRoutePorts;
}> | null {
  if (input.composition === undefined) return null;
  if (!recognizedCompositions.has(input.composition)) {
    throw new TypeError("Expected a recognized protected Memory composition");
  }
  const authority = normalizeTarget(input.authority);
  if (!sameAuthority(input.composition.target, authority)) {
    return Object.freeze({ authority, ports: authorityMismatchPorts });
  }
  return Object.freeze({ authority, ports: input.composition.ports });
}

/**
 * Internal direct-source test mint. It is deliberately not exported from the
 * server package root, so configuration and serialized input cannot activate
 * the dormant protected route composition.
 */
export function __mintProtectedMemoryTestShadowAuthorityForTesting():
  ProtectedMemoryTestShadowAuthority {
  const authority = Object.freeze({
    [protectedMemoryTestShadowAuthorityBrand]: true as const,
  });
  recognizedAuthorities.add(authority);
  return authority;
}
