import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  modelIdForCapabilityProjection,
  resolveModelRole,
} from "../../src/config/model-role-resolution";
import { ModelCatalogSchema } from "@nautilo/types";

function textModel(
  id: string,
  provider: "openrouter" | "venice" | "openai",
  priority: number,
) {
  return {
    id,
    displayName: id,
    provider,
    routing: provider === "openrouter"
      ? "openrouter" as const
      : provider === "venice"
        ? "venice-hosted" as const
        : "first-party" as const,
    priority,
    defaultEnabled: true,
    cost: { coefficient: 1 },
    privacy: { grade: provider === "venice" ? 6 : 2 },
    intelligence: { tier: "frontier" as const },
    limits: { contextTokens: 1_000_000, outputTokens: 128_000 },
    modalities: { input: ["text" as const, "image" as const], output: ["text" as const] },
    features: { tools: true, structuredOutputs: true, reasoning: true },
  };
}

const catalog = ModelCatalogSchema.parse({
  version: 1,
  catalogVersion: "2026.08.12.1",
  publishedAt: "2026-08-12T00:00:00.000Z",
  entries: [
    textModel("openrouter:minimax/minimax-m3", "openrouter", 10),
    textModel("venice:minimax-m3-preview", "venice", 11),
    textModel("openrouter:moonshotai/kimi-k3", "openrouter", 12),
    textModel("venice:kimi-k3", "venice", 13),
    textModel("openai:gpt-5.6-terra", "openai", 14),
    textModel("openai:gpt-5.6-luna", "openai", 15),
    {
      id: "openrouter:anthropic/claude-sonnet-4.6",
      displayName: "Claude Sonnet 4.6 (OpenRouter)",
      provider: "openrouter",
      routing: "openrouter",
      priority: 1,
      defaultEnabled: true,
      cost: { coefficient: 1 },
      privacy: { grade: 2 },
      intelligence: { tier: "frontier" },
      limits: { contextTokens: 1_000_000, outputTokens: 128_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      features: { tools: true, structuredOutputs: true, reasoning: true },
    },
    {
      id: "venice:claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6 (Venice)",
      provider: "venice",
      routing: "western-anonymized",
      priority: 2,
      defaultEnabled: true,
      cost: { coefficient: 1.8 },
      privacy: { grade: 6 },
      intelligence: { tier: "frontier" },
      limits: { contextTokens: 1_000_000, outputTokens: 128_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
      features: { tools: true, structuredOutputs: true, reasoning: true },
    },
    {
      id: "openrouter:openai/text-embedding-3-small",
      displayName: "Text Embedding 3 Small (OpenRouter)",
      provider: "openrouter",
      routing: "openrouter",
      priority: 3,
      defaultEnabled: true,
      cost: { coefficient: 1 },
      privacy: { grade: 2 },
      intelligence: { tier: "small" },
      limits: { contextTokens: 8_192, outputTokens: 8_192 },
      modalities: { input: ["text"], output: ["embedding"] },
      features: { tools: false, structuredOutputs: false, reasoning: false },
    },
    {
      id: "venice:text-embedding-3-small",
      displayName: "BGE M3 Embeddings (Venice)",
      provider: "venice",
      routing: "venice-hosted",
      priority: 4,
      defaultEnabled: true,
      cost: { coefficient: 1 },
      privacy: { grade: 6 },
      intelligence: { tier: "small" },
      limits: { contextTokens: 8_192, outputTokens: 8_192 },
      modalities: { input: ["text"], output: ["embedding"] },
      features: { tools: false, structuredOutputs: false, reasoning: false },
    },
    {
      id: "openrouter:openai/gpt-5.4-image-2",
      displayName: "GPT-5.4 Image 2 (OpenRouter)",
      provider: "openrouter",
      routing: "openrouter",
      priority: 5,
      defaultEnabled: true,
      cost: { coefficient: 1.28 },
      privacy: { grade: 4 },
      intelligence: { tier: "frontier" },
      limits: { contextTokens: 8_192, outputTokens: 8_192 },
      modalities: { input: ["text", "image", "file"], output: ["image"] },
      features: { tools: false, structuredOutputs: true, reasoning: true },
    },
  ],
});

describe("resolveModelRole", () => {
  beforeEach(async () => {
    configureRuntimeModelCatalog({
      loader: {
        get: async () => ({
          catalog,
          source: "remote-fresh",
          stale: false,
          fetchedAt: "2026-08-12T00:00:00.000Z",
          originUrl: "https://catalog.invalid/m252.json",
          reason: "",
          catalogVersion: catalog.catalogVersion,
        }),
        refresh: async () => {},
        clearCache: () => {},
      },
    });
    await hydrateRuntimeModelCatalog();
  });

  afterEach(() => resetRuntimeModelCatalog());

  test("chooses by candidate order among currently credentialed routes", () => {
    expect(resolveModelRole("chat", { env: { OPENROUTER_API_KEY: "or" } })).toBe(
      "openrouter:minimax/minimax-m3",
    );
    expect(resolveModelRole("chat", { env: { VENICE_API_KEY: "vk" } })).toBe(
      "venice:minimax-m3-preview",
    );
  });

  test("managed Gateway takes precedence for chat/background while preserving an existing Venice embedding identity", () => {
    const env = {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1",
      VENICE_API_KEY: "venice-direct-key",
    };
    expect(resolveModelRole("chat", { env })).toBe("openrouter:minimax/minimax-m3");
    expect(resolveModelRole("systemTasks", { env })).toBe("openrouter:minimax/minimax-m3");
    expect(resolveModelRole("embeddings", { env })).toBe(
      "venice:text-embedding-3-small",
    );
  });

  test("Gateway-only automatic embeddings select the existing signed OpenRouter route", () => {
    const env = {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      NAUTILO_MANAGED_GATEWAY_BASE_URL: "https://gateway.qa.example/v1",
    };
    expect(resolveModelRole("embeddings", { env })).toBe(
      "openrouter:openai/text-embedding-3-small",
    );
  });

  test("malformed managed Gateway configuration blocks chat and direct OpenRouter embedding fallback", () => {
    const env = {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      OPENROUTER_API_KEY: "direct-openrouter-must-not-be-used",
    };
    expect(() => resolveModelRole("chat", { env })).toThrow(
      "NAUTILO_MANAGED_GATEWAY_BASE_URL",
    );
    expect(() => resolveModelRole("embeddings", { env })).toThrow(
      "NAUTILO_MANAGED_GATEWAY_BASE_URL",
    );
  });

  test("malformed managed Gateway configuration preserves the signed legacy Venice embedding route", () => {
    const managed = { NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}` };
    expect(resolveModelRole("embeddings", {
      env: { ...managed, VENICE_API_KEY: "existing-venice-key" },
    })).toBe("venice:text-embedding-3-small");
  });

  test("malformed managed Gateway configuration does not disable direct OpenRouter image roles", () => {
    const env = {
      NAUTILO_MANAGED_GATEWAY_API_KEY: `ngw_${"a".repeat(43)}`,
      OPENROUTER_API_KEY: "direct-openrouter-image-key",
    };
    const configuredId = "openrouter:openai/gpt-5.4-image-2";
    expect(resolveModelRole("imageGeneration", { env, configuredId })).toBe(configuredId);
  });

  test("uses any eligible chat route for research after preferences are exhausted", async () => {
    const lone = ModelCatalogSchema.parse({
      ...catalog,
      entries: [{ ...catalog.entries[0], id: "openrouter:example/new-chat", priority: 10 }],
    });
    configureRuntimeModelCatalog({ loader: {
      get: async () => ({ catalog: lone, source: "remote-fresh", stale: false,
        fetchedAt: "2026-08-12T00:00:00.000Z", originUrl: "https://catalog.invalid/test.json",
        reason: "", catalogVersion: lone.catalogVersion }),
      refresh: async () => {}, clearCache: () => {},
    } });
    await hydrateRuntimeModelCatalog();
    for (const role of ["webSearchSynthesis", "deepResearchSupervisor", "deepResearchResearcher",
      "deepResearchSynthesis", "deepResearchFinalReport"] as const) {
      expect(resolveModelRole(role, { env: { OPENROUTER_API_KEY: "test" } })).toBe("openrouter:example/new-chat");
      expect(() => resolveModelRole(role, { env: {} })).toThrow();
    }
  });

  test("prefers MiniMax M3 for mini-cloud routes and preserves direct OpenAI choices", () => {
    for (const provider of ["openrouter", "venice", "openai"] as const) {
      const ids: readonly [string, string] = provider === "venice"
        ? ["venice:minimax-m3-preview", "venice:minimax-m3-preview"]
        : provider === "openrouter"
          ? ["openrouter:minimax/minimax-m3", "openrouter:minimax/minimax-m3"]
          : ["openai:gpt-5.6-terra", "openai:gpt-5.6-luna"];
      const env = { [provider.toUpperCase() + "_API_KEY"]: "test" };
      expect(resolveModelRole("chat", { env })).toBe(ids[0]);
      for (const role of ["conductor", "stenographer", "memoryReview", "memoryFlush", "sessionSearch", "systemTasks"] as const) {
        expect(resolveModelRole(role, { env })).toBe(ids[1]);
      }
      if (provider !== "openai") {
        expect(resolveModelRole("webSearchSynthesis", { env })).toBe(ids[1]);
        expect(resolveModelRole("visionFallback", { env })).toBe(ids[1]);
      }
    }
  });

  test("the checked-in catalog makes the new mini-cloud defaults runnable", async () => {
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
    await hydrateRuntimeModelCatalog();

    const minimaxRoles = ["chat", "conductor", "stenographer", "sessionSearch", "memoryFlush",
      "memoryReview", "webSearchSynthesis", "systemTasks", "visionFallback"] as const;
    for (const role of minimaxRoles) {
      expect(resolveModelRole(role, { env: { OPENROUTER_API_KEY: "or" } }), role)
        .toBe("openrouter:minimax/minimax-m3");
      expect(resolveModelRole(role, { env: { VENICE_API_KEY: "vk" } }), role)
        .toBe("venice:minimax-m3-preview");
    }

    const researchRoles = ["deepResearchSupervisor", "deepResearchResearcher",
      "deepResearchSynthesis", "deepResearchFinalReport"] as const;
    for (const role of researchRoles) {
      expect(resolveModelRole(role, { env: { OPENROUTER_API_KEY: "or" } }), role)
        .toBe("openrouter:moonshotai/kimi-k3");
      expect(resolveModelRole(role, { env: { VENICE_API_KEY: "vk" } }), role)
        .toBe("venice:kimi-k3");
    }
  });

  test("does not substitute an explicit unavailable selection", () => {
    expect(() =>
      resolveModelRole("chat", {
        configuredId: "openrouter:anthropic/claude-sonnet-4.6",
        env: { VENICE_API_KEY: "vk" },
      }),
    ).toThrow("OpenRouter credential is not configured");
  });

  test("resolves embeddings only from signed, credentialed embedding rows", () => {
    expect(resolveModelRole("embeddings", { env: { OPENROUTER_API_KEY: "or" } })).toBe(
      "openrouter:openai/text-embedding-3-small",
    );
    expect(resolveModelRole("embeddings", { env: { VENICE_API_KEY: "vk" } })).toBe(
      "venice:text-embedding-3-small",
    );
  });

  test("prefers Venice when multiple embedding candidates are runnable", () => {
    expect(resolveModelRole("embeddings", {
      env: { OPENROUTER_API_KEY: "or", VENICE_API_KEY: "vk" },
    })).toBe("venice:text-embedding-3-small");
  });

  test("fails truthfully when no candidate is runnable", () => {
    expect(() => resolveModelRole("chat", { env: {} })).toThrow(
      "No signed, credentialed model is runnable for the chat role.",
    );
  });

  test("capability projection preserves a selected ID without requiring credentials", () => {
    expect(modelIdForCapabilityProjection("chat", " custom:model ")).toBe("custom:model");
    expect(modelIdForCapabilityProjection("chat")).toBe(
      "openrouter:minimax/minimax-m3",
    );
  });
});
