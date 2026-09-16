import { describe, expect, test } from "bun:test";
import { memoryReviewAdmission, memoryReviewCompletionState, memoryReviewSourceIds } from "../../src/memory-review/admission";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase, SQL } from "@nautilo/db";
import { recoveredMemoryReviewTurnState, recoverMemoryReviewTurnsAtStartup } from "../../src/memory-review/startup-recovery";

const source = { threadId: "parent", transcriptOwnerId: "owner", turnId: "turn", input: {} };
const identity = { ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", toolPolicy: {} };
describe("Memory committed-turn boundaries", () => {
  test("preserves configured Agent, owner and independent fork checkpoint identity", async () => {
    const admitted = await memoryReviewAdmission({ ...identity, readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"] }, "parent:fork:sequence", source);
    expect(admitted).toEqual({ memoryReview: { ownerId: "owner", actorId: "actor", checkpointThreadId: "parent:fork:sequence", accessScope: "namespace" } });
  });
  test("scope review keeps its exact scope instead of falling back to Namespaces", async () => {
    expect((await memoryReviewAdmission({ ...identity, memoryMode: "scope", scopeId: "scope" }, "thread", source)).memoryReview?.accessScope).toBe("scope");
    expect(await memoryReviewAdmission(undefined, "thread", source)).toEqual({});
    expect(await memoryReviewAdmission({ ...identity, roomId: "", memoryMode: "scope", scopeId: "scope" }, "thread", source)).toEqual({});
  });
  test("unrecognized interruptions still pause both main and fork coverage", () => {
    expect(memoryReviewCompletionState({ tasks: [{ interrupts: [{ value: { unfamiliar: true } }] }] })).toBe("awaiting");
    expect(memoryReviewCompletionState({ tasks: [] })).toBe("completed");
    expect(memoryReviewCompletionState(undefined)).toBe("pending");
    expect(memoryReviewCompletionState({})).toBe("pending");
    expect(memoryReviewCompletionState({ tasks: "unavailable" })).toBe("pending");
  });
  test("restart preserves exact interrupted checkpoint and never invents success", () => {
    const checkpoint = { channel_values: { turnId: "turn" } };
    expect(recoveredMemoryReviewTurnState("turn", { checkpoint, pendingWrites: [["task", "__interrupt__", [{ value: "approval" }]]] })).toBe("awaiting");
    expect(recoveredMemoryReviewTurnState("older-turn", { checkpoint, pendingWrites: [["task", "__interrupt__", [{ value: "approval" }]]] })).toBe("interrupted");
    expect(recoveredMemoryReviewTurnState("turn", { checkpoint, pendingWrites: [] })).toBe("interrupted");
    expect(recoveredMemoryReviewTurnState("turn", undefined)).toBe("interrupted");
  });
  test("Strict-unavailable startup never opens a checkpoint or a database scan", async () => {
    let reads = 0;
    const result = await recoverMemoryReviewTurnsAtStartup({
      db: {} as DirectDatabase,
      pageSize: 10,
      bootCutoff: new Date(),
      isTurnActive: () => false,
      checkAvailable: async () => false,
      readCheckpoint: async () => { reads++; return undefined; },
    });
    expect(reads).toBe(0);
    expect(result).toEqual({ recovered: 0, unavailable: true });
  });

});


test("startup recovery continues through pages while preserving active turns and source-update fences", async () => {
  const updatedAt = new Date("2026-09-04T10:00:00Z");
  const makeRow = (id: string) => ({ id, checkpointThreadId: `checkpoint-${id}`, turnId: `turn-${id}`, updatedAt });
  const pages = [[makeRow("a"), makeRow("b")], [makeRow("c")], []];
  const scans: SQL[] = [];
  const updates: SQL[] = [];
  const reads: string[] = [];
  const db = {
    select: () => ({ from: () => ({ where: (query: SQL) => {
      scans.push(query);
      return { orderBy: () => ({ limit: async () => pages.shift() ?? [] }) };
    } }) }),
    update: () => ({ set: () => ({ where: async (query: SQL) => { updates.push(query); } }) }),
  };
  const result = await recoverMemoryReviewTurnsAtStartup({
    db: db as never, pageSize: 2, bootCutoff: new Date("2026-09-05T10:00:00Z"),
    isTurnActive: (turnId) => turnId === "turn-b", checkAvailable: async () => true,
    readCheckpoint: async (threadId) => { reads.push(threadId); return undefined; },
  });
  expect(result).toEqual({ recovered: 2, unavailable: false });
  expect(reads).toEqual(["checkpoint-a", "checkpoint-c"]);
  expect(scans).toHaveLength(3);
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(scans[1]!).params).toContain("b");
  expect(dialect.sqlToQuery(scans[2]!).params).toContain("c");
  for (const update of updates) {
    const query = dialect.sqlToQuery(update);
    expect(query.sql).toContain('"updated_at" =');
    expect(query.sql.toLowerCase()).toContain('"receipt_id" is null');
    expect(query.params).toContain(updatedAt.toISOString());
  }
});

test("Memory source coordinates retain the complete burst and reject malformed IDs", () => {
  expect(memoryReviewSourceIds({ currentMessageId: 3, memoryReviewSourceMessageIds: [2, 1, 3, 1] })).toEqual([1, 2, 3]);
  expect(() => memoryReviewSourceIds({ memoryReviewSourceMessageIds: [1, "2"] })).toThrow("memory_review_source_invalid");
});
