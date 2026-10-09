import {
  commitForegroundMemoryOrdinaryFallback,
  MemoryMutationAuthorityError,
  type ForegroundMemoryOrdinaryFallbackInput,
} from "@nautilo/agent";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "@nautilo/lattice-bridge";
import type {
  CurrentProtectedTaskMemoryPolicy,
} from "./current-protected-task-memory-authority";
import type {
  ProtectedTaskMemoryRepositoryCompositionInput,
} from "./protected-task-memory-composition";
import {
  withCurrentProtectedTaskMemoryOrdinaryFallback,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";

type OrdinaryFallback =
  ProtectedTaskMemoryRepositoryCompositionInput["fallbackOrdinary"];

type Dependencies = Readonly<{
  withCurrent: typeof withCurrentProtectedTaskMemoryOrdinaryFallback;
  commit: typeof commitForegroundMemoryOrdinaryFallback;
}>;

const productionDependencies: Dependencies = Object.freeze({
  withCurrent: withCurrentProtectedTaskMemoryOrdinaryFallback,
  commit: commitForegroundMemoryOrdinaryFallback,
});

function exactMutationAuthority(input: Parameters<OrdinaryFallback>[0]): boolean {
  const { authority, plan } = input;
  if (plan.requiredNamespaceIds.length === 0
    || plan.requiredNamespaceIds.some((id, index, ids) =>
      index > 0 && ids[index - 1]! >= id)) return false;
  if (authority.mode === "scope") {
    return plan.requiredNamespaceIds.length === 1
      && plan.requiredNamespaceIds[0] === authority.originWritableNamespaceId;
  }
  return plan.requiredNamespaceIds.every(id =>
    authority.mutableNamespaceIds.includes(id))
    && (plan.action !== "created"
      || (authority.writableNamespaceId !== null
        && plan.requiredNamespaceIds.length === 1
        && plan.requiredNamespaceIds[0] === authority.writableNamespaceId));
}

function supportedEmbeddingProvider(
  value: string,
): value is "openai" | "openrouter" | "venice" {
  return value === "openai" || value === "openrouter" || value === "venice";
}

/**
 * Create the ordinary Shadow fallback owned by one current protected Task.
 * The fallback reuses the Agent semantic mutation and its canonical product
 * transaction while the Task publication owner remains held around commit.
 */
export function createProtectedTaskMemoryOrdinaryFallback(
  input: Readonly<{
    current: ProtectedTaskMemoryAuthorityInput;
    policy: CurrentProtectedTaskMemoryPolicy;
    agentId: string;
  }>,
  overrides: Partial<Dependencies> = {},
): OrdinaryFallback {
  if (input.policy.mode !== "shadow_encryption"
    || input.policy.shadowBehavior !== "fallback") {
    throw new TypeError("Protected Task ordinary Memory fallback is unavailable");
  }
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  return async request => {
    if (request.authority.agentId !== input.agentId
      || !exactMutationAuthority(request)) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
    }
    const embeddingProvider = request.embedding.provider;
    if (!supportedEmbeddingProvider(embeddingProvider)) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: request.reason,
      });
    }
    const { authority, plan, content, embedding, reason } = request;
    const mutation: ForegroundMemoryOrdinaryFallbackInput = {
      operationId: plan.operationId,
      agentId: input.agentId,
      memoryId: plan.memoryId,
      expectedContentRevision: plan.contentRevision - 1,
      resultContentRevision: plan.contentRevision,
      expectedAccessRevision: plan.expectedPriorAccessRevision,
      expectedCryptoObjectId: plan.contentRevision === 1
        ? null
        : deriveMemoryCryptoObjectIdV1({
            memoryId: plan.memoryId,
            contentRevision: plan.contentRevision - 1,
          }),
      expectedRequiredNamespaceFingerprint: plan.contentRevision === 1
        ? null
        : fingerprintRequiredMemoryNamespaces(plan.requiredNamespaceIds),
      reservationDigest: plan.reservationDigest,
      reservedCryptoObjectId: plan.cryptoObjectId,
      action: content.kind === "complete" ? "save" : "replace",
      ...(content.kind === "complete"
        ? {
            type: content.payload.type,
            content: content.payload.content,
            expectedDedupId: plan.action === "updated"
              ? plan.memoryId : null,
          }
        : { content: content.content }),
      ...(authority.mode === "scope"
        ? { scope: {
            subjectUserId: authority.subjectUserId,
            scopeId: authority.scopeId,
            originWritableNamespaceId: authority.originWritableNamespaceId,
          } }
        : {
            ...(authority.writableNamespaceId === null
              ? {}
              : { namespaceId: authority.writableNamespaceId }),
            expectedNamespaceIds: plan.requiredNamespaceIds,
          }),
      importance: plan.importance,
      embedding: embedding.vector,
      embeddingProvider,
      embeddingModel: embedding.canonicalModel,
      embeddingDimensions: embedding.dimensions,
      embeddingContractVersion: embedding.contractVersion,
      reason,
    };
    try {
      const value = await dependencies.withCurrent(
        input.current,
        authority,
        transaction => dependencies.commit(transaction, mutation),
      );
      if (value === null) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        });
      }
      return Object.freeze({
        status: "success" as const,
        value,
        fallbackReason: reason,
      });
    } catch (error) {
      if (error instanceof MemoryMutationAuthorityError) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: error.reason === "source_changed"
            ? "stale_revision" as const
            : "authorization_required" as const,
        });
      }
      throw error;
    }
  };
}
