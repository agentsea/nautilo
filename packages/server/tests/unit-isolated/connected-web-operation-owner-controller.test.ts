import { expect, test } from "bun:test";
import Fastify from "fastify";
import { connectedWebOperationProjectionSchema, connectedWebOperationWatchSchema, type ConnectedWebOperationProjection } from "@nautilo/types";
import { ConnectedWebOperationOwnerController } from "../../src/connected-web-accounts/operation-owner-controller";
import { ConnectedWebAccountStoreError, type ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import { connectedWebOperationRoutes } from "../../src/routes/connected-web-operations";
import type { BrowserUseCloudAdapter } from "../../src/browser-use/browser-use-cloud";
import type { ConnectedWebBrowserFunding } from "../../src/connected-web-accounts/browser-use-funding";
import type { DurableServiceFundingBinding } from "@nautilo/types";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OPERATION = "33333333-3333-4333-8333-333333333333";

const SERVER_BINDING: DurableServiceFundingBinding = {
  humanUserId: OWNER,
  provider: "browser-use",
  binding: { kind: "server", providerRoute: "browser-use" },
  credentialFingerprint: "a".repeat(64),
};

const PERSONAL_BINDING: DurableServiceFundingBinding = {
  humanUserId: OWNER,
  provider: "browser-use",
  binding: {
    kind: "personal",
    providerRoute: "browser-use",
    credentialId: "77777777-7777-4777-8777-777777777777",
    credentialRevision: 3,
  },
  credentialFingerprint: "b".repeat(64),
};

type FakeOwnerProvider = Pick<
  BrowserUseCloudAdapter,
  "observeHostedReadRun" | "cancelHostedReadRun"
>;

function fundingFor(
  apiKey: string,
  onRun?: (binding: DurableServiceFundingBinding, intent: "spend" | "recover") => void,
): Pick<ConnectedWebBrowserFunding, "admitLegacyServer" | "run"> {
  return {
    admitLegacyServer: async (humanUserId) => ({
      ...SERVER_BINDING,
      humanUserId,
    }),
    run: async (binding, intent, callback) => {
      onRun?.(binding, intent);
      return callback({
        apiKey,
        usageFunding: {
          kind: binding.binding.kind,
          humanUserId: binding.humanUserId,
          providerRoute: "browser-use",
          ...(binding.binding.kind === "personal" ? {
            credentialId: binding.binding.credentialId,
            credentialRevision: binding.binding.credentialRevision,
          } : {}),
        } as never,
      });
    },
  };
}

function scopedProvider(
  provider: FakeOwnerProvider,
  onScope?: (apiKey: string) => void,
): Pick<BrowserUseCloudAdapter, "withRequestCredential"> {
  return {
    withRequestCredential: ({ apiKey }) => {
      onScope?.(apiKey);
      return provider as BrowserUseCloudAdapter;
    },
  };
}

function operation(overrides: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return {
    id: OPERATION, ownerUserId: OWNER, accountId: "22222222-2222-4222-8222-222222222222",
    initiatingAgentId: "44444444-4444-4444-8444-444444444444", initiatingRoomId: "55555555-5555-4555-8555-555555555555",
    initiatingThreadId: "thread", initiatingLane: "lane", deliveryId: "delivery", requestDigest: "a".repeat(64), sealedIntent: "cwo1.aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaa.aa",
    fundingBinding: SERVER_BINDING,
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
    provider: scopedProvider({ observeHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, stage: "browsing" as const, liveViewUrl: "https://live.browser-use.com/?opaque", observedAt: new Date() }), cancelHostedReadRun: async () => ({ runId: "provider-run", status: "cancelled" as const, observedAt: new Date() }) }),
    funding: fundingFor("server-key"),
    secrets: () => ({ unsealProviderReferences: () => ({ runId: "provider-run" }) } as never),
  });
  await expectStoreFailure(() => controller.get({ ownerUserId: "other", operationId: OPERATION }), "not_found");
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({ operationId: OPERATION, canWatch: true, canStop: true, result: null });
});

test("owner Get, Watch, and Stop recover through each operation's exact personal or server key", async () => {
  const providerCalls: string[] = [];
  const fundingCalls: Array<Readonly<{
    binding: DurableServiceFundingBinding;
    intent: "spend" | "recover";
  }>> = [];
  const funding: Pick<ConnectedWebBrowserFunding, "admitLegacyServer" | "run"> = {
    admitLegacyServer: async (humanUserId) => ({
      ...SERVER_BINDING,
      humanUserId,
    }),
    run: async (binding, intent, callback) => {
      fundingCalls.push({ binding, intent });
      if (intent === "spend") throw new Error("spend is revoked");
      return callback({
        apiKey: binding.binding.kind === "personal" ? "personal-key" : "server-key",
        usageFunding: { kind: binding.binding.kind } as never,
      });
    },
  };
  const provider = scopedProvider({
    observeHostedReadRun: async (runId) => {
      providerCalls.push(`observe:${runId}`);
      return {
        runId,
        status: "running",
        stage: "browsing",
        liveViewUrl: "https://live.browser-use.com/?opaque",
        observedAt: new Date(),
      };
    },
    cancelHostedReadRun: async (runId) => {
      providerCalls.push(`cancel:${runId}`);
      return { runId, status: "running", observedAt: new Date() };
    },
  }, (apiKey) => providerCalls.push(`key:${apiKey}`));
  const controller = (fundingBinding: DurableServiceFundingBinding) =>
    new ConnectedWebOperationOwnerController({
      store: {
        getOperationForOwner: async () => operation({ fundingBinding }),
        scheduleOperationCheck: async () => true,
      },
      provider,
      funding,
      secrets: () => ({
        unsealProviderReferences: () => ({ runId: "provider-run" }),
      } as never),
    });

  const personal = controller(PERSONAL_BINDING);
  expect(await personal.get({ ownerUserId: OWNER, operationId: OPERATION }))
    .toMatchObject({ canWatch: true, canStop: true });
  expect(await personal.watch({ ownerUserId: OWNER, operationId: OPERATION }))
    .toEqual({ liveViewUrl: "https://live.browser-use.com/?opaque" });
  expect(await personal.stop({ ownerUserId: OWNER, operationId: OPERATION }))
    .toMatchObject({ driver: "checking", canStop: true });
  expect(await controller(SERVER_BINDING).get({
    ownerUserId: OWNER,
    operationId: OPERATION,
  })).toMatchObject({ canWatch: true, canStop: true });

  expect(fundingCalls.map(({ binding, intent }) => [
    binding.binding.kind,
    intent,
  ])).toEqual([
    ["personal", "recover"],
    ["personal", "recover"],
    ["personal", "recover"],
    ["personal", "recover"],
    ["server", "recover"],
  ]);
  expect(providerCalls.filter((call) => call.startsWith("key:"))).toEqual([
    "key:personal-key",
    "key:personal-key",
    "key:personal-key",
    "key:personal-key",
    "key:server-key",
  ]);
});

test("a legacy null binding adopts only explicit server funding for recovery", async () => {
  let admissions = 0;
  const scopes: string[] = [];
  const controller = new ConnectedWebOperationOwnerController({
    store: {
      getOperationForOwner: async () => operation({ fundingBinding: null }),
      scheduleOperationCheck: async () => true,
    },
    provider: scopedProvider({
      observeHostedReadRun: async (runId) => ({
        runId,
        status: "running",
        stage: "browsing",
        liveViewUrl: null,
        observedAt: new Date(),
      }),
      cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
    }, (apiKey) => scopes.push(apiKey)),
    funding: {
      admitLegacyServer: async (humanUserId) => {
        admissions += 1;
        return { ...SERVER_BINDING, humanUserId };
      },
      run: fundingFor("legacy-server-key").run,
    },
    secrets: () => ({
      unsealProviderReferences: () => ({ runId: "provider-run" }),
    } as never),
  });

  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION }))
    .toMatchObject({ canWatch: false, canStop: true });
  expect(admissions).toBe(1);
  expect(scopes).toEqual(["legacy-server-key"]);
});

test("foreign, unavailable, replaced, or unavailable legacy funding never opens a provider client", async () => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    binding: DurableServiceFundingBinding | null;
    fundingFails: boolean;
    legacyAdmissionFails: boolean;
  }>> = [
    {
      name: "legacy server unavailable",
      binding: null,
      fundingFails: false,
      legacyAdmissionFails: true,
    },
    {
      name: "foreign Human",
      binding: { ...PERSONAL_BINDING, humanUserId: "99999999-9999-4999-8999-999999999999" },
      fundingFails: false,
      legacyAdmissionFails: false,
    },
    {
      name: "unavailable personal key",
      binding: PERSONAL_BINDING,
      fundingFails: true,
      legacyAdmissionFails: false,
    },
    {
      name: "rotated server key",
      binding: SERVER_BINDING,
      fundingFails: true,
      legacyAdmissionFails: false,
    },
    {
      name: "replaced personal key revision",
      binding: {
        ...PERSONAL_BINDING,
        binding: {
          kind: "personal",
          providerRoute: "browser-use",
          credentialId: "77777777-7777-4777-8777-777777777777",
          credentialRevision: 2,
        },
      },
      fundingFails: true,
      legacyAdmissionFails: false,
    },
  ];

  for (const item of cases) {
    let fundingRuns = 0;
    let legacyAdmissions = 0;
    let providerScopes = 0;
    const controller = new ConnectedWebOperationOwnerController({
      store: {
        getOperationForOwner: async () => operation({ fundingBinding: item.binding }),
        scheduleOperationCheck: async () => true,
      },
      provider: scopedProvider({
        observeHostedReadRun: async () => { throw new Error("must not observe"); },
        cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
      }, () => { providerScopes += 1; }),
      funding: {
        admitLegacyServer: async () => {
          legacyAdmissions += 1;
          if (item.legacyAdmissionFails) throw new Error(item.name);
          return SERVER_BINDING;
        },
        run: async () => {
          fundingRuns += 1;
          if (item.fundingFails) throw new Error(item.name);
          throw new Error("unexpected funding call");
        },
      },
      secrets: () => ({
        unsealProviderReferences: () => ({ runId: "provider-run" }),
      } as never),
    });
    await expectStoreFailure(
      () => controller.get({ ownerUserId: OWNER, operationId: OPERATION }),
      "provider_unavailable",
    );
    expect(providerScopes, item.name).toBe(0);
    expect(fundingRuns, item.name).toBe(item.fundingFails ? 1 : 0);
    expect(legacyAdmissions, item.name).toBe(item.binding === null ? 1 : 0);
  }
});

test("owner terminal projection returns only the durable owned artifact receipt", async () => {
  const row = operation({
    lifecycle: "terminal",
    terminalReceipt: { version: 1, outcome: "completed", code: "provider_completed", summary: "Connected website work completed." },
    terminalReadResult: {
      version: 1,
      account: { id: "22222222-2222-4222-8222-222222222222", label: "Example", service: "example", origin: "https://example.com" },
      page: { ref: "22222222-2222-4222-8222-222222222222", title: "Example", origin: "https://example.com" },
      read: null,
      cost: { currency: "USD", amountUsd: 0.01, state: "actual" },
      outputs: [{ artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3 }],
      outputsTruncated: false,
    },
    terminalAt: new Date(),
  });
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => row, scheduleOperationCheck: async () => true },
    provider: scopedProvider({
      observeHostedReadRun: async () => { throw new Error("terminal result must not reopen the provider"); },
      cancelHostedReadRun: async () => { throw new Error("terminal result must not reopen the provider"); },
    }),
    funding: fundingFor("server-key"),
    secrets: () => null,
  });

  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    lifecycle: "terminal",
    canWatch: false,
    canStop: false,
    result: {
      outputs: [{ artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3 }],
      outputsTruncated: false,
    },
  });
});

test("stop cancels then only schedules immediate reconciliation", async () => {
  const row = operation();
  const scheduled: unknown[] = [];
  const controller = new ConnectedWebOperationOwnerController({
    store: { getOperationForOwner: async () => row, scheduleOperationCheck: async (input) => { scheduled.push(input); return true; } },
    provider: scopedProvider({ observeHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, stage: "browsing" as const, liveViewUrl: null, observedAt: new Date() }), cancelHostedReadRun: async () => ({ runId: "provider-run", status: "running" as const, observedAt: new Date() }) }),
    funding: fundingFor("server-key"),
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
    provider: scopedProvider({
      observeHostedReadRun: async () => { observed += 1; throw new Error("direct must not observe hosted run"); },
      cancelHostedReadRun: async () => { cancelled += 1; throw new Error("direct must not cancel hosted run"); },
    }),
    funding: fundingFor("server-key"),
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
    provider: scopedProvider({
      observeHostedReadRun: async () => { throw new Error("must not observe"); },
      cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
    }),
    funding: fundingFor("server-key"),
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
    provider: scopedProvider({
      observeHostedReadRun: async () => { throw new Error("must not observe"); },
      cancelHostedReadRun: async () => { throw new Error("must not cancel"); },
    }),
    funding: fundingFor("server-key"),
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
    provider: scopedProvider({ observeHostedReadRun: async () => { throw new Error("must not observe"); }, cancelHostedReadRun: async () => { throw new Error("must not cancel"); } }),
    funding: fundingFor("server-key"),
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
    provider: scopedProvider({ observeHostedReadRun: async () => ({ runId: "provider-run", status: "completed", stage: "browsing", liveViewUrl: null, observedAt: new Date() }), cancelHostedReadRun: async () => { throw new Error("must not cancel a finished run"); } }),
    funding: fundingFor("server-key"),
    secrets: () => ({ unsealProviderReferences: () => ({ runId: "provider-run" }) } as never),
  });
  expect(await controller.get({ ownerUserId: OWNER, operationId: OPERATION })).toMatchObject({
    lifecycle: "running", driver: "checking", receipt: null, canWatch: false, canStop: false,
    activity: { phase: "finishing", code: "provider_terminal_pending" },
  });
  expect(row.safeActivity.code).toBe("browsing");
});
