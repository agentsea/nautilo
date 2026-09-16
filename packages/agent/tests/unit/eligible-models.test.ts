import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  resetModelCapabilitiesCacheForTests,
  setModelCapabilitiesCacheForTests,
} from "@nautilo/model-capabilities";
import { ModelCatalogSchema, type ModelCatalog } from "@nautilo/types";
import {
  getEligibleModels,
  resolveRetainedModels,
} from "../../src/config/eligible-models";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";

describe("getEligibleModels", () => {
  let prevVenice: string | undefined;
  let prevOpenRouter: string | undefined;

  beforeEach(() => {
    resetRuntimeModelCatalog();
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
    prevVenice = process.env["VENICE_API_KEY"];
    delete process.env["VENICE_API_KEY"];
    prevOpenRouter = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "test-openrouter-key";
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    if (prevVenice === undefined) delete process.env["VENICE_API_KEY"];
    else process.env["VENICE_API_KEY"] = prevVenice;
    if (prevOpenRouter === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = prevOpenRouter;
  });

  test("normal lists contain only signed rows with runnable credentials", () => {
    const eligible = getEligibleModels({ env: { OPENROUTER_API_KEY: "or-test" } });
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every((model) => model.provider === "openrouter")).toBe(true);
    expect(eligible.every((model) => model.availability === "selectable")).toBe(true);
    expect(eligible.some((model) => model.id.startsWith("anthropic:"))).toBe(false);
  });

  test("missing credentials are omitted normally and retained with a bounded reason", () => {
    const id = "anthropic:claude-sonnet-4-6";
    expect(getEligibleModels({ env: {} }).some((model) => model.id === id)).toBe(false);
    expect(resolveRetainedModels([id], { env: {} })[0]).toMatchObject({
      id,
      availability: "missing-key",
      enabled: false,
      unavailableReason: "Anthropic credential is not configured",
    });
  });

  test("legacy custom ids stay visible but cannot become selectable", () => {
    const id = "openrouter:legacy/custom-model";
    expect(resolveRetainedModels([id], { env: { OPENROUTER_API_KEY: "or-test" } })[0]).toMatchObject({
      id,
      availability: "unknown-model",
      enabled: false,
      unavailableReason: "model is not present in the current signed catalog",
    });
  });

  test("purpose qualification distinguishes chat, vision, and image generation", () => {
    const env = { ANTHROPIC_API_KEY: "a-test" };
    const id = "anthropic:claude-sonnet-4-6";
    expect(getEligibleModels({ env, purpose: "vision" }).some((model) => model.id === id)).toBe(true);
    expect(resolveRetainedModels([id], { env, purpose: "image-generation" })[0]).toMatchObject({
      availability: "unsupported-capability",
      unavailableReason: "model does not generate images",
    });
  });

  test("with Venice key, curated Venice models appear (except China unless opted in)", () => {
    process.env["VENICE_API_KEY"] = "vk-test";
    const selectable = getEligibleModels({ allowChinaUpstream: false }).filter(
      (m) => m.availability === "selectable",
    );
    const veniceIds = selectable.filter((m) => m.id.startsWith("venice:")).map((m) => m.id);
    expect(veniceIds.some((id) => id.includes("glm"))).toBe(true);
    expect(veniceIds).not.toContain("venice:qwen-3-8-max");
  });

  test("allowChinaUpstream reveals China-routed Venice SKU when keyed", () => {
    process.env["VENICE_API_KEY"] = "vk-test";
    const selectable = getEligibleModels({ allowChinaUpstream: true }).filter(
      (m) => m.availability === "selectable",
    );
    expect(selectable.some((m) => m.id === "venice:qwen-3-8-max")).toBe(true);
  });

  test("includeUnavailable surfaces Venice rows without key as missing-key or filtered (China)", () => {
    delete process.env["VENICE_API_KEY"];
    const rows = getEligibleModels({ includeUnavailable: true }).filter((m) =>
      m.id.startsWith("venice:"),
    );
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows.filter((m) => m.availability === "missing-key");
    const filtered = rows.filter((m) => m.availability === "filtered");
    expect(missing.length).toBeGreaterThan(0);
    expect(filtered.some((m) => m.id === "venice:qwen-3-8-max")).toBe(true);
    expect(rows.every((m) => !m.enabled)).toBe(true);
  });

  test("release-enabled Venice rows become selectable when keyed", () => {
    process.env["VENICE_API_KEY"] = "vk-test";
    const glm = getEligibleModels().find((m) => m.id === "venice:zai-org-glm-5-2");
    expect(glm?.availability).toBe("selectable");
    expect(glm?.enabled).toBe(true);
    expect(glm?.routing).toBe("venice-hosted");
  });

  test("media-generation rows never become ordinary chat candidates", () => {
    const mediaIds = [
      "venice:seedance-2-5-text-to-video-basic",
      "venice:minimax-h3-enhanced-text-to-video",
      "venice:sonilo-v1-1-music",
      "venice:minimax-music-v26",
    ];
    const env = { VENICE_API_KEY: "vk-test" };
    const chatCandidates = getEligibleModels({ env, purpose: "chat" });
    expect(chatCandidates.some((row) => mediaIds.includes(row.id))).toBe(false);

    // Diagnostics can explain why a persisted bad selection is unavailable,
    // but such rows never present as enabled/selectable chat models.
    const diagnostics = getEligibleModels({ env, purpose: "chat", includeUnavailable: true });
    for (const id of mediaIds) {
      expect(diagnostics.find((row) => row.id === id)).toMatchObject({
        availability: "unsupported-capability",
        enabled: false,
        unavailableReason: "model does not produce text",
      });
    }
  });

  test("non-Venice capabilities project from resolveModelCapabilities / OpenRouter cache", () => {
    const fetchedAt = new Date().toISOString();
    setModelCapabilitiesCacheForTests({
      fetchedAt,
      models: {
        "moonshotai/kimi-k2.6": {
          input: ["text"],
          output: ["text"],
          features: {
            tools: false,
            structuredOutputs: false,
            reasoning: true,
          },
        },
      },
    });
    const kimi = getEligibleModels({ purpose: "chat" }).find(
      (m) => m.id === "openrouter:moonshotai/kimi-k2.6",
    );
    expect(kimi?.capabilities.tools).toBe(false);
    expect(kimi?.capabilities.reasoning).toBe(true);
    expect(kimi?.capabilities.vision).toBe(false);
    expect(kimi?.capabilities.e2ee).toBe(false);
    expect(kimi?.capabilities.webSearch).toBe(false);
  });

  test("confirmed tools=false excludes a row from tool-using selection", () => {
    // Regression: prior code path defaulted capabilities.tools to true for all
    // non-Venice rows. After projection via resolveModelCapabilities, an
    // OpenRouter row whose cached `features.tools === false` must surface as
    // `capabilities.tools === false` even while the row is enabled/selectable.
    const fetchedAt = new Date().toISOString();
    setModelCapabilitiesCacheForTests({
      fetchedAt,
      models: {
        "moonshotai/kimi-k2.6": {
          input: ["text"],
          output: ["text"],
          features: { tools: false, structuredOutputs: false, reasoning: false },
        },
      },
    });
    const all = getEligibleModels({ includeUnavailable: true });
    const kimi = all.find((m) => m.id === "openrouter:moonshotai/kimi-k2.6");
    expect(kimi).toBeDefined();
    expect(kimi?.availability).toBe("unsupported-capability");
    expect(kimi?.enabled).toBe(false);
    expect(kimi?.capabilities.tools).toBe(false);
  });

  test("checked-in modality overrides set vision from resolver input modalities", () => {
    const sonnet = getEligibleModels({ env: { ANTHROPIC_API_KEY: "a-test" } }).find(
      (m) => m.id === "anthropic:claude-sonnet-4-6",
    );
    expect(sonnet?.capabilities.vision).toBe(true);
    expect(sonnet?.capabilities.tools).toBe(true);
    // D331 — Anthropic 4.x now carry an explicit reasoning feature.
    expect(sonnet?.capabilities.reasoning).toBe(true);
  });

  test("v2 Kimi serving controls project only public profile metadata", async () => {
    const catalog = ModelCatalogSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../fixtures/model-catalog-controls-v2.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-28T12:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    const kimi = getEligibleModels({ includeUnavailable: true }).find(
      (model) => model.id === "fireworks:accounts/fireworks/models/kimi-k3",
    );
    expect(kimi?.controls).toEqual({
      serving: {
        defaultProfile: "standard",
        profiles: [
          {
            id: "standard",
            label: "Standard",
            description: "Balanced default Fireworks route.",
            intent: "balanced",
            pricing: { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 },
          },
          {
            id: "priority",
            label: "Priority",
            description: "Higher reliability during peak traffic.",
            intent: "reliability",
            pricing: { inputPerMtok: 3.75, cachedInputPerMtok: 0.375, outputPerMtok: 18.75 },
          },
          {
            id: "fast",
            label: "Fast",
            description: "Higher generated-token throughput for interactive work.",
            intent: "throughput",
            pricing: { inputPerMtok: 4.5, cachedInputPerMtok: 0.45, outputPerMtok: 22.5 },
          },
        ],
      },
    });
    const serialized = JSON.stringify(kimi);
    expect(serialized).not.toContain("selector");
    expect(serialized).not.toContain("provenance");
  });

  test("v1 and model-only v2 rows omit controls", async () => {
    const catalog = ModelCatalogSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../fixtures/model-catalog-controls-v2.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-28T12:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    expect(
      getEligibleModels({ includeUnavailable: true }).find(
        (model) => model.id === "openai:legacy-model-only-test",
      )?.controls,
    ).toBeUndefined();
  });

  test("unsupported signed remote provider never appears picker-selectable", async () => {
    // Bypass schema validation through the injected loader to exercise the
    // picker-side provider support gate as defense in depth.
    const catalog: ModelCatalog = {
      version: 1,
      catalogVersion: "2026.07.18.2",
      publishedAt: "2026-07-18T12:00:00Z",
      entries: [{
        id: "newprovider:vortex-99",
        displayName: "Vortex 99",
        provider: "newprovider",
        routing: "first-party",
        priority: 1,
        defaultEnabled: true,
        limits: { contextTokens: 128_000, outputTokens: 8_000 },
        cost: { coefficient: 1 },
        privacy: { grade: 5 },
        intelligence: { tier: "strong" },
      }],
    };
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-18T12:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    expect(getEligibleModels().map((model) => model.id)).not.toContain(
      "newprovider:vortex-99",
    );
    const unavailable = getEligibleModels({ includeUnavailable: true }).find(
      (model) => model.id === "newprovider:vortex-99",
    );
    expect(unavailable?.availability).toBe("filtered");
    expect(unavailable?.enabled).toBe(false);
    expect(unavailable?.unavailableReason).toContain("not supported");
  });

  test("remote Venice defaultEnabled false remains non-selectable even with credentials", async () => {
    process.env["VENICE_API_KEY"] = "vk-test";
    const catalog: ModelCatalog = {
      version: 1,
      catalogVersion: "2026.07.18.3",
      publishedAt: "2026-07-18T13:00:00Z",
      entries: [{
        id: "venice:zai-org-glm-5-1",
        displayName: "GLM 5.1 Beta (Venice-hosted)",
        provider: "venice",
        routing: "venice-hosted",
        priority: 21,
        defaultEnabled: false,
        limits: { contextTokens: 200_000, outputTokens: 16_384 },
        cost: { coefficient: 0.55 },
        privacy: { grade: 8 },
        intelligence: { tier: "strong" },
      }],
    };
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-07-18T13:00:00.000Z",
          originUrl: "https://media.nautilo.ai/models/latest.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();

    expect(getEligibleModels()).toEqual([]);
    expect(getEligibleModels({ includeUnavailable: true })[0]).toMatchObject({
      id: "venice:zai-org-glm-5-1",
      enabled: false,
      availability: "filtered",
      unavailableReason: "catalog row disabled",
    });
  });
});
