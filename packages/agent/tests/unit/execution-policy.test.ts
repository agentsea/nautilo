import { describe, expect, test } from "bun:test";
import { GraphRecursionError } from "@langchain/langgraph";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveGraphExecutionPolicy,
  isGraphRecursionError,
  toGraphBudgetOutcome,
  GraphExecutionMetrics,
  DEFAULT_GRAPH_RECURSION_LIMIT,
  DEFAULT_REPEATED_FAILURE_LIMIT,
} from "../../src/graph/execution-policy";
import { applyToolResultsToStreaks } from "../../src/graph/no-progress";

const AGENT_ROOT = join(import.meta.dir, "..", "..");

/**
 * Stack 208 P0 — shared graph execution policy seam.
 *
 * Coverage: the resolver returns the P0 default ceiling (100), every graph
 * entry point consumes one resolver (no hardcoded `100`), and LangGraph's raw
 * `GraphRecursionError` maps to a typed internal `GraphBudgetOutcome` while
 * every other error shape returns `null`. The metrics accumulator counts
 * supersteps / model invocations / tool calls from the same `streamEvents`
 * shapes the executors already dispatch on.
 */
describe("resolveGraphExecutionPolicy (Stack 208 P0 / R1 + P2)", () => {
  test("returns the P2 technical ceiling (1_000_000) after the P1/P2 gates shipped", () => {
    const policy = resolveGraphExecutionPolicy();
    expect(policy.recursionLimit).toBe(1_000_000);
    expect(policy.recursionLimit).toBe(DEFAULT_GRAPH_RECURSION_LIMIT);
  });

  test("R1 — the ceiling is a single named constant (no call site hardcodes 100)", () => {
    // The seam exists so P3 raises ONE constant here instead of six scattered
    // sites. Assert the constant is the source of truth for the resolver.
    expect(DEFAULT_GRAPH_RECURSION_LIMIT).toBe(1_000_000);
    expect(resolveGraphExecutionPolicy().recursionLimit).toBe(DEFAULT_GRAPH_RECURSION_LIMIT);
    expect(resolveGraphExecutionPolicy({}).recursionLimit).toBe(DEFAULT_GRAPH_RECURSION_LIMIT);
    expect(resolveGraphExecutionPolicy({ time_limit_seconds: 60 }).recursionLimit).toBe(
      DEFAULT_GRAPH_RECURSION_LIMIT,
    );
  });

  test("R2 — omitted explicit caps do NOT lower the ceiling (no implicit deadline)", () => {
    // D2 / R2: omitted time_limit_seconds means no wall-clock termination. P0
    // ignores any explicit cap input — the seam is here so P2/P3 can thread
    // them later without changing call sites. Behavior today: unchanged.
    expect(resolveGraphExecutionPolicy(undefined).recursionLimit).toBe(
      resolveGraphExecutionPolicy({ time_limit_seconds: 999 }).recursionLimit,
    );
  });

  test("Stack 208 P2 — the policy carries repeatedFailureLimit (R4)", () => {
    const policy = resolveGraphExecutionPolicy();
    expect(policy.repeatedFailureLimit).toBe(3);
    expect(policy.repeatedFailureLimit).toBe(DEFAULT_REPEATED_FAILURE_LIMIT);
  });

  test("non-default repeatedFailureLimit flows from policy to helper behavior", () => {
    const policy = resolveGraphExecutionPolicy(undefined, {
      repeatedFailureLimit: 2,
    });
    expect(policy.repeatedFailureLimit).toBe(2);

    const failure = {
      toolName: "file",
      args: { command: "read" },
      status: "error" as const,
      errorContent: "Error: not found",
    };
    const first = applyToolResultsToStreaks(
      new Map(),
      [failure],
      policy.repeatedFailureLimit,
    );
    expect(first.action.kind).toBe("continue");
    const second = applyToolResultsToStreaks(
      first.streaks,
      [failure],
      policy.repeatedFailureLimit,
    );
    expect(second.action.kind).toBe("inject_corrective");
  });

  test("static parity — execution-policy owns the only default declaration and tools consumes resolver field", () => {
    const policySource = readFileSync(
      join(AGENT_ROOT, "src/graph/execution-policy.ts"),
      "utf8",
    );
    const helperSource = readFileSync(
      join(AGENT_ROOT, "src/graph/no-progress.ts"),
      "utf8",
    );
    const toolsSource = readFileSync(
      join(AGENT_ROOT, "src/nodes/tools.ts"),
      "utf8",
    );

    const declaration = /export const DEFAULT_REPEATED_FAILURE_LIMIT\s*=\s*3/g;
    expect((policySource.match(declaration) ?? []).length).toBe(1);
    expect((helperSource.match(declaration) ?? []).length).toBe(0);
    expect(toolsSource).toContain("resolveGraphExecutionPolicy()");
    expect(toolsSource).toContain("executionPolicy.repeatedFailureLimit");
    expect(toolsSource).not.toContain("DEFAULT_REPEATED_FAILURE_LIMIT");
  });
});

describe("isGraphRecursionError (Stack 208 P0 / R9)", () => {
  test("recognizes a real GraphRecursionError instance", () => {
    const err = new GraphRecursionError("Recursion limit of 100 reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    expect(isGraphRecursionError(err)).toBe(true);
  });

  test("recognizes a rewrapped throw via stable `name` marker", () => {
    // A transpiled / rewrapped rethrow may lose the prototype but keep `name`.
    const rewrapped = { name: "GraphRecursionError", message: "boom" };
    expect(isGraphRecursionError(rewrapped)).toBe(true);
  });

  test("recognizes a rewrapped throw via stable `lc_error_code` marker", () => {
    const rewrapped = { lc_error_code: "GRAPH_RECURSION_LIMIT", message: "boom" };
    expect(isGraphRecursionError(rewrapped)).toBe(true);
  });

  test("rejects unrelated errors, plain objects, and primitives", () => {
    expect(isGraphRecursionError(new Error("timeout"))).toBe(false);
    expect(isGraphRecursionError({ status: 429 })).toBe(false);
    expect(isGraphRecursionError({ name: "TypeError" })).toBe(false);
    expect(isGraphRecursionError(null)).toBe(false);
    expect(isGraphRecursionError(undefined)).toBe(false);
    expect(isGraphRecursionError("Recursion limit of 100 reached")).toBe(false);
    expect(isGraphRecursionError(42)).toBe(false);
  });
});

describe("toGraphBudgetOutcome (Stack 208 P0 / R9)", () => {
  test("maps a GraphRecursionError to a typed graph_budget_exceeded outcome", () => {
    const err = new GraphRecursionError("Recursion limit of 100 reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    const outcome = toGraphBudgetOutcome(err);
    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe("graph_budget_exceeded");
    // The outcome records the EFFECTIVE ceiling that was reached. With no
    // explicit ceiling passed, it is inferred from the error message (100),
    // which is the limit LangGraph actually threw against — distinct from
    // the raised {@link DEFAULT_GRAPH_RECURSION_LIMIT} (1_000_000).
    expect(outcome?.recursionLimit).toBe(100);
  });

  test("records the effective ceiling the caller passes (not just the default)", () => {
    const err = new GraphRecursionError("Recursion limit of 100 reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    const outcome = toGraphBudgetOutcome(err, 1_000_000);
    expect(outcome?.recursionLimit).toBe(1_000_000);
  });

  test("infers the effective ceiling from the GraphRecursionError message when omitted", () => {
    const err = new GraphRecursionError(
      "Recursion limit of 1000000 reached without hitting a stop condition.",
      { lc_error_code: "GRAPH_RECURSION_LIMIT" },
    );
    expect(toGraphBudgetOutcome(err)?.recursionLimit).toBe(1_000_000);
  });

  test("infers a formatted recursion ceiling from a rewrapped error message", () => {
    const err = {
      name: "GraphRecursionError",
      message: "Recursion limit of 1,000,000 reached without hitting a stop condition.",
    };
    expect(toGraphBudgetOutcome(err)?.recursionLimit).toBe(1_000_000);
  });

  test("explicit ceiling takes precedence over an inferred message value", () => {
    const err = new GraphRecursionError("Recursion limit of 100 reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    expect(toGraphBudgetOutcome(err, 1_000_000)?.recursionLimit).toBe(1_000_000);
  });

  test("falls back to the current default when the message has no inferable ceiling", () => {
    const err = new GraphRecursionError("Recursion limit reached", {
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    expect(toGraphBudgetOutcome(err)?.recursionLimit).toBe(
      DEFAULT_GRAPH_RECURSION_LIMIT,
    );
  });

  test("returns null for non-recursion errors (caller falls through to friendly)", () => {
    expect(toGraphBudgetOutcome(new Error("timeout"))).toBeNull();
    expect(toGraphBudgetOutcome({ status: 429 })).toBeNull();
    expect(toGraphBudgetOutcome(null)).toBeNull();
  });
});

describe("GraphExecutionMetrics (Stack 208 P0 / R9 — telemetry-only counters)", () => {
  test("counts every Nautilo graph node on on_chain_end", () => {
    const metrics = new GraphExecutionMetrics(() => 0);
    metrics.noteStreamEvent({ event: "on_chain_end", name: "pre_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "agent" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "post_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "tools" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "await_reply" });
    expect(metrics.snapshot().supersteps).toBe(5);
  });

  test("reports four supersteps for one complete tool round", () => {
    const metrics = new GraphExecutionMetrics(() => 0);
    metrics.noteStreamEvent({ event: "on_chain_end", name: "pre_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "agent" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "post_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "tools" });
    expect(metrics.snapshot().supersteps).toBe(4);
  });

  test("counts model invocations on on_chat_model_start and tool calls on on_tool_start", () => {
    const metrics = new GraphExecutionMetrics(() => 0);
    metrics.noteStreamEvent({ event: "on_chat_model_start", name: "ChatModel" });
    metrics.noteStreamEvent({ event: "on_chat_model_start", name: "ChatModel" });
    metrics.noteStreamEvent({ event: "on_tool_start", name: "search" });
    metrics.noteStreamEvent({ event: "on_tool_start", name: "read_file" });
    metrics.noteStreamEvent({ event: "on_tool_end", name: "search" });
    const snap = metrics.snapshot();
    expect(snap.modelInvocations).toBe(2);
    expect(snap.toolCalls).toBe(2);
    // on_tool_end is NOT a superstep (only Nautilo graph-node chain ends).
    expect(snap.supersteps).toBe(0);
  });

  test("ignores non-object / unrecognized event shapes", () => {
    const metrics = new GraphExecutionMetrics(() => 0);
    metrics.noteStreamEvent(null);
    metrics.noteStreamEvent(undefined);
    metrics.noteStreamEvent("ev");
    metrics.noteStreamEvent(42);
    metrics.noteStreamEvent({ event: "on_chain_start", name: "agent" });
    metrics.noteStreamEvent({ name: "agent" });
    metrics.noteStreamEvent({});
    const snap = metrics.snapshot();
    expect(snap.supersteps).toBe(0);
    expect(snap.modelInvocations).toBe(0);
    expect(snap.toolCalls).toBe(0);
  });

  test("snapshot reports elapsed time from the injected clock", () => {
    let now = 1_000;
    const metrics = new GraphExecutionMetrics(() => now);
    now = 2_500;
    expect(metrics.snapshot().elapsedMs).toBe(1_500);
  });

  test("formatLogToken renders a single grep-able line", () => {
    let now = 0;
    const metrics = new GraphExecutionMetrics(() => now);
    metrics.noteStreamEvent({ event: "on_chain_end", name: "agent" });
    metrics.noteStreamEvent({ event: "on_tool_start", name: "t" });
    now = 5_000;
    const token = metrics.formatLogToken();
    expect(token).toContain("graph_metrics");
    expect(token).toContain("elapsed_ms=5000");
    expect(token).toContain("supersteps=1");
    expect(token).toContain("tool_calls=1");
    expect(token).toContain("model_invocations=0");
  });
});
