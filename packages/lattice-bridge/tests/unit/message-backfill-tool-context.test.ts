import {expect, test} from "bun:test";
import {advanceMessageBackfillToolContext, initialMessageBackfillToolContext, messageBackfillToolCall,
  MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS, type MessageBackfillToolCallReference,
  type MessageBackfillToolContextPort, type MessageBackfillToolSourceRow,
} from "../../src/server/message/message-backfill-tool-context.ts";
import {createLiveShadowToolResultCallIdResolver} from "../../src/server/message/postgres-live-shadow-client-verification.ts";

const HUMAN = "11111111-1111-4111-8111-111111111111", SESSION = "22222222-2222-4222-8222-222222222222";
function row(id: number, role: string, toolCalls: unknown = null, toolName: string | null = null): MessageBackfillToolSourceRow {
  return {id, role, revision: 0, createdAt: new Date(1_800_000_000_000 + id).toISOString(), opaque: false,
    toolCalls: toolCalls === null ? null : JSON.stringify(toolCalls), toolName, oversized: false};
}
const call = (id: string, name = "lookup", value = "private arguments") => ({id, name, args: {value}});
function fixture(rows: MessageBackfillToolSourceRow[]) {
  const pending = new Map<number, MessageBackfillToolCallReference>();
  const target = rows.at(-1)!;
  const state = initialMessageBackfillToolContext({humanActorId: HUMAN, sessionId: SESSION,
    messageId: target.id, revision: target.revision}, 0);
  let reads = 0;
  const port: MessageBackfillToolContextPort = {
    row: async id => {reads++; return rows.find(r => r.id === id) ?? null;},
    next: async after => {reads++; return rows.find(r => after === null
      || r.createdAt > after.createdAt || (r.createdAt === after.createdAt && r.id > after.id)) ?? null;},
    pending: async after => {reads++; return [...pending.values()].sort((a,b) => a.sequence-b.sequence).find(r => r.sequence > after) ?? null;},
    insert: async reference => {pending.set(reference.sequence, reference);},
    remove: async sequence => {pending.delete(sequence);},
  };
  let activations = 0;
  const activate = async () => {
    const before = reads;
    await advanceMessageBackfillToolContext(state, port);
    expect(reads - before).toBeLessThanOrEqual(MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS * 3);
    const persisted = JSON.stringify({state, pending: [...pending.values()]});
    expect(persisted).not.toContain("lookup"); expect(persisted).not.toContain("private arguments");
    expect(persisted).not.toContain('"args"'); expect(persisted).not.toContain('"identity"');
    activations++;
  };
  const complete = async () => {
    while (state.phase !== "ready" && state.phase !== "invalid") {
      if (activations > 20_000) throw new Error("Continuation did not progress");
      await activate();
    }
    return state.selectedMessageId === null ? null
      : messageBackfillToolCall(rows.find(r => r.id === state.selectedMessageId)!, state.selectedCallOrdinal!)?.id;
  };
  return {rows, state, pending, activate, complete, activations: () => activations};
}
function canonical(rows: MessageBackfillToolSourceRow[]) {
  const values = createLiveShadowToolResultCallIdResolver({opaqueBodylessRows: true}).consume(rows.map(r => ({
    session_id: SESSION, role: r.role, content: r.opaque ? null : "", tool_calls: r.toolCalls, tool_name: r.toolName,
  })));
  return values.get(rows.length);
}

test("resumes calls and FIFO name matches across many source and comparison pages", async () => {
  const rows = [row(1, "assistant", Array.from({length: 125}, (_, i) => call(`call-${i}`, i === 124 ? "target" : "lookup"))),
    ...Array.from({length: 80}, (_, i) => row(i + 2, "user")), row(82, "tool", null, "target")];
  const f = fixture(rows);
  expect(await f.complete()).toBe(canonical(rows));
  expect(f.activations()).toBeGreaterThan(100);
  expect(f.pending.size).toBe(125);
  expect([...f.pending.values()].every(ref => Object.keys(ref).sort().join() ===
    "callOrdinal,humanActorId,sequence,sourceMessageId,sourceRevision")).toBe(true);
});
test("duplicate pending identical calls consume one result and completed IDs can be reused", async () => {
  const rows = [row(1, "assistant", [call("reused"), call("second")]),
    row(2, "assistant", [call("reused")]), row(3, "tool", null, "lookup"),
    row(4, "assistant", [call("reused", "lookup", "different arguments after completion")]),
    row(5, "tool", null, "lookup"), row(6, "tool", null, "lookup")];
  const f = fixture(rows);
  expect(await f.complete()).toBe("reused"); expect(await f.complete()).toBe(canonical(rows));
  expect(f.state.selectedMessageId).toBe(4);
});
test("conflicting pending duplicates are rejected even across comparison activations", async () => {
  const rows = [row(1, "assistant", Array.from({length: 80}, (_, i) => call(`call-${i}`))),
    row(2, "assistant", [call("call-79", "lookup", "substitution")]), row(3, "tool", null, "lookup")];
  const f = fixture(rows); await f.complete(); expect(f.state.phase).toBe("invalid");
  expect(() => canonical(rows)).toThrow("conflicts");
});
test("opaque boundaries drain all pending references through bounded activations", async () => {
  const rows = [row(1, "assistant", Array.from({length: 125}, (_, i) => call(`call-${i}`))),
    {...row(2, "assistant"), opaque: true}, row(3, "assistant", [call("new-call")]), row(4, "tool", null, "lookup")];
  const f = fixture(rows); expect(await f.complete()).toBe(canonical(rows));
  expect(f.pending.size).toBe(1); expect(f.state.selectedMessageId).toBe(3);
});
test("source generation changes invalidate ready references and rebuild after bounded cleanup", async () => {
  const rows = [row(1, "assistant", [call("old-call")]), row(2, "tool", null, "lookup")];
  const f = fixture(rows); expect(await f.complete()).toBe("old-call");
  rows[0] = {...row(1, "assistant", [call("new-call")]), revision: 1};
  Object.assign(f.state, initialMessageBackfillToolContext({humanActorId: HUMAN, sessionId: SESSION, messageId: 2, revision: 0}, 1));
  expect(f.state.selectedMessageId).toBeNull();
  expect(await f.complete()).toBe("new-call"); expect(f.state.selectedRevision).toBe(1);
});
test("source ordering retains sub-millisecond chronology independent of numeric Message IDs", async () => {
  const rows = [{...row(50, "assistant", [call("imported")]), createdAt: "2026-09-08 10:00:00.000001+00"},
    {...row(10, "tool", null, "lookup"), createdAt: "2026-09-08 10:00:00.000002+00"}];
  const f = fixture(rows); expect(await f.complete()).toBe("imported");
  expect(f.state.afterCreatedAt).toBe("2026-09-08 10:00:00.000001+00");
});
test.each(["oversized", "unpaired", "invalid JSON"])("rejects %s source without inventing a call ID", async failure => {
  const rows = [failure === "unpaired" ? row(1, "assistant") : {...row(1, "assistant", [call("first")]),
    ...(failure === "oversized" ? {oversized: true, toolCalls: null} : {toolCalls: "{"})}, row(2, "tool", null, "lookup")];
  const f = fixture(rows); expect(await f.complete()).toBeNull(); expect(f.state.phase).toBe("invalid");
});
