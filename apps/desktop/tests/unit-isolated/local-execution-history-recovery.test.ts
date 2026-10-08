import { expect, test } from "bun:test";
import { readLocalExecutionHistoryPage, readLocalExecutionWithExpiredHistory } from "../../electron/local-execution-history-projection";
import type { LocalExecutionHistoryRecord } from "../../electron/local-execution-history";

const record: LocalExecutionHistoryRecord = {
  version: 1, generation: "generation-a",
  scope: { instanceId: "fixture", origin: "https://server.example", serverFingerprint: "fingerprint-a", humanUserId: "human-a", relayId: "relay-a", pairingGeneration: "pair-a" },
  owner: { instanceId: "fixture", humanUserId: "human-a", agentId: "agent-a", runId: "run-a", conversationId: "room:room-a:bot:agent-a",
    relayId: "relay-a", desktopSessionId: "old-session", pairingGeneration: "pair-a", serverBindingId: "server-a",
    profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null },
  snapshot: { executionId: "execution-a", state: "completed", tty: false, pid: 42, exitCode: 7, signal: null,
    terminationScope: "owned_process_group", output: { data: "final\n", cursor: 0, nextCursor: 6, availableFrom: 0, produced: 6, gap: false, hasMore: false },
    failureCode: null, expiresAt: null, resources: "released" },
};

const binding = { version: 1 as const, generation: record.generation, executionId: record.snapshot.executionId, sourceMessageId: 42, invocationId: "new-read", reader: { instanceId: record.scope.instanceId, humanUserId: record.scope.humanUserId, agentId: record.owner.agentId, conversationId: record.owner.conversationId, roomId: "room-a", relayId: record.scope.relayId, pairingGeneration: record.scope.pairingGeneration, desktopSessionId: "new-session" } };
const request = () => ({ store: { read: async () => structuredClone(record) }, scope: record.scope, binding, cursor: 0, maxBytes: 4, isCurrent: () => true });
test("new Desktop reads exact old settled receipt with repeatable byte pages", async () => {
  const input = request(); const page = await readLocalExecutionHistoryPage(input);
  expect(page).toMatchObject({ historical: true, generation: record.generation, state: "completed", exitCode: 7, output: { data: "fina", nextCursor: 4, hasMore: true } });
  expect(page).not.toHaveProperty("archived"); expect(await readLocalExecutionHistoryPage(input)).toEqual(page);
  expect(await readLocalExecutionHistoryPage({ ...input, cursor: page.output.nextCursor })).toMatchObject({ output: { data: "l\n", nextCursor: 6, hasMore: false } });
});
test("foreign Agent, conversation or changed current reader cannot recover bytes", async () => {
  for (const reader of [{ ...binding.reader, humanUserId: "foreign" }, { ...binding.reader, pairingGeneration: "foreign" }, { ...binding.reader, instanceId: "foreign" }, { ...binding.reader, agentId: "foreign" }, { ...binding.reader, conversationId: "foreign" }]) {
    expect(await readLocalExecutionHistoryPage({ ...request(), binding: { ...binding, reader } }).then(() => false, () => true)).toBe(true);
  }
  let current = true;
  expect(await readLocalExecutionHistoryPage({ ...request(), isCurrent: () => current, store: { read: async () => { current = false; return record; } } }).then(() => false, () => true)).toBe(true);
});
test("Unicode retained gap stays explicit and no byte cursor splits a character", async () => {
  const unicode = { ...record, snapshot: { ...record.snapshot, output: { data: "🌊end", cursor: 10, nextCursor: 17, availableFrom: 10, produced: 17, gap: true, hasMore: false } } };
  const input = { ...request(), store: { read: async () => unicode } };
  expect(await readLocalExecutionHistoryPage(input)).toMatchObject({ output: { data: "🌊", cursor: 10, nextCursor: 14, gap: true, hasMore: true } });
  expect(await readLocalExecutionHistoryPage({ ...input, cursor: 11 }).then(() => false, () => true)).toBe(true);
});

function expiredReadFixture() {
  let current = true;
  let historyCurrent = true;
  let reads = 0;
  let stored: unknown = structuredClone(record);
  const input = {
    request: { generation: record.generation, executionId: record.snapshot.executionId, cursor: 6, maxBytes: 4 },
    cancel: false,
    isCurrent: () => current,
    readLive: async () => { throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED"); },
    openHistory: async () => ({ scope: record.scope, isCurrent: () => historyCurrent,
      store: { read: async () => { reads++; return stored as LocalExecutionHistoryRecord; } } }),
  };
  return { input, reads: () => reads, store: (value: unknown) => { stored = value; },
    retire: () => { current = false; }, changeHistory: () => { historyCurrent = false; } };
}
test("expired Human reads recover exact settled Task receipts without conversation substitution", async () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const fixture = expiredReadFixture();
    fixture.store({ ...record, owner: { ...record.owner, conversationId: "task-original-run" },
      snapshot: { ...record.snapshot, state, exitCode: state === "completed" ? 0 : null } });
    const result = await readLocalExecutionWithExpiredHistory(fixture.input);
    expect(result).toMatchObject({ archived: true, state, generation: record.generation,
      executionId: record.snapshot.executionId, output: record.snapshot.output });
    expect(fixture.reads()).toBe(1);
  }
});
test("cancel and non-expiry failures cannot consult saved history", async () => {
  const { rejects } = await import("node:assert/strict");
  const cancelled = expiredReadFixture();
  await rejects(readLocalExecutionWithExpiredHistory({ ...cancelled.input, cancel: true }), /RECEIPT_EXPIRED/);
  expect(cancelled.reads()).toBe(0);
  for (const reason of ["LOCAL_EXECUTION_GENERATION_MISMATCH", "LOCAL_EXECUTION_OWNER_MISMATCH", "LOCAL_EXECUTION_NOT_FOUND", "transport unavailable"]) {
    const fixture = expiredReadFixture();
    await rejects(readLocalExecutionWithExpiredHistory({ ...fixture.input, readLive: async () => { throw new Error(reason); } }), new RegExp(reason));
    expect(fixture.reads()).toBe(0);
  }
});
test("expired read rejects foreign scope, different references and nonterminal archives", async () => {
  const { rejects } = await import("node:assert/strict");
  for (const changed of [null, { ...record, generation: "other" },
    { ...record, snapshot: { ...record.snapshot, executionId: "other" } },
    { ...record, snapshot: { ...record.snapshot, state: "running", resources: "owned" } },
    { ...record, scope: { ...record.scope, serverFingerprint: "other" } },
    { ...record, scope: { ...record.scope, humanUserId: "other" }, owner: { ...record.owner, humanUserId: "other" } },
    { ...record, scope: { ...record.scope, pairingGeneration: "other" }, owner: { ...record.owner, pairingGeneration: "other" } }]) {
    const fixture = expiredReadFixture(); fixture.store(changed);
    await rejects(readLocalExecutionWithExpiredHistory(fixture.input), /HISTORY_UNAVAILABLE/);
  }
});
test("session or generation retirement during live lookup or archive read suppresses saved bytes", async () => {
  const { rejects } = await import("node:assert/strict");
  const before = expiredReadFixture();
  await rejects(readLocalExecutionWithExpiredHistory({ ...before.input, readLive: async () => {
    before.retire(); throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED");
  } }), /OWNER_CHANGED/);
  expect(before.reads()).toBe(0);
  for (const retire of ["session", "history"] as const) {
    const fixture = expiredReadFixture();
    await rejects(readLocalExecutionWithExpiredHistory({ ...fixture.input, openHistory: async () => {
      const history = await fixture.input.openHistory();
      return { ...history, store: { read: async () => {
        if (retire === "session") fixture.retire();
        else fixture.changeHistory();
        return record;
      } } };
    } }), /OWNER_CHANGED/);
  }
});
test("expired recovery still rejects future and split UTF8 cursors", async () => {
  const { rejects } = await import("node:assert/strict");
  for (const cursor of [1, 5]) {
    const fixture = expiredReadFixture();
    fixture.store({ ...record, snapshot: { ...record.snapshot, output: {
      data: "🌊", cursor: 0, nextCursor: 4, availableFrom: 0, produced: 4, gap: false, hasMore: false,
    } } });
    await rejects(readLocalExecutionWithExpiredHistory({ ...fixture.input,
      request: { ...fixture.input.request, cursor } }), /CURSOR_INVALID/);
  }
});
