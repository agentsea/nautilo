import type { TaskSummary } from "@nautilo/types";

const STOPPABLE_TASK_STATUSES = new Set(["pending", "running", "awaiting"]);

/**
 * Task-backed work runs on a task lane, so it does not drive the chat
 * runtime's `isRunning` bit. The room composer still owns one Stop surface
 * for every live job in the room; derive that extra activity from the
 * canonical Task store instead of manufacturing Codex-specific UI state.
 */
export function hasStoppableRoomTask(
  tasks: readonly TaskSummary[],
  roomId: string | null,
): boolean {
  if (!roomId) return false;
  return tasks.some((task) =>
    STOPPABLE_TASK_STATUSES.has(task.status)
    && (task.targetRoomId === roomId || task.callingRoomId === roomId)
  );
}
