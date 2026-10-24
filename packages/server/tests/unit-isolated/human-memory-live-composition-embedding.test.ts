import { describe, expect, mock, test } from "bun:test";
import type { LiveShadowEncryptionTransitionPolicy } from "@nautilo/db";
import type { MemoryEmbeddingDisclosureV2 } from "@nautilo/lattice-crypto/wire";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createHumanMemoryEmbeddingProcessor } from
  "../../src/routes/human-memory-embedding-processor";
import * as requestServices from "../../src/routes/human-memory-request-services";
import type { ProtectedMemoryRouteAuthority } from
  "../../src/routes/protected-memory-composition";

const marketplaceSpace = { provider: "venice" as const,
  model: "text-embedding-3-large", dimensions: 1536 as const };
const marketplaceDisclosure: MemoryEmbeddingDisclosureV2 = {
  contractVersion: 2,
  canonicalSpace: marketplaceSpace,
  processingRoute: { transport: "surplus_marketplace",
    marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
    dataRecipientClasses: ["surplus", "marketplace_seller",
      "seller_upstream_processor"] },
};
const directSpace = { provider: "openrouter" as const,
  model: "openai/text-embedding-3-small", dimensions: 1536 as const };
const directDisclosure: MemoryEmbeddingDisclosureV2 = {
  contractVersion: 2,
  canonicalSpace: directSpace,
  processingRoute: { transport: "direct" },
};
let currentDisclosure = marketplaceDisclosure;
const providerCalls: unknown[][] = [];
const searchCalls: unknown[] = [];

const unavailable = async () => ({ dtoVersion: 1 as const,
  status: "unavailable" as const, reason: "authorization_required" as const });

mock.module("../../src/routes/human-memory-request-services", () => ({
  ...requestServices,
  createHumanMemoryRequestServices: async () => {
    const disclosure = currentDisclosure;
    const embedding = createHumanMemoryEmbeddingProcessor({
      configuration: () => disclosure.canonicalSpace,
      disclosure: () => disclosure,
      embed: async (...args) => {
        providerCalls.push(args);
        return { provider: disclosure.canonicalSpace.provider,
          canonicalModel: disclosure.canonicalSpace.model,
          dimensions: 1536 as const, vector: new Array<number>(1536).fill(0.25),
          contractVersion: 1 as const };
      },
    });
    return {
      context: { canonicalRunner: {} }, publication: {}, embedding,
      resolveHumanId: async () => "human-one",
      resolveNamespaceAuthority: async () => null,
      product: {
        list: unavailable,
        detail: unavailable,
        brief: unavailable,
        transitionTier: unavailable,
        searchSemantic: async (request: unknown) => {
          searchCalls.push(request);
          return { dtoVersion: 1 as const, items: [], memoryMode: "namespace" as const,
            queryDisclosure: "embedding_provider" as const };
        },
      },
      preparedCreate: { planCreate: unavailable, createPrepared: unavailable },
      preparedUpdate: { updatePrepared: unavailable },
    } as never;
  },
}));
mock.module("../../src/routes/human-memory-exact-access-services", () => ({
  createHumanMemoryExactAccessServices: () => ({
    exactAccessProduct: {}, exactAccessCrypto: {}, accessDeadlineAt: Date.now,
  }),
}));
mock.module("../../src/routes/human-memory-repair-services", () => ({
  createHumanMemoryRepairServices: () => undefined,
}));

const { createProductionHumanMemoryRouteFactory } = await import(
  "../../src/routes/human-memory-live-composition"
);

const namespaceId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const envelope: MemoryAccessEnvelope = {
  ownerId: "user", actorId: "actor", agentId: "context-agent", roomId,
  readableNamespaces: [namespaceId], mutableNamespaces: [namespaceId],
  writableNamespaces: [namespaceId], toolPolicy: {},
};
const authority: ProtectedMemoryRouteAuthority = {
  userId: "user", actorId: "actor", agentId: null, memoryMode: "namespace",
  readableNamespaceIds: [namespaceId], mutableNamespaceIds: [namespaceId],
  writableNamespaceIds: [namespaceId], sourceRoomId: roomId, scopeId: null,
  originWritableNamespaceId: null,
};
const encryptedPolicy: LiveShadowEncryptionTransitionPolicy = {
  mode: "encrypted_only", revision: 1, shadowBehavior: "strict",
  shadowEncryptionStartedAt: null, updatedAt: new Date("2026-10-23T00:00:00Z"),
};

describe("production Human Memory embedding composition", () => {
  test("keeps marketplace disclosure through mutation effects and keeps direct legacy search", async () => {
    providerCalls.length = 0;
    searchCalls.length = 0;
    const factory = createProductionHumanMemoryRouteFactory({
      loadPolicy: async () => encryptedPolicy,
      wakeRecovery: () => {},
    });

    currentDisclosure = marketplaceDisclosure;
    const marketplace = await factory(authority, envelope);
    if (marketplace === null) {
      throw new Error("Production composition did not assemble marketplace ports");
    }
    expect(marketplace.embeddingDisclosure).toBe(marketplaceDisclosure);
    expect(marketplace).not.toHaveProperty("embeddingConfiguration");
    const preparedDisclosure = marketplace.embeddingDisclosure;
    if (preparedDisclosure === undefined) {
      throw new Error("Production composition dropped the marketplace disclosure");
    }
    expect(await marketplace.search({ authority, namespaceIds: [namespaceId],
      query: "private marketplace query", embeddingDisclosure: preparedDisclosure,
      includeArchive: false })).toMatchObject({ memoryMode: "namespace" });
    expect(providerCalls[0]).toEqual(["private marketplace query", undefined,
      { ...marketplaceSpace, disclosure: marketplaceDisclosure }]);
    expect(searchCalls).toHaveLength(1);

    currentDisclosure = directDisclosure;
    const direct = await factory(authority, envelope);
    if (direct === null) {
      throw new Error("Production composition did not assemble direct ports");
    }
    expect(direct.embeddingDisclosure).toBe(directDisclosure);
    expect(direct.embeddingConfiguration).toEqual(directSpace);
    expect(await direct.search({ authority, namespaceIds: [namespaceId],
      query: "private direct query", includeArchive: false }))
      .toMatchObject({ memoryMode: "namespace" });
    expect(providerCalls[1]).toEqual(["private direct query", undefined, directSpace]);
    expect(searchCalls).toHaveLength(2);
  });
});
