import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveGraphExecutionPolicy,
  DEFAULT_GRAPH_RECURSION_LIMIT,
  toGraphBudgetOutcome,
  GraphExecutionMetrics,
} from "@nautilo/agent";

/**
 * Stack 208 P0 — call-site parity test.
 *
 * The stack's invariant (R1): every graph entry point resolves ONE
 * `resolveGraphExecutionPolicy` and threads `policy.recursionLimit` into its
 * `streamEvents` config — no site hardcodes `100`. This is a static parity
 * test: it reads the six owned source files and asserts (a) each imports +
 * consumes the shared resolver from `@nautilo/agent`, (b) none hardcode a
 * numeric recursion limit, and (c) the seam returns the P0 default ceiling.
 *
 * A behavioral test that actually streams a graph is out of scope for P0
 * (would require a live checkpointer + model); the static parity test is the
 * reliable gate that the seam is the single source of truth.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const CALL_SITES = [
  "packages/runtime/src/executors/langgraph-executor.ts",
  "packages/runtime/src/executors/fork-langgraph-executor.ts",
  "packages/agent/src/subagents/scope-subagent/run.ts",
  "packages/agent/src/graph/resume-human-reply.ts",
  "packages/agent/src/graph/resume-approval.ts",
  "packages/agent/src/graph/resume-approval-ask.ts",
] as const;

function readCallSite(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("Stack 208 P0 — one shared policy seam consumed by all six recursion-limit sites", () => {
  test("every call site imports resolveGraphExecutionPolicy", () => {
    for (const rel of CALL_SITES) {
      const src = readCallSite(rel);
      expect(src, `${rel} should import resolveGraphExecutionPolicy`).toContain(
        "resolveGraphExecutionPolicy",
      );
    }
  });

  test("every call site threads policy.recursionLimit into its stream config (no hardcoded 100)", () => {
    for (const rel of CALL_SITES) {
      const src = readCallSite(rel);
      // Each site must reference the resolved policy's recursionLimit.
      expect(src, `${rel} should reference executionPolicy.recursionLimit`).toContain(
        "executionPolicy.recursionLimit",
      );
      // No site hardcodes the numeric recursion limit anymore.
      expect(src, `${rel} must not hardcode recursionLimit: 100`).not.toContain(
        "recursionLimit: 100",
      );
    }
  });

  test("no call site hardcodes any numeric recursionLimit literal", () => {
    // Guard against a site sneaking in a different magic number.
    const numericRecursionLimit = /recursionLimit\s*:\s*\d+/;
    for (const rel of CALL_SITES) {
      const src = readCallSite(rel);
      expect(
        numericRecursionLimit.test(src),
        `${rel} must not hardcode any numeric recursionLimit`,
      ).toBe(false);
    }
  });

  test("the runtime executors import the seam from @nautilo/agent (single source of truth)", () => {
    const fg = readCallSite("packages/runtime/src/executors/langgraph-executor.ts");
    const fork = readCallSite("packages/runtime/src/executors/fork-langgraph-executor.ts");
    // Both runtime executors must import the seam from the agent package, not
    // re-declare a local constant.
    expect(fg).toContain("resolveGraphExecutionPolicy");
    expect(fork).toContain("resolveGraphExecutionPolicy");
    // The agent-owned sites import from the local execution-policy module.
    expect(readCallSite("packages/agent/src/subagents/scope-subagent/run.ts")).toContain(
      "execution-policy",
    );
    expect(readCallSite("packages/agent/src/graph/resume-human-reply.ts")).toContain(
      "execution-policy",
    );
  });

  test("the seam returns the P2 technical ceiling (1_000_000) after the P1/P2 gates shipped", () => {
    expect(DEFAULT_GRAPH_RECURSION_LIMIT).toBe(1_000_000);
    expect(resolveGraphExecutionPolicy().recursionLimit).toBe(1_000_000);
  });
});

describe("Stack 208 P0 — GraphRecursionError outcome + metrics are reachable from the runtime", () => {
  test("toGraphBudgetOutcome is the agent-seam helper (typed internal outcome, R9)", () => {
    expect(typeof toGraphBudgetOutcome).toBe("function");
    // Non-recursion errors return null so the runtime catch site falls through
    // to the generic friendly classifier.
    expect(toGraphBudgetOutcome(new Error("timeout"))).toBeNull();
  });

  test("GraphExecutionMetrics is constructible from the runtime and counts supersteps", () => {
    const metrics = new GraphExecutionMetrics(() => 0);
    metrics.noteStreamEvent({ event: "on_chain_end", name: "pre_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "agent" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "post_model" });
    metrics.noteStreamEvent({ event: "on_chain_end", name: "tools" });
    metrics.noteStreamEvent({ event: "on_tool_start", name: "t" });
    const snap = metrics.snapshot();
    expect(snap.supersteps).toBe(4);
    expect(snap.toolCalls).toBe(1);
  });
});

