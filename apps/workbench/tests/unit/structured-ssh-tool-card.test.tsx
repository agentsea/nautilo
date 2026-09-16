import "../bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ServerEvent } from "@nautilo/types";
import type { ToolActivityEvent } from "../../src/adapters/runtime-contexts";
import { ToolActivityContext } from "../../src/adapters/runtime-contexts";
import { applyStructuredSshProgressEvent } from "../../src/adapters/nautilo-runtime";
import { ToolCard } from "../../src/components/tool-card/tool-card";

afterEach(cleanup);

function activity(overrides: Partial<ToolActivityEvent> = {}): ToolActivityEvent {
  return {
    toolCallId: "ssh-1",
    toolName: "structured_ssh_exec",
    args: { destination: "never render this", program: "uname", argv: ["-a"] },
    status: "running",
    startedAt: 1,
    ...overrides,
  };
}

function execProgress(overrides: Partial<Extract<ServerEvent, { type: "tool.structured_ssh.progress" }>> = {}) {
  return {
    type: "tool.structured_ssh.progress" as const,
    toolCallId: "ssh-1",
    version: 1 as const,
    sequence: 0,
    operation: "exec" as const,
    kind: "exec-output" as const,
    stream: "stdout" as const,
    offsetBytes: 0,
    endOffsetBytes: 3,
    text: "ok\n",
    elapsedMs: 1,
    phase: "running" as const,
    ...overrides,
  } as Extract<ServerEvent, { type: "tool.structured_ssh.progress" }>;
}

describe("D500 Structured SSH ToolCard", () => {
  test("accepts only exact ordered exec observations", () => {
    const first = applyStructuredSshProgressEvent(activity(), execProgress());
    expect(first?.structuredSshProgress).toMatchObject({
      operation: "exec",
      stdout: "ok\n",
      stdoutOffsetBytes: 3,
      lastSequence: 0,
    });
    expect(applyStructuredSshProgressEvent(first!, execProgress())).toBeNull();
    expect(applyStructuredSshProgressEvent(first!, execProgress({
      sequence: 2,
      offsetBytes: 3,
      endOffsetBytes: 8,
      text: "next\n",
    }))).toBeNull();
    expect(applyStructuredSshProgressEvent(first!, execProgress({ sequence: 1, offsetBytes: 4, endOffsetBytes: 7, text: "bad" }))).toBeNull();
    expect(applyStructuredSshProgressEvent(first!, execProgress({
      sequence: 1,
      operation: "copy-upload",
      kind: "transfer",
      phase: "starting",
      transferredBytes: 0,
    } as Extract<ServerEvent, { type: "tool.structured_ssh.progress" }>))).toBeNull();
    expect(applyStructuredSshProgressEvent(activity({ status: "ok" }), execProgress())).toBeNull();
  });

  test("accepts a dropped exec frame when its offset accounts for the omission", () => {
    const accepted = applyStructuredSshProgressEvent(activity(), execProgress({
      droppedBytes: 2,
      endOffsetBytes: 5,
    }));
    expect(accepted?.structuredSshProgress).toMatchObject({
      stdout: "ok\n",
      stdoutOffsetBytes: 5,
      droppedBytes: 2,
    });
  });

  test("requires a zero-byte start and a stable transfer total", () => {
    const copy = activity({ toolName: "structured_ssh_copy_upload" });
    const start = {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 0,
      operation: "copy-upload",
      kind: "transfer",
      phase: "starting",
      transferredBytes: 0,
      totalBytes: 10,
      elapsedMs: 5,
    } as const;
    expect(applyStructuredSshProgressEvent(copy, {
      ...start,
      phase: "transferring",
      transferredBytes: 4,
    })).toBeNull();
    const first = applyStructuredSshProgressEvent(copy, start);
    expect(first?.structuredSshProgress).toMatchObject({ transferredBytes: 0, totalBytes: 10 });
    expect(applyStructuredSshProgressEvent(first!, {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 1,
      operation: "copy-upload",
      kind: "transfer",
      phase: "transferring",
      transferredBytes: 4,
      totalBytes: 11,
      elapsedMs: 6,
    })).toBeNull();
    const advanced = applyStructuredSshProgressEvent(first!, {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 1,
      operation: "copy-upload",
      kind: "transfer",
      phase: "transferring",
      transferredBytes: 4,
      elapsedMs: 6,
    });
    expect(advanced?.structuredSshProgress).toMatchObject({ transferredBytes: 4, totalBytes: 10 });
    expect(applyStructuredSshProgressEvent(advanced!, {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 2,
      operation: "copy-upload",
      kind: "transfer",
      phase: "starting",
      transferredBytes: 4,
      totalBytes: 10,
      elapsedMs: 7,
    })).toBeNull();
  });

  test("shows a compact live card without connection machinery, and the final receipt replaces it", () => {
    const running = applyStructuredSshProgressEvent(activity(), execProgress({ droppedBytes: 2, endOffsetBytes: 5 }))!;
    const view = render(
      <ToolActivityContext.Provider value={[running]}>
        <ToolCard toolName="structured_ssh_exec" toolCallId="ssh-1" args={running.args} status={{ type: "running" }} />
      </ToolActivityContext.Provider>,
    );
    expect(view.getByRole("group", { name: /ssh.*running/i }).getAttribute("aria-expanded")).toBe("true");
    expect(view.getByLabelText("stdout").textContent).toContain("ok");
    expect(view.getByText(/Live observation was incomplete; final result is canonical/i)).toBeTruthy();
    expect(view.container.textContent).not.toContain("never render this");
    expect(view.container.textContent).not.toContain("argv");

    const complete = activity({
      status: "ok",
      endedAt: 10,
      result: JSON.stringify({ version: 1, operation: "exec", stdout: "canonical\n", stderr: "", exitCode: 0 }),
    });
    view.rerender(
      <ToolActivityContext.Provider value={[complete]}>
        <ToolCard toolName="structured_ssh_exec" toolCallId="ssh-1" args={complete.args} status={{ type: "complete" }} />
      </ToolActivityContext.Provider>,
    );
    expect(view.getByLabelText("stdout").textContent).toContain("canonical");
    expect(view.queryByText(/Live observation was incomplete/i)).toBeNull();
  });

  test("stays running when the graph leg completes while SSH awaits review", () => {
    const running = activity();
    const view = render(
      <ToolActivityContext.Provider value={[running]}>
        <ToolCard
          toolName="structured_ssh_exec"
          toolCallId="ssh-1"
          args={running.args}
          status={{ type: "complete" }}
        />
      </ToolActivityContext.Provider>,
    );

    expect(view.getByRole("group", { name: /ssh.*running/i })).toBeTruthy();
    expect(view.queryByText("Completed.")).toBeNull();
  });

  test("shows transfer phase and bounded bytes without paths or bindings", () => {
    const copyActivity = activity({ toolName: "structured_ssh_copy_download" });
    const started = applyStructuredSshProgressEvent(copyActivity, {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 0,
      operation: "copy-download",
      kind: "transfer",
      phase: "starting",
      transferredBytes: 0,
      totalBytes: 4_096,
      elapsedMs: 1,
    })!;
    const copy = applyStructuredSshProgressEvent(started, {
      type: "tool.structured_ssh.progress",
      toolCallId: "ssh-1",
      version: 1,
      sequence: 1,
      operation: "copy-download",
      kind: "transfer",
      phase: "transferring",
      transferredBytes: 2_048,
      totalBytes: 4_096,
      elapsedMs: 4,
    })!;
    const view = render(
      <ToolActivityContext.Provider value={[copy]}>
        <ToolCard toolName="structured_ssh_copy_download" toolCallId="ssh-1" args={copy.args} status={{ type: "running" }} />
      </ToolActivityContext.Provider>,
    );
    expect(view.getByText(/Transferring: 2.0 KiB of 4.0 KiB/i)).toBeTruthy();
    expect(view.container.textContent).not.toContain("never render this");
  });
});
