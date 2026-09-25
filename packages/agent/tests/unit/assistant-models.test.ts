import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelCatalog, ModelCatalogRoutingClass } from "@nautilo/types";
import {
  ASSISTANT_MODELS,
  getDefaultModel,
  getModelById,
  getEnabledModels,
  getNextFallbackModel,
  getCostCoefficient,
  getProviderFromModelId,
} from "../../src/config/assistant-models";
import {
  configureRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";

beforeEach(() => {
  resetRuntimeModelCatalog();
});

afterEach(() => {
  resetRuntimeModelCatalog();
});

async function activateRemoteRows(
  rows: Array<{
    id: string;
    provider: string;
    routing: ModelCatalogRoutingClass;
    coefficient: number;
  }>,
): Promise<void> {
  const catalog: ModelCatalog = {
    version: 1,
    catalogVersion: "2026.07.18.4",
    publishedAt: "2026-07-18T14:00:00Z",
    entries: rows.map((row, index) => ({
      id: row.id,
      displayName: `Remote ${row.id}`,
      provider: row.provider,
      routing: row.routing,
      priority: index + 1,
      defaultEnabled: true,
      limits: { contextTokens: 128_000, outputTokens: 8_000 },
      cost: { coefficient: row.coefficient },
      privacy: { grade: 1 },
      intelligence: { tier: "strong" },
    })),
  };
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-07-18T14:00:00.000Z",
        originUrl: "https://media.nautilo.ai/models/latest.json",
        reason: "",
        catalogVersion: catalog.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

describe("assistant-models", () => {
  test("getDefaultModel returns an enabled model", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    try {
      const model = getDefaultModel();
      expect(model.enabled).toBe(true);
      expect(model.id).toBeTruthy();
    } finally {
      if (original === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = original;
    }
  });

  test("getModelById returns model for valid ID", () => {
    const model = getModelById("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model!.displayName).toBe("Claude Sonnet 4.6 (Anthropic)");
  });

  test("getModelById returns undefined for unknown model", () => {
    const model = getModelById("nonexistent:model");
    expect(model).toBeUndefined();
  });

  test("getEnabledModels returns sorted by priority", () => {
    const models = getEnabledModels();
    expect(models.length).toBeGreaterThan(0);
    for (let i = 1; i < models.length; i++) {
      expect(models[i]!.priority).toBeGreaterThanOrEqual(models[i - 1]!.priority);
    }
  });

  test("getNextFallbackModel returns next priority model", () => {
    const next = getNextFallbackModel("anthropic:claude-sonnet-4-6");
    expect(next).toBeDefined();
    expect(next!.priority).toBeGreaterThan(1);
  });

  test("getNextFallbackModel returns undefined for last model", () => {
    const models = getEnabledModels();
    const last = models[models.length - 1]!;
    const next = getNextFallbackModel(last.id);
    expect(next).toBeUndefined();
  });

  test("getNextFallbackModel falls back from disabled explicit catalog rows to default enabled model", () => {
    const next = getNextFallbackModel("venice:zai-org-glm-5-1");
    expect(next?.id).toBe("anthropic:claude-sonnet-4-6");
    expect(next?.enabled).toBe(true);
  });

  test("getCostCoefficient returns 1.0 for unknown model", () => {
    expect(getCostCoefficient("unknown:model")).toBe(1.0);
  });

  test("getProviderFromModelId extracts provider", () => {
    expect(getProviderFromModelId("anthropic:claude-sonnet-4-6")).toBe("anthropic");
    expect(getProviderFromModelId("openai:gpt-5.5-2026-04-23")).toBe("openai");
    expect(getProviderFromModelId("bad")).toBe("unknown");
  });

  test("the static Venice roster replaces the absent E2EE Qwen and adds Kimi K3", () => {
    const ids = new Set(ASSISTANT_MODELS.map((model) => model.id));
    expect(ids).not.toContain("venice:e2ee-qwen3-5-122b-a10b");
    expect(ids).toContain("venice:e2ee-deepseek-v4-flash");
    expect(ids).toContain("venice:kimi-k3");
    expect(getModelById("venice:kimi-k3")).toMatchObject({
      routing: "venice-hosted",
      costCoefficient: 1.3,
    });
  });

  test("retires the Fireworks DeepSeek V4 Pro route while retaining OpenRouter", () => {
    expect(getModelById("fireworks:accounts/fireworks/models/deepseek-v4-pro-0813")).toBeUndefined();
    expect(getModelById("openrouter:deepseek/deepseek-v4-pro")).toMatchObject({ enabled: false });
    expect(getModelById("openrouter:deepseek/deepseek-v4-pro-0813")).toMatchObject({ enabled: true });
  });

  test("recognizes supported remote-only rows and their released costs", async () => {
    const rows = [
      { id: "anthropic:claude-b-only", provider: "anthropic", routing: "first-party", coefficient: 1.25 },
      { id: "fireworks:accounts/fireworks/models/b-only", provider: "fireworks", routing: "fireworks", coefficient: 0.42 },
      { id: "xai:grok-b-only", provider: "xai", routing: "first-party", coefficient: 0.8 },
      { id: "together:llama-b-only", provider: "together", routing: "together", coefficient: 0.3 },
    ] as const;
    await activateRemoteRows([...rows]);

    for (const row of rows) {
      expect(getModelById(row.id)).toMatchObject({
        id: row.id,
        enabled: true,
        costCoefficient: row.coefficient,
      });
      expect(getCostCoefficient(row.id)).toBe(row.coefficient);
    }
  });

  test("still rejects an unsupported remote-only provider", async () => {
    await activateRemoteRows([{
      id: "unsupported:vortex-b-only",
      provider: "unsupported",
      routing: "first-party",
      coefficient: 9,
    }]);
    expect(getModelById("unsupported:vortex-b-only")).toBeUndefined();
  });
});

describe("getDefaultModel NAUTILO_MODEL env override", () => {
  test("honors explicit env override to a release-enabled Venice model", () => {
    const orig = process.env["NAUTILO_MODEL"];
    const origKey = process.env["VENICE_API_KEY"];
    process.env["NAUTILO_MODEL"] = "venice:zai-org-glm-5-2";
    process.env["VENICE_API_KEY"] = "test-key";
    try {
      const model = getDefaultModel();
      expect(model.id).toBe("venice:zai-org-glm-5-2");
      expect(model.enabled).toBe(true);
    } finally {
      if (orig !== undefined) process.env["NAUTILO_MODEL"] = orig;
      else delete process.env["NAUTILO_MODEL"];
      if (origKey !== undefined) process.env["VENICE_API_KEY"] = origKey;
      else delete process.env["VENICE_API_KEY"];
    }
  });

  test("rejects an explicit env override that is absent from the signed catalog", () => {
    const orig = process.env["NAUTILO_MODEL"];
    process.env["NAUTILO_MODEL"] = "nonexistent:totally-made-up-model";
    try {
      expect(() => getDefaultModel()).toThrow("current signed catalog");
    } finally {
      if (orig !== undefined) process.env["NAUTILO_MODEL"] = orig;
      else delete process.env["NAUTILO_MODEL"];
    }
  });

  test("honors env override to an ENABLED model (no warning path)", () => {
    const orig = process.env["NAUTILO_MODEL"];
    const origKey = process.env["OPENAI_API_KEY"];
    process.env["NAUTILO_MODEL"] = "openai:gpt-5.6-sol";
    process.env["OPENAI_API_KEY"] = "test-key";
    try {
      const model = getDefaultModel();
      expect(model.id).toBe("openai:gpt-5.6-sol");
      expect(model.enabled).toBe(true);
    } finally {
      if (orig !== undefined) process.env["NAUTILO_MODEL"] = orig;
      else delete process.env["NAUTILO_MODEL"];
      if (origKey !== undefined) process.env["OPENAI_API_KEY"] = origKey;
      else delete process.env["OPENAI_API_KEY"];
    }
  });
});

describe("getModelById — pure catalog lookup (no enabled filter)", () => {
  test("returns the active released entry for a valid Venice ID", () => {
    const model = getModelById("venice:zai-org-glm-5-2");
    expect(model).toBeDefined();
    expect(model!.id).toBe("venice:zai-org-glm-5-2");
    expect(model!.enabled).toBe(true);
  });

  test("still returns undefined for truly unknown IDs", () => {
    expect(getModelById("totally-fabricated-model")).toBeUndefined();
  });
});
