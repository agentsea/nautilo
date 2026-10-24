import { describe, expect, test } from "bun:test";
import {
  assertMemoryEmbeddingDisclosureV2,
  decodeMemoryEmbeddingDisclosureV2,
  encodeMemoryEmbeddingDisclosureV2,
  sameMemoryEmbeddingDisclosureV2,
  type MemoryEmbeddingDisclosureV2,
} from "../../src/memory/embedding-disclosure-v2.ts";

function marketplace(): MemoryEmbeddingDisclosureV2 {
  return { contractVersion: 2,
    canonicalSpace: { provider: "venice", model: "text-embedding-3-large", dimensions: 1536 },
    processingRoute: { transport: "surplus_marketplace", marketplacePolicyVersion: "surplus-embedding-marketplace-v1",
      dataRecipientClasses: ["surplus", "marketplace_seller", "seller_upstream_processor"] } };
}

describe("Memory embedding disclosure V2", () => {
  test("round-trips the exact marketplace recipients and canonical space", () => {
    const value = marketplace();
    const bytes = encodeMemoryEmbeddingDisclosureV2(value);
    const decoded = decodeMemoryEmbeddingDisclosureV2(bytes);
    expect(decoded).toEqual(value);
    expect(encodeMemoryEmbeddingDisclosureV2(decoded)).toEqual(bytes);
    expect(sameMemoryEmbeddingDisclosureV2(value, decoded)).toBeTrue();
    expect(Object.isFrozen(decoded.canonicalSpace)).toBeTrue();
    expect(Object.isFrozen(decoded.processingRoute)).toBeTrue();
    if (decoded.processingRoute.transport === "surplus_marketplace") {
      expect(Object.isFrozen(decoded.processingRoute.dataRecipientClasses)).toBeTrue();
    }
    expect(sameMemoryEmbeddingDisclosureV2(value, { ...value, processingRoute: { transport: "direct" } })).toBeFalse();
  });

  test.each(["openai", "openrouter", "venice"] as const)("allows a portable exact direct %s binding", (provider) => {
    const value = { ...marketplace(), canonicalSpace: { provider, model: "organization/model:version", dimensions: 1536 as const },
      processingRoute: { transport: "direct" as const } };
    expect(decodeMemoryEmbeddingDisclosureV2(encodeMemoryEmbeddingDisclosureV2(value))).toEqual(value);
  });

  test("rejects wrong, missing, extra, and unknown semantic fields", () => {
    const value = marketplace();
    const route = value.processingRoute;
    const cases: unknown[] = [null, [], 2, {}, { ...value, contractVersion: 1 }, { ...value, extra: true },
      { ...value, [Symbol("extra")]: true },
      Object.defineProperty({ ...value }, "hidden", { value: true }),
      { ...value, canonicalSpace: null }, { ...value, canonicalSpace: { ...value.canonicalSpace, extra: true } },
      { ...value, canonicalSpace: { ...value.canonicalSpace, provider: "surplus" } },
      { ...value, canonicalSpace: { ...value.canonicalSpace, provider: "openai" } },
      { ...value, canonicalSpace: { ...value.canonicalSpace, model: "text-embedding-3-small" } },
      { ...value, canonicalSpace: { ...value.canonicalSpace, dimensions: 3072 } },
      { ...value, canonicalSpace: { ...value.canonicalSpace, model: "" } },
      { ...value, processingRoute: null }, { ...value, processingRoute: { transport: "unknown" } },
      { ...value, processingRoute: { transport: "direct", marketplacePolicyVersion: "anything" } },
      { ...value, processingRoute: { ...route, extra: true } },
      { ...value, processingRoute: { ...route, marketplacePolicyVersion: "surplus-embedding-marketplace-v2" } },
      ...[[], ["surplus"], ["surplus", "seller_upstream_processor", "marketplace_seller"],
        ["surplus", "marketplace_seller", "unknown"], ["surplus", "marketplace_seller", "seller_upstream_processor", "other"],
        "surplus", null].map((dataRecipientClasses) => ({ ...value, processingRoute: { ...route, dataRecipientClasses } })),
    ];
    for (const candidate of cases) expect(() => assertMemoryEmbeddingDisclosureV2(candidate)).toThrow();
    for (const model of [null, "", " spaces ", 123, "x".repeat(257)]) {
      expect(() => assertMemoryEmbeddingDisclosureV2({ ...value,
        canonicalSpace: { ...value.canonicalSpace, model }, processingRoute: { transport: "direct" } })).toThrow();
    }
  });

  test("rejects malformed/trailing binary encodings and unknown route data", () => {
    const bytes = encodeMemoryEmbeddingDisclosureV2(marketplace());
    const badVersion = bytes.slice(); badVersion[3] = 1;
    const badRecipient = bytes.slice(); badRecipient[badRecipient.length - 1] = 0x7a;
    for (const candidate of [bytes.slice(0, -1), Uint8Array.from([...bytes, 0]), badVersion, badRecipient]) {
      expect(() => decodeMemoryEmbeddingDisclosureV2(candidate)).toThrow();
    }
  });
});
