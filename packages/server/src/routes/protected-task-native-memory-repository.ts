import type { DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import type {
  ResolveHistoricalAgentRuntimeSignerPublicationManager,
} from "@nautilo/lattice-crypto";
import {
  selectLiveEncryptionRepresentationPolicy,
  type EncryptionDataOperationOwner,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
  type ProtectedTaskResultSignerAuthority,
} from "@nautilo/lattice-bridge";
import {
  copyTaskScopeMemoryBinding,
  PostgresAgentMemoryProductPort,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  readVerifiedDeviceWrappedAgentObject,
  withNativeTaskMemoryEntityCrypto,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  createTaskRuntimeDomainMemoryCryptoSession,
} from "@nautilo/runtime";

import {
  adoptProtectedTaskScopeMemoryOrigin,
  requireHeldProtectedTaskMemoryWriterAuthority,
  withCurrentProtectedTaskMemoryAuthority,
  type CurrentProtectedTaskMemoryPolicy,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";
import {
  createProtectedTaskMemoryBoundaries,
  type ProtectedTaskMemoryBoundariesInput,
} from "./protected-task-memory-boundaries";
import {
  createProtectedTaskMemoryRepository,
  type ProtectedTaskMemoryRepositoryCompositionInput,
} from "./protected-task-memory-composition";
import {
  persistProtectedTaskMemoryObject,
} from "./protected-task-memory-object-writer";
import {
  resolveForegroundMemoryNativeEntries,
} from "./foreground-memory-repository";

type ProductContext = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
}>;

export type ProtectedTaskNativeMemoryRepositoryInput<Value> = Readonly<{
  authority: ProtectedMemoryAuthority;
  policy: ProtectedTaskMemoryBoundariesInput["policy"];
  current: ProtectedTaskMemoryAuthorityInput;
  domains: readonly DomainForegroundSecretEntry[];
  signer: ProtectedTaskResultSignerAuthority;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  product: ProductContext;
  agentProduct: ProductContext;
  owner: EncryptionDataOperationOwner;
  embedding: ProtectedAgentMemoryEmbeddingPort;
  repairExactCandidate:
    ProtectedTaskMemoryRepositoryCompositionInput["repairExactCandidate"];
  fallbackOrdinary:
    ProtectedTaskMemoryRepositoryCompositionInput["fallbackOrdinary"];
  execute(repository: ProtectedAgentMemoryRepository): Promise<Value>;
}>;

type Dependencies = Readonly<{
  withCurrentAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  adoptScopeOrigin: typeof adoptProtectedTaskScopeMemoryOrigin;
  withEntityCrypto: typeof withNativeTaskMemoryEntityCrypto;
  createSession: typeof createTaskRuntimeDomainMemoryCryptoSession;
  createBoundaries: typeof createProtectedTaskMemoryBoundaries;
  createRepository: typeof createProtectedTaskMemoryRepository;
  persistObject: typeof persistProtectedTaskMemoryObject;
  requireHeldWriterAuthority:
    typeof requireHeldProtectedTaskMemoryWriterAuthority;
  createProduct(input: ConstructorParameters<
    typeof PostgresAgentMemoryProductPort
  >[0]): PostgresAgentMemoryProductPort;
  readObject: typeof readVerifiedDeviceWrappedAgentObject;
  createDomainKeys(
    ...input: ConstructorParameters<typeof PostgresDomainKeyAuthorityRepository>
  ): PostgresDomainKeyAuthorityRepository;
  createSignerHistory(
    input: ConstructorParameters<typeof PostgresHumanDeviceSignerHistory>[0],
  ): PostgresHumanDeviceSignerHistory;
  resolveNativeEntries: typeof resolveForegroundMemoryNativeEntries;
}>;

const productionDependencies: Dependencies = Object.freeze({
  withCurrentAuthority: withCurrentProtectedTaskMemoryAuthority,
  adoptScopeOrigin: adoptProtectedTaskScopeMemoryOrigin,
  withEntityCrypto: withNativeTaskMemoryEntityCrypto,
  createSession: createTaskRuntimeDomainMemoryCryptoSession,
  createBoundaries: createProtectedTaskMemoryBoundaries,
  createRepository: createProtectedTaskMemoryRepository,
  persistObject: persistProtectedTaskMemoryObject,
  requireHeldWriterAuthority:
    requireHeldProtectedTaskMemoryWriterAuthority,
  createProduct: input => new PostgresAgentMemoryProductPort(input),
  readObject: readVerifiedDeviceWrappedAgentObject,
  createDomainKeys: (...input) =>
    new PostgresDomainKeyAuthorityRepository(...input),
  createSignerHistory: input => new PostgresHumanDeviceSignerHistory(input),
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
  const domains = Object.freeze([...input.domains]);
  const owner = input.owner;
  const embedding = input.embedding;
  const repairExactCandidate = input.repairExactCandidate;
  const fallbackOrdinary = input.fallbackOrdinary;
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
    || signer.signerPublication.agentId !== authority.agentId) {
    throw new TypeError("Protected native Task Memory identity is unavailable");
  }
  const representation = selectLiveEncryptionRepresentationPolicy(
    policy,
  );
  if (representation.write === "ordinary_only") {
    throw new TypeError("Protected native Task Memory policy is unavailable");
  }

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
        read: async request => {
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
                resolveNativeNamespaceEntries: coordinates =>
                  dependencies.resolveNativeEntries(domainKeys, coordinates),
              });
              await binding.assertCurrent();
              return value;
            },
          );
          return result;
        },
      });
      const boundaries = dependencies.createBoundaries({
        authority,
        policy,
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
      const repository = dependencies.createRepository({
        subjectUserId: boundaries.authority.subjectUserId,
        agentId: boundaries.authority.agentId,
        entrypointId: "subagent.scope",
        read: {
          handle: productContext.handle,
          canonicalRunner: productContext.canonicalRunner,
          binding: boundaries.authority.mode === "namespace"
            ? { mode: "namespace", authority: boundaries.authority }
            : { mode: "scope", authority: boundaries.authority,
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
        },
        mutationProduct,
        crypto: session.session,
        owner,
        embedding,
        repairExactCandidate: authority.mode === "namespace"
          ? repairExactCandidate
          : async request => {
              if (!representation.allowForwardRepair) {
                return Object.freeze({ status: "unavailable" as const,
                  reason: "encryption_pending" as const });
              }
              if (request.authority.mode !== "scope"
                || request.authority.scopeId !== authority.scopeId
                || request.authority.subjectUserId !== authority.subjectUserId
                || request.authority.agentId !== authority.agentId
                || request.authority.originWritableNamespaceId
                  !== authority.originWritableNamespaceId
                || request.signal?.aborted === true) {
                return Object.freeze({ status: "unavailable" as const,
                  reason: "authorization_required" as const });
              }
              const adopted = await dependencies.adoptScopeOrigin(
                scopedCurrent, request.selection.memoryId,
              );
              if (adopted === "stale") {
                return Object.freeze({ status: "unavailable" as const,
                  reason: "authorization_required" as const });
              }
              return repairExactCandidate(request);
            },
        fallbackOrdinary,
        signal: entities.signal,
      });
      return execute(repository);
    },
  });
}
