/**
 * M151 (Task Phase 7a) — unit guards for the await-response substrate.
 *
 * The await/resume park is raised by `awaitReplyNode` via LangGraph's
 * `interrupt()`, which only behaves correctly inside a running graph (the
 * full park → checkpoint → resume cycle is exercised by the runtime
 * integration suite against real Postgres). These unit tests lock the two
 * deterministic, DB-free invariants:
 *
 *   1. `awaitReplyNode` is a NO-OP when `awaitResponse` is false — the load-
 *      bearing regression guard that ordinary turns (and the resumed
 *      post-reply turn, which clears the flag) reach real END instead of
 *      parking.
 *   2. `interruptValueToServerEvent` maps an `await_human_reply` interrupt to
 *      the owner-scoped `task.awaiting_reply` WS event with the right fields.
 */
import { describe, expect, test } from "bun:test";
import { awaitReplyNode } from "../../src/nodes/await-reply";
import { interruptValueToServerEvent } from "../../src/graph/interrupt-mapping";
import type { NautiloState } from "../../src/agent/state";

describe("M151 — awaitReplyNode", () => {
  test("returns {} (no interrupt) when awaitResponse is false", () => {
    const state = { awaitResponse: false } as unknown as NautiloState;
    expect(awaitReplyNode(state)).toEqual({});
  });
});

describe("M151 — interruptValueToServerEvent(await_human_reply)", () => {
  test("maps to owner-scoped task.awaiting_reply with all fields", () => {
    const ev = interruptValueToServerEvent(
      {
        type: "await_human_reply",
        targetRoomId: "room-1",
        awaitingFromUserIds: ["u-peer", "u-req"],
        taskId: "task-1",
        taskRunId: "run-1",
        ownerId: "owner-1",
      },
      "thread-1",
      "task:task-1",
    );
    expect(ev).toEqual({
      type: "task.awaiting_reply",
      threadId: "thread-1",
      laneKey: "task:task-1",
      targetRoomId: "room-1",
      awaitingFromUserIds: ["u-peer", "u-req"],
      taskId: "task-1",
      taskRunId: "run-1",
      ownerId: "owner-1",
    });
  });

  test("tolerates a missing taskId/taskRunId (omits them) and defaults arrays", () => {
    const ev = interruptValueToServerEvent(
      { type: "await_human_reply", targetRoomId: "room-2", ownerId: "owner-2" },
      "thread-2",
      "task:task-2",
    );
    expect(ev).toMatchObject({
      type: "task.awaiting_reply",
      targetRoomId: "room-2",
      awaitingFromUserIds: [],
      ownerId: "owner-2",
    });
    expect(ev && "taskId" in ev).toBe(false);
    expect(ev && "taskRunId" in ev).toBe(false);
  });
});
