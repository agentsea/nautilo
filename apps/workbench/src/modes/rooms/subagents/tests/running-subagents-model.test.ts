import { describe, expect, it } from "bun:test";
import {
  compareRunningSubagents,
  deriveHeartbeat,
  isTerminalStatus,
  sortRunningSubagents,
  STATUS_PRIORITY,
  type RunningSubagent,
  type RunningSubagentStatus,
} from "../running-subagents-model";

function sub(
  partial: Partial<RunningSubagent> & { taskId: string; status: RunningSubagentStatus },
): RunningSubagent {
  return {
    parentTaskId: null,
    depth: 0,
    taskRunId: `${partial.taskId}-run`,
    agentName: "Genie",
    modelId: "claude-sonnet-4.6",
    kind: "in_background",
    harnessId: null,
    prompt: "do a thing",
    line3: "",
    recentActivity: [],
    harnessActivity: [],
    awaitingRoomId: null,
    startedAtMs: 1000,
    terminalAtMs: null,
    ...partial,
  };
}

describe("sortRunningSubagents — status-priority (cap-3 visibility guarantee)", () => {
  it("floats awaiting + errored above running/paused/done", () => {
    const list = [
      sub({ taskId: "d", status: "done", startedAtMs: 1 }),
      sub({ taskId: "r", status: "running", startedAtMs: 2 }),
      sub({ taskId: "a", status: "awaiting", startedAtMs: 9 }),
      sub({ taskId: "p", status: "paused", startedAtMs: 3 }),
      sub({ taskId: "e", status: "errored", startedAtMs: 8 }),
    ];
    expect(sortRunningSubagents(list).map((s) => s.status)).toEqual([
      "awaiting",
      "errored",
      "running",
      "paused",
      "done",
    ]);
  });

  it("an awaiting/errored card is ALWAYS in the top-3 even when newest", () => {
    // Three older running cards + one brand-new awaiting card: the awaiting
    // card must still land in the visible cap-3 window (index < 3).
    const list = [
      sub({ taskId: "r1", status: "running", startedAtMs: 1 }),
      sub({ taskId: "r2", status: "running", startedAtMs: 2 }),
      sub({ taskId: "r3", status: "running", startedAtMs: 3 }),
      sub({ taskId: "late", status: "awaiting", startedAtMs: 999 }),
    ];
    const idx = sortRunningSubagents(list).findIndex((s) => s.taskId === "late");
    expect(idx).toBe(0);
    expect(idx).toBeLessThan(3);
  });

  it("stable start-time-ascending tiebreak within a tier (oldest first)", () => {
    const list = [
      sub({ taskId: "young", status: "running", startedAtMs: 300 }),
      sub({ taskId: "old", status: "running", startedAtMs: 100 }),
      sub({ taskId: "mid", status: "running", startedAtMs: 200 }),
    ];
    expect(sortRunningSubagents(list).map((s) => s.taskId)).toEqual(["old", "mid", "young"]);
  });

  it("does NOT reorder on live activity (line3 change keeps order)", () => {
    const before = [
      sub({ taskId: "a", status: "running", startedAtMs: 100, line3: "step 1" }),
      sub({ taskId: "b", status: "running", startedAtMs: 200, line3: "step 1" }),
    ];
    const after = [
      // 'b' just emitted a newer progress line — must NOT jump above 'a'.
      sub({ taskId: "b", status: "running", startedAtMs: 200, line3: "step 99" }),
      sub({ taskId: "a", status: "running", startedAtMs: 100, line3: "step 1" }),
    ];
    expect(sortRunningSubagents(before).map((s) => s.taskId)).toEqual(["a", "b"]);
    expect(sortRunningSubagents(after).map((s) => s.taskId)).toEqual(["a", "b"]);
  });

  it("comparator is a pure total order (priority map is exhaustive)", () => {
    const statuses = Object.keys(STATUS_PRIORITY) as RunningSubagentStatus[];
    expect(statuses.length).toBe(5);
    const a = sub({ taskId: "x", status: "running" });
    expect(compareRunningSubagents(a, a)).toBe(0);
  });
});

describe("deriveHeartbeat", () => {
  it("uses paused and completed lifecycle truth over stale working progress", () => {
    expect(deriveHeartbeat([sub({ status: "paused", agentName: "Moxie", line3: "Reading source" })]).line).toBe("Moxie paused");
    expect(deriveHeartbeat([sub({ status: "done", agentName: "Moxie", line3: "Reading source" })]).line).toBe("Moxie completed");
  });

  it("empty set → count 0, no line", () => {
    expect(deriveHeartbeat([])).toEqual({ count: 0, line: "" });
  });

  it("prioritizes an action-needed card over busy running ones", () => {
    const hb = deriveHeartbeat([
      sub({ taskId: "r", status: "running", agentName: "Genie", line3: "editing", startedAtMs: 1 }),
      sub({ taskId: "a", status: "awaiting", agentName: "Mira", startedAtMs: 999 }),
    ]);
    expect(hb.count).toBe(2);
    expect(hb.line).toContain("Mira");
    expect(hb.line).toContain("needs your reply");
  });

  it("shows the top running card's line when nothing needs attention", () => {
    const hb = deriveHeartbeat([
      sub({ taskId: "r", status: "running", agentName: "Genie", line3: "run_shell: rg", startedAtMs: 1 }),
    ]);
    expect(hb.line).toContain("Genie");
    expect(hb.line).toContain("run_shell: rg");
  });
});

describe("isTerminalStatus", () => {
  it("done + errored are terminal; others are not", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("errored")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("paused")).toBe(false);
    expect(isTerminalStatus("awaiting")).toBe(false);
  });
});
