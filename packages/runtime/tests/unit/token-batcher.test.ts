import { describe, expect, test } from "bun:test";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";

describe("TokenBatcher", () => {
  test("flushes when buffer exceeds maxChars", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane", maxChars: 10 });
    batcher.addToken("hello world!!");
    const events = batcher.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.content).toBe("hello world!!");
    expect(events[0]!.done).toBe(false);
    expect(events[0]!.laneKey).toBe("test:lane");
    expect(events[0]!.chunkSequence).toBe(1);
  });

  test("completeMessage flushes with done=true", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane", maxChars: 1000 });
    batcher.addToken("hello");
    batcher.completeMessage();
    const events = batcher.drain();
    expect(events.length).toBe(1);
    expect(events[0]!.content).toBe("hello");
    expect(events[0]!.done).toBe(true);
  });

  test("completeMessage without visible content does not emit a fragment", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane" });
    batcher.completeMessage();
    const events = batcher.drain();
    expect(events).toEqual([]);
  });

  test("increments message index only after a visible message", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane" });
    expect(batcher.getMessageIndex()).toBe(0);
    batcher.completeMessage();
    expect(batcher.getMessageIndex()).toBe(0);
    batcher.addToken("visible");
    batcher.completeMessage();
    expect(batcher.getMessageIndex()).toBe(1);
  });

  test("chunk sequence resets after completeMessage", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane", maxChars: 5 });
    batcher.addToken("abcdefgh");
    batcher.completeMessage();
    const events = batcher.drain();
    expect(events.length).toBe(2);
    expect(events[0]!.chunkSequence).toBe(1);
    expect(events[1]!.chunkSequence).toBe(2);
    expect(events[1]!.done).toBe(true);

    batcher.addToken("new");
    batcher.completeMessage();
    const events2 = batcher.drain();
    expect(events2[0]!.chunkSequence).toBe(1);
  });

  test("reset clears everything", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane" });
    batcher.addToken("pending");
    batcher.completeMessage();
    batcher.reset();
    expect(batcher.getMessageIndex()).toBe(0);
    expect(batcher.drain().length).toBe(0);
  });

  test("drain returns events and clears internal queue", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane" });
    batcher.addToken("hi");
    batcher.completeMessage();
    const first = batcher.drain();
    expect(first.length).toBe(1);
    const second = batcher.drain();
    expect(second.length).toBe(0);
  });

  test("stamps turnId on flushed message.tokens when configured", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane", turnId: "turn-abc" });
    batcher.addToken("hello");
    batcher.completeMessage();
    const events = batcher.drain();
    expect(events[0]!.turnId).toBe("turn-abc");
    expect(events[0]!.assistantMessageKey).toBe("assistant:turn-abc:0");
  });

  test("uses one identity per visible message and ignores empty node ends", () => {
    const batcher = new TokenBatcher({ laneKey: "test:lane", turnId: "turn-abc" });
    batcher.completeMessage();
    batcher.addToken("first");
    expect(batcher.completeMessage()).toBe("assistant:turn-abc:0");
    batcher.completeMessage();
    batcher.addToken("second");
    expect(batcher.completeMessage()).toBe("assistant:turn-abc:1");

    expect(batcher.drain().map((event) => event.assistantMessageKey)).toEqual([
      "assistant:turn-abc:0",
      "assistant:turn-abc:1",
    ]);
  });
});

describe("ToolCallTracker", () => {
  test("toolStart returns ToolStartEvent", () => {
    const tracker = new ToolCallTracker();
    const event = tracker.toolStart("tc_1", "search_memory", { query: "test" });
    expect(event.type).toBe("tool.start");
    expect(event.toolCallId).toBe("tc_1");
    expect(event.toolName).toBe("search_memory");
    expect(event.argsSummary).toContain("test");
  });

  test("toolEnd returns ToolEndEvent with duration", async () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_1", "search_memory");
    await new Promise((r) => setTimeout(r, 10));
    const event = tracker.toolEnd("tc_1", "search_memory", "success");
    expect(event.type).toBe("tool.end");
    expect(event.toolCallId).toBe("tc_1");
    expect(event.duration).toBeGreaterThanOrEqual(5);
    expect(event.status).toBe("success");
  });

  test("toolEnd with error includes error message", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_1", "run_shell");
    const event = tracker.toolEnd("tc_1", "run_shell", "error", "command blocked");
    expect(event.status).toBe("error");
    expect(event.error).toBe("command blocked");
  });

  test("tracks active call count", () => {
    const tracker = new ToolCallTracker();
    expect(tracker.getActiveCount()).toBe(0);
    tracker.toolStart("tc_1", "search_memory");
    tracker.toolStart("tc_2", "transcribe_audio");
    expect(tracker.getActiveCount()).toBe(2);
    tracker.toolEnd("tc_1", "search_memory", "success");
    expect(tracker.getActiveCount()).toBe(1);
  });

  test("reset clears all active calls", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_1", "search_memory");
    tracker.reset();
    expect(tracker.getActiveCount()).toBe(0);
  });

  // M155 follow-up — author attribution on WS tool events.
  test("stamps authorAgentId on tool.start and tool.end when constructed with an agent id", () => {
    const tracker = new ToolCallTracker("agent-genie");
    const start = tracker.toolStart("tc_1", "run_shell");
    const end = tracker.toolEnd("tc_1", "run_shell", "success");
    expect(start.authorAgentId).toBe("agent-genie");
    expect(end.authorAgentId).toBe("agent-genie");
  });

  test("stamps turnId on tool.start and tool.end when constructed with a turn id", () => {
    const tracker = new ToolCallTracker(undefined, "turn-xyz");
    const start = tracker.toolStart("tc_1", "run_shell");
    const end = tracker.toolEnd("tc_1", "run_shell", "success");
    expect(start.turnId).toBe("turn-xyz");
    expect(end.turnId).toBe("turn-xyz");
  });

  test("omits authorAgentId when constructed without an agent id", () => {
    const tracker = new ToolCallTracker();
    const start = tracker.toolStart("tc_1", "run_shell");
    const end = tracker.toolEnd("tc_1", "run_shell", "success");
    expect(start.authorAgentId).toBeUndefined();
    expect(end.authorAgentId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // D083 Phase 2 — result field carried across WS
  // -------------------------------------------------------------------------

  test("toolEnd carries the tool output as result when provided", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_shell", "run_shell");
    const event = tracker.toolEnd(
      "tc_shell",
      "run_shell",
      "success",
      undefined,
      "hello from stdout\n",
    );
    expect(event.result).toBe("hello from stdout\n");
    expect(event.resultTruncated).toBeUndefined();
  });

  test("toolEnd omits result field when not provided (backward-compat)", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_1", "run_shell");
    const event = tracker.toolEnd("tc_1", "run_shell", "success");
    expect(event.result).toBeUndefined();
    expect(event.resultTruncated).toBeUndefined();
  });

  test("toolEnd caps 11KB non-staged result and sets resultTruncated", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_11k", "run_shell");
    const elevenKb = "y".repeat(11_000);
    const event = tracker.toolEnd(
      "tc_11k",
      "run_shell",
      "success",
      undefined,
      elevenKb,
    );
    expect(event.resultTruncated).toBe(true);
    const result = event.result as string;
    expect(result).toContain("bytes truncated");
    expect(result.slice(0, 10_000)).toBe("y".repeat(10_000));
  });

  test("toolEnd caps result at TOOL_RESULT_MAX_BYTES and sets resultTruncated", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_big", "run_shell");
    const huge = "x".repeat(50_000);
    const event = tracker.toolEnd(
      "tc_big",
      "run_shell",
      "success",
      undefined,
      huge,
    );
    expect(event.resultTruncated).toBe(true);
    expect(event.result).not.toBeUndefined();
    const result = event.result as string;
    // Capped to ~10k chars + trailing marker.
    expect(result.length).toBeLessThan(15_000);
    expect(result).toContain("bytes truncated");
    // First 10k preserved verbatim.
    expect(result.slice(0, 10_000)).toBe("x".repeat(10_000));
  });

  test("toolEnd does NOT truncate a staged-patch envelope over the cap (D268)", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_staged", "file");
    // A staged envelope larger than TOOL_RESULT_MAX_BYTES (10KB): the
    // unified diff embeds a big new-file body. Truncating it would
    // corrupt the JSON and strip Accept/Reject in the UI.
    const bigDiff = "+" + "x".repeat(20_000);
    const envelope = JSON.stringify({
      staged: true,
      patchId: "turn-1:big",
      path: "/tmp/big.html",
      zone: "workspace",
      command: "write",
      stats: { additions: 1, deletions: 0 },
      summary: "Staged: write",
      unifiedDiff: bigDiff,
    });
    expect(envelope.startsWith('{"staged":true')).toBe(true);
    const event = tracker.toolEnd("tc_staged", "file", "success", undefined, envelope);
    expect(event.resultTruncated).toBeUndefined();
    expect(event.result).toBe(envelope);
    // Round-trips as valid JSON — the whole point.
    expect(() => {
      JSON.parse(event.result as string);
    }).not.toThrow();
  });

  test("toolEnd projects oversized apply_patch output as valid bounded JSON", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_apply_patch", "apply_patch");
    const pathResults = Array.from({ length: 40 }, (_, index) => ({
      operation: "update",
      path: `src/${index}.ts`,
      status: "applied",
      revisionId: `revision-${index}`,
    }));
    const result = JSON.stringify({
      status: "applied",
      partial: false,
      runtimeVersion: "apply-patch-1",
      turnId: "turn-448",
      operationCounts: { add: 0, update: 40, move: 0, delete: 0 },
      pathResults,
      changedFiles: pathResults,
      revisionIds: pathResults.map((pathResult) => pathResult.revisionId),
      unifiedDiff: Array.from(
        { length: 40 },
        (_, index) => `diff --git a/src/${index}.ts b/src/${index}.ts\n+${"x".repeat(400)}\n`,
      ).join(""),
    });

    const event = tracker.toolEnd("tc_apply_patch", "apply_patch", "success", undefined, result);
    expect(event.resultTruncated).toBe(true);
    expect(() => { JSON.parse(event.result!); }).not.toThrow();
    expect(event.result).not.toContain("bytes truncated");
    const projected = JSON.parse(event.result!) as unknown as {
      eventProjection: { totalPaths: number; shownPaths: number; truncated: boolean };
    };
    expect(projected.eventProjection.totalPaths).toBe(40);
    expect(projected.eventProjection.shownPaths).toBeGreaterThan(0);
    expect(projected.eventProjection.truncated).toBe(true);
  });

  test("toolEnd with BOTH error and result (error path that still produced output)", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_err", "run_shell");
    const event = tracker.toolEnd(
      "tc_err",
      "run_shell",
      "error",
      "command exited with code 1",
      "stderr: something broke\n",
    );
    expect(event.status).toBe("error");
    expect(event.error).toBe("command exited with code 1");
    expect(event.result).toBe("stderr: something broke\n");
  });

  test("toolEnd empty-string result is preserved (not treated as 'no result')", () => {
    const tracker = new ToolCallTracker();
    tracker.toolStart("tc_empty", "run_shell");
    const event = tracker.toolEnd(
      "tc_empty",
      "run_shell",
      "success",
      undefined,
      "",
    );
    expect(event.result).toBe("");
    expect(event.resultTruncated).toBeUndefined();
  });
});
