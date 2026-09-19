import { GraphRecursionError } from "@langchain/langgraph";
import { fromRuntimeConfig } from "@nautilo/config";

/**
 * Shared graph execution policy for foreground, forked, scoped, and resumed
 * runs. Every entry point resolves this policy and passes its recursion limit
 * to LangGraph. The million-step ceiling is an overflow backstop, while three
 * repeated normalized failures trigger correction and then a typed
 * `no_progress` stop. User Stop and human interrupts remain authoritative.
 *
 * LangGraph's raw {@link GraphRecursionError} is mapped to a typed internal
 * {@link GraphBudgetOutcome}. `friendly-errors.ts` renders the user-safe text;
 * raw framework details stay in server logs.
 */
export const DEFAULT_GRAPH_RECURSION_LIMIT = 1_000_000;

/**
 * Default number of identical normalized failures that
 * trigger one corrective model turn before a typed `no_progress` stop. The
 * stop fires on the next identical failure after the corrective turn was
 * issued (limit + 1). Mirrors the spec's policy:
 *
 * ```ts
 * type GraphExecutionPolicy = {
 * recursionLimit: 1_000_000;
 * repeatedFailureLimit: 3;
 * explicitTimeLimitMs?: number;
 * };
 * ```
 *
 * Re-exported here (and from the agent package index) so the runtime / tests
 * resolve it from the single policy seam alongside the recursion ceiling.
 */
export const DEFAULT_REPEATED_FAILURE_LIMIT = 3;

/**
 * Resolved execution policy for one graph invocation. Internal callers and
 * tests may override these values through the shared resolution seam.
 */
export interface GraphExecutionPolicy {
  /** Technical ceiling on LangGraph supersteps. */
  recursionLimit: number;
  /**
   * Identical normalized failures that trigger one corrective model turn
   * before a typed `no_progress` stop.
   */
  repeatedFailureLimit: number;
  /** Consecutive recoverable browser-decision events before Genie intervention. */
  browserDecisionInterventionLimit: number;
}

/** Internal/test override seam; production call sites normally omit this. */
export type GraphExecutionPolicyOverrides = Partial<GraphExecutionPolicy>;

/**
 * Resolve the execution policy for one graph invocation.
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
  const browserDecisionInterventionLimit = overrides.browserDecisionInterventionLimit
    ?? fromRuntimeConfig().nautilo_browser_decision_intervention_limit;
  if (!Number.isInteger(recursionLimit) || recursionLimit < 1) {
    throw new Error(`Invalid graph recursion limit: ${recursionLimit}`);
  }
  if (!Number.isInteger(repeatedFailureLimit) || repeatedFailureLimit < 1) {
    throw new Error(`Invalid repeated failure limit: ${repeatedFailureLimit}`);
  }
  if (!Number.isInteger(browserDecisionInterventionLimit) || browserDecisionInterventionLimit < 1) {
    throw new Error(`Invalid browser decision intervention limit: ${browserDecisionInterventionLimit}`);
  }
  return {
    recursionLimit,
    repeatedFailureLimit,
    browserDecisionInterventionLimit,
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
 * ( — framework failure remains distinct in telemetry, not in the WS
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
 * Telemetry-only : logged to `server.log`, never persisted, never put on
 * a WS event.
 */
export interface GraphExecutionMetricsSnapshot {
  readonly elapsedMs: number;
  readonly supersteps: number;
  readonly modelInvocations: number;
  readonly toolCalls: number;
}

/**
 * measurable counters fed from the existing `streamEvents` hook.
 *
 * Each graph entry point already iterates `for await (const ev of
 * graph.streamEvents(...))`; calling {@link noteStreamEvent} per event counts
 * supersteps (`on_chain_end` for every Nautilo graph node: `pre_model`,
 * `agent`, `post_model`, `tools`, and `await_reply`), model invocations
 * (`on_chat_model_start`), and tool calls (`on_tool_start`) — the same event
 * shapes `processStreamEvent` already dispatches on, so no new hook is
 * invented. The snapshot is logged at stream end / on error via `log`.
 * No persistence is introduced ( — telemetry-only defaults).
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
        name === "browser_decision" ||
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
