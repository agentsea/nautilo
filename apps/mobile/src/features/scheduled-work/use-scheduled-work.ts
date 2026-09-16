import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";

import { getApiClient } from "@/lib/api";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import {
  createScheduledWorkController,
  scheduledWorkFailure,
  scheduledWorkRows,
  type ScheduledWorkApi,
  type ScheduledWorkFailure,
} from "./scheduled-work-state";
import { useTaskWorkScope } from "@/features/task-work/use-task-work-scope";

/** Binds scheduled-work data to the active verified owner and nothing else. */
export function useScheduledWork({
  server,
  authStatus,
  viewerId,
  viewerActorId,
  viewerState,
  canInvokeAgents,
  viewerIdentity,
}: {
  server: { id: string; serverUrl: string } | null;
  authStatus: string;
  viewerId: string | null;
  viewerActorId: string | null;
  viewerState: string;
  canInvokeAgents: boolean;
  viewerIdentity: object | null;
}) {
  const controllerRef = useRef(createScheduledWorkController());
  const controller = controllerRef.current;
  // `canonicalRefreshPending` is controller-derived state rather than a
  // SettingsDataState field. Its last transition happens after a request
  // settles, so observe public operations to publish that final transition.
  const [, refreshDerivedState] = useReducer((revision: number) => revision + 1, 0);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const subscribeDetail = useCallback((listener: () => void) => controller.subscribeDetail(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const getDetailSnapshot = useCallback(() => controller.getDetailState(), [controller]);
  const listState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const detailState = useSyncExternalStore(subscribeDetail, getDetailSnapshot, getDetailSnapshot);
  const scope = useMemo(
    () => settingsScopeForVerifiedViewer(server, {
      status: authStatus,
      viewerState,
      viewer: viewerId && viewerActorId && viewerState === "verified"
        ? { userId: viewerId, actorId: viewerActorId }
        : null,
    }),
    [authStatus, server, viewerActorId, viewerId, viewerState],
  );
  const detailScope = useTaskWorkScope({ server, authStatus, viewerId, viewerActorId, viewerState, canInvokeAgents, viewerIdentity });
  const api = useMemo<ScheduledWorkApi>(() => ({
    async list(requestScope) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      return getApiClient(server.serverUrl).listActiveTasks();
    },
    async detail(requestScope, id) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      return getApiClient(server.serverUrl).getTask(id);
    },
    async pause(requestScope, id) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      await getApiClient(server.serverUrl).pauseTask(id);
    },
    async resume(requestScope, id) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      await getApiClient(server.serverUrl).unpauseTask(id);
    },
    async stop(requestScope, id) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      await getApiClient(server.serverUrl).stopTask(id);
    },
  }), [server]);

  useEffect(() => {
    controller.setScope(scope, server?.serverUrl ?? null, detailScope);
  }, [controller, detailScope, scope, server?.serverUrl]);
  useFocusEffect(useCallback(() => {
    if (scope) void controller.load(api);
  }, [api, controller, scope]));
  useEffect(() => () => controller.dispose(), [controller]);

  const observe = useCallback(<T,>(operation: Promise<T>): Promise<T> =>
    operation.finally(() => refreshDerivedState()), []);
  const retry = useCallback(() => observe(
    scope ? controller.retry(api) : Promise.resolve({ status: "ignored" as const }),
  ), [api, controller, observe, scope]);
  const openDetail = useCallback((id: string) => controller.getDetail(id, api), [api, controller]);
  const closeDetail = useCallback(() => controller.clearDetail(), [controller]);
  const pause = useCallback((id: string) => observe(controller.pause(id, api)), [api, controller, observe]);
  const resume = useCallback((id: string) => observe(controller.resume(id, api)), [api, controller, observe]);
  const stop = useCallback((id: string) => observe(controller.stop(id, api)), [api, controller, observe]);

  const failure: ScheduledWorkFailure | null = listState.loadError
    ? scheduledWorkFailure(listState.loadError)
    : null;
  return {
    scope,
    rows: scheduledWorkRows(listState.data ?? []),
    loading: listState.loading,
    mutating: listState.mutating,
    mutationError: listState.mutationError,
    canonicalRefreshPending: controller.hasPendingCanonicalRefresh(),
    failure,
    detail: detailState.data,
    detailLoading: detailState.loading,
    detailError: detailState.error,
    retry,
    openDetail,
    closeDetail,
    pause,
    resume,
    stop,
  };
}
