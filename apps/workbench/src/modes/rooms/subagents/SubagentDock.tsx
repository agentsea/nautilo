import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useRunningSubagents } from "../../../adapters/runtime-contexts";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useTaskState } from "../../../contexts/task-state/task-state-context";
import { SubagentCard } from "./SubagentCard";

/**
 * D307 (Stack 87) — owner-scoped subagent activity dock (§5.12 Option E).
 *
 * Presentational shell over `useRunningSubagents()`: collapses to a single
 * heartbeat line, fills the remaining panel height with the complete scrollable
 * list, and wires shared task lifecycle controls + room navigation.
 * Renders nothing when the live set is empty.
 */
export function SubagentDock({ className }: { readonly className?: string }): ReactElement | null {
  const { list, heartbeat } = useRunningSubagents();
  const { busyIds, pauseTask, unpauseTask, stopTask } = useTaskState();
  const roomNav = useRoomNavigation();
  const accessibleRoomIds = useMemo(
    () => new Set((roomNav.rooms ?? []).map((r) => r.id)),
    [roomNav.rooms],
  );
  const [collapsed, setCollapsed] = useState(false);

  const onStop = useCallback(
    (taskId: string) => void stopTask(taskId),
    [stopTask],
  );
  const onPause = useCallback(
    (taskId: string) => void pauseTask(taskId),
    [pauseTask],
  );
  const onResume = useCallback(
    (taskId: string) => void unpauseTask(taskId),
    [unpauseTask],
  );
  const onJump = useCallback(
    (roomId: string) => {
      roomNav.setActiveRoom(roomId);
    },
    [roomNav],
  );

  if (list.length === 0) return null;

  const count = list.length;

  if (collapsed) {
    return (
      <div
        className={["shrink-0 border-t border-border/70 px-2 py-1.5", className].filter(Boolean).join(" ")}
        data-testid="subagent-dock"
        data-collapsed="true"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label="Expand subagent activity dock"
          className="flex w-full items-center gap-1.5 text-left text-[11px] text-foreground-muted hover:text-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {heartbeat.count} {heartbeat.count === 1 ? "task" : "tasks"} · {heartbeat.line}
          </span>
          <span aria-hidden className="shrink-0 text-[10px]">
            ⌄
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={["flex min-h-0 flex-1 flex-col border-t border-border/70 px-2 py-1.5", className].filter(Boolean).join(" ")}
      data-testid="subagent-dock"
      data-collapsed="false"
    >
      <header className="mb-1 flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-expanded
          aria-label="Collapse subagent activity dock"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="text-[11px] font-semibold text-foreground">Task activity ({count})</span>
          <span aria-hidden className="ml-auto shrink-0 text-[10px] text-foreground-muted">
            ⌃
          </span>
        </button>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain"
        data-testid="subagent-dock-list"
        role="region"
        aria-label="Task activity"
        tabIndex={0}
      >
        {list.map((subagent) => (
          <SubagentCard
            key={subagent.taskId}
            subagent={subagent}
            onStop={onStop}
            onPause={onPause}
            onResume={onResume}
            onJump={onJump}
            canJump={
              subagent.awaitingRoomId ? accessibleRoomIds.has(subagent.awaitingRoomId) : false
            }
            busy={busyIds.has(subagent.taskId)}
          />
        ))}
      </div>
    </div>
  );
}
