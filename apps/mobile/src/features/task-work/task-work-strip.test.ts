/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskProgressEvent } from "@nautilo/types";
import {
  createTaskWorkController,
  taskWorkViewState,
  type TaskWorkApi,
} from "./task-work-state";
import {
  TASK_WORK_FIXTURE_NOW,
  TASK_WORK_LIFECYCLE_FIXTURES,
  taskWorkFixture,
  taskWorkScopeA,
} from "./task-work-lifecycle-fixtures";
import {
  projectTaskWorkStrip,
  reduceTaskWorkStripOpen,
  shouldOpenTaskWorkOverviewFromHandle,
  shouldRenderTaskAgentAvatarImage,
  taskWorkStripInteraction,
  taskAgentAvatarTokenLoaded,
} from "./task-work-strip-presentation";
import type { TaskWorkViewState } from "./task-work-state";

describe("Task work strip", () => {
  test("uses the shared lifecycle fixture for initial appearance, priority, exact progress, and reconnect fallback", async () => {
    const controller = createTaskWorkController();
    const api: TaskWorkApi = {
      list: async () => [
        TASK_WORK_LIFECYCLE_FIXTURES.running,
        TASK_WORK_LIFECYCLE_FIXTURES.awaiting,
        TASK_WORK_LIFECYCLE_FIXTURES.freshError,
      ],
    };
    controller.setScope(taskWorkScopeA);
    await controller.load(api);

    const initial = taskWorkViewState(controller.getState(), taskWorkScopeA, TASK_WORK_FIXTURE_NOW);
    expect(projectTaskWorkStrip(initial)).toMatchObject({
      taskCount: 3,
      row: { taskId: "awaiting", activity: "Needs attention" },
      actionNeeded: true,
    });

    const exactProgress: TaskProgressEvent = {
      type: "task.progress",
      taskId: "running",
      taskRunId: "run-1",
      detail: "run_shell: rg delegated work",
      ownerId: taskWorkScopeA.userId,
    };
    controller.applyRealtimeEvent(exactProgress, api);
    const withExactProgress = taskWorkViewState(controller.getState(), taskWorkScopeA, TASK_WORK_FIXTURE_NOW);
    expect(withExactProgress.selectors.active[0]?.activity).toBe("run_shell: rg delegated work");

    await controller.reconcile({ list: async () => [taskWorkFixture({ id: "running" })] }, { resetLive: true });
    const afterReconnect = taskWorkViewState(controller.getState(), taskWorkScopeA, TASK_WORK_FIXTURE_NOW);
    expect(projectTaskWorkStrip(afterReconnect)).toMatchObject({
      taskCount: 1,
      row: { taskId: "running", activity: "Working…" },
      actionNeeded: false,
    });
  });

  test("only claims deliberate downward center-handle drags", () => {
    expect(shouldOpenTaskWorkOverviewFromHandle({ dx: 2, dy: 14, startX: 120, windowWidth: 360 })).toBeTrue();
    expect(shouldOpenTaskWorkOverviewFromHandle({ dx: 20, dy: 14, startX: 120, windowWidth: 360 })).toBeFalse();
    expect(shouldOpenTaskWorkOverviewFromHandle({ dx: 1, dy: 11, startX: 120, windowWidth: 360 })).toBeFalse();
    expect(shouldOpenTaskWorkOverviewFromHandle({ dx: 1, dy: 20, startX: 10, windowWidth: 360 })).toBeFalse();
    expect(shouldOpenTaskWorkOverviewFromHandle({ dx: 1, dy: 20, startX: 350, windowWidth: 360 })).toBeFalse();
  });

  test("projects one exact top row and only counts strip-relevant work", () => {
    const view = {
      kind: "ready",
      scope: { serverId: "server", userId: "owner", actorId: "actor", viewerEpoch: 1 },
      selectors: {
        quiet: false,
        topRows: [{ taskId: "awaiting", task: { agentName: "Moxie" }, activity: "Waiting for your reply" }],
        overviewRows: [{ taskId: "awaiting" }, { taskId: "paused" }, { taskId: "history" }],
        actionNeeded: [{ taskId: "awaiting" }],
      },
    } as unknown as TaskWorkViewState;
    expect(projectTaskWorkStrip(view)).toMatchObject({
      taskCount: 1,
      actionNeeded: true,
      row: { taskId: "awaiting", activity: "Waiting for your reply" },
    });
    expect(projectTaskWorkStrip({ ...view, kind: "empty" } as unknown as TaskWorkViewState)).toBeNull();
  });

  test("opens once for pull plus tap, then allows later ordinary taps", () => {
    let state = { pullClaimed: false };
    const pull = reduceTaskWorkStripOpen(state, "pull");
    state = pull.state;
    const followingPress = reduceTaskWorkStripOpen(state, "press");
    const release = reduceTaskWorkStripOpen(followingPress.state, "release");
    const newTapStart = reduceTaskWorkStripOpen(release.state, "press-start");
    const laterPress = reduceTaskWorkStripOpen(newTapStart.state, "press");
    expect([pull.shouldOpen, followingPress.shouldOpen, laterPress.shouldOpen]).toEqual([true, false, true]);
  });

  test("suppresses a ghost press after release but a new press-start restores the next independent tap", () => {
    const pull = reduceTaskWorkStripOpen({ pullClaimed: false }, "pull");
    const release = reduceTaskWorkStripOpen(pull.state, "release");
    const afterReleasePress = reduceTaskWorkStripOpen(release.state, "press");
    const independentStart = reduceTaskWorkStripOpen(afterReleasePress.state, "press-start");
    const independentPress = reduceTaskWorkStripOpen(independentStart.state, "press");
    expect([pull.shouldOpen, afterReleasePress.shouldOpen, independentPress.shouldOpen]).toEqual([true, false, true]);
  });

  test("changes the expanded strip into a real close control without an open gesture", () => {
    expect(taskWorkStripInteraction({ expanded: false, canOpen: true, canClose: true })).toBe("open");
    expect(taskWorkStripInteraction({ expanded: true, canOpen: true, canClose: true })).toBe("close");
    expect(taskWorkStripInteraction({ expanded: true, canOpen: true, canClose: false })).toBe("inert");
  });

  test("never renders an old server or task bearer while a new avatar scope is loading", () => {
    const old = { scopeKey: "server-a\u0000task-a", headers: { Authorization: "Bearer old" }, imageFailed: false };
    expect(shouldRenderTaskAgentAvatarImage(old, "server-b\u0000task-b")).toBeFalse();
    expect(taskAgentAvatarTokenLoaded(old, "server-b\u0000task-b", "new")).toEqual(old);
    const current = { scopeKey: "server-b\u0000task-b", headers: undefined, imageFailed: false };
    const loaded = taskAgentAvatarTokenLoaded(current, "server-b\u0000task-b", "new");
    expect(shouldRenderTaskAgentAvatarImage(loaded, "server-b\u0000task-b")).toBeTrue();
  });

  test("keeps unsupported capability quiet while preserving an observable state", async () => {
    for (const status of [404, 405, 501]) {
      const controller = createTaskWorkController();
      controller.setScope(taskWorkScopeA);
      const response = await controller.load({
        list: async () => { throw Object.assign(new Error("Task API unavailable"), { status }); },
      });
      const view = taskWorkViewState(controller.getState(), taskWorkScopeA, TASK_WORK_FIXTURE_NOW);
      expect(response).toMatchObject({ status: "failed" });
      expect(view.kind).toBe("unsupported");
      expect(projectTaskWorkStrip(view)).toBeNull();
    }
  });

  test("retains literal-null and accessibility contracts while the route owns the real overview callback", () => {
    const strip = readFileSync(resolve(import.meta.dir, "task-work-strip.tsx"), "utf8");
    const presentation = readFileSync(resolve(import.meta.dir, "task-work-strip-presentation.ts"), "utf8");
    const route = readFileSync(resolve(import.meta.dir, "../../app/chat/[roomId].tsx"), "utf8");
    expect(strip).toContain('if (interaction === "inert") {');
    expect(strip).toContain("<View ref={forwardedRef} accessible={false}");
    expect(strip).not.toContain("disabled={!onOpenOverview}");
    expect(presentation).toContain("view.kind === \"idle\" || view.kind === \"empty\" || view.kind === \"unsupported\"");
    expect(strip).toContain("height: largeText ? 88 : 60");
    expect(strip.match(/numberOfLines=\{1\} ellipsizeMode="tail"/g)).toHaveLength(2);
    expect(strip).toContain("allowFontScaling");
    expect(strip).toContain("useWindowDimensions");
    expect(strip).toContain("const largeText = fontScale >= 1.3");
    expect(strip).toContain('flexDirection: largeText ? "column" : "row"');
    expect(strip).toContain('<Text accessible={false} allowFontScaling={false} style={styles.disclosure}>');
    expect(strip).toContain("flexShrink: 0");
    expect(strip).not.toMatch(/Animated|Reanimated|withTiming/);
    expect(route).toContain("const { focusedBotActorId, isFocused, secondsLeft, toggleFocus } = useRoomFocus(");
    expect(route).toContain("const hasTaskWorkStrip = taskWorkStripServerUrl !== null && projectTaskWorkStrip(taskWork) !== null;");
    expect(route).toContain("{hasTopWorkStack ? <View");
    expect(route).toContain("{hasTaskWorkStrip ? <TaskWorkStrip ref={stripRef} view={taskWork} serverUrl={taskWorkStripServerUrl}");
    expect(route).toContain("if (overviewOpen) return;");
    expect(route).toContain("Keyboard.dismiss();");
    expect(strip).toContain("interaction === \"open\" ? <View {...handleResponder.panHandlers} style={styles.handle} />");
    expect(strip).toContain("Double tap to close delegated work");
    const avatar = readFileSync(resolve(import.meta.dir, "task-agent-avatar.tsx"), "utf8");
    expect(avatar).toContain('<Text accessible={false} allowFontScaling={false} style={styles.shellGlyph}>🐚</Text>');
  });
});
