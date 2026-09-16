import { expect, test } from "bun:test";

import { taskDetailBackTarget } from "./task-detail-navigation";

test("task detail only uses a valid origin as a no-history chat fallback", () => {
  const roomId = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
  expect(taskDetailBackTarget(roomId)).toEqual({ pathname: "/chat/[roomId]", params: { roomId } });
  expect(taskDetailBackTarget("foreign-room")).toBe("/(drawer)/(tabs)");
});

test("route keeps its fixed AppBar and current-only avatar identity contract", async () => {
  const source = await Bun.file(new URL("./task-detail-route.tsx", import.meta.url)).text();
  expect(source).toContain('headerShown: true');
  expect(source).toContain("<TaskAgentAvatar serverUrl={detail.target!.serverUrl} taskId={task.id}");
  expect(source).toContain("detail.data?.task ?? null");
});

test("route wires lifecycle controls through the fenced detail hook without direct endpoints", async () => {
  const source = await Bun.file(new URL("./task-detail-route.tsx", import.meta.url)).text();
  expect(source).toContain("<TaskDetailLifecycleControls");
  expect(source).toContain("actions={detail.lifecycle.actions}");
  expect(source).toContain("onAction={(action) => void detail.lifecycle.act(action)}");
  expect(source).toContain("onReload={() => void detail.lifecycle.reload()}");
  expect(source).not.toContain("pauseTask(");
  expect(source).not.toContain("unpauseTask(");
  expect(source).not.toContain("stopTask(");
});

test("detail reuses only the exact global Task approval and PIN authority", async () => {
  const source = await Bun.file(new URL("./task-detail-route.tsx", import.meta.url)).text();
  expect(source).toContain("const latestRunId = detail.data?.runs.at(-1)?.id");
  expect(source).toContain("pendingApprovalForTask(task.id, latestRunId)");
  expect(source).toContain("activeChallengeForTask(task.id, latestRunId)");
  expect(source).toContain("<ApprovalCard approval={taskApproval} />");
  expect(source).toContain("onPress={() => presentChallenge(taskChallenge)}");
  expect(source).toContain("Enter PIN to continue task");
  expect(source).not.toMatch(/new .*Modal|useState\(.*pin/i);
});

test("detail exposes no Room-derived metadata and delegates the guarded handoff to its route-owned coordinator", async () => {
  const source = await Bun.file(new URL("./task-detail-route.tsx", import.meta.url)).text();
  expect(source).toContain("useTaskRoomHandoff({");
  expect(source).toContain("attentionPending: taskApproval !== null || taskChallenge !== null");
  expect(source).toContain('accessibilityLabel="Open Room"');
  expect(source).toContain('router.push({ pathname: "/chat/[roomId]", params: { roomId: result.target.targetRoomId } })');
  expect(source.indexOf("if (!roomHandoff.mayNavigate(result.target)) return;")).toBeLessThan(source.indexOf('router.push({ pathname: "/chat/[roomId]"'));
  expect(source).toContain("roomHandoff.reportNavigationFailure()");
  expect(source).not.toContain("targetRoomLabel");
  expect(source).not.toContain("room.label");
});

test("lifecycle controls keep confirmation intentional and clear it when stop becomes invalid", async () => {
  const source = await Bun.file(new URL("./task-detail-lifecycle-controls.tsx", import.meta.url)).text();
  expect(source).toContain('onPress={() => action === "stop" ? setConfirmingStop(true) : onAction(action)}');
  expect(source).toContain("const dismissConfirmation = (): void =>");
  expect(source).toContain("restoreStopFocusRef.current = true;");
  expect(source).toContain('onAction("stop")');
  expect(source).toContain("if (!canStop) {");
  expect(source).toContain("restoreStopFocusRef.current = false;");
  expect(source).toContain("setConfirmingStop(false);");
  expect(source).toContain("<View style={styles.actions}>");
  expect(source.indexOf("<View style={styles.actions}>")).toBeLessThan(source.indexOf("{pendingText ?"));
  expect(source).toContain('scrollable onClose={() => !busy && dismissConfirmation()}');
  expect(source).toContain("accessibilityViewIsModal");
  expect(source).toContain("confirmationCancelRef.current?.focus?.()");
});

test("deleted or unauthorized Tasks keep the route recoverable without exposing server detail", async () => {
  const source = await Bun.file(new URL("./task-detail-route.tsx", import.meta.url)).text();
  expect(source).toContain('title="Task unavailable" message="This task is no longer available."');
  expect(source).toContain("detail.unavailable || !detail.validTaskId");
  // The controller maps 401/403/404 to unavailable before this route renders.
  expect(source).not.toContain("detail.error?.message");
});

test("overview closes before pushing the exact root Task route with only its origin hint", async () => {
  const source = await Bun.file(new URL("../../app/chat/[roomId].tsx", import.meta.url)).text();
  const handoff = source.slice(source.indexOf("const openTaskDetail"), source.indexOf("useEffect(() => {", source.indexOf("const openTaskDetail")));
  expect(handoff).toContain("taskDetailHandoffRef.current.begin({");
  expect(handoff).toContain("openOverviewScopeKey");
  expect(handoff).toContain("currentOverviewScopeKey: overviewScopeKey");
  expect(handoff).toContain("if (handoff.status !== \"navigate\") return;");
  expect(handoff.indexOf('closeOverview("teardown")')).toBeLessThan(handoff.indexOf('router.push({ pathname: "/tasks/[taskId]"'));
  expect(handoff).toContain("params: { taskId: handoff.taskId, originRoomId: handoff.originRoomId }");
  expect(handoff).not.toContain("router.replace");
});

test("native and Mobile Web resolve the same scoped exact-detail route", async () => {
  const [nativeRoute, webRoute] = await Promise.all([
    Bun.file(new URL("../../app/tasks/[taskId].tsx", import.meta.url)).text(),
    Bun.file(new URL("../../app/tasks/[taskId].web.tsx", import.meta.url)).text(),
  ]);
  expect(nativeRoute).toContain('export { default } from "@/features/task-work/task-detail-route"');
  expect(webRoute).toContain('export { default } from "@/features/task-work/task-detail-route"');
});
