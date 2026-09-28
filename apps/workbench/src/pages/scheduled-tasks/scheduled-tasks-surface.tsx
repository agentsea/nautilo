import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Search } from "lucide-react";
import { ScheduledTaskCard } from "./ScheduledTaskCard";
import { ProtectedScheduledTaskCard } from "./ProtectedScheduledTaskCard";
import { filterBySearch } from "./scheduled-tasks-view-model";
import { useScheduledTasks } from "./use-scheduled-tasks";

/**
 * D406 / Stack 200 — Scheduled tasks as a full-width management route (peer
 * of Memory / Commands / Skills / Approvals). Rendered through normal
 * management routing (see `app.tsx`); the shell hides both side panels via
 * the shared `isFullWidthManagementRoute` predicate. No top-level X / onClose
 * — exit via normal route navigation (rail, back, or clicking Files/Artifacts).
 */
export function ScheduledTasksSurface(): ReactElement {
  const { tasks, protectedTasks, protectedLoading, loading, error,
    busyIds, disable, enable, remove } = useScheduledTasks();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => filterBySearch(tasks, query), [tasks, query]);
  const protectedVisible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return protectedTasks;
    return protectedTasks.filter((row) => [
      row.availability === "opened" ? row.prompt : "protected locked waiting authorization",
      row.task.agentName ?? "",
      row.task.cron ?? "",
      row.task.scheduleKind,
      row.task.status,
      "protected",
    ].join(" ").toLowerCase().includes(normalized));
  }, [protectedTasks, query]);

  return (
    <div
      data-testid="scheduled-tasks"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground">Scheduled tasks</h1>
          <p className="mt-0.5 truncate text-[11px] text-foreground-muted">
            Recurring and one-off tasks your agents run on a schedule. Toggle one
            off to pause it without deleting it.
          </p>
        </div>
        <div className="relative min-w-[10rem] flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search schedules…"
            aria-label="Search scheduled tasks"
            data-testid="scheduled-tasks-search"
            className="w-full rounded-md border border-border bg-background-element py-1.5 pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading || (protectedLoading && tasks.length === 0
          && protectedTasks.length === 0) ? (
          <p
            className="px-6 py-10 text-sm text-foreground-muted"
            data-testid="scheduled-tasks-loading"
          >
            Loading…
          </p>
        ) : error ? (
          <p
            className="px-6 py-10 text-sm text-red-500"
            role="alert"
            data-testid="scheduled-tasks-error"
          >
            {error}
          </p>
        ) : tasks.length === 0 && protectedTasks.length === 0
          && !protectedLoading ? (
          <p
            className="px-6 py-10 text-sm text-foreground-muted"
            data-testid="scheduled-tasks-empty"
          >
            No scheduled tasks yet. Ask your agent to schedule something — e.g.
            “remind me every weekday at 9am”.
          </p>
        ) : visible.length === 0 && protectedVisible.length === 0 ? (
          <p
            className="px-6 py-10 text-sm text-foreground-muted"
            data-testid="scheduled-tasks-no-matches"
          >
            No schedules match “{query}”.
          </p>
        ) : (
          <ul data-testid="scheduled-tasks-list">
            {visible.map((task) => (
              <ScheduledTaskCard
                key={task.id}
                task={task}
                busy={busyIds.has(task.id)}
                onEnable={enable}
                onDisable={disable}
                onRemove={remove}
              />
            ))}
            {protectedVisible.map((row) => (
              <ProtectedScheduledTaskCard
                key={row.task.id}
                row={row}
                busy={busyIds.has(row.task.id)}
                onEnable={enable}
                onDisable={disable}
                onRemove={remove}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
