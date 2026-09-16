import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { RunningSubagent, RunningSubagentStatus } from "./running-subagents-model";
import { useDrawer } from "../thread-drawer/drawer-state.tsx";
import { SubagentStepFeed } from "./SubagentStepFeed";
import { HarnessActivityFeed } from "./HarnessActivityFeed";
import { harnessPresentation } from "./harness-presentation";
import { useSubagentTranscript } from "./use-subagent-transcript";

/**
 * D307 (Stack 87) — one card in the Subagent activity dock (§5.12).
 *
 * Presentational only: status/controls come from props so the hook/dock owns
 * all API calls. Three lines: (1) status glyph + agent · model + controls,
 * (2) prompt, (3) live work line. Status lives in the glyph, severity in color;
 * the running glyph animates (a 4-frame spinner) unless reduced-motion is on.
 *
 * Controls (Q2 locked): running → pause + stop; paused → resume + stop;
 * awaiting → "jump →" to the awaiting room; done/errored → no controls (the
 * card lingers ~5s then the hook drops it).
 */

const KIND_LABEL: Record<string, string> = {
  in_scope: "scope",
  in_background: "background",
  ask_peer: "ask_peer",
  in_private_namespace: "private",
  schedule: "scheduled",
  task: "task",
  repo_docs: "repo docs",
};

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** Animated spinner glyph for the `running` state (static dot under reduced-motion). */
function RunningGlyph({ reduced }: { readonly reduced: boolean }): ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 220);
    return () => clearInterval(id);
  }, [reduced]);
  return (
    <span
      aria-hidden
      data-testid="subagent-glyph-running"
      className="text-primary"
    >
      {reduced ? "●" : SPINNER_FRAMES[frame]}
    </span>
  );
}

export function StatusGlyph({
  status,
  reduced,
}: {
  readonly status: RunningSubagentStatus;
  readonly reduced: boolean;
}): ReactElement {
  switch (status) {
    case "running":
      return <RunningGlyph reduced={reduced} />;
    case "paused":
      return <span aria-hidden className="text-foreground-muted">⏸</span>;
    case "awaiting":
      return (
        <span
          aria-hidden
          data-testid="subagent-glyph-awaiting"
          className={`text-[var(--warning)] ${reduced ? "" : "animate-pulse"}`}
        >
          ⌛
        </span>
      );
    case "done":
      return <span aria-hidden className="text-online">✓</span>;
    case "errored":
      return <span aria-hidden className="text-red-500">⚠</span>;
  }
}

export interface SubagentCardProps {
  readonly subagent: RunningSubagent;
  readonly onStop: (taskId: string) => void;
  readonly onPause: (taskId: string) => void;
  readonly onResume: (taskId: string) => void;
  /** Navigate to the awaiting room (only meaningful for `awaiting` cards). */
  readonly onJump: (roomId: string) => void;
  /** Per-control in-flight flag to disable buttons + show a wait cursor. */
  readonly busy?: boolean;
  /** When awaiting, only show jump when the operator can access the room. */
  readonly canJump?: boolean;
}

export function SubagentCard({
  subagent,
  onStop,
  onPause,
  onResume,
  onJump,
  busy = false,
  canJump = false,
}: SubagentCardProps): ReactElement {
  const reduced = usePrefersReducedMotion();
  const drawer = useDrawer();
  // D314 Phase A (Stack 92) — L0 (collapsed, today's 3-line card) ↔ L1
  // (expanded: a condensed step feed + an "expand to full view" control).
  const [expanded, setExpanded] = useState(
    () =>
      subagent.harnessId !== null &&
      (subagent.status === "running" || subagent.status === "awaiting"),
  );
  const {
    taskId,
    status,
    agentName,
    modelId,
    kind,
    harnessId,
    prompt,
    line3,
    recentActivity,
    harnessActivity = [],
    awaitingRoomId,
  } = subagent;
  const elapsed = useElapsedLabel(subagent.startedAtMs, status);
  const { messages: transcriptMessages, loading: transcriptLoading, error: transcriptError } =
    useSubagentTranscript(taskId, { enabled: expanded });

  const accent =
    status === "errored"
      ? "border-red-500/40 bg-red-500/5"
      : status === "awaiting"
        ? "border-[var(--warning)]/40 bg-[var(--warning)]/5"
        : status === "done"
          ? "border-online/40 bg-online/5"
          : "border-border/70 bg-background-panel/70";

  const kindLabel = kind ? KIND_LABEL[kind] ?? kind : null;
  const presentation = harnessPresentation(harnessId);
  const nativeControls = harnessId === null;

  const openTranscript = () => drawer.open({ kind: "subagent-transcript", taskId });

  return (
    <div
      className={`flex shrink-0 cursor-pointer flex-col gap-0.5 rounded-xl border px-2 py-1.5 hover:border-primary/50 ${accent}`}
      data-testid="subagent-card"
      data-task-id={taskId}
      data-status={status}
      role="button"
      tabIndex={0}
      onClick={openTranscript}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTranscript();
        }
      }}
      title="Open transcript"
    >
      {/* Line 1 — disclosure + glyph + name · model + controls */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse subagent steps" : "Expand subagent steps"}
          title={expanded ? "Collapse steps" : "Expand steps"}
          className="flex h-4 w-3 shrink-0 items-center justify-center rounded text-[10px] leading-none text-foreground-muted hover:text-foreground"
          data-testid="subagent-card-disclosure"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-xs leading-none">
          <StatusGlyph status={status} reduced={reduced} />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="truncate text-xs font-semibold text-foreground">{agentName}</span>
          {harnessId ? (
            <span className="shrink-0 text-[10px] font-medium text-primary">
              → {harnessDisplayName(harnessId)}
            </span>
          ) : null}
          {/* A native Task-run model is not proof of the model selected by an
              external harness. Hide it until the harness activity contract
              supplies a revalidated provider model. */}
          {modelId && !harnessId ? (
            <span className="shrink-0 truncate text-[10px] text-foreground-muted">· {modelId}</span>
          ) : null}
          {kindLabel ? (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-foreground-muted/80">
              · {kindLabel}
            </span>
          ) : null}
          <span
            className="shrink-0 text-[10px] tabular-nums text-foreground-muted"
            title="Elapsed time"
            data-testid="subagent-elapsed"
          >
            · {elapsed}
          </span>
        </div>
        <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
          <SubagentControls
            status={status}
            canResumeResearch={subagent.canResumeResearch === true}
            busy={busy}
            awaitingRoomId={awaitingRoomId}
            canJump={canJump}
            allowPauseResume={nativeControls || presentation?.supportsPauseResume === true}
            allowStop={nativeControls || presentation?.supportsTaskStop === true}
            allowAwaitingJump={nativeControls || presentation?.supportsRequests === true}
            onStop={() => onStop(taskId)}
            onPause={() => onPause(taskId)}
            onResume={() => onResume(taskId)}
            onJump={() => awaitingRoomId && onJump(awaitingRoomId)}
          />
        </span>
      </div>

      {/* Line 2 — one-line description */}
      <p className="truncate pl-[22px] text-[11px] leading-tight text-foreground" title={prompt}>
        {prompt || "(no description)"}
      </p>

      {/* Line 3 — live work / status */}
      <p
        className="truncate pl-[22px] text-[10px] leading-tight text-foreground-muted"
        data-testid="subagent-line3"
        title={line3}
      >
        {line3 ? `› ${line3}` : statusFallbackLine(status)}
      </p>

      {/* L1 (expanded) — condensed step feed + "expand to full view" control. */}
      {expanded ? (
        <div className="mt-1 flex flex-col" data-testid="subagent-card-expanded">
          <div className="flex items-center justify-end pl-[22px]">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openTranscript();
              }}
              className="rounded px-1 text-[10px] leading-none text-foreground-muted hover:bg-background hover:text-foreground"
              data-testid="subagent-expand-full"
              aria-label="Open full transcript view"
              title="Open full transcript"
            >
              ⤢ full view
            </button>
          </div>
          {transcriptLoading ? (
            <p className="pl-[22px] text-[10px] italic leading-tight text-foreground-muted">
              Loading steps…
            </p>
          ) : null}
          {transcriptError ? (
            <p
              className="pl-[22px] text-[10px] leading-tight text-red-500"
              data-testid="subagent-card-transcript-error"
            >
              {transcriptError}
            </p>
          ) : null}
          {harnessActivity.length > 0 ? (
            <HarnessActivityFeed
              activity={harnessActivity}
              className="mt-1 max-h-80 overflow-y-auto pl-[22px] pr-1"
            />
          ) : recentActivity.length > 0 ? (
            <div
              className="mt-1 flex max-h-64 flex-col gap-1 overflow-y-auto pl-[22px] pr-1"
              data-testid="subagent-live-activity"
              aria-label="Live harness activity"
            >
              {recentActivity.map((detail, index) => (
                <p
                  key={`${index}-${detail}`}
                  className="whitespace-pre-wrap break-words rounded bg-background/50 px-1.5 py-1 font-mono text-[10px] leading-snug text-foreground-muted"
                >
                  › {detail}
                </p>
              ))}
            </div>
          ) : null}
          {harnessActivity.length === 0 &&
          (transcriptMessages.length > 0 || recentActivity.length === 0) ? (
            <SubagentStepFeed messages={transcriptMessages} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function harnessDisplayName(harnessId: string): string {
  return harnessPresentation(harnessId)?.displayName ?? harnessId;
}

function useElapsedLabel(startedAtMs: number, status: RunningSubagentStatus): string {
  const [nowMs, setNowMs] = useState(Date.now());
  const terminal = status === "done" || status === "errored";
  useEffect(() => {
    if (terminal) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [terminal]);
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusFallbackLine(status: RunningSubagentStatus): string {
  switch (status) {
    case "running":
      return "working…";
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

function SubagentControls({
  status,
  canResumeResearch,
  busy,
  awaitingRoomId,
  canJump,
  allowPauseResume,
  allowStop,
  allowAwaitingJump,
  onStop,
  onPause,
  onResume,
  onJump,
}: {
  readonly status: RunningSubagentStatus;
  readonly canResumeResearch: boolean;
  readonly busy: boolean;
  readonly awaitingRoomId: string | null;
  readonly canJump: boolean;
  readonly allowPauseResume: boolean;
  readonly allowStop: boolean;
  readonly allowAwaitingJump: boolean;
  readonly onStop: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onJump: () => void;
}): ReactElement | null {
  const btn =
    "rounded px-1 text-[11px] leading-none text-foreground-muted hover:bg-background hover:text-foreground disabled:cursor-wait disabled:opacity-40";

  if (status === "awaiting") {
    return allowAwaitingJump && awaitingRoomId && canJump ? (
      <button
        type="button"
        onClick={onJump}
        className="shrink-0 rounded px-1 text-[10px] font-medium text-[var(--warning)] hover:underline"
        data-testid="subagent-jump"
        aria-label="Jump to the room awaiting your reply"
      >
        jump →
      </button>
    ) : null;
  }

  // Only server-verified recovery keeps a Resume action on a terminal card.
  if (status === "done" || (status === "errored" && !canResumeResearch)) return null;

  if (!allowPauseResume && !allowStop) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {allowPauseResume && status === "running" ? (
        <button
          type="button"
          onClick={onPause}
          disabled={busy}
          className={btn}
          data-testid="subagent-pause"
          aria-label="Pause this subagent"
          title="Pause"
        >
          ⏸
        </button>
      ) : allowPauseResume ? (
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className={btn}
          data-testid="subagent-resume"
          aria-label="Resume this subagent"
          title="Resume"
        >
          ▶
        </button>
      ) : null}
      {allowStop && status !== "errored" ? (
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          className={`${btn} hover:text-red-500`}
          data-testid="subagent-stop"
          aria-label="Stop this subagent"
          title="Stop"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
