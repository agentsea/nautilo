/**
 * generic inline ToolCard primitive.
 *
 * Replaces the minimal inline `ToolCallCard` that previously lived
 * in `conversation.tsx`. The assistant-ui framework already threads
 * tool calls into the conversation message stream via the
 * `assistantComponents.tools.Fallback` seam; this component is what
 * the seam renders.
 *
 * Scope (Phase 1):
 *   - Five-state visual model (pending/running/success/error/blocked)
 *     with the glyphs + colors from the issue-doc chart.
 *   - Collapsed one-liner: glyph + toolName + arg summary + duration.
 *   - Expanded: args JSON + result payload.
 *   - 1Hz live timer while running (from the matching
 *     `ToolActivityEvent` in `useToolActivity()`, fallback to
 *     the component's own mount time if no event has arrived yet).
 *   - Keyboard accessible: focusable, Enter/Space toggles,
 *     `aria-expanded`, composite aria-label, screen-reader state
 *     labels via stateLabelFor.
 *
 * Explicitly NOT in Phase 1:
 *   - Per-tool specializations (Phase 2) — run_shell / edit_file
 *     etc. will override this component with richer rendering.
 *   - Streaming (Phase 3).
 *   - Session rehydrate (Phase 4).
 *   - Click-to-rerun / copy-args / retry buttons (Phase 5).
 */

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { LocalToolControlBody, parseLocalToolControlDisplay } from "./renderers/local-tool-control";
import { useToolActivity } from "../../adapters/runtime-contexts";
import {
  argsSummary,
  cardAriaLabel,
  computeElapsedMs,
  deriveCardState,
  formatDuration,
  glyphFor,
  shouldRenderSpinner,
  stateLabelFor,
  type ToolCardState,
} from "./tool-card-helpers";
import {
  projectToolArgsForCardDisplay,
  projectToolResultForDisplay,
  projectToolResultTextForDisplay,
  redactCredentialMaterialForDisplay,
} from "../tool-argument-preview";
import { getToolRenderer } from "./renderers";
import { parseConnectedWebAccountReadActive, parsePublicBrowserReadActive, parseWebsiteTaskActive } from "./renderers/connected-web-account-read";
import { useConnectedWebOperation } from "./renderers/use-connected-web-operation";
import type { RunShellContinuity, RunShellProgress, StructuredSshProgress } from "./renderers/types";
import type { ToolActivityEvent } from "../../adapters/runtime-contexts";
import { parseStagedEnvelope } from "../../lib/staged-envelope";
import { registerKnownFilePath } from "../../lib/known-file-links";
import { GenieRecoveryAction, parseGenieRecoveryToolResult } from "./genie-recovery";

// Keep history compact after a reload while still opening current-session
// run_shell receipts that finish before their card ever observes `running`.
const TOOL_CARD_UI_SESSION_STARTED_AT = Date.now();

export interface ToolCardProps {
  /** Display an admitted snapshot without network observers or actionable renderers. */
  readOnly?: boolean;
  toolName: string;
  /** User-facing label when the protocol tool name is implementation-specific. */
  displayName?: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  /** Assistant-UI status shape: `{ type: "running" | "complete" | "requires-action" | ... }`. */
  status: { type: string };
  /** Start open when the surrounding activity surface promises live detail. */
  defaultExpanded?: boolean;
  /** Preserve the user's expansion choice when a transcript virtualizes rows. */
  onExpandedChange?: (expanded: boolean) => void;
  /** A real user choice restored after a virtualized row remounts. */
  savedExpansionChoice?: boolean;
  /** Rich body supplied by a higher-level tool surface instead of the generic JSON fallback. */
  expandedContent?: ReactNode;
  // Framework-provided callbacks — unused in Phase 1 but part of the
  // assistant-ui fallback signature; kept so we don't have to
  // type-gymnastic around them at the call site.
  addResult?: (result: unknown) => void;
  resume?: (payload: unknown) => void;
  /**
   * Historical/decoupled rendering.
   *
   * When provided, the card uses THIS event instead of matching one from the
   * live `useToolActivity()` stream, so a ToolCard can render from static
   * props (transcript replay) with no live WS event. When absent, behavior is
   * byte-identical to the live path. Pass a synthetic `{ status: "ok", ... }`
   * event plus `status={{ type: "complete" }}` to render a completed call.
   */
  activityOverride?: ToolActivityEvent;
  /** Canonical state for wrappers whose child work outlives the tool receipt. */
  stateOverride?: ToolCardState;
}

const STATE_COLOR_CLASS: Record<ToolCardState, string> = {
  unknown: "text-foreground-dim",
  pending: "text-foreground-dim",
  running: "text-tool-running",
  paused: "text-foreground-muted",
  awaiting: "text-foreground-muted",
  success: "text-tool-success",
  cancelled: "text-foreground-muted",
  error: "text-tool-error",
  blocked: "text-[var(--warning,#b58900)]",
};

function RunningSpinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      data-testid="tool-card-spinner"
      className={`h-3 w-3 animate-spin ${className ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 1Hz ticker for the running-card timer display. Returns `Date.now()`
 * refreshed every `intervalMs` while `active`; frozen when inactive
 * so non-running cards don't re-render pointlessly.
 */
function useNowTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

interface ToolCardBodyBoundaryProps {
  children: ReactNode;
  toolName: string;
}

interface ToolCardBodyBoundaryState {
  failed: boolean;
}

/**
 * Tool payloads and specialized renderers are intentionally lower-trust than
 * the surrounding conversation. Keep a malformed historical result or a
 * renderer regression inside the expanded card instead of escalating it to
 * the app-root recovery boundary.
 */
export class ToolCardBodyErrorBoundary extends Component<
  ToolCardBodyBoundaryProps,
  ToolCardBodyBoundaryState
> {
  state: ToolCardBodyBoundaryState = { failed: false };

  static getDerivedStateFromError(): ToolCardBodyBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[error-boundary:tool-card:${this.props.toolName}] caught render error:`,
      error,
      "component-stack:",
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="border-t border-border px-3 py-2 text-xs text-foreground-muted"
        data-testid="tool-card-render-fallback"
        onClick={(event) => event.stopPropagation()}
      >
        This tool result could not be previewed. Collapse and reopen the card
        to try again.
      </div>
    );
  }
}

/**
 * The runtime owns decoding and offset reconciliation. Keep this defensive
 * projection local so historical events and older servers continue to render
 * while the event field rolls out.
 */
function runShellProgressFromEvent(
  event: ToolActivityEvent | undefined,
): RunShellProgress | undefined {
  const candidate = (event as (ToolActivityEvent & {
    runShellProgress?: unknown;
  }) | undefined)?.runShellProgress;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.stdoutOffsetBytes !== "number" ||
    typeof value.stderrOffsetBytes !== "number" ||
    typeof value.droppedBytes !== "number" ||
    typeof value.phase !== "string" ||
    typeof value.elapsedMs !== "number"
  ) {
    return undefined;
  }
  return {
    stdout: redactCredentialMaterialForDisplay(value.stdout),
    stderr: redactCredentialMaterialForDisplay(value.stderr),
    stdoutOffsetBytes: value.stdoutOffsetBytes,
    stderrOffsetBytes: value.stderrOffsetBytes,
    droppedBytes: value.droppedBytes,
    phase: value.phase,
    elapsedMs: value.elapsedMs,
  };
}

function runShellContinuityFromEvent(
  event: ToolActivityEvent | undefined,
): { state: RunShellContinuity; changedAt?: number } | undefined {
  const value = event as (ToolActivityEvent & {
    runShellContinuity?: unknown;
    runShellContinuityChangedAt?: unknown;
  }) | undefined;
  if (
    value?.runShellContinuity !== "connected" &&
    value?.runShellContinuity !== "disconnected" &&
    value?.runShellContinuity !== "outcome_unknown"
  ) {
    return undefined;
  }
  return {
    state: value.runShellContinuity,
    ...(typeof value.runShellContinuityChangedAt === "number"
      ? { changedAt: value.runShellContinuityChangedAt }
      : {}),
  };
}

function structuredSshProgressFromEvent(
  event: ToolActivityEvent | undefined,
): StructuredSshProgress | undefined {
  const value = (event as (ToolActivityEvent & { structuredSshProgress?: unknown }) | undefined)
    ?.structuredSshProgress;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const progress = value as Record<string, unknown>;
  if (
    progress.operation === "exec" &&
    typeof progress.stdout === "string" &&
    typeof progress.stderr === "string" &&
    typeof progress.stdoutOffsetBytes === "number" &&
    typeof progress.stderrOffsetBytes === "number" &&
    typeof progress.droppedBytes === "number" &&
    progress.phase === "running" &&
    typeof progress.elapsedMs === "number"
  ) return {
    operation: "exec",
    stdout: redactCredentialMaterialForDisplay(progress.stdout),
    stderr: redactCredentialMaterialForDisplay(progress.stderr),
    stdoutOffsetBytes: progress.stdoutOffsetBytes,
    stderrOffsetBytes: progress.stderrOffsetBytes,
    droppedBytes: progress.droppedBytes,
    phase: "running",
    elapsedMs: progress.elapsedMs,
  };
  if (
    (progress.operation === "copy-upload" || progress.operation === "copy-download") &&
    typeof progress.transferredBytes === "number" &&
    (progress.totalBytes === undefined || typeof progress.totalBytes === "number") &&
    (progress.phase === "starting" || progress.phase === "transferring") &&
    typeof progress.elapsedMs === "number"
  ) return progress as StructuredSshProgress;
  return undefined;
}

function isStructuredSshTool(toolName: string): boolean {
  return toolName === "structured_ssh_exec" ||
    toolName === "structured_ssh_copy_upload" ||
    toolName === "structured_ssh_copy_download";
}

export function ToolCard(props: ToolCardProps): React.ReactElement {
  const {
    toolName,
    displayName,
    toolCallId,
    args,
    result,
    isError,
    status,
    activityOverride,
    stateOverride,
    defaultExpanded = false,
    expandedContent,
    onExpandedChange,
    savedExpansionChoice,
    readOnly = false,
  } = props;

  // Match up to the WS-backed event for accurate timestamps.
  // When `activityOverride` is provided (historical/transcript rendering) it
  // wins over the live match, letting the card render with no live WS event.
  // When absent the live path below is unchanged (byte-identical to today).
  const events = useToolActivity();
  const liveEvent = useMemo(
    () => events.find((e) => e.toolCallId === toolCallId),
    [events, toolCallId],
  );
  const event = activityOverride ?? liveEvent;

  // `resultText` comes from the ToolActivityEvent
  // (populated by nautilo-runtime's tool.end handler from the WS
  // event's `result` field); it's the real stdout / file content /
  // search matches, not the assistant-ui synthetic "Done (Xms)"
  // placeholder the framework falls back to. We compute it up-front
  // so state derivation can sniff for error-shaped bodies.
  const rawResultText = event?.result ?? (
    typeof result === "string" ? result : undefined
  );
  const displayResultText = useMemo(
    () => projectToolResultTextForDisplay(rawResultText),
    [rawResultText],
  );
  const displayResult = useMemo(
    () => projectToolResultForDisplay(result),
    [result],
  );
  const displayArgs = useMemo(() => {
    // assistant-ui can mount a tool with empty/partial args even though the
    // keyed live activity still has the canonical tool.start display args.
    // Renderers that require command/identity evidence reconcile that safe
    // activity projection first; framework-provided values still win.
    const safeArgs = projectToolArgsForCardDisplay(args);
    if ((toolName !== "run_shell" && toolName !== "hue_lights" && toolName !== "read_connected_web_account" && toolName !== "act_connected_web_account" && toolName !== "run_website_task" && toolName !== "officecli") || !event?.args) return safeArgs;
    return {
      ...projectToolArgsForCardDisplay(event.args),
      ...safeArgs,
    };
  }, [args, event?.args, toolName]);
  // Registered renderers are also the only surface allowed to refine a
  // transport-success state from a sealed semantic receipt. This lookup stays
  // above state derivation so a verified receipt and an outcome-unknown
  // receipt cannot share a green glyph.
  const renderer = useMemo(
    () => readOnly ? undefined : getToolRenderer(toolName, rawResultText, displayArgs),
    [displayArgs, rawResultText, toolName, readOnly],
  );
  // Generic transcript projection deliberately strips opaque capabilities.
  // A renderer may opt into parsing the untouched envelope only when it owns
  // a sealed, no-raw-render presentation; this is required to distinguish a
  // verified Computer Use handoff from an unknown one without putting target
  // references into the DOM.
  const rendererResultText = renderer?.sealedResultParser === true
    ? rawResultText
    : displayResultText;
  const resultTruncated = event?.resultTruncated === true;
  const stagedEnvelope = useMemo(
    () => parseStagedEnvelope(rawResultText),
    [rawResultText],
  );
  useEffect(() => {
    if (!stagedEnvelope) return;
    registerKnownFilePath(stagedEnvelope.path);
  }, [stagedEnvelope]);
  const [expanded, setExpanded] = useState(savedExpansionChoice ?? defaultExpanded);
  useEffect(() => {
    if (defaultExpanded && !((toolName === "run_shell" || isStructuredSshTool(toolName)) && manuallyCollapsedRef.current)) {
      setExpanded(true);
    }
  }, [defaultExpanded, toolName]);
  const autoExpandedResultRef = useRef<string | null>(savedExpansionChoice === undefined ? null : rawResultText ?? event?.result ?? null);
  const manuallyChangedExpansionRef = useRef(savedExpansionChoice !== undefined);
  // A Human's collapse is an explicit preference for this invocation. Unlike
  // the generic default-expanded surface, it must win over later progress and
  // the terminal receipt.
  const manuallyCollapsedRef = useRef(savedExpansionChoice === false);

  const derivedState = deriveCardState({
    uiStatus: status,
    event,
    ...(isError !== undefined ? { isError } : {}),
    ...(typeof rawResultText === "string" ? { resultText: rawResultText } : {}),
  });
  const connectedReceipt = toolName === "run_website_task"
    ? parseWebsiteTaskActive(rendererResultText)
    : toolName === "browse_web" ? parsePublicBrowserReadActive(rendererResultText) : toolName === "read_connected_web_account" ? parseConnectedWebAccountReadActive(rendererResultText) : null;
  const connectedObservation = useConnectedWebOperation(readOnly ? null : connectedReceipt?.operation.operationId ?? null);
  const connectedOperation = connectedObservation.value;
  const connectedStatusLabel = connectedReceipt && connectedObservation.status !== "available"
    ? connectedObservation.status === "loading" ? "Checking browser status" : "Browser status unavailable"
    : connectedOperation?.activity.code === "provider_terminal_pending" ? "Browser finished · recording outcome" : null;
  const connectedState: ToolCardState | null = connectedOperation?.lifecycle === "terminal"
    ? connectedOperation.receipt?.outcome === "completed" ? "success"
      : connectedOperation.receipt?.outcome === "cancelled" ? "cancelled"
        : connectedOperation.receipt?.outcome === "failed" ? "error" : "blocked"
    : connectedStatusLabel ? connectedObservation.status === "loading" ? "pending" : connectedObservation.status === "unavailable" ? "unknown" : "awaiting"
      : connectedOperation?.lifecycle === "attention" ? "blocked" : null;
  const semanticState = connectedState ?? renderer?.stateOverride?.({
    resultText: rendererResultText,
    resultTruncated,
    state: derivedState,
  }) ?? null;
  // A canonical cancelled receipt is terminal execution truth. It must win
  // even if a surrounding renderer supplied a stale optimistic success
  // override while the transport itself completed normally.
  // A file body can itself contain a cancellation-shaped JSON document.
  // Persisted file outcome (including unknown) is independent of those bytes.
  const state = toolName === "file" && stateOverride !== undefined ? stateOverride : derivedState === "cancelled"
    ? "cancelled"
    : event?.browserResearchIntervention && derivedState === "running"
      ? "blocked"
      : event?.connectedWebActionAttention && derivedState === "running"
        ? "blocked"
        : event?.connectedWebActionResumeFailed && derivedState === "running"
          ? "error"
      : (semanticState ?? stateOverride ?? derivedState);

  const localControl = state === "error" ? parseLocalToolControlDisplay(toolName, displayResultText) : null;

  const displayEvent = useMemo(
    () => {
      if (!event) return undefined;
      const safeRunShellProgress = runShellProgressFromEvent(event);
      const safeStructuredSshProgress = structuredSshProgressFromEvent(event);
      const safeEventRunShellProgress = event.runShellProgress && safeRunShellProgress
        ? {
            ...event.runShellProgress,
            stdout: safeRunShellProgress.stdout,
            stderr: safeRunShellProgress.stderr,
          }
        : undefined;
      const safeEventStructuredSshProgress = event.structuredSshProgress && safeStructuredSshProgress
        ? safeStructuredSshProgress.operation === "exec" &&
            event.structuredSshProgress.operation === "exec"
          ? {
              ...event.structuredSshProgress,
              stdout: safeStructuredSshProgress.stdout,
              stderr: safeStructuredSshProgress.stderr,
            }
          : event.structuredSshProgress
        : undefined;
      return {
          ...event,
          args: projectToolArgsForCardDisplay(event.args ?? {}),
          ...(event.result !== undefined
            ? { result: projectToolResultTextForDisplay(event.result) }
            : {}),
          ...(event.error !== undefined
            ? { error: projectToolResultTextForDisplay(event.error) }
            : {}),
          runShellProgress: safeEventRunShellProgress,
          structuredSshProgress: safeEventStructuredSshProgress,
        };
    },
    [event],
  );
  // Keep a successful typed recovery immediately usable in the ordinary
  // transcript. This is display-only: `GenieRecoveryAction` remains the sole
  // Human-clicked presenter and this value is never sent to a client action.
  const recovery = useMemo(
    () => [displayResultText, displayEvent?.result, displayEvent?.error]
      .map((candidate) => parseGenieRecoveryToolResult(toolName, candidate))
      .find((candidate) => candidate !== null) ?? null,
    [displayEvent?.error, displayEvent?.result, displayResultText, toolName],
  );

  // Fallback start time for the case where the card renders before
  // the matching `tool.start` event has reached the client. Kept in a
  // ref so re-renders don't reset it.
  const mountStartRef = useRef<number>(Date.now());

  const runShellContinuity = toolName === "run_shell"
    ? runShellContinuityFromEvent(event)
    : undefined;
  const now = useNowTicker(
    state === "running" &&
    runShellContinuity?.state !== "disconnected" &&
    runShellContinuity?.state !== "outcome_unknown",
  );

  // Prefer the WS event's timestamps; fall back to the component's
  // own mount time for the running case.
  const effectiveStart = event?.startedAt ?? mountStartRef.current;
  // Once observation is lost, continuing to tick looks like proof that the
  // child is alive. Freeze at the last transport transition until new progress
  // or the canonical final receipt restores certainty.
  const effectiveEnd = event?.endedAt ?? (
    runShellContinuity?.state !== "connected"
      ? runShellContinuity?.changedAt
      : undefined
  );
  const durationMs = (() => {
    if (effectiveEnd !== undefined) return effectiveEnd - effectiveStart;
    if (state === "running") return now - effectiveStart;
    if (event) return computeElapsedMs(event, now, state);
    return null;
  })();
  const runShellProgress = runShellProgressFromEvent(event);
  const structuredSshProgress = isStructuredSshTool(toolName)
    ? structuredSshProgressFromEvent(event)
    : undefined;

  // Look up a per-tool renderer; fall back to the generic body for
  // tools without one.
  const toolLabel = displayName ?? renderer?.displayName ?? toolName;
  useEffect(() => {
    const expandWhileRunning = toolName === "run_shell"
      || isStructuredSshTool(toolName)
      || renderer?.autoExpandWhileRunning === true;
    if (!expandWhileRunning || state !== "running" || manuallyCollapsedRef.current) {
      return;
    }
    setExpanded(true);
  }, [renderer?.autoExpandWhileRunning, state, toolName]);
  useEffect(() => {
    if (event?.browserResearchIntervention || event?.connectedWebActionAttention || event?.connectedWebActionResumeFailed) {
      setExpanded(true);
      return;
    }
    if (!renderer?.autoExpandOnResult && !recovery) return;
    if ((toolName === "run_shell" || isStructuredSshTool(toolName)) && manuallyCollapsedRef.current) return;
    if (
      toolName === "run_shell" &&
      (event?.startedAt === undefined || event.startedAt < TOOL_CARD_UI_SESSION_STARTED_AT)
    ) return;
    if (state !== "success" && state !== "error") return;
    const key = rawResultText ?? event?.result ?? null;
    if (!key || autoExpandedResultRef.current === key) return;
    autoExpandedResultRef.current = key;
    setExpanded(true);
  }, [event?.browserResearchIntervention, event?.connectedWebActionAttention, event?.connectedWebActionResumeFailed, event?.result, event?.startedAt, recovery, renderer, rawResultText, state, toolName]);
  useEffect(() => {
    if (renderer?.collapseOnTerminalResult !== true || state !== "success" || !rawResultText?.trim() || manuallyChangedExpansionRef.current) return;
    setExpanded(false);
  }, [rawResultText, renderer?.collapseOnTerminalResult, state]);

  const summary = useMemo(() => {
    if (connectedStatusLabel) return connectedStatusLabel;
    if (event?.browserResearchIntervention) return "Verification required";
    if (event?.connectedWebActionAttention) return "Sign-in required";
    if (event?.connectedWebActionResumeFailed) return "Cancellation required";
    if (renderer?.collapsedSummary) {
      return renderer.collapsedSummary({
        args: displayArgs,
        result: displayResult,
        state,
        resultText: rendererResultText,
        resultTruncated,
      });
    }
    return argsSummary(displayArgs);
  }, [connectedStatusLabel, event?.browserResearchIntervention, event?.connectedWebActionAttention, event?.connectedWebActionResumeFailed, renderer, displayArgs, displayResult, state, rendererResultText, resultTruncated]);

  const extras = useMemo(() => {
    return renderer?.collapsedExtras
      ? renderer.collapsedExtras({
          args: displayArgs,
          result: displayResult,
          state,
          resultText: rendererResultText,
          resultTruncated,
        })
      : null;
  }, [renderer, displayArgs, displayResult, state, rendererResultText, resultTruncated]);

  const glyph = glyphFor(state);
  const glyphColor = STATE_COLOR_CLASS[state];
  const continuityLabel = runShellContinuity?.state === "disconnected"
    ? "connection lost, command may still be running"
    : runShellContinuity?.state === "outcome_unknown"
      ? "command outcome unknown"
      : null;
  const ariaLabel = `${cardAriaLabel({
    toolName: toolLabel,
    state,
    summary,
    durationMs,
  })}${continuityLabel ? `, ${continuityLabel}` : ""}`;

  const toggleExpanded = () => {
    manuallyChangedExpansionRef.current = true;
    onExpandedChange?.(!expanded);
    setExpanded((wasExpanded) => {
      if ((toolName === "run_shell" || isStructuredSshTool(toolName) || renderer?.autoExpandWhileRunning === true) && wasExpanded) {
        manuallyCollapsedRef.current = true;
      }
      return !wasExpanded;
    });
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-expanded={expanded}
      className="relative w-full overflow-hidden rounded-lg border border-border border-l-2 border-l-accent bg-background-element text-sm"
      data-tool-card-state={state}
      {...(runShellContinuity
        ? { "data-run-shell-continuity": runShellContinuity.state }
        : {})}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {shouldRenderSpinner(state) && !continuityLabel ? (
          <RunningSpinner className={`shrink-0 ${glyphColor}`} />
        ) : (
          <span aria-hidden className={`shrink-0 font-mono ${glyphColor}`}>
            {glyph}
          </span>
        )}
        <span
          className="min-w-0 truncate font-medium text-accent"
          title={toolLabel}
        >
          {toolLabel}
        </span>
        {summary && (
          <span className="truncate text-xs text-foreground-muted" title={summary}>
            ({summary})
          </span>
        )}
        {extras && (
          <span className="shrink-0 text-xs text-foreground-muted">{extras}</span>
        )}
        {continuityLabel && (
          <span className="truncate text-xs text-[var(--warning,#b58900)]">
            {continuityLabel}
          </span>
        )}
        {(state === "paused" || state === "awaiting") && (
          <span className="shrink-0 text-xs text-foreground-muted">
            {state === "paused" ? "Paused" : "Awaiting reply"}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-foreground-muted tabular-nums">
          {durationMs !== null ? formatDuration(durationMs) : ""}
        </span>
        <button
          type="button"
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs text-foreground-muted hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={expanded ? `Collapse ${toolLabel}` : `Expand ${toolLabel}`}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        </button>
      </div>

      {toolName === "hue_lights" && displayArgs["action"] === "setup" && state === "running" && (
        <p role="status" className="px-3 pb-2 text-foreground">
          Pairing with your Hue Bridge. Press its physical button now.
        </p>
      )}

      {expanded && (
        <ToolCardBodyErrorBoundary toolName={toolName}>
          {localControl && !readOnly ? <LocalToolControlBody receipt={localControl} /> : expandedContent !== undefined ? (
            expandedContent
          ) : renderer ? (
            <renderer.ExpandedBody
              toolName={toolName}
              args={displayArgs}
              result={displayResult}
              state={state}
              event={displayEvent}
              resultText={rendererResultText}
              resultTruncated={resultTruncated}
              elapsedMs={durationMs ?? undefined}
              runShellProgress={runShellProgress}
              runShellContinuity={runShellContinuity?.state}
              structuredSshProgress={structuredSshProgress}
            />
          ) : (
            <ToolCardBody
              readOnly={readOnly}
              toolName={toolName}
              args={displayArgs}
              result={displayResult}
              state={state}
              event={displayEvent}
              resultText={displayResultText}
            />
          )}
        </ToolCardBodyErrorBoundary>
      )}

      {/* The positioned card root contains this absolute sr-only box so a
          nested transcript cannot expand its outer chat scroll area.
          Screen-reader-only state announcement. Kept in the DOM so
          the live transition from running→success announces — sighted
          users see the glyph flip, SR users hear the label change. */}
      <span className="sr-only" aria-live="polite">
        {connectedStatusLabel ?? stateLabelFor(state)}
      </span>
    </div>
  );
}

function ToolCardBody({
  readOnly,
  toolName,
  args,
  result,
  state,
  event,
  resultText,
}: {
  readOnly?: boolean;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  state: ToolCardState;
  event: ToolActivityEvent | undefined;
  resultText: string | undefined;
}): React.ReactElement {
  const hasArgs = args && Object.keys(args).length > 0;
  const recovery = [resultText, event?.result, event?.error]
    .map((candidate) => parseGenieRecoveryToolResult(toolName, candidate))
    .find((candidate) => candidate !== null) ?? null;
  // prefer the real `resultText` from the
  // ToolActivityEvent (populated by the WS tool.end event) over
  // the assistant-ui synthesized `result` (often "Done (Xms)"
  // for tools without a registered renderer pre-Phase-2).
  // `resultText` is ALREADY cap-truncated server-side.
  const displayResult = resultText ?? (
    typeof result === "string" ? result : (result !== undefined && result !== null ? safeStringify(result) : undefined)
  );
  const hasResult = displayResult !== undefined && displayResult !== null && displayResult !== "";

  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      {recovery && !readOnly ? <GenieRecoveryAction recovery={recovery} stopParent={(event) => event.stopPropagation()} /> : null}

      {hasArgs && (
        <section aria-label="arguments">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Args
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-foreground-muted">
            {safeStringify(args)}
          </pre>
        </section>
      )}

      {hasResult && (
        <section aria-label="result">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            Result{event?.resultTruncated === true ? " (truncated)" : ""}
          </div>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground-muted">
            {displayResult}
          </pre>
        </section>
      )}

      {state === "error" && event?.error && event.error !== displayResult && (
        <section aria-label="error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {event.error}
          </pre>
        </section>
      )}

      {!hasArgs && !hasResult && state !== "error" && (
        <div className="text-xs italic text-foreground-dim">
          (no arguments or result to display)
        </div>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
