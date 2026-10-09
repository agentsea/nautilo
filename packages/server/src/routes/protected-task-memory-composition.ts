import {
  createInvocationBoundProtectedAgentMemoryRepository,
  type EncryptionDataOperationOwner,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryProductPort,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";
import {
  PostgresTaskMemoryReadPort,
  type ProtectedTaskMemoryReadPort,
  type TaskMemoryReadBinding,
  type TaskMemoryReadBoundary,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";

type CreateRepositoryInput = Parameters<
  typeof createInvocationBoundProtectedAgentMemoryRepository
>[0];

type ExactTaskMemoryRepair = (
  input: Parameters<CreateRepositoryInput["repairExactCandidate"]>[0],
) => Promise<
  ProtectedMemoryResult<Readonly<{
    memoryId: string;
    contentRevision: number;
  }>>
>;

export type ProtectedTaskMemoryReadComposition = Readonly<{
  handle: ConversationProductPostgresHandle;
  canonicalRunner: ConversationProductCanonicalTransactionRunner;
  binding: TaskMemoryReadBinding;
  boundary: TaskMemoryReadBoundary;
}>;

export type ProtectedTaskMemoryRepositoryCompositionInput = Readonly<{
  subjectUserId: string;
  agentId: string;
  entrypointId: CreateRepositoryInput["entrypointId"];
  read: ProtectedTaskMemoryReadComposition;
  /** Bound to the Agent product role; it remains the semantic mutation owner. */
  mutationProduct: ProtectedAgentMemoryProductPort;
  crypto: ProtectedAgentMemoryCryptoSessionPort;
  owner: EncryptionDataOperationOwner;
  embedding: ProtectedAgentMemoryEmbeddingPort;
  /** Returns the exact current revision established by authorized repair. */
  repairExactCandidate: ExactTaskMemoryRepair;
  fallbackOrdinary: CreateRepositoryInput["fallbackOrdinary"];
  signal?: AbortSignal;
}>;

type Dependencies = Readonly<{
  createReader(
    input: ConstructorParameters<typeof PostgresTaskMemoryReadPort>[0],
  ): ProtectedTaskMemoryReadPort;
  createRepository: typeof createInvocationBoundProtectedAgentMemoryRepository;
}>;

const productionDependencies: Dependencies = Object.freeze({
  createReader: input => new PostgresTaskMemoryReadPort(input),
  createRepository: createInvocationBoundProtectedAgentMemoryRepository,
});

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function sameTarget(
  expected: ProtectedMemoryMutationTarget,
  current: ProtectedMemoryCandidate,
): boolean {
  return expected.memoryId === current.memoryId
    && expected.contentRevision === current.contentRevision
    && expected.cryptoAccessRevision === current.cryptoAccessRevision
    && expected.cryptoObjectId === current.cryptoObjectId
    && sameIds(expected.requiredNamespaceIds, current.requiredNamespaceIds);
}

function sameCandidate(
  expected: ProtectedMemoryCandidate,
  current: ProtectedMemoryCandidate,
): boolean {
  return sameTarget(expected, current)
    && expected.readNamespaceId === current.readNamespaceId;
}

function unavailable<Value>(
  reason: Extract<
    ProtectedMemoryResult<never>,
    { status: "unavailable" }
  >["reason"],
): ProtectedMemoryResult<Value> {
  return Object.freeze({
    status: "unavailable" as const,
    reason,
  });
}

function success<Value>(value: Value): ProtectedMemoryResult<Value> {
  return Object.freeze({ status: "success" as const, value });
}

async function validateCurrentSources<
  Target extends ProtectedMemoryMutationTarget,
>(
  reader: ProtectedTaskMemoryReadPort,
  authority: ProtectedMemoryAuthority,
  targets: readonly Target[],
  compare: (
    expected: Target,
    current: ProtectedMemoryCandidate,
  ) => boolean,
  signal?: AbortSignal,
): Promise<ProtectedMemoryResult<void>> {
  if (targets.length === 0) return success(undefined);
  const memoryIds = [...targets.map(target => target.memoryId)].sort();
  if (new Set(memoryIds).size !== targets.length) {
    return unavailable("integrity_failure");
  }
  const result = await reader.loadExactProtectedSources({
    authority,
    memoryIds,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.status === "unavailable") return result;
  if (result.value.length !== targets.length) {
    return unavailable("stale_revision");
  }
  const byId = new Map(result.value.map(candidate => [
    candidate.memoryId,
    candidate,
  ]));
  return targets.every(target => {
    const candidate = byId.get(target.memoryId);
    return candidate !== undefined && compare(target, candidate);
  }) ? success(undefined) : unavailable("stale_revision");
}

function sourcesCurrent(
  reader: ProtectedTaskMemoryReadPort,
  authority: ProtectedMemoryAuthority,
  targets: readonly ProtectedMemoryMutationTarget[],
  signal?: AbortSignal,
): Promise<ProtectedMemoryResult<void>> {
  return validateCurrentSources(
    reader,
    authority,
    targets,
    sameTarget,
    signal,
  );
}

function candidatesCurrent(
  reader: ProtectedTaskMemoryReadPort,
  authority: ProtectedMemoryAuthority,
  candidates: readonly ProtectedMemoryCandidate[],
  signal?: AbortSignal,
): Promise<ProtectedMemoryResult<void>> {
  return validateCurrentSources(
    reader,
    authority,
    candidates,
    sameCandidate,
    signal,
  );
}

function mutationProductWithTaskReads(
  mutationProduct: ProtectedAgentMemoryProductPort,
  reader: ProtectedTaskMemoryReadPort,
): ProtectedAgentMemoryProductPort {
  const product: ProtectedAgentMemoryProductPort = {
    searchCandidates: request => reader.searchProtectedCandidates(request),
    replayCompleted: request => mutationProduct.replayCompleted(request),
    selectSaveCandidate: request => mutationProduct.selectSaveCandidate(request),
    planSave: request => mutationProduct.planSave(request),
    planReplace: request => mutationProduct.planReplace(request),
    publishPrepared: request => mutationProduct.publishPrepared(request),
    resolveTierTarget: request => mutationProduct.resolveTierTarget(request),
    commitTier: request => mutationProduct.commitTier(request),
  };
  return Object.freeze(product);
}

function cryptoWithCurrentTaskSources(
  crypto: ProtectedAgentMemoryCryptoSessionPort,
  reader: ProtectedTaskMemoryReadPort,
): ProtectedAgentMemoryCryptoSessionPort {
  const guarded: ProtectedAgentMemoryCryptoSessionPort = {
    async openMany(request) {
      const before = await candidatesCurrent(
        reader,
        request.authority,
        request.candidates,
        request.signal,
      );
      if (before.status === "unavailable") return before;
      const opened = await crypto.openMany(request);
      if (opened.status === "unavailable") return opened;
      const after = await candidatesCurrent(
        reader,
        request.authority,
        request.candidates,
        request.signal,
      );
      return after.status === "success" ? opened : after;
    },

    async prepare(request) {
      const sources = request.content.kind === "replacement"
        ? [request.content.previous]
        : [];
      const before = await sourcesCurrent(
        reader,
        request.authority,
        sources,
        request.signal,
      );
      if (before.status === "unavailable") return before;
      const prepared = await crypto.prepare(request);
      if (prepared.status === "unavailable" || sources.length === 0) {
        return prepared;
      }
      const after = await sourcesCurrent(
        reader,
        request.authority,
        sources,
        request.signal,
      );
      return after.status === "success" ? prepared : after;
    },

    authorizeCommit: request => crypto.authorizeCommit(request),
  };
  return Object.freeze(guarded);
}

/**
 * Bind protected Task Memory reads to the product role while preserving the
 * Agent role as the sole semantic mutation owner. Policy selection stays in
 * the central data-operation owner used by the repository.
 */
export function createProtectedTaskMemoryRepository(
  input: ProtectedTaskMemoryRepositoryCompositionInput,
  overrides: Partial<Dependencies> = {},
): ProtectedAgentMemoryRepository {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  const reader = dependencies.createReader(input.read);
  return dependencies.createRepository({
    subjectUserId: input.subjectUserId,
    agentId: input.agentId,
    entrypointId: input.entrypointId,
    embedding: input.embedding,
    product: mutationProductWithTaskReads(input.mutationProduct, reader),
    crypto: cryptoWithCurrentTaskSources(input.crypto, reader),
    owner: input.owner,
    fallbackSearch: reader,
    repairExactCandidate: input.repairExactCandidate,
    fallbackOrdinary: input.fallbackOrdinary,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
