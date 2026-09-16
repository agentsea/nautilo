import { expect, test } from "bun:test";
import {
  loadPostgresForegroundMessageRepairSources,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
} from "@nautilo/lattice-bridge/server";
import { serializeTranscriptToolCalls } from "../../src/store/transcript-tool-arguments.ts";

test("foreground repair consumes actual serialized tool calls with reused completed IDs", async () => {
  const namespaceId = "20000000-0000-4000-8000-000000000001";
  const row = (id: number, role: string, session: string, calls: string | null = null) => ({
    id,
    session_id: session,
    room_id: "10000000-0000-4000-8000-000000000001",
    namespace_id: namespaceId,
    role,
    content: role === "assistant" ? "" : "synthetic tool result",
    tool_calls: calls,
    tool_name: role === "tool" ? "manage_memory" : null,
    human_turn_id: null,
    edit_revision: 0,
    crypto_object_id: null,
    created_at: new Date(1_800_000_000_000 + id),
    agent_id: "40000000-0000-4000-8000-000000000001",
  });
  const call = (id: string) => serializeTranscriptToolCalls([
    { id, name: "manage_memory", args: { action: "inspect" }, type: "tool_call" },
  ]);
  const batches: Array<readonly ConversationProductDatabaseRow[]> = [
    [{ current_user: "nautilo", session_user: "nautilo" }],
    [
      row(1, "assistant", "session-A", call("manage_memory_0")),
      row(2, "assistant", "session-B", call("other-session-call")),
      row(3, "tool", "session-B"),
      row(4, "tool", "session-A"),
      row(5, "assistant", "session-A", call("manage_memory_0")),
      row(6, "tool", "session-A"),
    ],
  ];
  const connection: ConversationProductPostgresConnection = {
    query: <Row extends ConversationProductDatabaseRow>() => {
      const rows = batches.shift();
      if (rows === undefined) throw new Error("Unexpected query");
      return Promise.resolve(rows as readonly Row[]);
    },
    transaction: (callback) => callback(connection),
  };
  const product = await verifyConversationProductPostgresHandle(connection);
  const sources = await loadPostgresForegroundMessageRepairSources({
    product, readableNamespaceIds: [namespaceId], messageIds: [1, 2, 3, 4, 5, 6],
  });
  expect(sources.every((source) => source.payload !== null)).toBe(true);
  const payloads = sources.map((source) => {
    if (source.payload === null) {
      throw new Error("Default foreground repair loading must include ordinary payloads");
    }
    return source.payload;
  });
  expect(payloads[0]?.toolCalls).toEqual([
    { id: "manage_memory_0", name: "manage_memory", args: { action: "inspect" } },
  ]);
  expect(payloads[2]?.sensitiveMetadata).toEqual({ toolCallId: "other-session-call" });
  expect(payloads[3]?.sensitiveMetadata).toEqual({ toolCallId: "manage_memory_0" });
  expect(payloads[5]?.sensitiveMetadata).toEqual({ toolCallId: "manage_memory_0" });
});
