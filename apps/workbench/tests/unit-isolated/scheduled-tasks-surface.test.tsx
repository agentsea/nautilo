import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TaskSummary } from "@nautilo/types";
import type { ScheduledTasksState } from
  "../../src/pages/scheduled-tasks/use-scheduled-tasks";

const refresh = mock(async () => {});

function ordinaryTask(id: string): TaskSummary {
  return {
    id,
    parentTaskId: null,
    depth: 0,
    status: "pending",
    preset: "schedule",
    prompt: "Send a weekly digest",
    scheduleKind: "cron",
    cron: "0 9 * * 1",
    nextFireAt: "2026-10-12T09:00:00.000Z",
    callingRoomId: null,
  };
}

const baseState: ScheduledTasksState = {
  tasks: [],
  protectedTasks: [],
  protectedLoading: false,
  protectedError: null,
  loading: false,
  error: null,
  busyIds: new Set<string>(),
  refresh,
  disable: () => {},
  enable: () => {},
  remove: () => {},
};

let scheduledState = baseState;

mock.module("../../src/pages/scheduled-tasks/use-scheduled-tasks", () => ({
  useScheduledTasks: () => scheduledState,
}));

const { ScheduledTasksSurface } = await import(
  "../../src/pages/scheduled-tasks/scheduled-tasks-surface"
);

describe("ScheduledTasksSurface protected refresh failures", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    cleanup();
    refresh.mockClear();
    scheduledState = baseState;
  });

  test("shows the protected error with loaded ordinary and protected rows and retries", () => {
    scheduledState = {
      ...baseState,
      tasks: [ordinaryTask("ordinary-task")],
      protectedTasks: [{
        availability: "unavailable",
        task: {
          id: "protected-task",
          scheduleKind: "cron",
          status: "pending",
          cron: "0 10 * * 1",
          nextFireAt: "2026-10-12T10:00:00.000Z",
          content: {
            dtoVersion: 1,
            status: "unavailable",
            reason: "waiting_for_authorization",
          },
        },
        reason: "waiting_for_authorization",
      }],
      protectedError: "temporarily unavailable",
    };

    const view = render(<ScheduledTasksSurface />);
    expect(view.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(view.getByTestId("scheduled-task-row")).toBeTruthy();
    expect(view.getByTestId("protected-scheduled-task-row")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("keeps the Plain list unchanged without protected error or retry UI", () => {
    scheduledState = { ...baseState, tasks: [ordinaryTask("plain-task")] };

    const view = render(<ScheduledTasksSurface />);
    expect(view.getByTestId("scheduled-task-row")).toBeTruthy();
    expect(view.queryByTestId("scheduled-tasks-protected-error")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("keeps the original Plain loading replacement when rows already exist", () => {
    scheduledState = {
      ...baseState,
      tasks: [ordinaryTask("plain-task")],
      loading: true,
    };

    const view = render(<ScheduledTasksSurface />);
    expect(view.getByTestId("scheduled-tasks-loading")).toBeTruthy();
    expect(view.queryByTestId("scheduled-task-row")).toBeNull();
  });

  test("keeps loaded rows visible while the protected list refreshes", () => {
    scheduledState = {
      ...baseState,
      tasks: [ordinaryTask("ordinary-task")],
      loading: true,
      protectedLoading: true,
    };

    const view = render(<ScheduledTasksSurface />);
    expect(view.queryByTestId("scheduled-tasks-loading")).toBeNull();
    expect(view.getByTestId("scheduled-task-row")).toBeTruthy();
  });
});
