import { agentRuntimeObjectSignerKeyIdV1 } from "@nautilo/lattice-crypto/wire";
import type { DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import type {
  ProtectedTaskMemoryAccessHandoff,
  ProtectedTaskMemoryProjectionHandoff,
} from "@nautilo/agent";
import type {
  ResolveHistoricalAgentRuntimeSignerPublicationManager,
} from "@nautilo/lattice-crypto";
import {
  deriveMemoryCryptoObjectIdV1,
  ClassifiedDataOperationError,
  commitMemoryMutationV1,
  createProtectedTaskMemoryAccessContinuationCapsule,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  selectLiveEncryptionRepresentationPolicy,
  type EncryptionDataOperationOwner,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryResult,
  type ProtectedTaskExecutionSignerAuthority,
} from "@nautilo/lattice-bridge";
import {
  copyTaskScopeMemoryBinding,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  foregroundAgentAcceptedExecutionSigner,
  PostgresAgentMemoryProductPort,
  PostgresAgentMemoryExactAccessProduct,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  readVerifiedDeviceWrappedAgentObject,
  persistForegroundAgentMemoryNativeExactAccess,
  withNativeTaskMemoryEntityCrypto,
  type ForegroundMemoryRepairSource,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  createTaskRuntimeDomainMemoryCryptoSession,
  createForegroundDomainMemoryExactAccess,
} from "@nautilo/runtime";
import {
  findActorByHandle,
  findActorById,
} from "@nautilo/trust";

import {
  adoptProtectedTaskScopeMemoryOrigin,
  reserveProtectedTaskNamespaceMemoryRepair,
  reserveProtectedTaskScopeMemoryRepair,
  attachProtectedTaskNamespaceMemoryRepair,
  attachProtectedTaskScopeMemoryRepair,
  assertHeldProtectedTaskContentAccessNamespace,
  requireHeldProtectedTaskMemoryWriterAuthority,
  findProtectedTaskContentAccessNamespace,
  resolveProtectedTaskContentAccessNamespace,
  withCurrentProtectedTaskMemoryAuthority,
  type CurrentProtectedTaskMemoryPolicy,
  type HeldProtectedTaskMemoryAuthority,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";
import {
  createProtectedTaskMemoryBoundaries,
  type ProtectedTaskMemoryBoundariesInput,
} from "./protected-task-memory-boundaries";
import {
  createProtectedTaskMemoryRepository,
  createProtectedTaskMemoryReader,
  type ProtectedTaskMemoryRepositoryCompositionInput,
} from "./protected-task-memory-composition";
import {
  persistProtectedTaskMemoryObject,
} from "./protected-task-memory-object-writer";
import {
  resolveForegroundMemoryNativeEntries,
} from "./foreground-memory-repository";

import { createProtectedTaskMemoryOrdinaryFallback } from "./protected-task-memory-ordinary-fallback";
import {
  createProtectedTaskMemoryProjection,
} from "./protected-task-memory-projection";
import {
  createProtectedTaskMemoryExactAccess,
  type ProtectedTaskMemoryAccessDestination,
  type ProtectedTaskMemoryAccessSource,
} from "./protected-task-memory-exact-access";

type ProductContext = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

type ExactMemoryCandidate = Extract<Awaited<ReturnType<
  import("@nautilo/lattice-bridge/server")
    .ProtectedTaskMemoryReadPort["loadExactCandidates"]
>>, { status: "success" }>["value"][number];
type ExactProtectedMemoryCandidate = Exclude<
  ExactMemoryCandidate,
  { representation: "ordinary_only" }
>;

type MemoryUnavailableReason = Extract<
  ProtectedMemoryResult<never>,
  { status: "unavailable" }
>["reason"];

export type ProtectedTaskNativeMemoryRepositoryInput<Value> = Readonly<{
  authority: ProtectedMemoryAuthority;
  policy: ProtectedTaskMemoryBoundariesInput["policy"];
  current: ProtectedTaskMemoryAuthorityInput;
  domains: readonly DomainForegroundSecretEntry[];
  signer: ProtectedTaskExecutionSignerAuthority;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  product: ProductContext;
  agentProduct: ProductContext;
  owner: EncryptionDataOperationOwner;
  embedding: ProtectedAgentMemoryEmbeddingPort;
  execute(
    repository: ProtectedAgentMemoryRepository,
    projection: ProtectedTaskMemoryProjectionHandoff,
    access: ProtectedTaskMemoryAccessHandoff,
  ): Promise<Value>;
}>;

type Dependencies = Readonly<{
  createFallback: typeof createProtectedTaskMemoryOrdinaryFallback;
  withCurrentAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  adoptScopeOrigin: typeof adoptProtectedTaskScopeMemoryOrigin;
  reserveNamespaceRepair: typeof reserveProtectedTaskNamespaceMemoryRepair;
  reserveScopeRepair: typeof reserveProtectedTaskScopeMemoryRepair;
  attachNamespaceRepair: typeof attachProtectedTaskNamespaceMemoryRepair;
  attachScopeRepair: typeof attachProtectedTaskScopeMemoryRepair;
  withEntityCrypto: typeof withNativeTaskMemoryEntityCrypto;
  createSession: typeof createTaskRuntimeDomainMemoryCryptoSession;
  createBoundaries: typeof createProtectedTaskMemoryBoundaries;
  createRepository: typeof createProtectedTaskMemoryRepository;
  createReader: typeof createProtectedTaskMemoryReader;
  createProjection: typeof createProtectedTaskMemoryProjection;
  createAccess: typeof createProtectedTaskMemoryExactAccess;
  createAccessCapsule: typeof createProtectedTaskMemoryAccessContinuationCapsule;
  createExactCrypto: typeof createForegroundDomainMemoryExactAccess;
  persistExact: typeof persistForegroundAgentMemoryNativeExactAccess;
  resolveAccessNamespace: typeof resolveProtectedTaskContentAccessNamespace;
  findAccessNamespace: typeof findProtectedTaskContentAccessNamespace;
  assertHeldAccessNamespace:
    typeof assertHeldProtectedTaskContentAccessNamespace;
  findActorByHandle: typeof findActorByHandle;
  findActorById: typeof findActorById;
  persistObject: typeof persistProtectedTaskMemoryObject;
  requireHeldWriterAuthority:
    typeof requireHeldProtectedTaskMemoryWriterAuthority;
  createProduct(input: ConstructorParameters<
    typeof PostgresAgentMemoryProductPort
  >[0]): PostgresAgentMemoryProductPort;
  createExactProduct(input: ConstructorParameters<
    typeof PostgresAgentMemoryExactAccessProduct
  >[0]): PostgresAgentMemoryExactAccessProduct;
  readObject: typeof readVerifiedDeviceWrappedAgentObject;
  createDomainKeys(
    ...input: ConstructorParameters<typeof PostgresDomainKeyAuthorityRepository>
  ): PostgresDomainKeyAuthorityRepository;
  createSignerHistory(
    input: ConstructorParameters<typeof PostgresHumanDeviceSignerHistory>[0],
  ): PostgresHumanDeviceSignerHistory;
  createForegroundAgentAcceptedExecutionEvidenceResolver:
    typeof createPostgresForegroundAgentAcceptedExecutionEvidenceResolver;
  foregroundAgentAcceptedExecutionSigner:
    typeof foregroundAgentAcceptedExecutionSigner;
  resolveNativeEntries: typeof resolveForegroundMemoryNativeEntries;
}>;

const productionDependencies: Dependencies = Object.freeze({
  createFallback: createProtectedTaskMemoryOrdinaryFallback,
  withCurrentAuthority: withCurrentProtectedTaskMemoryAuthority,
  adoptScopeOrigin: adoptProtectedTaskScopeMemoryOrigin,
  reserveNamespaceRepair: reserveProtectedTaskNamespaceMemoryRepair,
  reserveScopeRepair: reserveProtectedTaskScopeMemoryRepair,
  attachNamespaceRepair: attachProtectedTaskNamespaceMemoryRepair,
  attachScopeRepair: attachProtectedTaskScopeMemoryRepair,
  withEntityCrypto: withNativeTaskMemoryEntityCrypto,
  createSession: createTaskRuntimeDomainMemoryCryptoSession,
  createBoundaries: createProtectedTaskMemoryBoundaries,
  createRepository: createProtectedTaskMemoryRepository,
  createReader: createProtectedTaskMemoryReader,
  createProjection: createProtectedTaskMemoryProjection,
  createAccess: createProtectedTaskMemoryExactAccess,
  createAccessCapsule: createProtectedTaskMemoryAccessContinuationCapsule,
  createExactCrypto: createForegroundDomainMemoryExactAccess,
  persistExact: persistForegroundAgentMemoryNativeExactAccess,
  resolveAccessNamespace: resolveProtectedTaskContentAccessNamespace,
  findAccessNamespace: findProtectedTaskContentAccessNamespace,
  assertHeldAccessNamespace:
    assertHeldProtectedTaskContentAccessNamespace,
  findActorByHandle,
  findActorById,
  persistObject: persistProtectedTaskMemoryObject,
  requireHeldWriterAuthority:
    requireHeldProtectedTaskMemoryWriterAuthority,
  createProduct: input => new PostgresAgentMemoryProductPort(input),
  createExactProduct: input => new PostgresAgentMemoryExactAccessProduct(input),
  readObject: readVerifiedDeviceWrappedAgentObject,
  createDomainKeys: (...input) =>
    new PostgresDomainKeyAuthorityRepository(...input),
  createSignerHistory: input => new PostgresHumanDeviceSignerHistory(input),
  createForegroundAgentAcceptedExecutionEvidenceResolver:
    createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  foregroundAgentAcceptedExecutionSigner,
  resolveNativeEntries: resolveForegroundMemoryNativeEntries,
});

function samePolicy(
  actual: CurrentProtectedTaskMemoryPolicy,
  expected: ProtectedTaskMemoryBoundariesInput["policy"],
): boolean {
  return expected.mode !== "plaintext_only"
    && actual.mode === expected.mode
    && actual.shadowBehavior === expected.shadowBehavior
    && actual.revision === expected.revision;
}

function sameAuthority(
  actual: ProtectedMemoryAuthority,
  expected: ProtectedMemoryAuthority,
): boolean {
  if (actual.mode !== expected.mode
    || actual.subjectUserId !== expected.subjectUserId
    || actual.agentId !== expected.agentId) return false;
  if (actual.mode === "scope" && expected.mode === "scope") {
    return actual.scopeId === expected.scopeId
      && actual.originWritableNamespaceId
        === expected.originWritableNamespaceId;
  }
  return actual.mode === "namespace" && expected.mode === "namespace"
    && actual.writableNamespaceId === expected.writableNamespaceId
    && actual.readableNamespaceIds.length === expected.readableNamespaceIds.length
    && actual.readableNamespaceIds.every((id, index) =>
      id === expected.readableNamespaceIds[index])
    && actual.mutableNamespaceIds.length === expected.mutableNamespaceIds.length
    && actual.mutableNamespaceIds.every((id, index) =>
      id === expected.mutableNamespaceIds[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((id, index) => id === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactAccessAuthority(
  authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }>,
  source: Pick<ProtectedTaskMemoryAccessSource, "requiredNamespaceIds">,
  destination: ProtectedTaskMemoryAccessDestination,
): Extract<ProtectedMemoryAuthority, { mode: "namespace" }> {
  const readableNamespaceIds = Object.freeze([...new Set([
    ...source.requiredNamespaceIds,
    destination.namespaceId,
  ])].sort());
  return Object.freeze({
    mode: "namespace" as const,
    subjectUserId: authority.subjectUserId,
    agentId: authority.agentId,
    readableNamespaceIds,
    mutableNamespaceIds: Object.freeze([destination.namespaceId]),
    writableNamespaceId: destination.namespaceId,
  });
}

function recoveredExactAccessPlan(input: Readonly<{
  operationId: string;
  source: Omit<ProtectedTaskMemoryAccessSource, "type" | "content">;
  destination: ProtectedTaskMemoryAccessDestination;
}>): ForegroundAgentMemoryNativeExactAccessPlan | null {
  const currentNamespaceIds = Object.freeze([
    ...input.source.requiredNamespaceIds,
  ].sort());
  if (currentNamespaceIds.length === 0
    || new Set(currentNamespaceIds).size !== currentNamespaceIds.length
    || currentNamespaceIds.includes(input.destination.namespaceId)) return null;
  const targetNamespaceIds = Object.freeze([
    ...currentNamespaceIds,
    input.destination.namespaceId,
  ].sort());
  return Object.freeze({
    operationId: input.operationId,
    memoryId: input.source.memoryId,
    cryptoObjectId: input.source.cryptoObjectId,
    expectedContentRevision: input.source.contentRevision,
    expectedCryptoAccessRevision: input.source.cryptoAccessRevision,
    nextCryptoAccessRevision: input.source.cryptoAccessRevision + 1,
    anchorNamespaceId: currentNamespaceIds[0]!,
    currentNamespaceIds,
    targetNamespaceIds,
    addedNamespaceIds: Object.freeze([input.destination.namespaceId]),
    removedNamespaceIds: Object.freeze([]),
    currentRequiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces(currentNamespaceIds),
    targetRequiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces(targetNamespaceIds),
    productMutation: Object.freeze({
      kind: "grant_namespace" as const,
      namespaceId: input.destination.namespaceId,
    }),
  });
}

function exactAccessPlan(
  plan: ForegroundAgentMemoryNativeExactAccessPlan,
  source: Omit<ProtectedTaskMemoryAccessSource, "type" | "content">,
  destination: ProtectedTaskMemoryAccessDestination,
): boolean {
  const currentNamespaceIds = [...source.requiredNamespaceIds].sort();
  const targetNamespaceIds = [...new Set([
    ...currentNamespaceIds,
    destination.namespaceId,
  ])].sort();
  const addedNamespaceIds = currentNamespaceIds.includes(
    destination.namespaceId,
  ) ? [] : [destination.namespaceId];
  return currentNamespaceIds.length > 0
    && new Set(currentNamespaceIds).size === currentNamespaceIds.length
    && plan.memoryId === source.memoryId
    && plan.cryptoObjectId === source.cryptoObjectId
    && plan.expectedContentRevision === source.contentRevision
    && plan.expectedCryptoAccessRevision
      === source.cryptoAccessRevision
    && plan.nextCryptoAccessRevision === source.cryptoAccessRevision + 1
    && plan.anchorNamespaceId === currentNamespaceIds[0]
    && sameIds(plan.currentNamespaceIds, currentNamespaceIds)
    && sameIds(plan.targetNamespaceIds, targetNamespaceIds)
    && sameIds(plan.addedNamespaceIds, addedNamespaceIds)
    && plan.removedNamespaceIds.length === 0
    && sameBytes(plan.currentRequiredNamespaceFingerprint,
      fingerprintRequiredMemoryNamespaces(currentNamespaceIds))
    && sameBytes(plan.targetRequiredNamespaceFingerprint,
      fingerprintRequiredMemoryNamespaces(targetNamespaceIds))
    && plan.productMutation.kind === "grant_namespace"
    && plan.productMutation.namespaceId === destination.namespaceId;
}

/**
 * Open one callback-scoped native Task Memory repository. Entity custody and
 * prepared-handle ownership live for exactly the callback; every product read,
 * publication, and object write acquires its own bounded current authority.
 */
export async function withProtectedTaskNativeMemoryRepository<Value>(
  input: ProtectedTaskNativeMemoryRepositoryInput<Value>,
  overrides: Partial<Dependencies> = {},
): Promise<Value> {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  const authority: ProtectedMemoryAuthority = input.authority.mode === "scope"
    ? Object.freeze({ ...input.authority })
    : Object.freeze({
    mode: input.authority.mode,
    subjectUserId: input.authority.subjectUserId,
    agentId: input.authority.agentId,
    readableNamespaceIds: Object.freeze([
      ...input.authority.readableNamespaceIds,
    ]),
    mutableNamespaceIds: Object.freeze([
      ...input.authority.mutableNamespaceIds,
    ]),
    writableNamespaceId: input.authority.writableNamespaceId,
  });
  const policy = Object.freeze({
    mode: input.policy.mode,
    shadowBehavior: input.policy.shadowBehavior,
    revision: input.policy.revision,
  });
  const current = Object.freeze({ ...input.current,
    ...(input.current.scopeMemory === undefined ? {} : {
      scopeMemory: Object.freeze({
        binding: copyTaskScopeMemoryBinding(input.current.scopeMemory.binding),
        targetRoomId: input.current.scopeMemory.targetRoomId,
        workIdentity: input.current.scopeMemory.workIdentity,
      }),
    }),
  });
  const scope = current.scopeMemory?.binding;
  if (authority.mode === "scope"
    ? scope === undefined || scope.scopeId !== authority.scopeId
      || scope.originWritableNamespaceId !== authority.originWritableNamespaceId
    : scope !== undefined) {
    throw new TypeError("Protected native Task Memory Scope binding is unavailable");
  }
  const readableNamespaceIds = authority.mode === "namespace"
    ? authority.readableNamespaceIds : scope!.readableNamespaceIds;
  const productContext = Object.freeze({ ...input.product });
  const agentProductContext = Object.freeze({ ...input.agentProduct });
  const signer = Object.freeze({ ...input.signer });
  const signerIdentity = signer.signerPublication !== null
    ? { signerKeyId: signer.signerPublication.signerKeyId,
      publicKey: signer.signerPublication.signerPublicKey }
    : (() => {
      const temporary = signer.temporarySigner;
      if (temporary === undefined) throw new TypeError("Task Memory signer proof is unavailable");
      return { signerKeyId: agentRuntimeObjectSignerKeyIdV1(current.crypto, temporary.signerPublicKey),
        publicKey: temporary.signerPublicKey };
    })();
  const domains = Object.freeze([...input.domains]);
  const owner = input.owner;
  const embedding = input.embedding;
  const resolveHistoricalSignerPublicationManager =
    input.resolveHistoricalSignerPublicationManager;
  const execute = input.execute;
  if (productContext.handle.role !== "nautilo"
    || productContext.canonicalRunner !== current.runner
    || agentProductContext.handle.role !== "nautilo_agent"
    || authority.subjectUserId !== current.subject.userId
    || authority.agentId !== current.occurrence.task.agentId
    || authority.agentId !== current.evidence.result.signerAgentId
    || signer.runtime.agentId !== authority.agentId
    || (signer.signerPublication !== null
      && signer.signerPublication.agentId !== authority.agentId)) {
    throw new TypeError("Protected native Task Memory identity is unavailable");
  }
  const representation = selectLiveEncryptionRepresentationPolicy(
    policy,
  );
  if (representation.write === "ordinary_only") {
    throw new TypeError("Protected native Task Memory policy is unavailable");
  }
  const protectedPolicy = Object.freeze({
    mode: policy.mode === "shadow_encryption"
      ? "shadow_encryption" as const
      : "encrypted_only" as const,
    shadowBehavior: policy.shadowBehavior,
    revision: policy.revision,
  });

  const assertCurrentTaskAuthority = async (): Promise<void> => {
    const result = await dependencies.withCurrentAuthority(
      current,
      async held => {
        await held.assertCurrent();
        return samePolicy(held.policy, policy);
      },
    );
    if (result !== true) {
      throw new TypeError("Protected native Task Memory authority is unavailable");
    }
  };

  return dependencies.withEntityCrypto({
    restricted: current.restricted,
    crypto: current.crypto,
    serverScope: current.serverScope,
    evidence: current.evidence,
    domains,
    signal: current.signal,
    assertCurrentTaskAuthority,
    execute: async entities => {
      const scopedCurrent = Object.freeze({
        ...current,
        signal: entities.signal,
      });
      const readNativeObject = async (request: Readonly<{
        objectId: string;
        expectedObjectType: string;
        expectedAccessRevision?: number;
        expectedNamespaceIds: readonly string[];
      }>) => {
        const result = await dependencies.withCurrentAuthority(
          scopedCurrent,
          async held => {
            const binding = dependencies.requireHeldWriterAuthority(held);
            await binding.assertCurrent();
            const domainKeys = dependencies.createDomainKeys(
              binding.restricted,
              binding.crypto,
              current.serverScope,
            );
            const history = dependencies.createSignerHistory({
              handle: binding.restrictedHandle,
              crypto: binding.crypto,
            });
            const value = await dependencies.readObject({
              handle: binding.restrictedHandle,
              crypto: binding.crypto,
              ...request,
              resolveHistoricalAgentSignerAuthority:
                history.resolveAgentRuntimeSignerManager,
              resolveLiveShadowAgentSigner:
                dependencies.foregroundAgentAcceptedExecutionSigner({
                  crypto: binding.crypto,
                  resolveEvidence: dependencies
                    .createForegroundAgentAcceptedExecutionEvidenceResolver({
                      product: binding.productHandle,
                      crypto: binding.crypto,
                      rejectInvalidSelectedEvidence: true,
                    }),
                }),
              resolveNativeNamespaceEntries: coordinates =>
                dependencies.resolveNativeEntries(domainKeys, coordinates),
            });
            await binding.assertCurrent();
            return value;
          },
        );
        return result;
      };
      const session = dependencies.createSession({
        ...(scope === undefined ? {} : { scopeBinding: {
          scopeId: scope.scopeId,
          originWritableNamespaceId: scope.originWritableNamespaceId,
          readableNamespaceIds: scope.readableNamespaceIds,
        } }),
        subjectUserId: authority.subjectUserId,
        agentId: authority.agentId,
        evidence: current.evidence,
        crypto: current.crypto,
        entities,
        runtime: signer.runtime,
        signerPublication: signer.signerPublication,
        ...(signer.temporarySigner === undefined ? {} : {
          temporarySigner: signer.temporarySigner,
        }),
        resolveHistoricalSignerPublicationManager:
          resolveHistoricalSignerPublicationManager,
        agentAuthorizationRevision: signer.agentAuthorizationRevision,
        persist: ({ evidence, ...write }) => {
          if (evidence !== current.evidence) {
            throw new TypeError(
              "Protected native Task Memory evidence was substituted",
            );
          }
          return dependencies.persistObject(scopedCurrent, write);
        },
        read: readNativeObject,
      });
      const boundaries = dependencies.createBoundaries({
        authority,
        policy: protectedPolicy,
        current: scopedCurrent,
        ...(representation.write === "ordinary_and_protected"
          ? { readPreparedPayload: session.readPreparedPayload }
          : {}),
      });
      const mutationProduct = dependencies.createProduct({
        handle: agentProductContext.handle,
        canonicalRunner: agentProductContext.canonicalRunner,
        readableNamespaceIds,
        cryptoCompletion: session.completion,
        publication: boundaries.publication,
      });
      const repairExactCandidate = async (
        request: Parameters<NonNullable<
          ProtectedTaskMemoryRepositoryCompositionInput["repairExactCandidate"]
        >>[0],
      ): ReturnType<NonNullable<
        ProtectedTaskMemoryRepositoryCompositionInput["repairExactCandidate"]
      >> => {
        if (!representation.allowForwardRepair) {
          return Object.freeze({ status: "unavailable" as const,
            reason: "encryption_pending" as const });
        }
        if (!sameAuthority(request.authority, authority)
          || request.signal?.aborted === true) {
          return Object.freeze({ status: "unavailable" as const,
            reason: "authorization_required" as const });
        }
        const protectAndAttach = async (
          source: ForegroundMemoryRepairSource,
          attach: (objectId: string) => Promise<
            "attached" | "replayed" | "conflict" | null
          >,
        ): ReturnType<NonNullable<
          ProtectedTaskMemoryRepositoryCompositionInput["repairExactCandidate"]
        >> => {
          try {
            const protectedResult = await session.protectExactRepair({
              operationId: request.operationId,
              authority: request.authority,
              source,
              ...(request.signal === undefined
                ? {} : { signal: request.signal }),
            });
            if (protectedResult.status !== "verified") {
              return Object.freeze({ status: "unavailable" as const,
                reason: protectedResult.status === "waiting_for_authority"
                  ? "authorization_required" as const
                  : "integrity_failure" as const });
            }
            const attached = await attach(deriveMemoryCryptoObjectIdV1({
              memoryId: source.memory.id,
              contentRevision: source.targetContentRevision,
            }));
            if (attached === null || attached === "conflict") {
              return Object.freeze({ status: "unavailable" as const,
                reason: attached === null ? "authorization_required" as const
                  : "stale_revision" as const });
            }
            return Object.freeze({ status: "success" as const, value: {
              memoryId: source.memory.id,
              contentRevision: source.targetContentRevision,
            } });
          } finally {
            source.plaintextBytes?.fill(0);
            source.requestCommitment.fill(0);
          }
        };
        if (authority.mode === "namespace") {
          const source = await dependencies.reserveNamespaceRepair(
            scopedCurrent, authority, request.selection,
          );
          if (source === null) {
            return Object.freeze({ status: "unavailable" as const,
              reason: "authorization_required" as const });
          }
          return protectAndAttach(source, objectId =>
            dependencies.attachNamespaceRepair(
              scopedCurrent, authority, source, objectId,
            ));
        }
        const adopted = await dependencies.adoptScopeOrigin(
          scopedCurrent, request.selection.memoryId,
        );
        if (adopted === "stale") {
          return Object.freeze({ status: "unavailable" as const,
            reason: "authorization_required" as const });
        }
        const source = await dependencies.reserveScopeRepair(
          scopedCurrent, request.selection,
        );
        if (source === null) {
            return Object.freeze({ status: "unavailable" as const,
              reason: "authorization_required" as const });
        }
        return protectAndAttach(source.source, objectId =>
          dependencies.attachScopeRepair(
            scopedCurrent, source, objectId,
          ));
      };
      const read = Object.freeze({
        handle: productContext.handle,
        canonicalRunner: productContext.canonicalRunner,
        binding: boundaries.authority.mode === "namespace"
          ? { mode: "namespace" as const, authority: boundaries.authority }
          : { mode: "scope" as const, authority: boundaries.authority,
              readableNamespaceIds,
              coordinates: {
                taskId: current.occurrence.task.id,
                requesterUserId: current.subject.userId,
                agentId: authority.agentId,
                scopeId: scope!.scopeId,
                memoryRoomId: scope!.memoryRoomId,
                originWritableNamespaceId: scope!.originWritableNamespaceId,
              },
            },
        boundary: boundaries.read,
      }) satisfies ProtectedTaskMemoryRepositoryCompositionInput["read"];
      const reader = dependencies.createReader(read);
      const repository = dependencies.createRepository({
        subjectUserId: boundaries.authority.subjectUserId,
        agentId: boundaries.authority.agentId,
        entrypointId: "subagent.scope",
        read,
        reader,
        mutationProduct,
        crypto: session.session,
        owner,
        embedding,
        repairExactCandidate,
        fallbackOrdinary: boundaries.policy.mode === "shadow_encryption"
          && boundaries.policy.shadowBehavior === "fallback"
          ? dependencies.createFallback({
              current: scopedCurrent,
              policy: boundaries.policy,
              agentId: authority.agentId,
            })
          : request => Promise.resolve({
              status: "unavailable",
              reason: request.reason,
            }),
        signal: entities.signal,
      });
      const projection = dependencies.createProjection({
        authority: boundaries.authority,
        policy: protectedPolicy,
        current: scopedCurrent,
        agentAuthorizationRevision: signer.agentAuthorizationRevision,
        entities,
        session,
        sourceProduct: mutationProduct,
        product: agentProductContext,
        embedding,
      });
      const capsule = dependencies.createAccessCapsule({
        crypto: current.crypto,
        entities,
        namespaceId: current.occurrence.task.contentNamespaceId,
        identity: Object.freeze({
          kind: "protected_task_access_v1" as const,
          taskId: current.occurrence.task.id,
          taskRunId: current.occurrence.run.id,
          graphThreadId: current.occurrence.run.graphThreadId,
          subjectUserId: current.subject.userId,
          humanActorId: current.subject.humanActorId,
          agentId: current.occurrence.task.agentId,
          contentNamespaceId: current.occurrence.task.contentNamespaceId,
          policyRevision: policy.revision,
          agentAuthorizationRevision: signer.agentAuthorizationRevision,
        }),
      });
      const exactCrypto = dependencies.createExactCrypto({
        crypto: current.crypto,
        entities,
        runtime: signer.runtime,
        signerKeyId: signerIdentity.signerKeyId,
        agentAuthorizationRevision: signer.agentAuthorizationRevision,
        ...(signer.signerPublication === null ? {
          evidence: current.evidence,
          temporarySigner: signer.temporarySigner,
        } : {}),
        read: async request => {
          const value = await readNativeObject({
            ...request,
            expectedObjectType: MEMORY_OBJECT_TYPE,
          });
          return value?.nativeEntries === undefined
            ? null
            : Object.freeze({ ...value,
                nativeEntries: value.nativeEntries });
        },
      });
      const openAccessSource = async (request: Readonly<{
        authority: ProtectedMemoryAuthority;
        memoryId: string;
      }>): Promise<ProtectedTaskMemoryAccessSource | null> => {
        const fail = (
          reason: MemoryUnavailableReason,
        ): never => {
          throw new ClassifiedDataOperationError(
            reason === "encryption_pending"
              || reason === "target_encryption_not_ready"
              ? "recoverable_availability"
              : reason === "authorization_required" ? "authority"
                : reason === "stale_revision" || reason === "deleted"
                  ? "stale" : "integrity",
            reason,
          );
        };
        const loadCandidate = async (): Promise<ExactMemoryCandidate> => {
          const selected = await reader.loadExactCandidates({
            authority: request.authority,
            memoryIds: [request.memoryId],
            signal: entities.signal,
          });
          if (selected.status === "unavailable") {
            return fail(selected.reason);
          }
          const candidate = selected.value[0];
          if (selected.value.length !== 1
            || candidate?.memoryId !== request.memoryId) {
            return fail("integrity_failure");
          }
          return candidate;
        };
        const openProtected = async (
          candidate: ExactMemoryCandidate,
        ): Promise<ProtectedTaskMemoryAccessSource> => {
          if (candidate.representation === "ordinary_only") {
            return fail("encryption_pending");
          }
          const protectedCandidate: ExactProtectedMemoryCandidate = candidate;
          const opened = await session.session.openMany({
            entrypointId: "subagent.scope",
            agentId: authority.agentId,
            authority: request.authority,
            candidates: [protectedCandidate],
          });
          if (opened.status === "unavailable") {
            return fail(opened.reason);
          }
          const value = opened.value[0];
          const requiredNamespaceIds = Object.freeze([
            ...candidate.requiredNamespaceIds,
          ].sort());
          if (opened.value.length !== 1
            || value === undefined
            || value.memoryId !== candidate.memoryId
            || value.contentRevision !== candidate.contentRevision
            || requiredNamespaceIds.length === 0
            || new Set(requiredNamespaceIds).size
              !== requiredNamespaceIds.length) {
            return fail("integrity_failure");
          }
          return Object.freeze({
            memoryId: protectedCandidate.memoryId,
            contentRevision: protectedCandidate.contentRevision,
            cryptoAccessRevision: protectedCandidate.cryptoAccessRevision,
            cryptoObjectId: protectedCandidate.cryptoObjectId,
            requiredNamespaceIds,
            payloadDigest: Buffer.from(commitMemoryMutationV1({
              kind: "save",
              payload: { formatVersion: 1, type: value.type,
                content: value.content },
            })).toString("hex"),
            type: value.type,
            content: value.content,
          });
        };
        try {
          const selected = await owner.read<never,
            ProtectedTaskMemoryAccessSource,
            ProtectedTaskMemoryAccessSource>({
              ordinary: () => Promise.reject(new ClassifiedDataOperationError(
                "recoverable_availability",
                "encryption_pending",
              )),
              protected: async () => openProtected(await loadCandidate()),
              repair: {
                forward: async () => {
                  const candidate = await loadCandidate();
                  if (candidate.representation !== "ordinary_only") {
                    return openProtected(candidate);
                  }
                  const repaired = await repairExactCandidate({
                    operationId: `task-memory-access-repair:${
                      current.occurrence.run.id}:${candidate.memoryId}:${
                      candidate.contentRevision}`,
                    authority: request.authority,
                    selection: Object.freeze({
                      memoryId: candidate.memoryId,
                      contentRevision: candidate.contentRevision,
                      score: candidate.score,
                      repairRequired: true,
                      repair: Object.freeze({
                        id: candidate.memoryId,
                        type: null,
                        importance: candidate.importance,
                        tier: candidate.tier,
                        createdAt: new Date(candidate.createdAt),
                        score: candidate.score,
                        representation: "structural" as const,
                      }),
                    }),
                    signal: entities.signal,
                  });
                  if (repaired.status === "unavailable") {
                    return fail(repaired.reason);
                  }
                  if (repaired.value === undefined
                    || repaired.value.memoryId !== request.memoryId) {
                    fail("integrity_failure");
                  }
                  const currentCandidate = await loadCandidate();
                  if (currentCandidate.representation === "ordinary_only"
                    || currentCandidate.contentRevision
                      !== repaired.value.contentRevision) {
                    fail("stale_revision");
                  }
                  return openProtected(currentCandidate);
                },
              },
              consumeOrdinary: () => fail("integrity_failure"),
              consumeProtected: value => value,
            });
          return selected.value;
        } catch (error) {
          if (error instanceof ClassifiedDataOperationError) return null;
          throw error;
        }
      };
      const productFor = (
        source: Omit<ProtectedTaskMemoryAccessSource, "type" | "content">,
        destination: ProtectedTaskMemoryAccessDestination,
        handle: string,
        assertCurrentAuthority?: () => Promise<void>,
      ) => {
        if (boundaries.authority.mode !== "namespace") return null;
        const operationAuthority = exactAccessAuthority(
          boundaries.authority,
          source,
          destination,
        );
        const product = dependencies.createExactProduct({
          handle: agentProductContext.handle,
          readableNamespaceIds: operationAuthority.readableNamespaceIds,
          resolveGrantUserNamespace: ({ authority: candidate,
            userHandle }) => Promise.resolve(
              sameAuthority(candidate, operationAuthority)
                && userHandle === handle ? destination.namespaceId : null,
            ),
          ...(assertCurrentAuthority === undefined
            ? {} : { assertCurrentAuthority }),
        });
        return Object.freeze({ authority: operationAuthority, product });
      };
      const persistExactUnderHeld = async (
        held: HeldProtectedTaskMemoryAuthority,
        publication: Parameters<Dependencies["persistExact"]>[0]["publication"],
      ) => {
        const binding = dependencies.requireHeldWriterAuthority(held);
        await binding.assertCurrent();
        const history = dependencies.createSignerHistory({
          handle: binding.restrictedHandle,
          crypto: binding.crypto,
        });
        if (signer.signerPublication === null) {
          if (publication.signerEvidenceBytes === undefined
            || !sameBytes(
              publication.signerEvidenceBytes,
              signer.temporarySigner.certificateBytes,
            )) {
            throw new TypeError(
              "Protected Task Memory exact-access signer proof was substituted",
            );
          }
        } else if (publication.signerEvidenceBytes !== undefined) {
          throw new TypeError(
            "Protected Task Memory exact-access has unexpected signer proof",
          );
        }
        const persisted = await dependencies.persistExact({
          handle: binding.restrictedHandle,
          crypto: binding.crypto,
          publication,
          resolveHistoricalAgentSignerAuthority:
            history.resolveAgentRuntimeSignerManager,
          resolveLiveShadowAgentSigner:
            dependencies.foregroundAgentAcceptedExecutionSigner({
              crypto: binding.crypto,
              resolveEvidence: dependencies
                .createForegroundAgentAcceptedExecutionEvidenceResolver({
                  product: binding.productHandle,
                  crypto: binding.crypto,
                  rejectInvalidSelectedEvidence: true,
                }),
            }),
          resolveCurrentAgentSigner: principal =>
            principal.agentId === signer.runtime.agentId
              && principal.runtimeGeneration === signer.runtime.generation
              && principal.signerKeyId
                === signerIdentity.signerKeyId
              ? signerIdentity.publicKey.slice()
              : null,
        });
        await binding.assertCurrent();
        return persisted;
      };
      const withCurrentAccessCommit = async <Value>(
        destination: ProtectedTaskMemoryAccessDestination,
        commit: (held: HeldProtectedTaskMemoryAuthority) => Promise<Value>,
      ): Promise<Value | null> => dependencies.withCurrentAuthority(
        scopedCurrent,
        async held => {
          await held.assertCurrent();
          if (!await dependencies.assertHeldAccessNamespace(
            held,
            {
              requesterUserId: scopedCurrent.subject.userId,
              requesterActorId: scopedCurrent.subject.humanActorId,
              humanActorIds: destination.humanActorIds,
            },
            destination,
          )) return null;
          const result = await commit(held);
          await held.assertCurrent();
          return result;
        },
      );
      const unavailableAccessCommit = () => Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      const access = dependencies.createAccess({
        authority: boundaries.authority,
        current: scopedCurrent,
        capsule,
        openSource: openAccessSource,
        resolveTarget: async request => {
          const normalizedHandle = request.normalizedHandle.trim()
            .replace(/^@/u, "").toLowerCase();
          if (normalizedHandle.length === 0) return null;
          const target = await dependencies.findActorByHandle(normalizedHandle);
          if (target === null || target.kind !== "user"
            || target.actorId === request.requesterActorId) return null;
          const actor = await dependencies.findActorById(target.actorId);
          return actor?.ownerId === undefined ? null : Object.freeze({
            userId: actor.ownerId,
            actorId: target.actorId,
            normalizedHandle,
          });
        },
        reserveDestination: async request => {
          const resolved = await dependencies.resolveAccessNamespace(
            scopedCurrent,
            {
              requesterUserId: request.requesterUserId,
              requesterActorId: request.requesterActorId,
              humanActorIds: Object.freeze([
                request.requesterActorId,
                request.target.actorId,
              ].sort()),
            },
          );
          return resolved === null ? null : Object.freeze({
            roomId: resolved.roomId,
            namespaceId: resolved.namespaceId,
            humanActorIds: Object.freeze([
              request.requesterActorId,
              request.target.actorId,
            ].sort()),
          });
        },
        findDestination: async request => {
          const humanActorIds = Object.freeze([
            request.requesterActorId,
            request.target.actorId,
          ].sort());
          const resolved = await dependencies.findAccessNamespace(
            scopedCurrent,
            {
              requesterUserId: request.requesterUserId,
              requesterActorId: request.requesterActorId,
              humanActorIds,
            },
          );
          return resolved === null ? null : Object.freeze({
            roomId: resolved.roomId,
            namespaceId: resolved.namespaceId,
            humanActorIds,
          });
        },
        planProduct: async request => {
          const selected = productFor(request.source, request.destination,
            request.request.action.userHandle);
          if (selected === null) return Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_required" as const,
          });
          const planned = await selected.product.planNativeChange({
            operationId: request.request.operationId,
            authority: selected.authority,
            memoryId: request.source.memoryId,
            action: request.request.action,
          });
          if (planned.status === "unavailable") return planned;
          if (!exactAccessPlan(planned.value.plan, request.source,
            request.destination)) return Object.freeze({
            status: "unavailable" as const,
            reason: "integrity_failure" as const,
          });
          return Object.freeze({ status: "success" as const,
            value: Object.freeze({ status: planned.value.status,
              plan: planned.value.plan }) });
        },
        inspectRecovery: async request => {
          const plan = recoveredExactAccessPlan({
            operationId: request.request.operationId,
            source: request.source,
            destination: request.destination,
          });
          if (plan === null) return null;
          const selected = productFor(request.source, request.destination,
            request.request.action.userHandle);
          if (selected === null) return Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_required" as const,
          });
          const prepared = await exactCrypto.prepare({
            objectId: plan.cryptoObjectId,
            expectedAccessRevision: plan.nextCryptoAccessRevision,
            currentNamespaceIds: plan.targetNamespaceIds,
            targetNamespaceIds: plan.targetNamespaceIds,
          });
          if (prepared === null) return null;
          const inspected = await exactCrypto.authorizeCurrentHead({
            prepared,
            commit: head => selected.product.inspectNativeCommitted({
              authority: selected.authority,
              plan,
              head,
            }),
          });
          if (inspected.status === "unavailable") return inspected;
          const payload = exactCrypto.readPreparedPayload(prepared);
          const payloadDigest = Buffer.from(commitMemoryMutationV1({
            kind: "save",
            payload,
          })).toString("hex");
          if (payloadDigest !== request.source.payloadDigest) {
            return Object.freeze({ status: "unavailable" as const,
              reason: "integrity_failure" as const });
          }
          return Object.freeze({ status: "success" as const,
            value: Object.freeze({ status: inspected.value.status,
              plan,
              source: Object.freeze({ ...request.source,
                type: payload.type, content: payload.content }) }) });
        },
        commit: async request => {
          const selected = productFor(request.source, request.destination,
            request.request.action.userHandle);
          if (selected === null
            || !exactAccessPlan(request.plan, request.source,
              request.destination)) return Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_required" as const,
          });
          const prepared = await exactCrypto.prepare({
            objectId: request.plan.cryptoObjectId,
            expectedAccessRevision: request.plan.expectedCryptoAccessRevision,
            currentNamespaceIds: request.plan.currentNamespaceIds,
            targetNamespaceIds: request.plan.targetNamespaceIds,
          });
          if (prepared === null) {
            const current = await exactCrypto.prepare({
              objectId: request.plan.cryptoObjectId,
              expectedAccessRevision:
                request.plan.nextCryptoAccessRevision,
              currentNamespaceIds: request.plan.targetNamespaceIds,
              targetNamespaceIds: request.plan.targetNamespaceIds,
            });
            if (current === null) return Object.freeze({
              status: "unavailable" as const,
              reason: "stale_revision" as const,
            });
            return exactCrypto.authorizeCurrentHead({
              prepared: current,
              commit: async head => (await withCurrentAccessCommit(
                request.destination,
                held => {
                  const guarded = productFor(
                    request.source,
                    request.destination,
                    request.request.action.userHandle,
                    () => held.assertCurrent(),
                  );
                  return guarded === null
                    ? Promise.resolve(unavailableAccessCommit())
                    : guarded.product.recoverNativeCommitted({
                        authority: guarded.authority,
                        plan: request.plan,
                        head,
                      });
                },
              )) ?? unavailableAccessCommit(),
            });
          }
          if (sameIds(request.plan.currentNamespaceIds,
            request.plan.targetNamespaceIds)) {
            return exactCrypto.authorizeCurrentHead({
              prepared,
              commit: () => Promise.resolve(Object.freeze({
                status: "success" as const,
                value: Object.freeze({ status: "unchanged" as const,
                  memoryId: request.source.memoryId }),
              })),
            });
          }
          return exactCrypto.authorizeCommit({
            prepared,
            commit: async publication => (await withCurrentAccessCommit(
              request.destination,
              held => {
                const guarded = productFor(
                  request.source,
                  request.destination,
                  request.request.action.userHandle,
                  () => held.assertCurrent(),
                );
                return guarded === null
                  ? Promise.resolve(unavailableAccessCommit())
                  : guarded.product.commitNativePrepared({
                      authority: guarded.authority,
                      plan: request.plan,
                      publication,
                      persist: () => persistExactUnderHeld(held, publication),
                    });
              },
            )) ?? unavailableAccessCommit(),
          });
        },
      });
      return execute(repository, projection, access);
    },
  });
}
