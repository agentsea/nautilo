import { expect, test } from "bun:test";
import { agentBrowserCdpArgv } from "../../../relay/src/browser";
import {
  DirectBrowserRouter,
  type DirectBrowserRouterDependencies,
} from "../../src/connected-web-accounts/direct-browser-router";
import type {
  ConnectedWebAccountBinding,
  ConnectedWebOperation,
} from "../../src/connected-web-accounts/store";
import type { BrowserUseBrowserSession } from "../../src/browser-use/browser-use-cloud";

const CDP_DISCOVERY = "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com";
const RESOLVED_CDP = "wss://11111111-1111-4111-8111-111111111111.cdp.browser-use.com/devtools/browser/private-token";
const ORIGIN = "https://console.example.test";

function binding(overrides: Partial<ConnectedWebAccountBinding> = {}): ConnectedWebAccountBinding {
  return {
    accountId: "account-1",
    ownerUserId: "owner-1",
    service: "Example",
    origin: ORIGIN,
    status: "connected",
    profileRef: "profile-private-id",
    executionCheckpoint: null,
    ...overrides,
  };
}

function operation(overrides: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return {
    id: "operation-1",
    ownerUserId: "owner-1",
    accountId: "account-1",
    driver: "hosted",
    lifecycle: "running",
    controlEpoch: 4,
    actionOperationId: null,
    effectIdempotencyKey: null,
    sealedProviderRefs: { version: 1, sessionRef: "sealed-hosted-session" },
    ...overrides,
  } as ConnectedWebOperation;
}

function stoppedBrowser(browserId: string) {
  return {
    browserId,
    cdpUrl: null,
    liveViewUrl: null,
    timeoutAt: new Date("2026-01-01T00:00:00.000Z"),
    observedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "stopped" as const,
  };
}

function makeRouter(overrides: Partial<DirectBrowserRouterDependencies> = {}) {
  let currentOperation = operation();
  let currentBinding = binding();
  let decisionSnapshot = '- button "Continue" [ref=e1]';
  let decisionFailure = false;
  const calls = {
    started: [] as Array<{ profileId: string; timeoutMinutes: number }>,
    navigated: [] as Array<{ cdpUrl: string; origin: string; timeoutMs: number }>,
    attached: [] as string[],
    stopped: [] as string[],
    rotated: [] as Array<{ expectedControlEpoch: number; driver: string }>,
    takeovers: [] as unknown[],
    sealedBrowsers: [] as string[],
    allocated: [] as Array<{ controlEpoch: number; harnessSession: string }>,
    released: [] as string[],
    pinnedUrlReads: 0,
    invoked: [] as Array<{ argv: readonly string[]; environment: Readonly<{ AGENT_BROWSER_CDP: string }> }>,
    terminalProofs: 0,
    cleanupOrder: [] as string[],
  };
  const dependencies: DirectBrowserRouterDependencies = {
    store: {
      getBindingForOwner: async () => currentBinding,
      getOperationForOwner: async () => currentOperation,
      rotateOperationDriver: async (input) => {
        calls.rotated.push({ expectedControlEpoch: input.expectedControlEpoch, driver: input.driver });
        if (currentOperation.controlEpoch !== input.expectedControlEpoch || currentOperation.lifecycle === "terminal") return null;
        currentOperation = operation({
          ...currentOperation,
          driver: input.driver,
          lifecycle: input.lifecycle,
          controlEpoch: input.expectedControlEpoch + 1,
        });
        return { controlEpoch: currentOperation.controlEpoch, controlLeaseToken: "lease-private" };
      },
      takeOverReadOperationForDirect: async (input) => {
        calls.takeovers.push(input);
        if (currentOperation.controlEpoch !== input.expectedControlEpoch) return null;
        currentOperation = operation({ ...currentOperation, driver: "direct", lifecycle: "running", controlEpoch: input.expectedControlEpoch + 1,
          sealedProviderRefs: input.sealedProviderRefs, wakeFingerprint: null, nextCheckAt: null, supervisorClaimOwner: null });
        return { controlEpoch: currentOperation.controlEpoch, controlLeaseToken: "lease-private" };
      },
    },
    provider: {
      startBrowser: async (input) => {
        calls.started.push(input);
        return {
          browserId: "browser-private-id",
          cdpUrl: CDP_DISCOVERY,
          liveViewUrl: null,
          timeoutAt: new Date("2026-01-01T00:00:00.000Z"),
          observedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "active",
        };
      },
      findHostedBrowsers: async ({ agentSessionId }) => {
        calls.attached.push(agentSessionId);
        return [{
          browserId: "browser-private-id",
          cdpUrl: CDP_DISCOVERY,
          liveViewUrl: null,
          timeoutAt: new Date("2026-01-01T00:00:00.000Z"),
          observedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "active",
          agentSessionId,
        }];
      },
      stopBrowser: async (browserId) => { calls.cleanupOrder.push("provider"); calls.stopped.push(browserId); return stoppedBrowser(browserId); },
    },
    providerReferences: {
      unseal: async () => ({ sessionId: "hosted-session-private" }),
      sealBrowserRef: async ({ operation: current, browserId }) => {
        calls.sealedBrowsers.push(browserId);
        return { ...current.sealedProviderRefs, browserRef: "sealed-browser-private" };
      },
    },
    hostedLifecycle: {
      hasTerminalProof: async () => { calls.terminalProofs += 1; return true; },
    },
    directories: {
      allocate: async (input) => {
        calls.allocated.push({ controlEpoch: input.controlEpoch, harnessSession: input.harnessSession });
        return { socketDirectory: "/run/nautilo/op-1", homeDirectory: "/var/lib/nautilo/op-1" };
      },
      release: async (directories) => { calls.cleanupOrder.push("directories"); calls.released.push(directories.socketDirectory); },
    },
    harness: {
      buildArgv: ({ toolName, args, session }) => agentBrowserCdpArgv(toolName, args as Record<string, unknown>, session),
      invoke: async (input) => {
        calls.invoked.push(input);
        return { text: `snapshot ${RESOLVED_CDP}`, truncated: false };
      },
      observe: async () => {
        if (decisionFailure) throw new Error("invalid observation");
        return { snapshot: decisionSnapshot, refs: { e1: { role: "button", name: "Continue" } } };
      },
      bindPinnedTarget: async () => undefined,
      readPinnedUrl: async () => { calls.pinnedUrlReads += 1; return `${ORIGIN}/page`; },
      closePrivateDaemons: async () => { calls.cleanupOrder.push("daemon"); },
    },
    resolveCdpWebSocketUrl: async () => RESOLVED_CDP,
    navigateSavedProfileBrowser: async (cdpUrl, origin, timeoutMs) => {
      calls.navigated.push({ cdpUrl, origin, timeoutMs });
    },
    findPageTargetAtOrigin: async () => "target-1",
    browserTimeoutMinutes: 15,
    assertServerFunding: async () => undefined,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    ...overrides,
  };
  return {
    router: new DirectBrowserRouter(dependencies),
    calls,
    setOperation: (value: ConnectedWebOperation) => { currentOperation = value; },
    setBinding: (value: ConnectedWebAccountBinding) => { currentBinding = value; },
    setDecisionSnapshot: (value: string) => { decisionSnapshot = value; },
    setDecisionFailure: (value: boolean) => { decisionFailure = value; },
  };
}

const admission = {
  ownerUserId: "owner-1",
  accountId: "account-1",
  operationId: "operation-1",
  expectedControlEpoch: 4,
  source: "saved_profile" as const,
};

test("direct router admits only an owner-scoped connected saved profile, fences it, and returns sanitized bounded feedback", async () => {
  const { router, calls } = makeRouter();
  const result = await router.execute({ ...admission, command: { toolName: "browser_snapshot", args: {} } });

  expect(calls.started).toEqual([{ profileId: "profile-private-id", timeoutMinutes: 15 }]);
  expect(calls.navigated).toEqual([{ cdpUrl: CDP_DISCOVERY, origin: ORIGIN, timeoutMs: 10_000 }]);
  expect(calls.rotated).toEqual([
    { expectedControlEpoch: 4, driver: "direct" },
    { expectedControlEpoch: 5, driver: "checking" },
  ]);
  expect(calls.allocated).toHaveLength(1);
  expect(calls.allocated[0]!.controlEpoch).toBe(5);
  expect(calls.allocated[0]!.harnessSession).toMatch(/^d-[a-f0-9]{32}$/u);
  expect(calls.pinnedUrlReads).toBe(3); // bind verification + command pre/post
  expect(calls.invoked).toHaveLength(1);
  expect(calls.invoked[0]!.environment).toEqual({ AGENT_BROWSER_CDP: RESOLVED_CDP });
  expect(calls.invoked[0]!.argv).not.toContain("--cdp");
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(calls.released).toEqual(["/run/nautilo/op-1"]);
  expect(calls.cleanupOrder).toEqual(["daemon", "provider", "directories"]);
  expect(result).toEqual({
    result: { text: "snapshot [redacted]", truncated: false },
    cleanup: { browser: "stopped", directories: "released", operation: "released" },
  });
});

test("direct router denies a paid saved-profile start before provider or durable mutation", async () => {
  const checks: unknown[] = [];
  const { router, calls } = makeRouter({
    assertServerFunding: async (...input) => {
      checks.push(input);
      throw new Error("server_provider_credentials_required");
    },
  });
  const error = await router.acquire(admission).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(checks).toEqual([["owner-1", "connected_web_direct_browser"]]);
  expect(calls.started).toEqual([]);
  expect(calls.rotated).toEqual([]);
  expect(calls.allocated).toEqual([]);
});

test("direct router attaches only the one active browser proven by the exact hosted Agent session", async () => {
  const { router, calls } = makeRouter();
  const lease = await router.acquire({ ...admission, source: "hosted_session" });
  expect(calls.started).toEqual([]);
  expect(calls.navigated).toEqual([]);
  expect(calls.attached).toEqual(["hosted-session-private"]);
  expect(calls.terminalProofs).toBe(1);
  await lease.close();
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("direct router retains the exact Browser Use live-view capability only while its lease is live", async () => {
  const { router } = makeRouter({
    provider: {
      startBrowser: async () => ({ kind: "failure", code: "network_error" }),
      findHostedBrowsers: async ({ agentSessionId }) => [{
        browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY, liveViewUrl: "https://live.browser-use.com/?opaque",
        timeoutAt: new Date(), observedAt: new Date(), status: "active", agentSessionId,
      }],
      stopBrowser: async (browserId) => stoppedBrowser(browserId),
    },
  });
  const lease = await router.acquire({ ...admission, source: "hosted_session" });
  expect(lease.ownerLiveViewUrl()).toBe("https://live.browser-use.com/?opaque");
  await lease.close();
  expect(lease.ownerLiveViewUrl()).toBeNull();
});

test("direct router transfers an active read checkpoint with a sealed attached browser instead of releasing the writer", async () => {
  const activeRead = {
    resource: "read", phase: "active", reservationToken: "reservation-private", recordedAt: "2026-09-03T00:00:00.000Z", opaqueExecutionRef: "sealed-run-private",
  } as ConnectedWebAccountBinding["executionCheckpoint"];
  const op = operation({ sealedProviderRefs: { version: 1, runRef: "sealed-run-private", sessionRef: "sealed-hosted-session" }, wakeFingerprint: "old-hosted-wake" });
  // The exact opaque execution reference is an opaque sealed run locator, not
  // the provider plaintext. The router only carries it into the store CAS.
  const context = makeRouter();
  context.setBinding(binding({ status: "busy", executionCheckpoint: activeRead }));
  context.setOperation(op);
  const lease = await context.router.acquire({ ...admission, source: "hosted_session" });
  expect(context.calls.sealedBrowsers).toEqual(["browser-private-id"]);
  expect(context.calls.takeovers).toHaveLength(1);
  expect(context.calls.takeovers[0]).toMatchObject({ expectedControlEpoch: 4, expectedRunRef: "sealed-run-private", opaqueExecutionRef: "sealed-run-private",
    sealedProviderRefs: { browserRef: "sealed-browser-private" } });
  expect(context.calls.rotated).toEqual([]);
  await lease.close();
});

test("direct router fails closed when a hosted writer has no terminal proof", async () => {
  const { router, calls } = makeRouter({ hostedLifecycle: { hasTerminalProof: async () => false } });
  const error = await router.acquire(admission).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "hosted_still_active", message: "direct browser control unavailable" });
  expect(calls.started).toEqual([]);
  expect(calls.rotated).toEqual([]);
  expect(calls.stopped).toEqual([]);
});

test("direct router never opens a direct lease for an external-effect operation", async () => {
  const context = makeRouter();
  context.setOperation(operation({
    actionOperationId: "77777777-7777-4777-8777-777777777777",
    effectIdempotencyKey: "effect-private",
  }));
  const error = await context.router.acquire(admission).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "stale_control", message: "direct browser control unavailable" });
  expect(context.calls.started).toEqual([]);
  expect(context.calls.allocated).toEqual([]);
  expect(context.calls.rotated).toEqual([]);
});

test("direct router CAS-fences a hosted/checking handoff after provider start and cleans up the exact new browser", async () => {
  const { router, calls, setOperation } = makeRouter({
    provider: {
      startBrowser: async (input) => {
        calls.started.push(input);
        setOperation(operation({ driver: "checking", controlEpoch: 5 }));
        return {
          browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY, liveViewUrl: null, status: "active",
          timeoutAt: new Date(), observedAt: new Date(),
        };
      },
      findHostedBrowsers: async () => [],
      stopBrowser: async (browserId) => { calls.stopped.push(browserId); return stoppedBrowser(browserId); },
    },
  });
  const error = await router.acquire(admission).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "stale_control", message: "direct browser control unavailable" });
  expect(calls.rotated).toEqual([{ expectedControlEpoch: 4, driver: "direct" }]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("direct router stops its newly created browser when initial navigation fails", async () => {
  const { router, calls } = makeRouter({ navigateSavedProfileBrowser: async () => { throw new Error("navigation failed"); } });
  const failed = await router.acquire({
    ownerUserId: "owner-1", accountId: "account-1", operationId: "operation-1", expectedControlEpoch: 4, source: "saved_profile",
  }).then(() => null, (cause: unknown) => cause);
  expect(failed).toMatchObject({ code: "unavailable" });
  expect(calls.started).toHaveLength(1);
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(calls.allocated).toEqual([]);
  expect(calls.rotated).toEqual([]);
});

test("direct router rejects ambiguous hosted-browser attachment without choosing or stopping an unproven browser", async () => {
  const { router, calls } = makeRouter({
    provider: {
      startBrowser: async () => ({ kind: "failure", code: "network_error" }),
      findHostedBrowsers: async () => [
        {
          browserId: "browser-1", cdpUrl: CDP_DISCOVERY, liveViewUrl: null, status: "active",
          timeoutAt: new Date(), observedAt: new Date(), agentSessionId: "hosted-session-private",
        },
        {
          browserId: "browser-2", cdpUrl: CDP_DISCOVERY, liveViewUrl: null, status: "active",
          timeoutAt: new Date(), observedAt: new Date(), agentSessionId: "hosted-session-private",
        },
      ],
      stopBrowser: async (browserId) => { calls.stopped.push(browserId); return stoppedBrowser(browserId); },
    },
  });
  const error = await router.acquire({ ...admission, source: "hosted_session" }).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(calls.rotated).toEqual([]);
  expect(calls.stopped).toEqual([]);
});

test("direct router re-reads owner account and operation fences before every command, then releases exact resources", async () => {
  const { router, calls, setOperation } = makeRouter();
  const lease = await router.acquire(admission);
  setOperation(operation({ driver: "human", controlEpoch: 6 }));
  const error = await lease.invoke({ toolName: "browser_snapshot", args: {} }).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "stale_control", message: "direct browser control unavailable" });
  expect(calls.invoked).toEqual([]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(calls.released).toEqual(["/run/nautilo/op-1"]);
});

test("direct router prevents navigation outside the durable account origin and observes the destination after an allowed navigation", async () => {
  const { router, calls } = makeRouter();
  const lease = await router.acquire(admission);
  await lease.invoke({ toolName: "browser_snapshot", args: {} });
  const error = await lease.invoke({ toolName: "browser_open", args: { url: "https://other.example.test/" } }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ code: "origin_not_allowed", message: "direct browser control unavailable" });
  expect(calls.invoked).toHaveLength(1);
  expect(calls.pinnedUrlReads).toBe(3);
  expect(calls.stopped).toEqual(["browser-private-id"]);

  const allowed = makeRouter();
  const secondLease = await allowed.router.acquire(admission);
  await secondLease.invoke({ toolName: "browser_snapshot", args: {} });
  await secondLease.invoke({ toolName: "browser_open", args: { url: `${ORIGIN}/projects` } });
  expect(allowed.calls.pinnedUrlReads).toBe(5);
  await secondLease.close();
});

test("direct mutations require one fresh snapshot and never manufacture replay authority", async () => {
  const { router, calls } = makeRouter();
  const lease = await router.acquire(admission);
  const stale = await lease.invoke({ toolName: "browser_click", args: { ref: "@e1" } })
    .then(() => null, (error: unknown) => error);
  expect(stale).toMatchObject({ code: "fresh_snapshot_required" });
  expect(calls.stopped).toEqual([]);

  await lease.invoke({ toolName: "browser_snapshot", args: {} });
  await lease.invoke({ toolName: "browser_click", args: { ref: "@e1" } });
  const replay = await lease.invoke({ toolName: "browser_click", args: { ref: "@e1" } })
    .then(() => null, (error: unknown) => error);
  expect(replay).toMatchObject({ code: "fresh_snapshot_required" });
  expect(calls.invoked).toHaveLength(2);
  expect(calls.stopped).toEqual([]);
  await lease.close();
});

test("decision mutations refresh and consume the exact server-owned observation once", async () => {
  const { router, calls } = makeRouter();
  const lease = await router.acquire(admission);
  const observation = await lease.observeDecision();
  expect(observation.snapshot).toContain("Continue");
  expect(observation.pageUrl).toBe(`${ORIGIN}/page`);
  await lease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, observation.observationId);
  expect(calls.invoked).toHaveLength(1);
  const replay = await lease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, observation.observationId)
    .then(() => null, (error: unknown) => error);
  expect(replay).toMatchObject({ code: "observation_stale" });
  expect(calls.invoked).toHaveLength(1);
  await lease.close();
});

test("ordinary commands and failed re-observation invalidate saved decision authority", async () => {
  const first = makeRouter();
  const lease = await first.router.acquire(admission);
  const observation = await lease.observeDecision();
  await lease.invoke({ toolName: "browser_snapshot", args: {} });
  expect(await lease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, observation.observationId)
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "observation_stale" });
  const next = await lease.observeDecision();
  first.setDecisionSnapshot("- button Changed [ref=e1]");
  expect(await lease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, next.observationId)
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "observation_stale" });
  expect(first.calls.invoked).toHaveLength(1);
  await lease.close();

  const second = makeRouter();
  const otherLease = await second.router.acquire(admission);
  const old = await otherLease.observeDecision();
  second.setDecisionFailure(true);
  expect(await otherLease.observeDecision().then(() => null, (error: unknown) => error)).toMatchObject({ code: "observation_invalid" });
  second.setDecisionFailure(false);
  expect(await otherLease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, old.observationId)
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "observation_stale" });
  expect(await otherLease.invoke({ toolName: "browser_click", args: { ref: "@e1" } })
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "fresh_snapshot_required" });
  expect(second.calls.invoked).toHaveLength(0);
  await otherLease.close();

  const third = makeRouter();
  const refreshLease = await third.router.acquire(admission);
  const refreshObservation = await refreshLease.observeDecision();
  third.setDecisionFailure(true);
  expect(await refreshLease.invokeDecision({ toolName: "browser_click", args: { ref: "@e1" } }, refreshObservation.observationId)
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "observation_invalid" });
  expect(await refreshLease.invoke({ toolName: "browser_click", args: { ref: "@e1" } })
    .then(() => null, (error: unknown) => error)).toMatchObject({ code: "fresh_snapshot_required" });
  expect(third.calls.invoked).toHaveLength(0);
  await refreshLease.close();
});

test("a provider Stop retry closes the same browser across recovery epochs without reopening input", async () => {
  let attempts = 0;
  let starts = 0;
  const { router } = makeRouter({ provider: {
    startBrowser: async () => {
      starts++;
      return { ...stoppedBrowser("browser-private-id"), status: "active", cdpUrl: CDP_DISCOVERY };
    },
    findHostedBrowsers: async () => [],
    stopBrowser: async (id) => ++attempts === 1
      ? { kind: "failure", code: "network_error" }
      : stoppedBrowser(id),
  } });
  const lease = await router.acquire(admission);
  expect((await lease.close()).operation).toBe("recovery_fenced");
  expect(await lease.invoke({ toolName: "browser_snapshot", args: {} }).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect((await lease.close()).operation).toBe("released");
  expect(attempts).toBe(2);
  expect(starts).toBe(1);
});

test("direct router reports exact-provider and private-directory cleanup truth independently", async () => {
  const { router, calls } = makeRouter({
    provider: {
      startBrowser: async () => ({
        browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY, liveViewUrl: null, status: "active",
        timeoutAt: new Date(), observedAt: new Date(),
      }),
      findHostedBrowsers: async () => [],
      stopBrowser: async (browserId) => { calls.stopped.push(browserId); return { kind: "failure", code: "network_error" }; },
    },
    directories: {
      allocate: async () => ({ socketDirectory: "/run/nautilo/op-1", homeDirectory: "/var/lib/nautilo/op-1" }),
      release: async () => { throw new Error("disk unavailable"); },
    },
  });
  const lease = await router.acquire(admission);
  expect(await lease.close()).toEqual({
    browser: "cleanup_unresolved",
    directories: "cleanup_unresolved",
    operation: "recovery_fenced",
  });
  expect(calls.stopped).toEqual(["browser-private-id"]);
});

test("direct router retries unresolved directory cleanup against its rotated recovery fence", async () => {
  let releases = 0;
  const { router, calls } = makeRouter({
    directories: {
      allocate: async () => ({ socketDirectory: "/run/nautilo/op-1", homeDirectory: "/var/lib/nautilo/op-1" }),
      release: async () => { releases += 1; if (releases === 1) throw new Error("disk unavailable"); },
    },
  });
  const lease = await router.acquire(admission);
  expect(await lease.close()).toEqual({
    browser: "stopped",
    directories: "cleanup_unresolved",
    operation: "recovery_fenced",
  });
  expect(calls.rotated).toEqual([
    { expectedControlEpoch: 4, driver: "direct" },
    { expectedControlEpoch: 5, driver: "direct" },
  ]);
  expect(lease.cleanupControlEpoch()).toBe(6);
  expect(await lease.close()).toEqual({ browser: "stopped", directories: "released", operation: "released" });
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(calls.rotated.at(-1)).toEqual({ expectedControlEpoch: 6, driver: "checking" });
  await lease.close();
  expect(releases).toBe(2);
});

for (const [name, stopResult] of [
  ["malformed", undefined as unknown as BrowserUseBrowserSession],
  ["still active", { ...stoppedBrowser("browser-private-id"), status: "active" as const }],
  ["wrong browser", stoppedBrowser("different-browser-private-id")],
] as const) {
  test(`direct router keeps recovery fenced when provider stop proof is ${name}`, async () => {
    const { router, calls } = makeRouter({
      provider: {
        startBrowser: async () => ({
          browserId: "browser-private-id", cdpUrl: CDP_DISCOVERY, liveViewUrl: null, status: "active",
          timeoutAt: new Date(), observedAt: new Date(),
        }),
        findHostedBrowsers: async () => [],
        stopBrowser: async (browserId) => { calls.stopped.push(browserId); return stopResult; },
      },
    });
    const lease = await router.acquire(admission);
    expect(await lease.close()).toEqual({
      browser: "cleanup_unresolved",
      directories: "cleanup_unresolved",
      operation: "recovery_fenced",
    });
    expect(calls.stopped).toEqual(["browser-private-id"]);
  });
}

test("direct router turns a post-rotation discovery failure into a new fenced recovery epoch", async () => {
  const { router, calls } = makeRouter({
    resolveCdpWebSocketUrl: async () => { throw new Error(`failed ${CDP_DISCOVERY}`); },
  });
  const error = await router.acquire(admission).then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "unavailable", message: "direct browser control unavailable" });
  expect(error).toMatchObject({
    cleanup: { browser: "stopped", directories: "released", operation: "released" },
  });
  // Setup closes the private daemon and proves the exact browser stopped, so
  // the operation is immediately scheduled for durable reconciliation.
  expect(calls.rotated).toEqual([
    { expectedControlEpoch: 4, driver: "direct" },
    { expectedControlEpoch: 5, driver: "checking" },
  ]);
  expect(calls.stopped).toEqual(["browser-private-id"]);
  expect(calls.released).toEqual(["/run/nautilo/op-1"]);
});

test("failed admission retains the direct fence if private directory release fails after the browser stopped", async () => {
  const { router, calls } = makeRouter({
    resolveCdpWebSocketUrl: async () => { throw new Error("discovery failed"); },
    directories: {
      allocate: async () => ({ socketDirectory: "/run/nautilo/op-1", homeDirectory: "/run/nautilo/home-1" }),
      release: async () => { throw new Error("directory cleanup failed"); },
    },
  });
  const error = await router.acquire(admission).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ cleanup: { browser: "stopped", directories: "cleanup_unresolved", operation: "recovery_fenced" } });
  expect(calls.rotated.at(-1)).toEqual({ expectedControlEpoch: 5, driver: "direct" });
});
