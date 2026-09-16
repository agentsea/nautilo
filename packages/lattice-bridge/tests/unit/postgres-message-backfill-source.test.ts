import { describe, expect, test } from "bun:test";

import { decodeMessagePayloadV2 } from
  "../../src/message/message-payload-v2.ts";
import { readMessageBackfillOrdinarySource } from
  "../../src/server/message/postgres-message-backfill-source.ts";
import { readMessageBackfillToolSourceRow } from
  "../../src/server/message/message-backfill-tool-context.ts";
import type {
  ConversationProductDatabaseRow,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

class ScriptedExecutor implements ConversationProductPostgresExecutor {
  readonly calls: Array<Readonly<{
    statement: string;
    parameters: readonly ConversationProductPostgresScalar[];
  }>> = [];

  constructor(
    private readonly results: Array<readonly ConversationProductDatabaseRow[]>,
  ) {}

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    const result = this.results.shift();
    if (result === undefined) throw new Error(`Unexpected query: ${statement}`);
    return Promise.resolve(result as readonly Row[]);
  }

  assertExhausted(): void {
    expect(this.results).toEqual([]);
  }
}

function transcriptRow(
  id: number,
  role: "user" | "assistant" | "tool" | "system",
  overrides: ConversationProductDatabaseRow = {},
): ConversationProductDatabaseRow {
  return {
    id,
    session_id: SESSION,
    role,
    content: "",
    tool_calls: null,
    tool_name: null,
    created_at: new Date(1_800_000_000_000 + id),
    ...overrides,
  };
}

const input = {humanActorId: "22222222-2222-4222-8222-222222222222", sessionId: SESSION, messageId: 51, revision: 4};
const session = [{message_source_revision: 9}];
const ready = [{phase: "ready", selected_message_id: 1, selected_revision: 2, selected_call_ordinal: 1}];
const original = [transcriptRow(1, "assistant", {edit_revision: 2, opaque: false, oversized: false,
  tool_calls: JSON.stringify([{id: "first", name: "lookup", args: {}}, {id: "second", name: "lookup", args: {q: "private"}}])})];

describe("Postgres Message backfill ordinary source", () => {
  test("reads one exact prepared Tool call under the Session generation fence", async () => {
    const executor = new ScriptedExecutor([session,
      [transcriptRow(51, "tool", {content: "second result", tool_name: "lookup"})], ready, original]);
    const bytes = await readMessageBackfillOrdinarySource(executor, input);
    expect(decodeMessagePayloadV2(bytes!)).toEqual({role: "tool", content: "second result", toolName: "lookup",
      sensitiveMetadata: {toolCallId: "second"}});
    expect(executor.calls).toHaveLength(4);
    expect(executor.calls[0]!.statement).toContain('for share');
    expect(executor.calls[0]!.statement).toContain('"sessions"');
    expect(executor.calls.slice(1).every(c => !c.statement.includes('for share') && !c.statement.includes('for update'))).toBe(true);
    expect(executor.calls[2]!.parameters).toContain(9);
    expect(executor.calls[2]!.parameters).toContain(input.humanActorId);
    expect(executor.calls[3]!.parameters).toContain(1);
    executor.assertExhausted();
  });
  test.each([{context: []}, {context: [{phase: "scan"}]}, {context: [{phase: "clear"}]}])("a missing or stale prepared generation is retryable", async ({context}) => {
    const executor = new ScriptedExecutor([session,
      [transcriptRow(51, "tool", {content: "result", tool_name: "lookup"})], context]);
    expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull(); executor.assertExhausted();
  });
  test("rechecks referenced edit revision and tool name before encoding", async () => {
    for (const source of [{...original[0], edit_revision: 3}, {...original[0], tool_calls: JSON.stringify([
      {id: "first", name: "lookup"}, {id: "second", name: "substituted"}])}]) {
      const executor = new ScriptedExecutor([session,
        [transcriptRow(51, "tool", {content: "result", tool_name: "lookup"})], ready, [source]]);
      expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull();
    }
  });
  test("invalid context is a typed source integrity failure", async () => {
    const executor = new ScriptedExecutor([session,
      [transcriptRow(51, "tool", {content: "result", tool_name: "lookup"})], [{phase: "invalid"}]]);
    expect(readMessageBackfillOrdinarySource(executor, input)).rejects.toThrow("correlation is invalid");
  });
  test("encodes system metadata through canonical MessagePayloadV2", async () => {
    const executor = new ScriptedExecutor([session, [transcriptRow(51, "system", {content: "routing state changed",
      tool_calls: JSON.stringify({event: "room_membership", revision: 3})})]]);
    const bytes = await readMessageBackfillOrdinarySource(executor, input);
    expect(decodeMessagePayloadV2(bytes!)).toEqual({role: "system", content: "routing state changed",
      sensitiveMetadata: {event: "room_membership", revision: 3}});
    executor.assertExhausted();
  });
  test("returns no source for an exact protected-only revision", async () => {
    const executor = new ScriptedExecutor([session, [transcriptRow(51, "assistant", {content: null})]]);
    expect(await readMessageBackfillOrdinarySource(executor, input)).toBeNull(); executor.assertExhausted();
  });
  test("SQL rejects oversized source before loading strings or parsing JSON", async () => {
    const executor = new ScriptedExecutor([session, [transcriptRow(51, "assistant", {content: null, tool_calls: null, oversized: true})]]);
    expect(readMessageBackfillOrdinarySource(executor, input)).rejects.toThrow("exceeds Message payload encoding");
    expect(executor.calls[1]!.statement).toContain("octet_length");
    expect(executor.calls[1]!.statement).toContain("case when");
  });
});

test("context pages use exact PostgreSQL timestamp cursor and target bound with one source row", async () => {
  const executor = new ScriptedExecutor([[]]);
  await readMessageBackfillToolSourceRow(executor, {sessionId: SESSION,
    after: {createdAt: "2026-09-08 10:00:00.000001+00", id: 50}, throughMessageId: 10});
  const statement = executor.calls[0]!.statement;
  expect(statement).toContain('::timestamptz');
  expect(statement).toContain('::text');
  expect(statement).toContain('select "created_at" from "session_messages"');
  expect(statement).toContain('order by "session_messages"."created_at" asc, "session_messages"."id" asc');
  expect(statement).not.toContain('for share'); expect(statement).not.toContain('for update');
  expect(executor.calls[0]!.parameters).toContain("2026-09-08 10:00:00.000001+00");
  expect(executor.calls[0]!.parameters.at(-1)).toBe(1);
});
