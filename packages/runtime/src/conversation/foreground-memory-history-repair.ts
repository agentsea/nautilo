import {
  MEMORY_OBJECT_TYPE,
  createForegroundAgentObjectRepairer,
  decodeMemoryPayloadV1,
  deriveMemoryCryptoObjectIdV1,
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundMemoryContextItem,
  type ForegroundMemoryRepairSelection,
  type ForegroundMemoryHistoryResult,
  type PreparedDeviceWrappedAgentObject,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import {
  isForegroundProductChangedError,
  type ForegroundMemoryRepairSource,
} from "@nautilo/lattice-bridge/server";
import type {
  AgentRuntimeKeyGeneration,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";

/** Protect and reopen the exact authored Memories selected for one prompt. */
export function createForegroundMemoryHistoryRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  publication: Readonly<{
    operationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
    policyRevision?: number;
  }>;
  sourceRepresentationMode?: "ordinary-and-protected" | "protected-only";
  loadSources(
    memories: readonly ForegroundMemoryRepairSelection[],
    representationMode?: "ordinary-and-protected" | "protected-only",
  ): Promise<readonly ForegroundMemoryRepairSource[]>;
  persist(prepared: PreparedDeviceWrappedAgentObject): Promise<
    "created" | "duplicate" | "stale"
  >;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedForegroundAgentObject | null>;
  validateExisting(request: Readonly<{
    source: ForegroundMemoryRepairSource;
    objectId: string;
  }>): Promise<boolean>;
  attach(request: Readonly<{
    source: ForegroundMemoryRepairSource;
    objectId: string;
    requestCommitment: Uint8Array;
  }>): Promise<"attached" | "replayed" | "conflict">;
  restoreOrdinary?(request: Readonly<{
    source: ForegroundMemoryRepairSource;
    objectId: string;
    type: string;
    content: string;
    expectedPolicyRevision: number;
  }>): Promise<"restored" | "replayed" | "conflict">;
}>): Readonly<{
  protect(request: Readonly<{
    memories: readonly ForegroundMemoryRepairSelection[];
    signal?: AbortSignal;
  }>): Promise<ForegroundMemoryHistoryResult>;
}> {
  const objects = createForegroundAgentObjectRepairer({
    crypto: input.crypto,
    entities: input.entities,
    publication: input.publication,
    persist: input.persist,
    read: input.read,
  });
  return Object.freeze({
    protect: async (request) => {
      const cancelled = (): boolean => request.signal?.aborted ?? false;
      if (cancelled()) return Object.freeze({
        status: "waiting_for_authority" as const,
        reason: "cancelled",
      });
      let sources: readonly ForegroundMemoryRepairSource[] = [];
      try {
        sources = await input.loadSources(
          request.memories,
          input.sourceRepresentationMode ?? "ordinary-and-protected",
        );
        if (cancelled()) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
        });
        if (
          sources.length !== request.memories.length
          || sources.some((source, index) =>
            source.memory.id !== request.memories[index]?.id
          )
        ) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "memory_product_changed",
        });
        if (
          input.sourceRepresentationMode === "protected-only"
          && sources.some((source) => source.plaintextBytes !== null)
        ) return Object.freeze({
          status: "failed" as const,
          reason: "ordinary_source_forbidden",
        });
        const memories: ForegroundMemoryContextItem[] = [];
        let repairedCount = 0;
        let ordinaryRestoredCount = 0;
        let independentlyComparedCount = 0;
        for (const source of sources) {
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
          });
          const objectId = deriveMemoryCryptoObjectIdV1({
            memoryId: source.memory.id,
            contentRevision: source.targetContentRevision,
          });
          const protectedObject = await objects.protect({
            source: {
              objectId,
              objectType: MEMORY_OBJECT_TYPE,
              existingObjectId: source.existingObjectId,
              expectedAccessRevision: source.expectedAccessRevision,
              createdAt: source.createdAt,
              namespaceIds: source.accessNamespaceIds,
              plaintextBytes: source.plaintextBytes,
            },
            decode: (bytes) => decodeMemoryPayloadV1(bytes),
          });
          if (protectedObject.status !== "verified") return Object.freeze({
            status: protectedObject.status,
            reason: protectedObject.reason,
          });
          if (cancelled()) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "cancelled",
          });
          if (
            (
              source.memory.type !== null
              && protectedObject.value.type !== source.memory.type
            )
            || (
              source.memory.content !== null
              && protectedObject.value.content !== source.memory.content
            )
          ) return Object.freeze({
            status: "failed" as const,
            reason: "memory_payload_parity_mismatch",
          });
          if (
            source.existingObjectId !== null
            && !await input.validateExisting({
              source,
              objectId: protectedObject.objectId,
            })
          ) return Object.freeze({
            status: "waiting_for_authority" as const,
            reason: "memory_product_changed",
          });
          if (source.existingObjectId === null) {
            const attached = await input.attach({
              source,
              objectId: protectedObject.objectId,
              requestCommitment: source.requestCommitment,
            });
            if (attached === "conflict") return Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "memory_product_changed",
            });
            repairedCount += 1;
          }
          if (
            source.plaintextBytes !== null && source.existingObjectId !== null
          ) independentlyComparedCount += 1;
          if (
            source.plaintextBytes === null
            && source.existingObjectId !== null
            && input.restoreOrdinary !== undefined
            && input.publication.policyRevision !== undefined
            && input.sourceRepresentationMode !== "protected-only"
          ) {
            const restored = await input.restoreOrdinary({
              source,
              objectId: protectedObject.objectId,
              type: protectedObject.value.type,
              content: protectedObject.value.content,
              expectedPolicyRevision: input.publication.policyRevision,
            });
            if (restored === "conflict") return Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "memory_product_changed",
            });
            ordinaryRestoredCount += 1;
          }
          memories.push(Object.freeze({
            ...source.memory,
            type: protectedObject.value.type,
            content: protectedObject.value.content,
          }));
        }
        return Object.freeze({
          status: "verified" as const,
          memories: Object.freeze(memories),
          provenance: repairedCount > 0
            ? "repaired" as const
            : "existing" as const,
          repairedCount,
          verification: independentlyComparedCount === sources.length
            ? "independent_parity" as const
            : "authenticated" as const,
          ordinaryRestoredCount,
        });
      } catch (error) {
        if (isForegroundProductChangedError(error)) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "memory_product_changed",
        });
        return Object.freeze({
          status: "failed" as const,
          reason: "memory_repair_failed",
        });
      } finally {
        sources.forEach((source) => {
          source.plaintextBytes?.fill(0);
          source.requestCommitment.fill(0);
        });
      }
    },
  });
}
