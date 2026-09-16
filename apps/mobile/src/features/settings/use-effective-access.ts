import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getApiClient } from "@/lib/api";
import {
  createSettingsDataState,
  settingsScopeForVerifiedViewer,
  type SettingsDataScope,
} from "@/features/settings/settings-data-state";

import { effectiveAccessFailure, type EffectiveAccess } from "./access-presentation";

type AuthStatus = "loading" | "signed-in" | "signed-out";

export type EffectiveAccessState =
  | { kind: "loading"; serverId: string | null; viewerId: string | null }
  | { kind: "ready"; serverId: string; viewerId: string | null; access: EffectiveAccess }
  | { kind: "signed-out"; serverId: string | null; viewerId: string | null }
  | { kind: "identity-stale"; serverId: string | null; viewerId: string | null }
  | { kind: "forbidden"; serverId: string; viewerId: string | null }
  | { kind: "failed"; serverId: string; viewerId: string | null; message: string };

export function useEffectiveAccess({
  server,
  authStatus,
  viewerId,
  viewerActorId,
  viewerState,
}: {
  server: { id: string; serverUrl: string } | null;
  authStatus: AuthStatus;
  /** Identity is only a response-fencing key; its capabilities are never read. */
  viewerId: string | null;
  viewerActorId: string | null;
  viewerState: string;
}): { state: EffectiveAccessState; retry: () => Promise<void> } {
  const controllerRef = useRef(createSettingsDataState<EffectiveAccess, null>());
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const dataState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
  const load = useCallback(async (_scope: SettingsDataScope): Promise<EffectiveAccess> => {
    // Scope ownership is fenced by the shared controller. The self endpoint is
    // the only authority for this view; no cached viewer capability is read.
    if (!server) throw new Error("No active server.");
    return getApiClient(server.serverUrl).accessControl.getMyEffectiveAccess();
  }, [server]);

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load(load);
  }, [controller, scope, load]);

  useEffect(() => () => controller.setScope(null), [controller]);

  const retry = useCallback(async () => {
    if (scope) await controller.retryLoad(load);
  }, [controller, scope, load]);

  if (!scope) {
    return {
      retry,
      state: authStatus === "signed-out"
        ? { kind: "signed-out", serverId: server?.id ?? null, viewerId }
        : viewerState === "stale"
          ? { kind: "identity-stale", serverId: server?.id ?? null, viewerId }
          : { kind: "loading", serverId: server?.id ?? null, viewerId },
    };
  }
  if (dataState.data) {
    return { retry, state: { kind: "ready", serverId: scope.serverId, viewerId, access: dataState.data } };
  }
  if (dataState.loadError) {
    return { retry, state: effectiveAccessFailure(dataState.loadError, scope.serverId, viewerId) };
  }
  return { retry, state: { kind: "loading", serverId: scope.serverId, viewerId } };
}
