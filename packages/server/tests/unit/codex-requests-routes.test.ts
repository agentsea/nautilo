import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type { CodexUserInputRequest } from "@nautilo/db";
import {
  HarnessControlPlane,
  MaintenanceDrainError,
  permissiveMaintenanceGate,
  setMaintenanceGate,
} from "@nautilo/runtime";
import {
  createCodexHarnessRegistration,
  CODEX_HARNESS_ID,
} from "../../src/codex/harness-driver";
import {
  codexRequestsRoutes,
  type CodexRequestsRouteDeps,
} from "../../src/routes/codex-requests";
import { AgentInvocationDeniedError } from "@nautilo/trust";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

class RequestFailure extends Error {
  constructor(readonly code: "stale_scope" | "wrong_owner" | "unsupported") {
    super(code);
  }
}

function controlFor(
  respond?: (response: { readonly requestId: string; readonly ownerId: string; readonly kind: string }) => Promise<void>,
): HarnessControlPlane {
  const execution = {
    async *start() { yield* []; },
    ...(respond ? { respond } : {}),
  };
  return new HarnessControlPlane([createCodexHarnessRegistration({ execution })]);
}

function makeApp(options: {
  readonly userId?: string | null;
  readonly role?: "owner" | "guest";
  readonly respond?: (response: { readonly requestId: string; readonly ownerId: string; readonly kind: string }) => Promise<void>;
  readonly userInputRequests?: NonNullable<CodexRequestsRouteDeps["userInputRequests"]>;
  readonly liveRequests?: NonNullable<CodexRequestsRouteDeps["liveRequests"]>;
  readonly ephemeralRequests?: NonNullable<CodexRequestsRouteDeps["ephemeralRequests"]>;
  readonly terminalizeUnavailable?: (request: CodexUserInputRequest) => Promise<void>;
  readonly now?: () => Date;
  readonly canInvoke?: boolean;
} = {}) {
  const emitted: unknown[] = [];
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = options.userId === undefined ? OWNER : options.userId;
    request.policyContext = { actorRole: options.role ?? "owner" } as typeof request.policyContext;
  });
  const deps: CodexRequestsRouteDeps = {
    controlPlane: controlFor(options.respond),
    emit: (event) => emitted.push(event),
    unavailableRequests: {
      terminalize: options.terminalizeUnavailable ?? (async () => undefined),
    },
    assertCanInvokeAgent: async (input) => {
      if (options.canInvoke === false) throw new AgentInvocationDeniedError(input);
    },
    liveRequests: options.liveRequests ?? {
      hasLiveRequest: () => true,
      hasLiveUserInputRequest: () => true,
    },
    ...(options.userInputRequests ? { userInputRequests: options.userInputRequests } : {}),
    ...(options.ephemeralRequests ? { ephemeralRequests: options.ephemeralRequests } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  codexRequestsRoutes(app, deps);
  return { app, emitted };
}

const approval = { kind: "command_approval_required", decision: "approve" };
const userInput = { kind: "user_input_required", answers: { target: ["answer-value-never-stored"] } } as const;
const permissionSelection = {
  kind: "permission_selection_required",
  outcome: { kind: "selected", optionId: "allow_once" },
} as const;

function inputRow(overrides: Partial<CodexUserInputRequest> = {}): CodexUserInputRequest {
  return {
    requestRef: "input-ref",
    userId: OWNER,
    sourceAgentId: "33333333-3333-4333-8333-333333333333",
    roomId: "44444444-4444-4444-8444-444444444444",
    taskId: "55555555-5555-4555-8555-555555555555",
    taskRunId: "66666666-6666-4666-8666-666666666666",
    jobId: "77777777-7777-4777-8777-777777777777",
    bindingId: "88888888-8888-4888-8888-888888888888",
    bindingGeneration: 4,
    codexThreadId: "thread",
    codexTurnId: "turn",
    codexItemId: "item",
    questions: [{
      id: "target", header: "Target", question: "Which target?",
      isOther: false, isSecret: false,
      options: [{ id: "tests", label: "Tests", description: "Run focused tests." }],
    }],
    autoResolutionMs: null,
    expiresAt: new Date("2099-07-29T12:00:00.000Z"),
    state: "awaiting_human",
    failureCode: null,
    revision: 0,
    dispatchingAt: null,
    submittedAt: null,
    terminalAt: null,
    createdAt: new Date("2026-07-29T11:00:00.000Z"),
    updatedAt: new Date("2026-07-29T11:00:00.000Z"),
    ...overrides,
  };
}

function inputStore(initial: CodexUserInputRequest) {
  let current = initial;
  const unavailable: string[] = [];
  const settles: string[] = [];
  let listCalls = 0;
  const store: NonNullable<CodexRequestsRouteDeps["userInputRequests"]> = {
    async get(ownerId, requestRef) {
      return ownerId === current.userId && requestRef === current.requestRef ? current : undefined;
    },
    async listRoom(ownerId, roomId) {
      listCalls += 1;
      return ownerId === current.userId && roomId === current.roomId ? [current] : [];
    },
    async claim(input) {
      if (input.expectedRevision !== current.revision || current.state !== "awaiting_human") return { status: "conflict" };
      current = { ...current, state: "dispatching", revision: current.revision + 1, dispatchingAt: input.now };
      return { status: "transitioned", request: current };
    },
    async settle(input) {
      settles.push(input.requestRef);
      if (input.expectedRevision !== current.revision) return { status: "conflict" };
      current = {
        ...current,
        state: input.state,
        revision: current.revision + 1,
        terminalAt: input.now,
        failureCode: input.state === "expired" ? "CODEX_REQUEST_EXPIRED" : "CODEX_REQUEST_UNAVAILABLE",
      };
      return { status: "transitioned", request: current };
    },
    async markUnavailable(input) {
      unavailable.push(input.requestRef);
      return { status: "conflict" };
    },
    async markSubmitted(input) {
      if (input.expectedRevision !== current.revision || current.state !== "dispatching") return { status: "conflict" };
      current = { ...current, state: "submitted", revision: current.revision + 1, submittedAt: input.now };
      return { status: "transitioned", request: current };
    },
  };
  return { store, current: () => current, unavailable, settles, listCalls: () => listCalls };
}

describe("Codex native request response route", () => {
  test("hydrates only a live owner input request and keeps the wire answer-free", async () => {
    const fixture = inputStore(inputRow());
    const { app } = makeApp({
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: (ref, owner) => ref === "input-ref" && owner === OWNER },
    });
    const result = await app.inject({
      method: "GET",
      url: `/api/codex/rooms/${fixture.current().roomId}/requests`,
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      roomId: fixture.current().roomId,
      items: [{
        availability: "actionable",
        event: {
          type: "codex.request",
          ownerId: OWNER,
          requestId: "input-ref",
          taskId: fixture.current().taskId,
          jobId: fixture.current().jobId,
          roomId: fixture.current().roomId,
          expiresAt: "2099-07-29T12:00:00.000Z",
          request: {
            kind: "user_input_required",
            questions: [{
              id: "target", header: "Target", prompt: "Which target?",
              secret: false, allowOther: false,
              options: [{ id: "tests", label: "Tests", description: "Run focused tests." }],
            }],
            autoResolutionMs: null,
          },
        },
      }],
    });
    expect(result.body).not.toContain("bindingGeneration");
    expect(result.body).not.toContain("sourceAgentId");
    await app.close();
  });

  test("marks a no-broker input unavailable and returns a non-answerable recovery item", async () => {
    const fixture = inputStore(inputRow());
    const terminalized: string[] = [];
    const { app } = makeApp({
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: () => false },
      terminalizeUnavailable: async (request) => { terminalized.push(request.requestRef); },
    });
    const result = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });
    const retry = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });

    expect(result.statusCode).toBe(200);
    const payload = JSON.parse(result.body) as { readonly items: readonly { readonly availability: string }[] };
    expect(payload.items[0]?.availability).toBe("unavailable");
    expect(fixture.current()).toMatchObject({ state: "unavailable" });
    expect(JSON.parse(retry.body) as { readonly items: readonly unknown[] }).toMatchObject({ items: [{ availability: "unavailable" }] });
    expect(fixture.settles).toEqual(["input-ref"]);
    expect(terminalized).toEqual(["input-ref", "input-ref"]);
    await app.close();
  });

  test("retries terminalization for a retained unavailable receipt without accepting an answer", async () => {
    const fixture = inputStore(inputRow({
      state: "unavailable",
      failureCode: "CODEX_REQUEST_UNAVAILABLE",
      terminalAt: new Date("2026-07-29T11:05:00.000Z"),
    }));
    const terminalized: string[] = [];
    let responded = false;
    const { app } = makeApp({
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: () => false },
      terminalizeUnavailable: async (request) => { terminalized.push(request.requestRef); },
      respond: async () => { responded = true; },
    });

    const listed = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });
    const response = await app.inject({ method: "POST", url: "/api/codex/requests/input-ref/respond", payload: userInput });

    expect(listed.statusCode).toBe(200);
    expect(response.statusCode).toBe(404);
    expect(terminalized).toEqual(["input-ref", "input-ref"]);
    expect(responded).toBe(false);
    expect(JSON.stringify(fixture.current())).not.toContain("answer-value-never-stored");
    await app.close();
  });

  test("does not expose an unavailable card when a lost-broker CAS loses a race", async () => {
    const fixture = inputStore(inputRow());
    let terminalizations = 0;
    const store = {
      ...fixture.store,
      async settle() { return { status: "conflict" } as const; },
    };
    const { app } = makeApp({
      userInputRequests: store,
      liveRequests: { hasLiveUserInputRequest: () => false },
      terminalizeUnavailable: async () => { terminalizations += 1; },
    });
    const result = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ roomId: fixture.current().roomId, items: [] });
    expect(terminalizations).toBe(0);
    await app.close();
  });

  test("never inspects or settles dispatching/submitted rows during recovery", async () => {
    for (const state of ["dispatching", "submitted"] as const) {
      const fixture = inputStore(inputRow({ state }));
      const { app } = makeApp({
        userInputRequests: fixture.store,
        liveRequests: { hasLiveUserInputRequest: () => false },
      });
      const result = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ roomId: fixture.current().roomId, items: [] });
      expect(fixture.settles).toEqual([]);
      await app.close();
    }
  });

  test("rejects a malformed Room id before it touches the durable store", async () => {
    const fixture = inputStore(inputRow());
    const { app } = makeApp({
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: () => true },
    });
    const result = await app.inject({ method: "GET", url: "/api/codex/rooms/not-a-uuid/requests" });

    expect(result.statusCode).toBe(404);
    expect(fixture.listCalls()).toBe(0);
    await app.close();
  });

  test("owner-isolates durable input response and does not send a foreign answer", async () => {
    const fixture = inputStore(inputRow());
    let called = false;
    let terminalizations = 0;
    const { app } = makeApp({
      userId: FOREIGN,
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: () => true },
      respond: async () => { called = true; },
      terminalizeUnavailable: async () => { terminalizations += 1; },
    });
    const result = await app.inject({ method: "POST", url: "/api/codex/requests/input-ref/respond", payload: userInput });

    expect(result.statusCode).toBe(404);
    expect(called).toBe(false);
    expect(terminalizations).toBe(0);
    await app.close();
  });

  test("claims a user-input response once, keeps its answer off the durable store, and leaves approvals ephemeral", async () => {
    const fixture = inputStore(inputRow());
    const received: unknown[] = [];
    const { app, emitted } = makeApp({
      userInputRequests: fixture.store,
      liveRequests: { hasLiveUserInputRequest: () => true },
      respond: async (value) => { received.push(value); },
    });
    const first = await app.inject({ method: "POST", url: "/api/codex/requests/input-ref/respond", payload: userInput });
    const second = await app.inject({ method: "POST", url: "/api/codex/requests/input-ref/respond", payload: userInput });
    const approvalResult = await app.inject({ method: "POST", url: "/api/codex/requests/approval-ref/respond", payload: approval });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(fixture.current()).toMatchObject({ state: "submitted", revision: 2 });
    expect(JSON.stringify(fixture.current())).not.toContain("answer-value-never-stored");
    expect(received).toHaveLength(2);
    expect(approvalResult.statusCode).toBe(200);
    expect(emitted).toEqual([
      { type: "codex.request.resolved", ownerId: OWNER, requestId: "input-ref" },
      { type: "codex.request.resolved", ownerId: OWNER, requestId: "approval-ref" },
    ]);
    await app.close();
  });

  test("does not relabel a sent-but-not-yet-submitted response as unavailable", async () => {
    const fixture = inputStore(inputRow());
    let live = true;
    const store = {
      ...fixture.store,
      async markSubmitted() { return { status: "conflict" } as const; },
    };
    const { app } = makeApp({
      userInputRequests: store,
      liveRequests: { hasLiveUserInputRequest: () => live },
      respond: async () => undefined,
    });
    const sent = await app.inject({ method: "POST", url: "/api/codex/requests/input-ref/respond", payload: userInput });
    live = false;
    const recovery = await app.inject({ method: "GET", url: `/api/codex/rooms/${fixture.current().roomId}/requests` });

    expect(sent.statusCode).toBe(409);
    expect(fixture.current()).toMatchObject({ state: "dispatching" });
    expect(JSON.parse(recovery.body)).toEqual({ roomId: fixture.current().roomId, items: [] });
    expect(fixture.settles).toEqual([]);
    await app.close();
  });

  test("adds authenticated owner and URL request ref, then emits owner-private resolution", async () => {
    const received: unknown[] = [];
    const { app, emitted } = makeApp({
      respond: async (response) => { received.push(response); },
    });
    const result = await app.inject({
      method: "POST",
      url: "/api/codex/requests/request-ref/respond",
      payload: approval,
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ requestId: "request-ref" });
    expect(received).toEqual([{
      kind: "command_approval_required",
      requestId: "request-ref",
      ownerId: OWNER,
      decision: "approve",
    }]);
    expect(emitted).toEqual([{
      type: "codex.request.resolved",
      ownerId: OWNER,
      requestId: "request-ref",
    }]);
    await app.close();
  });

  test("does not use the Guest role shortcut when Capability admission allows", async () => {
    let called = false;
    const { app } = makeApp({ role: "guest", respond: async () => { called = true; } });
    const result = await app.inject({ method: "POST", url: "/api/codex/requests/request-ref/respond", payload: approval });
    expect(result.statusCode).toBe(200);
    expect(called).toBe(true);
    await app.close();
  });

  test("returns the exact invocation denial after binding and before live response", async () => {
    let called = false;
    const { app, emitted } = makeApp({
      canInvoke: false,
      respond: async () => { called = true; },
    });
    const result = await app.inject({
      method: "POST",
      url: "/api/codex/requests/request-ref/respond",
      payload: approval,
    });
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    expect(called).toBe(false);
    expect(emitted).toEqual([]);
    await app.close();
  });

  test("rejects invalid browser bodies before response handling", async () => {
    let called = false;
    const { app } = makeApp({ respond: async () => { called = true; } });
    const result = await app.inject({
      method: "POST",
      url: "/api/codex/requests/request-ref/respond",
      payload: { ...approval, ownerId: FOREIGN },
    });
    expect(result.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  test("makes stale, foreign, and replay responses indistinguishable and never emits resolution", async () => {
    for (const code of ["stale_scope", "wrong_owner"] as const) {
      const { app, emitted } = makeApp({ respond: async () => { throw new RequestFailure(code); } });
      const result = await app.inject({ method: "POST", url: "/api/codex/requests/request-ref/respond", payload: approval });
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({ code: "CODEX_REQUEST_UNAVAILABLE" });
      expect(emitted).toEqual([]);
      await app.close();
    }
  });

  test("returns bounded conflict when the generic harness cannot respond", async () => {
    const { app, emitted } = makeApp();
    const result = await app.inject({ method: "POST", url: "/api/codex/requests/request-ref/respond", payload: approval });
    expect(result.statusCode).toBe(409);
    expect(emitted).toEqual([]);
    await app.close();
  });

  test("routes live permission and user-input replies only through the ephemeral port", async () => {
    const durable = inputStore(inputRow());
    const direct: unknown[] = [];
    let fallback = 0;
    const { app, emitted } = makeApp({
      respond: async () => { fallback += 1; },
      userInputRequests: durable.store,
      ephemeralRequests: {
        hasLiveRequest: () => true,
        async respond(response, authority) { direct.push({ response, authority }); },
      },
    });

    const permission = await app.inject({
      method: "POST",
      url: "/api/codex/requests/permission-ref/respond",
      payload: permissionSelection,
    });
    const input = await app.inject({
      method: "POST",
      url: "/api/codex/requests/input-ref/respond",
      payload: userInput,
    });

    expect(permission.statusCode).toBe(200);
    expect(input.statusCode).toBe(200);
    expect(direct).toMatchObject([
      { response: { kind: "permission_selection_required", requestId: "permission-ref", ownerId: OWNER, outcome: { kind: "selected", optionId: "allow_once" } } },
      { response: { kind: "user_input_required", requestId: "input-ref", ownerId: OWNER, answers: userInput.answers } },
    ]);
    expect(fallback).toBe(0);
    expect(durable.current()).toMatchObject({ state: "awaiting_human", revision: 0 });
    expect(emitted).toEqual([
      { type: "codex.request.resolved", ownerId: OWNER, requestId: "permission-ref" },
      { type: "codex.request.resolved", ownerId: OWNER, requestId: "input-ref" },
    ]);
    await app.close();
  });

  test("rechecks ephemeral liveness after admission and keeps auth and maintenance before direct response", async () => {
    let liveness = 0;
    let direct = 0;
    const stale = makeApp({
      ephemeralRequests: {
        hasLiveRequest: () => ++liveness === 1,
        async respond() { direct += 1; },
      },
    });
    const staleResult = await stale.app.inject({
      method: "POST", url: "/api/codex/requests/permission-ref/respond", payload: permissionSelection,
    });
    expect(staleResult.statusCode).toBe(404);
    expect(liveness).toBe(2);
    expect(direct).toBe(0);
    expect(stale.emitted).toEqual([]);
    await stale.app.close();

    const denied = makeApp({
      canInvoke: false,
      ephemeralRequests: { hasLiveRequest: () => true, async respond() { direct += 1; } },
    });
    const deniedResult = await denied.app.inject({
      method: "POST", url: "/api/codex/requests/permission-ref/respond", payload: permissionSelection,
    });
    expect(deniedResult.statusCode).toBe(403);
    expect(direct).toBe(0);
    await denied.app.close();

    setMaintenanceGate({
      async assertAcceptingNewWork() { throw new MaintenanceDrainError("draining"); },
      async isAcceptingWork() { return false; },
    });
    try {
      const draining = makeApp({
        ephemeralRequests: { hasLiveRequest: () => true, async respond() { direct += 1; } },
      });
      const drainingResult = await draining.app.inject({
        method: "POST", url: "/api/codex/requests/permission-ref/respond", payload: permissionSelection,
      });
      expect(drainingResult.statusCode).toBe(503);
      expect(direct).toBe(0);
      await draining.app.close();
    } finally {
      setMaintenanceGate(permissiveMaintenanceGate);
    }
  });

  test("never falls through a live request and treats unmatched selection as unavailable", async () => {
    let direct = 0;
    let fallback = 0;
    const failed = makeApp({
      respond: async () => { fallback += 1; },
      ephemeralRequests: {
        hasLiveRequest: () => true,
        async respond() { direct += 1; throw new Error("stale"); },
      },
    });
    const failure = await failed.app.inject({
      method: "POST", url: "/api/codex/requests/permission-ref/respond", payload: permissionSelection,
    });
    expect(failure.statusCode).toBe(409);
    expect(direct).toBe(1);
    expect(fallback).toBe(0);
    expect(failed.emitted).toEqual([]);
    await failed.app.close();

    const unavailable = makeApp({ respond: async () => { fallback += 1; } });
    const missing = await unavailable.app.inject({
      method: "POST", url: "/api/codex/requests/permission-ref/respond", payload: permissionSelection,
    });
    expect(missing.statusCode).toBe(404);
    expect(fallback).toBe(0);
    await unavailable.app.close();
  });
});

void CODEX_HARNESS_ID;
