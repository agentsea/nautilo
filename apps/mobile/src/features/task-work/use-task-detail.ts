import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";

import { getApiClient } from "@/lib/api";
import { useRealtime } from "@/providers/realtime";
import {
  createTaskDetailController,
  isExactTaskId,
  sameTaskDetailTarget,
  type TaskDetailApi,
  type TaskDetailTarget,
} from "./task-detail-state";
import {
  createTaskDetailLiveActivityController,
  sameTaskDetailLiveActivityTarget,
  taskDetailLiveActivityText,
} from "./task-detail-live-activity";
import {
  createTaskDetailLifecycleController,
  taskDetailLifecycleActions,
  type TaskDetailLifecycleApi,
} from "./task-detail-lifecycle";
import { taskDetailFocusRefreshDecision } from "./task-detail-focus";
import { useTaskWorkScope } from "./use-task-work-scope";

/** Binds a route-owned exact Task reader to the active authenticated identity. */
export function useTaskDetail({
  taskId,
  server,
  authStatus,
  viewerId,
  viewerActorId,
  viewerState,
  canInvokeAgents,
  viewerIdentity,
}: {
  taskId: string | null;
  server: { id: string; serverUrl: string } | null;
  authStatus: string;
  viewerId: string | null;
  viewerActorId: string | null;
  viewerState: string;
  canInvokeAgents: boolean;
  viewerIdentity: object | null;
}) {
  const { subscribe: subscribeRealtime } = useRealtime();
  const controllerRef = useRef(createTaskDetailController());
  const controller = controllerRef.current;
  const liveActivityControllerRef = useRef(createTaskDetailLiveActivityController());
  const liveActivityController = liveActivityControllerRef.current;
  const lifecycleControllerRef = useRef(createTaskDetailLifecycleController());
  const lifecycleController = lifecycleControllerRef.current;
  const scope = useTaskWorkScope({ server, authStatus, viewerId, viewerActorId, viewerState, canInvokeAgents, viewerIdentity });
  const target = useMemo<TaskDetailTarget | null>(() =>
    scope && server && isExactTaskId(taskId) ? { ...scope, serverUrl: server.serverUrl, taskId } : null,
  [scope, server, taskId]);
  const api = useMemo<TaskDetailApi>(() => ({
    async detail(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) {
        throw new Error("Active server changed.");
      }
      return getApiClient(requestTarget.serverUrl).getTask(requestTarget.taskId);
    },
  }), [server]);
  const lifecycleApi = useMemo<TaskDetailLifecycleApi>(() => ({
    async pause(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) throw new Error("Active server changed.");
      return getApiClient(requestTarget.serverUrl).pauseTask(requestTarget.taskId);
    },
    async resume(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) throw new Error("Active server changed.");
      return getApiClient(requestTarget.serverUrl).unpauseTask(requestTarget.taskId);
    },
    async stop(requestTarget) {
      if (!server || server.id !== requestTarget.serverId || server.serverUrl !== requestTarget.serverUrl) throw new Error("Active server changed.");
      return getApiClient(requestTarget.serverUrl).stopTask(requestTarget.taskId);
    },
    reconcile(requestTarget) {
      if (!sameTaskDetailTarget(requestTarget, target)) return Promise.resolve({ status: "ignored" as const });
      return controller.reconcileAfterMutation(api);
    },
  }), [api, controller, server, target]);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const subscribeLiveActivity = useCallback((listener: () => void) => liveActivityController.subscribe(listener), [liveActivityController]);
  const getLiveActivitySnapshot = useCallback(() => liveActivityController.getState(), [liveActivityController]);
  const liveActivity = useSyncExternalStore(subscribeLiveActivity, getLiveActivitySnapshot, getLiveActivitySnapshot);
  const subscribeLifecycle = useCallback((listener: () => void) => lifecycleController.subscribe(listener), [lifecycleController]);
  const getLifecycleSnapshot = useCallback(() => lifecycleController.getState(), [lifecycleController]);
  const lifecycle = useSyncExternalStore(subscribeLifecycle, getLifecycleSnapshot, getLifecycleSnapshot);
  // Effects install the new controller target after render. Never let that
  // scheduling gap paint a prior Task's identity under a new route locator.
  const visibleState = sameTaskDetailTarget(state.target, target)
    ? state
    : { target, data: null, loading: target !== null, unavailable: false, authRequired: false, error: null };

  useEffect(() => {
    controller.setTarget(target);
    liveActivityController.setTarget(target);
    lifecycleController.setTarget(target);
    if (target) void controller.load(api);
  }, [api, controller, lifecycleController, liveActivityController, target]);
  useEffect(() => () => { controller.dispose(); liveActivityController.dispose(); lifecycleController.dispose(); }, [controller, lifecycleController, liveActivityController]);
  useEffect(() => {
    if (!target) return;
    return subscribeRealtime((event) => {
      // Progress updates are already exact and do not need to turn one active
      // run into GET polling. Other lifecycle bytes coalesce in the reader.
      if (liveActivityController.apply(event, target)) void controller.refresh(api);
    });
  }, [api, controller, liveActivityController, subscribeRealtime, target]);
  useEffect(() => {
    if (!sameTaskDetailTarget(visibleState.target, target) || !visibleState.data) return;
    const latest = visibleState.data.runs.at(-1);
    if (liveActivityController.seedCanonical({
      taskStatus: visibleState.data.task.status,
      latestRun: latest ? { id: latest.id, status: latest.status } : null,
    })) void controller.refresh(api);
  }, [liveActivityController, target, visibleState.data, visibleState.target]);
  const firstFocusTargetRef = useRef<TaskDetailTarget | null>(null);
  useFocusEffect(useCallback(() => {
    const decision = taskDetailFocusRefreshDecision(firstFocusTargetRef.current, target);
    firstFocusTargetRef.current = decision.next;
    if (decision.refresh) void controller.refresh(api);
  }, [api, controller, target]));
  // Realtime repairs identity before publishing recovery. The resulting fresh
  // viewer object advances target.viewerEpoch, and setTarget clears both the
  // canonical reader and provisional live activity before the one load above.
  useEffect(() => {
    if (!visibleState.data || !sameTaskDetailTarget(visibleState.target, target)) return;
    lifecycleController.observeCanonical(visibleState.data.task.status);
  }, [lifecycleController, target, visibleState.data, visibleState.target]);

  return {
    ...visibleState,
    target,
    validTaskId: isExactTaskId(taskId),
    liveActivity: visibleState.data
      ? taskDetailLiveActivityText(
        sameTaskDetailLiveActivityTarget(liveActivity.target, target) ? liveActivity : { progress: null, status: null, awaitingReply: false },
        visibleState.data.task.status,
      )
      : null,
    liveHarnessActivity: sameTaskDetailLiveActivityTarget(liveActivity.target, target) ? liveActivity.activity : null,
    refresh: useCallback(() => controller.refresh(api), [api, controller]),
    lifecycle: {
      ...lifecycle,
      actions: taskDetailLifecycleActions(visibleState.data?.task.status ?? null),
      act: useCallback((action: "pause" | "resume" | "stop") => lifecycleController.act(action, visibleState.data?.task.status ?? null, lifecycleApi), [lifecycleApi, lifecycleController, visibleState.data?.task.status]),
      reload: useCallback(() => lifecycleController.reload(lifecycleApi), [lifecycleApi, lifecycleController]),
    },
  };
}
