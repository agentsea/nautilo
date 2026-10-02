import { afterEach, describe, expect, test } from "bun:test";
import type { DirectDatabase } from "../../src/config/direct-database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  __setLlmUsageDbForTests,
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  listPendingSurplusAttempts,
  reconcileSurplusLlmAttemptCost,
  settleSurplusLlmAttempt,
  type SurplusPendingAttempt,
} from "../../src/queries/llm-usage";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function mutationDb(options: { returning?: unknown[] } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const insertBuilder = {
    values(value: Record<string, unknown>) {
      inserted.push(value);
      return { onConflictDoNothing: async () => {} };
    },
  };
  const updateBuilder = {
    set(value: Record<string, unknown>) {
      updated.push(value);
      return {
        where: () => ({
          returning: async () => options.returning ?? [{ id: ATTEMPT_ID }],
        }),
      };
    },
  };
  return {
    handle: {
      insert: () => insertBuilder,
      update: () => updateBuilder,
    } as unknown as DirectDatabase,
    inserted,
    updated,
  };
}

describe("Surplus durable LLM attempts", () => {
  afterEach(() => {
    __setLlmUsageDbForTests(null);
  });

  test("begins a content-free pending row before provider execution", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);

    await beginSurplusLlmAttempt({
      id: ATTEMPT_ID,
      userId: "22222222-2222-4222-8222-222222222222",
      roomId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444",
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      endpoint: "/v1/chat/completions",
      fundingKind: "server",
    });

    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0]).toMatchObject({
      id: ATTEMPT_ID,
      provider: "venice",
      model: "venice:openai-gpt-55",
      providerRoute: "surplus",
      attemptOutcome: "in_progress",
      costState: "pending",
      actualCostUsd: null,
      estimatedCostUsd: "0.00000000",
    });
  });

  test("attaches the provider request id to the existing attempt", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);
    await attachSurplusRequestReceipt({
      attemptId: ATTEMPT_ID,
      providerRequestId: "req_surplus_1",
      servingProvider: "venice",
    });
    expect(fake.updated[0]).toMatchObject({
      providerRequestId: "req_surplus_1",
      servingProvider: "venice",
    });
  });

  test("settles an explicit zero as actual rather than unknown", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);
    await settleSurplusLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "succeeded",
      costState: "actual",
      inputTokens: 10,
      outputTokens: 5,
      actualCostUsd: 0,
    });
    expect(fake.updated[0]).toMatchObject({
      attemptOutcome: "succeeded",
      costState: "actual",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      actualCostUsd: "0.00000000",
    });
  });

  test("rejects absent actual evidence and conflicting receipt updates", async () => {
    const fake = mutationDb({ returning: [] });
    __setLlmUsageDbForTests(fake.handle);
    expect(settleSurplusLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "succeeded",
      costState: "actual",
    })).rejects.toThrow("requires actualCostUsd");
    expect(attachSurplusRequestReceipt({
      attemptId: ATTEMPT_ID,
      providerRequestId: "different",
    })).rejects.toThrow("conflicts with durable state");
  });

  test("returns content-free pending rows for restart reconciliation", async () => {
    const pending = {
      id: ATTEMPT_ID,
      occurredAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:01:00Z"),
      userId: null,
      roomId: null,
      taskId: null,
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      providerRequestId: null,
      endpoint: "/v1/chat/completions",
      servingProvider: null,
      attemptOutcome: "unknown",
      costState: "unknown",
      fundingKind: "service",
    } satisfies SurplusPendingAttempt;
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit"] as const) {
      builder[method] = method === "limit" ? async () => [pending] : () => builder;
    }
    __setLlmUsageDbForTests({ select: () => builder } as unknown as DirectDatabase);
    expect(await listPendingSurplusAttempts({ limit: 1 })).toEqual([pending]);
  });

  test("late cost recovery preserves terminal outcomes and ignores concurrent state changes", async () => {
    const fake = mutationDb({ returning: [] });
    __setLlmUsageDbForTests(fake.handle);
    expect(await reconcileSurplusLlmAttemptCost({
      attemptId: ATTEMPT_ID, providerRequestId: "request-1",
      expectedUpdatedAt: new Date(0), actualCostUsd: 0.000283,
    })).toBe(false);
    expect(fake.updated[0]).toMatchObject({ costState: "actual", actualCostUsd: "0.00028300" });
    // Outcome is computed from the stored row rather than a stale caller's
    // succeeded/cancelled classification.
    expect(fake.updated[0]?.["attemptOutcome"]).not.toBe("succeeded");
    expect(fake.updated[0]?.["attemptOutcome"]).not.toBe("cancelled");
  });

  test("terminal completion preserves recovered actual cost while retrying its observed request receipt", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);
    await settleSurplusLlmAttempt({
      attemptId: ATTEMPT_ID, providerRequestId: "request-1", outcome: "succeeded",
      costState: "pending", inputTokens: 11, outputTokens: 17,
    });
    expect(fake.updated[0]).toMatchObject({
      attemptOutcome: "succeeded", providerRequestId: "request-1", inputTokens: 11, outputTokens: 17,
    });
    const dialect = new PgDialect();
    const cost = dialect.sqlToQuery(fake.updated[0]?.["actualCostUsd"] as SQL);
    const state = dialect.sqlToQuery(fake.updated[0]?.["costState"] as SQL);
    expect(cost.sql).toContain('else "llm_usage_events"."actual_cost_usd" end');
    expect(state.sql).toContain('else "llm_usage_events"."cost_state" end');
    expect(cost.params).toContain("pending");
    expect(cost.params).toContain("unknown");
    expect(cost.params).not.toContain("actual");
  });
});
