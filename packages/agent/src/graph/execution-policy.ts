import { GraphRecursionError } from "@langchain/langgraph";

/**
 * Stack 208 P0 — one shared graph execution policy seam.
 *
 * Every graph entry point (foreground, fork, scope-subagent, and the three
 * resume paths) resolves a {@link GraphExecutionPolicy} through
 * {@link resolveGraphExecutionPolicy} and threads `policy.recursionLimit`
 * into its `streamEvents` config. No call site hardcodes `100`. P0 keeps the
 * effective limit at 100 (R1: the technical ceiling rises to `1_000_000`
 * only after the P1 storage and P2 no-progress gates ship). The seam exists
 * so later phases change ONE constant here rather than six scattered sites.
 *
 * R9 — LangGraph's raw {@link GraphRecursionError} is mapped here to a typed
 * internal {@link GraphBudgetOutcome}; `friendly-errors.ts` renders the
 * user-safe sentence while the raw framework detail (troubleshooting URL,
 * literal limit number) stays in server logs, never on the room-broadcast
 * WS event.
 */

/**
 * P0 default — unchanged from the prior scattered constants. R1 raises this
 * to `1_000_000` only after P1 (shallow saver) and P2 (no-progress breaker)
 * pass their gates. Keeping it here as a named constant means the raise is a
 * one-line diff in this file.
 *
 * Stack 208 P2 — the P1 storage gate and the P2 no-progress breaker have
 * shipped, so the technical recursion ceiling is now {@link DEFAULT_GRAPH_RECURSION_LIMIT}
 * below (1_000_000). This is an overflow / runaway backstop, NOT a normal
 * stopping condition (R1): legitimate long-running work may run for hours,
 * the no-progress breaker stops demonstrated failure loops, and User Stop /
 * explicit Task time pause / human interrupts remain authoritative (R3).
 */
export const DEFAULT_GRAPH_RECURSION_LIMIT = 1_000_000;

/**
 * Stack 208 P2 — default number of identical normalized failures that
 * trigger one corrective model turn before a typed `no_progress` stop. The
 * stop fires on the next identical failure after the corrective turn was
 * issued (limit + 1). Mirrors the spec's policy:
 *
 * ```ts
 * type GraphExecutionPolicy = {
 *   recursionLimit: 1_000_000;
 *   repeatedFailureLimit: 3;
 *   explicitTimeLimitMs?: number;
 * };
 * ```
 *
 * Re-exported here (and from the agent package index) so the runtime / tests
 * resolve it from the single policy seam alongside the recursion ceiling.
 */
export const DEFAULT_REPEATED_FAILURE_LIMIT = 3;

/**
 * Resolved execution policy for one graph invocation. P0 carried only the
 * recursion ceiling; P2 threads the {@link DEFAULT_REPEATED_FAILURE_LIMIT}
 * so the no-progress breaker is configurable from one seam. P3 may thread
 * explicit per-run / deployment caps (D2 / R2 — omitted means no deadline).
 */
export interface GraphExecutionPolicy {
  /** Technical ceiling on LangGraph supersteps (R1). */
  recursionLimit: number;
  /**
   * Stack 208 P2 — identical normalized failures that trigger one corrective
   * model turn before a typed `no_progress` stop (R4).
   */
  repeatedFailureLimit: number;
}

/** Internal/test override seam; production call sites normally omit this. */
export type GraphExecutionPolicyOverrides = Partial<GraphExecutionPolicy>;

/**
 * Resolve the execution policy for one graph invocation.
 *
 * P0 ignored explicit per-run / deployment caps (D2 / R2): an omitted
 * `time_limit_seconds` means no wall-clock termination, and the recursion
 * ceiling is a technical backstop, not a product budget. The seam is here so
 * P2 can thread a `repeatedFailureLimit` and P3 can raise the ceiling without
 * touching call sites.
 *
 * `input` is accepted (and intentionally unused) so the signature is stable
 * for future per-run cap threading. `overrides` is an internal/test seam for
 * proving non-default policy values flow to consumers; production call sites
 * omit it and receive the shared defaults above.
 */
export function resolveGraphExecutionPolicy(
  _input?: Record<string, unknown>,
  overrides: GraphExecutionPolicyOverrides = {},
): GraphExecutionPolicy {
  const recursionLimit =
    overrides.recursionLimit ?? DEFAULT_GRAPH_RECURSION_LIMIT;
  const repeatedFailureLimit =
    overrides.repeatedFailureLimit ?? DEFAULT_REPEATED_FAILURE_LIMIT;
  if (!Number.isInteger(recursionLimit) || recursionLimit < 1) {
    throw new Error(`Invalid graph recursion limit: ${recursionLimit}`);
  }
  if (!Number.isInteger(repeatedFailureLimit) || repeatedFailureLimit < 1) {
    throw new Error(`Invalid repeated failure limit: ${repeatedFailureLimit}`);
  }
  return {
    recursionLimit,
    repeatedFailureLimit,
  };
}

/**
 * Typed internal outcome for a graph that exhausted its recursion ceiling.
 *
 * Distinct from the user-visible {@link FriendlyErrorCategory} (which stays
 * `unknown` on the WS event so the closed `JobStatusEvent.errorCategory`
 * union in `@nautilo/types` is untouched). The runtime job-loop catch site
 * detects this outcome and emits a structured `[nautilo/job]` log token so
 * `rg "graph_budget_exceeded" server.log` bridges to the specific failure
 * (R9 — framework failure remains distinct in telemetry, not in the WS
 * category union that would require a cross-boundary types change).
 */
export interface GraphBudgetOutcome {
  /** Discriminator — always `"graph_budget_exceeded"`. */
  readonly kind: "graph_budget_exceeded";
  /** The effective recursion limit that was reached. */
  readonly recursionLimit: number;
}

/**
 * Recognize LangGraph's raw {@link GraphRecursionError} (thrown when a run
 * exhausts its `recursionLimit`). Defensive against any thrown shape: checks
 * `instanceof` first, then the stable `name` and `lc_error_code` markers so
 * a transpiled / rewrapped / minified rethrow still classifies correctly.
 */
export function isGraphRecursionError(error: unknown): boolean {
  if (error instanceof GraphRecursionError) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e["name"] === "string" && e["name"] === "GraphRecursionError") return true;
  if (typeof e["lc_error_code"] === "string" && e["lc_error_code"] === "GRAPH_RECURSION_LIMIT") {
    return true;
  }
  return false;
}

/**
 * Map a recognized {@link GraphRecursionError} to a typed internal
 * {@link GraphBudgetOutcome}. Returns `null` for any other error shape so the
 * runtime catch site can branch cleanly (`if (outcome) … else friendly`).
 *
 * Callers that have already resolved a policy pass `policy.recursionLimit`,
 * which always takes precedence. When omitted (for example at the runtime
 * Job catch boundary), infer LangGraph's `Recursion limit of <N>` message.
 * Fall back to {@link DEFAULT_GRAPH_RECURSION_LIMIT} only when inference is
 * unavailable.
 */
export function toGraphBudgetOutcome(
  error: unknown,
  recursionLimit?: number,
): GraphBudgetOutcome | null {
  if (!isGraphRecursionError(error)) return null;
  return {
    kind: "graph_budget_exceeded",
    recursionLimit:
      recursionLimit ??
      inferGraphRecursionLimit(error) ??
      DEFAULT_GRAPH_RECURSION_LIMIT,
  };
}

function inferGraphRecursionLimit(error: unknown): number | null {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" &&
          typeof (error as Record<string, unknown>)["message"] === "string"
        ? ((error as Record<string, unknown>)["message"] as string)
        : "";
  const match = /Recursion limit of ([\d,_]+)\b/i.exec(message);
  if (!match?.[1]) return null;
  const inferred = Number(match[1].replace(/[,_]/g, ""));
  return Number.isSafeInteger(inferred) && inferred > 0 ? inferred : null;
}

/**
 * Read-only snapshot of a {@link GraphExecutionMetrics} accumulator.
 * Telemetry-only (D2): logged to `server.log`, never persisted, never put on
 * a WS event.
 */
export interface GraphExecutionMetricsSnapshot {
  readonly elapsedMs: number;
  readonly supersteps: number;
  readonly modelInvocations: number;
  readonly toolCalls: number;
}

/**
 * Stack 208 P0 — measurable counters fed from the existing `streamEvents` hook.
 *
 * Each graph entry point already iterates `for await (const ev of
 * graph.streamEvents(...))`; calling {@link noteStreamEvent} per event counts
 * supersteps (`on_chain_end` for every Nautilo graph node: `pre_model`,
 * `agent`, `post_model`, `tools`, and `await_reply`), model invocations
 * (`on_chat_model_start`), and tool calls (`on_tool_start`) — the same event
 * shapes `processStreamEvent` already dispatches on, so no new hook is
 * invented. The snapshot is logged at stream end / on error via `log()`.
 * No persistence is introduced (D2 — telemetry-only defaults).
 */
export class GraphExecutionMetrics {
  private readonly startedAt: number;
  private readonly now: () => number;
  private supersteps = 0;
  private modelInvocations = 0;
  private toolCalls = 0;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.startedAt = this.now();
  }

  /** Feed one raw `streamEvents` event. Ignores non-object / unrecognized shapes. */
  noteStreamEvent(ev: unknown): void {
    if (!ev || typeof ev !== "object") return;
    const e = ev as Record<string, unknown>;
    const event = typeof e["event"] === "string" ? e["event"] : "";
    if (event === "") return;
    const name = typeof e["name"] === "string" ? e["name"] : "";
    if (
      event === "on_chain_end" &&
      (
        name === "pre_model" ||
        name === "agent" ||
        name === "post_model" ||
        name === "tools" ||
        name === "await_reply"
      )
    ) {
      this.supersteps++;
    } else if (event === "on_chat_model_start") {
      this.modelInvocations++;
    } else if (event === "on_tool_start") {
      this.toolCalls++;
    }
  }

  snapshot(): GraphExecutionMetricsSnapshot {
    return {
      elapsedMs: this.now() - this.startedAt,
      supersteps: this.supersteps,
      modelInvocations: this.modelInvocations,
      toolCalls: this.toolCalls,
    };
  }

  /** Format the snapshot as a single log-line token (e.g. for `[nautilo/...]` lines). */
  formatLogToken(): string {
    const s = this.snapshot();
    return (
      `graph_metrics elapsed_ms=${s.elapsedMs} supersteps=${s.supersteps} ` +
      `model_invocations=${s.modelInvocations} tool_calls=${s.toolCalls}`
    );
  }
}
