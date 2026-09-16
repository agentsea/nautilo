import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getApiClient } from "@/lib/api";
import { useRealtime } from "@/providers/realtime";
import {
  createTaskWorkController,
  taskWorkViewState,
  type TaskWorkApi,
} from "./task-work-state";
import { useTaskWorkScope } from "./use-task-work-scope";

/**
 * Binds the one Task controller to the active verified owner. This deliberately
 * owns no Room, focus, realtime, or persisted state; 2.2 will feed its live
 * overlay only after the canonical initial-load boundary is established here.
 */
export function useTaskWork({
  server,
  authStatus,
  viewerId,
  viewerActorId,
  viewerState,
  /** Existing capability authority; Tasks are unavailable when it is revoked. */
  canInvokeAgents,
  /** AuthProvider's viewer object fences reauth even when its IDs are unchanged. */
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
  const { subscribe: subscribeRealtime } = useRealtime();
  const controllerRef = useRef(createTaskWorkController());
  const controller = controllerRef.current;
  const scope = useTaskWorkScope({ server, authStatus, viewerId, viewerActorId, viewerState, canInvokeAgents, viewerIdentity });
  const api = useMemo<TaskWorkApi>(() => ({
    async list(requestScope) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      return getApiClient(server.serverUrl).listTasks({ includeTerminal: true, recentTerminalLimit: 5 });
    },
  }), [server]);
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load(api);
  }, [api, controller, scope]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (!scope) return;
    return subscribeRealtime((event) => controller.applyRealtimeEvent(event, api));
  }, [api, controller, scope, subscribeRealtime]);

  // Successful realtime recovery publishes a fresh viewer identity first.
  // That advances scope.viewerEpoch, so setScope clears provisional overlays
  // and the scope effect performs exactly one canonical load.

  const refresh = useCallback(
    () => scope ? controller.retry(api) : Promise.resolve({ status: "ignored" as const }),
    [api, controller, scope],
  );
  return {
    ...taskWorkViewState(state, scope),
    refresh,
  };
}
