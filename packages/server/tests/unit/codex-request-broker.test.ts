import { describe, expect, test } from "bun:test";
import type {
  RelayCodexClientMessage,
  RelayCodexRequestMessage,
  RelayCodexServerMessage,
} from "@nautilo/relay";
import type { HarnessRequestResponse } from "@nautilo/runtime";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { codexRequestScopePartitionIdentity, CodexRequestBroker, CodexRequestSourcePartition,
  type CodexRelayRequestSource } from "../../src/codex/request-broker";
import type { CodexRelayTurnScope } from "../../src/codex/turn-event-broker";

const scope: CodexRelayTurnScope = {
  relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 1,
  profileHandle: "profile", profileGeneration: 2, accountGeneration: 3,
  runtimeGeneration: 4, childGeneration: 5,
  workspace: {
    workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2099-07-30T00:00:00.000Z",
  },
  bindingId: "binding", bindingGeneration: 6,
  taskId: "task", jobId: "job", threadId: "thread", turnId: "turn",
};

function createSource(): {
  source: CodexRelayRequestSource;
  emit(message: RelayCodexClientMessage): void;
  invalidate(relayId: string): void;
  readonly sent: RelayCodexServerMessage[];
} {
  let listener: ((relayId: string, message: RelayCodexClientMessage) => void) | null = null;
  let invalidationListener: ((relayId: string, errorCode: string) => void) | null = null;
  const sent: RelayCodexServerMessage[] = [];
  return {
    source: {
      onCodexMessage(next) {
        listener = next;
        return () => { listener = null; };
      },
      onCodexContextInvalidated(next) {
        invalidationListener = next;
        return () => { invalidationListener = null; };
      },
      sendCodex(_relayId, message) {
        sent.push(message);
        return { ok: true };
      },
    },
    emit(message) { listener?.("relay", message); },
    invalidate(relayId) { invalidationListener?.(relayId, "CODEX_RELAY_UNAVAILABLE"); },
    sent,
  };
}

function request(input: {
  readonly requestRef?: string;
  readonly taskId?: string;
  readonly jobId?: string;
  readonly bindingGeneration?: number;
  readonly turnId?: string;
  readonly workspaceFingerprint?: string;
  readonly expiresAt?: string;
} = {}): RelayCodexRequestMessage {
  return {
    type: "relay:codex-request",
    scope: {
      ...scope,
      taskId: input.taskId ?? scope.taskId,
      jobId: input.jobId ?? scope.jobId,
      bindingGeneration: input.bindingGeneration ?? scope.bindingGeneration,
      turnId: input.turnId ?? scope.turnId,
      selectedProtocolVersion: 8,
      workspace: {
        workspaceRef: "workspace", revision: 1,
        fingerprint: input.workspaceFingerprint ?? scope.workspace.fingerprint,
        issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2099-07-30T00:00:00.000Z",
      },
      eventId: "event",
      itemId: "item",
      requestRef: input.requestRef ?? "request",
    },
    request: {
      kind: "command_approval",
      choices: ["accept", "decline"],
      reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["unknown"] },
      expiresAt: input.expiresAt ?? "2099-07-30T00:00:00.000Z",
    },
  };
}

function commandResponse(ownerId = "owner", requestId = "request"): HarnessRequestResponse {
  return { kind: "command_approval_required", requestId, ownerId, decision: "approve" };
}

function userInputRequest(): RelayCodexRequestMessage {
  const base = request({ requestRef: "plan-input-request" });
  return {
    ...base,
    scope: { ...base.scope, itemId: "plan-input-item" },
    request: {
      kind: "user_input",
      questions: [{
        id: "target", header: "Target", question: "Which target?",
        isOther: false, isSecret: false,
        options: [{ id: "tests", label: "Tests", description: "Run focused tests." }],
      }],
      autoResolutionMs: null,
      expiresAt: "2099-07-30T00:00:00.000Z",
    },
  };
}

function userInputResponse(): HarnessRequestResponse {
  return {
    kind: "user_input_required",
    requestId: "plan-input-request",
    ownerId: "owner",
    answers: { target: ["tests"] },
  };
}

describe("CodexRequestBroker", () => {
  test("partitions protected requests before buffering and retires only the exact Task Job scope", async () => {
    const upstream = createSource();
    const partition = new CodexRequestSourcePartition(upstream.source);
    const ordinary = new CodexRequestBroker({ source: partition.ordinary });
    const protectedBroker = new CodexRequestBroker({ source: partition.protected });
    const protection = partition.protect({ relayId: scope.relayId, bindingId: scope.bindingId,
      bindingGeneration: scope.bindingGeneration, taskId: scope.taskId, jobId: scope.jobId });
    const ordinarySubscription = ordinary.subscribe(scope, "ordinary-owner");
    const protectedSubscription = protectedBroker.subscribe(scope, "protected-owner");

    upstream.emit(request({ requestRef: "wrong-generation", bindingGeneration: 7 }));
    expect(ordinary.hasLiveRequest("wrong-generation", "ordinary-owner")).toBeFalse();
    expect(protectedBroker.hasLiveRequest("wrong-generation", "protected-owner")).toBeFalse();
    expect(() => codexRequestScopePartitionIdentity({ relayId: "relay", bindingId: "binding",
      bindingGeneration: "06", taskId: "task", jobId: "job" })).toThrow("binding generation");

    // The request can arrive before the protected provider has started
    // consuming; the partition was installed before any broker saw it.
    upstream.emit(request());
    expect(await protectedSubscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false, value: { scope: { requestRef: "request", taskId: "task", jobId: "job" } },
    });
    expect(protectedBroker.hasLiveRequest("request", "protected-owner")).toBeTrue();
    expect(ordinary.hasLiveRequest("request", "ordinary-owner")).toBeFalse();

    upstream.emit(request({ requestRef: "unknown-private", turnId: "unknown-turn" }));
    protectedSubscription.close();
    protection.close();
    expect(protectedBroker.hasLiveRequest("request", "protected-owner")).toBeFalse();
    expect(() => protectedBroker.subscribe({ ...scope, turnId: "unknown-turn" }, "protected-owner"))
      .toThrow(expect.objectContaining({ code: "stale_scope" }));
    upstream.emit(request({ requestRef: "late-private", turnId: "late-turn" }));
    expect(ordinary.hasLiveRequest("late-private", "ordinary-owner")).toBeFalse();
    expect(protectedBroker.hasLiveRequest("late-private", "protected-owner")).toBeFalse();

    const retryProtection = partition.protect({ relayId: scope.relayId, bindingId: scope.bindingId,
      bindingGeneration: scope.bindingGeneration, taskId: scope.taskId, jobId: scope.jobId });
    const retryScope = { ...scope, turnId: "retry-turn" };
    const retrySubscription = protectedBroker.subscribe(retryScope, "protected-owner");
    upstream.emit(request({ requestRef: "retry-private", turnId: "retry-turn" }));
    expect(await retrySubscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false, value: { scope: { requestRef: "retry-private", jobId: "job" } },
    });
    retrySubscription.close();
    retryProtection.close();

    const ordinaryScope = { ...scope, jobId: "later-ordinary-job", turnId: "ordinary-turn" };
    const ordinaryProtection = partition.claimOrdinary({ relayId: scope.relayId,
      bindingId: scope.bindingId, bindingGeneration: scope.bindingGeneration,
      taskId: scope.taskId, jobId: "later-ordinary-job" });
    const laterOrdinary = ordinary.subscribe(ordinaryScope, "ordinary-owner");
    upstream.emit(request({ requestRef: "ordinary-request", jobId: "later-ordinary-job",
      turnId: "ordinary-turn" }));
    expect(await laterOrdinary[Symbol.asyncIterator]().next()).toMatchObject({
      done: false, value: { scope: { requestRef: "ordinary-request", taskId: "task",
        jobId: "later-ordinary-job" } },
    });

    ordinarySubscription.close();
    laterOrdinary.close();
    ordinaryProtection.close();

    const invalidatedIdentity = { relayId: scope.relayId, bindingId: scope.bindingId,
      bindingGeneration: scope.bindingGeneration, taskId: scope.taskId, jobId: "reconnected-job" };
    const staleLease = partition.protect(invalidatedIdentity);
    upstream.invalidate(scope.relayId);
    const freshLease = partition.protect(invalidatedIdentity);
    staleLease.close();
    const freshScope = { ...scope, jobId: "reconnected-job", turnId: "fresh-turn" };
    const freshSubscription = protectedBroker.subscribe(freshScope, "protected-owner");
    upstream.emit(request({ requestRef: "fresh-private", jobId: "reconnected-job",
      turnId: "fresh-turn" }));
    expect(await freshSubscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false, value: { scope: { requestRef: "fresh-private" } },
    });
    freshSubscription.close();
    freshLease.close();
    ordinary.dispose();
    protectedBroker.dispose();
    partition.dispose();
  });

  test("proves live user-input membership only for the exact active owner and stream", () => {
    const { source, emit } = createSource();
    const broker = new CodexRequestBroker({ source });
    broker.subscribe(scope, "owner");
    emit(userInputRequest());

    expect(broker.hasLiveRequest("plan-input-request", "owner")).toBe(true);
    expect(broker.hasLiveRequest("plan-input-request", "intruder")).toBe(false);
    expect(broker.hasLiveUserInputRequest("plan-input-request", "owner")).toBe(true);
    expect(broker.hasLiveUserInputRequest("plan-input-request", "intruder")).toBe(false);
    broker.closeRelay("relay");
    expect(broker.hasLiveUserInputRequest("plan-input-request", "owner")).toBe(false);
    broker.dispose();
  });

  test("retains an early request and returns only its exact correlated response", async () => {
    const { source, emit, sent } = createSource();
    const broker = new CodexRequestBroker({ source });
    emit(request());
    const subscription = broker.subscribe(scope, "owner");
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false,
      value: { scope: { requestRef: "request", taskId: "task" } },
    });

    broker.respond(commandResponse(), createAcceptedInvocationAuthority("owner"));
    expect(sent).toHaveLength(1);
    const routed = sent[0];
    if (!routed || routed.type !== "relay:codex-request-response") throw new Error("missing response");
    expect(routed.scope.requestRef).toBe("request");
    expect(routed.scope.taskId).toBe("task");
    expect(routed.response).toEqual({ kind: "command_approval", decision: "accept" });
    // A duplicate native frame must not reopen a response that was already
    // routed exactly once.
    emit(request());
    expect(() => broker.respond(commandResponse(), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );
    broker.dispose();
  });

  test("does not deliver or answer a stale scope, wrong workspace, or different owner", async () => {
    const { source, emit } = createSource();
    const broker = new CodexRequestBroker({ source });
    emit(request({ taskId: "other-task", requestRef: "other" }));
    expect(() => broker.respond(commandResponse("owner", "other"), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );

    const subscription = broker.subscribe(scope, "owner");
    emit(request({ requestRef: "wrong-workspace", workspaceFingerprint: "other-workspace" }));
    expect(() => broker.respond(commandResponse("owner", "wrong-workspace"), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );
    emit(request());
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false,
      value: { scope: { requestRef: "request", workspace: { fingerprint: "fingerprint" } } },
    });
    expect(() => broker.respond(commandResponse("intruder"), createAcceptedInvocationAuthority("intruder"))).toThrow(
      expect.objectContaining({ code: "wrong_owner" }),
    );
    broker.dispose();
  });

  test("rejects an expired request and replayed request reference", () => {
    let now = 100;
    const { source, emit } = createSource();
    const broker = new CodexRequestBroker({ source, now: () => now });
    emit(request({ expiresAt: new Date(200).toISOString() }));
    broker.subscribe(scope, "owner");
    now = 201;
    expect(() => broker.respond(commandResponse(), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );

    broker.dispose();

    const replaySource = createSource();
    const replayBroker = new CodexRequestBroker({ source: replaySource.source });
    replaySource.emit(request());
    replaySource.emit(request());
    const subscription = replayBroker.subscribe(scope, "owner");
    expect(() => replayBroker.subscribe(scope, "owner")).toThrow(
      expect.objectContaining({ code: "consumer_exists" }),
    );
    subscription.close();
    replayBroker.dispose();
  });

  test("cancels outstanding requests on abort and known relay disconnect", () => {
    const { source, emit, invalidate } = createSource();
    const broker = new CodexRequestBroker({ source });
    const controller = new AbortController();
    broker.subscribe(scope, "owner", controller.signal);
    emit(request());
    controller.abort();
    expect(() => broker.respond(commandResponse(), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );

    const second = { ...scope, turnId: "second-turn" };
    broker.subscribe(second, "owner");
    emit(request({ requestRef: "second", turnId: "second-turn" }));
    // RelayRegistry invalidation, rather than a browser route, owns the
    // disconnect/re-registration lifecycle.
    invalidate("relay");
    expect(() => broker.respond(commandResponse("owner", "second"), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );
    broker.dispose();
  });

  test("tombstones a pending Plan user-input request on Stop and rejects every late answer", async () => {
    const { source, emit, sent } = createSource();
    const broker = new CodexRequestBroker({ source });
    const controller = new AbortController();
    const subscription = broker.subscribe(scope, "owner", controller.signal);
    emit(userInputRequest());
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
      done: false,
      value: {
        scope: { requestRef: "plan-input-request", turnId: "turn" },
        request: { kind: "user_input" },
      },
    });

    controller.abort();
    expect(() => broker.respond(userInputResponse(), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );
    // A late relay copy of the server request cannot recreate the completed
    // request or make a second answer routable.
    emit(userInputRequest());
    expect(() => broker.respond(userInputResponse(), createAcceptedInvocationAuthority("owner"))).toThrow(
      expect.objectContaining({ code: "stale_scope" }),
    );
    expect(sent).toHaveLength(0);
    broker.dispose();
  });

});
