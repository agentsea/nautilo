import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { classifyDataOperationFailure } from "@nautilo/lattice-bridge";
import type { TaskSummary } from "@nautilo/types";
import { useTaskState } from "../../contexts/task-state/task-state-context";
import { filterScheduledTasks } from "./scheduled-tasks-view-model";
import { useAuth } from "../../hooks/use-auth";
import { useConversationEncryptionPolicyMode } from
  "../../adapters/runtime-contexts";
import { createWorkbenchDataOperationOwner } from
  "../../lib/encryption-data-operation-policy";
import {
  createWorkbenchProtectedHumanTaskController,
  listProtectedScheduledTasks,
  type ProtectedScheduledTaskProjection,
} from "../../lib/protected-human-task-controller";
import { taskContentViewerScopeKey } from
  "../../modes/rooms/subagents/task-content-viewer-scope";

export type ProtectedScheduledTaskRow = ProtectedScheduledTaskProjection;

function isDormantProtectedTaskRoute(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 405 || status === 501;
}

function isTransientProtectedTaskListError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 425 || error.status === 429
      || error.status >= 500;
  }
  const failure = classifyDataOperationFailure(error);
  return failure === "recoverable_availability";
}

/**
 * D406 — data hook for the Scheduled tasks management page.
 *
 * M214 Phase 8 — consumes the owner-scoped canonical task store (seeded once
 * at runtime mount / WS open, enriched by `tasks.*` WS events). Polls only
 * while this hook is enabled (dashboard visible), using completion-based
 * scheduling with no overlapping refreshes.
 */

export interface ScheduledTasksState {
  tasks: TaskSummary[];
  protectedTasks: readonly ProtectedScheduledTaskRow[];
  protectedLoading: boolean;
  protectedError: string | null;
  loading: boolean;
  error: string | null;
  /** Task ids with an in-flight lifecycle action (disable their controls). */
  busyIds: ReadonlySet<string>;
  refresh: () => Promise<void>;
  disable: (taskId: string) => void;
  enable: (taskId: string) => void;
  remove: (taskId: string) => void;
}

export function useScheduledTasks(enabled = true): ScheduledTasksState {
  const auth = useAuth();
  const policyMode = useConversationEncryptionPolicyMode();
  const {
    tasks: allTasks,
    loading,
    error,
    lastSuccessfulAtMs,
    busyIds,
    refresh: refreshTasks,
    pauseTask,
    unpauseTask,
    stopTask,
    setDashboardPollingEnabled,
  } = useTaskState();
  const protectedOwner = useMemo(() => createWorkbenchDataOperationOwner(), []);
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const protectedController = useMemo(() => {
    if (
      policyMode === "plaintext_only"
      || policyMode === "unknown"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null
      || serverOrigin.length === 0
    ) return undefined;
    return createWorkbenchProtectedHumanTaskController({
      owner: protectedOwner,
      serverScope: serverOrigin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
  }, [auth.viewer.isVerified, auth.viewer.sessionActorId,
    auth.viewer.sessionUserId, policyMode, protectedOwner, serverOrigin]);
  const protectedScopeKey = taskContentViewerScopeKey({
    serverOrigin,
    viewerGeneration: auth.viewerGeneration,
    viewerId: auth.viewer.sessionUserId,
    actorId: auth.viewer.sessionActorId,
    viewerVerified: auth.viewer.isVerified,
    policyMode,
  });
  const [protectedState, setProtectedState] = useState<Readonly<{
    scopeKey: string;
    rows: readonly ProtectedScheduledTaskRow[];
    loading: boolean;
    error: string | null;
  }>>({ scopeKey: protectedScopeKey, rows: [], loading: false, error: null });
  const [protectedRefreshGeneration, setProtectedRefreshGeneration] = useState(0);
  const dormantProtectedRouteScopeRef = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setProtectedRefreshGeneration((generation) => generation + 1);
    await refreshTasks();
  }, [refreshTasks]);

  useEffect(() => {
    setDashboardPollingEnabled(enabled);
    return () => setDashboardPollingEnabled(false);
  }, [enabled, setDashboardPollingEnabled]);

  useEffect(() => {
    let current = true;
    if (dormantProtectedRouteScopeRef.current !== null
      && dormantProtectedRouteScopeRef.current !== protectedScopeKey) {
      dormantProtectedRouteScopeRef.current = null;
    }
    const canLoad = enabled && protectedController !== undefined
      && dormantProtectedRouteScopeRef.current !== protectedScopeKey;
    setProtectedState((previous) => previous.scopeKey === protectedScopeKey
      ? { ...previous, loading: canLoad, error: null }
      : {
          scopeKey: protectedScopeKey,
          rows: [],
          loading: canLoad,
          error: null,
        });
    if (!canLoad || protectedController === undefined) {
      return () => { current = false; };
    }
    void listProtectedScheduledTasks(protectedController).then((opened) => {
      if (!current) return;
      setProtectedState({
        scopeKey: protectedScopeKey,
        rows: opened,
        loading: false,
        error: null,
      });
    }).catch((cause: unknown) => {
      if (!current) return;
      const dormantRoute = isDormantProtectedTaskRoute(cause);
      if (dormantRoute) {
        dormantProtectedRouteScopeRef.current = protectedScopeKey;
      }
      setProtectedState((previous) => ({
        scopeKey: protectedScopeKey,
        rows: !dormantRoute && isTransientProtectedTaskListError(cause)
          && previous.scopeKey === protectedScopeKey ? previous.rows : [],
        loading: false,
        error: dormantRoute
          ? null
          : cause instanceof Error ? cause.message : String(cause),
      }));
    });
    return () => { current = false; };
  }, [enabled, lastSuccessfulAtMs, protectedController,
    protectedRefreshGeneration, protectedScopeKey]);

  const tasks = useMemo(
    () => filterScheduledTasks(allTasks),
    [allTasks],
  );

  const disable = useCallback(
    (taskId: string) => void pauseTask(taskId),
    [pauseTask],
  );
  const enable = useCallback(
    (taskId: string) => void unpauseTask(taskId),
    [unpauseTask],
  );
  const remove = useCallback(
    (taskId: string) => void stopTask(taskId),
    [stopTask],
  );

  return {
    tasks,
    protectedTasks: protectedState.scopeKey === protectedScopeKey
      ? protectedState.rows : [],
    protectedLoading: protectedState.scopeKey === protectedScopeKey
      ? protectedState.loading : false,
    protectedError: protectedState.scopeKey === protectedScopeKey
      ? protectedState.error : null,
    loading,
    error,
    busyIds,
    refresh,
    disable,
    enable,
    remove,
  };
}
