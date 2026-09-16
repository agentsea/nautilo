import { describe, expect, test } from "bun:test";
import type {
  ChildIdentity,
  PersistedBindingRecord,
} from "@nautilo/codex-app-server-host/internal";
import type {
  RelayCodexClientMessage,
  RelayCodexRequestResponseMessage,
  RelayCodexSession,
} from "@nautilo/relay";
import {
  CODEX_REQUEST_REF_MAX_ATTEMPTS,
  ElectronCodexRequestBroker,
} from "../../electron/codex-request-broker.ts";
import { projectCodexHumanRequest } from "../../electron/codex-request-proxy.ts";

const session: RelayCodexSession = {
  relayId: "relay",
  relaySessionId: "relay-session",
  desktopSessionId: "desktop",
  pairingGenerationRef: "pairing",
  selectedProtocolVersion: 8,
  capabilityRevision: 3,
};

describe("ElectronCodexRequestBroker", () => {
  test("relays only a semantic request and settles the exact response once", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent);
    const promise = broker.request(modernCommandRequest());

    const request = sent.at(-1);
    expect(request).toMatchObject({
      type: "relay:codex-request",
      scope: { threadId: "thread", turnId: "turn", itemId: "item", requestRef: "request-1" },
      request: {
        kind: "command_approval",
        command: { detail: "host_local_only" },
      },
    });
    expect(JSON.stringify(request)).not.toContain("/private/workspace");
    expect(JSON.stringify(request)).not.toContain("bun test");

    const response = responseFor(request!, { kind: "command_approval", decision: "decline" });
    expect(broker.respond(response)).toBeTrue();
    expect(await promise).toEqual({ kind: "command_approval", decision: "decline" });
    expect(broker.respond(response)).toBeFalse();
  });

  test("rejects a stale scope without consuming the pending request", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent);
    const promise = broker.request(modernCommandRequest());
    const request = sent.at(-1)!;
    const stale = responseFor(request, { kind: "command_approval", decision: "accept" });
    expect(broker.respond({ ...stale, scope: { ...stale.scope, turnId: "other-turn" } })).toBeFalse();
    expect(broker.respond(responseFor(request, { kind: "command_approval", decision: "decline" }))).toBeTrue();
    await expect(promise).resolves.toEqual({ kind: "command_approval", decision: "decline" });
  });

  test("expires and aborts locally, then suppresses late relay responses", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const timer = fakeTimer();
    const expiryBroker = brokerFor(sent, timer);
    const expiry = expiryBroker.request(modernCommandRequest());
    const expiredRequest = sent.at(-1)!;
    timer.fire();
    await expect(expiry).rejects.toThrow("expired");
    expect(expiryBroker.respond(responseFor(expiredRequest, { kind: "command_approval", decision: "accept" }))).toBeFalse();

    const controller = new AbortController();
    const abortBroker = brokerFor(sent);
    const aborted = abortBroker.request(modernCommandRequest(controller.signal));
    const abortedRequest = sent.at(-1)!;
    controller.abort();
    await expect(aborted).rejects.toThrow("cancelled");
    expect(abortBroker.respond(responseFor(abortedRequest, { kind: "command_approval", decision: "accept" }))).toBeFalse();
  });

  test("fails closed for legacy callbacks without exact turn authority", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent);
    await expect(broker.request({
      child: child(),
      binding: binding(),
      context: context(),
      projected: projectCodexHumanRequest(
        "execCommandApproval",
        {
          conversationId: "thread", callId: "call", approvalId: null,
          command: ["bun", "test"], cwd: "/private/workspace", reason: null,
        },
        "1970-01-01T00:01:00.000Z",
      ),
    })).rejects.toThrow("lacks exact turn authority");
    expect(sent).toHaveLength(0);
  });

  test("cancels pending requests on relay disconnect or generation replacement", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent);
    const pending = broker.request(modernCommandRequest());
    const request = sent.at(-1)!;
    broker.cancelAll();
    await expect(pending).rejects.toThrow("cancelled");
    expect(broker.respond(responseFor(request, { kind: "command_approval", decision: "accept" }))).toBeFalse();
  });

  test("cancels only the exact Plan input turn and suppresses its late answer", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent);
    const planInput = broker.request(modernUserInputRequest());
    const planInputRequest = sent.at(-1)!;
    const otherTurn = broker.request({
      ...modernCommandRequest(),
      projected: projectCodexHumanRequest(
        "item/commandExecution/requestApproval",
        {
          threadId: "thread", turnId: "other-turn", itemId: "other-item",
          command: "bun test", cwd: "/private/workspace", reason: "run tests",
          availableDecisions: ["accept", "decline"],
        },
        "1970-01-01T00:01:00.000Z",
      ),
    });
    const otherTurnRequest = sent.at(-1)!;
    if (planInputRequest.type !== "relay:codex-request" || otherTurnRequest.type !== "relay:codex-request") {
      throw new Error("test fixture must produce relay requests");
    }

    broker.cancelTurn(planInputRequest.scope);
    await expect(planInput).rejects.toThrow("cancelled");
    expect(broker.respond({
      type: "relay:codex-request-response",
      scope: planInputRequest.scope,
      response: { kind: "user_input", answers: { target: { answers: ["tests"] } } },
    })).toBeFalse();
    expect(broker.respond(responseFor(otherTurnRequest, { kind: "command_approval", decision: "decline" }))).toBeTrue();
    await expect(otherTurn).resolves.toEqual({ kind: "command_approval", decision: "decline" });
  });

  test("rejects before send when the bounded pending queue is full", async () => {
    const sent: RelayCodexClientMessage[] = [];
    const broker = brokerFor(sent, fakeTimer(), { maxPendingRequests: 1 });
    const first = broker.request(modernCommandRequest());
    await expect(broker.request(modernCommandRequest())).rejects.toThrow("queue is full");
    expect(sent).toHaveLength(1);
    broker.cancelAll();
    await expect(first).rejects.toThrow("cancelled");
  });

  test("bounds repeated requestRef collisions instead of spinning", async () => {
    const sent: RelayCodexClientMessage[] = [];
    let minted = 0;
    const broker = brokerFor(sent, fakeTimer(), {
      mintRequestRef: () => { minted += 1; return "same-request-ref"; },
      maxPendingRequests: 2,
    });
    const first = broker.request(modernCommandRequest());
    await expect(broker.request(modernCommandRequest())).rejects.toThrow("correlation is unavailable");
    expect(minted).toBe(CODEX_REQUEST_REF_MAX_ATTEMPTS + 1);
    expect(sent).toHaveLength(1);
    broker.cancelAll();
    await expect(first).rejects.toThrow("cancelled");
  });
});

function brokerFor(
  messages: RelayCodexClientMessage[],
  timer = fakeTimer(),
  options: Partial<ConstructorParameters<typeof ElectronCodexRequestBroker>[0]> = {},
) {
  let index = 0;
  return new ElectronCodexRequestBroker({
    session: () => session,
    transport: () => ({ send: (message) => { messages.push(message); return true; } }),
    now: () => 0,
    timer,
    mintRequestRef: () => `request-${++index}`,
    ...options,
  });
}

function modernCommandRequest(signal = new AbortController().signal) {
  return {
    child: child(),
    binding: binding(),
    method: "item/commandExecution/requestApproval" as const,
    params: {
      threadId: "thread", turnId: "turn", itemId: "item",
      command: "bun test --cwd /private/workspace", cwd: "/private/workspace",
      reason: "run tests", availableDecisions: ["accept", "decline"] as const,
    },
    context: context(signal),
    projected: projectCodexHumanRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        command: "bun test --cwd /private/workspace", cwd: "/private/workspace",
        reason: "run tests", availableDecisions: ["accept", "decline"],
      },
      "1970-01-01T00:01:00.000Z",
    ),
  };
}

function modernUserInputRequest(signal = new AbortController().signal) {
  return {
    child: child(),
    binding: binding(),
    context: context(signal),
    projected: projectCodexHumanRequest(
      "item/tool/requestUserInput",
      {
        threadId: "thread", turnId: "turn", itemId: "input-item",
        questions: [{
          id: "target", header: "Target", question: "Which target?",
          isOther: false, isSecret: false,
          options: [{ label: "Tests", description: "Run focused tests." }],
        }],
      },
      "1970-01-01T00:01:00.000Z",
    ),
  };
}

function responseFor(
  message: RelayCodexClientMessage,
  response: Extract<RelayCodexRequestResponseMessage["response"], { readonly kind: "command_approval" }>,
): RelayCodexRequestResponseMessage {
  if (message.type !== "relay:codex-request" || message.request.kind !== "command_approval") {
    throw new Error("expected command approval request");
  }
  return { type: "relay:codex-request-response", scope: message.scope, response };
}

function context(signal = new AbortController().signal) {
  return { signal, requestId: "upstream-request", expiresAt: "1970-01-01T00:01:00.000Z" };
}

function child(): ChildIdentity {
  return {
    profile: { actorId: "actor", profileHandle: "profile" as never, profileGeneration: 1 },
    accountGeneration: 2,
    runtimeGeneration: 3,
    childGeneration: 4,
  };
}

function binding(): PersistedBindingRecord {
  return {
    child: child(), bindingId: "binding" as never, bindingGeneration: 1,
    taskId: "task", jobId: "job", threadId: "thread", model: undefined,
    posture: { kind: "codex_default", anchorMode: "default" },
    callbacks: { manifestHash: "manifest", declarations: [] },
    activeTurns: 0, pendingRequests: 0, outstandingRpcs: 0,
    workspace: {
      handle: "workspace" as never, actorId: "actor", relayId: "relay", relaySessionId: "relay-session",
      desktopSessionId: "desktop", pairingGenerationRef: "pairing", capabilityRevision: 3,
      revision: 7, fingerprint: "fingerprint", issuedAt: 0, expiresAt: 60_000,
    },
  };
}

function fakeTimer() {
  let pending: (() => void) | undefined;
  return {
    setTimeout(callback: () => void) { pending = callback; return 1 as never; },
    clearTimeout() { pending = undefined; },
    fire() { pending?.(); },
  };
}
