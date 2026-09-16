import { describe, expect, test } from "bun:test";

import {
  loadPostgresForegroundMessageRepairSources,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const PARENT_NAMESPACE_ID = "20000000-0000-4000-8000-000000000002";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: string[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: Array<readonly unknown[]>;

  constructor(results: readonly (readonly unknown[])[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push(statement);
    const result = this.#results.shift();
    if (result === undefined) return Promise.reject(new Error("Unexpected query"));
    return Promise.resolve(result as readonly Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

async function product(rows: readonly unknown[]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    rows,
  ]);
  return {
    connection,
    handle: await verifyConversationProductPostgresHandle(connection),
  };
}

async function productBatches(batches: readonly (readonly unknown[])[]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...batches,
  ]);
  return {
    connection,
    handle: await verifyConversationProductPostgresHandle(connection),
  };
}

describe("Postgres foreground Message repair source", () => {
  test("selects a bodyless Full-origin row for Shadow reverse repair", async () => {
    const postgres = await product([{
      id: 11,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role: "user",
      content: null,
      tool_calls: null,
      tool_name: null,
      human_turn_id: "turn-11",
      edit_revision: 0,
      crypto_object_id: "conversation-message-v2:full-origin",
      created_at: new Date("2026-09-04T10:00:01.000Z"),
      agent_id: "40000000-0000-4000-8000-000000000001",
    }]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [11],
      representationMode: "ordinary-and-protected",
    });

    expect(sources).toEqual([expect.objectContaining({
      messageId: 11,
      mappedCryptoObjectId: "conversation-message-v2:full-origin",
      payload: null,
    })]);
    const selection = postgres.connection.queries[1]!.split(" from ")[0]!;
    expect(selection).toContain('"content"');
    expect(selection).toContain('"tool_calls"');
    expect(selection).toContain('"tool_name"');
  });

  test("preserves mixed ordinary tool pairing across opaque Full-origin turns", async () => {
    const base = (id: number, role: string, content: string | null) => ({
      id,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role,
      content,
      tool_calls: null,
      tool_name: null,
      human_turn_id: role === "user" ? `turn-${id}` : null,
      edit_revision: 0,
      crypto_object_id: content === null ? `conversation-message-v2:${id}` : null,
      created_at: new Date(`2026-09-04T10:00:0${id}.000Z`),
      agent_id: "40000000-0000-4000-8000-000000000001",
    });
    const postgres = await product([
      { ...base(1, "assistant", ""), tool_calls: JSON.stringify([{
        id: "ordinary-call-before", name: "search", args: {},
      }]) },
      { ...base(2, "tool", "ordinary-before"), tool_name: "search" },
      base(3, "user", null),
      base(4, "assistant", null),
      base(5, "tool", null),
      base(6, "assistant", null),
      { ...base(7, "assistant", ""), tool_calls: JSON.stringify([{
        id: "ordinary-call-after", name: "search", args: {},
      }]) },
      { ...base(8, "tool", "ordinary-after"), tool_name: "search" },
    ]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [1, 2, 3, 4, 5, 6, 7, 8],
      representationMode: "ordinary-and-protected",
    });

    expect(sources.slice(2, 6).map((source) => source.payload)).toEqual([
      null, null, null, null,
    ]);
    expect(sources[1]?.payload).toMatchObject({
      role: "tool",
      sensitiveMetadata: { toolCallId: "ordinary-call-before" },
    });
    expect(sources[7]?.payload).toMatchObject({
      role: "tool",
      sensitiveMetadata: { toolCallId: "ordinary-call-after" },
    });
  });

  test("defers partially restored tool identities to their protected payloads", async () => {
    const base = (id: number, role: "assistant" | "tool", content: string | null) => ({
      id,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role,
      content,
      tool_calls: null,
      tool_name: null,
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: `conversation-message-v2:${id}`,
      created_at: new Date(`2026-09-04T10:01:0${id}.000Z`),
      agent_id: "40000000-0000-4000-8000-000000000001",
    });
    const postgres = await product([
      // The call remains protected-only while its result was already restored.
      base(1, "assistant", null),
      { ...base(2, "tool", "restored-result"), tool_name: "search" },
      // The inverse partial state must also reset correlation for later pairs.
      { ...base(3, "assistant", ""), tool_calls: JSON.stringify([{
        id: "partially-restored-call", name: "lookup", args: {},
      }]) },
      base(4, "tool", null),
      // Even when both ordinary copies are present, a mapped Tool row owns its
      // identity in the authenticated protected payload.
      { ...base(5, "assistant", ""), tool_calls: JSON.stringify([{
        id: "fully-ordinary-call", name: "fetch", args: {},
      }]) },
      { ...base(6, "tool", "fully-ordinary-result"), tool_name: "fetch" },
    ]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [1, 2, 3, 4, 5, 6],
      representationMode: "ordinary-and-protected",
    });

    expect(sources[0]?.payload).toBeNull();
    expect(sources[1]).toMatchObject({
      ordinaryComparison: "tool_result_protected_identity",
      payload: { role: "tool", content: "restored-result", toolName: "search" },
    });
    expect(sources[3]?.payload).toBeNull();
    expect(sources[5]).toMatchObject({
      ordinaryComparison: "tool_result_protected_identity",
      payload: {
        role: "tool",
        content: "fully-ordinary-result",
        toolName: "fetch",
      },
    });
  });

  test("defers mapped project-checkpoint duplicate identity to the protected Tool payload", async () => {
    const base = (id: number, role: "assistant" | "tool") => ({
      id,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role,
      content: role === "assistant" ? "" : "projected memory",
      tool_calls: null,
      tool_name: role === "tool" ? "share_memory" : null,
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: `conversation-message-v2:${id}`,
      created_at: new Date(`2026-09-04T10:02:0${id}.000Z`),
      agent_id: "40000000-0000-4000-8000-000000000001",
    });
    const postgres = await product([
      { ...base(1, "assistant"), tool_calls: JSON.stringify([{
        id: "project-call",
        name: "share_memory",
        args: {
          mode: "project",
          proposed_content: "original proposal",
          source_memory_ids: ["memory-source-1"],
        },
      }]) },
      { ...base(2, "assistant"), tool_calls: JSON.stringify([{
        id: "project-call",
        name: "share_memory",
        args: { mode: "project" },
      }]) },
      base(3, "tool"),
    ]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [1, 2, 3],
      representationMode: "ordinary-and-protected",
    });

    expect(sources[0]?.payload).toMatchObject({
      role: "assistant",
      toolCalls: [{
        id: "project-call",
        name: "share_memory",
        args: {
          mode: "project",
          proposed_content: "original proposal",
          source_memory_ids: ["memory-source-1"],
        },
      }],
    });
    expect(sources[1]?.payload).toMatchObject({
      role: "assistant",
      toolCalls: [{
        id: "project-call",
        name: "share_memory",
        args: { mode: "project" },
      }],
    });
    expect(sources[2]).toMatchObject({
      ordinaryComparison: "tool_result_protected_identity",
      payload: {
        role: "tool",
        content: "projected memory",
        toolName: "share_memory",
      },
    });
    expect(sources[2]?.payload).not.toHaveProperty("sensitiveMetadata");
  });

  test("protected-only selection excludes every ordinary payload column", async () => {
    const postgres = await product([{
      id: 11,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role: "user",
      human_turn_id: "turn-11",
      edit_revision: 3,
      crypto_object_id: "conversation-message-v2:protected-only",
      created_at: new Date("2026-09-04T10:00:01.000Z"),
      agent_id: "40000000-0000-4000-8000-000000000001",
    }]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [11],
      representationMode: "protected-only",
    });

    expect(sources).toEqual([expect.objectContaining({
      messageId: 11,
      namespaceId: NAMESPACE_ID,
      revision: 3,
      mappedCryptoObjectId: "conversation-message-v2:protected-only",
      payload: null,
    })]);
    const selection = postgres.connection.queries[1]!.split(" from ")[0]!;
    expect(selection).not.toContain('"content"');
    expect(selection).not.toContain('"tool_calls"');
    expect(selection).not.toContain('"tool_name"');
  });

  test.each([
    { id: "call-1", name: "search", args: {}, type: "unknown" },
    { id: "call-1", name: "search", args: {}, type: "tool_call", unsupported: true },
  ])("retains strict wire validation after transcript marker normalization: %j", async (call) => {
    const postgres = await product([{
      id: 11,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role: "assistant",
      content: "",
      tool_calls: JSON.stringify([call]),
      tool_name: null,
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: null,
      created_at: new Date("2026-09-04T10:00:01.000Z"),
      agent_id: "40000000-0000-4000-8000-000000000001",
    }]);
    expect(loadPostgresForegroundMessageRepairSources({
      product: postgres.handle, readableNamespaceIds: [NAMESPACE_ID], messageIds: [11],
    })).rejects.toThrow("contains unknown field");
  });

  test("loads only the exact selected IDs and preserves caller order", async () => {
    const postgres = await product([
      {
        id: 12,
        session_id: "30000000-0000-4000-8000-000000000001",
        room_id: ROOM_ID,
        namespace_id: PARENT_NAMESPACE_ID,
        role: "assistant",
        content: "answer",
        tool_calls: null,
        tool_name: null,
        human_turn_id: null,
        edit_revision: 2,
        crypto_object_id: "conversation-message-v2:existing",
        created_at: new Date("2026-09-04T10:00:02.000Z"),
        agent_id: "40000000-0000-4000-8000-000000000001",
      },
      {
        id: 11,
        session_id: "30000000-0000-4000-8000-000000000001",
        room_id: ROOM_ID,
        namespace_id: NAMESPACE_ID,
        role: "user",
        content: "question",
        tool_calls: null,
        tool_name: null,
        human_turn_id: "turn-11",
        edit_revision: 0,
        crypto_object_id: null,
        created_at: new Date("2026-09-04T10:00:01.000Z"),
        agent_id: "40000000-0000-4000-8000-000000000001",
      },
    ]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID, PARENT_NAMESPACE_ID],
      messageIds: [12, 11],
    });

    expect(sources.map((source) => source.messageId)).toEqual([12, 11]);
    expect(sources[0]?.payload).toMatchObject({
      role: "assistant",
      content: "answer",
    });
    expect(sources[0]?.namespaceId).toBe(PARENT_NAMESPACE_ID);
    expect(sources[1]?.payload).toMatchObject({
      role: "user",
      content: "question",
    });
    expect(sources[1]?.mappedCryptoObjectId).toBeNull();
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    expect(postgres.connection.queries[1]).toContain("in ($1, $2)");
    expect(postgres.connection.queries[1]).toContain("in ($3, $4)");
  });

  test("fails closed when the selected set changes", async () => {
    const postgres = await product([]);
    expect(loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [11],
    })).rejects.toThrow("selection changed");
  });

  test("loads system audit Messages through the canonical protected payload", async () => {
    const postgres = await product([{
      id: 13,
      session_id: "30000000-0000-4000-8000-000000000001",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role: "system",
      content: "A member joined the Room",
      tool_calls: JSON.stringify({
        kind: "room_membership",
        memberId: "50000000-0000-4000-8000-000000000001",
      }),
      tool_name: null,
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: null,
      created_at: new Date("2026-09-04T10:00:03.000Z"),
      agent_id: "40000000-0000-4000-8000-000000000001",
    }]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: [13],
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.payload).toEqual({
      role: "system",
      content: "A member joined the Room",
      sensitiveMetadata: {
        kind: "room_membership",
        memberId: "50000000-0000-4000-8000-000000000001",
      },
    });
    expect(sources[0]?.authorRole).toBe("system");
  });

  test("pairs tool results across an internal 256-row query boundary", async () => {
    const sessionId = "30000000-0000-4000-8000-000000000001";
    const agentId = "40000000-0000-4000-8000-000000000001";
    const row = (id: number, overrides: Record<string, unknown> = {}) => ({
      id,
      session_id: sessionId,
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      role: "user",
      content: `message-${id}`,
      tool_calls: null,
      tool_name: null,
      human_turn_id: `turn-${id}`,
      edit_revision: 0,
      crypto_object_id: null,
      created_at: new Date(1_800_000_000_000 + id),
      agent_id: agentId,
      ...overrides,
    });
    const firstBatch = Array.from({ length: 255 }, (_, index) => row(index + 1));
    firstBatch.push(row(256, {
      role: "assistant",
      content: "",
      tool_calls: JSON.stringify([{
        id: "call-boundary",
        name: "search_memory",
        args: {},
      }]),
      human_turn_id: null,
    }));
    const postgres = await productBatches([
      firstBatch,
      [row(257, {
        role: "tool",
        content: "tool result",
        tool_name: "search_memory",
        human_turn_id: null,
      })],
    ]);

    const sources = await loadPostgresForegroundMessageRepairSources({
      product: postgres.handle,
      readableNamespaceIds: [NAMESPACE_ID],
      messageIds: Array.from({ length: 257 }, (_, index) => index + 1),
    });

    expect(sources).toHaveLength(257);
    expect(sources[256]?.payload).toMatchObject({
      role: "tool",
      content: "tool result",
      sensitiveMetadata: { toolCallId: "call-boundary" },
    });
    expect(postgres.connection.queries).toHaveLength(3);
  });
});
