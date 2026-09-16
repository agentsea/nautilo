/**
 * D083 Phase 2 — per-tool renderer contract.
 *
 * Each tool registered with the renderer registry can override:
 *   - `collapsedSummary` — the one-liner shown in the collapsed
 *     card header (default uses the generic `argsSummary` helper)
 *   - `collapsedExtras` — optional extra info on the collapsed
 *     header (e.g. "+12/-3" for write_file, "42 matches" for grep)
 *   - `ExpandedBody` — the body rendered when the card expands
 *     (default is a JSON-dump of args + result)
 *
 * Tools without a registered renderer fall through to the generic
 * JSON fallback. The registry is keyed by tool name verbatim so a
 * new tool can ship without a renderer and still render cleanly.
 */

import type { ComponentType } from "react";
import type { ToolActivityEvent } from "../../../adapters/runtime-contexts";
import type { ToolCardState } from "../tool-card-helpers";

/**
 * D502 Stack 1 — the deliberately narrow, bounded observation payload for a
 * Desktop `run_shell` invocation. This is provisional evidence only; the
 * completed DesktopShellResult in `resultText` remains canonical.
 */
export interface RunShellProgress {
  stdout: string;
  stderr: string;
  stdoutOffsetBytes: number;
  stderrOffsetBytes: number;
  droppedBytes: number;
  phase: string;
  elapsedMs: number;
}

export type RunShellContinuity =
  | "connected"
  | "disconnected"
  | "outcome_unknown";

/** D500 v15 bounded, secret-free live observation for an exact SSH call. */
export type StructuredSshProgress =
  | {
      operation: "exec";
      stdout: string;
      stderr: string;
      stdoutOffsetBytes: number;
      stderrOffsetBytes: number;
      droppedBytes: number;
      phase: "running";
      elapsedMs: number;
    }
  | {
      operation: "copy-upload" | "copy-download";
      transferredBytes: number;
      totalBytes?: number;
      phase: "starting" | "transferring";
      elapsedMs: number;
    };

export interface ToolRendererProps {
  /** Exact protocol tool name; renderers shared by aliases can scope behavior. */
  toolName?: string;
  args: Record<string, unknown>;
  result: unknown;
  state: ToolCardState;
  /** The matching ToolActivityEvent from useToolActivity(), if any. */
  event: ToolActivityEvent | undefined;
  /** D083 Phase 2 — actual tool output from the WS; cap-truncated. */
  resultText: string | undefined;
  resultTruncated: boolean;
  /** Elapsed time supplied by the shared card timer. */
  elapsedMs?: number | undefined;
  /** Latest bounded, provisional Desktop run_shell observation. */
  runShellProgress?: RunShellProgress | undefined;
  /** Truthful transport/outcome state for this exact Desktop invocation. */
  runShellContinuity?: RunShellContinuity | undefined;
  /** Latest bounded provisional observation for Structured SSH. */
  structuredSshProgress?: StructuredSshProgress | undefined;
}

export interface ToolRenderer {
  /** Optional human-facing label for a protocol-specific tool name. */
  displayName?: string;
  /** Override the collapsed one-liner. */
  collapsedSummary?: (input: {
    args: Record<string, unknown>;
    result: unknown;
    state: ToolCardState;
    resultText: string | undefined;
    resultTruncated?: boolean;
  }) => string;
  /** Optional extras appended to the collapsed header (e.g. "42 matches"). */
  collapsedExtras?: (input: {
    args: Record<string, unknown>;
    result: unknown;
    state: ToolCardState;
    resultText: string | undefined;
    resultTruncated?: boolean;
  }) => string | null;
  /** Expand this tool card automatically when a successful result arrives. */
  autoExpandOnResult?: boolean;
  /**
   * Keep a live invocation open so its controls and progress are visible.
   * The Human can still collapse that exact invocation explicitly.
   */
  autoExpandWhileRunning?: boolean;
  /** Collapse a successful terminal receipt unless the Human chose expansion. */
  collapseOnTerminalResult?: boolean;
  /**
   * A narrow semantic result can refine the card's transport-derived state.
   * This is deliberately opt-in: generic tool cards retain their existing
   * lifecycle behavior. Renderers must fail closed (return `null`) for any
   * unrecognized payload.
   */
  stateOverride?: (input: {
    resultText: string | undefined;
    /** A truncated sealed receipt is never sufficient proof of success. */
    resultTruncated?: boolean;
    state: ToolCardState;
  }) => ToolCardState | null;
  /**
   * The renderer parses an opaque-capability envelope and guarantees that it
   * never renders the source bytes. ToolCard may pass it the original result
   * text rather than the generic transcript projection, which intentionally
   * removes the references needed to validate that envelope.
   */
  sealedResultParser?: true;
  /** Required expanded-body component. */
  ExpandedBody: ComponentType<ToolRendererProps>;
}
