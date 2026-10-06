import { afterEach, describe, expect, test } from "bun:test";
import type { DirectDatabase } from "../../src/config/direct-database";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  __setLlmUsageDbForTests,
  attachSurplusRequestReceipt,
  beginPersonalLlmAttempt,
  beginSurplusLlmAttempt,
  listPendingSurplusAttempts,
  reconcileSurplusLlmAttemptCost,
  requeueBlockedPersonalSurplusAttempts,
  settlePersonalLlmAttempt,
  settleSurplusLlmAttempt,
  type SurplusPendingAttempt,
} from "../../src/queries/llm-usage";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function mutationDb(options: { returning?: unknown[]; selected?: unknown[] } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const updatePredicates: SQL[] = [];
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
        where: (predicate: SQL) => {
          updatePredicates.push(predicate);
          return {
          returning: async () => options.returning ?? [{ id: ATTEMPT_ID }],
          };
        },
      };
    },
  };
  let selectPredicate: SQL | undefined;
  const selectBuilder: Record<string, unknown> = {
    getSQL: () => sql`select 1${selectPredicate ? sql` where ${selectPredicate}` : sql``}`,
  };
  selectBuilder["from"] = () => selectBuilder;
  selectBuilder["where"] = (predicate: SQL) => {
    selectPredicate = predicate;
    return selectBuilder;
  };
  selectBuilder["limit"] = async () => options.selected ?? [];
  return {
    handle: {
      insert: () => insertBuilder,
      update: () => updateBuilder,
      select: () => selectBuilder,
    } as unknown as DirectDatabase,
    inserted,
    updated,
    updatePredicates,
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

  test("prewires and settles a direct personal attempt on the same row", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);
    await beginPersonalLlmAttempt({
      id: ATTEMPT_ID,
      userId: "22222222-2222-4222-8222-222222222222",
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      providerRoute: "anthropic",
      credentialId: "55555555-5555-4555-8555-555555555555",
      credentialRevision: 2,
      endpoint: "/v1/messages",
    });
    expect(fake.inserted[0]).toMatchObject({
      fundingKind: "personal",
      payerHumanId: "22222222-2222-4222-8222-222222222222",
      credentialRevision: 2,
      attemptOutcome: "in_progress",
      costState: "pending",
    });

    await settlePersonalLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "succeeded",
      costState: "estimated",
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0012,
      pricingVersion: "test-pricing-v1",
    });
    expect(fake.updated[0]).toMatchObject({
      attemptOutcome: "succeeded",
      costState: "estimated",
      estimatedCostUsd: "0.00120000",
      pricingVersion: "test-pricing-v1",
      totalTokens: 120,
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

  test("late direct usage replaces unknown cost without rewriting terminal outcome", async () => {
    const fake = mutationDb();
    __setLlmUsageDbForTests(fake.handle);
    await settlePersonalLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "interrupted",
      costState: "estimated",
      estimatedCostUsd: 0.0009,
      pricingVersion: "test-pricing-v1",
      inputTokens: 80,
      outputTokens: 10,
      preserveOutcome: true,
    });
    expect(fake.updated[0]).toMatchObject({
      costState: "estimated",
      estimatedCostUsd: "0.00090000",
      totalTokens: 90,
    });
    expect(fake.updated[0]).not.toHaveProperty("attemptOutcome");
    expect(fake.updated[0]).not.toHaveProperty("failureCode");
    expect(fake.updated[0]).not.toHaveProperty("settledAt");
  });

  test("accepts an exact ordinary direct settlement replay after a lost commit acknowledgement", async () => {
    const settledAt = new Date("2026-10-06T10:00:00.000Z");
    const committed = {
      attemptOutcome: "succeeded",
      costState: "estimated",
      providerRequestId: "request-1",
      metadata: { receipt: { source: "callback" }, retained: true },
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 3,
      cachedInputTokens: 4,
      totalTokens: 120,
      estimatedCostUsd: "0.00120000",
      actualCostUsd: null,
      pricingVersion: "test-pricing-v1",
      servingProvider: "anthropic",
      failureCode: null,
      settledAt,
    };
    const fake = mutationDb({ returning: [], selected: [committed] });
    __setLlmUsageDbForTests(fake.handle);
    await settlePersonalLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "succeeded",
      costState: "estimated",
      providerRequestId: "request-1",
      metadata: { receipt: { source: "callback" } },
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 3,
      cachedInputTokens: 4,
      estimatedCostUsd: 0.0012,
      pricingVersion: "test-pricing-v1",
      servingProvider: "anthropic",
      settledAt,
    });
    expect(settlePersonalLlmAttempt({
      attemptId: ATTEMPT_ID,
      outcome: "failed",
      costState: "estimated",
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0012,
      pricingVersion: "test-pricing-v1",
    })).rejects.toThrow("conflicts with durable state");
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
      updatedAtToken: "2026-10-01T00:01:00.000000Z",
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
      recoveryState: "retryable",
      fundingKind: "service",
      payerHumanId: null,
      credentialId: null,
      credentialRevision: null,
      failureCode: "receipt_not_confirmed",
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

  test("requeues a payer's old blocked receipts only behind a current-key guard", async () => {
    const fake = mutationDb({ returning: [{ id: ATTEMPT_ID }] });
    __setLlmUsageDbForTests(fake.handle);
    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId: "22222222-2222-4222-8222-222222222222",
      credentialId: "55555555-5555-4555-8555-555555555555",
      credentialRevision: 2,
    })).toBe(1);
    expect(fake.updated[0]).toMatchObject({
      recoveryState: "retryable",
      failureCode: null,
    });
    const predicate = new PgDialect().sqlToQuery(fake.updatePredicates[0]!);
    expect(predicate.sql).toContain("exists (select 1 where");
    expect(predicate.sql).toContain('"personal_provider_credentials"."id"');
    expect(predicate.sql).not.toContain('"llm_usage_events"."credential_id"');
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
    const recovery = dialect.sqlToQuery(fake.updated[0]?.["recoveryState"] as SQL);
    expect(cost.sql).toContain('else "llm_usage_events"."actual_cost_usd" end');
    expect(state.sql).toContain('else "llm_usage_events"."cost_state" end');
    expect(cost.params).toContain("pending");
    expect(cost.params).toContain("unknown");
    expect(cost.params).not.toContain("actual");
    expect(recovery.sql).toContain("then coalesce");
    expect(recovery.sql).toContain("else null");
  });
});
