/**
 * ISSUE-D440 — pure approval lifecycle reducer tests.
 *
 * Behavioral coverage for `apps/workbench/src/approval/approval-lifecycle.ts`.
 * The reducer owns every approval dock invariant; these tests pin them
 * so a refactor that moves the invariants back into prose comments
 * fails loudly. See the D440 grounded verdict: backend ordering is
 * safe; the defect is Workbench stale state after a lost ack and
 * late/duplicate asks.
 */

import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  deriveApprovalAskView,
  enqueuePendingApprovalPreviews,
  initialApprovalLifecycleState,
  initialPendingApprovalPreviewQueue,
  settlePendingApprovalPreview,
  reconcilePendingApprovalPreviewSnapshot,
  shouldQueueApprovalAsk,
  reduceApprovalLifecycle,
  resolutionFromVerb,
  type ApprovalAskPayload,
} from "../../src/approval/approval-lifecycle";

function ask(approvalId: string, threadId = "thread-1"): ApprovalAskPayload {
  return {
    approvalId,
    threadId,
    laneKey: threadId,
    tools: [{ name: "run_shell", args: { command: "printf d440" } }],
    reason: "gated",
    reasonCode: "destructive" as never,
    network: null,
    allowedVerbs: ["once", "room", "always", "deny"],
    scopeInfo: [],
  };
}

describe("D440 approval lifecycle reducer", () => {
  test("replays every recovered pending approval in arrival order", () => {
    const first = ask("recovered-1");
    const second = ask("recovered-2");
    const queued = enqueuePendingApprovalPreviews(
      initialPendingApprovalPreviewQueue<ApprovalAskPayload>(),
      [first, second],
    );
    expect(queued.active?.approvalId).toBe("recovered-1");
    expect(queued.waiting.map((item) => item.approvalId)).toEqual(["recovered-2"]);

    const advanced = settlePendingApprovalPreview(queued);
    expect(advanced.active?.approvalId).toBe("recovered-2");
    expect(advanced.waiting).toEqual([]);
  });

  test("does not settle a newer queued approval from an older callback", () => {
    const first = ask("recovered-1");
    const second = ask("recovered-2");
    const queued = enqueuePendingApprovalPreviews(
      initialPendingApprovalPreviewQueue<ApprovalAskPayload>(),
      [first, second, second],
      (item) => item.approvalId,
    );
    const mismatch = settlePendingApprovalPreview(
      queued,
      (active) => active.approvalId === "recovered-2",
    );
    expect(mismatch).toBe(queued);
    expect(mismatch.waiting).toEqual([second]);
  });
  test("ignores an older HTTP acknowledgement or error after a newer ask is pending", () => {
    const newer = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("newer"),
    });
    expect(reduceApprovalLifecycle(newer, {
      kind: "submitAck",
      approvalId: "older",
      resolution: "approved",
    })).toBe(newer);
    expect(reduceApprovalLifecycle(newer, {
      kind: "submitError",
      approvalId: "older",
      error: "older request failed",
    })).toBe(newer);
  });
  test("rejects a duplicate terminal ask before it can occupy the preview queue", () => {
    const resolved = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "resolved",
      approvalId: "terminal",
      resolution: "approved",
      source: "server-event",
    });
    expect(shouldQueueApprovalAsk(resolved, "terminal")).toBe(false);
    expect(shouldQueueApprovalAsk(resolved, "new")).toBe(true);
  });
  test("reconciles canonical snapshots while retaining an exact active retry", () => {
    const first = ask("a");
    const second = ask("b");
    const active = enqueuePendingApprovalPreviews(
      initialPendingApprovalPreviewQueue<ApprovalAskPayload>(), [first, second],
    );
    const retained = reconcilePendingApprovalPreviewSnapshot(active, [first, second],
      (item) => item.approvalId);
    expect(retained.retainedActive).toBe(true);
    expect(retained.queue.active).toBe(first);
    expect(retained.queue.waiting).toEqual([second]);

    const replaced = reconcilePendingApprovalPreviewSnapshot(active, [second],
      (item) => item.approvalId);
    expect(replaced.retainedActive).toBe(false);
    expect(replaced.queue.active).toBe(second);
    expect(reconcilePendingApprovalPreviewSnapshot(active, [],
      (item) => item.approvalId).queue.active).toBeNull();
  });
  test("reference previews retain the room captured with their approval", () => {
    const state = reduceApprovalLifecycle(initialApprovalLifecycleState(), { kind: "ask", payload: { ...ask("media-1"), roomId: "source-room" } });
    expect(deriveApprovalAskView(state).roomId).toBe("source-room");
    expect(deriveApprovalAskView(initialApprovalLifecycleState()).roomId).toBeUndefined();
  });
  test("initial state is hidden with no terminal ids", () => {
    const state = initialApprovalLifecycleState();
    expect(state.pending).toBeNull();
    expect(state.hidden).toBe(false);
    expect(state.submitting).toBe(false);
    expect(state.error).toBeNull();
    expect(state.resolvedApprovalIds.size).toBe(0);
    expect(deriveApprovalAskView(state).show).toBe(false);
  });

  test("ask arms the pending dock and surfaces it", () => {
    const state = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    expect(state.pending?.approvalId).toBe("a-1");
    expect(state.hidden).toBe(false);
    const view = deriveApprovalAskView(state);
    expect(view.show).toBe(true);
    expect(view.approvalId).toBe("a-1");
    expect(view.tools).toHaveLength(1);
    expect(view.error).toBeNull();
    expect(view.submitting).toBe(false);
  });

  test("silent ask arms the pending id without surfacing the dock (auto-approve no-flash)", () => {
    const state = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
      silent: true,
    });
    expect(state.pending?.approvalId).toBe("a-1");
    expect(state.hidden).toBe(true);
    expect(deriveApprovalAskView(state).show).toBe(false);
    // The id is armed: a successful auto-ack clears it and records
    // terminality, so a late duplicate ask is still guarded.
    const acked = reduceApprovalLifecycle(state, {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    expect(deriveApprovalAskView(acked).show).toBe(false);
    expect(acked.resolvedApprovalIds.has("a-1")).toBe(true);
  });

  test("silent ask surfaces on lost ack so the user can retry", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
      silent: true,
    });
    const lost = reduceApprovalLifecycle(armed, {
      kind: "submitError",
      error: "network drop",
    });
    expect(lost.hidden).toBe(false);
    expect(deriveApprovalAskView(lost).show).toBe(true);
    expect(lost.error).toBe("network drop");
    expect(lost.resolvedApprovalIds.has("a-1")).toBe(false);
  });

  test("submitAck clears the dock exactly once and records terminality", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const acked = reduceApprovalLifecycle(armed, {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    expect(acked.pending).toBeNull();
    expect(acked.resolvedApprovalIds.has("a-1")).toBe(true);
    expect(deriveApprovalAskView(acked).show).toBe(false);

    // A second submitAck (duplicate ack) is a no-op — exactly once.
    const acked2 = reduceApprovalLifecycle(acked, {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    expect(acked2).toEqual(acked);
  });

  test("submitAck with no pending ask is a no-op", () => {
    const state = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    expect(state).toEqual(initialApprovalLifecycleState());
  });

  test("deny records a denied terminal disposition", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const denied = reduceApprovalLifecycle(armed, {
      kind: "submitAck",
      resolution: resolutionFromVerb("deny"),
    });
    expect(denied.pending).toBeNull();
    expect(denied.resolvedApprovalIds.has("a-1")).toBe(true);
    expect(deriveApprovalAskView(denied).show).toBe(false);
  });

  test("server approval.resolved clears the matching pending dock exactly once", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const resolved = reduceApprovalLifecycle(armed, {
      kind: "resolved",
      approvalId: "a-1",
      resolution: "approved",
      source: "server-event",
    });
    expect(resolved.pending).toBeNull();
    expect(resolved.resolvedApprovalIds.has("a-1")).toBe(true);
    expect(deriveApprovalAskView(resolved).show).toBe(false);

    // Idempotent: a second resolved for the same id is a no-op.
    const resolved2 = reduceApprovalLifecycle(resolved, {
      kind: "resolved",
      approvalId: "a-1",
      resolution: "approved",
      source: "server-event",
    });
    expect(resolved2).toEqual(resolved);
  });

  test("server approval.resolved for a non-matching id does NOT wipe a newer pending ask", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const unrelated = reduceApprovalLifecycle(armed, {
      kind: "resolved",
      approvalId: "stale-id",
      resolution: "cancelled",
      source: "server-event",
    });
    // Pending dock untouched.
    expect(unrelated.pending?.approvalId).toBe("a-1");
    expect(deriveApprovalAskView(unrelated).show).toBe(true);
    // The stale id is terminal — a later ask for it is ignored.
    expect(unrelated.resolvedApprovalIds.has("stale-id")).toBe(true);
  });

  test("server approval.resolved for a terminal id, then a late ask, stays hidden", () => {
    // Server resolves before the ask ever surfaced (e.g. auto-ack
    // raced with a late server event). The id is terminal; a late
    // ask cannot reopen.
    const resolved = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "resolved",
      approvalId: "a-1",
      resolution: "expired",
      source: "server-event",
    });
    const reopened = reduceApprovalLifecycle(resolved, {
      kind: "ask",
      payload: ask("a-1"),
    });
    expect(reopened).toBe(resolved);
    expect(deriveApprovalAskView(reopened).show).toBe(false);
  });

  test("hide (room switch) clears the dock but keeps the terminal set", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const acked = reduceApprovalLifecycle(armed, {
      kind: "submitAck",
      resolution: resolutionFromVerb("once"),
    });
    // New ask after a room switch.
    const reArmed = reduceApprovalLifecycle(acked, {
      kind: "ask",
      payload: ask("a-2"),
    });
    const hidden = reduceApprovalLifecycle(reArmed, { kind: "hide" });
    expect(hidden.pending).toBeNull();
    expect(deriveApprovalAskView(hidden).show).toBe(false);
    // Terminal set survives the room switch.
    expect(hidden.resolvedApprovalIds.has("a-1")).toBe(true);
    // A late ask for the resolved a-1 still cannot reopen.
    const reopened = reduceApprovalLifecycle(hidden, {
      kind: "ask",
      payload: ask("a-1"),
    });
    expect(reopened).toBe(hidden);
  });

  test("hide is a no-op when nothing is pending", () => {
    const state = initialApprovalLifecycleState();
    expect(reduceApprovalLifecycle(state, { kind: "hide" })).toBe(state);
  });

  test("submitStart only arms when an ask is pending", () => {
    const empty = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "submitStart",
    });
    expect(empty).toEqual(initialApprovalLifecycleState());

    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("a-1"),
    });
    const inflight = reduceApprovalLifecycle(armed, { kind: "submitStart" });
    expect(inflight.submitting).toBe(true);
    expect(inflight.error).toBeNull();
    expect(inflight.pending?.approvalId).toBe("a-1");
  });

  test("resolutionFromVerb maps deny → denied and approve-grains → approved", () => {
    expect(resolutionFromVerb("deny")).toBe("denied");
    expect(resolutionFromVerb("once")).toBe("approved");
    expect(resolutionFromVerb("room")).toBe("approved");
    expect(resolutionFromVerb("always")).toBe("approved");
  });

  test("deriveApprovalAskView default-loads allowedVerbs when no pending ask", () => {
    const view = deriveApprovalAskView(initialApprovalLifecycleState());
    expect(view.allowedVerbs).toEqual(["once", "room", "always", "deny"]);
    expect(view.show).toBe(false);
    expect(view.approvalId).toBeNull();
  });
});

describe("D440 approval.resolved server integration seam", () => {
  test("approval.resolved is a member of the ServerEvent union (protocol seam present)", () => {
    // Compile-time: the assignment below only typechecks if
    // `approval.resolved` is a member of the ServerEvent union. The
    // authoritative terminal event is defined in the shared types so
    // the Workbench can wire a handler today; the missing piece is a
    // server producer (see D440 deferral).
    const event: ServerEvent = {
      type: "approval.resolved",
      approvalId: "seam-1",
      threadId: "thread-1",
      userId: "user-1",
      resolution: "approved",
    };
    expect(event.type).toBe("approval.resolved");
  });

  test("an approval.resolved-shaped server event dispatches through the reducer (matched clear)", () => {
    const armed = reduceApprovalLifecycle(initialApprovalLifecycleState(), {
      kind: "ask",
      payload: ask("seam-1"),
    });
    const resolved = reduceApprovalLifecycle(armed, {
      kind: "resolved",
      approvalId: "seam-1",
      resolution: "approved",
      source: "server-event",
    });
    expect(resolved.pending).toBeNull();
    expect(resolved.resolvedApprovalIds.has("seam-1")).toBe(true);
  });
});
