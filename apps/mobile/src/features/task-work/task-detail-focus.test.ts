import { expect, test } from "bun:test";

import { taskDetailFocusRefreshDecision } from "./task-detail-focus";
import type { TaskDetailTarget } from "./task-detail-state";

const target: TaskDetailTarget = { serverId: "server", serverUrl: "https://server", userId: "user", actorId: "actor", viewerEpoch: 1, taskId: "b487068d-9720-4f0f-a7a0-e84d9e4bff54" };

test("focus does one blocking load after capability loss then same-target regain", () => {
  const first = taskDetailFocusRefreshDecision(null, target);
  expect(first.refresh).toBeFalse();
  const lost = taskDetailFocusRefreshDecision(first.next, null);
  expect(lost).toEqual({ next: null, refresh: false });
  const regained = taskDetailFocusRefreshDecision(lost.next, target);
  expect(regained.refresh).toBeFalse();
  expect(taskDetailFocusRefreshDecision(regained.next, target).refresh).toBeTrue();
});
