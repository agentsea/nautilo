import { describe, expect, test } from "bun:test";
import {
  PERSONAL_PROVIDER_KEY_CATALOGUE,
  PROVIDER_KEY_CATALOGUE,
  orderProviderKeys,
} from "../../src/provider-key-catalogue";

describe("provider key catalogue", () => {
  test("keeps personal presentation secret-free and excludes retired gateways", () => {
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.some(({ id }) => id === "gateway")).toBe(false);
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.map(({ id }) => id)).not.toContain("nautilo-gateway");
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "openai")).toMatchObject({
      purpose: "OpenAI text models; embeddings remain server-managed",
      personalCapabilities: ["chat"],
    });
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "tavily")?.personalCapabilities).toEqual([]);
    for (const id of ["xai", "together"] as const) {
      expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find((entry) => entry.id === id)).toMatchObject({
        personalCapabilities: ["chat"],
        category: "llm",
      });
    }
    expect(JSON.stringify(PROVIDER_KEY_CATALOGUE)).not.toContain("formatCheck");
    expect(JSON.stringify(PROVIDER_KEY_CATALOGUE)).not.toContain("doctorHints");
  });

  test("puts Surplus after OpenRouter, keeps fallback order stable, and leaves gateways last", () => {
    const providers = [
      { id: "anthropic" }, { id: "tavily" }, { id: "gateway" },
      { id: "custom" }, { id: "surplus" }, { id: "openrouter" },
      { id: "venice" }, { id: "nautilo-gateway" }, { id: "openai" },
      { id: "together" }, { id: "xai" },
    ];

    expect(orderProviderKeys(providers).map(({ id }) => id)).toEqual([
      "venice", "openrouter", "surplus", "openai", "anthropic",
      "xai", "together", "tavily", "custom", "gateway", "nautilo-gateway",
    ]);
    expect(providers.map(({ id }) => id)).toEqual([
      "anthropic", "tavily", "gateway", "custom", "surplus",
      "openrouter", "venice", "nautilo-gateway", "openai", "together", "xai",
    ]);
  });
});
