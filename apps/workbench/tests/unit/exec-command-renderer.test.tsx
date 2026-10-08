import "../bun-dom-preload.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { projectToolResultForEvent } from "@nautilo/types";
import type { DesktopLocalExecutionAPI, LocalExecutionSnapshot } from "../../src/lib/desktop";
import { ToolCard } from "../../src/components/tool-card/tool-card";
import { projectToolResultForCard } from "../../src/adapters/local-execution-result-projection";
import { HarnessActivityFeed } from "../../src/modes/rooms/subagents/HarnessActivityFeed";
import { clearLocalExecutionHistoryOverlays, publishLocalExecutionHistoryOverlay } from "../../src/lib/local-execution-observation";

afterEach(() => {
  cleanup();
  delete (window as unknown as { nautiloDesktop?: unknown }).nautiloDesktop;
});

function snapshot(overrides: Partial<LocalExecutionSnapshot> = {}): LocalExecutionSnapshot {
  return {
    executionId: "exec-1",
    session_id: "exec-1",
    generation: "generation-1",
    state: "running",
    tty: false,
    pid: 42,
    exitCode: null,
    signal: null,
    terminationScope: "owned_process_group",
    output: {
      data: "first line\n",
      cursor: 0,
      nextCursor: 11,
      availableFrom: 0,
      produced: 11,
      gap: false,
      hasMore: false,
    },
    failureCode: null,
    expiresAt: null,
    resources: "owned",
    ...overrides,
  };
}

function result(value: LocalExecutionSnapshot): string {
  return JSON.stringify(value);
}

function unknownEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: "local_execution_outcome_unknown",
    generation: "generation-1",
    executionId: "exec-1",
    session_id: "exec-1",
    operation: "start",
    outcome: "unknown",
    recovery: "read_or_cancel_same_execution",
    message: "The command may have started; recover its existing execution.",
    ...overrides,
  });
}

function card(toolName: "exec_command" | "write_stdin", value: LocalExecutionSnapshot | null, args: Record<string, unknown> = {}, transportCancelled = false) {
  return <ToolCard
    toolName={toolName}
    toolCallId="call-1"
    args={{ cmd: "bun run dev", ...args }}
    {...(value ? { result: transportCancelled ? JSON.stringify({ ...value, cancelled: true }) : result(value) } : {})}
    status={{ type: "complete" }}
    defaultExpanded
  />;
}

function installBridge(localExecution: {
  read: ReturnType<typeof mock>;
  cancel: ReturnType<typeof mock>;
  openPreview: ReturnType<typeof mock>;
  onChanged?: DesktopLocalExecutionAPI["onChanged"];
}) {
  (window as unknown as { nautiloDesktop: unknown }).nautiloDesktop = { localExecution };
  return localExecution;
}

describe("unified local execution ToolCard renderer", () => {
  test("empty historical search and read pages never display a reversed saved-byte range", () => {
    const empty = snapshot({ state: "completed", exitCode: 0, resources: "released", historical: true,
      output: { data: "", cursor: 85051, nextCursor: 85051, availableFrom: 0, produced: 85051, gap: false, hasMore: false } });
    const miss = { ...empty, search: { matchedAt: null, nextSearchCursor: 85051, complete: true, gap: false, availableFrom: 0, produced: 85051 } };
    const view = render(card("write_stdin", miss, { search: "not present" }));
    expect(view.getByTestId("exec-search-result").textContent).toBe("No match in the retained output searched.");
    expect(view.getByText("Search finished through byte 85051.")).not.toBeNull();
    expect(view.queryByTestId("exec-saved-output-range")).toBeNull();
    expect(view.queryByTestId("exec-output")).toBeNull();
    view.rerender(card("write_stdin", empty));
    expect(view.getByTestId("exec-process-state").textContent).toBe("completed");
    expect(view.queryByTestId("exec-saved-output-range")).toBeNull();
    expect(view.queryByTestId("exec-search-result")).toBeNull();
  });
  test("leading BOM output survives search status reconstruction without changing byte cursors", async () => {
    const full = snapshot({ output: { data: "\ufeffabc", cursor: 0, nextCursor: 6, availableFrom: 0, produced: 6, gap: false, hasMore: false } });
    const match = { ...full, search: { matchedAt: 0, nextSearchCursor: 3, complete: false, gap: false, availableFrom: 0, produced: 6 } };
    const read = mock(async () => full);
    installBridge({ read, cancel: mock(async () => full), openPreview: mock(async () => undefined) });
    const view = render(card("write_stdin", match, { search: "\ufeff" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("exec-output").textContent).toBe("\ufeffabc");
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    await waitFor(() => expect(read).toHaveBeenLastCalledWith({ generation: match.generation, executionId: match.executionId, cursor: 6, maxBytes: Number.MAX_SAFE_INTEGER }));
    expect(view.getByTestId("exec-output").textContent).toBe("\ufeffabc");
  });
  test("browser follow-up searches settle the earlier card while retaining each card's own output", async () => {
    const initial = snapshot();
    const completed = snapshot({ state: "completed", exitCode: 7, resources: "released",
      output: { data: "match", cursor: 20, nextCursor: 25, availableFrom: 0, produced: 25, gap: false, hasMore: false },
      search: { matchedAt: 20, nextSearchCursor: 21, complete: false, gap: false, availableFrom: 0, produced: 25 } });
    const start = <ToolCard toolName="exec_command" toolCallId="browser-start" args={{ cmd: "build" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />;
    const view = render(start);
    view.rerender(<>{start}<ToolCard toolName="write_stdin" toolCallId="browser-search" args={{ search: "match" }} result={result(completed)} status={{ type: "complete" }} defaultExpanded /></>);
    await waitFor(() => expect(view.getAllByRole("group").map(node => node.getAttribute("data-tool-card-state"))).toEqual(["error", "error"]));
    expect(view.getAllByTestId("exec-output").map(node => node.textContent)).toEqual([initial.output.data, "match"]);
    expect(view.getByTestId("exec-output-unread").textContent).toBe("14 output bytes after this page are not shown.");
  });

  test("browser final search trims earlier card loss without copying match bytes", async () => {
    const initial = snapshot({ output: { data: "α\ufeffβ", cursor: 0, nextCursor: 7, availableFrom: 0, produced: 7, gap: false, hasMore: false } });
    const completed = snapshot({ state: "completed", exitCode: 0, resources: "released",
      output: { data: "tail", cursor: 10, nextCursor: 14, availableFrom: 2, produced: 14, gap: false, hasMore: false },
      search: { matchedAt: 10, nextSearchCursor: 11, complete: false, gap: true, availableFrom: 2, produced: 14 } });
    const start = <ToolCard toolName="exec_command" toolCallId="browser-loss-start" args={{ cmd: "build" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />;
    const view = render(start);
    view.rerender(<>{start}<ToolCard toolName="write_stdin" toolCallId="browser-loss-search" args={{ search: "tail" }} result={result(completed)} status={{ type: "complete" }} defaultExpanded /></>);
    await waitFor(() => expect(view.getAllByRole("group").map(node => node.getAttribute("data-tool-card-state"))).toEqual(["success", "success"]));
    expect(view.getAllByTestId("exec-output").map(node => node.textContent)).toEqual(["\ufeffβ", "tail"]);
    expect(view.getByText("Some output before this cursor is no longer retained.")).not.toBeNull();
    expect(view.getByTestId("exec-output-unread").textContent).toBe("7 output bytes after this page are not shown.");
  });
  test("search match cards keep their page while shared status settles and ordinary cards keep full output", async () => {
    const full = snapshot({ output: { data: "before match after", cursor: 0, nextCursor: 18, availableFrom: 0, produced: 18, gap: false, hasMore: false } });
    const match = snapshot({ output: { data: "match", cursor: 7, nextCursor: 12, availableFrom: 0, produced: 18, gap: false, hasMore: true },
      search: { matchedAt: 7, nextSearchCursor: 8, complete: false, gap: false, availableFrom: 0, produced: 18 } });
    const read = mock(async () => full);
    installBridge({ read, cancel: mock(async () => full), openPreview: mock(async () => undefined) });
    const start = <ToolCard toolName="exec_command" toolCallId="search-start" args={{ cmd: "build" }} result={result(full)} status={{ type: "complete" }} defaultExpanded />;
    const search = <ToolCard toolName="write_stdin" toolCallId="search-match" args={{ search: "match" }} result={result(match)} status={{ type: "complete" }} defaultExpanded />;
    const view = render(<>{start}{search}</>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getAllByTestId("exec-output").map(node => node.textContent)).toEqual([full.output.data, "match"]);
    expect(view.getByTestId("exec-search-result").textContent).toBe("Match at byte 7.");
    expect(view.getByText("Search observed through byte 18. Continue this search from byte 8.")).not.toBeNull();
    fireEvent.click(view.getAllByRole("button", { name: "Load more output" })[0]);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith({ generation: match.generation, executionId: match.executionId, cursor: 12, maxBytes: Number.MAX_SAFE_INTEGER }));
    const completed = { ...full, state: "completed" as const, exitCode: 7, resources: "released" as const };
    view.rerender(<>{start}{search}<ToolCard toolName="write_stdin" toolCallId="search-complete" args={{}} result={result(completed)} status={{ type: "complete" }} defaultExpanded /></>);
    await waitFor(() => expect(view.getAllByRole("group").map(node => node.getAttribute("data-tool-card-state"))).toEqual(["error", "error", "error"]));
    // Manual context paging may extend the match; the shared final page must
    // never prepend the unrelated prefix before its byte coordinate.
    expect(view.getAllByTestId("exec-output")[1].textContent).toBe("match after");
  });

  test("automatic window eviction trims a search page without replacing it or reviving evicted bytes", async () => {
    let notify: ((event: { generation: string | null }) => void) | undefined;
    const full = snapshot({ output: { data: "α😀βγ", cursor: 0, nextCursor: 10, availableFrom: 0, produced: 10, gap: false, hasMore: false } });
    const match = { ...full, output: { ...full.output, data: "😀β", cursor: 2, nextCursor: 8, hasMore: true },
      search: { matchedAt: 2, nextSearchCursor: 6, complete: false, gap: false, availableFrom: 0, produced: 10 } };
    const read = mock(async () => full);
    installBridge({ read, cancel: mock(async () => full), openPreview: mock(async () => undefined),
      onChanged: callback => { notify = callback; return () => { notify = undefined; }; } });
    const view = render(card("write_stdin", match, { search: "😀" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("exec-output").textContent).toBe("😀β");
    const window = { ...full, output: { data: "βγ", cursor: 6, nextCursor: 10, availableFrom: 6, produced: 10, gap: true, hasMore: false } };
    read.mockImplementation(async () => window);
    await act(async () => { notify?.({ generation: full.generation }); });
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("β"));
    expect(view.getByText("Some output before this cursor is no longer retained.")).not.toBeNull();
    expect(view.getByTestId("exec-search-result").textContent).toBe("Match at byte 2.");
  });

  test("pending and saved settled misses disclose search completeness and loss independently of process success", () => {
    const pending = snapshot({ output: { data: "", cursor: 100, nextCursor: 100, availableFrom: 90, produced: 100, gap: false, hasMore: false },
      search: { matchedAt: null, nextSearchCursor: 97, complete: false, gap: true, availableFrom: 90, produced: 100 } });
    const view = render(card("write_stdin", pending, { search: "needle" }));
    expect(view.getByTestId("exec-search-result").textContent).toBe("No match in the output searched so far. Search is incomplete.");
    expect(view.getByText("Earlier output was discarded and was not searched.")).not.toBeNull();
    const saved = { ...pending, state: "completed" as const, exitCode: 7, resources: "released" as const, historical: true as const,
      search: { ...pending.search, nextSearchCursor: 100, complete: true } };
    view.rerender(card("write_stdin", saved, { search: "needle" }));
    expect(view.getByTestId("exec-search-result").textContent).toBe("No match in the retained output searched.");
    expect(view.getByText("Search finished through byte 100.")).not.toBeNull();
    expect(view.queryByText(/Continue this search/)).toBeNull();
    expect(view.getByTestId("exec-exit-code").textContent).toBe("7");
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });
  test("a follow-up receipt settles an earlier collapsed card for the same execution", async () => {
    const initial = snapshot();
    const completed = snapshot({ state: "completed", exitCode: 0, resources: "released" });
    const view = render(<>
      <ToolCard toolName="exec_command" toolCallId="start-shared" args={{ cmd: "build" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />
    </>);
    const first = view.getByRole("group");
    fireEvent.click(view.getByRole("button", { name: /Collapse/ }));
    expect(first.getAttribute("aria-expanded")).toBe("false");
    view.rerender(<>
      <ToolCard toolName="exec_command" toolCallId="start-shared" args={{ cmd: "build" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />
      <ToolCard toolName="write_stdin" toolCallId="follow-shared" args={{ session_id: initial.executionId }} result={result(completed)} status={{ type: "complete" }} defaultExpanded />
    </>);
    await waitFor(() => expect(view.getAllByRole("group").map((group) => group.getAttribute("data-tool-card-state"))).toEqual(["success", "success"]));
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  test("another card's final receipt survives a later manual-read failure", async () => {
    const initial = snapshot();
    let rejectRead!: (error: Error) => void;
    const read = mock(async () => initial);
    installBridge({ read, cancel: mock(async () => initial), openPreview: mock(async () => undefined) });
    const first = <ToolCard toolName="exec_command" toolCallId="read-race-start" args={{ cmd: "build" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />;
    const view = render(<>{first}</>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    const completed = snapshot({ state: "completed", exitCode: 0, resources: "released" });
    view.rerender(<>{first}<ToolCard toolName="write_stdin" toolCallId="read-race-follow" args={{}} result={result(completed)} status={{ type: "complete" }} defaultExpanded /></>);
    await waitFor(() => expect(view.getAllByRole("group").map((group) => group.getAttribute("data-tool-card-state"))).toEqual(["success", "success"]));
    await act(async () => { rejectRead(new Error("Old request lost")); });
    expect(view.getAllByRole("group").map((group) => group.getAttribute("data-tool-card-state"))).toEqual(["success", "success"]);
    expect(view.queryByText("Outcome unconfirmed") === null).toBe(true);
  });

  test("colored Vite URLs open a preview while reads retain the original byte cursor", async () => {
    const data = "Local: http://127.0.0.1:\u001b[1m4321\u001b[22m/\u001b[39m\n";
    const bytes = new TextEncoder().encode(data).byteLength;
    const value = snapshot({ output: { data, cursor: 0, nextCursor: bytes, availableFrom: 0, produced: bytes, gap: false, hasMore: false } });
    const read = mock(async () => value);
    const openPreview = mock(async () => undefined);
    installBridge({ read, cancel: mock(async () => value), openPreview });
    const view = render(card("exec_command", value));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith({ generation: value.generation, executionId: value.executionId, cursor: bytes, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(view.getByTestId("exec-output").textContent).toBe("Local: http://127.0.0.1:4321/\n");
    fireEvent.click(view.getByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(openPreview).toHaveBeenCalledWith({ generation: value.generation, executionId: value.executionId, url: "http://127.0.0.1:4321/" }));
  });

  test("automatic host windows replace noisy output, preserve Unicode boundaries, and resist old receipts", async () => {
    let notify: ((event: { generation: string | null }) => void) | undefined;
    const windowAt = (data: string, cursor: number) => snapshot({ output: { data, cursor,
      nextCursor: cursor + new TextEncoder().encode(data).byteLength, availableFrom: cursor,
      produced: cursor + new TextEncoder().encode(data).byteLength, gap: cursor > 0, hasMore: false } });
    const initial = windowAt("α😀", 0);
    let current = initial;
    const read = mock(async () => current);
    installBridge({ read, cancel: mock(async () => current), openPreview: mock(async () => undefined),
      onChanged: (listener) => { notify = listener; return () => { notify = undefined; }; } });
    const first = <ToolCard toolName="exec_command" toolCallId="retained-start" args={{ cmd: "noisy" }} result={result(initial)} status={{ type: "complete" }} defaultExpanded />;
    const view = render(<>{first}</>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    for (const value of [windowAt("😀β", 2), windowAt("βγ", 6)]) {
      current = value;
      await act(async () => { notify?.({ generation: current.generation }); });
      await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe(value.output.data));
      expect(read).toHaveBeenLastCalledWith({ generation: current.generation, executionId: current.executionId, cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    }
    expect(view.getByText("Some output before this cursor is no longer retained.")).toBeTruthy();
    view.rerender(<>{first}<ToolCard toolName="write_stdin" toolCallId="old-retained" args={{}} result={result(initial)} status={{ type: "complete" }} defaultExpanded /></>);
    await waitFor(() => expect(view.getAllByTestId("exec-output").map((node) => node.textContent)).toEqual(["βγ", "βγ"]));
    expect(view.queryByText("α😀") === null).toBe(true);
  });

  test("Stop observes actual cleanup settlement without another click or mutation", async () => {
    let notify: ((event: { generation: string | null }) => void) | undefined;
    let current = snapshot();
    const read = mock(async (request: { cursor: number }) => ({ ...current, output: {
      ...current.output, data: "", cursor: request.cursor, nextCursor: request.cursor,
    } }));
    const cancel = mock(async () => { current = snapshot({ state: "cancelling" }); return current; });
    const unsubscribe = mock(() => { notify = undefined; });
    installBridge({ read, cancel, openPreview: mock(async () => undefined),
      onChanged: (listener) => { notify = listener; return unsubscribe; } });
    const view = render(card("exec_command", snapshot()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("cancelling"));
    current = snapshot({ state: "cancelled", signal: "SIGTERM", resources: "released" });
    await act(async () => { notify?.({ generation: current.generation }); });
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled"));
    expect(view.queryByRole("button", { name: "Stop" }) === null).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    for (const processState of ["running", "completed", "failed"] as const) {
      test(`preserves ${toolName} ${processState} receipt through live event projection`, async () => {
        const value = snapshot({ state: processState,
          exitCode: processState === "completed" ? 7 : null,
          failureCode: processState === "failed" ? "LOCAL_EXECUTION_START_FAILED" : null,
          resources: processState === "running" ? "owned" : "released" });
        const read = mock(async () => value);
        installBridge({ read, cancel: mock(async () => value), openPreview: mock(async () => undefined) });
        const eventProjection = projectToolResultForEvent(toolName, JSON.stringify(value));
        const view = render(<ToolCard toolName={toolName} toolCallId="live-call"
          args={toolName === "exec_command" ? { cmd: "sh ./slow-build.sh" } : { session_id: value.executionId }}
          status={{ type: "complete" }} defaultExpanded
          activityOverride={{ toolCallId: "live-call", toolName, args: {}, status: "ok", startedAt: 1, endedAt: 2,
            result: projectToolResultForCard(toolName, eventProjection.result) }} />);
        expect(view.getByTestId("exec-process-state").textContent).toBe(processState);
        expect(view.getByTestId("exec-output").textContent).toBe("first line\n");
        expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe(processState === "running" ? "running" : "error");
        expect(view.getByRole("button", { name: "Refresh status and output" })).toBeTruthy();
        if (processState === "running") {
          await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
          expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
        } else expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
        expect(view.container.textContent).not.toContain(value.executionId);
        expect(view.container.textContent).not.toContain(value.generation);
      });
    }
  }

  test("Harness activity keeps managed process truth and output instead of transport success", () => {
    const value = snapshot({ state: "completed", exitCode: 7, resources: "released" });
    const view = render(<HarnessActivityFeed activity={[{ id: "harness-fixture", kind: "tool", name: "write_stdin",
      status: "completed", args: { session_id: value.executionId }, result: JSON.stringify(value), startedAt: 1, endedAt: 2 }]} />);
    expect(view.getByTestId("exec-process-state").textContent).toBe("completed");
    expect(view.getByTestId("exec-exit-code").textContent).toBe("7");
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error");
    expect(view.container.textContent).not.toContain(value.executionId);
  });

  for (const resultText of [undefined, "Done (1ms)", '{"executionId":"invalid-reference","state":"completed"}', '{"executionId":"invalid-reference"']) {
    test(`does not equate successful delivery with a process result without a valid receipt: ${resultText}`, () => {
      installBridge({ read: mock(async () => snapshot()), cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
      const view = render(<ToolCard toolName="exec_command" toolCallId="invalid-call" args={{ cmd: "sh ./slow-build.sh" }}
        status={{ type: "complete" }} defaultExpanded result={resultText}
        activityOverride={{ toolCallId: "invalid-call", toolName: "exec_command", args: {}, status: "ok", startedAt: 1, endedAt: 2,
          result: projectToolResultForCard("exec_command", resultText), resultTruncated: true }} />);
      expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
      expect(view.getByTestId("exec-receipt-unavailable").textContent).toContain("Outcome unconfirmed");
      expect(view.getByTestId("exec-receipt-unavailable").textContent).toContain("truncated");
      expect(view.queryByTestId("exec-process-state")).toBeNull();
      expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
      expect(view.queryByRole("button", { name: "Refresh status and output" })).toBeNull();
      expect(view.container.textContent).not.toContain("invalid-reference");
    });
  }

  test("a complete structurally projected snapshot still carries process truth when output was shortened", () => {
    const value = snapshot({ state: "completed", exitCode: 7, resources: "released", output: {
      data: "first line\n", cursor: 0, nextCursor: 11, availableFrom: 0, produced: 20, gap: false, hasMore: true } });
    const view = render(<ToolCard toolName="write_stdin" toolCallId="projected-call" args={{ session_id: value.executionId }}
      status={{ type: "complete" }} defaultExpanded activityOverride={{ toolCallId: "projected-call", toolName: "write_stdin",
        args: {}, status: "ok", startedAt: 1, endedAt: 2, result: projectToolResultForCard("write_stdin", JSON.stringify(value)), resultTruncated: true }} />);
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error");
    expect(view.getByTestId("exec-exit-code").textContent).toBe("7");
    expect(view.queryByTestId("exec-receipt-unavailable")).toBeNull();
  });

  test("sealed output preserves byte cursors for controls but redacts explicit credential material from display", async () => {
    const data = "Bearer credential-fixture-1234567890\n";
    const produced = new TextEncoder().encode(data).byteLength;
    const value = snapshot({ output: { data, cursor: 0, nextCursor: produced, availableFrom: 0, produced, gap: false, hasMore: false } });
    const read = mock(async () => value);
    installBridge({ read, cancel: mock(async () => value), openPreview: mock(async () => undefined) });
    const view = render(<ToolCard toolName="exec_command" toolCallId="credential-call" args={{ cmd: "build" }}
      status={{ type: "complete" }} defaultExpanded result={projectToolResultForCard("exec_command", JSON.stringify(value))} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith({ generation: value.generation, executionId: value.executionId, cursor: produced, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(view.getByTestId("exec-output").textContent).toBe("Bearer [redacted]\n");
    expect(view.container.textContent).not.toContain("credential-fixture-1234567890");
  });

  test("shows process completion and exit status even when the tool call succeeded", () => {
    const done = snapshot({ state: "completed", exitCode: 9, pid: null, resources: "released" });
    const view = render(card("exec_command", done));
    const group = view.getByRole("group", { name: /Local command.*error/i });
    expect(group.getAttribute("data-tool-card-state")).toBe("error");
    expect(view.getByTestId("exec-process-state").textContent).toBe("completed");
    expect(view.getByTestId("exec-exit-code").textContent).toBe("9");
    expect(view.getByTestId("exec-output").textContent).toBe("first line\n");
  });

  test("reads from the next cursor and appends the returned page once", async () => {
    const original = snapshot({ output: {
      data: "first line\n", cursor: 0, nextCursor: 11,
      availableFrom: 0, produced: 23, gap: false, hasMore: true,
    } });
    const read = mock(async () => read.mock.calls.length === 1 ? original : snapshot({
      output: {
        data: "second line\n", cursor: 11, nextCursor: 23,
        availableFrom: 0, produced: 23, gap: false, hasMore: false,
      },
    }));
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("write_stdin", original, { session_id: "exec-1" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Load more output" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenCalledWith({ generation: "generation-1", executionId: "exec-1", cursor: 11, maxBytes: Number.MAX_SAFE_INTEGER });
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("first line\nsecond line\n"));
    view.rerender(card("write_stdin", snapshot({ output: {
      data: "second line\n", cursor: 11, nextCursor: 23,
      availableFrom: 0, produced: 23, gap: false, hasMore: false,
    } }), { session_id: "exec-1" }));
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("first line\nsecond line\n"));
  });

  test("reports a retained-output gap and keeps the returned cursor page visible", () => {
    const value = snapshot({ output: {
      data: "retained tail\n", cursor: 40, nextCursor: 54, availableFrom: 40,
      produced: 54, gap: true, hasMore: false,
    } });
    const view = render(card("exec_command", value));
    expect(view.getByTestId("exec-output").textContent).toBe("retained tail\n");
    expect(view.getByRole("status").textContent).toContain("Some output before this cursor is no longer retained.");
  });

  test("keeps a gap notice after later output arrives without a gap", async () => {
    const original = snapshot({ output: {
      data: "retained tail\n", cursor: 40, nextCursor: 54, availableFrom: 40,
      produced: 65, gap: true, hasMore: true,
    } });
    const read = mock(async () => read.mock.calls.length === 1 ? original : snapshot({ output: {
      data: "new output\n", cursor: 54, nextCursor: 65, availableFrom: 40,
      produced: 65, gap: false, hasMore: false,
    } }));
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", original));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Load more output" }));
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("retained tail\nnew output\n"));
    expect(view.getByRole("status").textContent).toContain("Some output before this cursor is no longer retained.");
  });

  test("reconciles a receipt that arrives after the running card mounts", async () => {
    const read = mock(async () => snapshot());
    installBridge({ read, cancel: mock(async () => snapshot({ state: "cancelled" })), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", null));
    expect(view.queryByTestId("exec-output")).toBeNull();
    view.rerender(card("exec_command", snapshot()));
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("first line\n"));
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  test("Stop cancels the exact execution reference and displays the returned outcome", async () => {
    const cancel = mock(async () => snapshot({ state: "cancelled", pid: null, signal: "SIGTERM", resources: "released", output: {
      data: "", cursor: 11, nextCursor: 11, availableFrom: 0, produced: 11, gap: false, hasMore: false,
    } }));
    installBridge({ read: mock(async () => snapshot()), cancel, openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledWith({ generation: "generation-1", executionId: "exec-1", cursor: 11, maxBytes: Number.MAX_SAFE_INTEGER });
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("cancelled"));
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled"));
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("Refresh updates the header to the process exit result", async () => {
    const initial = snapshot();
    const completed = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released" });
    const read = mock(async () => read.mock.calls.length === 1 ? initial : completed);
    installBridge({ read, cancel: mock(async () => initial), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", initial));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("completed"));
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error"));
    expect(view.getByTestId("exec-exit-code").textContent).toBe("7");
  });

  test("shows outcome unconfirmed after a failed read, then recovers on retry", async () => {
    const completed = snapshot({ state: "completed", exitCode: 0, pid: null, resources: "released" });
    const read = mock(async () => {
      if (read.mock.calls.length === 1) throw new Error("generation expired");
      return completed;
    });
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    await waitFor(() => expect(view.getByText("Outcome unconfirmed")).toBeTruthy());
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked"));
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("success"));
    expect(view.queryByText("Outcome unconfirmed")).toBeNull();
  });

  test("refreshes a persisted receipt when the card mounts", async () => {
    const completed = snapshot({ state: "completed", exitCode: 3, pid: null, resources: "released" });
    const read = mock(async () => completed);
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error"));
    expect(view.getByTestId("exec-exit-code").textContent).toBe("3");
  });

  test("does not refresh an already released terminal receipt", async () => {
    const terminal = snapshot({ state: "completed", exitCode: 4, pid: null, resources: "released" });
    const read = mock(async () => { throw new Error("receipt expired"); });
    installBridge({ read, cancel: mock(async () => terminal), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", terminal));
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error");
    expect(view.getByTestId("exec-exit-code").textContent).toBe("4");
    expect(view.queryByText("Outcome unconfirmed")).toBeNull();
  });

  test("ignores an older mount-read failure after Stop confirms cancellation", async () => {
    let rejectMountRead!: (error: Error) => void;
    const read = mock(() => new Promise<LocalExecutionSnapshot>((_resolve, reject) => { rejectMountRead = reject; }));
    const cancelled = snapshot({ state: "cancelled", pid: null, signal: "SIGTERM", resources: "released" });
    const cancel = mock(async () => cancelled);
    installBridge({ read, cancel, openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("cancelled"));
    await act(async () => {
      rejectMountRead(new Error("old generation request failed"));
      await Promise.resolve();
    });
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled");
    expect(view.queryByText("Outcome unconfirmed")).toBeNull();
  });

  test("keeps an unknown owned execution blocked and lets Stop retry despite transport cancellation", async () => {
    const unknown = snapshot({ state: "unknown", resources: "owned" });
    const cancelled = snapshot({ state: "cancelled", pid: null, signal: "SIGTERM", resources: "released" });
    const cancel = mock(async () => cancelled);
    installBridge({ read: mock(async () => unknown), cancel, openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", unknown, {}, true));
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
    expect(view.getByTestId("exec-process-state").textContent).toBe("unknown");
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("cancelled"));
    expect(cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled"));
  });

  test("keeps transport cancellation pending while cancellation cleanup is owned", async () => {
    const cancelling = snapshot({ state: "cancelling", resources: "owned" });
    const read = mock(async () => cancelling);
    installBridge({ read, cancel: mock(async () => cancelling), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", cancelling, {}, true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("running");
    expect(view.getByTestId("exec-process-state").textContent).toBe("cancelling");
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  test("does not confirm cancellation before execution resources are released", async () => {
    const cancelling = snapshot({ state: "cancelled", resources: "owned" });
    const read = mock(async () => cancelling);
    installBridge({ read, cancel: mock(async () => cancelling), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", cancelling, {}, true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("does not let a malformed local receipt override transport cancellation", () => {
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={JSON.stringify({ state: "completed", exitCode: 0, cancelled: true })}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled");
    expect(view.queryByTestId("exec-process-state")).toBeNull();
  });

  test("keeps an unknown-delivery envelope honest and recovers only by its exact reference", async () => {
    const cancelled = snapshot({ state: "cancelled", pid: null, signal: "SIGTERM", resources: "released" });
    const read = mock(async () => { throw new Error("host unavailable"); });
    const cancel = mock(async () => cancelled);
    installBridge({ read, cancel, openPreview: mock(async () => undefined) });
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={unknownEnvelope()}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    await waitFor(() => expect(view.getByTestId("exec-outcome-unknown").textContent).toBe("Outcome unknown"));
    expect(read).toHaveBeenCalledWith({ generation: "generation-1", executionId: "exec-1", cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
    expect(view.queryByTestId("exec-process-state")).toBeNull();
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("cancelled"));
    expect(cancel).toHaveBeenCalledWith({ generation: "generation-1", executionId: "exec-1", cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("cancelled"));
    expect(view.queryByTestId("exec-outcome-unknown")).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("replaces unknown delivery with the first validated snapshot read", async () => {
    const running = snapshot({ state: "running", output: {
      data: "actual host output\n", cursor: 0, nextCursor: 19,
      availableFrom: 0, produced: 19, gap: false, hasMore: false,
    } });
    const read = mock(async () => {
      if (read.mock.calls.length === 1) return running;
      throw new Error("later read unavailable");
    });
    installBridge({ read, cancel: mock(async () => running), openPreview: mock(async () => undefined) });
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={unknownEnvelope()}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    await waitFor(() => expect(view.getByTestId("exec-process-state").textContent).toBe("running"));
    expect(read).toHaveBeenCalledWith({ generation: "generation-1", executionId: "exec-1", cursor: 0, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(view.getByTestId("exec-output").textContent).toBe("actual host output\n");
    expect(view.queryByTestId("exec-outcome-unknown")).toBeNull();
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("running"));
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    await waitFor(() => expect(view.getByText("Outcome unconfirmed")).toBeTruthy());
    expect(view.queryByTestId("exec-outcome-unknown")).toBeNull();
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked"));
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  test("ignores an old pending read after a same-identity terminal receipt arrives", async () => {
    let rejectRead!: (error: Error) => void;
    const read = mock(() => new Promise<LocalExecutionSnapshot>((_resolve, reject) => { rejectRead = reject; }));
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const completed = snapshot({ state: "completed", exitCode: 5, pid: null, resources: "released" });
    view.rerender(card("exec_command", completed));
    await waitFor(() => expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error"));
    await act(async () => {
      rejectRead(new Error("old pending read expired"));
      await Promise.resolve();
    });
    expect(view.getByTestId("exec-exit-code").textContent).toBe("5");
    expect(view.queryByText("Outcome unconfirmed")).toBeNull();
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("error");
  });

  test("drops recovery controls when an uncertainty receipt is replaced by malformed data", async () => {
    const read = mock(() => new Promise<LocalExecutionSnapshot>(() => undefined));
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={unknownEnvelope()}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    await waitFor(() => expect(view.getByTestId("exec-outcome-unknown")).toBeTruthy());
    view.rerender(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={JSON.stringify({ state: "unknown" })}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    await waitFor(() => expect(view.queryByTestId("exec-outcome-unknown")).toBeNull());
    expect(view.queryByRole("button", { name: "Read execution status" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("rejects malformed unknown-delivery envelopes", () => {
    const read = mock(async () => snapshot());
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={unknownEnvelope({ extra: "not permitted" })}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    expect(view.queryByTestId("exec-outcome-unknown")).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    view.rerender(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={unknownEnvelope({ operation: ["start"] })}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    expect(view.queryByTestId("exec-outcome-unknown")).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("rejects a snapshot whose resource state is an array", () => {
    const read = mock(async () => snapshot());
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(<ToolCard
      toolName="exec_command"
      toolCallId="call-1"
      args={{ cmd: "bun run dev" }}
      result={JSON.stringify({ ...snapshot({ state: "completed", exitCode: 0 }), resources: ["released"] })}
      status={{ type: "complete" }}
      defaultExpanded
    />);
    expect(view.queryByTestId("exec-process-state")).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("offers only loopback preview URLs and opens through the exact bridge reference", async () => {
    const openPreview = mock(async () => undefined);
    const value = snapshot({ output: {
      data: "Local: http://localhost:5173/ and http://example.com/\n", cursor: 0, nextCursor: 54,
      availableFrom: 0, produced: 54, gap: false, hasMore: false,
    } });
    installBridge({ read: mock(async () => value), cancel: mock(async () => value), openPreview });
    const view = render(card("exec_command", value));
    expect(view.getAllByRole("button", { name: "Open preview" })).toHaveLength(1);
    expect(view.getByText(/Availability has not been confirmed/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(openPreview).toHaveBeenCalledWith({
      generation: "generation-1", executionId: "exec-1", url: "http://localhost:5173/",
    }));
  });

  test("does not offer preview for a completed process", async () => {
    const value = snapshot({ state: "completed", exitCode: 0, pid: null, output: {
      data: "Local: http://localhost:5173/\n", cursor: 0, nextCursor: 30,
      availableFrom: 0, produced: 30, gap: false, hasMore: false,
    } });
    const read = mock(async () => value);
    installBridge({ read, cancel: mock(async () => value), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", value));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("button", { name: "Open preview" })).toBeNull();
  });

  for (const archived of [
    snapshot({ state: "completed", exitCode: 0, pid: null, resources: "released", archived: true }),
    snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released", archived: true }),
    snapshot({ state: "failed", pid: null, failureCode: "LOCAL_EXECUTION_START_FAILED", resources: "released", archived: true }),
    snapshot({ state: "cancelled", pid: null, signal: "SIGTERM", resources: "released", archived: true }),
    snapshot({ state: "unknown", pid: null, resources: "released", archived: true }),
    snapshot({ state: "unknown", pid: null, resources: "release_failed", archived: true }),
  ] as Array<LocalExecutionSnapshot & { archived: true }>) {
    test(`renders archived ${archived.state} history without live bridge actions`, () => {
      const read = mock(async () => snapshot());
      const cancel = mock(async () => snapshot());
      const openPreview = mock(async () => undefined);
      const localExecution = installBridge({ read, cancel, openPreview });
      const data = "Local: http://localhost:5173/\nsaved output\n";
      const bytes = new TextEncoder().encode(data).byteLength;
      const value = { ...archived, output: { data, cursor: 0, nextCursor: bytes, availableFrom: 0, produced: bytes, gap: false, hasMore: false } };
      const { archived: _archived, ...receipt } = value;
      publishLocalExecutionHistoryOverlay(localExecution, { generation: archived.generation, executionId: archived.executionId, snapshot: value });
      const view = render(card("exec_command", receipt));

      expect(view.getByText(/Saved history/)).toBeTruthy();
      expect(view.getByTestId("exec-process-state").textContent).toBe(archived.state);
      expect(view.getByTestId("exec-output").textContent).toBe(data);
      expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe(
        archived.state === "completed" ? archived.exitCode === 0 ? "success" : "error"
          : archived.state === "cancelled" ? "cancelled" : archived.state === "unknown" ? "blocked" : "error",
      );
      if (archived.state === "unknown") expect(view.getByTestId("exec-archived-unknown")).toBeTruthy();
      expect(view.queryByRole("button", { name: /Stop|Refresh|Load more|Read execution|Open preview/ })).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
      act(() => clearLocalExecutionHistoryOverlays(localExecution));
    });
  }

  test("does not accept an archived marker in an ordinary tool result as history authority", () => {
    const read = mock(async () => snapshot());
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const value = { ...snapshot({ state: "completed", exitCode: 0, resources: "released" }), archived: true as const };
    const view = render(card("exec_command", value));
    expect(view.getByTestId("exec-receipt-unavailable").textContent).toContain("Outcome unconfirmed");
    expect(view.queryByText(/Saved history/)).toBeNull();
    expect(view.queryByRole("button", { name: /Stop|Refresh|Load more|Read execution/ })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("renders historical ToolMessage pages as saved read-only results", () => {
    const read = mock(async () => snapshot());
    const cancel = mock(async () => snapshot());
    const openPreview = mock(async () => undefined);
    installBridge({ read, cancel, openPreview });
    const data = "saved output π\n";
    const bytes = new TextEncoder().encode(data).byteLength;
    const historical = snapshot({ state: "completed", exitCode: 7, pid: null, resources: "released", historical: true,
      output: { data, cursor: 0, nextCursor: bytes, availableFrom: 0, produced: bytes + 9, gap: false, hasMore: true } });
    const raw = JSON.stringify({ ...historical, unrelatedProviderField: "discard me" });
    const projected = projectToolResultForCard("exec_command", raw)!;
    expect(JSON.parse(projected)).toMatchObject({ historical: true, output: { cursor: 0, hasMore: true } });
    expect(projected).not.toContain("unrelatedProviderField");
    const complete = snapshot({ executionId: "exec-full", session_id: "exec-full", state: "completed", exitCode: 0,
      pid: null, resources: "released", historical: true,
      output: { data, cursor: 0, nextCursor: bytes, availableFrom: 0, produced: bytes, gap: false, hasMore: false } });

    const view = render(<>
      <ToolCard toolName="exec_command" toolCallId="historical-tool-call" args={{ cmd: "build" }}
        result={projected} status={{ type: "complete" }} defaultExpanded />
      <ToolCard toolName="exec_command" toolCallId="historical-full-tool-call" args={{ cmd: "build" }}
        result={result(complete)} status={{ type: "complete" }} defaultExpanded />
    </>);
    expect(view.getAllByText(/Saved history/)).toHaveLength(2);
    expect(view.getAllByTestId("exec-process-state")[0]?.textContent).toBe("completed");
    expect(view.getAllByTestId("exec-exit-code")[0]?.textContent).toBe("7");
    expect(view.getAllByTestId("exec-output")[0]?.textContent).toBe(data);
    expect(view.getAllByRole("group").map((group) => group.getAttribute("data-tool-card-state"))).toEqual(["error", "success"]);
    expect(view.getByTestId("exec-saved-output-range").textContent).toBe(`Showing saved output bytes 1–${bytes} of ${bytes + 9}.`);
    expect(view.getAllByTestId("exec-saved-output-range")).toHaveLength(1);
    expect(view.queryAllByRole("button", { name: /Stop|Refresh|Load more|Read execution|Open preview/ })).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(openPreview).not.toHaveBeenCalled();
  });

  test("an archive published while a manual read is pending remains the confirmed unknown outcome", async () => {
    let rejectRead!: (error: Error) => void;
    const read = mock(async () => snapshot({ state: "unknown", resources: "owned" }));
    const cancel = mock(async () => snapshot({ state: "unknown", resources: "owned" }));
    const localExecution = installBridge({ read, cancel, openPreview: mock(async () => undefined) });
    const current = snapshot({ state: "unknown", resources: "owned" });
    const view = render(card("exec_command", current));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    const archived = snapshot({ state: "unknown", resources: "release_failed", pid: null, archived: true });
    act(() => publishLocalExecutionHistoryOverlay(localExecution, { generation: archived.generation, executionId: archived.executionId, snapshot: archived }));
    await waitFor(() => expect(view.getByTestId("exec-archived-unknown")).toBeTruthy());
    await act(async () => { rejectRead(new Error("late failure")); });
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByText("Outcome unconfirmed")).toBeNull();
    act(() => clearLocalExecutionHistoryOverlays(localExecution));
  });

  test("an archive published while Stop is pending cannot be overwritten by the late cancel reply", async () => {
    let resolveCancel!: (value: LocalExecutionSnapshot) => void;
    const read = mock(async () => snapshot({ state: "unknown", resources: "owned" }));
    const cancel = mock(() => new Promise<LocalExecutionSnapshot>((resolve) => { resolveCancel = resolve; }));
    const localExecution = installBridge({ read, cancel, openPreview: mock(async () => undefined) });
    const current = snapshot({ state: "unknown", resources: "owned" });
    const view = render(card("exec_command", current));
    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const archived = snapshot({ state: "unknown", resources: "release_failed", pid: null, archived: true });
    act(() => publishLocalExecutionHistoryOverlay(localExecution, { generation: archived.generation, executionId: archived.executionId, snapshot: archived }));
    await waitFor(() => expect(view.getByTestId("exec-archived-unknown")).toBeTruthy());
    await act(async () => { resolveCancel(current); });
    expect(view.getByRole("group").getAttribute("data-tool-card-state")).toBe("blocked");
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.getByTestId("exec-archived-unknown")).toBeTruthy();
    act(() => clearLocalExecutionHistoryOverlays(localExecution));
  });

  test("withholds preview while an exited process is finishing resource cleanup", async () => {
    const value = snapshot({ state: "running", exitCode: 0, pid: null, resources: "owned", output: {
      data: "Local: http://localhost:5173/\n", cursor: 0, nextCursor: 30,
      availableFrom: 0, produced: 30, gap: false, hasMore: false,
    } });
    const read = mock(async () => value);
    installBridge({ read, cancel: mock(async () => value), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", value));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("exec-process-state").textContent).toBe("Finishing cleanup");
    expect(view.queryByRole("button", { name: "Open preview" })).toBeNull();
  });

  test("rejects a pending read after the card changes to another identity", async () => {
    const resolvers: Array<(value: LocalExecutionSnapshot) => void> = [];
    const read = mock(() => new Promise<LocalExecutionSnapshot>((resolve) => { resolvers.push(resolve); }));
    installBridge({ read, cancel: mock(async () => snapshot()), openPreview: mock(async () => undefined) });
    const view = render(card("exec_command", snapshot()));
    fireEvent.click(view.getByRole("button", { name: "Refresh status and output" }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));

    const replacement = snapshot({ executionId: "exec-2", session_id: "exec-2", generation: "generation-2", output: {
      data: "replacement output\n", cursor: 0, nextCursor: 19, availableFrom: 0,
      produced: 19, gap: false, hasMore: false,
    } });
    view.rerender(card("exec_command", replacement));
    await act(async () => {
      resolvers.forEach((resolve) => resolve(snapshot({ output: {
        data: "stale output\n", cursor: 11, nextCursor: 24, availableFrom: 0,
        produced: 24, gap: false, hasMore: false,
      } })));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByTestId("exec-output").textContent).toBe("replacement output\n"));
    expect(view.queryByText("stale output")).toBeNull();
  });

  test("keeps actions unavailable when the Desktop bridge is absent", () => {
    const view = render(card("exec_command", snapshot()));
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("button", { name: /Refresh|Load more/ })).toBeNull();
  });
});
