import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  classifyModelAttemptReplaySafety,
  hasOnlyRefusedServiceAttempts,
  hasSettledServiceMemoryReview,
  resolveModelAttemptReplaySafety,
  type ModelAttemptReplayIdentity,
} from "../../src/queries/model-attempt-replay-safety";

const row = (attemptOutcome: "in_progress" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown" | null, failureCode: string | null = null) => ({
  id: `attempt-${attemptOutcome ?? "legacy"}`,
  attemptOutcome,
  failureCode,
  metadata: {},
});

function queryDb(rows: ReturnType<typeof row>[]) {
  let predicate: SQL | undefined;
  let limit: number | undefined;
  const builder = {
    from: () => builder,
    where: (value: SQL) => {
      predicate = value;
      return builder;
    },
    limit: async (value: number) => {
      limit = value;
      return rows;
    },
  };
  return {
    db: { select: () => builder } as unknown as DirectDatabase,
    query: () => ({
      ...new PgDialect().sqlToQuery(predicate!),
      limit,
    }),
  };
}

describe("model attempt replay safety", () => {
  test("allows work with no prior wire and verified pre-service refusals", () => {
    expect(classifyModelAttemptReplaySafety([]).decision).toBe("allow");
    for (const failureCode of ["provider_refused", "no_sellers_for_model", "pre_service_refusal"]) {
      expect(classifyModelAttemptReplaySafety([row("failed", failureCode)]).decision).toBe("allow");
    }
    expect(classifyModelAttemptReplaySafety([
      row("failed", "pre_service_refusal"),
      row("failed", "provider_refused"),
    ]).decision).toBe("allow");
  });

  test("blocks every uncertain or lost provider outcome", () => {
    for (const outcome of ["in_progress", "unknown", "cancelled", "interrupted", "succeeded"] as const) {
      expect(classifyModelAttemptReplaySafety([row(outcome)]).decision).toBe("block_unknown");
    }
    expect(classifyModelAttemptReplaySafety([row(null)]).decision).toBe("block_unknown");
    expect(classifyModelAttemptReplaySafety([row("failed", "provider_error")]).decision).toBe("block_unknown");
    expect(classifyModelAttemptReplaySafety([row("unknown", "no_sellers_for_model")]).decision).toBe("block_unknown");
    expect(classifyModelAttemptReplaySafety([row("succeeded", "pre_service_refusal")]).decision).toBe("block_unknown");
    expect(classifyModelAttemptReplaySafety([
      row("failed", "pre_service_refusal"), row("unknown"),
    ]).decision).toBe("block_unknown");
  });

  test("allows a succeeded wire only when the canonical job retained an unusable-result failure", () => {
    expect(classifyModelAttemptReplaySafety([row("succeeded")], { knownNonusableResult: true }).decision).toBe("allow");
    expect(classifyModelAttemptReplaySafety([
      row("succeeded"), row("unknown"),
    ], { knownNonusableResult: true }).decision).toBe("block_unknown");
  });

  test("queries the exact durable Memory correlation and blocks lost results", async () => {
    const identities: Exclude<ModelAttemptReplayIdentity, { kind: "reflection_operation" }>[] = [
      {
        kind: "memory_review",
        roomId: "11111111-1111-4111-8111-111111111111",
        workId: "memory-work-1",
      },
      ...(["room_stenographer", "room_event_compaction", "room_reflection", "image_assistance"] as const).map((callType) => ({
        kind: "operation" as const,
        roomId: "11111111-1111-4111-8111-111111111111",
        callType,
        operationId: `${callType}:operation-1`,
      })),
    ];

    for (const [index, identity] of identities.entries()) {
      const fake = queryDb([row(index === 0 ? "succeeded" : "unknown")]);
      expect(await resolveModelAttemptReplaySafety(identity, { db: fake.db })).toMatchObject({
        decision: "block_unknown",
      });
      const query = fake.query();
      expect(query.limit).toBe(1);
      expect(query.params).toContain(identity.roomId);
      expect(query.params).toContain(identity.kind === "memory_review" ? "memory_review" : identity.callType);
      if (identity.kind === "memory_review") {
        expect(query.sql).toContain("->>'workId'");
        expect(query.params).toContain(identity.workId);
        expect(query.sql).toContain("->>'attemptId'");
        expect(query.sql).toContain("not exists");
        expect(query.sql).toContain('"memory_review_receipts"."id"::text');
        expect(query.sql).toContain('"memory_review_receipts"."work_id"');
        expect(query.params).toContain("invalid_proposal");
        expect(query.params).toContain("iteration_exhausted");
      } else {
        expect(query.sql).toContain("->>'operationId'");
        expect(query.params).toContain(identity.operationId);
      }
    }

    const refusal = queryDb([row("failed", "provider_refused")]);
    expect(await resolveModelAttemptReplaySafety(identities[0]!, { db: refusal.db }))
      .toEqual({ decision: "allow" });
    const refusalQuery = refusal.query();
    expect(refusalQuery.params).toContain("provider_refused");
    expect(refusalQuery.params).toContain("no_sellers_for_model");
    expect(refusalQuery.params).toContain("pre_service_refusal");
  });

  test("a reclaimed Reflection family checks the same wire across accounting Rooms", async () => {
    const identity = {
      kind: "reflection_operation",
      operationId: "reflection:committed-family:primary",
    } as const;
    const fake = queryDb([row("succeeded")]);
    expect(await resolveModelAttemptReplaySafety(identity, { db: fake.db }))
      .toMatchObject({ decision: "block_unknown" });
    expect(fake.query().params.slice(0, 2)).toEqual(["room_reflection", identity.operationId]);
    expect(fake.query().sql).not.toContain('"room_id"');
  });

  test("operator recovery requires every exact wire attempt to be settled service-funded Surplus usage", async () => {
    const input = { roomId: "11111111-1111-4111-8111-111111111111", workId: "work", modelId: "fixture:model" };
    const settled = {
      fundingKind: "service", payerHumanId: null, providerRoute: "surplus", model: input.modelId, actualCost: "0.01",
      requestId: "provider-receipt", attemptId: "original-attempt", attemptOutcome: "succeeded",
      costState: "actual", recoveryState: null,
    };
    let predicate: SQL | undefined;
    const database = (rows: readonly unknown[]) => ({
      select: () => ({ from: () => ({ where: async (query: SQL) => { predicate = query; return rows; } }) }),
    }) as unknown as DirectDatabase;
    expect(await hasSettledServiceMemoryReview(input, database([]))).toBe(false);
    expect(await hasSettledServiceMemoryReview(input, database([settled]))).toBe(true);
    for (const changed of [
      { attemptOutcome: "in_progress" }, { costState: "pending" }, { recoveryState: "retryable" },
      { fundingKind: "personal" }, { payerHumanId: "owner" }, { requestId: null },
      { providerRoute: "other" }, { model: "fixture:other" }, { actualCost: null }, { attemptId: null },
    ]) {
      expect(await hasSettledServiceMemoryReview(input, database([settled, { ...settled, ...changed }]))).toBe(false);
    }
    const query = new PgDialect().sqlToQuery(predicate!);
    expect(query.params).toEqual([input.roomId, "memory_review", input.workId]);
    expect(query.sql).toContain("->>'workId'");
  });

  test("provider replacement requires only refused service-funded attempts for exact identities", async () => {
    const memoryIdentity: Extract<ModelAttemptReplayIdentity, { kind: "memory_review" }> = {
      kind: "memory_review",
      roomId: "11111111-1111-4111-8111-111111111111",
      workId: "memory-work-1",
    };
    const reflectionIdentity: Extract<ModelAttemptReplayIdentity, { kind: "operation" }> = {
      kind: "operation",
      roomId: "11111111-1111-4111-8111-111111111111",
      callType: "room_reflection",
      operationId: "reflection:operation-1",
    };
    const identities = [memoryIdentity, reflectionIdentity];
    let aggregate: SQL | undefined;
    let predicate: SQL | undefined;
    let queries = 0;
    const database = (proven: boolean | null) => ({
      select: (selection: { proven: SQL }) => {
        aggregate = selection.proven;
        return {
        from: () => ({
          where: async (query: SQL) => {
            queries += 1;
            predicate = query;
            return proven === null ? [] : [{ proven }];
          },
        }),
        };
      },
    }) as unknown as DirectDatabase;

    const current = { modelId: "openai:gpt-5.6-luna", attemptId: "current-attempt", occurredAtOrAfter: new Date("2026-11-27T10:00:00Z") };
    expect(await hasOnlyRefusedServiceAttempts([], database(true), current)).toBe(false);
    expect(queries).toBe(0);
    expect(await hasOnlyRefusedServiceAttempts(identities, database(true), current)).toBe(true);
    expect(await hasOnlyRefusedServiceAttempts(identities, database(false), current)).toBe(false);
    expect(await hasOnlyRefusedServiceAttempts(identities, database(null), current)).toBe(false);

    const dialect = new PgDialect();
    const predicateQuery = dialect.sqlToQuery(predicate!);
    expect(predicateQuery.params).toEqual([
      memoryIdentity.roomId,
      "memory_review",
      memoryIdentity.workId,
      reflectionIdentity.roomId,
      "room_reflection",
      reflectionIdentity.operationId,
    ]);
    expect(predicateQuery.sql).toContain("->>'workId'");
    expect(predicateQuery.sql).toContain("->>'operationId'");
    const aggregateQuery = dialect.sqlToQuery(aggregate!);
    expect(aggregateQuery.sql).toContain("bool_and");
    expect(aggregateQuery.sql).toContain("bool_or");
    expect(aggregateQuery.sql).toContain("funding_kind");
    expect(aggregateQuery.sql).toContain("payer_human_id");
    expect(aggregateQuery.params).toEqual([
      current.modelId,
      current.attemptId,
      current.occurredAtOrAfter.toISOString(),
      "provider_refused",
      "no_sellers_for_model",
      "pre_service_refusal",
    ]);
  });

  test("scopes image assistance by operation and never replays a succeeded wire without retained output", async () => {
    const identity: ModelAttemptReplayIdentity = {
      kind: "operation",
      roomId: "11111111-1111-4111-8111-111111111111",
      callType: "image_assistance",
      operationId: "image-assistance:turn-a:digest-a",
    };
    const succeeded = queryDb([row("succeeded")]);
    expect(await resolveModelAttemptReplaySafety(identity, {
      db: succeeded.db,
      knownNonusableResult: true,
    })).toEqual({
      decision: "block_unknown",
      blockingAttemptId: "attempt-succeeded",
    });
    const query = succeeded.query();
    expect(query.params).toContain(identity.roomId);
    expect(query.params).toContain("image_assistance");
    expect(query.sql).toContain("->>'operationId'");
    expect(query.params).toContain(identity.operationId);

    const refusal = queryDb([row("failed", "pre_service_refusal")]);
    expect(await resolveModelAttemptReplaySafety(identity, { db: refusal.db }))
      .toEqual({ decision: "allow" });
  });
});
