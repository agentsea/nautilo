import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";

import { createTaskDetailLiveActivityController, taskDetailLiveActivityText } from "./task-detail-live-activity";

const target = { serverId: "server-a", serverUrl: "https://server-a", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1, taskId: "task-a" };
const wire = (partial: Record<string, unknown>) => ({ ...partial, ownerId: partial.ownerId ?? target.userId }) as ServerEvent;
const fired = (run: string) => wire({ type: "task.fired", taskId: target.taskId, taskRunId: run, laneKey: "task:task-a" });
const progress = (run: string, detail = "exact bytes", activity?: object) => wire({ type: "task.progress", taskId: target.taskId, taskRunId: run, detail, ...(activity ? { activity } : {}) });
const awaiting = (run?: string) => wire({ type: "task.awaiting_reply", taskId: target.taskId, ...(run ? { taskRunId: run } : {}), targetRoomId: "room-a", awaitingFromUserIds: [] });
const complete = (run: string) => wire({ type: "task.completed", taskId: target.taskId, taskRunId: run, status: "completed" });

function ready() {
  const controller = createTaskDetailLiveActivityController();
  controller.setTarget(target);
  return controller;
}

describe("Task detail live activity reconciliation", () => {
  test("generic waiting is not a reply request and explicit reasons expire when work resumes", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "awaiting", latestRun: { id: "A", status: "awaiting" } });
    expect(taskDetailLiveActivityText(controller.getState(), "awaiting")).toBe("Needs attention");
    controller.apply(awaiting("A"), target);
    expect(taskDetailLiveActivityText(controller.getState(), "awaiting")).toBe("Waiting for your reply");
    controller.apply(progress("A", "Resumed model work"), target);
    expect(controller.getState().awaitingReply).toBe(false);
    controller.seedCanonical({ taskStatus: "awaiting", latestRun: { id: "A", status: "awaiting" } });
    expect(taskDetailLiveActivityText(controller.getState(), "awaiting")).toBe("Needs attention");
  });

  test("fired A then terminal/awaiting A spends exactly one trailing read", () => {
    const terminal = ready();
    expect(terminal.apply(fired("A"), target)).toBe(true);
    expect(terminal.apply(complete("A"), target)).toBe(true);
    expect(terminal.apply(complete("A"), target)).toBe(false);
    expect(terminal.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(taskDetailLiveActivityText(terminal.getState(), "running")).toBe("Done");

    const reply = ready();
    expect(reply.apply(fired("A"), target)).toBe(true);
    expect(reply.apply(awaiting("A"), target)).toBe(true);
    expect(reply.apply(awaiting("A"), target)).toBe(false);
    expect(reply.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(taskDetailLiveActivityText(reply.getState(), "running")).toBe("Waiting for your reply");
  });

  test("a trailing repair never suppresses a later exact terminal or progress patch", () => {
    const terminal = ready();
    expect(terminal.apply(fired("A"), target)).toBe(true);
    expect(terminal.apply(awaiting("A"), target)).toBe(true);
    // The read is already trailing, but this exact terminal receipt must still
    // latch locally and prevent later progress from reopening the run.
    expect(terminal.apply(complete("A"), target)).toBe(false);
    expect(terminal.getState()).toMatchObject({ terminalTaskRunId: "A", status: "done" });
    expect(terminal.apply(progress("A", "late"), target)).toBe(false);

    const active = ready();
    active.apply(fired("B"), target);
    active.apply(progress("B", "first"), target);
    expect(active.apply(wire({ type: "task.status", taskId: target.taskId, status: "paused" }), target)).toBe(true);
    expect(active.getState().progress).toBeNull();
    // Exact established progress remains local truth even after that repair
    // entered its trailing phase.
    expect(active.apply(progress("B", "second"), target)).toBe(false);
    expect(active.getState().progress).toBe("second");
  });

  test("a distinct fired run starts a fresh revision despite stale replies for predecessors", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(fired("B"), target)).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(controller.apply(fired("C"), target)).toBe(true);
    expect(controller.getState()).toMatchObject({ taskRunId: "C", reconciliationPhase: "initial-requested" });
  });

  test("mismatched lifecycle and unknown-progress bursts are bounded across stale canonical seeds", () => {
    const lifecycle = ready();
    lifecycle.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(lifecycle.apply(awaiting("B"), target)).toBe(true);
    expect(lifecycle.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(true);
    expect(lifecycle.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(lifecycle.apply(awaiting("B"), target)).toBe(false);

    const unknown = ready();
    unknown.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(unknown.apply(progress("B"), target)).toBe(true);
    expect(unknown.apply(progress("C"), target)).toBe(true);
    expect(unknown.apply(progress("B"), target)).toBe(false);
    expect(unknown.apply(progress("C"), target)).toBe(false);
  });

  test("runless task.status never rewrites a concrete run and alternation is bounded", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "paused" }), target)).toBe(true);
    expect(controller.getState().taskRunId).toBe("A");
    expect(controller.getState().status).toBe("running");
    // A stale Task status upgrades initial to one trailing read but does not
    // clear the desired pause, so another identical WS frame cannot poll.
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "paused" }), target)).toBe(false);
    expect(controller.seedCanonical({ taskStatus: "paused", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(controller.getState().status).toBe("paused");

    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "running" }), target)).toBe(true);
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "paused" }), target)).toBe(true);
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "running" }), target)).toBe(false);
  });

  test("a runless awaiting event also retains its desired Task lifecycle through stale seeds", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(awaiting(), target)).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(controller.apply(awaiting(), target)).toBe(false);
    controller.seedCanonical({ taskStatus: "awaiting", latestRun: { id: "A", status: "running" } });
    expect(taskDetailLiveActivityText(controller.getState(), "running")).toBe("Waiting for your reply");
  });

  test("runless pending is an explicit unpause desire, not an idle null status", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "paused", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "pending" }), target)).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "paused", latestRun: { id: "A", status: "running" } })).toBe(true);
    expect(controller.seedCanonical({ taskStatus: "paused", latestRun: { id: "A", status: "running" } })).toBe(false);
    expect(controller.apply(wire({ type: "task.status", taskId: target.taskId, status: "pending" }), target)).toBe(false);
    controller.seedCanonical({ taskStatus: "pending", latestRun: { id: "A", status: "running" } });
    expect(taskDetailLiveActivityText(controller.getState(), "pending")).toBe("No current activity.");
  });

  test("canonical Task lifecycle owns presentation over a latest run status", () => {
    const paused = ready();
    paused.seedCanonical({ taskStatus: "paused", latestRun: { id: "A", status: "running" } });
    expect(taskDetailLiveActivityText(paused.getState(), "running")).toBe("Paused");

    const recurring = ready();
    recurring.seedCanonical({ taskStatus: "pending", latestRun: { id: "A", status: "completed" } });
    expect(recurring.getState().terminalTaskRunId).toBe("A");
    expect(taskDetailLiveActivityText(recurring.getState(), "pending")).toBe("No current activity.");
  });

  test("terminal truth is monotonic; a newer canonical run retires its predecessor", () => {
    const controller = ready();
    controller.apply(fired("A"), target);
    controller.apply(complete("A"), target);
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(progress("A", "late"), target)).toBe(false);
    expect(controller.apply(fired("A"), target)).toBe(false);
    expect(taskDetailLiveActivityText(controller.getState(), "running")).toBe("Done");

    controller.apply(fired("B"), target);
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "C", status: "running" } });
    expect(controller.getState().taskRunId).toBe("C");
    expect(controller.getState().retiredRunIds).toContain("B");
    expect(controller.apply(fired("B"), target)).toBe(false);
  });

  test("a newer canonical run retires an unconfirmed desired run against its delayed fire", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    expect(controller.apply(progress("B"), target)).toBe(true);
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "C", status: "running" } });
    expect(controller.getState().retiredRunIds).toContain("A");
    expect(controller.getState().retiredRunIds).toContain("B");
    expect(controller.apply(fired("B"), target)).toBe(false);
    expect(controller.getState().taskRunId).toBe("C");
  });

  test("duplicate current lifecycle frames are no-ops and exact source fencing rejects stale authority", () => {
    const controller = ready();
    expect(controller.apply(fired("A"), target)).toBe(true);
    expect(controller.apply(fired("A"), target)).toBe(false);
    expect(controller.apply(complete("A"), target)).toBe(true);
    expect(controller.apply(complete("A"), target)).toBe(false);

    const oldAuthority = { ...target, viewerEpoch: 0 };
    expect(controller.apply(fired("B"), oldAuthority)).toBe(false);
    expect(controller.apply(wire({ type: "task.fired", taskId: "other", taskRunId: "B", laneKey: "task:other" }), target)).toBe(false);
  });

  test("canonical seed accepts a mid-run fence and reconnect discard preserves terminal fence", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    controller.apply(progress("A", "mid run"), target);
    expect(controller.getState().progress).toBe("mid run");
    controller.clearProvisional();
    expect(controller.getState().progress).toBeNull();
    controller.apply(complete("A"), target);
    controller.clearProvisional();
    expect(controller.getState().terminalTaskRunId).toBe("A");
    expect(controller.apply(progress("A", "late"), target)).toBe(false);
  });

  test("activity projection appends only same-ID safe bytes and dispose rejects later events", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    controller.apply(progress("A", "one", { id: "one", kind: "tool", name: "one", status: "running", args: { path: "a" }, result: "one", startedAt: 1 }), target);
    controller.apply(progress("A", "two", { id: "one", kind: "tool", name: "one", status: "completed", args: {}, result: "two", appendResult: true, startedAt: 2 }), target);
    expect(controller.getState().activity).toMatchObject({ id: "one", args: { path: "a" }, result: "one\ntwo", startedAt: 1 });
    controller.apply(progress("A", "other", { id: "two", kind: "tool", name: "two", status: "running", args: {}, startedAt: 3 }), target);
    expect(controller.getState().activity).toMatchObject({ id: "two", args: {} });
    expect(controller.getState().activity?.result).toBeUndefined();
    controller.dispose();
    expect(controller.apply(progress("A"), target)).toBe(false);
  });

  test("activity projection preserves exact Codex response chunk boundaries", () => {
    const controller = ready();
    controller.seedCanonical({ taskStatus: "running", latestRun: { id: "A", status: "running" } });
    controller.apply(progress("A", "Codex writing response", {
      id: "response", kind: "status", name: "codex_response", status: "running",
      args: {}, result: "Hello ", appendResult: true, appendResultSeparator: "", startedAt: 1,
    }), target);
    controller.apply(progress("A", "Codex writing response", {
      id: "response", kind: "status", name: "codex_response", status: "running",
      args: {}, result: "world", appendResult: true, appendResultSeparator: "", startedAt: 2,
    }), target);

    expect(controller.getState().activity).toMatchObject({
      id: "response", result: "Hello world", startedAt: 1,
    });
  });
});
