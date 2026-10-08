import { expect, test } from "bun:test";
import { readLocalExecutionHistoryPage } from "../../electron/local-execution-history-projection";
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
