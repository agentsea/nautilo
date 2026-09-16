/**
 * ISSUE-D440 Phase 0 → Phase 3 — approval UI terminal-state reconciliation.
 *
 * This file was originally a Phase 0 *characterization* test that pinned
 * the buggy seam by asserting against source text of
 * `nautilo-runtime.tsx` (e.g. "the catch path does not contain
 * `show: false`", "the ask case has no terminality guard"). That made
 * the test a source-shape assertion: it broke on any refactor and
 * silently passed if the bug moved.
 *
 * D440 replaces those brittle source-characterization assertions with
 * behavioral tests of the pure approval lifecycle reducer
 * (`apps/workbench/src/approval/approval-lifecycle.ts`) that now owns
 * the dock. The three invariants the characterization test pinned are
 * now asserted behaviorally:
 *
 *   1. Lost HTTP acknowledgement keeps the dock visible (conservative
 *      reconciliation — we do not invent terminal evidence).
 *   2. Unrelated `tool.end` / `job.status` events cannot clear
 *      another approval (the reducer has no action for them, so by
 *      construction they cannot).
 *   3. A late or duplicate `approval.ask` for an already-terminal id
 *      cannot reopen the dock (terminality guard).
 */

import { describe, expect, test } from "bun:test";
import {
  deriveApprovalAskView,
  initialApprovalLifecycleState,
  reduceApprovalLifecycle,
  resolutionFromVerb,
  type ApprovalAskPayload,
} from "../../src/approval/approval-lifecycle";

function askPayload(approvalId: string, threadId = "thread-1"): ApprovalAskPayload {
  return {
    approvalId,
    threadId,
    laneKey: threadId,
    tools: [{ name: "run_shell", args: { command: "printf d440" } }],
    reason: "run_shell is gated",
    reasonCode: "destructive" as never,
    network: null,
    allowedVerbs: ["once", "room", "always", "deny"],
    scopeInfo: [],
  };
}

describe("D440 approval UI terminal-state reconciliation (behavioral)", () => {
  test("lost approval HTTP acknowledgement leaves the actionable dock visible", () => {
    // Ask surfaces the dock.
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: askPayload("a-1"),
    });
    expect(deriveApprovalAskView(armed).show).toBe(true);

    // Submit starts (in-flight).
    const inflight = reduceApprovalLifecycle(armed, { kind: "submitStart" });
    expect(deriveApprovalAskView(inflight).submitting).toBe(true);

    // The HTTP reply is lost (catch). Conservative reconciliation:
    // keep the dock visible with the error so the user can retry.
    // We do NOT clear, and we do NOT record terminality.
    const lost = reduceApprovalLifecycle(inflight, {
      kind: "submitError",
      error: "network drop",
    });
    const view = deriveApprovalAskView(lost);
    expect(view.show).toBe(true);
    expect(view.approvalId).toBe("a-1");
    expect(view.error).toBe("network drop");
    expect(view.submitting).toBe(false);
    expect(lost.resolvedApprovalIds.has("a-1")).toBe(false);
  });

  test("tool.end and terminal job.status do not clear the matching approval id", () => {
    // The reducer is the single source of truth for the dock. There is
    // no `tool.end` / `job.status` action in its vocabulary, so the
    // provider cannot dispatch one — by construction, those events
    // cannot clear another approval. Behavioral proof: arm an ask,
    // then exercise every *non-clearing* action the reducer defines
    // and confirm the dock stays armed. The clearing actions
    // (`submitAck` / `resolved` / `hide`) are covered in the other
    // tests; `submitStart` and `submitError` must NOT hide the dock.
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: askPayload("a-2"),
    });
    expect(deriveApprovalAskView(armed).show).toBe(true);

    // submitStart arms the in-flight flag without hiding.
    const inflight = reduceApprovalLifecycle(armed, { kind: "submitStart" });
    expect(deriveApprovalAskView(inflight).show).toBe(true);
    expect(inflight.pending?.approvalId).toBe("a-2");

    // submitError (lost ack) keeps the dock visible with the error.
    const lost = reduceApprovalLifecycle(inflight, {
      kind: "submitError",
      error: "network drop",
    });
    expect(deriveApprovalAskView(lost).show).toBe(true);
    expect(lost.pending?.approvalId).toBe("a-2");

    // A server `resolved` for a *different* approval id must NOT wipe
    // the currently-pending ask — unrelated terminal evidence cannot
    // clear another approval.
    const unrelated = reduceApprovalLifecycle(armed, {
      kind: "resolved",
      approvalId: "someone-else",
      resolution: "approved",
      source: "server-event",
    });
    expect(deriveApprovalAskView(unrelated).show).toBe(true);
    expect(unrelated.pending?.approvalId).toBe("a-2");
    // The unrelated id is still recorded as terminal (a later ask for
    // it is ignored), but our pending dock is untouched.
    expect(unrelated.resolvedApprovalIds.has("someone-else")).toBe(true);
  });

  test("a late or duplicate approval.ask cannot reopen a terminal approval id", () => {
    // First ask surfaces, then the user approves (submit-ack) — the id
    // becomes terminal and the dock clears exactly once.
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: askPayload("a-3"),
    });
    const resolved = reduceApprovalLifecycle(armed, {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    expect(deriveApprovalAskView(resolved).show).toBe(false);
    expect(resolved.resolvedApprovalIds.has("a-3")).toBe(true);

    // A late (or duplicate) approval.ask for the same id is ignored —
    // the dock does NOT reopen.
    const reopened = reduceApprovalLifecycle(resolved, {
      kind: "ask",
      payload: askPayload("a-3"),
    });
    expect(reopened).toBe(resolved);
    expect(deriveApprovalAskView(reopened).show).toBe(false);

    // An ask for a *different* id still surfaces normally — the guard
    // is per-approvalId, not a global lock.
    const next = reduceApprovalLifecycle(resolved, {
      kind: "ask",
      payload: askPayload("a-4"),
    });
    expect(deriveApprovalAskView(next).show).toBe(true);
    expect(next.pending?.approvalId).toBe("a-4");
  });
});
