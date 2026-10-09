import { describe, expect, test } from "bun:test";
import {
  MODEL_BADGE_ACTUAL,
  MODEL_BADGE_FALLBACK_ESTIMATE,
  MODEL_BADGE_PENDING,
  MODEL_BADGE_UNKNOWN,
  buildModelBarRows,
  callTypeLabel,
  modelRowBadges,
  modelRowTitle,
  normalizeAdminCosts,
  normalizePersonalCosts,
  type CostsModelBarInput,
} from "../../src/pages/costs/costs-view-model";
import type { CostsSummary } from "../../src/lib/costs-api";

function modelRow(
  overrides: Partial<CostsModelBarInput> & Pick<CostsModelBarInput, "model">,
): CostsModelBarInput {
  return {
    provider: "openai",
    displayName: overrides.model,
    calls: 1,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.01,
    actualCostUsd: 0,
    totalCostUsd: 0.01,
    hasActual: false,
    hasFallbackEstimate: false,
    pendingAttempts: 0,
    unknownAttempts: 0,
    ...overrides,
  };
}

describe("M217 — costs view-model badges", () => {
  test("explicit estimate only → no badges", () => {
    expect(
      modelRowBadges({ hasActual: false, hasFallbackEstimate: false }),
    ).toEqual([]);
  });

  test("provider actual only → actual badge unchanged", () => {
    expect(
      modelRowBadges({ hasActual: true, hasFallbackEstimate: false }),
    ).toEqual([MODEL_BADGE_ACTUAL]);
  });

  test("fallback estimate only → fallback estimate badge", () => {
    expect(
      modelRowBadges({ hasActual: false, hasFallbackEstimate: true }),
    ).toEqual([MODEL_BADGE_FALLBACK_ESTIMATE]);
  });

  test("mixed actual + fallback aggregate → both badges (actual first)", () => {
    expect(
      modelRowBadges({ hasActual: true, hasFallbackEstimate: true }),
    ).toEqual([MODEL_BADGE_ACTUAL, MODEL_BADGE_FALLBACK_ESTIMATE]);
  });

  test("unresolved marketplace attempts remain visible", () => {
    expect(
      modelRowBadges({
        hasActual: false,
        hasFallbackEstimate: false,
        pendingAttempts: 2,
        unknownAttempts: 1,
      }),
    ).toEqual([MODEL_BADGE_PENDING, MODEL_BADGE_UNKNOWN]);
  });

  test("modelRowTitle preserves raw model id for diagnosis", () => {
    expect(
      modelRowTitle({
        displayName: "GPT-5.6 Terra",
        model: "openai:gpt-5.6-terra",
      }),
    ).toBe("GPT-5.6 Terra (openai:gpt-5.6-terra)");
  });
});

describe("M217 — buildModelBarRows renders every model", () => {
  const byModel: CostsModelBarInput[] = [
    modelRow({
      model: "openai:gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      totalCostUsd: 12.5,
      hasActual: false,
      hasFallbackEstimate: false,
    }),
    modelRow({
      model: "openai:gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      totalCostUsd: 8.2,
      hasActual: false,
      hasFallbackEstimate: false,
    }),
    modelRow({
      model: "anthropic:claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      totalCostUsd: 5.1,
      hasActual: false,
      hasFallbackEstimate: false,
    }),
    modelRow({
      model: "openrouter:anthropic/claude-opus-4",
      displayName: "Claude Opus 4 (OpenRouter)",
      totalCostUsd: 3.4,
      hasActual: true,
      actualCostUsd: 3.4,
      estimatedCostUsd: 0,
    }),
    modelRow({
      model: "fireworks:accounts/fireworks/models/qwen3-235b",
      displayName: "Qwen3 235B",
      totalCostUsd: 1.9,
      hasFallbackEstimate: true,
    }),
    modelRow({
      model: "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
      displayName: "Llama 3.3 70B",
      totalCostUsd: 1.2,
      hasFallbackEstimate: true,
    }),
    modelRow({
      model: "xai:grok-3",
      displayName: "Grok 3",
      totalCostUsd: 0.95,
      hasActual: false,
    }),
    modelRow({
      model: "google:gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      totalCostUsd: 0.8,
      hasActual: false,
    }),
    modelRow({
      model: "gateway:custom/experimental-model",
      displayName: "Experimental Gateway Model",
      totalCostUsd: 0.55,
      hasActual: true,
      hasFallbackEstimate: true,
      actualCostUsd: 0.4,
      estimatedCostUsd: 0.15,
    }),
    modelRow({
      model: "openai:gpt-4o-mini",
      displayName: "GPT-4o mini",
      totalCostUsd: 0.42,
    }),
    modelRow({
      model: "anthropic:claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      totalCostUsd: 0.31,
      hasFallbackEstimate: true,
    }),
  ];

  test("maps all eleven API rows without truncation", () => {
    const rows = buildModelBarRows(byModel);
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.key)).toEqual(byModel.map((m) => m.model));
  });

  test("each row title includes the raw model id", () => {
    const rows = buildModelBarRows(byModel);
    for (const row of rows) {
      expect(row.title).toContain(row.key);
      expect(row.title).toContain(row.label);
    }
  });

  test("badges lock explicit, actual, fallback, and mixed aggregate cases", () => {
    const rows = buildModelBarRows(byModel);
    const badgeByKey = Object.fromEntries(rows.map((r) => [r.key, r.badges]));

    expect(badgeByKey["openai:gpt-5.6-terra"]).toEqual([]);
    expect(badgeByKey["openrouter:anthropic/claude-opus-4"]).toEqual([
      MODEL_BADGE_ACTUAL,
    ]);
    expect(
      badgeByKey["fireworks:accounts/fireworks/models/qwen3-235b"],
    ).toEqual([MODEL_BADGE_FALLBACK_ESTIMATE]);
    expect(badgeByKey["gateway:custom/experimental-model"]).toEqual([
      MODEL_BADGE_ACTUAL,
      MODEL_BADGE_FALLBACK_ESTIMATE,
    ]);
  });
});

test("admin headlines derive the current estimate without double-counting historical estimates", () => {
  const data = {
    totals: {
      calls: 1,
      providerOperations: 0,
      unknownProviderOperations: 0,
      pendingModelAttempts: 0,
      unknownModelAttempts: 0,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostUsd: 5,
      actualCostUsd: 3,
      totalCostUsd: 4,
    },
    byModel: [],
    byCallType: [],
    byProvider: [{
      provider: "tavily",
      operation: "search",
      operations: 3,
      unknownOperations: 1,
      estimatedCostUsd: 1,
      actualCostUsd: 2,
      totalCostUsd: 3,
    }],
    byUser: [],
    timeSeries: [],
  } as unknown as CostsSummary;
  expect(normalizeAdminCosts(data).totals.estimatedCostUsd).toBe(1);
  expect(normalizeAdminCosts(data).byProvider[0]).toMatchObject({
    unknownOperations: 1,
    estimatedCostUsd: 1,
    actualCostUsd: 2,
    totalCostUsd: 3,
  });
  expect(data.totals.estimatedCostUsd).toBe(5);
});

test("labels research and decision workloads", () => {
  expect(callTypeLabel("decision")).toBe("Decision");
  expect(callTypeLabel("deep_research")).toBe("Deep research");
  expect(callTypeLabel("future_workload")).toBe("future_workload");
});

test("provider normalization retains evidence buckets and safely defaults legacy fields", () => {
  const data = {
    totals: {
      calls: 0, providerOperations: 2, inputTokens: 0, cachedInputTokens: 0,
      outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0.02,
      actualCostUsd: 0, totalCostUsd: 0.02,
    },
    byModel: [], byCallType: [], byTask: [], timeSeries: [],
    byProvider: [
      { provider: "tavily", operation: "search", operations: 1,
        unknownOperations: 0, actualCostUsd: 0, estimatedCostUsd: 0.02,
        totalCostUsd: 0.02 },
      { provider: "legacy", operation: "read", operations: 1,
        totalCostUsd: 0 },
    ],
    recovery: {
      pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0,
      blockedAttempts: 0, attempts: [],
    },
  } as unknown as Parameters<typeof normalizePersonalCosts>[0];
  expect(normalizePersonalCosts(data).byProvider).toEqual([
    { provider: "tavily", operation: "search", operations: 1,
      unknownOperations: 0, measuredUnits: null, unitType: null,
      actualCostUsd: 0, estimatedCostUsd: 0.02,
      totalCostUsd: 0.02 },
    { provider: "legacy", operation: "read", operations: 1,
      unknownOperations: 0, measuredUnits: null, unitType: null,
      actualCostUsd: 0, estimatedCostUsd: 0,
      totalCostUsd: 0 },
  ]);
});
