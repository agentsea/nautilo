import type { MemoryProcessorRequestPurposeV1, NautiloApiClient } from
  "@nautilo/api-client/browser";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { sealForegroundMemoryProcessorRequest } from "../../memory/foreground-memory-processor-transport.ts";
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
}>): ProtectedMemoryApi {
  const { api } = input;
  const seal = async (purpose: MemoryProcessorRequestPurposeV1, payload: string) =>
    sealForegroundMemoryProcessorRequest({
      crypto: input.crypto,
      recipient: await api.getMemoryProcessorRecipient(),
      subjectId: input.subjectId,
      purpose,
      payload,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
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
    async searchProtectedMemories({ q, ...options }) {
      return api.searchProtectedMemories({ ...options,
        sealedQuery: await seal("memory.query_embedding", q),
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
