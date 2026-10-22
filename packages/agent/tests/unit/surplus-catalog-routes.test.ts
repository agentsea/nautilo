import { afterEach, describe, expect, test } from "bun:test";
import { ModelCatalogSchema, type ModelCatalog } from "@nautilo/types";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  canBroadenSurplusModelRoute,
  resolveQualifiedSurplusChatRoute,
  resolveSurplusChatServingAvailability,
} from "../../src/providers/surplus-route";

async function installCatalog(catalog: ModelCatalog): Promise<void> {
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-10-03T00:00:00.000Z",
        originUrl: "https://catalog.invalid/surplus-routes.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

afterEach(() => resetRuntimeModelCatalog());

describe("catalog-derived Surplus chat routes", () => {
  test("bounds only exact qualified Surplus Sonnet identifiers without changing signed direct limits", () => {
    const catalog = getActiveModelCatalogSync().catalog;
    const catalogModelId = "openrouter:anthropic/claude-sonnet-4.6";
    const signedSonnet = catalog.entries.find((entry) => entry.id === catalogModelId);
    const unrelated = catalog.entries.find((entry) => entry.id === "openrouter:minimax/minimax-m3");
    if (!signedSonnet?.limits || !unrelated?.limits) throw new Error("Surplus route fixtures are missing limits");

    expect(signedSonnet.limits.outputTokens).toBe(128_000);
    expect(resolveQualifiedSurplusChatRoute(catalogModelId)?.maxOutputTokens).toBe(64_000);
    expect(resolveQualifiedSurplusChatRoute(unrelated.id)?.maxOutputTokens)
      .toBe(unrelated.limits.outputTokens);
    expect(resolveQualifiedSurplusChatRoute("anthropic:claude-sonnet-4-6")?.maxOutputTokens)
      .toBe(128_000);
    expect(resolveQualifiedSurplusChatRoute("venice:claude-sonnet-4-6")?.maxOutputTokens)
      .toBe(128_000);
  });

  test("an injected route cannot bypass the signed route's qualified ceiling", () => {
    const catalogModelId = "openrouter:anthropic/claude-sonnet-4.6";
    const route = resolveQualifiedSurplusChatRoute(catalogModelId);
    if (!route) throw new Error("Qualified Sonnet route fixture is missing");

    expect(resolveQualifiedSurplusChatRoute(catalogModelId, [{
      ...route,
      maxOutputTokens: 128_000,
    }])?.maxOutputTokens).toBe(64_000);
    expect(resolveQualifiedSurplusChatRoute(catalogModelId, [{
      ...route,
      surplusModelId: "claude-sonnet-4.6",
      maxOutputTokens: 128_000,
    }])?.maxOutputTokens).toBe(64_000);
    expect(resolveQualifiedSurplusChatRoute(catalogModelId, [{
      ...route,
      surplusModelId: "injected-unqualified-model-id",
      maxOutputTokens: 128_000,
    }])?.maxOutputTokens).toBe(64_000);
  });

  test("a signed Sonnet limit below the qualified Surplus ceiling stays authoritative", async () => {
    const current = getActiveModelCatalogSync().catalog;
    const catalogModelId = "openrouter:anthropic/claude-sonnet-4.6";
    const source = current.entries.find((entry) => entry.id === catalogModelId);
    if (!source) throw new Error("OpenRouter Sonnet fixture is missing");
    const narrowed = { ...source, limits: { ...source.limits, outputTokens: 32_000 } };
    await installCatalog(ModelCatalogSchema.parse({
      ...current,
      catalogVersion: "2026.10.22.1",
      entries: [narrowed],
    }));

    expect(getActiveModelCatalogSync().catalog.entries[0]?.limits?.outputTokens).toBe(32_000);
    expect(resolveQualifiedSurplusChatRoute(catalogModelId)?.maxOutputTokens).toBe(32_000);
  });

  test("a newly signed supported-provider row is immediately routable with catalog capabilities", async () => {
    const current = getActiveModelCatalogSync().catalog;
    const source = current.entries.find((entry) => entry.id === "openai:gpt-5.6-sol");
    if (!source) throw new Error("OpenAI chat fixture is missing");
    const id = "together:meta-llama/future-signed-chat";
    const future = {
      ...source,
      id,
      displayName: "Future signed chat",
      provider: "together",
      routing: "together" as const,
      features: { tools: false, structuredOutputs: false, reasoning: true },
      modalities: { input: ["text", "image"], output: ["text"] },
      limits: { contextTokens: 234_567, outputTokens: 12_345 },
    };
    await installCatalog({ ...current, catalogVersion: "2026.10.03.1", entries: [future] } as ModelCatalog);

    expect(resolveQualifiedSurplusChatRoute(id)).toEqual({
      catalogModelId: id,
      surplusModelId: "meta-llama/future-signed-chat",
      providerPin: "together",
      supportsTools: false,
      supportsVision: true,
      supportsReasoning: true,
      maxContextTokens: 234_567,
      maxOutputTokens: 12_345,
    });
  });

  test("Google catalog rows pin google-ai-studio while preserving the exact model suffix", () => {
    const googleRoute = resolveQualifiedSurplusChatRoute("google:gemini-3.1-pro-preview");
    expect(googleRoute).toMatchObject({
      surplusModelId: "gemini-3.1-pro-preview",
      providerPin: "google-ai-studio",
    });
    expect(resolveQualifiedSurplusChatRoute("google:gemini-3.1-pro-preview", [{
      ...googleRoute!,
      providerPin: "google" as never,
    }])).toBeNull();
    expect(resolveQualifiedSurplusChatRoute("fireworks:accounts/fireworks/models/kimi-k3")).toMatchObject({
      surplusModelId: "accounts/fireworks/models/kimi-k3",
      providerPin: "fireworks",
    });
    expect(resolveQualifiedSurplusChatRoute("openrouter:openai/gpt-5.6-sol")).toMatchObject({
      surplusModelId: "openai/gpt-5.6-sol",
      providerPin: "openrouter",
    });
  });

  test("policy and key availability do not require a direct provider credential", () => {
    const catalogModelId = "anthropic:claude-sonnet-4-6";
    expect(resolveSurplusChatServingAvailability({
      catalogModelId, policyEnabled: true, keyConfigured: true, fundingKind: "server",
    }).status).toBe("available");
    expect(resolveSurplusChatServingAvailability({
      catalogModelId, policyEnabled: false, keyConfigured: true, fundingKind: "server",
    }).status).toBe("qualified-unavailable");
    expect(resolveSurplusChatServingAvailability({
      catalogModelId, policyEnabled: true, keyConfigured: true, fundingKind: "personal",
    }).status).toBe("available");
  });

  test("aggregate availability scans the active catalog instead of a fixed model", async () => {
    const current = getActiveModelCatalogSync().catalog;
    const source = current.entries.find((entry) => entry.id === "anthropic:claude-sonnet-4-6");
    if (!source) throw new Error("Anthropic chat fixture is missing");
    const only = { ...source, id: "anthropic:aggregate-new-row" };
    await installCatalog({ ...current, catalogVersion: "2026.10.03.2", entries: [only] } as ModelCatalog);
    expect(resolveSurplusChatServingAvailability({ policyEnabled: true, keyConfigured: true }))
      .toMatchObject({ status: "available", route: { catalogModelId: "anthropic:aggregate-new-row" } });
  });

  test("disabled, non-chat, unsupported, private E2EE, and China-anonymized rows stay excluded", async () => {
    const current = getActiveModelCatalogSync().catalog;
    const chat = current.entries.find((entry) => entry.id === "openai:gpt-5.6-sol");
    const nonChat = current.entries.find((entry) => entry.id === "openai:gpt-image-2");
    const unsupported = current.entries.find((entry) => entry.provider === "typesafe");
    const e2ee = current.entries.find((entry) => entry.id === "venice:e2ee-deepseek-v4-flash");
    const china = current.entries.find((entry) => entry.routing === "china-anonymized");
    if (!chat || !nonChat || !unsupported || !e2ee || !china) throw new Error("catalog exclusion fixtures are missing");
    const disabled = { ...chat, id: "openai:disabled-chat", defaultEnabled: false };
    const privateE2ee = { ...chat, id: "openai:private-e2ee-chat", privacy: { grade: 10, label: "e2ee" as const } };
    await installCatalog({
      ...current,
      catalogVersion: "2026.10.03.3",
      entries: [disabled, nonChat, unsupported, e2ee, privateE2ee, china],
    } as ModelCatalog);
    for (const id of [disabled.id, nonChat.id, unsupported.id, e2ee.id, privateE2ee.id, china.id]) {
      expect(resolveQualifiedSurplusChatRoute(id), id).toBeNull();
    }
  });
});


describe("marketplace provider broadening", () => {
  test("ordinary aggregator rows allow exact-model seller recovery", () => {
    expect(canBroadenSurplusModelRoute("openrouter:anthropic/claude-sonnet-4.6")).toBe(true);
    expect(canBroadenSurplusModelRoute("openrouter:minimax/minimax-m3")).toBe(true);
    expect(canBroadenSurplusModelRoute("openrouter:typesafe/jev-1.13")).toBe(true);
    expect(canBroadenSurplusModelRoute("fireworks:accounts/fireworks/models/kimi-k3")).toBe(true);
  });
  test("provider-bound privacy routes and unknown models retain their pin", () => {
    expect(canBroadenSurplusModelRoute("venice:claude-sonnet-4-6")).toBe(false);
    for (const row of getActiveModelCatalogSync().catalog.entries.filter(row => row.provider === "venice")) {
      expect(canBroadenSurplusModelRoute(row.id)).toBe(false);
    }
    expect(canBroadenSurplusModelRoute("openai:gpt-5.6-sol")).toBe(false);
    expect(canBroadenSurplusModelRoute("missing:unknown")).toBe(false);
  });
  test.each(["e2ee", "anonymized"] as const)("an explicit %s label keeps even aggregator rows pinned", async label => {
    const current = getActiveModelCatalogSync().catalog;
    const source = current.entries.find(row => row.id === "openrouter:minimax/minimax-m3")!;
    await installCatalog({ ...current, entries: [{ ...source, privacy: { ...source.privacy, label } }] } as ModelCatalog);
    expect(canBroadenSurplusModelRoute(source.id)).toBe(false);
  });
});
