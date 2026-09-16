import { expect, test } from "bun:test";
import Fastify from "fastify";
import { connectedWebOperationProjectionSchema, connectedWebOperationWatchSchema, type ConnectedWebOperationProjection } from "@nautilo/types";
import { ConnectedWebOperationOwnerController } from "../../src/connected-web-accounts/operation-owner-controller";
import { ConnectedWebAccountStoreError, type ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import { connectedWebOperationRoutes } from "../../src/routes/connected-web-operations";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OPERATION = "33333333-3333-4333-8333-333333333333";

function operation(overrides: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return {
    id: OPERATION, ownerUserId: OWNER, accountId: "22222222-2222-4222-8222-222222222222",
    initiatingAgentId: "44444444-4444-4444-8444-444444444444", initiatingRoomId: "55555555-5555-4555-8555-555555555555",
    initiatingThreadId: "thread", initiatingLane: "lane", deliveryId: "delivery", requestDigest: "a".repeat(64), sealedIntent: "cwo1.aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaa.aa",
    actionOperationId: null, effectIdempotencyKey: null, driver: "hosted", lifecycle: "running", controlEpoch: 1,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666", controlLeaseExpiresAt: null,
    sealedProviderRefs: { version: 1, runRef: "cwo1.aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaa.aa" }, eventCursor: 0,
    safeActivity: { version: 1, phase: "working", code: "browsing", summary: "Reading the connected website." }, wakeFingerprint: null,
    nextCheckAt: new Date(), supervisorClaimOwner: null, supervisorClaimExpiresAt: null, wakeClaimOwner: null, wakeClaimExpiresAt: null, wakeAttempts: 0, wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 100, terminalReceipt: null, terminalReadResult: null, terminalAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

async function expectStoreFailure(run: () => Promise<unknown>, kind: ConnectedWebAccountStoreError["kind"]): Promise<void> {
  try {
    await run();
    throw new Error("expected connected-web store failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectedWebAccountStoreError);
    expect((error as ConnectedWebAccountStoreError).kind).toBe(kind);
  }
}

test("owner operation projection uses exact ownership and fresh provider capabilities", async () => {
  const row = operation();
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async (input) => {
      if (input.ownerUserId !== OWNER || input.operationId !== OPERATION) throw new ConnectedWebAccountStoreError("not_found");
      return row;
    }, scheduleOperationCheck: async () => true },
    provider: { observeHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, stage: "browsing" as const, liveViewUrl: "https://live.browser-use.com/?opaque", observedAt: new Date() }), cancelHostedReadRun: async () => ({ runId: "provider-run", status: "cancelled" as const, observedAt: new Date() }) },
    secrets: () => ({ unsealProviderReferences: () => ({ runId: "provider-run" }) } as never),
  });
  await expectStoreFailure(() => controller.get({ ownerUserId: "other", operationId: OPERATION }), "not_found");
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({ operationId: OPERATION, canWatch: true, canStop: true, result: null });
});

test("stop cancels then only schedules immediate reconciliation", async () => {
  const row = operation();
  const scheduled: unknown[] = [];
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => row, scheduleOperationCheck: async (input) => { scheduled.push(input); return true; } },
    provider: { observeHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, stage: "browsing" as const, liveViewUrl: null, observedAt: new Date() }), cancelHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, observedAt: new Date() }) },
    secrets: () => ({ unsealProviderReferences: () => ({ runId: "provider-run" }) } as never),
  });
  const result = await controller.stop({ ownerUserId: OWNER, operationId: OPERATION });
  expect(result.lifecycle).toBe("running");
  expect(result.receipt).toBeNull();
  expect(result.canStop).toBe(true);
  expect(scheduled).toHaveLength(1);
  expect((scheduled[0] as { now: Date; dueAt: Date }).now).toBe((scheduled[0] as { now: Date; dueAt: Date }).dueAt);
});

test("owner direct Watch and Stop use only the exact in-memory direct lease", async () => {
  const direct = operation({ driver: "direct", controlEpoch: 8, safeActivity: {
    version: 1, phase: "working", code: "direct_page_inspected", summary: "Moxie inspected the connected website.",
  } });
  const afterStop = { ...direct, driver: "checking" as const, lifecycle: "attention" as const, controlEpoch: 9 };
  let observed = 0;
  let cancelled = 0;
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => direct, scheduleOperationCheck: async () => true },
    provider: {
      observeHostedReadRun: async () => { observed += 1; throw new Error("direct must not observe hosted run"); },
      cancelHostedReadRun: async () => { cancelled += 1; throw new Error("direct must not cancel hosted run"); },
    },
    secrets: () => null,
    direct: () => ({
      ownerControls: async () => ({ operation: direct, liveViewUrl: "https://live.browser-use.com/?opaque" }),
      stopForOwner: async () => afterStop,
    } as never),
  });
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    driver: "direct", controlEpoch: 8, canWatch: true, canStop: true,
  });
  expect(await controller.watch({ ownerUserId: OWNER, operationId: OPERATION })).toEqual({ liveViewUrl: "https://live.browser-use.com/?opaque" });
  expect(await controller.stop({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    driver: "checking", lifecycle: "attention", controlEpoch: 9, canWatch: false, canStop: false,
  });
  expect(observed).toBe(0);
  expect(cancelled).toBe(0);
});

test("restarted direct rows fail closed without reacquiring a browser lease", async () => {
  const direct = operation({ driver: "direct", controlEpoch: 8 });
  let attempts = 0;
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => direct, scheduleOperationCheck: async () => true },
    provider: {
      observeHostedReadRun: async () => { throw new Error("must not observe"); },
      cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
    },
    secrets: () => null,
    direct: () => ({
      ownerControls: async () => null,
      stopForOwner: async () => { attempts += 1; return null; },
    } as never),
  });
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({ canWatch: false, canStop: false });
  await expectStoreFailure(() => controller.watch({ ownerUserId: OWNER, operationId: OPERATION }), "conflict");
  await expectStoreFailure(() => controller.stop({ ownerUserId: OWNER, operationId: OPERATION }), "conflict");
  expect(attempts).toBe(1);
});

test("owner Stop projects unresolved direct cleanup without a stale capability", async () => {
  const direct = operation({ driver: "direct", controlEpoch: 8 });
  const recoveryFenced = operation({
    driver: "direct", lifecycle: "attention", controlEpoch: 9,
    safeActivity: {
      version: 1, phase: "attention", code: "direct_browser_cleanup_unresolved",
      summary: "Connected website browser cleanup needs recovery before another writer can start.",
    },
  });
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => direct, scheduleOperationCheck: async () => true },
    provider: {
      observeHostedReadRun: async () => { throw new Error("must not observe"); },
      cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
    },
    secrets: () => null,
    direct: () => ({ ownerControls: async () => ({ operation: recoveryFenced, liveViewUrl: null }), stopForOwner: async () => recoveryFenced } as never),
  });
  expect(await controller.stop({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    driver: "direct", lifecycle: "attention", controlEpoch: 9,
    activity: { code: "direct_browser_cleanup_unresolved" }, canWatch: false, canStop: true,
  });
});

test("malformed or unavailable sealed references fail closed", async () => {
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => operation(), scheduleOperationCheck: async () => true },
    provider: { observeHostedReadRun: async () => { throw new Error("must not observe"); }, cancelHostedReadRun: async () => { throw new Error("must not cancel"); } },
    secrets: () => ({ unsealProviderReferences: () => { throw new Error("bad aad"); } } as never),
  });
  await expectStoreFailure(() => controller.get({ ownerUserId: OWNER, operationId: OPERATION }), "provider_unavailable");
});

test("owner routes reject guests and foreign owners while keeping the live bearer ephemeral", async () => {
  const projection: ConnectedWebOperationProjection = {
    operationId: OPERATION,
    driver: "hosted",
    lifecycle: "running",
    controlEpoch: 1,
    activity: { phase: "working", code: "browsing", summary: "Reading the connected website." },
    receipt: null,
    canWatch: true,
    canStop: true,
    result: null,
  };
  const app = Fastify();
  app.addHook("onRequest", (request, _reply, done) => {
    const bearer = request.headers.authorization;
    (request as unknown as { sessionUserId: string | null }).sessionUserId = bearer === "owner" || bearer === "guest" ? OWNER : bearer === "other" ? "other-owner" : null;
    (request as unknown as { policyContext: { actorRole: string } }).policyContext = { actorRole: bearer === "guest" ? "guest" : "member" };
    done();
  });
  connectedWebOperationRoutes(app, { controller: {
    get: async ({ ownerUserId }) => {
      if (ownerUserId !== OWNER) throw new ConnectedWebAccountStoreError("not_found");
      return projection;
    },
    watch: async ({ ownerUserId }) => {
      if (ownerUserId !== OWNER) throw new ConnectedWebAccountStoreError("not_found");
      return { liveViewUrl: "https://live.browser-use.com/?opaque" };
    },
    stop: async ({ ownerUserId }) => {
      if (ownerUserId !== OWNER) throw new ConnectedWebAccountStoreError("not_found");
      return { ...projection, driver: "checking", activity: { phase: "checking", code: "stop_reconciliation_scheduled", summary: "Stop was requested." } };
    },
  } });
  await app.ready();
  try {
    expect((await app.inject({ method: "GET", url: `/api/connected-web-operations/${OPERATION}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/connected-web-operations/${OPERATION}`, headers: { authorization: "guest" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/connected-web-operations/${OPERATION}`, headers: { authorization: "other" } })).statusCode).toBe(404);
    const result = await app.inject({ method: "GET", url: `/api/connected-web-operations/${OPERATION}`, headers: { authorization: "owner" } });
    expect(result.statusCode).toBe(200);
    expect(connectedWebOperationProjectionSchema.parse(JSON.parse(result.body))).toEqual(projection);
    for (const forbidden of ["runId", "sessionId", "browserId", "profileRef", "cdpUrl", "liveViewUrl", "sealedIntent"]) expect(result.body).not.toContain(forbidden);

    const watch = await app.inject({ method: "POST", url: `/api/connected-web-operations/${OPERATION}/watch`, headers: { authorization: "owner" }, payload: {} });
    expect(watch.statusCode).toBe(200);
    expect(watch.headers["cache-control"]).toBe("no-store");
    expect(connectedWebOperationWatchSchema.parse(JSON.parse(watch.body)).liveViewUrl).toContain("live.browser-use.com");
    expect((await app.inject({ method: "POST", url: `/api/connected-web-operations/${OPERATION}/stop`, headers: { authorization: "owner" }, payload: { runId: "provider-run" } })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});


test("a finished provider run awaiting durable settlement never projects stale browsing activity", async () => {
  const row = operation({ accountId: null });
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => row, scheduleOperationCheck: async () => true },
    provider: { observeHostedReadRun: async () => ({ runId: "provider-run", status: "completed", stage: "browsing", liveViewUrl: null, observedAt: new Date() }), cancelHostedReadRun: async () => { throw new Error("must not cancel a finished run"); } },
    secrets: () => ({ unsealProviderReferences: () => ({ runId: "provider-run" }) } as never),
  });
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    lifecycle: "running", driver: "checking", receipt: null, canWatch: false, canStop: false,
    activity: { phase: "finishing", code: "provider_terminal_pending" },
  });
  expect(row.safeActivity.code).toBe("browsing");
});
