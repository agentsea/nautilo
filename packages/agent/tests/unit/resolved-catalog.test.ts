import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resetModelCapabilitiesCacheForTests,
  setModelCapabilitiesCacheForTests,
} from "@nautilo/model-capabilities";
import type { ResolvedCatalogModel } from "@nautilo/trust";
import { ASSISTANT_MODELS } from "../../src/config/assistant-models";
import { resolveCatalogModel, listResolvedCatalogModels } from "../../src/config/resolved-catalog";
import { getEligibleModels } from "../../src/config/eligible-models";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";

const NO_ENV: NodeJS.ProcessEnv = {};

function writeVeniceSnapshot(
  cachePath: string,
  snapshot: { fetchedAt: string; complete: boolean; models: Record<string, unknown> },
): void {
  fs.writeFileSync(cachePath, JSON.stringify(snapshot), "utf8");
}

describe("resolved-catalog (the current implementation)", () => {
  beforeEach(() => {
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  });
  afterEach(() => {
    delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
  });

  test("every curated ASSISTANT_MODELS row resolves", () => {
    for (const m of ASSISTANT_MODELS) {
      const row = resolveCatalogModel(m.id, { env: { ...process.env, VENICE_API_KEY: "x", OPENROUTER_API_KEY: "x", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", GOOGLE_API_KEY: "x", FIREWORKS_API_KEY: "x", XAI_API_KEY: "x", TOGETHER_API_KEY: "x" }, allowChinaUpstream: true });
      expect(row.id).toBe(m.id);
      expect(row.displayName).toBe(m.displayName);
      expect(["selectable", "missing_credentials", "routing_filtered", "disabled", "unknown_model"]).toContain(row.availability);
    }
  });

  test("unknown feature values are null, not false", () => {
    // Arbitrary routed IDs remain visible to retained-value callers, but are
    // never promoted outside the signed catalog.
    const row = resolveCatalogModel("openrouter:somevendor/unknown-model-v1", { env: NO_ENV });
    expect(row.availability).toBe("unknown_model");
    expect(row.features.tools).toBe(null);
    expect(row.features.structuredOutputs).toBe(null);
    expect(row.features.reasoning).toBe(null);
    expect(row.features.visualGrounding).toBe(null);
    expect(row.features.webSearch).toBe(null);
    expect(row.features.e2ee).toBe(null);
    expect(row.privacyGrade).toBe(null);
    expect(row.intelligenceTier).toBe(null);
    expect(row.intelligenceRank).toBe(null);
    expect(row.provenance).toBe(null);
    expect(row.lastVerifiedAt).toBe(null);
    expect(row.maxOutputTokens).toBe(null);
  });

  test("unknown id returns availability unknown_model", () => {
    const row = resolveCatalogModel("newprovider:vortex-99", { env: NO_ENV });
    expect(row.availability).toBe("unknown_model");
    expect(row.routing).toBe(null);
  });

  test("missing credentials produce missing_credentials for every provider, including venice", () => {
    const cases: Array<[string, string]> = [
      ["anthropic:claude-sonnet-4-6", "Anthropic credential is not configured"],
      ["openai:gpt-5.6-sol", "OpenAI credential is not configured"],
      ["openrouter:moonshotai/kimi-k2.6", "OpenRouter credential is not configured"],
      ["google:gemini-2.5-pro", "Google credential is not configured"],
      ["fireworks:accounts/fireworks/models/glm-5p3", "Fireworks credential is not configured"],
      ["venice:zai-org-glm-5-2", "Venice credential is not configured"],
    ];
    for (const [id, reason] of cases) {
      const row = resolveCatalogModel(id, { env: NO_ENV });
      expect(row.availability).toBe("missing_credentials");
      expect(row.unavailableReason).toBe(reason);
    }
  });

  test("retired Fireworks GLM route is unknown", () => {
    const row = resolveCatalogModel("fireworks:accounts/fireworks/models/glm-5p2", { env: NO_ENV });
    expect(row.availability).toBe("unknown_model");
  });

  test("managed Gateway admits OpenRouter chat but not generation catalog rows", () => {
    const managedEnv = {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1",
    };

    expect(resolveCatalogModel("openrouter:moonshotai/kimi-k2.6", {
      env: managedEnv,
    }).availability).toBe("selectable");

    const generation = resolveCatalogModel("openrouter:openai/gpt-5.4-image-2", {
      env: managedEnv,
    });
    expect(generation.availability).toBe("missing_credentials");
    expect(generation.unavailableReason).toBe("OpenRouter credential is not configured");
    expect(listResolvedCatalogModels({ env: managedEnv }).some(
      (row) => row.id === "openrouter:openai/gpt-5.4-image-2",
    )).toBe(false);
  });

  test("direct OpenRouter credentials admit generation despite malformed managed config", () => {
    const generation = resolveCatalogModel("openrouter:openai/gpt-5.4-image-2", {
      env: {
        OPENROUTER_API_KEY: "synthetic-openrouter-key",
        NAUTILO_MANAGED_GATEWAY_API_KEY: "malformed-managed-key",
      },
    });
    expect(generation.availability).toBe("selectable");
  });

  test("venice china-routed SKU is routing_filtered without opt-in, selectable with opt-in + key", () => {
    const env = { VENICE_API_KEY: "vk-test" };
    const filtered = resolveCatalogModel("venice:qwen-3-8-max", { env, allowChinaUpstream: false });
    expect(filtered.availability).toBe("routing_filtered");
    const selectable = resolveCatalogModel("venice:qwen-3-8-max", { env, allowChinaUpstream: true });
    expect(selectable.availability).toBe("selectable");
    expect(selectable.routing).toBe("china-anonymized");
  });

  test("venice western SKU is selectable when keyed (no opt-in needed)", () => {
    const row = resolveCatalogModel("venice:zai-org-glm-5-2", { env: { VENICE_API_KEY: "vk-test" } });
    expect(row.availability).toBe("selectable");
    expect(row.routing).toBe("venice-hosted");
  });

  test("explicit signed modalities are not widened by a positive Venice vision hint", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "venice-resolved-"));
    const cachePath = path.join(directory, "cache.json");
    const previous = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    try {
      process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = cachePath;
      writeVeniceSnapshot(cachePath, {
        fetchedAt: new Date().toISOString(),
        complete: false,
        models: {
          "e2ee-deepseek-v4-flash": {
            tools: true,
            vision: true,
            reasoning: true,
            e2ee: false,
            webSearch: false,
          },
          "qwen-3-6-plus": {
            tools: true,
            vision: true,
            reasoning: true,
            e2ee: false,
            webSearch: false,
          },
        },
      });
      const row = resolveCatalogModel("venice:e2ee-deepseek-v4-flash", {
        env: { VENICE_API_KEY: "vk-test" },
        allowChinaUpstream: true,
      });
      expect(row.input).toEqual(["text"]);
      const legacyOmitted = resolveCatalogModel("venice:qwen-3-6-plus", {
        env: { VENICE_API_KEY: "vk-test" },
        allowChinaUpstream: true,
      });
      expect(legacyOmitted.input).toEqual(["text", "image"]);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
      else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("workload-isolated Venice media rows are listable without fabricated chat token or reference claims", () => {
    const ids = [
      "venice:seedance-2-5-text-to-video-basic",
      "venice:minimax-h3-enhanced-text-to-video",
      "venice:sonilo-v1-1-music",
      "venice:minimax-music-v26",
    ];
    const expectedOutput = ["video", "video", "audio", "audio"];
    const expectedFamily = ["video", "video", "music", "music"];
    const listed = listResolvedCatalogModels({
      env: { VENICE_API_KEY: "vk-test" },
      includeUnavailable: true,
    });
    for (const [index, id] of ids.entries()) {
      const row = listed.find((candidate) => candidate.id === id);
      expect(row).toMatchObject({
        id,
        availability: "selectable",
        workload: "generation",
        input: ["text"],
        output: [expectedOutput[index]],
        generation: { family: expectedFamily[index], references: null },
        privacyLabel: "anonymized",
        contextTokens: null,
        maxOutputTokens: null,
        intelligenceTier: null,
      });
    }
  });

  test("a fresh complete Venice snapshot makes a confirmed offline media model non-selectable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "venice-resolved-"));
    const cachePath = path.join(directory, "cache.json");
    const previous = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    try {
      process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = cachePath;
      const fetchedAt = new Date().toISOString();
      writeVeniceSnapshot(cachePath, {
        fetchedAt,
        complete: true,
        models: {
          "seedance-2-5-text-to-video-basic": {
            type: "video",
            offline: true,
            privacy: "private",
            capabilities: null,
          },
        },
      });
      const row = resolveCatalogModel("venice:seedance-2-5-text-to-video-basic", {
        env: { VENICE_API_KEY: "vk-test" },
      });
      expect(row.availability).toBe("disabled");
      expect(row.unavailableReason).toBe("Venice reports this model offline");
      expect(row.lastVerifiedAt).toBe(fetchedAt);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
      else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only a fresh complete Venice snapshot can deny an absent fallback row", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "venice-resolved-"));
    const cachePath = path.join(directory, "cache.json");
    const previous = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    try {
      process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = cachePath;
      writeVeniceSnapshot(cachePath, {
        fetchedAt: new Date().toISOString(),
        complete: true,
        models: {
          "zai-org-glm-5-1": {
            type: "text",
            offline: false,
            privacy: "private",
            capabilities: null,
          },
        },
      });
      const removed = resolveCatalogModel("venice:sonilo-v1-1-music", {
        env: { VENICE_API_KEY: "vk-test" },
      });
      expect(removed.availability).toBe("disabled");
      expect(removed.unavailableReason).toBe("model absent from fresh complete Venice catalog");

      writeVeniceSnapshot(cachePath, {
        fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        complete: true,
        models: {},
      });
      const stale = resolveCatalogModel("venice:sonilo-v1-1-music", {
        env: { VENICE_API_KEY: "vk-test" },
      });
      expect(stale.availability).toBe("selectable");

      writeVeniceSnapshot(cachePath, {
        fetchedAt: new Date().toISOString(),
        complete: false,
        models: {
          "seedance-2-5-text-to-video-basic": {
            type: "video",
            offline: true,
            privacy: "private",
            capabilities: null,
          },
        },
      });
      const partial = resolveCatalogModel("venice:sonilo-v1-1-music", {
        env: { VENICE_API_KEY: "vk-test" },
      });
      expect(partial.availability).toBe("selectable");
      const partialOffline = resolveCatalogModel("venice:seedance-2-5-text-to-video-basic", {
        env: { VENICE_API_KEY: "vk-test" },
      });
      expect(partialOffline.availability).toBe("selectable");
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
      else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("known static limits populate contextTokens and maxOutputTokens without a fetch", () => {
    const row = resolveCatalogModel("anthropic:claude-sonnet-4-6", { env: { ANTHROPIC_API_KEY: "x" } });
    expect(typeof row.contextTokens).toBe("number");
    expect(row.contextTokens!).toBeGreaterThan(0);
    expect(row.maxOutputTokens).toBe(128_000);
  });

  test("axes + provenance populated for a curated frontier row", () => {
    const row = resolveCatalogModel("anthropic:claude-sonnet-4-6", { env: { ANTHROPIC_API_KEY: "x" } });
    expect(row.privacyGrade).toBe(1);
    expect(row.intelligenceTier).toBe("frontier");
    expect(row.intelligenceRank).toBe(4);
    expect(row.costCoefficient).toBe(1.0);
    expect(row.provenance).not.toBe(null);
  });

  test("OpenRouter cache features flow through as known (non-null) values", () => {
    setModelCapabilitiesCacheForTests({
      fetchedAt: new Date().toISOString(),
      models: {
        "moonshotai/kimi-k2.6": {
          input: ["text"],
          output: ["text"],
          features: { tools: false, structuredOutputs: false, reasoning: true },
        },
      },
    });
    const row = resolveCatalogModel("openrouter:moonshotai/kimi-k2.6", { env: { OPENROUTER_API_KEY: "x" } });
    expect(row.features.tools).toBe(false);
    expect(row.features.structuredOutputs).toBe(false);
    expect(row.features.reasoning).toBe(true);
    expect(row.provenance).toBe("openrouter");
  });

  test("list never performs a network fetch ( / 1.2.3)", () => {
    const original = globalThis.fetch;
    let called = 0;
    // Replace fetch with a trap; any awaited fetch would throw and fail the run.
    (globalThis as { fetch: unknown }).fetch = () => {
      called++;
      throw new Error("fetch must not be called during resolved-catalog resolution");
    };
    try {
      const rows = listResolvedCatalogModels({ env: NO_ENV, includeUnavailable: true });
      expect(rows.length).toBeGreaterThan(0);
      for (const m of ASSISTANT_MODELS) {
        resolveCatalogModel(m.id, { env: NO_ENV });
      }
      // Also exercise the legacy picker projection (shares the resolved row).
      getEligibleModels({ includeUnavailable: true });
      expect(called).toBe(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });

  test("list excludes unavailable rows by default, includes them with includeUnavailable", () => {
    const onlySelectable = listResolvedCatalogModels({ env: NO_ENV });
    expect(onlySelectable.every((r) => r.availability === "selectable")).toBe(true);
    const withUnavailable = listResolvedCatalogModels({ env: NO_ENV, includeUnavailable: true });
    expect(withUnavailable.length).toBeGreaterThan(onlySelectable.length);
    expect(withUnavailable.some((r) => r.availability !== "selectable")).toBe(true);
  });

  test("catalog parity guard: every curated row has intelligence metadata", () => {
    for (const m of ASSISTANT_MODELS) {
      const row: ResolvedCatalogModel = resolveCatalogModel(m.id, { env: { ...process.env, VENICE_API_KEY: "x" }, allowChinaUpstream: true });
      expect(row.intelligenceTier).not.toBe(null);
      expect(row.intelligenceRank).not.toBe(null);
    }
  });
});
