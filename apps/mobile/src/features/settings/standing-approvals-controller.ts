import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getApiClient } from "@/lib/api";
import {
  settingsScopeForVerifiedViewer,
  type SettingsMutationResult,
} from "@/features/settings/settings-data-state";
import {
  createStandingApprovalsController,
  standingApprovalsFailure,
  type StandingApproval,
  type StandingApprovalsApi,
  type StandingApprovalsScreenState,
} from "@/features/settings/standing-approvals-state";

export function useStandingApprovals({
  server,
  authStatus,
  viewerId,
  viewerActorId,
  viewerState,
}: {
  server: { id: string; serverUrl: string } | null;
  authStatus: string;
  viewerId: string | null;
  viewerActorId: string | null;
  viewerState: string;
}): {
  state: StandingApprovalsScreenState;
  retry: () => Promise<void>;
  revoke: (id: string) => Promise<SettingsMutationResult<StandingApproval[]>>;
} {
  const controllerRef = useRef(createStandingApprovalsController());
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
  const api = useMemo<StandingApprovalsApi>(() => ({
    async list(requestScope) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      return getApiClient(server.serverUrl).listStandingApprovals();
    },
    async revoke(requestScope, id) {
      if (!server || server.id !== requestScope.serverId) throw new Error("Active server changed.");
      await getApiClient(server.serverUrl).revokeStandingApproval(id);
    },
  }), [server]);

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load(api);
  }, [api, controller, scope]);

  useEffect(() => () => controller.setScope(null), [controller]);

  const retry = useCallback(async () => {
    if (scope) await controller.retry(api);
  }, [api, controller, scope]);
  const revoke = useCallback(async (id: string) => {
    return await controller.revoke(id, api);
  }, [api, controller]);

  if (!scope) {
    if (authStatus === "signed-out") return { state: { kind: "signed-out" }, retry, revoke };
    return { state: { kind: "loading" }, retry, revoke };
  }
  if (dataState.data) {
    return {
      state: {
        kind: "ready",
        approvals: dataState.data,
        mutating: dataState.mutating,
        mutationFailure: dataState.mutationError ? standingApprovalsFailure(dataState.mutationError) : null,
        canonicalRefreshPending: controller.hasPendingCanonicalRefresh(),
      },
      retry,
      revoke,
    };
  }
  if (dataState.loadError) return { state: standingApprovalsFailure(dataState.loadError), retry, revoke };
  return { state: { kind: "loading" }, retry, revoke };
}
