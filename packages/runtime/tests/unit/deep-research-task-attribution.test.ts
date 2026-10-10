import { describe, expect, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";
import { deepResearchTaskUsageAttribution } from "../../src/tasks/task-run-executor";

describe("Deep Research Task usage attribution", () => {
  test("uses the canonical origin Room for an orphan Task", () => {
    const task = {
      id: "task-deep-research",
      agentId: "agent-deep-research",
      callingRoomId: "room-return-destination",
      targetChat: "orphan",
      targetRoomId: null,
    } as Pick<Task, "id" | "agentId" | "callingRoomId" | "targetChat" | "targetRoomId">;
    const run = { id: "run-deep-research" } as Pick<TaskRun, "id">;

    expect(deepResearchTaskUsageAttribution(task, run)).toEqual({
      roomId: "room-return-destination",
      taskId: "task-deep-research",
      taskRunId: "run-deep-research",
      agentId: "agent-deep-research",
    });
  });

  test("does not invent a Room when the canonical origin is absent", () => {
    const task = {
      id: "task-legacy-orphan",
      agentId: "agent-legacy-orphan",
      callingRoomId: null,
    } as Pick<Task, "id" | "agentId" | "callingRoomId">;

    expect(deepResearchTaskUsageAttribution(task, { id: "run-legacy-orphan" })).toEqual({
      roomId: null,
      taskId: "task-legacy-orphan",
      taskRunId: "run-legacy-orphan",
      agentId: "agent-legacy-orphan",
    });
  });
});
