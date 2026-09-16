import { useCallback, useEffect, useMemo } from "react";
import type { TaskSummary } from "@nautilo/types";
import { useTaskState } from "../../contexts/task-state/task-state-context";
import { filterScheduledTasks } from "./scheduled-tasks-view-model";

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
  const {
    tasks: allTasks,
    loading,
    error,
    busyIds,
    refresh,
    pauseTask,
    unpauseTask,
    stopTask,
    setDashboardPollingEnabled,
  } = useTaskState();

  useEffect(() => {
    setDashboardPollingEnabled(enabled);
    return () => setDashboardPollingEnabled(false);
  }, [enabled, setDashboardPollingEnabled]);

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
    loading,
    error,
    busyIds,
    refresh,
    disable,
    enable,
    remove,
  };
}
