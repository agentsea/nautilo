import type { ReactElement } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { DrawerShell } from "../thread-drawer/components/DrawerShell";
import { useRunningSubagents } from "../../../adapters/runtime-contexts";
import { isToolRow } from "./transcript-vm";
import { VirtualTranscriptRows } from "./VirtualTranscriptRows";
export { TranscriptRow } from "./VirtualTranscriptRows";
import { useSubagentTranscript } from "./use-subagent-transcript";
import { StatusGlyph, usePrefersReducedMotion } from "./SubagentCard";
import type { RunningSubagentStatus } from "./running-subagents-model";
import { HarnessActivityFeed } from "./HarnessActivityFeed";
import { harnessPresentation } from "./harness-presentation";

/**
 * D314 (Stack 92) — L2 full-transcript surface.
 *
 * Rendered by the `subagent-transcript` drawer case (see ThreadDrawer.tsx),
 * wrapped in the shared `DrawerShell` chrome. A live status header (reusing the
 * dock card's animated `StatusGlyph`, fed by `useRunningSubagents()`) keeps the
 * pane alive while turn-granular rows stream in below; a trailing pulse signals
 * "more coming" while the run is still going. Tool rows reuse the (A3-decoupled)
 * `ToolCard`, fed a synthetic complete `ToolActivityEvent`.
 */
export function SubagentTranscriptSurface({
  taskId,
  taskRunId,
}: {
  readonly taskId: string;
  readonly taskRunId?: string;
}): ReactElement {
  const { messages, loading, error, status: fetchedStatus } = useSubagentTranscript(taskId, { enabled: true });
  const { list } = useRunningSubagents();
  const reduced = usePrefersReducedMotion();

  // Live status from the dock entry (same source as the hook's refresh key).
  // The owner-scoped Task API supplies status when the dock has no entry.
  const entry = list.find((s) => s.taskId === taskId);
  const status = entry?.status ?? fetchedStatus;
  const agentName = entry?.agentName ?? "Subagent";
  const modelId = entry?.harnessId ? null : (entry?.modelId ?? null);
  const presentation = harnessPresentation(entry?.harnessId);
  const liveStep = entry?.line3 ?? "";
  const liveActivity = entry?.recentActivity ?? [];
  const harnessActivity = entry?.harnessActivity ?? [];
  const isRunning = status === "running";

  return (
    <DrawerShell title="Subagent transcript">
      <div className="flex min-h-0 flex-1 flex-col" data-testid="subagent-transcript-surface" data-task-id={taskId} data-task-run-id={taskRunId ?? ""}>
        {/* Live status header — animated glyph + agent · model + status, plus
            the live work step while running. Keeps the pane from looking dead
            before the first turn-granular row lands. */}
        <header
          className="flex shrink-0 flex-col gap-0.5 border-b border-border/70 px-3 py-2"
          data-testid="subagent-transcript-header"
        >
          <div className="flex items-center gap-1.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-xs leading-none">
              {status ? <StatusGlyph status={status} reduced={reduced} /> : null}
            </span>
            <span className="truncate text-sm font-semibold text-foreground">{agentName}</span>
            {presentation ? (
              <span className="shrink-0 text-[11px] font-medium text-primary">→ {presentation.displayName}</span>
            ) : null}
            {modelId ? (
              <span className="shrink-0 truncate text-[11px] text-foreground-muted">· {modelId}</span>
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-foreground-muted">{status ? statusLabel(status) : loading ? "Loading status…" : "Status unavailable"}</span>
          </div>
          {(isRunning || status === "awaiting") && liveStep ? (
            <p className="truncate pl-[22px] text-[11px] leading-tight text-foreground-muted" title={liveStep}>
              › {liveStep}
            </p>
          ) : null}
        </header>

        <StickToBottom
          className="min-h-0 flex-1"
          resize="smooth"
          initial="smooth"
          data-testid="subagent-transcript-scroll"
        >
          <StickToBottom.Content
            className="flex flex-col gap-2 p-3"
            scrollClassName="overflow-y-auto"
          >
          {error ? (
            <p className="text-sm text-red-500" data-testid="subagent-transcript-error">
              {error}
            </p>
          ) : null}
          <VirtualTranscriptRows key={taskId} isRunning={isRunning} messages={messages.filter((message) => harnessActivity.length === 0 || !isToolRow(message))} />
          {harnessActivity.length > 0 ? (
            <HarnessActivityFeed activity={harnessActivity} />
          ) : liveActivity.length > 0 ? (
            <section
              className="flex flex-col gap-1 rounded-lg border border-border/70 bg-background-panel/60 p-2"
              data-testid="subagent-transcript-live-activity"
              aria-label="Live harness execution activity"
            >
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
                Live execution
              </div>
              {liveActivity.map((detail, index) => (
                <p
                  key={`${index}-${detail}`}
                  className="whitespace-pre-wrap break-words rounded bg-background px-2 py-1 font-mono text-[11px] leading-snug text-foreground-muted"
                >
                  › {detail}
                </p>
              ))}
            </section>
          ) : null}
          {!error && messages.length === 0 && liveActivity.length === 0 && harnessActivity.length === 0 ? (
            <p
              className={`text-sm italic text-foreground-muted ${isRunning && !reduced ? "animate-pulse" : ""}`}
              data-testid="subagent-transcript-empty"
            >
              {loading
                ? "Loading transcript…"
                : isRunning
                  ? "Working — first step incoming…"
                  : "No messages."}
            </p>
          ) : null}
          {!error && messages.length > 0 && isRunning ? (
            <p
              className={`pl-1 text-[11px] italic leading-tight text-foreground-muted ${reduced ? "" : "animate-pulse"}`}
              data-testid="subagent-transcript-working"
            >
              ░ working… ░
            </p>
          ) : null}
          </StickToBottom.Content>
        </StickToBottom>
      </div>
    </DrawerShell>
  );
}

function statusLabel(status: RunningSubagentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "awaiting":
      return "needs attention";
    case "done":
      return "done";
    case "errored":
      return "errored";
  }
}
