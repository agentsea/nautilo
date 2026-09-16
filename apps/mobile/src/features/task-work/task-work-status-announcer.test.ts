import { expect, test } from "bun:test";

import { EMPTY_TASK_WORK_STATUS_ANNOUNCEMENT, reduceTaskWorkStatusAnnouncement } from "./task-work-status-announcement";
import type { TaskWorkViewState } from "./task-work-state";

const row = (status: "running" | "paused", activity = "Working…") => ({ taskId: "task-a", status, activity });
const view = (rows: readonly ReturnType<typeof row>[]): TaskWorkViewState => ({ kind: "ready", scope: { serverId: "server", userId: "user", actorId: "actor", viewerEpoch: 1 }, selectors: { overviewRows: rows, quiet: false, topRows: [], actionNeeded: [], active: [], paused: [], terminalHistory: [], newlyCompleted: [] } } as unknown as TaskWorkViewState);

test("Task status announcer hydrates and changes scope silently, ignores progress, and announces one lifecycle transition", () => {
  let outcome = reduceTaskWorkStatusAnnouncement({ previous: EMPTY_TASK_WORK_STATUS_ANNOUNCEMENT, scopeKey: "scope-a", view: view([row("running")]) });
  expect(outcome.announcement).toBeNull();
  outcome = reduceTaskWorkStatusAnnouncement({ previous: outcome.state, scopeKey: "scope-a", view: view([row("running", "exact progress changed")]) });
  expect(outcome.announcement).toBeNull();
  outcome = reduceTaskWorkStatusAnnouncement({ previous: outcome.state, scopeKey: "scope-a", view: view([row("paused")]) });
  expect(outcome.announcement).toBe("Delegated work status changed to Paused.");
  outcome = reduceTaskWorkStatusAnnouncement({ previous: outcome.state, scopeKey: "scope-b", view: view([row("running")]) });
  expect(outcome.announcement).toBeNull();
});
