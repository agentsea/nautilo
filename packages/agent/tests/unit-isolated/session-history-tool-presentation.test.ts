import { expect, mock, test } from "bun:test";

const database = await import("@nautilo/db");
let rows: Record<string, unknown>[] = [];
const selections: string[][] = [];
let executeRows: Record<string, unknown>[][] = [];
const fakeDb = {
  select(fields: Record<string, unknown>) {
    selections.push(Object.keys(fields));
    const selected = rows.map((row) => Object.fromEntries(
      Object.keys(fields).map((key) => [key, row[key]]),
    ));
    const query = {
      from: () => query, where: () => query, innerJoin: () => query,
      orderBy: () => query, limit: () => query, offset: () => query,
      then: (resolve: (value: Record<string, unknown>[]) => unknown,
        reject?: (error: unknown) => unknown) => Promise.resolve(selected).then(resolve, reject),
    };
    return query;
  },
  execute: () => Promise.resolve(executeRows.shift() ?? []),
};
mock.module("@nautilo/db", () => ({ ...database, agentDb: fakeDb }));
const trustDb = await import("../../src/store/trust-agent-db");
mock.module("../../src/store/trust-agent-db", () => ({
  ...trustDb,
  withAgentTrustContext: (_context: unknown, work: (tx: typeof fakeDb) => unknown) => work(fakeDb),
}));
const store = await import("../../src/store/session-store");
const search = await import("../../src/store/room-message-search");

function fixtures() {
  return ["tool", "assistant"].map((role, index) => ({
    id: index + 1, sessionId: "session", role, content: "result", toolCalls: null,
    toolName: role === "tool" ? "exec_command" : null,
    metadata: { privateSidecar: "not-for-http", nautilo_tool_result: {
      toolCallId: "file-call", toolStatus: "success", untrusted: "not-for-http",
    } },
    createdAt: new Date("2026-01-01T00:00:00.000Z"), editedAt: null, editRevision: 0,
    fingerprint: null, sourceUserId: "human", sessionAgentId: "agent",
  }));
}

test("all ordinary history projections carry only persisted closed tool fields", async () => {
  for (const read of [
    () => store.getSessionMessages("session"),
    () => store.getLatestSessionMessages("session"),
    async () => (await store.getRoomMessagesBeforeCursor({
      ownerId: "human", roomId: "room", beforeCreatedAt: new Date(), beforeId: 99,
    })).messages,
    async () => (await store.getRoomMessagesAcrossMemberSessionsWithSelection({
      ownerId: "human", roomId: "room", beforeCreatedAt: new Date(), beforeId: 99,
    })).messages,
  ]) {
    rows = fixtures();
    const result = await read();
    expect(result.find((row) => row.role === "tool")).toMatchObject({ toolCallId: "file-call", toolStatus: "success" });
    expect(result.find((row) => row.role === "assistant")).not.toHaveProperty("toolCallId");
    expect(JSON.stringify(result)).not.toContain("not-for-http");
    rows[0]!["metadata"] = { nautilo_tool_result: { toolCallId: ["forged"], toolStatus: "unknown" } };
    expect((await read()).find((row) => row.role === "tool")).not.toHaveProperty("toolCallId");
    expect((await read()).find((row) => row.role === "tool")).not.toHaveProperty("toolStatus");
  }
});

test("structural protected history neither selects nor projects ordinary identity", async () => {
  rows = fixtures(); selections.length = 0;
  const result = await store.getRoomMessagesAcrossMemberSessionsWithSelection({
    ownerId: "human", roomId: "room", beforeCreatedAt: new Date(), beforeId: 99,
    contentRepresentation: "structural",
  });
  expect(selections[0]).not.toContain("metadata");
  for (const row of result.messages) {
    expect(row.content).toBeNull();
    expect(row).not.toHaveProperty("toolCallId");
    expect(row).not.toHaveProperty("toolStatus");
  }
});

test("around reader retains exact tool presentation without exposing metadata", async () => {
  const target = {
    message_id: 2, session_id: "session", role: "tool", content: "result", tool_calls: null,
    tool_name: "exec_command", tool_presentation: { toolCallId: "file-call", toolStatus: "error", private: "hidden" },
    created_at: "2026-01-01T00:00:00.000Z", edited_at: null, edit_revision: 0,
    fingerprint: null, session_agent_id: "agent", source_user_id: "human",
  };
  executeRows = [[target], [], [], [], [], []];
  const result = await search.getRoomMessagesAround({ ownerId: "human", roomId: "room", messageId: 2 });
  expect(result?.messages[0]).toMatchObject({ toolCallId: "file-call", toolStatus: "error" });
  expect(JSON.stringify(result)).not.toContain("hidden");
  expect(result?.messages[0]).not.toHaveProperty("tool_presentation");
});
