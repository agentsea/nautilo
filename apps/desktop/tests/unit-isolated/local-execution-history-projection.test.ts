import { expect, test } from "bun:test";
import { hasVerifiedLocalExecutionReference, projectLocalExecutionHistory, projectVerifiedLocalExecutionHistory, readLocalExecutionHistoryPage } from "../../electron/local-execution-history-projection";
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
const reference = { generation: record.generation, executionId: record.snapshot.executionId };
function pageInput(saved = record) {
  return { store: { read: async () => structuredClone(saved) }, scope: saved.scope,
    binding: { version: 1 as const, ...reference, invocationId: "read-a", sourceMessageId: 123,
      reader: { ...saved.owner, roomId: "room-a" } }, cursor: 0, maxBytes: 4, isCurrent: () => true };
}
async function rejected(promise: Promise<unknown>, message: string): Promise<void> {
  expect(await promise.catch((error: unknown) => error)).toMatchObject({ message });
}

test("history search returns one UTF-8 page and a distinct overlapping-match continuation", async () => {
  const saved = { ...record, snapshot: { ...record.snapshot, output: {
    data: "α😀α😀", cursor: 10, nextCursor: 22, availableFrom: 10, produced: 22, gap: true, hasMore: false } } };
  const first = await readLocalExecutionHistoryPage({ ...pageInput(saved), search: "😀" });
  expect(first).toMatchObject({ historical: true, exitCode: 7,
    search: { matchedAt: 12, nextSearchCursor: 16, complete: false, gap: true, availableFrom: 10, produced: 22 },
    output: { data: "😀", cursor: 12, nextCursor: 16, gap: false, hasMore: true } });
  const second = await readLocalExecutionHistoryPage({ ...pageInput(saved), search: "😀", cursor: first.search!.nextSearchCursor, maxBytes: 8 });
  expect(second.search).toMatchObject({ matchedAt: 18, nextSearchCursor: 22, complete: false, gap: false });
  const miss = await readLocalExecutionHistoryPage({ ...pageInput(saved), search: "😀", cursor: second.search!.nextSearchCursor });
  expect(miss.search).toMatchObject({ matchedAt: null, nextSearchCursor: 22, complete: true });
  expect(miss.output).toMatchObject({ data: "", cursor: 22, nextCursor: 22, hasMore: false });
});

test("settled history misses disclose discarded bytes and preserve unknown cleanup truth", async () => {
  const saved = { ...record, snapshot: { ...record.snapshot, state: "unknown" as const,
    resources: "release_failed" as const, failureCode: "LOCAL_EXECUTION_RESOURCE_CLEANUP_FAILED",
    output: { data: "tail", cursor: 100, nextCursor: 104, availableFrom: 100, produced: 104, gap: true, hasMore: false } } };
  const value = await readLocalExecutionHistoryPage({ ...pageInput(saved), search: "missing" });
  expect(value).toMatchObject({ state: "unknown", resources: "release_failed",
    search: { matchedAt: null, nextSearchCursor: 104, complete: true, gap: true } });
});

test("history search retains reader fences and rejects malformed literals or split cursors", async () => {
  const request = pageInput();
  for (const search of ["", "\ud800"]) await rejected(readLocalExecutionHistoryPage({ ...request, search }), "LOCAL_EXECUTION_SEARCH_INVALID");
  const saved = { ...record, snapshot: { ...record.snapshot, output: { ...record.snapshot.output, data: "αtail" } } };
  await rejected(readLocalExecutionHistoryPage({ ...pageInput(saved), search: "tail", cursor: 1 }), "LOCAL_EXECUTION_CURSOR_INVALID");
  await rejected(readLocalExecutionHistoryPage({ ...request, search: "final", binding: { ...request.binding,
    reader: { ...request.binding.reader, agentId: "other-agent" } } }), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
  let current = true;
  await rejected(readLocalExecutionHistoryPage({ ...request, search: "final", isCurrent: () => current,
    store: { read: async () => { current = false; return record; } } }), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
});
const originalPayload = { role: "tool" as const, toolName: "exec_command", content: JSON.stringify({ ...reference, session_id: reference.executionId, state: "running" }) };
const verified = { sessionId: "session-a", messageId: "123", editRevision: 0, status: "verified" as const,
  verification: "signed_representation_authenticated" as const, payload: originalPayload };
type Result = Parameters<typeof projectVerifiedLocalExecutionHistory>[0]["result"];
function result(records: Result["records"] = [verified]): Result {
  return { records, eligibleCount: records.length, verifiedCount: records.filter(row => row.status === "verified").length, fallbackCounts: {} };
}
function input() {
  let reads = 0;
  return {
    store: { read: async () => { reads += 1; return structuredClone(record); } },
    scope: record.scope, graphThreadId: "room:room-a", isCurrent: () => true,
    references: [reference], result: result(), reads: () => reads,
  };
}

test("verified exact protected tool result gains a separate local-history overlay", async () => {
  const request = input();
  const before = JSON.stringify(request.result);
  const overlays = await projectVerifiedLocalExecutionHistory(request);
  expect(overlays).toHaveLength(1);
  expect(overlays[0]).toMatchObject({ ...reference, sessionId: "session-a", messageId: "123", editRevision: 0,
    snapshot: { archived: true, state: "completed", exitCode: 7, expiresAt: null, output: { data: "final\n" } } });
  expect(JSON.stringify(request.result)).toBe(before);
  expect(request.reads()).toBe(1);
});

test("fallback and unrelated verified payloads cannot authorize archive reads", async () => {
  const request = input();
  const candidates: Result["records"] = [
    { sessionId: "session-a", messageId: "123", editRevision: 0, status: "fallback", reason: "current_read_authority_unavailable" },
    { ...verified, payload: { ...originalPayload, role: "user" } },
    { ...verified, payload: { ...originalPayload, toolName: "run_shell" } },
    { ...verified, payload: { ...originalPayload, content: "truncated{" } },
    { ...verified, payload: { ...originalPayload, content: JSON.stringify({ ...reference, session_id: "other" }) } },
  ];
  expect(hasVerifiedLocalExecutionReference(result(candidates))).toBe(false);
  expect(await projectVerifiedLocalExecutionHistory({ ...request, result: result(candidates) })).toEqual([]);
  expect(request.reads()).toBe(0);
});

test("fresh server-resolved conversation identity is required", async () => {
  const request = input();
  expect(await projectLocalExecutionHistory({ ...request, graphThreadId: "room:other" })).toEqual([]);
  expect(await projectLocalExecutionHistory({ ...request, graphThreadId: "room:room" })).toEqual([]);
  expect(await projectLocalExecutionHistory({ ...request, graphThreadId: "task:room-a" })).toEqual([]);
});

test("identity invalidated during archive read delivers nothing", async () => {
  const request = input();
  let current = true;
  const overlays = await projectVerifiedLocalExecutionHistory({ ...request, isCurrent: () => current,
    store: { read: async () => { current = false; return record; } } });
  expect(overlays).toEqual([]);
});

test("already invalidated identity does not read archive", async () => {
  const request = input();
  expect(await projectLocalExecutionHistory({ ...request, isCurrent: () => false })).toEqual([]);
  expect(request.reads()).toBe(0);
});

test("missing or unreadable archive leaves history unchanged", async () => {
  const request = input();
  expect(await projectVerifiedLocalExecutionHistory({ ...request, store: { read: async () => null } })).toEqual([]);
  expect(await projectVerifiedLocalExecutionHistory({ ...request, store: { read: async () => { throw new Error("unavailable"); } } })).toEqual([]);
});

test("uncertain settled cleanup remains unknown in an archived view", async () => {
  const uncertain = structuredClone(record);
  (uncertain as { snapshot: LocalExecutionHistoryRecord["snapshot"] }).snapshot = { ...record.snapshot,
    state: "unknown", resources: "release_failed", failureCode: "LOCAL_EXECUTION_RESOURCE_CLEANUP_FAILED" };
  const overlays = await projectLocalExecutionHistory({ ...input(), store: { read: async () => uncertain } });
  expect(overlays[0]?.snapshot).toMatchObject({ archived: true, state: "unknown", resources: "release_failed" });
});
