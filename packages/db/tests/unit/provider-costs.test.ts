import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DirectDatabase } from "../../src/config/direct-database";
import { __setLlmUsageDbForTests, getCostsSummary } from "../../src/queries/llm-usage";
import {
  buildProviderCostsSummaryQueries,
  buildPersonalProviderCostsByTaskQuery,
  buildProviderCostRecoveryAttemptsQuery,
  estimateProviderToolCostUsd,
  insertProviderCostEventWith,
  providerCostIdempotencyKey,
  providerCostRequestReference,
  PROVIDER_TOOL_PRICING_VERSION,
  settleProviderCostEventWith,
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
    expect(estimateProviderToolCostUsd("tavily:credit", 0.5)).toBe("0.00400000");
    expect(estimateProviderToolCostUsd("tavily:credit", 1.25)).toBe("0.01000000");
    expect(estimateProviderToolCostUsd("tavily:credit", 0)).toBe("0.00000000");
    expect(providerCostIdempotencyKey("raw-provider-receipt")).toMatch(/^[0-9a-f]{64}$/);
    expect(providerCostRequestReference("raw-provider-receipt")).toMatch(/^req_[0-9a-f]{12}$/);
    expect(providerCostRequestReference(null)).toBeNull();
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
      taskId: "00000000-0000-4000-8000-000000000004",
      runId: "00000000-0000-4000-8000-000000000005",
      jobId: "00000000-0000-4000-8000-000000000006",
      workload: "deep_research",
      attemptOutcome: "succeeded",
      pricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      measuredUnits: 0.5,
      unitType: "credit",
      requestReference: providerCostRequestReference("raw-provider-receipt"),
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
      taskId: "00000000-0000-4000-8000-000000000004",
      runId: "00000000-0000-4000-8000-000000000005",
      jobId: "00000000-0000-4000-8000-000000000006",
      workload: "deep_research",
      attemptOutcome: "succeeded",
      pricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      measuredUnits: "0.50000000",
      unitType: "credit",
      requestReference: providerCostRequestReference("raw-provider-receipt"),
      idempotencyKey: DIGEST,
    });
    expect(conflictTarget).toBeTruthy();
    expect(JSON.stringify(values)).not.toContain("raw-provider-receipt");
  });

  test("keeps a provider-reported zero-unit estimate as known zero evidence", async () => {
    let values: Record<string, unknown> | undefined;
    const builder = {
      values(input: Record<string, unknown>) {
        values = input;
        return this;
      },
      async onConflictDoNothing() {},
    };
    const handle = { insert: () => builder } as unknown as DirectDatabase;
    await insertProviderCostEventWith(handle, {
      provider: "tavily",
      operation: "search",
      estimatedCostUsd: estimateProviderToolCostUsd("tavily:credit", 0),
      evidenceState: "estimated",
      measuredUnits: 0,
      unitType: "credit",
      requestReference: "req_0123456789ab",
      idempotencyKey: DIGEST,
    });
    expect(values).toMatchObject({
      evidenceState: "estimated",
      estimatedCostUsd: "0.00000000",
      measuredUnits: "0.00000000",
      unitType: "credit",
    });
  });

  test("settlement uses the injected handle and fences immutable attribution", async () => {
    let updateValues: Record<string, unknown> | undefined;
    let whereClause: unknown;
    let returningCount = 0;
    const builder = {
      set(input: Record<string, unknown>) {
        updateValues = input;
        return this;
      },
      where(input: unknown) {
        whereClause = input;
        return this;
      },
      async returning() {
        returningCount += 1;
        return [{ id: "00000000-0000-4000-8000-000000000009" }];
      },
    };
    const handle = { update: () => builder } as unknown as DirectDatabase;
    const input = {
      userId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000004",
      runId: "00000000-0000-4000-8000-000000000005",
      jobId: "00000000-0000-4000-8000-000000000006",
      provider: "tavily",
      operation: "search",
      workload: "deep_research",
      fundingKind: "personal" as const,
      payerHumanId: "00000000-0000-4000-8000-000000000001",
      providerRoute: "tavily",
      credentialId: "00000000-0000-4000-8000-000000000007",
      credentialRevision: 2,
      attemptOutcome: "failed" as const,
      failureCode: "provider_request_failed",
      estimatedCostUsd: "0.008",
      actualCostUsd: "0",
      evidenceState: "actual" as const,
      pricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      measuredUnits: 1,
      unitType: "credit",
      idempotencyKey: DIGEST,
    };

    await settleProviderCostEventWith(handle, input);
    await settleProviderCostEventWith(handle, input);

    expect(returningCount).toBe(2);
    expect(whereClause).toBeTruthy();
    expect(updateValues).toMatchObject({
      actualCostUsd: "0.00000000",
      evidenceState: "actual",
    });
    expect(updateValues?.["requestReference"]).toBeTruthy();
  });

  test("provider Task and recovery queries are payer-filtered and content-free", () => {
    const payer = "22222222-2222-4222-8222-222222222222";
    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const byTask = buildPersonalProviderCostsByTaskQuery(RANGE, offlineDb, payer).toSQL();
    const recovery = buildProviderCostRecoveryAttemptsQuery(RANGE, offlineDb, 100, payer).toSQL();

    for (const generated of [byTask, recovery]) {
      expect(generated.sql).toContain('"provider_cost_events"."payer_human_id" =');
      expect(generated.sql).toContain('"provider_cost_events"."funding_kind" =');
      expect(generated.params).toContain(payer);
      expect(generated.params).toContain("personal");
      expect(generated.sql).not.toContain('join "tasks"');
    }
    expect(byTask.sql).toContain('group by "provider_cost_events"."task_id"');
    expect(recovery.sql).toContain('"provider_cost_events"."evidence_state" =');
    expect(recovery.sql).toContain('"request_reference"');
    expect(recovery.sql).toContain("limit");
    expect(recovery.params).toContain(100);
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

  test("rejects failure details that are not content-free codes", async () => {
    const handle = { insert: () => { throw new Error("must not insert"); } } as unknown as DirectDatabase;
    try {
      await insertProviderCostEventWith(handle, {
        provider: "tavily",
        operation: "search",
        evidenceState: "unknown",
        attemptOutcome: "failed",
        failureCode: "upstream said: private prompt",
        idempotencyKey: DIGEST,
      });
      throw new Error("Expected content-bearing failure detail to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid provider failure code");
    }
  });

  test("rejects raw provider receipt IDs at the database write boundary", async () => {
    const handle = { insert: () => { throw new Error("must not insert"); } } as unknown as DirectDatabase;
    const rejected = await insertProviderCostEventWith(handle, {
      provider: "tavily",
      operation: "search",
      evidenceState: "unknown",
      requestReference: "raw-provider-request-id",
      idempotencyKey: DIGEST,
    }).then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("Invalid provider request reference");
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

  test("personal provider aggregates bind payer identity before grouping", () => {
    const payer = "22222222-2222-4222-8222-222222222222";
    const queries = buildProviderCostsSummaryQueries(
      RANGE,
      drizzle.mock() as unknown as DirectDatabase,
      payer,
    );
    for (const query of Object.values(queries)) {
      const generated = query.toSQL();
      expect(generated.sql).toContain('"provider_cost_events"."payer_human_id" =');
      expect(generated.sql).toContain('"provider_cost_events"."funding_kind" =');
      expect(generated.params).toContain(payer);
      expect(generated.params).toContain("personal");
    }
  });

  test("personal provider estimates include only currently estimated evidence", () => {
    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const payer = "22222222-2222-4222-8222-222222222222";
    const personal = Object.values(buildProviderCostsSummaryQueries(
      RANGE,
      offlineDb,
      payer,
    )).map((query) => query.toSQL().sql.replace(/\s+/g, " ").toLowerCase());

    for (const sqlText of personal) {
      expect(sqlText).toContain(
        `when "provider_cost_events"."evidence_state" = 'estimated' then "provider_cost_events"."estimated_cost_usd" else 0 end`,
      );
    }

    const administratorTotals = buildProviderCostsSummaryQueries(RANGE, offlineDb).totals
      .toSQL().sql.replace(/\s+/g, " ").toLowerCase();
    expect(administratorTotals).toContain(
      `when "provider_cost_events"."evidence_state" = 'estimated' then "provider_cost_events"."estimated_cost_usd" else 0 end`,
    );
  });

  test("merges already-aggregated model and provider costs by user and day", async () => {
    __setLlmUsageDbForTests(mockQueryDb([
      [{ calls: 1, input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120, estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [],
      [],
      [{ user_id: "user-1", handle: "owner", name: "Owner", calls: 1, total_tokens: 120, estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [{ day: "2026-09-01", estimated_cost: "0.02000000", actual_cost: "0", total_cost: "0.02000000" }],
      [{ operations: 2, unknown_operations: 1, succeeded_operations: 0, failed_operations: 0, cancelled_operations: 0, interrupted_operations: 0, unknown_outcome_operations: 0, legacy_operations: 2, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" }],
      [{ provider: "browser_use", operation: "hosted_read", operations: 2, unknown_operations: 1, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" }],
      [
        { user_id: "user-1", handle: "owner", name: "Owner", operations: 1, unknown_operations: 0, estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" },
        { user_id: "user-2", handle: "member", name: "Member", operations: 1, unknown_operations: 1, estimated_cost: "0", actual_cost: "0", total_cost: "0" },
      ],
      [
        { day: "2026-09-01", estimated_cost: "0", actual_cost: "0.01400000", total_cost: "0.01400000" },
        { day: "2026-09-02", estimated_cost: "0", actual_cost: "0", total_cost: "0" },
      ],
      [],
      [{ provider: "tavily", operation: "search", workload: "deep_research",
        attemptOutcome: "unknown", failureCode: "provider_transport_unknown",
        requestReference: "req_0123456789ab", taskId: null, runId: null, jobId: null,
        occurredAt: new Date("2026-09-02T00:00:00.000Z") }],
    ]));

    const summary = await getCostsSummary(RANGE);
    expect(summary.totals).toMatchObject({
      calls: 1,
      providerOperations: 2,
      unknownProviderOperations: 1,
      totalCostUsd: 0.034,
    });
    expect(summary.serviceOperations).toEqual({
      operations: 2,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
      legacy: 2,
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
    expect(summary.serviceRecovery.attempts).toEqual([{
      provider: "tavily",
      operation: "search",
      workload: "deep_research",
      attemptOutcome: "unknown",
      failureCode: "provider_transport_unknown",
      requestReference: "req_0123456789ab",
      taskId: null,
      runId: null,
      jobId: null,
      occurredAt: "2026-09-02T00:00:00.000Z",
    }]);
  });
});
