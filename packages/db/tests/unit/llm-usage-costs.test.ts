/**
 * ISSUE-M217 — costs aggregation fallback disclosure from stored metadata.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  __setLlmUsageDbForTests,
  buildCostsSummaryQueries,
  getCostsSummary,
} from "../../src/queries/llm-usage";

const RANGE = {
  sinceIso: "2026-07-01T00:00:00.000Z",
  untilIso: "2026-08-01T00:00:00.000Z",
};

function emptyTotalsRow() {
  return {
    calls: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_cost: 0,
    actual_cost: 0,
    total_cost: 0,
  };
}

function mockDb(responses: unknown[][]) {
  let executionIndex = 0;
  const query = () => {
    const builder: object = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "then") {
            return (
              resolve: (value: unknown[]) => unknown,
              reject: (reason: unknown) => unknown,
            ) =>
              Promise.resolve(responses[executionIndex++] ?? []).then(
                resolve,
                reject,
              );
          }
          return () => builder;
        },
      },
    );
    return builder;
  };
  return {
    select: query,
    insert: () => ({ values: async () => {} }),
  } as unknown as DirectDatabase;
}

describe("getCostsSummary fallback disclosure (ISSUE-M217)", () => {
  afterEach(() => {
    __setLlmUsageDbForTests(null);
  });

  test("explicit stored rows do not set hasFallbackEstimate", async () => {
    __setLlmUsageDbForTests(
      mockDb([
        [emptyTotalsRow()],
        [
          {
            model: "openai:gpt-5.6-terra",
            provider: "openai",
            calls: 1,
            input_tokens: 100,
            output_tokens: 20,
            estimated_cost: 0.001,
            actual_cost: 0,
            total_cost: 0.001,
            has_actual: false,
            has_fallback_estimate: false,
          },
        ],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );

    const summary = await getCostsSummary(RANGE);
    expect(summary.byModel[0]?.hasFallbackEstimate).toBe(false);
  });

  test("legacy rows without stored source omit fallback disclosure", async () => {
    __setLlmUsageDbForTests(
      mockDb([
        [emptyTotalsRow()],
        [
          {
            model: "legacy:model",
            provider: "openrouter",
            calls: 1,
            input_tokens: 50,
            output_tokens: 10,
            estimated_cost: 0.002,
            actual_cost: 0,
            total_cost: 0.002,
            has_actual: false,
            has_fallback_estimate: false,
          },
        ],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );

    const summary = await getCostsSummary(RANGE);
    expect(summary.byModel[0]?.hasFallbackEstimate).toBe(false);
  });

  test("mixed actual and fallback rows disclose fallback while keeping actual totals", async () => {
    __setLlmUsageDbForTests(
      mockDb([
        [
          {
            calls: 2,
            input_tokens: 150,
            cached_input_tokens: 0,
            output_tokens: 30,
            total_tokens: 180,
            estimated_cost: 0.003,
            actual_cost: 0.004,
            total_cost: 0.007,
          },
        ],
        [
          {
            model: "openrouter:mixed-model",
            provider: "openrouter",
            calls: 2,
            input_tokens: 150,
            output_tokens: 30,
            estimated_cost: 0.003,
            actual_cost: 0.004,
            total_cost: 0.007,
            has_actual: true,
            has_fallback_estimate: true,
          },
        ],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );

    const summary = await getCostsSummary(RANGE);
    const row = summary.byModel[0];
    expect(row?.hasActual).toBe(true);
    expect(row?.hasFallbackEstimate).toBe(true);
    expect(row?.actualCostUsd).toBeCloseTo(0.004, 8);
    expect(row?.totalCostUsd).toBeCloseTo(0.007, 8);
  });

  test("by-model SQL derives fallback disclosure from stored metadata", async () => {
    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const queries = buildCostsSummaryQueries(
      RANGE,
      offlineDb,
    );
    const compiled = Object.values(queries).map((queryBuilder) =>
      queryBuilder.toSQL(),
    );
    const byModelSql = compiled[1]!.sql.replace(/\s+/g, " ").trim();
    expect(byModelSql).toContain('as "has_fallback_estimate"');
    expect(byModelSql).toContain(`"llm_usage_events"."metadata"->>'usagePricingSource'`);
    expect(byModelSql).toContain("'catalog_coefficient'");
    expect(byModelSql).toContain("'baseline_default'");
    expect(byModelSql).toContain("'image_default'");
    expect(byModelSql).toMatch(
      /"llm_usage_events"\."actual_cost_usd" is null\s+and/i,
    );
    expect(compiled).toHaveLength(5);
    for (const generated of compiled) {
      expect(generated.sql).toContain('"llm_usage_events"');
      expect(generated.params.some((param) => param instanceof Date)).toBe(
        false,
      );
      expect(generated.params).toContain(RANGE.sinceIso);
      expect(generated.params).toContain(RANGE.untilIso);
    }
    expect(compiled[3]!.sql).toContain('left join "users"');
  });

  test("administrator aggregates exclude only explicitly personal-funded usage", () => {
    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const compiled = Object.values(buildCostsSummaryQueries(RANGE, offlineDb)).map(
      (queryBuilder) => queryBuilder.toSQL(),
    );

    for (const generated of compiled) {
      expect(generated.sql.toLowerCase()).toContain(
        '("llm_usage_events"."funding_kind" is null or "llm_usage_events"."funding_kind" <>',
      );
      expect(generated.params).toContain("personal");
    }
  });

  test("pending and unknown model attempts are counted without entering known spend", async () => {
    __setLlmUsageDbForTests(
      mockDb([
        [{
          ...emptyTotalsRow(),
          calls: 2,
          pending_model_attempts: 1,
          unknown_model_attempts: 1,
        }],
        [{
          model: "venice:openai-gpt-55",
          provider: "venice",
          calls: 2,
          pending_attempts: 1,
          unknown_attempts: 1,
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost: 0,
          actual_cost: 0,
          total_cost: 0,
          has_actual: false,
          has_fallback_estimate: false,
        }],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]),
    );

    const summary = await getCostsSummary(RANGE);
    expect(summary.totals).toMatchObject({
      calls: 2,
      pendingModelAttempts: 1,
      unknownModelAttempts: 1,
      totalCostUsd: 0,
    });
    expect(summary.byModel[0]).toMatchObject({
      pendingAttempts: 1,
      unknownAttempts: 1,
      totalCostUsd: 0,
    });
  });

  test("known-spend SQL preserves legacy rows and zeros unresolved attempt estimates", () => {
    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const compiled = Object.values(buildCostsSummaryQueries(RANGE, offlineDb)).map(
      (queryBuilder) => queryBuilder.toSQL().sql.replace(/\s+/g, " ").toLowerCase(),
    );
    expect(compiled[0]).toContain("cost_state\" in ('pending', 'unknown')");
    expect(compiled[0]).toContain("then 0");
    expect(compiled[0]).toContain("else coalesce");
    expect(compiled[1]).toContain("filter (where \"cost_state\" = 'pending')");
    expect(compiled[1]).toContain("filter (where \"cost_state\" = 'unknown')");
  });
});
