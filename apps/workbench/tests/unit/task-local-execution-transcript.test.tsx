import "../bun-dom-preload.ts";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { TaskRunTranscriptMessage } from "@nautilo/types";
import { taskRunToVMs } from "../../src/modes/rooms/subagents/transcript-vm";
import { TranscriptRow } from "../../src/modes/rooms/subagents/VirtualTranscriptRows";
import { ToolActivityContext } from "../../src/adapters/runtime-contexts";
import type { LocalExecutionSnapshot } from "../../src/lib/desktop";

afterEach(() => { cleanup(); delete (window as unknown as { nautiloDesktop?: unknown }).nautiloDesktop; });
function receipt(state: LocalExecutionSnapshot["state"], data = "BACKGROUND_LOCAL_OK 多字节😀\n"): LocalExecutionSnapshot {
  const end = new TextEncoder().encode(data).byteLength;
  return { executionId: "task-receipt-reference", session_id: "task-receipt-reference", generation: "task-native-generation",
    state, tty: false, pid: 42, exitCode: state === "completed" ? 7 : null, signal: state === "cancelled" ? "SIGKILL" : null,
    terminationScope: "owned_process_group", failureCode: state === "failed" ? "LOCAL_EXECUTION_START_FAILED" : null,
    expiresAt: null, resources: state === "running" ? "owned" : "released",
    output: { data, cursor: 0, nextCursor: end, availableFrom: 0, produced: end, gap: false, hasMore: false } };
}
function transcript(toolName: "exec_command" | "write_stdin", result: string): TaskRunTranscriptMessage[] {
  const createdAt = "2026-10-08T12:00:00.000Z";
  return [{ role: "assistant", content: "", toolName: null, createdAt,
    toolCalls: [{ name: toolName, id: "task-tool-call", args: toolName === "exec_command"
      ? { cmd: "python3 synthetic-fixture.py" } : { session_id: "task-receipt-reference" } }] },
  { role: "tool", toolName, content: result, toolCallId: "task-tool-call", toolStatus: "success", createdAt, toolCalls: null }];
}
for (const toolName of ["exec_command", "write_stdin"] as const) {
  for (const state of ["running", "completed", "cancelled", "failed"] as const) {
    test(`${toolName} Task DTO renders ${state} execution truth and output through the real transcript card`, async () => {
      const original = receipt(state, "BACKGROUND_LOCAL_OK 多字节😀\n".repeat(200));
      const [message] = taskRunToVMs(transcript(toolName, JSON.stringify(original)));
      if (!message) throw new Error("Missing Task tool card");
      const view = render(<TranscriptRow message={message} index={0} expanded />);
      await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe(state));
      expect(view.getByTestId("exec-output").textContent).toBe(original.output.data);
      const expectedState = state === "running" ? "running" : state === "cancelled" ? "cancelled" : "error";
      await waitFor(() => expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe(expectedState));
      expect(view.container.textContent).not.toContain("receipt is unavailable or invalid");
      expect(view.container.textContent).not.toContain(original.executionId);
      expect(view.container.textContent).not.toContain(original.generation);
      if (state === "completed") expect(view.container.textContent).toContain("exit code 7");
    });
  }
}
test("successful Task command renders its confirmed zero exit without a blocked receipt", async () => {
  const original = { ...receipt("completed"), exitCode: 0 };
  const [message] = taskRunToVMs(transcript("exec_command", JSON.stringify(original)));
  if (!message) throw new Error("Missing Task tool card");
  const view = render(<TranscriptRow message={message} index={0} expanded />);
  await waitFor(() => expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("success"));
  expect(view.getByTestId("exec-process-state").textContent).toBe("completed");
  expect(view.getByTestId("exec-output").textContent).toBe(original.output.data);
  expect(view.container.textContent).not.toContain("receipt is unavailable or invalid");
});
test("invalid Task command receipt stays unconfirmed and creates no native controls", async () => {
  const [message] = taskRunToVMs(transcript("exec_command", JSON.stringify({ ...receipt("completed"),
    output: { ...receipt("completed").output, nextCursor: 1 }, injected: { token: "private-credential" } })));
  if (!message) throw new Error("Missing Task tool card");
  const view = render(<TranscriptRow message={message} index={0} expanded />);
  await waitFor(() => expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("blocked"));
  expect(view.queryByTestId("exec-process-state")).toBeNull();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.container.textContent).not.toContain("private-credential");
});
test("schema-valid credential output keeps Task redaction and cannot fabricate a valid byte page", async () => {
  const [message] = taskRunToVMs(transcript("exec_command", JSON.stringify(receipt("completed", "Bearer\tabcdefghijklmnopqrstuvwxyz"))));
  if (!message) throw new Error("Missing Task tool card");
  const view = render(<TranscriptRow message={message} index={0} expanded />);
  await waitFor(() => expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("blocked"));
  expect(view.container.textContent).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(view.queryByTestId("exec-process-state")).toBeNull();
});

for (const toolName of ["exec_command", "write_stdin"] as const) {
  test(`${toolName} without a durable result is neutral pending despite unrelated live activity`, () => {
    const [message] = taskRunToVMs(transcript(toolName, "").slice(0, 1));
    if (!message) throw new Error("Missing Task tool card");
    expect(message.toolCallId).toBe("task-tool-call");
    const view = render(<ToolActivityContext.Provider value={[{
      toolCallId: "task-tool-call", toolName, args: {}, status: "ok", startedAt: 0,
      result: JSON.stringify(receipt("completed")),
    }]}><TranscriptRow message={message} index={0} expanded /></ToolActivityContext.Provider>);
    expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("pending");
    expect(view.queryByTestId("exec-process-state")).toBeNull();
    expect(view.queryByTestId("exec-output")).toBeNull();
    expect(view.queryByTestId("exec-receipt-unavailable")).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("button", { name: "Refresh status/output" })).toBeNull();
    expect(view.container.textContent).not.toContain("Outcome unconfirmed");
    expect(view.container.textContent).not.toContain("Awaiting approval");
    expect(view.container.textContent).not.toContain("BACKGROUND_LOCAL_OK");
  });
}

test("a recorded empty result remains an invalid receipt rather than becoming pending", () => {
  const [message] = taskRunToVMs(transcript("exec_command", ""));
  if (!message) throw new Error("Missing Task tool card");
  const view = render(<TranscriptRow message={message} index={0} expanded />);
  expect(view.container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("blocked");
});
