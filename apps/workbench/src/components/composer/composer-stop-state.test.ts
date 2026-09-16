import { describe, expect, test } from "bun:test";
import type { TaskSummary } from "@nautilo/types";
import { hasStoppableRoomTask } from "./composer-stop-state";

function task(
  status: string,
  overrides: Partial<TaskSummary> = {},
): TaskSummary {
  return {
    id: "task-1",
    parentTaskId: null,
    depth: 0,
    status,
    preset: "task",
    prompt: "Investigate",
    scheduleKind: "now",
    nextFireAt: null,
    callingRoomId: "room-1",
    targetRoomId: "room-1",
    ...overrides,
  };
}

describe("hasStoppableRoomTask", () => {
  test("recognizes pending, running, and awaiting task work in the active room", () => {
    expect(hasStoppableRoomTask([task("pending")], "room-1")).toBe(true);
    expect(hasStoppableRoomTask([task("running")], "room-1")).toBe(true);
    expect(hasStoppableRoomTask([task("awaiting")], "room-1")).toBe(true);
  });

  test("ignores terminal, paused, other-room, and roomless task work", () => {
    expect(hasStoppableRoomTask([task("completed")], "room-1")).toBe(false);
    expect(hasStoppableRoomTask([task("cancelled")], "room-1")).toBe(false);
    expect(hasStoppableRoomTask([task("paused")], "room-1")).toBe(false);
    expect(hasStoppableRoomTask([task("running")], "room-2")).toBe(false);
    expect(hasStoppableRoomTask([task("running")], null)).toBe(false);
  });

  test("accepts either canonical room association", () => {
    expect(hasStoppableRoomTask([
      task("running", { targetRoomId: null, callingRoomId: "room-1" }),
    ], "room-1")).toBe(true);
    expect(hasStoppableRoomTask([
      task("running", { targetRoomId: "room-1", callingRoomId: null }),
    ], "room-1")).toBe(true);
  });
});
