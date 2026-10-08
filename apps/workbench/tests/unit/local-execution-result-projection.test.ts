import { describe, expect, test } from "bun:test";
import { projectToolResultForEvent } from "@nautilo/types";
import { projectToolResultForCard } from "../../src/adapters/local-execution-result-projection";
import { restoreSessionMessages } from "../../src/adapters/session-rehydrate";
import { initialThreadRoomControllerState, threadRoomReducer } from "../../src/modes/rooms/thread-drawer/thread-room-controller";
import { preserveLocalExecutionResultForCard } from "../../src/components/tool-card/renderers/exec-command";

function receipt() {
  return { executionId: "execution-fixture", session_id: "execution-fixture", generation: "generation-fixture",
    state: "completed", tty: false, pid: null, exitCode: 7, signal: null,
    terminationScope: "owned_process_group", failureCode: null, expiresAt: null, resources: "released",
    output: { data: "diagnostic\n", cursor: 0, nextCursor: 11, availableFrom: 0, produced: 11, gap: false, hasMore: false } };
}

describe("managed receipt ingress projection", () => {
  test("closed search coordinates survive live and historical ingress without copying provider fields", () => {
    const value = { ...receipt(), output: { data: "nostic", cursor: 4, nextCursor: 10, availableFrom: 0, produced: 11, gap: false, hasMore: true },
      search: { matchedAt: 4, nextSearchCursor: 5, complete: false, gap: false, availableFrom: 0, produced: 11 } };
    for (const historical of [false, true]) {
      const expected = { ...value, ...(historical ? { historical: true } : {}) };
      const raw = JSON.stringify({ ...expected, providerToken: "private-fixture" });
      expect(JSON.parse(projectToolResultForCard("write_stdin", raw)!)).toEqual(expected);
      const messages = restoreSessionMessages([{ id: "search-message", role: "tool", toolName: "write_stdin", content: raw }]);
      const restored = messages[0]?.content[0] as { type: string; result: string };
      expect(restored.type).toBe("tool-call");
      expect(JSON.parse(restored.result)).toEqual(expected);
    }
    expect(preserveLocalExecutionResultForCard("write_stdin", JSON.stringify({ ...value, search: { ...value.search, secret: "private-fixture" } }))).toBeUndefined();
  });
  for (const toolName of ["exec_command", "write_stdin"]) {
    test(`${toolName} keeps numeric output cursors through history hydration`, () => {
      const value = receipt();
      const messages = restoreSessionMessages([{ id: "message-fixture", role: "tool", toolName, content: JSON.stringify(value) }]);
      expect(messages[0]?.content[0]).toMatchObject({ type: "tool-call", toolName, result: JSON.stringify(value) });
    });

    test(`${toolName} keeps numeric output cursors through the child Room event reducer`, () => {
      const state = threadRoomReducer(initialThreadRoomControllerState, { type: "open", roomId: "child-fixture", visible: true, connected: true });
      const started = threadRoomReducer(state, { type: "event.received", event: {
        type: "tool.start", laneKey: "room:child-fixture", toolCallId: "call-fixture", toolName, argsSummary: "{}" } });
      const projected = projectToolResultForEvent(toolName, JSON.stringify(receipt()));
      const ended = threadRoomReducer(started, { type: "event.received", event: {
        type: "tool.end", laneKey: "room:child-fixture", toolCallId: "call-fixture", toolName,
        status: "success", duration: 1, result: projected.result } });
      expect(ended.runtimeMessages[0]?.content[0]).toMatchObject({ type: "tool-call", result: JSON.stringify(receipt()) });
    });
  }

  test("preservation is exact-tool only and never copies unrelated provider fields", () => {
    const raw = JSON.stringify({ ...receipt(), providerToken: "private-provider-fixture", opaqueLocator: "private-locator-fixture" });
    expect(JSON.parse(projectToolResultForCard("exec_command", raw)!)).toEqual(receipt());
    expect(preserveLocalExecutionResultForCard("exec_command_extra", raw)).toBeUndefined();
    expect(preserveLocalExecutionResultForCard("run_shell", raw)).toBeUndefined();
    expect(projectToolResultForCard("other_tool", JSON.stringify({ token: "private-fixture", output: { cursor: 4, nextCursor: 8 }, text: "safe" })))
      .toBe(JSON.stringify({ output: {}, text: "safe" }, null, 2));
  });

  for (const invalid of [
    { output: { ...receipt().output, nextCursor: 12 } },
    { output: { ...receipt().output, cursor: "0" } },
    { resources: ["released"] },
    { session_id: "other-execution" },
  ]) {
    test(`malformed managed receipt stays on the generic redacted path: ${JSON.stringify(invalid)}`, () => {
      const raw = JSON.stringify({ ...receipt(), ...invalid });
      expect(preserveLocalExecutionResultForCard("write_stdin", raw)).toBeUndefined();
      const projected = JSON.parse(projectToolResultForCard("write_stdin", raw)!) as { output: Record<string, unknown> };
      expect(projected.output.cursor).toBeUndefined();
      expect(projected.output.nextCursor).toBeUndefined();
    });
  }

  test("validated uncertainty locator survives ingress but extra fields invalidate its closed grammar", () => {
    const value = { version: 1, kind: "local_execution_outcome_unknown", generation: "generation-fixture",
      executionId: "execution-fixture", session_id: "execution-fixture", operation: "start", outcome: "unknown",
      recovery: "read_or_cancel_same_execution", message: "Read or stop this same execution." };
    expect(projectToolResultForCard("exec_command", JSON.stringify(value))).toBe(JSON.stringify(value));
    expect(preserveLocalExecutionResultForCard("exec_command", JSON.stringify({ ...value, secret: "private-fixture" }))).toBeUndefined();
  });
});
