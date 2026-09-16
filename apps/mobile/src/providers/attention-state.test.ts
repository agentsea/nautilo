import { describe, expect, test } from "bun:test";
import type {
  ApprovalAskEvent,
  ApprovalReplyVerb,
  ApprovalResolvedEvent,
  IdentityChallengeEvent,
  ProveItChallengeEvent,
} from "@nautilo/types";

import {
  createAttentionAuthorityCoordinator,
  mayAdmitAttentionEvent,
  sameAttentionScope,
  type AttentionAuthorityEndpoints,
  type AttentionScope,
  type PinChallenge,
} from "./attention-state";

const scope = (epoch = 1): AttentionScope => ({
  serverId: "server-a", serverUrl: "https://server-a.test", userId: "user-a", actorId: "actor-a", epoch,
});
const ask = (id: string, taskId = "task-a", taskRunId = "run-a"): ApprovalAskEvent => ({
  type: "approval.ask", approvalId: id, threadId: `thread-${taskId}`, laneKey: `task:${taskId}`,
  origin: "task", taskId, taskRunId, tools: [], reason: "Exact approval", reasonCode: "tier-bump",
  allowedVerbs: ["once", "room", "always", "deny"],
});
const resolved = (approval: ApprovalAskEvent): ApprovalResolvedEvent => ({
  type: "approval.resolved", approvalId: approval.approvalId, threadId: approval.threadId,
  laneKey: approval.laneKey, origin: "task", taskId: approval.taskId, taskRunId: approval.taskRunId,
  userId: "user-a", resolution: "approved", verb: "once",
});
const prove = (taskId = "task-a", taskRunId = "run-a"): PinChallenge => ({
  kind: "prove_it",
  event: { type: "prove_it.challenge", threadId: `thread-${taskId}`, laneKey: `task:${taskId}`, origin: "task", taskId, taskRunId, tools: [] } as ProveItChallengeEvent,
});
const identity = (mode: "verify" | "enrollPin" = "verify", taskId = "task-a"): PinChallenge => ({
  kind: "identity",
  event: { type: "identity.challenge", threadId: `thread-${taskId}`, laneKey: `task:${taskId}`, challengeId: `challenge-${taskId}`, expiresAt: "2100-01-01T00:00:00.000Z", mode, origin: "task", taskId, taskRunId: "run-a" } as IdentityChallengeEvent,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function harness(
  overrides: Partial<AttentionAuthorityEndpoints> = {},
  onEndpointError?: (error: unknown, scope: AttentionScope) => Promise<void> | void,
) {
  let current: AttentionScope | null = scope();
  const calls: string[] = [];
  const endpoints: AttentionAuthorityEndpoints = {
    approvalReply: async (_scope, approval, verb) => { calls.push(`approval:${verb}:${approval.approvalId}:${approval.threadId}:${approval.laneKey}`); return true; },
    proveIt: async (_scope, challenge, pin) => { calls.push(`prove:${pin}:${challenge.threadId}:${challenge.laneKey}`); return true; },
    denyProveIt: async (_scope, challenge) => { calls.push(`deny:${challenge.threadId}:${challenge.laneKey}`); return true; },
    verifyIdentity: async (_scope, challenge, pin) => { calls.push(`verify:${pin}:${challenge.threadId}:${challenge.laneKey}`); return true; },
    enrollPin: async (_scope, challenge, pin) => { calls.push(`enroll:${pin}:${challenge.threadId}:${challenge.laneKey}`); return true; },
    ...overrides,
  };
  const coordinator = createAttentionAuthorityCoordinator({
    currentScope: () => current,
    endpoints,
    onStateChange: () => {},
    onEndpointError,
  });
  return { coordinator, calls, setScope: (next: AttentionScope | null) => { current = next; } };
}

describe("Mobile Attention authority coordinator", () => {
  test("admits Task attention only for its exact recipient while preserving legacy room compatibility", () => {
    const task = ask("private-task");
    expect(mayAdmitAttentionEvent(scope(), task)).toBe(false);
    expect(mayAdmitAttentionEvent(scope(), { ...task, userId: "user-b" })).toBe(false);
    expect(mayAdmitAttentionEvent(scope(), { ...task, userId: "user-a" })).toBe(true);
    const legacy = { ...task, origin: undefined, taskId: undefined, taskRunId: undefined, laneKey: "room:one" };
    expect(mayAdmitAttentionEvent(scope(), legacy)).toBe(true);
    expect(mayAdmitAttentionEvent(scope(), { ...resolved(task), userId: "user-b" })).toBe(false);
  });

  test("reserves one exact auto approval before posting and exposes it on rejection", async () => {
    const first = deferred<boolean>();
    const h = harness({ approvalReply: async (_scope, approval, verb) => {
      h.calls.push(`approval:${verb}:${approval.approvalId}`);
      return first.promise;
    } });
    const event = ask("approval-a");
    h.coordinator.receiveApproval(scope(), event, true);
    h.coordinator.receiveApproval(scope(), event, true);
    expect(h.calls).toEqual(["approval:once:approval-a"]);
    expect(h.coordinator.getState().approvals[0]?.hidden).toBe(true);
    first.resolve(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.coordinator.getState().approvals[0]).toMatchObject({ approval: event, hidden: false, attempt: null });
  });

  test("does not post a resolved-before-ask or a stale rendered approval", async () => {
    const h = harness();
    const event = ask("approval-a");
    h.coordinator.receiveResolvedApproval(scope(), resolved(event));
    h.coordinator.receiveApproval(scope(), event, false);
    expect(h.coordinator.getState().approvals).toEqual([]);
    expect(await h.coordinator.replyApproval(scope(), event, "once")).toEqual({ ok: false });
    expect(h.calls).toEqual([]);
  });

  test("posts only stored exact manual once or deny replies and preserves a same-id other Task until its own reply", async () => {
    const h = harness();
    const a = ask("same", "task-a", "run-a");
    const b = ask("same", "task-b", "run-b");
    h.coordinator.receiveApproval(scope(), a, false);
    h.coordinator.receiveApproval(scope(), b, false);
    const storedA = h.coordinator.getState().approvals[0].approval;
    expect(await h.coordinator.replyApproval(scope(), { ...storedA }, "once")).toEqual({ ok: false });
    expect(await h.coordinator.replyApproval(scope(), storedA, "once")).toEqual({ ok: true });
    expect(h.coordinator.getState().approvals.map((record) => record.approval)).toEqual([b]);
    const storedB = h.coordinator.getState().approvals[0].approval;
    expect(await h.coordinator.replyApproval(scope(), storedB, "deny")).toEqual({ ok: true });
    expect(h.calls).toEqual([
      "approval:once:same:thread-task-a:task:task-a",
      "approval:deny:same:thread-task-b:task:task-b",
    ]);
  });

  test("manual approval validates its verb before one exact call and clears a failed attempt for recovery", async () => {
    const h = harness({ approvalReply: async (_scope, approval, verb) => {
      h.calls.push(`manual:${verb}:${approval.approvalId}:${approval.threadId}:${approval.laneKey}`);
      return false;
    } });
    const event = { ...ask("manual"), allowedVerbs: ["once"] as ApprovalReplyVerb[] };
    h.coordinator.receiveApproval(scope(), event, false);
    const stored = h.coordinator.getState().approvals[0].approval;
    expect(await h.coordinator.replyApproval(scope(), stored, "deny")).toEqual({ ok: false });
    expect(h.calls).toEqual([]);
    expect(await h.coordinator.replyApproval(scope(), stored, "once")).toEqual({ ok: false });
    expect(h.calls).toEqual(["manual:once:manual:thread-task-a:task:task-a"]);
    expect(h.coordinator.getState().approvals[0]).toMatchObject({ approval: stored, hidden: false, attempt: null });
  });

  test("a local room success tombstones its exact lane until authoritative terminal evidence arrives", async () => {
    const h = harness();
    const room = { ...ask("room-a"), origin: undefined, taskId: undefined, taskRunId: undefined, laneKey: "room:one" };
    h.coordinator.receiveApproval(scope(), room, false);
    const stored = h.coordinator.getState().approvals[0].approval;
    expect(await h.coordinator.replyApproval(scope(), stored, "once")).toEqual({ ok: true });
    h.coordinator.receiveApproval(scope(), room, false);
    expect(h.coordinator.getState().approvals).toEqual([]);
  });

  test("settles failures and scope switches without an optimistic terminal mutation", async () => {
    const pending = deferred<boolean>();
    const h = harness({ approvalReply: () => pending.promise });
    const event = ask("approval-a");
    h.coordinator.receiveApproval(scope(), event, false);
    const reply = h.coordinator.replyApproval(scope(), h.coordinator.getState().approvals[0].approval, "once");
    expect(h.coordinator.getState().approvals[0]?.attempt).not.toBeNull();
    h.setScope(scope(2));
    pending.resolve(true);
    await reply;
    expect(sameAttentionScope(h.coordinator.getState().scope, scope(2))).toBe(true);
    expect(h.coordinator.getState().approvals).toEqual([]);
  });

  test("wrong, missing, or rapid alternate approval scopes have zero calls", async () => {
    const pending = deferred<boolean>();
    let calls = 0;
    const h = harness({ approvalReply: async () => { calls += 1; return pending.promise; } });
    const event = ask("approval-a");
    h.coordinator.receiveApproval(scope(), event, false);
    const stored = h.coordinator.getState().approvals[0].approval;
    h.setScope(null);
    expect(await h.coordinator.replyApproval(scope(), stored, "once")).toEqual({ ok: false });
    expect(calls).toBe(0);
    h.setScope(scope());
    const first = h.coordinator.replyApproval(scope(), stored, "once");
    expect(await h.coordinator.replyApproval(scope(), stored, "deny")).toEqual({ ok: false });
    expect(calls).toBe(1);
    pending.resolve(false);
    await first;
  });

  test("an endpoint and reporter failure still settles the exact record and returns recoverably", async () => {
    const h = harness({ approvalReply: async () => { throw new Error("offline"); } }, async () => { throw new Error("report failed"); });
    const event = ask("approval-a");
    h.coordinator.receiveApproval(scope(), event, false);
    const stored = h.coordinator.getState().approvals[0].approval;
    expect(await h.coordinator.replyApproval(scope(), stored, "once")).toEqual({ ok: false });
    expect(h.coordinator.getState().approvals[0]).toMatchObject({ approval: stored, attempt: null, hidden: false });
  });

  test("routes prove-it, deny, identity verify, and PIN enrollment to their exact endpoints", async () => {
    const h = harness();
    const proof = prove();
    h.coordinator.receiveChallenge(scope(), proof);
    expect(await h.coordinator.resolveChallenge(scope(), proof, "123456")).toEqual({ ok: true });
    h.coordinator.receiveChallenge(scope(), proof);
    expect(await h.coordinator.denyChallenge(scope(), proof)).toEqual({ ok: true });
    const verify = identity("verify");
    h.coordinator.receiveChallenge(scope(), verify);
    expect(await h.coordinator.resolveChallenge(scope(), verify, "12345678")).toEqual({ ok: true });
    const enroll = identity("enrollPin");
    h.coordinator.receiveChallenge(scope(), enroll);
    expect(await h.coordinator.resolveChallenge(scope(), enroll, "765432")).toEqual({ ok: true });
    expect(h.calls).toEqual([
      "prove:123456:thread-task-a:task:task-a",
      "deny:thread-task-a:task:task-a",
      "verify:12345678:thread-task-a:task:task-a",
      "enroll:765432:thread-task-a:task:task-a",
    ]);
  });

  test("a rejected PIN endpoint leaves only the exact current challenge retryable", async () => {
    const h = harness({ proveIt: async () => false });
    const proof = prove();
    h.coordinator.receiveChallenge(scope(), proof);
    expect(await h.coordinator.resolveChallenge(scope(), proof, "123456")).toEqual({ ok: false });
    expect(h.coordinator.getState().challenge).toMatchObject({ challenge: proof, attempt: null, presented: true });
  });

  test("a throwing PIN endpoint and recovery reporter still leave the exact challenge retryable", async () => {
    const h = harness({ proveIt: async () => { throw new Error("offline"); } }, async () => { throw new Error("report failed"); });
    const proof = prove();
    h.coordinator.receiveChallenge(scope(), proof);
    expect(await h.coordinator.resolveChallenge(scope(), proof, "123456")).toEqual({ ok: false });
    expect(h.coordinator.getState().challenge).toMatchObject({ challenge: proof, attempt: null, presented: true });
  });

  test("rejects malformed Task events, expired identity, and a late expiry terminal without calls", () => {
    const h = harness();
    const badAsk = { ...ask("bad"), taskRunId: undefined } as ApprovalAskEvent;
    const badChallenge = { kind: "prove_it", event: { ...prove().event, taskRunId: undefined } as ProveItChallengeEvent } as PinChallenge;
    const expired = { kind: "identity", event: { ...identity().event, expiresAt: "2000-01-01T00:00:00.000Z" } as IdentityChallengeEvent } as PinChallenge;
    h.coordinator.receiveApproval(scope(), badAsk, true);
    h.coordinator.receiveChallenge(scope(), badChallenge);
    h.coordinator.receiveChallenge(scope(), expired);
    expect(h.coordinator.getState().approvals).toEqual([]);
    expect(h.coordinator.getState().challenge).toBeNull();
    expect(h.calls).toEqual([]);
    const event = ask("expired");
    h.coordinator.receiveApproval(scope(), event, false);
    h.coordinator.receiveResolvedApproval(scope(), { ...resolved(event), resolution: "expired", verb: undefined });
    expect(h.coordinator.getState().approvals).toEqual([]);
    h.coordinator.receiveApproval(scope(), event, false);
    expect(h.coordinator.getState().approvals).toEqual([]);
  });

  test("rejects malformed PIN before a call, hides/reopens identity, expires it, and fences a superseded response", async () => {
    const pending = deferred<boolean>();
    let proofCalls = 0;
    const h = harness({ proveIt: () => { proofCalls += 1; return pending.promise; } });
    const proofA = prove("task-a");
    const proofB = prove("task-b");
    h.coordinator.receiveChallenge(scope(), proofA);
    expect(await h.coordinator.resolveChallenge(scope(), proofA, "12")).toEqual({ ok: false });
    expect(h.calls).toEqual([]);
    const resolveA = h.coordinator.resolveChallenge(scope(), proofA, "123456");
    expect(await h.coordinator.denyChallenge(scope(), proofA)).toEqual({ ok: false });
    expect(proofCalls).toBe(1);
    h.coordinator.receiveChallenge(scope(), proofB);
    pending.resolve(true);
    await resolveA;
    expect(h.coordinator.getState().challenge?.challenge).toBe(proofB);
    const identityA = identity();
    h.coordinator.receiveChallenge(scope(), identityA);
    expect(await h.coordinator.denyChallenge(scope(), identityA)).toEqual({ ok: true });
    expect(h.coordinator.getState().challenge?.presented).toBe(false);
    h.coordinator.presentChallenge(scope(), identityA);
    expect(h.coordinator.getState().challenge?.presented).toBe(true);
    h.coordinator.expireChallenge(scope(), identityA, Date.parse("2101-01-01T00:00:00.000Z"));
    expect(h.coordinator.getState().challenge).toBeNull();
  });
});
