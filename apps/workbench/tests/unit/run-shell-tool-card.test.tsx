import "../bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolActivityEvent } from "../../src/adapters/runtime-contexts";
import { ToolActivityContext } from "../../src/adapters/runtime-contexts";
import { ToolCard } from "../../src/components/tool-card/tool-card";
import {
  applyRunShellProgressEvent,
  markRunShellOutcomeUnknown,
  markRunShellActivitiesDisconnected,
} from "../../src/adapters/nautilo-runtime";

afterEach(cleanup);

type ProgressEvent = ToolActivityEvent & {
  runShellContinuity?: "connected" | "disconnected" | "outcome_unknown";
  runShellContinuityChangedAt?: number;
  runShellProgress?: {
    stdout: string;
    stderr: string;
    stdoutOffsetBytes: number;
    stderrOffsetBytes: number;
    droppedBytes: number;
    phase: string;
    elapsedMs: number;
    lastSequence: number;
  };
};

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    toolCallId: "shell-1",
    toolName: "run_shell",
    args: { command: "bun test", cwd: "apps/workbench" },
    status: "running",
    startedAt: 1,
    runShellProgress: {
      stdout: "provisional output\n",
      stderr: "",
      stdoutOffsetBytes: 19,
      stderrOffsetBytes: 0,
      droppedBytes: 0,
      phase: "running",
      elapsedMs: 1200,
      lastSequence: 0,
    },
    ...overrides,
  };
}

function card(activity: ProgressEvent, status = "running") {
  return (
    <ToolActivityContext.Provider value={[activity]}>
      <ToolCard
        toolName="run_shell"
        toolCallId="shell-1"
        args={activity.args}
        status={{ type: status }}
      />
    </ToolActivityContext.Provider>
  );
}

describe("run_shell ToolCard (D502)", () => {
  test("projects a canonical cancelled receipt into the outer card state", () => {
    const cancelled = event({
      status: "ok",
      endedAt: 2500,
      result: JSON.stringify({
        stdout: "before stop\n",
        stderr: "",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        cancelled: true,
        durationMs: 2500,
        sideEffectsMayHaveStarted: true,
      }),
    });
    const view = render(
      <ToolActivityContext.Provider value={[cancelled]}>
        <ToolCard
          toolName="run_shell"
          toolCallId="shell-1"
          args={cancelled.args}
          status={{ type: "complete" }}
          stateOverride="success"
          defaultExpanded
        />
      </ToolActivityContext.Provider>,
    );

    const toolCard = view.getByRole("group", { name: /run_shell.*cancelled/i });
    expect(toolCard.getAttribute("data-tool-card-state")).toBe("cancelled");
    expect(view.getAllByText(/^cancelled$/i)).toHaveLength(2);
    expect(view.queryByText(/^succeeded$/i)).toBeNull();
  });

  test("opens only exact run_shell on start, keeps a manual collapse sticky, and replaces progress with the final receipt", () => {
    const running = event();
    const view = render(card(running));
    const toolCard = view.getByRole("group", { name: /run_shell.*running/i });

    expect(toolCard.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByLabelText("command").textContent).toBe("$ bun test");
    expect(view.getByLabelText("execution context").textContent).toContain("Current Folder / apps/workbench · sandboxed");
    expect(view.getByTestId("run-shell-stdout").textContent).toBe("provisional output\n");

    fireEvent.click(toolCard);
    expect(toolCard.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(view.getByRole("button", { name: /collapse run_shell/i }));
    expect(toolCard.getAttribute("aria-expanded")).toBe("false");

    view.rerender(card(event({
      runShellProgress: {
        stdout: "provisional output\nnext line\n",
        stderr: "",
        stdoutOffsetBytes: 29,
        stderrOffsetBytes: 0,
        droppedBytes: 4,
        phase: "building",
        elapsedMs: 2200,
        lastSequence: 1,
      },
    })));
    expect(toolCard.getAttribute("aria-expanded")).toBe("false");

    const completed = event({
      status: "ok",
      endedAt: 3000,
      result: JSON.stringify({
        stdout: "canonical stdout\n",
        stderr: "canonical stderr\n",
        exitCode: 1,
        durationMs: 3000,
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    });
    view.rerender(card(completed, "complete"));
    expect(toolCard.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(view.getByRole("button", { name: /expand run_shell/i }));
    expect(view.getByTestId("run-shell-stdout").textContent).toBe("canonical stdout\n");
    expect(view.getByTestId("run-shell-stderr").textContent).toBe("canonical stderr\n");
    expect(view.queryByText("provisional output")).toBeNull();
    expect(view.getByText("exit code:").textContent).toContain("1");
  });

  test("does not auto-open the run_command compatibility renderer", () => {
    const activity = event({ toolName: "run_command" });
    const view = render(
      <ToolActivityContext.Provider value={[activity]}>
        <ToolCard toolName="run_command" toolCallId="shell-1" args={activity.args} status={{ type: "running" }} />
      </ToolActivityContext.Provider>,
    );

    expect(view.getByRole("group", { name: /run_command.*running/i }).getAttribute("aria-expanded")).toBe("false");
  });

  test("auto-opens a completed run_shell card even when the running state was never rendered", () => {
    const completed = event({
      startedAt: Date.now(),
      status: "ok",
      endedAt: Date.now() + 5,
      result: JSON.stringify({
        stdout: "fast result\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      }),
    });
    const view = render(card(completed, "complete"));

    expect(view.getByRole("group", { name: /run_shell.*succeeded/i }).getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("run-shell-stdout").textContent).toBe("fast result\n");
  });

  test("uses keyed live run_shell args when the completed framework card drops its command", () => {
    const completed = event({
      startedAt: Date.now(),
      status: "ok",
      endedAt: Date.now() + 5,
      result: JSON.stringify({
        stdout: "large output\n",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      }),
    });
    const view = render(
      <ToolActivityContext.Provider value={[completed]}>
        <ToolCard
          toolName="run_shell"
          toolCallId="shell-1"
          args={{}}
          status={{ type: "complete" }}
        />
      </ToolActivityContext.Provider>,
    );

    expect(view.getByLabelText("command").textContent).toBe("$ bun test");
    expect(view.getByRole("group").getAttribute("aria-expanded")).toBe("true");
  });

  test("keeps historical completed run_shell cards collapsed after a UI reload", () => {
    const historical = event({
      startedAt: 1,
      status: "ok",
      endedAt: 5,
      result: JSON.stringify({
        stdout: "old result\n",
        stderr: "",
        exitCode: 0,
        durationMs: 4,
      }),
    });
    const view = render(card(historical, "complete"));

    expect(view.getByRole("group", { name: /run_shell.*succeeded/i }).getAttribute("aria-expanded")).toBe("false");
  });

  test("tail-follow stops after the Human scrolls away and resumes only after returning to the tail", () => {
    const view = render(card(event()));
    const output = view.getByTestId("run-shell-stdout") as HTMLPreElement;
    Object.defineProperties(output, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    output.scrollTop = 0;
    fireEvent.scroll(output);

    view.rerender(card(event({
      runShellProgress: {
        stdout: "provisional output\nnext\n",
        stderr: "",
        stdoutOffsetBytes: 24,
        stderrOffsetBytes: 0,
        droppedBytes: 0,
        phase: "running",
        elapsedMs: 2400,
        lastSequence: 1,
      },
    })));
    expect(output.scrollTop).toBe(0);

    output.scrollTop = 900;
    fireEvent.scroll(output);
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 1200 });
    view.rerender(card(event({
      runShellProgress: {
        stdout: "provisional output\nnext\nfinal\n",
        stderr: "",
        stdoutOffsetBytes: 30,
        stderrOffsetBytes: 0,
        droppedBytes: 0,
        phase: "running",
        elapsedMs: 3000,
        lastSequence: 2,
      },
    })));
    expect(output.scrollTop).toBe(1200);
  });

  test("shows lost continuity without inventing cancellation, then resumes on keyed progress", () => {
    const disconnected = event({
      runShellContinuity: "disconnected",
      runShellContinuityChangedAt: 2000,
    });
    const view = render(card(disconnected));
    const toolCard = view.getByRole("group", { name: /connection lost, command may still be running/i });

    expect(toolCard.getAttribute("data-run-shell-continuity")).toBe("disconnected");
    expect(view.getByLabelText("execution context").textContent).toContain(
      "disconnected · command may still be running",
    );
    expect(view.getByText(/waiting for progress or its final result/i)).toBeTruthy();
    expect(view.getByLabelText("stdout").textContent).toContain("stdout (last observed)");
    expect(view.queryByText(/^cancelled$/i)).toBeNull();

    view.rerender(card(event({
      runShellContinuity: "connected",
      runShellProgress: {
        stdout: "provisional output\nresumed\n",
        stderr: "",
        stdoutOffsetBytes: 27,
        stderrOffsetBytes: 0,
        droppedBytes: 0,
        phase: "running",
        elapsedMs: 3000,
        lastSequence: 1,
      },
    })));
    expect(toolCard.getAttribute("data-run-shell-continuity")).toBe("connected");
    expect(view.queryByText(/waiting for progress or its final result/i)).toBeNull();
    expect(view.getByLabelText("stdout").textContent).toContain("stdout (live)");
  });

  test("renders an explicit unknown outcome and lets a late canonical final receipt win", () => {
    const view = render(card(event({
      runShellContinuity: "outcome_unknown",
      runShellContinuityChangedAt: 2500,
    })));
    const toolCard = view.getByRole("group", { name: /command outcome unknown/i });
    expect(toolCard.getAttribute("data-run-shell-continuity")).toBe("outcome_unknown");
    expect(view.getByText(/No completion or cancellation is being assumed/i)).toBeTruthy();

    view.rerender(card(event({
      status: "ok",
      endedAt: 4000,
      result: JSON.stringify({
        stdout: "late canonical\n",
        stderr: "",
        exitCode: 0,
        durationMs: 4000,
      }),
    }), "complete"));
    expect(toolCard.getAttribute("data-run-shell-continuity")).toBeNull();
    expect(view.queryByText(/outcome unknown/i)).toBeNull();
    expect(view.getByTestId("run-shell-stdout").textContent).toBe("late canonical\n");
  });

  test("deduplicates and orders keyed progress while accounting for a reconnect gap", () => {
    const initial = event() as ToolActivityEvent;
    const first = applyRunShellProgressEvent(initial, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 1,
      stream: "stdout",
      offsetBytes: 19,
      endOffsetBytes: 24,
      text: "next\n",
      elapsedMs: 2000,
      phase: "running",
    });
    expect(first?.runShellProgress?.stdout).toBe("provisional output\nnext\n");

    expect(applyRunShellProgressEvent(first!, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 1,
      stream: "stdout",
      offsetBytes: 19,
      endOffsetBytes: 24,
      text: "duplicate",
      elapsedMs: 2100,
      phase: "running",
    })).toBeNull();

    // A gap while the websocket is still connected is not a reconnect gap;
    // accepting it would invent continuity in the visible transcript.
    expect(applyRunShellProgressEvent(first!, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 2,
      stream: "stdout",
      offsetBytes: 30,
      endOffsetBytes: 37,
      text: "forged\n",
      elapsedMs: 2200,
      phase: "running",
    })).toBeNull();

    expect(applyRunShellProgressEvent(first!, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 2,
      stream: "stdout",
      offsetBytes: 20,
      endOffsetBytes: 25,
      text: "late",
      elapsedMs: 2200,
      phase: "running",
    })).toBeNull();

    const resumed = applyRunShellProgressEvent({
      ...first!,
      runShellContinuity: "disconnected",
      runShellContinuityChangedAt: 2300,
    } as ToolActivityEvent, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 3,
      stream: "stdout",
      offsetBytes: 30,
      endOffsetBytes: 37,
      text: "resume\n",
      elapsedMs: 3000,
      phase: "running",
    });
    expect(resumed?.runShellProgress?.stdout).toBe("provisional output\nnext\nresume\n");
    expect(resumed?.runShellProgress?.droppedBytes).toBe(6);
    expect((resumed as ProgressEvent).runShellContinuity).toBe("connected");
  });

  test("freezes only the keyed running shell as outcome_unknown and ignores late progress", () => {
    const unknown = markRunShellOutcomeUnknown(event(), 2500);
    expect((unknown as ProgressEvent).runShellContinuity).toBe("outcome_unknown");
    expect(unknown.runShellProgress?.stdout).toBe("provisional output\n");
    expect(applyRunShellProgressEvent(unknown, {
      type: "tool.run_shell.progress",
      toolCallId: "shell-1",
      version: 1,
      sequence: 1,
      stream: "stdout",
      offsetBytes: 19,
      endOffsetBytes: 24,
      text: "late\n",
      elapsedMs: 2600,
      phase: "running",
    })).toBeNull();
    const other = markRunShellOutcomeUnknown(event({ toolName: "read_file" }), 2500);
    expect(other.runShellContinuity).toBeUndefined();
  });

  test("marks only exact running run_shell activities disconnected", () => {
    const shell = event();
    const other = event({ toolCallId: "command-1", toolName: "run_command" });
    const completed = event({ toolCallId: "shell-2", status: "ok", endedAt: 10 });
    const next = markRunShellActivitiesDisconnected(
      [shell, other, completed],
      5000,
    ) as ProgressEvent[];

    expect(next[0]?.runShellContinuity).toBe("disconnected");
    expect(next[0]?.runShellContinuityChangedAt).toBe(5000);
    expect(next[1]).toBe(other);
    expect(next[2]).toBe(completed);
  });

  test("shows retained-output availability and renders continuation retrieval as an intentional operation", () => {
    const expiresAt = "2026-08-06T12:00:00.000Z";
    const completed = event({
      startedAt: Date.now(),
      status: "ok",
      endedAt: Date.now() + 3000,
      result: JSON.stringify({
        stdout: "bounded head and tail\n",
        stderr: "",
        exitCode: 0,
        durationMs: 3000,
        stdoutTruncated: true,
        stderrTruncated: false,
        outputArtifact: {
          version: 1,
          reference: "a".repeat(43),
          expiresAt,
          capturedBytes: 32768,
          totalBytes: 65536,
          truncated: true,
        },
      }),
    });
    const view = render(card(completed, "complete"));
    expect(view.getByRole("group").getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("status").textContent).toContain("Retained capture is partial: capture limit reached; 32.0 KiB of 64.0 KiB sanitized output retained");
    expect(view.getByRole("status").textContent).toContain(expiresAt);

    const retrieval = event({
      args: { output_artifact: { reference: "a".repeat(43), offset_bytes: 0 } },
      status: "ok",
      endedAt: 4000,
      result: JSON.stringify({
        version: 1,
        reference: "a".repeat(43),
        stdout: "continued output\n",
        stderr: "",
        offsetBytes: 0,
        nextOffsetBytes: null,
        capturedBytes: 17,
        totalBytes: 17,
        truncated: false,
        expiresAt,
        deleted: true,
      }),
    });
    view.rerender(card(retrieval, "complete"));
    expect(view.getByLabelText("command").textContent).toContain("Retrieve retained shell output");
    expect(view.getByLabelText("execution context").textContent).toContain("Desktop-local continuation");
    expect(view.getByRole("status").textContent).toContain("Final page; continuation deleted");
  });

  test("renders a bounded stderr search continuation with stream and artifact offsets, without retrieval controls", () => {
    const expiresAt = "2026-08-07T12:00:00.000Z";
    const search = event({
      startedAt: Date.now(),
      args: {
        output_artifact: {
          reference: "a".repeat(43),
          operation: "search",
          query: "FAIL",
        },
      },
      status: "ok",
      endedAt: Date.now() + 5,
      result: JSON.stringify({
        version: 1,
        operation: "search",
        reference: "a".repeat(43),
        matches: [{
          stream: "stderr",
          matchOffsetBytes: 8,
          artifactOffsetBytes: 72,
          matchBytes: 4,
          contextOffsetBytes: 0,
          context: "warning\nFAIL named test\n",
        }],
        totalMatches: 1,
        matchesTruncated: false,
        capturedBytes: 128,
        totalBytes: 128,
        truncated: false,
        expiresAt,
      }),
    });
    const view = render(card(search, "complete"));

    expect(view.getByRole("group").getAttribute("aria-expanded")).toBe("true");

    expect(view.getByLabelText("command").textContent).toContain("Search retained shell output");
    expect(view.getByLabelText("execution context").textContent).toContain("Desktop-local continuation");
    expect(view.getByRole("status").textContent).toContain("Literal search returned 1 of 1 match");
    expect(view.getByRole("status").textContent).toContain("Retained capture is complete: 128 bytes available after redaction and UTF-8 normalization");
    expect(view.getByLabelText("stderr search match 1").textContent).toContain("stream match at byte 8");
    expect(view.getByLabelText("stderr search match 1").textContent).toContain("artifact byte 72");
    expect(view.getByLabelText("stderr search match 1").textContent).toContain("FAIL named test");
    expect(view.queryByRole("button", { name: /retrieve|search retained/i })).toBeNull();
  });
});
