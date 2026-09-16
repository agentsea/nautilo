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
});
