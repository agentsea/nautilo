import { describe, expect, test } from "bun:test";

import {
  memoryEmbeddingDisclosureV2Schema,
  memoryProcessorRecipientV1Schema,
  memoryProcessorRecipientV2Schema,
} from "../../src/schemas/memory-processor-transport";

function recipient<const Provider extends string>(provider: Provider) {
  return {
    formatVersion: 1,
    purpose: "memory.foreground_embedding",
    recipientId: "A".repeat(43),
    publicKeyBase64url: "B".repeat(87),
    embedding: {
      provider,
      model: "text-embedding-3-small",
      dimensions: 1_536,
    },
  } as const;
}

describe("Memory processor transport schema", () => {
  test("accepts a Venice recipient while preserving the signed disclosure coordinates", () => {
    expect(memoryProcessorRecipientV1Schema.parse(recipient("venice"))).toEqual(
      recipient("venice"),
    );
  });

  test("rejects an unknown embedding provider", () => {
    expect(memoryProcessorRecipientV1Schema.safeParse(
      recipient("unknown-provider"),
    ).success).toBe(false);
  });

  test("accepts the exact Surplus marketplace disclosure without changing canonical space", () => {
    const embedding = {
      contractVersion: 2,
      canonicalSpace: {
        provider: "venice",
        model: "text-embedding-3-large",
        dimensions: 1536,
      },
      processingRoute: {
        transport: "surplus_marketplace",
        marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
        dataRecipientClasses: [
          "surplus",
          "marketplace_seller",
          "seller_upstream_processor",
        ],
      },
    } as const;
    expect(memoryEmbeddingDisclosureV2Schema.parse(embedding)).toEqual(embedding);
    expect(memoryProcessorRecipientV2Schema.parse({
      formatVersion: 2,
      purpose: "memory.foreground_embedding",
      recipientId: "A".repeat(43),
      publicKeyBase64url: "B".repeat(87),
      embedding,
    }).embedding).toEqual(embedding);
  });

  test("rejects widened or reordered marketplace recipients", () => {
    const base = {
      contractVersion: 2,
      canonicalSpace: { provider: "venice", model: "text-embedding-3-large", dimensions: 1536 },
      processingRoute: {
        transport: "surplus_marketplace",
        marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
      },
    } as const;
    expect(memoryEmbeddingDisclosureV2Schema.safeParse({ ...base,
      processingRoute: { ...base.processingRoute,
        dataRecipientClasses: ["surplus", "seller_upstream_processor", "marketplace_seller"] },
    }).success).toBe(false);
    expect(memoryEmbeddingDisclosureV2Schema.safeParse({ ...base,
      canonicalSpace: { provider: "openai", model: "text-embedding-3-large",
        dimensions: 1536 },
      processingRoute: { ...base.processingRoute,
        dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor"] },
    }).success).toBe(false);
    expect(memoryEmbeddingDisclosureV2Schema.safeParse({ ...base,
      processingRoute: { ...base.processingRoute,
        dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor", "other"] },
    }).success).toBe(false);
  });
});
