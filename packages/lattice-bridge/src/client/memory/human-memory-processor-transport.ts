import { ApiError, type MemoryProcessorRequestPurposeV1, type NautiloApiClient } from
  "@nautilo/api-client/browser";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  sameMemoryEmbeddingDisclosureV2,
  type MemoryEmbeddingDisclosureV2,
} from "@nautilo/lattice-crypto/wire";
import {
  sealForegroundMemoryProcessorRequest,
  sealForegroundMemoryProcessorRequestV2,
  sealForegroundMemoryProcessorSearchQueryV2,
} from "../../memory/foreground-memory-processor-transport.ts";
import type { ProtectedMemoryApi } from "./authorized-human-memory-client.ts";

function requiredString(value: object, field: string): string {
  const candidate: unknown = Reflect.get(value, field);
  if (typeof candidate !== "string") {
    throw new TypeError(`Protected Memory ${field} is invalid`);
  }
  return candidate;
}

/**
 * The device-local API view accepts transient text; HTTP receives only the
 * processor carrier. Fetch its recipient at send time, including journal
 * retries, rather than persisting it or retaining a key across server restart.
 */
export function createHumanMemoryProcessorTransport(input: Readonly<{
  api: NautiloApiClient;
  crypto: LatticeCrypto;
  subjectId: string;
  now?: () => number;
  /** Disclosure already shown to and approved by the human for this action. */
  resolveEmbeddingDisclosure?: () => MemoryEmbeddingDisclosureV2 | undefined;
}>): ProtectedMemoryApi {
  const { api } = input;
  const recipient = async () => {
    try {
      return Object.freeze({ kind: "v2" as const,
        value: await api.getMemoryProcessorRecipientV2() });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return Object.freeze({ kind: "v1" as const,
        value: await api.getMemoryProcessorRecipient() });
    }
  };
  const seal = async (purpose: MemoryProcessorRequestPurposeV1, payload: string) => {
    const current = await recipient();
    const common = {
      crypto: input.crypto,
      subjectId: input.subjectId,
      purpose,
      payload,
      ...(input.now === undefined ? {} : { now: input.now }),
    };
    if (current.kind === "v1") {
      return sealForegroundMemoryProcessorRequest({ ...common, recipient: current.value });
    }
    if (current.value.embedding === undefined) {
      throw new TypeError("Memory embedding is unavailable");
    }
    const approved = input.resolveEmbeddingDisclosure?.();
    if (approved !== undefined
      && !sameMemoryEmbeddingDisclosureV2(approved, current.value.embedding)) {
      throw new TypeError(
        "The Memory embedding disclosure changed. Reload it before trying again.",
      );
    }
    return sealForegroundMemoryProcessorRequestV2({ ...common, recipient: current.value });
  };
  return Object.freeze({
    listProtectedMemories: api.listProtectedMemories.bind(api),
    getProtectedMemory: api.getProtectedMemory.bind(api),
    getProtectedMemoryBrief: api.getProtectedMemoryBrief.bind(api),
    planProtectedMemoryCreate: api.planProtectedMemoryCreate.bind(api),
    archiveProtectedMemory: api.archiveProtectedMemory.bind(api),
    transitionProtectedMemoryTier: api.transitionProtectedMemoryTier.bind(api),
    restoreProtectedMemory: api.restoreProtectedMemory.bind(api),
    planProtectedMemoryAccess: api.planProtectedMemoryAccess.bind(api),
    commitProtectedMemoryAccess: api.commitProtectedMemoryAccess.bind(api),
    planProtectedMemoryRepair: api.planProtectedMemoryRepair.bind(api),
    commitProtectedMemoryRepair: api.commitProtectedMemoryRepair.bind(api),
    async searchProtectedMemories({ q, embeddingDisclosure, ...options }) {
      const current = await recipient();
      if (current.kind === "v1") {
        return api.searchProtectedMemories({ ...options,
          sealedQuery: await sealForegroundMemoryProcessorRequest({
            crypto: input.crypto,
            recipient: current.value,
            subjectId: input.subjectId,
            purpose: "memory.query_embedding",
            payload: q,
            ...(input.now === undefined ? {} : { now: input.now }),
          }),
        });
      }
      if (current.value.embedding === undefined) {
        throw new TypeError("Memory embedding is unavailable");
      }
      const approved = embeddingDisclosure ?? input.resolveEmbeddingDisclosure?.();
      if (approved === undefined) {
        throw new TypeError(
          "Memory search requires the embedding disclosure shown to the human.",
        );
      }
      if (!sameMemoryEmbeddingDisclosureV2(approved, current.value.embedding)) {
        throw new TypeError(
          "The Memory embedding disclosure changed. Reload it before trying again.",
        );
      }
      return api.searchProtectedMemoriesV2({ ...options,
        sealedQueryV2: await sealForegroundMemoryProcessorSearchQueryV2({
          crypto: input.crypto,
          recipient: current.value,
          subjectId: input.subjectId,
          query: q,
          embeddingDisclosure: approved,
          ...(input.now === undefined ? {} : { now: input.now }),
        }),
      });
    },
    async createProtectedMemory(prepared) {
      if ("publicationKind" in prepared) {
        return api.createProtectedMemory(prepared,
          await seal("memory.ordinary_fallback",
            requiredString(prepared,
              "signedOrdinaryFallbackRequestBytesBase64url")));
      }
      return api.createProtectedMemory(prepared,
        await seal("memory.content_embedding",
          prepared.signedContentEmbeddingRequestBytesBase64url));
    },
    async updateProtectedMemory(memoryId, prepared) {
      if ("publicationKind" in prepared) {
        return api.updateProtectedMemory(memoryId, prepared,
          await seal("memory.ordinary_fallback",
            requiredString(prepared,
              "signedOrdinaryFallbackRequestBytesBase64url")));
      }
      return api.updateProtectedMemory(memoryId, prepared,
        await seal("memory.content_embedding",
          prepared.signedContentEmbeddingRequestBytesBase64url));
    },
  });
}
