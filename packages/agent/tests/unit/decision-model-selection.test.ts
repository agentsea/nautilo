import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";
import { ModelCatalogV4Schema, type ModelCatalog } from "@nautilo/types";
import {
  getEligibleModels,
  resolveRetainedModels,
} from "../../src/config/eligible-models";
import { getDefaultModel } from "../../src/config/assistant-models";
import {
  NoRunnableModelForRoleError,
  resolveModelRole,
} from "../../src/config/model-role-resolution";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import { resolveCatalogModel } from "../../src/config/resolved-catalog";
import { validateExactTaskModelSelection } from "../../src/config/validate-exact-task-model";
import { resetVeniceCatalogCacheModuleForTests } from "../../src/config/venice-catalog-cache";
import { createUniversalModel } from "../../src/providers/universal";

const JEV_ID = "openrouter:typesafe/jev-1.13";
const OPENROUTER_ENV: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "or-test" };

async function installCatalog(catalog: ModelCatalog): Promise<void> {
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-09-18T12:00:00.000Z",
        originUrl: "https://catalog.invalid/decision-test.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

function onlyDecisionCatalog(provider: "openrouter" | "venice" = "openrouter"): ModelCatalog {
  const current = getActiveModelCatalogSync().catalog;
  if (current.version !== 4 && current.version !== 5) {
    throw new Error("checked-in Jev decision fixture is missing");
  }
  const decision = current.entries.find((entry) => entry.id === JEV_ID);
  if (!decision || decision.workload !== "decision") {
    throw new Error("checked-in Jev decision fixture is missing");
  }
  return ModelCatalogV4Schema.parse({
    ...current,
    version: 4,
    catalogVersion: "2026.09.18.2",
    entries: provider === "openrouter"
      ? [decision]
      : [{
          ...decision,
          id: "venice:jev-decision-test",
          displayName: "Unsupported Venice Decision Test",
          provider: "venice",
          routing: "venice-hosted",
        }],
  });
}

describe("decision model selection boundaries", () => {
  let priorDefaultModel: string | undefined;
  let priorOpenRouterKey: string | undefined;
  let priorSkipVeniceRefresh: string | undefined;
  let priorVeniceCachePath: string | undefined;

  beforeEach(() => {
    resetRuntimeModelCatalog();
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    priorDefaultModel = process.env["NAUTILO_MODEL"];
    priorOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    priorSkipVeniceRefresh = process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    priorVeniceCachePath = process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
    process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] =
      `/tmp/nautilo-decision-model-missing-${process.pid}/venice-models.json`;
  });

  afterEach(() => {
    resetRuntimeModelCatalog();
    resetVeniceCatalogCacheModuleForTests();
    resetModelCapabilitiesCacheForTests();
    if (priorSkipVeniceRefresh === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = priorSkipVeniceRefresh;
    if (priorDefaultModel === undefined) delete process.env["NAUTILO_MODEL"];
    else process.env["NAUTILO_MODEL"] = priorDefaultModel;
    if (priorOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorOpenRouterKey;
    if (priorVeniceCachePath === undefined) delete process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"];
    else process.env["NAUTILO_VENICE_MODELS_CACHE_PATH"] = priorVeniceCachePath;
  });

  test("Jev is unavailable to plain chat, tool chat, and Task candidate pools", () => {
    for (const purpose of ["chat", "chat-tools", "task-tool-free", "task-tools"] as const) {
      expect(getEligibleModels({ env: OPENROUTER_ENV, purpose }).some((row) => row.id === JEV_ID), purpose)
        .toBe(false);
      expect(resolveRetainedModels([JEV_ID], { env: OPENROUTER_ENV, purpose })[0], purpose)
        .toMatchObject({
          id: JEV_ID,
          availability: "unsupported-capability",
          enabled: false,
          unavailableReason: "decision workload cannot be used for chat",
          capabilities: { tools: false },
        });
    }
  });

  test("tool-free exact Tasks still reject Jev as a non-chat workload", () => {
    expect(validateExactTaskModelSelection({
      requestedModelId: JEV_ID,
      toolsMode: "none",
      env: OPENROUTER_ENV,
    })).toEqual({
      code: "capability_mismatch",
      modelId: JEV_ID,
      message:
        `Model "${JEV_ID}" uses the decision workload. ` +
        "Tasks require a chat model, including tool-free runs.",
    });
  });

  test("configured chat defaults and role fallback cannot select Jev", async () => {
    expect(() => resolveModelRole("chat", {
      configuredId: JEV_ID,
      env: OPENROUTER_ENV,
    })).toThrow("decision workload cannot be used for chat");

    process.env["NAUTILO_MODEL"] = JEV_ID;
    process.env["OPENROUTER_API_KEY"] = "or-test";
    expect(() => getDefaultModel()).toThrow("decision workload cannot be used for chat");

    await installCatalog(onlyDecisionCatalog());
    expect(() => resolveModelRole("webSearchSynthesis", { env: OPENROUTER_ENV }))
      .toThrow(NoRunnableModelForRoleError);
  });

  test("direct universal chat construction rejects Jev before any network access", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must not be reached");
    };
    try {
      try {
        await createUniversalModel(JEV_ID, { apiKey: "or-test" });
        expect.unreachable("Jev must be rejected before chat model construction");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /decision workload and cannot be used for chat completion/,
        );
      }
      expect(fetchCalls).toBe(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("a signed decision row stays disabled when its provider lacks a decision adapter", async () => {
    const catalog = onlyDecisionCatalog("venice");
    await installCatalog(catalog);

    expect(resolveCatalogModel("venice:jev-decision-test", {
      env: { VENICE_API_KEY: "vk-test" },
      allowChinaUpstream: true,
    })).toMatchObject({
      availability: "disabled",
      unavailableReason:
        'provider "venice" is not supported for the decision workload on this server',
      workload: "decision",
      decision: { operations: ["choice"], inputTokens: 32_000, maxChoices: 255 },
    });
  });

  test("the decision gate preserves existing chat and media availability", () => {
    expect(resolveCatalogModel("openrouter:minimax/minimax-m3", {
      env: OPENROUTER_ENV,
    })).toMatchObject({
      availability: "selectable",
      workload: "chat",
      decision: null,
    });
    expect(resolveCatalogModel("venice:seedance-2-5-text-to-video-basic", {
      env: { VENICE_API_KEY: "vk-test" },
      allowChinaUpstream: true,
    })).toMatchObject({
      availability: "selectable",
      workload: "generation",
      generation: { family: "video" },
      decision: null,
    });
  });
});
