import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DirectDatabase } from "../../src/config/direct-database";
import { __setLlmUsageDbForTests, getCostsSummary } from "../../src/queries/llm-usage";
import {
  buildProviderCostsSummaryQueries,
  estimateProviderToolCostUsd,
  insertProviderCostEventWith,
  providerCostIdempotencyKey,
  PROVIDER_TOOL_PRICING_VERSION,
} from "../../src/queries/provider-costs";

const RANGE = {
  sinceIso: "2026-09-01T00:00:00.000Z",
  untilIso: "2026-09-03T00:00:00.000Z",
};
const DIGEST = "a".repeat(64);

function mockQueryDb(responses: unknown[][]): DirectDatabase {
  let executionIndex = 0;
  const query = () => {
    const builder: object = new Proxy({}, {
      get: (_target, property) => property === "then"
        ? (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(responses[executionIndex++] ?? []).then(resolve, reject)
        : () => builder,
    });
    return builder;
  };
  return { select: query } as unknown as DirectDatabase;
}

afterEach(() => {
  __setLlmUsageDbForTests(null);
});

describe("provider cost events", () => {
  test("keeps public unit estimates exact and versioned", () => {
    expect(PROVIDER_TOOL_PRICING_VERSION).toBe("2026-09-02.1");
    expect(estimateProviderToolCostUsd("tavily:credit", 2)).toBe("0.01600000");
    expect(estimateProviderToolCostUsd("elevenlabs:v3_character", 1_234)).toBe("0.12340000");
    expect(estimateProviderToolCostUsd("openai:web_search_call", 3)).toBe("0.03000000");
    expect(estimateProviderToolCostUsd("anthropic:web_search_call", 1)).toBe("0.01000000");
    expect(estimateProviderToolCostUsd("tavily:credit", 0)).toBeNull();
    expect(providerCostIdempotencyKey("raw-provider-receipt")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("writes exact-decimal evidence with conflict-safe idempotency", async () => {
    let values: Record<string, unknown> | undefined;
    let conflictTarget: unknown;
    const builder = {
      values(input: Record<string, unknown>) {
        values = input;
        return this;
      },
      async onConflictDoNothing(input: { target: unknown }) {
        conflictTarget = input.target;
      },
    };
    const handle = { insert: () => builder } as unknown as DirectDatabase;

    await insertProviderCostEventWith(handle, {
      provider: "browser_use",
      operation: "hosted_read",
      userId: "00000000-0000-4000-8000-000000000001",
      roomId: "00000000-0000-4000-8000-000000000002",
      agentId: "00000000-0000-4000-8000-000000000003",
      actualCostUsd: "0.014",
      evidenceState: "actual",
      idempotencyKey: DIGEST,
    });

    expect(values).toMatchObject({
      provider: "browser_use",
      operation: "hosted_read",
      actualCostUsd: "0.01400000",
      estimatedCostUsd: null,
      evidenceState: "actual",
      idempotencyKey: DIGEST,
    });
    expect(conflictTarget).toBeTruthy();
    expect(JSON.stringify(values)).not.toContain("run-private-id");
  });

  test("rejects contradictory evidence and non-digest replay keys", async () => {
    const handle = { insert: () => { throw new Error("must not insert"); } } as unknown as DirectDatabase;
    const invalidInputs = [
      { actualCostUsd: "0.014", evidenceState: "unknown" as const, idempotencyKey: DIGEST },
      { evidenceState: "unknown" as const, idempotencyKey: "raw-run-id" },
    ];
    let rejected = 0;
    for (const input of invalidInputs) {
      try {
        await insertProviderCostEventWith(handle, {
          provider: "browser_use",
          operation: "hosted_read",
          ...input,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Invalid provider cost evidence");
        rejected += 1;
      }
    }
    expect(rejected).toBe(2);
  });

  test("builds bounded provider aggregate queries without joining raw LLM events", () => {
    const queries = buildProviderCostsSummaryQueries(
      RANGE,
      drizzle.mock() as unknown as DirectDatabase,
    );
    const compiled = Object.values(queries).map((query) => query.toSQL());
    expect(compiled).toHaveLength(4);
    for (const generated of compiled) {
      expect(generated.sql).toContain('"provider_cost_events"');
      expect(generated.sql).not.toContain('"llm_usage_events"');
      expect(generated.params).toContain(RANGE.sinceIso);
      expect(generated.params).toContain(RANGE.untilIso);
    }
    expect(compiled[0]!.sql).toContain("FILTER (WHERE");
    expect(compiled[2]!.sql).toContain('left join "users"');
  });

  test("merges already-aggregated model and provider costs by user and day", async () => {
    __setLlmUsageDbForTests(mockQueryDb([
      [{ calls: 1, input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120, estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [],
      [],
      [{ user_id: "user-1", handle: "owner", name: "Owner", calls: 1, total_tokens: 120, estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [{ day: "2026-09-01", estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [{ operations: 2, unknown_operations: 1, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" }],
      [{ provider: "browser_use", operation: "hosted_read", operations: 2, unknown_operations: 1, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" }],
      [
        { user_id: "user-1", handle: "owner", name: "Owner", operations: 1, unknown_operations: 0, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" },
        { user_id: "user-2", handle: "member", name: "Member", operations: 1, unknown_operations: 1, estimated_cost: "0", actual_cost: "0", total_cost: "0" },
      ],
      [
        { day: "2026-09-01", estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" },
        { day: "2026-09-02", estimated_cost: "0", actual_cost: "0", total_cost: "0" },
      ],
    ]));

    const summary = await getCostsSummary(RANGE);
    expect(summary.totals).toMatchObject({
      calls: 1,
      providerOperations: 2,
      unknownProviderOperations: 1,
      totalCostUsd: 0.034,
    });
    expect(summary.byProvider[0]).toMatchObject({
      provider: "browser_use",
      operation: "hosted_read",
      operations: 2,
      unknownOperations: 1,
      totalCostUsd: 0.014,
    });
    expect(summary.byUser.find((row) => row.userId === "user-1")).toMatchObject({
      calls: 1,
      providerOperations: 1,
      totalCostUsd: 0.034,
    });
    expect(summary.byUser.find((row) => row.userId === "user-2")).toMatchObject({
      calls: 0,
      providerOperations: 1,
      unknownProviderOperations: 1,
      totalCostUsd: 0,
    });
    expect(summary.timeSeries).toEqual([
      { day: "2026-09-01", estimatedCostUsd: 0.02, actualCostUsd: 0.014, totalCostUsd: 0.034 },
      { day: "2026-09-02", estimatedCostUsd: 0, actualCostUsd: 0, totalCostUsd: 0 },
    ]);
  });
});
