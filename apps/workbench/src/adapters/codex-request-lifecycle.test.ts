import { describe, expect, test } from "bun:test";
import type { CodexRequestEvent, CodexRoomRequestList } from "@nautilo/types";
import {
  initialCodexRequestLifecycleState,
  isCodexOwner,
  isCodexRequestForViewer,
  reduceCodexRequestLifecycle,
  selectCodexRequestsForRoom,
} from "./runtime-contexts";

const ROOM_A = "room-a";
const ROOM_B = "room-b";

function inputEvent(id: string, roomId = ROOM_A, taskId = `task-${id}`, jobId = `job-${id}`): CodexRequestEvent {
  return {
    type: "codex.request",
    ownerId: "owner-a",
    requestId: id,
    taskId,
    jobId,
    roomId,
    expiresAt: "2026-08-01T12:00:00.000Z",
    request: {
      kind: "user_input_required",
      questions: [{ id: "question", header: "Question", prompt: "Choose", secret: false, allowOther: false, options: null }],
      autoResolutionMs: null,
    },
  };
}

function approvalEvent(id: string): CodexRequestEvent {
  return {
    type: "codex.request",
    ownerId: "owner-a",
    requestId: id,
    taskId: `task-${id}`,
    jobId: `job-${id}`,
    roomId: ROOM_A,
    expiresAt: null,
    request: {
      kind: "command_approval_required",
      options: ["approve", "deny"],
      reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["read"] },
    },
  };
}

function recovered(event: ReturnType<typeof inputEvent>, availability: "actionable" | "unavailable" = "actionable"): CodexRoomRequestList["items"][number] {
  return { availability, event };
}

describe("Codex request lifecycle recovery", () => {
  test("replaces only target-room durable inputs, preserves approvals/other Rooms, and replays newer terminal facts", () => {
    let state = initialCodexRequestLifecycleState();
    const approval = approvalEvent("approval-live");
    const otherRoom = inputEvent("other-room", ROOM_B);
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: approval });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: inputEvent("old-target") });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: otherRoom });

    const snapshot = inputEvent("snapshot-target");
    const accepted = inputEvent("accepted-after-get");
    const jobCleared = inputEvent("job-cleared-after-get");
    const taskCleared = inputEvent("task-cleared-after-get");
    const retained = inputEvent("retained-after-get");
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room",
      roomId: ROOM_A,
      ownerId: "owner-a",
      // Server emits newest first; reducer intentionally normalizes dock order.
      items: [recovered(snapshot)],
      baselineRequestIds: ["old-target"],
      newerActions: [
        { kind: "arm", event: accepted },
        { kind: "submit_start", requestId: accepted.requestId },
        { kind: "submit_accepted", requestId: accepted.requestId },
        { kind: "arm", event: jobCleared },
        { kind: "clear_job", jobId: jobCleared.jobId },
        { kind: "arm", event: taskCleared },
        { kind: "clear_task", taskId: taskCleared.taskId },
        { kind: "resolved", requestId: snapshot.requestId },
        { kind: "arm", event: retained },
      ],
    });

    expect(state.byId[approval.requestId]).toEqual(approval);
    expect(state.byId[otherRoom.requestId]).toEqual(otherRoom);
    expect(state.byId[retained.requestId]).toEqual(retained);
    expect(state.byId["old-target"]).toBeUndefined();
    expect(state.byId[snapshot.requestId]).toBeUndefined();
    expect(state.byId[accepted.requestId]).toBeUndefined();
    expect(state.byId[jobCleared.requestId]).toBeUndefined();
    expect(state.byId[taskCleared.requestId]).toBeUndefined();
  });

  test("normalizes newest-first snapshot to oldest-first and retains unavailable noninteractive facts", () => {
    let state = initialCodexRequestLifecycleState();
    const oldest = inputEvent("oldest");
    const newest = inputEvent("newest");
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room",
      roomId: ROOM_A,
      ownerId: "owner-a",
      items: [recovered(newest, "unavailable"), recovered(oldest)],
      baselineRequestIds: [],
      newerActions: [],
    });
    const view = selectCodexRequestsForRoom(state, ROOM_A, "owner-a");
    expect(view.requests.map((item) => item.event.requestId)).toEqual(["oldest", "newest"]);
    expect(view.requests[1]?.availability).toBe("unavailable");

    state = reduceCodexRequestLifecycle(state, { kind: "mark_unavailable", requestId: oldest.requestId });
    expect(selectCodexRequestsForRoom(state, ROOM_A, "owner-a").requests[0]?.availability).toBe("unavailable");
  });

  test("never evicts live approvals or another Room to admit a recovery snapshot", () => {
    let state = initialCodexRequestLifecycleState();
    for (let index = 0; index < 15; index += 1) {
      state = reduceCodexRequestLifecycle(state, { kind: "arm", event: approvalEvent(`approval-${index}`) });
    }
    const otherRoom = inputEvent("other-saturated", ROOM_B);
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: otherRoom });
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room",
      roomId: ROOM_A,
      ownerId: "owner-a",
      items: [recovered(inputEvent("recovered-over-cap"))],
      baselineRequestIds: [],
      newerActions: [],
    });
    expect(state.order).toHaveLength(16);
    expect(state.byId[otherRoom.requestId]).toEqual(otherRoom);
    expect(state.byId["approval-0"]).toBeDefined();
    expect(state.byId["recovered-over-cap"]).toBeUndefined();
  });

  test("keeps newest snapshot item when a baseline removal frees only one slot", () => {
    let state = initialCodexRequestLifecycleState();
    for (let index = 0; index < 15; index += 1) {
      state = reduceCodexRequestLifecycle(state, { kind: "arm", event: approvalEvent(`approval-${index}`) });
    }
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: inputEvent("baseline") });
    const newest = inputEvent("newest");
    const older = inputEvent("older");
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room",
      roomId: ROOM_A,
      ownerId: "owner-a",
      items: [recovered(newest), recovered(older)],
      baselineRequestIds: ["baseline"],
      newerActions: [],
    });
    expect(state.byId[newest.requestId]).toBeDefined();
    expect(state.byId[older.requestId]).toBeUndefined();
  });

  test("tombstones terminal refs and task/job terminals so late arms cannot reopen them", () => {
    let state = initialCodexRequestLifecycleState();
    const resolved = inputEvent("resolved");
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: resolved });
    state = reduceCodexRequestLifecycle(state, { kind: "resolved", requestId: resolved.requestId });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: resolved });
    expect(state.byId[resolved.requestId]).toBeUndefined();

    const accepted = inputEvent("accepted");
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: accepted });
    state = reduceCodexRequestLifecycle(state, { kind: "submit_accepted", requestId: accepted.requestId });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: accepted });
    expect(state.byId[accepted.requestId]).toBeUndefined();

    state = reduceCodexRequestLifecycle(state, { kind: "clear_task", taskId: "terminal-task" });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: inputEvent("late-task", ROOM_A, "terminal-task") });
    state = reduceCodexRequestLifecycle(state, { kind: "clear_job", jobId: "terminal-job" });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: inputEvent("late-job", ROOM_A, "task-late", "terminal-job") });
    expect(state.byId["late-task"]).toBeUndefined();
    expect(state.byId["late-job"]).toBeUndefined();
  });

  test("keeps an unavailable restart receipt after Task/Job terminality until dismissal", () => {
    let state = initialCodexRequestLifecycleState();
    const ended = inputEvent("ended", ROOM_A, "terminal-task", "terminal-job");
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room",
      roomId: ROOM_A,
      ownerId: "owner-a",
      items: [recovered(ended, "unavailable")],
      baselineRequestIds: [],
      newerActions: [],
    });

    state = reduceCodexRequestLifecycle(state, { kind: "clear_job", jobId: ended.jobId });
    state = reduceCodexRequestLifecycle(state, { kind: "clear_task", taskId: ended.taskId });
    expect(selectCodexRequestsForRoom(state, ROOM_A, "owner-a").requests).toEqual([
      { event: ended, availability: "unavailable" },
    ]);

    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: inputEvent("late", ROOM_A, ended.taskId, ended.jobId) });
    expect(state.byId.late).toBeUndefined();
    state = reduceCodexRequestLifecycle(state, { kind: "dismiss", requestId: ended.requestId });
    expect(selectCodexRequestsForRoom(state, ROOM_A, "owner-a").requests).toEqual([]);
  });

  test("does not resurrect unavailable/reconciled cards and preserves pre-fetch submit state", () => {
    let state = initialCodexRequestLifecycleState();
    const unavailable = inputEvent("unavailable");
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: [recovered(unavailable, "unavailable")], baselineRequestIds: [], newerActions: [{ kind: "arm", event: unavailable }],
    });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: unavailable });
    expect(selectCodexRequestsForRoom(state, ROOM_A, "owner-a").requests[0]?.availability).toBe("unavailable");

    const submitting = inputEvent("submitting");
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: submitting });
    state = reduceCodexRequestLifecycle(state, { kind: "submit_start", requestId: submitting.requestId });
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: [recovered(submitting)], baselineRequestIds: [submitting.requestId], newerActions: [],
    });
    expect(state.submittingRequestId).toBe(submitting.requestId);
    state = reduceCodexRequestLifecycle(state, { kind: "submit_failed", requestId: submitting.requestId, message: "retry" });
    expect(state.errors[submitting.requestId]).toBe("retry");
    state = reduceCodexRequestLifecycle(state, { kind: "submit_accepted", requestId: submitting.requestId });
    expect(state.byId[submitting.requestId]).toBeUndefined();
  });

  test("does not infer terminal absence for an active submit or a saturated recovery page", () => {
    let state = initialCodexRequestLifecycleState();
    const submitting = inputEvent("submitting-omitted");
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: submitting });
    state = reduceCodexRequestLifecycle(state, { kind: "submit_start", requestId: submitting.requestId });
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: [], baselineRequestIds: [submitting.requestId], newerActions: [],
    });
    expect(state.byId[submitting.requestId]).toEqual(submitting);
    expect(state.submittingRequestId).toBe(submitting.requestId);

    const olderBaseline = inputEvent("older-baseline");
    state = reduceCodexRequestLifecycle(state, { kind: "submit_accepted", requestId: submitting.requestId });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: olderBaseline });
    const fullNewestFirst = Array.from({ length: 16 }, (_, index) => recovered(inputEvent(`page-${index}`)));
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: fullNewestFirst, baselineRequestIds: [olderBaseline.requestId], newerActions: [],
    });
    expect(state.byId[olderBaseline.requestId]).toEqual(olderBaseline);
  });

  test("filters another owner synchronously and reset clears all retained state", () => {
    let state = initialCodexRequestLifecycleState();
    const owned = inputEvent("owned");
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: owned });
    expect(selectCodexRequestsForRoom(state, ROOM_A, "owner-b").requests).toEqual([]);
    expect(isCodexRequestForViewer(owned, "owner-a")).toBe(true);
    expect(isCodexOwner("owner-a", "owner-b")).toBe(false);
    const wrongOwner = { ...inputEvent("wrong-owner"), ownerId: "owner-b" };
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: [recovered(wrongOwner)], baselineRequestIds: [owned.requestId], newerActions: [],
    });
    expect(state.byId[owned.requestId]).toEqual(owned);
    const wrongRoom = inputEvent("wrong-room", ROOM_B);
    state = reduceCodexRequestLifecycle(state, {
      kind: "hydrate_room", roomId: ROOM_A, ownerId: "owner-a", items: [recovered(wrongRoom)], baselineRequestIds: [owned.requestId], newerActions: [],
    });
    expect(state.byId[owned.requestId]).toEqual(owned);
    state = reduceCodexRequestLifecycle(state, { kind: "reset_owner" });
    expect(state.order).toEqual([]);
    expect(state.terminalRequestIds).toEqual([]);
  });
});
