import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { taskRunTranscriptToPresentation, type TaskRunTranscriptMessage } from "@nautilo/types";
import { TranscriptRow } from "../../src/modes/rooms/subagents/SubagentTranscriptSurface";

const createdAt = "2026-09-08T00:00:00.000Z";
function project(toolStatus?: "success" | "error", content = "Recovery is active. New investigation has not executed.") {
  const rows: TaskRunTranscriptMessage[] = [
    { role: "assistant", content: "", toolName: null, createdAt, toolCalls: [{ id: toolStatus ? "file-read-1" : null, name: "file", args: { command: "read", path: "src/a.ts" } }] },
    { role: "tool", content, toolName: "file", toolCalls: null, createdAt, ...(toolStatus ? { toolCallId: "file-read-1", toolStatus } : {}) },
  ];
  return taskRunTranscriptToPresentation(rows)[0];
}
afterEach(cleanup);

test("blocked plain-text file results render the recorded failure, never a successful source card", () => {
  reapplyHappyDomGlobals();
  const view = render(<TranscriptRow message={project("error")} index={0} />);
  expect(view.container.textContent).toContain("New investigation has not executed");
  expect(view.container.querySelector('[aria-label*="errored"]')).toBeTruthy();
  expect(view.container.querySelector('[aria-label*="succeeded"]')).toBeNull();
  expect(view.container.querySelector(".cm-editor")).toBeNull();
  expect(view.container.querySelector('[aria-label="tool error"]')).toBeTruthy();
});

test("successful literal error text remains source; legacy rows never acquire success", async () => {
  reapplyHappyDomGlobals();
  const success = render(<TranscriptRow message={project("success", "Error: literal source text")} index={0} />);
  expect(success.container.querySelector('[aria-label*="succeeded"]')).toBeTruthy();
  await waitFor(() => expect(success.container.querySelector(".cm-editor")).toBeTruthy());
  success.unmount();
  const legacy = render(<TranscriptRow message={project(undefined)} index={0} />);
  expect(legacy.container.querySelector('[aria-label*="outcome unavailable"]')).toBeTruthy();
  expect(legacy.container.querySelector('[aria-label*="succeeded"]')).toBeNull();
  expect(legacy.container.querySelector(".cm-editor")).toBeNull();
  expect(legacy.container.querySelector('[aria-label="recorded tool output"]')).toBeTruthy();
});

test("validated pre-dispatch control failures show the correction and runtime facts without source or opaque handles", () => {
  reapplyHappyDomGlobals();
  const receipt = JSON.stringify({ ok: false, operation: "local_tool_control", toolName: "file", requestedOperation: "read", notDispatched: true,
    error: { code: "context_recovery_pending", message: "Save the useful notes and checkpoint before another page.", retryable: false },
    runtimeRecovery: { phase: "consolidation_required", pendingInputCount: 2, recoveredInputBytes: 4300,
      retainedUnconsolidatedPages: 3, asOfMessageIndex: 52, nextContextRef: "private-source-handle" } });
  const projected = project("error", receipt);
  expect(JSON.stringify(projected)).not.toContain("private-source-handle");
  const view = render(<TranscriptRow message={projected} index={0} />);
  expect(view.container.querySelector('[aria-label="Tool not executed"]')).toBeTruthy();
  expect(view.container.textContent).toContain("Save the useful notes and checkpoint");
  expect(view.container.textContent).toContain("2 historical inputs remain");
  expect(view.container.textContent).toContain("4300 historical input bytes recovered");
  expect(view.container.querySelector(".cm-editor")).toBeNull();
  expect(view.container.innerHTML).not.toContain("nextContextRef");
  view.unmount();
  // Even this exact receipt-shaped text is not failure authority on a successful file read.
  const source = render(<TranscriptRow message={project("success", receipt)} index={0} />);
  expect(source.container.querySelector('[aria-label="Tool not executed"]')).toBeNull();
  expect(source.container.querySelector('[aria-label*="succeeded"]')).toBeTruthy();
});


test("cancellation-shaped file bytes cannot replace a recorded or unknown outcome", () => {
  reapplyHappyDomGlobals();
  for (const status of ["success", undefined] as const) {
    const view = render(<TranscriptRow message={project(status, '{"cancelled":true}')} index={0} />);
    expect(view.container.querySelector(`[aria-label*="${status ? "succeeded" : "outcome unavailable"}"]`)).toBeTruthy();
    expect(view.container.querySelector('[aria-label*="cancelled"]')).toBeNull();
    view.unmount();
  }
});
