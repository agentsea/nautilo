import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  classifyModelAttemptReplaySafety,
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
    const identities: ModelAttemptReplayIdentity[] = [
      {
        kind: "memory_review",
        roomId: "11111111-1111-4111-8111-111111111111",
        workId: "memory-work-1",
        attemptIds: ["memory-attempt-1"],
      },
      ...(["room_stenographer", "room_event_compaction", "room_reflection"] as const).map((callType) => ({
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
        expect(query.params).toContain(identity.attemptIds[0]);
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
});
