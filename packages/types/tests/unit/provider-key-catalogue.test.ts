import { describe, expect, test } from "bun:test";
import {
  PERSONAL_PROVIDER_KEY_CATALOGUE,
  PROVIDER_KEY_CATALOGUE,
  orderProviderKeys,
  personalProviderCapabilitySummary,
} from "../../src/provider-key-catalogue";

describe("provider key catalogue", () => {
  test("keeps personal presentation secret-free and excludes retired gateways", () => {
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.some(({ id }) => id === "gateway")).toBe(false);
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.map(({ id }) => id)).not.toContain("nautilo-gateway");
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "openai")).toMatchObject({
      purpose: "OpenAI text models; embeddings remain server-managed",
      personalCapabilities: ["chat", "research"],
    });
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "tavily")?.personalCapabilities).toEqual(["research"]);
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "typesafe")?.personalCapabilities).toEqual(["decision"]);
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "openrouter")?.personalCapabilities).toEqual(["chat", "research", "decision"]);
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "venice")?.personalCapabilities).toEqual(["chat", "research", "decision"]);
    for (const id of ["xai", "together"] as const) {
      expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find((entry) => entry.id === id)).toMatchObject({
        personalCapabilities: ["chat", "research"],
        category: "llm",
      });
    }
    for (const id of ["elevenlabs", "groq"] as const) {
      expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find((entry) => entry.id === id)?.personalCapabilities).toEqual([]);
    }
    expect(JSON.stringify(PROVIDER_KEY_CATALOGUE)).not.toContain("formatCheck");
    expect(JSON.stringify(PROVIDER_KEY_CATALOGUE)).not.toContain("doctorHints");
  });

  test("describes real capability use and keeps Surplus entitlement honest", () => {
    const surplus = PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "surplus");
    const tavily = PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "tavily");
    const browserUse = PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "browser-use");
    expect(surplus && personalProviderCapabilitySummary(surplus)).toBe(
      "Eligible for personal chat and native text Tasks, Research and Decisions. Surplus Decisions also require a pilot-enabled account; saving a key does not grant that entitlement.",
    );
    expect(tavily && personalProviderCapabilitySummary(tavily)).toBe("Eligible for Research.");
    expect(browserUse && personalProviderCapabilitySummary(browserUse)).toBe("Eligible for website browsing and actions.");
    expect(PERSONAL_PROVIDER_KEY_CATALOGUE.find(({ id }) => id === "cloudconvert")?.personalCapabilities).toEqual(["conversion"]);
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
