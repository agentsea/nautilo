import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { memoryReviewTurns, type SQL } from "@nautilo/db";
import {
  classifyPriorMemoryReviewAttempts,
  PostgresMemoryReviewRepository,
  selectMemoryReviewPrefix,
} from "../../src/memory-review/repository";
import type { MemoryReviewClaim } from "../../src/memory-review/worker";

const dialect = new PgDialect();
const NOW = new Date("2026-09-05T12:00:00Z");
const policy = { threshold: () => 2, leaseMs: 120_000, retryMs: 15_000, retentionMs: 86_400_000, retentionBatchSize: 10, assertAvailable: async () => {} };
const claim: MemoryReviewClaim = {
  workId: "logical-work", attemptId: "new-attempt", ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room",
  threadId: "thread", scopeId: null, turnIds: ["turn"], sourceIds: [1], leaseUntil: new Date(NOW.getTime() + 120_000),
};
function turn(id: string, state: "pending" | "awaiting" | "completed" | "interrupted" | "covered", hasHuman = 1) {
  return { id, state, hasHuman, sourceIds: [Number(id)] } as typeof memoryReviewTurns.$inferSelect;
}

describe("Memory durable coverage selection", () => {
  test("a paused lower fork prevents reviewing later completed turns", () => {
    const older = turn("1", "completed");
    const paused = turn("2", "awaiting");
    const newer = turn("3", "completed");
    expect(selectMemoryReviewPrefix([older, paused, newer], 2)).toEqual([]);
    expect(selectMemoryReviewPrefix([older, { ...paused, state: "completed" }, newer], 2)).toEqual([older, { ...paused, state: "completed" }]);
  });
  test("unfinished crashes neither count toward cadence nor fabricate complete turns", () => {
    const abandoned = turn("1", "interrupted");
    const complete = turn("2", "completed");
    expect(selectMemoryReviewPrefix([abandoned], 1)).toEqual([]);
    expect(selectMemoryReviewPrefix([abandoned, complete], 1)).toEqual([abandoned, complete]);
    expect(selectMemoryReviewPrefix([turn("1", "pending"), complete], 1)).toEqual([]);
  });
  test("covered history and assistant-only continuations do not inflate cadence", () => {
    const rows = [turn("1", "covered"), turn("2", "completed", 0), turn("3", "completed"), turn("4", "completed")];
    expect(selectMemoryReviewPrefix(rows, 2)).toEqual(rows.slice(1));
    expect(selectMemoryReviewPrefix(rows.slice(0, 3), 2)).toEqual([]);
  });

  test("attributes nonusable output only to the exact durably failed attempt", () => {
    const known = {
      ...turn("1", "completed"), attemptId: "attempt-known",
      failurePhase: "model", failureCode: "invalid_proposal",
    };
    const crashed = {
      ...turn("2", "completed"), attemptId: "attempt-crashed",
      failurePhase: null, failureCode: null,
    };
    expect(classifyPriorMemoryReviewAttempts([known, crashed])).toEqual({
      attemptIds: ["attempt-known", "attempt-crashed"],
      knownNonusableAttemptIds: ["attempt-known"],
    });
    expect(classifyPriorMemoryReviewAttempts([
      known,
      { ...known, id: "3", failureCode: null },
    ])).toEqual({
      attemptIds: ["attempt-known"],
      knownNonusableAttemptIds: [],
    });
  });
});

describe("Memory repository query contracts without a live database", () => {
  test("service model binding is frozen across retry and rejects disagreeing coalesced turns", async () => {
    const baseTurn = { ...turn("1", "completed"), attemptId: claim.attemptId, receiptId: null,
      leaseUntil: new Date("2099-01-01"), acceptedModelBinding: { kind: "service" as const, modelId: "first-model" } };
    const makeDb = (turns: typeof baseTurn[]) => ({
      transaction: async <T>(run: (tx: unknown) => Promise<T>) => run({
        select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ for: async () => turns }) }) }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      }),
    });
    const retryRepo = new PostgresMemoryReviewRepository(policy, makeDb([baseTurn]) as never);
    let resolutions = 0;
    expect(await retryRepo.bindServiceModel(claim, () => { resolutions += 1; return "new-default"; })).toBe("first-model");
    expect(resolutions).toBe(0);

    const mismatchRepo = new PostgresMemoryReviewRepository(policy, makeDb([
      baseTurn,
      { ...baseTurn, id: "2", sourceIds: [], acceptedModelBinding: { kind: "service", modelId: "other-model" } },
    ]) as never);
    const coalesced = { ...claim, turnIds: ["1", "2"] };
    await mismatchRepo.bindServiceModel(coalesced, () => { resolutions += 1; return "new-default"; }).then(
      () => { throw new Error("expected mismatched binding to fail"); },
      (error: unknown) => { expect(error).toMatchObject({ code: "source_changed" }); },
    );
    expect(resolutions).toBe(0);

    const malformedRepo = new PostgresMemoryReviewRepository(policy, makeDb([
      { ...baseTurn, acceptedModelBinding: { kind: "service", modelId: 42 } as never },
    ]) as never);
    await malformedRepo.bindServiceModel(claim, () => "new-default").then(
      () => { throw new Error("expected malformed binding to fail"); },
      (error: unknown) => { expect(error).toMatchObject({ code: "source_changed" }); },
    );
  });

  test("accepted Memory operation CAS is lazy on resume and upgrades legacy service without changing its model", async () => {
    const commitment = `hmac-sha256:${"a".repeat(43)}`;
    const accepted = { version: 1 as const, kind: "human" as const, role: "memoryReview" as const,
      modelId: "personal-model", inputCommitment: commitment, humanUserId: "human",
      preferenceRevision: 3, funding: { kind: "server" as const, providerRoute: "openai" } };
    const base = { ...turn("1", "completed"), attemptId: claim.attemptId, receiptId: null,
      leaseUntil: new Date("2099-01-01"), acceptedModelBinding: accepted };
    const makeDb = (turns: typeof base[]) => ({ transaction: async <T>(run: (tx: unknown) => Promise<T>) => run({
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ for: async () => turns }) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => turns.map(({ id }) => ({ id })) }) }) }),
    }) });
    let resolved = 0;
    const resumed = new PostgresMemoryReviewRepository(policy, makeDb([base]) as never);
    expect(await resumed.bindModelOperation(claim, async () => { resolved += 1; return accepted; })).toEqual(accepted);
    expect(resolved).toBe(0);

    let persisted: unknown;
    const legacyDb = { transaction: async <T>(run: (tx: unknown) => Promise<T>) => run({
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ for: async () => [
        { ...base, acceptedModelBinding: { kind: "service", modelId: "legacy-model" } },
      ] }) }) }) }),
      update: () => ({ set: (value: { acceptedModelBinding: unknown }) => {
        persisted = value.acceptedModelBinding;
        return { where: () => ({ returning: async () => [{ id: "1" }] }) };
      } }),
    }) };
    const legacy = new PostgresMemoryReviewRepository(policy, legacyDb as never);
    const proposed = { version: 1 as const, kind: "human" as const, role: "memoryReview" as const,
      modelId: "new-personal", inputCommitment: commitment, humanUserId: "human",
      preferenceRevision: 9, funding: { kind: "server" as const, providerRoute: "openai" } };
    const upgraded = await legacy.bindModelOperation(claim, async () => proposed);
    expect(upgraded).toMatchObject({ kind: "service", modelId: "legacy-model", inputCommitment: commitment });
    expect(persisted).toEqual(upgraded);
  });

  test("candidate discovery reads only work metadata and partitions predecessors by Agent and authority scope", async () => {
    const queries: SQL[] = [];
    const db = { execute: async (query: SQL) => { queries.push(query); return []; } };
    const repo = new PostgresMemoryReviewRepository(policy, db as never);
    expect(await repo.claimNext({ now: NOW })).toBeNull();
    const { sql, params } = dialect.sqlToQuery(queries[0]!);
    expect(sql).not.toContain("session_messages");
    expect(sql).not.toContain("content");
    expect(sql).toContain("p.agent_id=t.agent_id");
    expect(sql).toContain("p.owner_id=t.owner_id");
    expect(sql).toContain("p.access_scope=t.access_scope");
    expect(sql).toContain("t.failure_code IS NULL");
    expect(sql).toContain("t.failure_code='publication_uncertain' AND t.retry_at IS NULL");
    // Raw postgres-js query parameters cannot contain unencoded Date objects.
    expect(params.some((value: unknown) => value instanceof Date)).toBe(false);
  });

  test("receipt reconciliation keys logical work across attempts and requires published outcome", async () => {
    let predicate: SQL | undefined;
    const db = { select: () => ({ from: () => ({ where: async (query: SQL) => { predicate = query; return [{ id: "previous-attempt" }]; } }) }) };
    const repo = new PostgresMemoryReviewRepository(policy, db as never);
    expect(await repo.reconcile(claim)).toBe("published");
    const query = dialect.sqlToQuery(predicate!);
    expect(query.params).toContain("logical-work");
    expect(query.params).toContain("published");
    expect(query.params).not.toContain("new-attempt");
  });

  test("replay safety excuses only exact failed attempts and blocks an unaccounted sibling", async () => {
    const attemptRow = (
      id: string,
      attemptOutcome: "succeeded" | "failed" | "unknown",
      failureCode: string | null = null,
    ) => ({ id, attemptOutcome, failureCode, metadata: {} });
    const makeDb = (responses: unknown[][]) => {
      const predicates: SQL[] = [];
      return {
        predicates,
        handle: {
          select: () => {
            const builder = {
              from: () => builder,
              where: (predicate: SQL) => {
                predicates.push(predicate);
                return builder;
              },
              limit: async () => responses.shift() ?? [],
            };
            return builder;
          },
        },
      };
    };
    const replayClaim: MemoryReviewClaim = {
      ...claim,
      priorAttemptIds: ["attempt-known", "attempt-unaccounted"],
      knownNonusableAttemptIds: ["attempt-known"],
    };
    const safe = makeDb([
      [attemptRow("wire-refused", "failed", "provider_refused")],
      [attemptRow("wire-known", "succeeded")],
    ]);
    const safeRepository = new PostgresMemoryReviewRepository(policy, safe.handle as never);
    expect(await safeRepository.modelReplaySafety(replayClaim)).toBe("allow");
    expect(safe.predicates).toHaveLength(2);
    const unaccountedQuery = dialect.sqlToQuery(safe.predicates[0]!);
    const knownQuery = dialect.sqlToQuery(safe.predicates[1]!);
    expect(unaccountedQuery.params).toContain("attempt-unaccounted");
    expect(unaccountedQuery.params).not.toContain("attempt-known");
    expect(knownQuery.params).toContain("attempt-known");
    expect(knownQuery.params).not.toContain("attempt-unaccounted");

    const unknown = makeDb([[
      attemptRow("wire-unknown", "unknown"),
    ]]);
    const unknownRepository = new PostgresMemoryReviewRepository(policy, unknown.handle as never);
    expect(await unknownRepository.modelReplaySafety(replayClaim)).toBe("block_unknown");
    expect(unknown.predicates).toHaveLength(1);
  });

  test("failed attempts persist content-free diagnostics and fence newer or committed attempts", async () => {
    const receipts: Record<string, unknown>[] = [];
    let update: Record<string, unknown> | undefined;
    let predicate: SQL | undefined;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: "turn" }] }) }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ onConflictDoNothing: async () => { receipts.push(value); } }) }),
      update: () => ({ set: (value: Record<string, unknown>) => ({ where: async (query: SQL) => { update = value; predicate = query; } }) }),
    };
    const transactionalDb = { ...db, transaction: async <T>(run: (tx: typeof db) => Promise<T>) => run(db) };
    const repo = new PostgresMemoryReviewRepository(policy, transactionalDb as never);
    await repo.fail({ claim, phase: "model", reason: "provider_failed", retryable: true, now: NOW });
    expect(receipts[0]).toMatchObject({ id: "new-attempt", workId: "logical-work", outcome: "failed", phase: "model", code: "provider_failed", effects: [] });
    expect(update?.["retryAt"]).toEqual(new Date(NOW.getTime() + 15_000));
    const query = dialect.sqlToQuery(predicate!);
    expect(query.params).toContain("new-attempt");
    expect(query.sql.toLowerCase()).toContain('"receipt_id" is null');
    await repo.fail({ claim, phase: "publication", reason: "publication_uncertain", retryable: false, now: NOW });
    expect(update?.["retryAt"]).toEqual(new Date(NOW.getTime() + policy.retryMs));
    await repo.fail({ claim, phase: "model", reason: "model_unavailable", retryable: false, now: NOW });
    expect(update?.["retryAt"]).toBeNull();
  });
});

describe("Memory source admission query contracts", () => {
  test("source append reserves exact persisted IDs without copying message bodies", async () => {
    const { admitMemoryReviewSourceInTx } = await import("@nautilo/db");
    const values: Record<string, unknown>[] = [];
    const tx = {
      execute: async () => [{ id: "session" }],
      select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: "scope" }] }) }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ onConflictDoUpdate: async () => { values.push(value); } }) }),
    };
    const input = {
      ownerId: "owner", actorId: "actor", accessScope: "scope", checkpointThreadId: "parent:fork:1",
      sessionId: "session", threadId: "parent", agentId: "agent", roomId: "room", turnId: "human-turn",
    };
    await admitMemoryReviewSourceInTx(tx as never, { ...input, messageId: 11, role: "user" });
    await admitMemoryReviewSourceInTx(tx as never, { ...input, messageId: 12, role: "assistant" });
    expect(values[0]).toMatchObject({ ...input, sourceIds: [11], firstMessageId: 11 });
    expect(values[1]).toMatchObject({ sourceIds: [12] });
    expect(dialect.sqlToQuery(values[0]!["hasHuman"] as SQL).params).toContain('[{"id":11,"key":"human-turn"}]');
    expect(dialect.sqlToQuery(values[1]!["hasHuman"] as SQL).params).toContain("[]");
    expect(values.every((value) => !("content" in value) && !("messages" in value))).toBe(true);
  });

  test("turn completion fences Agent, transcript and exact Human turn and never rewrites covered work", async () => {
    const { markMemoryReviewTurnInTx } = await import("@nautilo/db");
    let values: Record<string, unknown> | undefined;
    let predicate: SQL | undefined;
    const tx = { update: () => ({ set: (value: Record<string, unknown>) => ({ where: async (query: SQL) => { values = value; predicate = query; } }) }) };
    await markMemoryReviewTurnInTx(tx as never, { threadId: "parent", agentId: "agent", turnId: "human-turn", state: "awaiting" });
    expect(values).toMatchObject({ state: "awaiting", completedAt: null });
    const query = dialect.sqlToQuery(predicate!);
    expect(query.params).toContain("parent");
    expect(query.params).toContain("agent");
    expect(query.params).toContain("human-turn");
    expect(query.sql.toLowerCase()).toContain('"receipt_id" is null');
    await markMemoryReviewTurnInTx(tx as never, { threadId: "parent", agentId: "agent", turnId: "human-turn", state: "pending" });
    expect(values).toMatchObject({ state: "pending", completedAt: null });
    await markMemoryReviewTurnInTx(tx as never, { threadId: "parent", agentId: "agent", turnId: "human-turn", state: "interrupted" });
    expect(values).toMatchObject({ state: "interrupted" });
    expect(dialect.sqlToQuery(values!["completedAt"] as SQL).sql).toContain("coalesce");
  });
});


test("retention preserves first/latest coverage and every unacknowledged effect", async () => {
  const queries: SQL[] = [];
  const db = {
    execute: async (query: SQL) => { queries.push(query); return []; },
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  };
  const repo = new PostgresMemoryReviewRepository(policy, db as never);
  await repo.drainEffects({ now: NOW });
  expect(queries).toHaveLength(2);
  const retirement = queries.map((query) => dialect.sqlToQuery(query));
  expect(retirement[0]!.sql).toContain("c.first_rank>1 AND c.last_rank>1");
  for (const query of retirement) {
    expect(query.sql).toContain("r.delivered=jsonb_array_length(r.effects)");
    expect(query.params.some((value: unknown) => value instanceof Date)).toBe(false);
    expect(query.params).toContain(policy.retentionBatchSize);
  }
  expect(retirement[1]!.sql).toContain("t.receipt_id=r.id");
  expect(retirement[1]!.sql).toContain("t.generation_id=r.work_id");
  expect(retirement[1]!.sql).toContain("t.failure_code='publication_uncertain'");
});
