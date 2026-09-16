import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { admitMemoryReviewSourceInTx } from "../../src/queries/memory-review";
const dialect = new PgDialect();
const input = { ownerId: "owner", actorId: "actor", accessScope: "namespace", checkpointThreadId: "checkpoint", sessionId: "session", threadId: "thread", agentId: "agent", roomId: "room", turnId: "execution-turn" };
function fake(referenced: { id: number; humanTurnId: string; role?: string; roomId?: string }[], authorized = true) {
  const inserts: Record<string, unknown>[] = [];
  const conflicts: { setWhere: SQL; set: Record<string, unknown> }[] = [];
  const checks: SQL[] = [];
  const tx = {
    execute: async (query: SQL) => { checks.push(query); return authorized ? [{ id: "session" }] : []; },
    select: () => ({ from: () => ({ innerJoin: () => ({ where: (query: SQL) => { checks.push(query); return { for: async () => referenced.map((row) => ({ role: "user", roomId: "room", fingerprint: null, ...row })) }; } }) }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => { inserts.push(values); return { onConflictDoUpdate: async (conflict: { setWhere: SQL; set: Record<string, unknown> }) => { conflicts.push(conflict); } }; } }),
  };
  return { tx: tx as unknown as Parameters<typeof admitMemoryReviewSourceInTx>[0], inserts, conflicts, checks };
}
describe("canonical Memory source admission", () => {
  test("links shared-session coalesced Humans with the reply and counts distinct Human turns", async () => {
    const state = fake([{ id: 1, humanTurnId: "human-one" }, { id: 2, humanTurnId: "human-two" }]);
    await admitMemoryReviewSourceInTx(state.tx, { ...input, existingSourceMessageIds: [1, 2, 1], messageId: 3, role: "assistant" });
    expect(state.inserts[0]).toMatchObject({ sourceIds: [1, 2, 3], firstMessageId: 1 });
    for (const coordinate of ["session", "thread", "room", "agent", "actor", "owner"]) expect(dialect.sqlToQuery(state.checks[1]!).params).toContain(coordinate);
    expect(dialect.sqlToQuery(state.checks[2]!).sql).toContain('"sessions"."room_id"');
    expect(JSON.stringify(state.inserts)).not.toContain("content");
  });
  test("zero-output execution still reserves committed Human references without a new message", async () => {
    const state = fake([{ id: 1, humanTurnId: "same-human" }, { id: 2, humanTurnId: "same-human" }]);
    await admitMemoryReviewSourceInTx(state.tx, { ...input, existingSourceMessageIds: [1, 2] });
    expect(state.inserts[0]).toMatchObject({ sourceIds: [1, 2] });
  });
  test("rejects missing or cross-Room source references and revoked execution authority", async () => {
    for (const state of [fake([]), fake([{ id: 1, humanTurnId: "human" }], false)]) {
      const error = await admitMemoryReviewSourceInTx(state.tx, { ...input, existingSourceMessageIds: [1, 2] }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(state.inserts).toEqual([]);
    }
  });
  test("overlapping execution turns count only new Humans and retain original cadence ownership", async () => {
    const state = fake([{ id: 1, humanTurnId: "old" }, { id: 2, humanTurnId: "new" }]);
    await admitMemoryReviewSourceInTx(state.tx, { ...input, existingSourceMessageIds: [1, 2] });
    expect(dialect.sqlToQuery(state.checks[0]!).sql).toContain("FOR UPDATE");
    const count = dialect.sqlToQuery(state.inserts[0]!["hasHuman"] as SQL);
    expect(count.sql).toContain("count(DISTINCT candidate.key)");
    expect(count.sql).toContain("prior.receipt_id IS NOT NULL");
    expect(count.sql).toContain("candidate.id > coalesce");
    expect(count.sql).toContain("AND NOT EXISTS");
    expect(count.sql).toContain("= candidate.key");
    for (const coordinate of ["room", "agent", "owner", "namespace"]) expect(count.params).toContain(coordinate);
    const updated = dialect.sqlToQuery(state.conflicts[0]!.set["hasHuman"] as SQL);
    expect(updated.sql).toContain('ELSE "memory_review_turns"."has_human" + excluded.has_human');
    expect(updated.sql).toContain('IS NOT NULL THEN excluded.has_human');
  });
  test("duplicate references cannot reopen generations or clear active claims", async () => {
    const state = fake([{ id: 1, humanTurnId: "human" }]);
    await admitMemoryReviewSourceInTx(state.tx, { ...input, existingSourceMessageIds: [1] });
    const guard = dialect.sqlToQuery(state.conflicts[0]!.setWhere);
    expect(guard.sql).toContain('NOT ("memory_review_turns"."source_ids" @>');
    expect(guard.params).toContain("[1]");
    const generation = dialect.sqlToQuery(state.conflicts[0]!.set["generationId"] as SQL);
    expect(generation.sql).toContain("gen_random_uuid()");
    expect(generation.sql).toContain('"receipt_id" IS NOT NULL');
  });
});
