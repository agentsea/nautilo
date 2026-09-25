import { afterEach, describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ModelCatalogSchema, type ModelCatalog } from "@nautilo/types";
import {
  configureRuntimeModelCatalog,
  getActiveModelCatalogSync,
  hydrateRuntimeModelCatalog,
  resetRuntimeModelCatalog,
} from "../../src/config/model-catalog/runtime-catalog";
import {
  getModelMaxOutputTokens,
  getModelTokenLimit,
  MissingModelExecutionLimitsError,
  resolveModelExecutionLimits,
} from "../../src/providers/models";
import { resolveFactoryMaxTokens } from "../../src/providers/factory";
import { resolveCompletionBudget, resolvePreparedMessageBudget, PreparedContextExceededError } from "../../src/utils/chat-model-invocation";
import { processHistory } from "../../src/utils/history-manager";

interface LimitRow {
  readonly id: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
}

function catalog(version: string, rows: readonly LimitRow[]): ModelCatalog {
  return ModelCatalogSchema.parse({
    version: 1,
    catalogVersion: version,
    publishedAt: "2026-08-23T00:00:00.000Z",
    entries: rows.map((row, index) => ({
      id: row.id,
      displayName: row.id,
      provider: "openrouter",
      routing: "openrouter",
      priority: index + 1,
      defaultEnabled: true,
      modalities: { input: ["text"], output: ["text"] },
      features: { tools: true, structuredOutputs: true, reasoning: true },
      limits: {
        contextTokens: row.contextTokens,
        outputTokens: row.outputTokens,
      },
      cost: { coefficient: 1 },
      privacy: { grade: 2 },
      intelligence: { tier: "frontier" },
    })),
  });
}

async function activateCatalog(value: ModelCatalog): Promise<void> {
  configureRuntimeModelCatalog({
    loader: {
      get: async () => ({
        catalog: value,
        source: "remote-fresh",
        stale: false,
        fetchedAt: "2026-08-23T00:00:00.000Z",
        originUrl: "https://catalog.invalid/m293-limits.json",
        reason: "",
        catalogVersion: value.catalogVersion,
      }),
      refresh: async () => {},
      clearCache: () => {},
    },
  });
  await hydrateRuntimeModelCatalog();
}

afterEach(() => resetRuntimeModelCatalog());

describe("M293 signed-catalogue execution limits", () => {
  const releasedRows: readonly LimitRow[] = [
    { id: "openrouter:anthropic/claude-sonnet-4.6", contextTokens: 1_000_000, outputTokens: 128_000 },
    { id: "openrouter:openai/gpt-5.6-sol", contextTokens: 1_050_000, outputTokens: 128_000 },
    { id: "openrouter:z-ai/glm-5.1", contextTokens: 202_752, outputTokens: 65_535 },
    { id: "openrouter:deepseek/deepseek-v4-pro", contextTokens: 1_048_576, outputTokens: 384_000 },
    { id: "openrouter:minimax/minimax-m2.7", contextTokens: 196_608, outputTokens: 196_607 },
    { id: "openrouter:qwen/qwen3.5-397b-a17b", contextTokens: 262_144, outputTokens: 65_536 },
  ];

  test("uses one signed snapshot for every representative curated route", async () => {
    await activateCatalog(catalog("2026.08.23.1", releasedRows));

    for (const row of releasedRows) {
      expect(getModelTokenLimit(row.id), row.id).toBe(row.contextTokens);
      expect(await getModelMaxOutputTokens(row.id), row.id).toBe(row.outputTokens);
      expect(await resolveModelExecutionLimits(row.id)).toEqual({
        modelId: row.id,
        catalogVersion: "2026.08.23.1",
        contextTokens: row.contextTokens,
        maxOutputTokens: row.outputTokens,
        contextSource: "catalog",
        outputSource: "catalog",
      });
    }
  });

  test("keeps context and output coherent across catalogue refreshes", async () => {
    const id = "openrouter:openai/gpt-5.6-sol";
    await activateCatalog(catalog("2026.08.23.2", [
      { id, contextTokens: 1_050_000, outputTokens: 128_000 },
    ]));
    const before = await resolveModelExecutionLimits(id);

    await activateCatalog(catalog("2026.08.23.3", [
      { id, contextTokens: 900_000, outputTokens: 96_000 },
    ]));
    const after = await resolveModelExecutionLimits(id);

    expect(before).toMatchObject({
      catalogVersion: "2026.08.23.2",
      contextTokens: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(after).toMatchObject({
      catalogVersion: "2026.08.23.3",
      contextTokens: 900_000,
      maxOutputTokens: 96_000,
    });
  });

  test("allows lower per-call budgets but never lets overrides exceed signed limits", async () => {
    const id = "openrouter:anthropic/claude-sonnet-4.6";
    await activateCatalog(catalog("2026.08.23.4", [
      { id, contextTokens: 1_000_000, outputTokens: 128_000 },
    ]));

    expect(await resolveModelExecutionLimits(id, {
      contextTokenOverride: 320_000,
      outputTokenOverride: 24_000,
    })).toMatchObject({
      contextTokens: 320_000,
      maxOutputTokens: 24_000,
      contextSource: "override",
      outputSource: "override",
    });
    expect(await resolveModelExecutionLimits(id, {
      contextTokenOverride: Number.POSITIVE_INFINITY,
      outputTokenOverride: Number.NaN,
    })).toMatchObject({
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      contextSource: "catalog",
      outputSource: "catalog",
    });
    expect(await resolveModelExecutionLimits(id, {
      contextTokenOverride: 2_000_000,
      outputTokenOverride: 256_000,
    })).toMatchObject({
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      contextSource: "catalog",
      outputSource: "catalog",
    });
    expect(await resolveFactoryMaxTokens({ modelId: id, maxTokens: 256_000 })).toBe(128_000);
    expect(await resolveFactoryMaxTokens({ modelId: id, maxTokens: 24_000 })).toBe(24_000);
  });

  test("fails closed for unknown routes instead of manufacturing generic limits", async () => {
    const id = "openrouter:unknown/dynamic-model";
    expect(() => getModelTokenLimit(id)).toThrow(MissingModelExecutionLimitsError);
    expect(resolveModelExecutionLimits(id)).rejects.toBeInstanceOf(
      MissingModelExecutionLimitsError,
    );
    expect(resolveFactoryMaxTokens({ modelId: id, maxTokens: 1 })).rejects.toBeInstanceOf(
      MissingModelExecutionLimitsError,
    );
  });

  test("uses every bundled chat model's signed budget without a global ceiling", async () => {
    resetRuntimeModelCatalog();
    const { catalog: active } = getActiveModelCatalogSync();
    let modelsAboveLegacyCeiling = 0;

    for (const entry of active.entries) {
      if (("workload" in entry && entry.workload === "generation") || !entry.limits) continue;
      const expected = Math.min(
        entry.limits.outputTokens,
        entry.limits.contextTokens - 4_097,
      );
      const actual = await resolveCompletionBudget(entry.id, [new HumanMessage("x")]);
      expect(actual, entry.id).toBe(expected);
      if (expected > 16_384) {
        modelsAboveLegacyCeiling += 1;
        expect(actual, entry.id).toBeGreaterThan(16_384);
      }
    }

    expect(modelsAboveLegacyCeiling).toBeGreaterThan(0);
  });

  test("drives completion and history budgets from the signed entry", async () => {
    const id = "openrouter:openai/gpt-5.6-sol";
    await activateCatalog(catalog("2026.08.23.5", [
      { id, contextTokens: 20_000, outputTokens: 7_000 },
    ]));

    expect(await resolveCompletionBudget(id, [new HumanMessage("short")])).toBe(7_000);

    const oversized = new HumanMessage("x".repeat(20_000));
    const processed = processHistory([oversized], {
      validationEnabled: true,
      pruningEnabled: false,
      maxMessageTokens: await resolvePreparedMessageBudget(id),
    });
    expect(processed.clamping.clampedCount).toBe(0);
    expect(processed.messages[0]).toBe(oversized);
  });
  test("uses context above the former 60 percent boundary and charges system, tools and remaining output", async () => {
    const id = "openrouter:openai/gpt-6-luna";
    await activateCatalog(catalog("2026.09.24.1", [{ id, contextTokens: 1_050_000, outputTokens: 128_000 }]));
    const { DynamicStructuredTool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const tool = new DynamicStructuredTool({ name: "read", description: "Read source", schema: z.object({ path: z.string() }), func: async () => "" });
    const { estimateTokenCount } = await import("../../src/utils/history-manager");
    const { estimateBoundToolTokens } = await import("../../src/utils/chat-model-invocation");
    const messages = [new SystemMessage("s".repeat(4_000)), new HumanMessage("x".repeat(800_000 * 4))];
    const allowance = await resolvePreparedMessageBudget(id, [tool]);
    expect(allowance).toBe(1_050_000 - 4096 - estimateBoundToolTokens([tool]));
    expect(await resolveCompletionBudget(id, messages, [tool])).toBe(128_000);
    messages.push(new HumanMessage("y".repeat(200_000 * 4)));
    expect(await resolveCompletionBudget(id, messages, [tool])).toBe(allowance - estimateTokenCount(messages));
    messages.push(new HumanMessage("z".repeat(60_000 * 4)));
    const error = await resolveCompletionBudget(id, messages, [tool]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PreparedContextExceededError);
    expect((messages[1]!.content as string).length).toBe(800_000 * 4);
  });

});
