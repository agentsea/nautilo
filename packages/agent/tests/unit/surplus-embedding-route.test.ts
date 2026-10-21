import { describe, expect, test } from "bun:test";
import {
  assertQualifiedSurplusEmbeddingReceipt,
  assertQualifiedSurplusEmbeddingResponseModel,
  getQualifiedSurplusEmbeddingRoute,
  QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID,
  SurplusEmbeddingReceiptError,
} from "../../src/providers/surplus-embedding-route";

describe("qualified Surplus embedding route", () => {
  test("admits only the explicit Venice large 1536-dimensional space", () => {
    expect(QUALIFIED_SURPLUS_EMBEDDING_CATALOG_MODEL_ID)
      .toBe("venice:text-embedding-3-large");
    const route = getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-large", 1_536);
    expect(route).toMatchObject({
      provider: "venice",
      model: "text-embedding-3-large",
      wireModel: "text-embedding-3-large",
      responseModel: "text-embedding-3-large",
      receiptModel: "venice-embed-1",
      servingPolicy: "surplus-embedding-marketplace-v1",
      knownServingProviders: ["mordiem", "venice"],
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-small", 1_536)).toBeNull();
    expect(getQualifiedSurplusEmbeddingRoute("openai:text-embedding-3-large", 1_536)).toBeNull();
    expect(getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-large", 3_072)).toBeNull();
  });

  test("accepts only known serving families and the qualified compatibility adaptation", () => {
    const route = getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-large", 1_536)!;
    expect(() => assertQualifiedSurplusEmbeddingReceipt(route, {
      providerFamily: "Mordiem",
      buyerCostMicro: 0,
      truncated: false,
    }, 200)).not.toThrow();
    expect(() => assertQualifiedSurplusEmbeddingReceipt(route, {
      providerFamily: "venice",
      adaptedParameters: " safe_mode ",
      truncated: false,
    }, 200)).not.toThrow();
    for (const receipt of [
      { providerFamily: "unknown", truncated: false },
      { providerFamily: "mordiem", adaptedParameters: "safe_mode,safe_mode", truncated: false },
      { providerFamily: "mordiem", adaptedParameters: "dimensions", truncated: false },
      { providerFamily: "mordiem", adaptedParameters: "safe_mode,dimensions", truncated: false },
      { providerFamily: "venice", truncated: true },
    ]) {
      expect(() => assertQualifiedSurplusEmbeddingReceipt(route, receipt, 200))
        .toThrow(SurplusEmbeddingReceiptError);
    }
  });

  test("requires the qualified response model alias", () => {
    const route = getQualifiedSurplusEmbeddingRoute("venice:text-embedding-3-large", 1_536)!;
    expect(() => assertQualifiedSurplusEmbeddingResponseModel(route, {
      model: "text-embedding-3-large",
    })).not.toThrow();
    expect(() => assertQualifiedSurplusEmbeddingResponseModel(route, { model: "3-large" }))
      .toThrow(SurplusEmbeddingReceiptError);
  });
});
