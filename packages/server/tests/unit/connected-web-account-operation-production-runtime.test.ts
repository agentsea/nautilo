import { expect, test } from "bun:test";
import {
  createConnectedWebOperationProductionRuntime,
  type ConnectedWebOperationProductionRuntimeScheduler,
} from "../../src/connected-web-accounts/operation-production-runtime";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";

function scheduler(): {
  readonly scheduler: ConnectedWebOperationProductionRuntimeScheduler;
  readonly queued: Array<() => void>;
  readonly ticks: Array<() => void>;
} {
  const queued: Array<() => void> = [];
  const ticks: Array<() => void> = [];
  return {
    scheduler: {
      queue: (callback) => { queued.push(callback); },
      setInterval: (callback) => {
        ticks.push(callback);
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    },
    queued,
    ticks,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("production polling is non-overlapping while scheduled wakes remain independent, and stop aborts future work", async () => {
  const manual = scheduler();
  const sequence: string[] = [];
  let supervisorCalls = 0;
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  let firstSignal: AbortSignal | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never,
    store: {} as never,
    provider: {} as never,
    secrets: {} as never,
    scheduler: manual.scheduler,
    runSupervisor: async ({ signal }) => {
      supervisorCalls += 1;
      sequence.push(`supervisor-${supervisorCalls}`);
      if (supervisorCalls === 1) {
        firstSignal = signal;
        firstStarted?.();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { claimed: 0, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 0 };
    },
    deliverWakes: async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      sequence.push("wake");
    },
  });

  runtime.start();
  expect(manual.queued).toHaveLength(1);
  manual.queued.shift()?.();
  await firstStartedPromise;
  runtime.requestPump();
  expect(manual.queued).toHaveLength(1);
  manual.queued.shift()?.();
  await flush();
  expect(supervisorCalls).toBe(1);
  expect(sequence).toEqual(["supervisor-1", "wake", "wake"]);

  runtime.stop();
  expect(firstSignal?.aborted).toBe(true);
  releaseFirst?.();
  await flush();
  expect(sequence).toEqual(["supervisor-1", "wake", "wake"]);

  runtime.start();
  expect(manual.queued).toHaveLength(1);
  manual.queued.shift()?.();
  await flush();
  expect(sequence).toEqual(["supervisor-1", "wake", "wake", "supervisor-2", "wake"]);
  runtime.stop();
});

test("D568 production operation pump keeps supervisor and wake transport claims distinct", async () => {
  const manual = scheduler();
  const calls: Array<{ readonly kind: string; readonly workerId: string }> = [];
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never,
    store: {} as never,
    provider: {} as never,
    secrets: {} as never,
    scheduler: manual.scheduler,
    runSupervisor: async ({ workerId }) => {
      calls.push({ kind: "supervisor", workerId });
      return { claimed: 1, reconciled: 1, rescheduled: 0, terminalized: 0, stale: 0 };
    },
    deliverWakes: async ({ workerId }) => { calls.push({ kind: "wake", workerId }); },
  });

  runtime.start();
  manual.queued.shift()?.();
  await flush();
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.kind)).toEqual(["supervisor", "wake"]);
  expect(calls[0]!.workerId).not.toBe(calls[1]!.workerId);
  runtime.stop();
});

test("finished sync cleanup retries independently while provider supervision is stalled", async () => {
  const manual = scheduler();
  let pending = true;
  let attempts = 0;
  let releaseSupervisor!: () => void;
  let finished!: () => void;
  const complete = new Promise<void>((resolve) => { finished = resolve; });
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never, secrets: {} as never, scheduler: manual.scheduler,
    runSupervisor: async () => {
      await new Promise<void>((resolve) => { releaseSupervisor = resolve; });
      return { claimed: 0, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 0 };
    },
    deliverWakes: async () => undefined,
    provider: { stopHostedReadBrowser: async () => ++attempts > 1 } as never,
    store: {
      listPendingExecutionCleanup: async () => pending ? [{ accountId: "account", ownerUserId: "owner", checkpoint: {
        resource: "read", phase: "active", reservationToken: "reservation", opaqueExecutionRef: "run", cleanupStatus: "connected",
      } }] : [],
      requestExecutionCleanup: async () => "run",
      completeExecution: async () => { pending = false; finished(); return {} as never; },
    } as never,
  });
  runtime.start();
  manual.queued.shift()?.();
  // Drain the finite cleanup promise chain; supervisor deliberately stays pending.
  await Bun.sleep(0);
  expect(attempts).toBe(1);
  expect(pending).toBe(true);
  runtime.requestPump();
  manual.queued.shift()?.();
  await complete;
  expect(attempts).toBe(2);
  expect(pending).toBe(false);
  runtime.stop();
  releaseSupervisor();
});

test("idle cleanup is wired to the pump without blocking supervision or claiming twice during a slow stop", async () => {
  const manual = scheduler();
  const now = new Date("2026-09-04T15:00:00Z");
  const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "s".repeat(32) });
  const context = { operationId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222", accountId: "33333333-3333-4333-8333-333333333333" };
  const operation = { id: context.operationId, ownerUserId: context.ownerUserId, accountId: context.accountId,
    lifecycle: "terminal", browserCleanupStartedAt: now,
    sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: { sessionId: "idle-session" } }),
  } as ConnectedWebOperation;
  let claims = 0;
  let supervised = 0;
  let wakePasses = 0;
  let releaseStop!: () => void;
  let startedStop!: () => void;
  let completedCleanup!: () => void;
  const stopping = new Promise<void>((resolve) => { startedStop = resolve; });
  const finished = new Promise<void>((resolve) => { completedCleanup = resolve; });
  const completed: unknown[] = [];
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never, scheduler: manual.scheduler, clock: { now: () => now }, secrets,
    runSupervisor: async () => { supervised++; return { claimed: 0, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 0 }; },
    deliverWakes: async () => { wakePasses++; },
    store: {
      claimIdleBrowserOperations: async () => { claims++; return [operation]; },
      completeIdleBrowserCleanup: async (input: unknown) => { completed.push(input); completedCleanup(); },
    } as never,
    provider: {
      findHostedBrowsers: async ({ agentSessionId }: { agentSessionId: string }) => {
        expect(agentSessionId).toBe("idle-session");
        return [{ browserId: "exact-idle-browser", status: "active" }];
      },
      stopBrowser: async (id: string) => {
        expect(id).toBe("exact-idle-browser"); startedStop();
        await new Promise<void>((resolve) => { releaseStop = resolve; });
        return { browserId: id, status: "stopped" };
      },
    } as never,
  });
  runtime.start(); manual.queued.shift()?.(); await stopping;
  runtime.requestPump(); manual.queued.shift()?.(); await flush();
  expect(supervised).toBe(2); expect(wakePasses).toBe(2); expect(claims).toBe(1);
  expect(completed).toEqual([]);
  releaseStop(); await finished;
  expect(completed).toEqual([{ operationId: context.operationId, now, stopped: true }]);
  runtime.stop();
});

test("D568 production composition unseals provider coordinates only with the exact claimed operation context", async () => {
  const manual = scheduler();
  const now = new Date("2026-09-03T12:00:00.000Z");
  const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "s".repeat(32) });
  const context = {
    operationId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
  };
  const operation = {
    ...context,
    id: context.operationId,
    initiatingAgentId: "44444444-4444-4444-8444-444444444444",
    initiatingRoomId: "55555555-5555-4555-8555-555555555555",
    initiatingThreadId: "thread-1",
    initiatingLane: "lane-1",
    deliveryId: "delivery-1",
    requestDigest: "a".repeat(64),
    sealedIntent: "sealed-intent",
    actionOperationId: null,
    effectIdempotencyKey: null,
    driver: "hosted" as const,
    lifecycle: "running" as const,
    controlEpoch: 1,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666",
    controlLeaseExpiresAt: null,
    sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: { runId: "run-private-id" } }),
    eventCursor: 0,
    safeActivity: { version: 1 as const, phase: "working" as const, code: "running", summary: "Working." },
    wakeFingerprint: null,
    nextCheckAt: now,
    supervisorClaimOwner: null,
    supervisorClaimExpiresAt: null,
    wakeClaimOwner: null,
    wakeClaimExpiresAt: null,
    wakeAttempts: 0,
    wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 0,
    remainingBudgetUsdMicros: 100,
    terminalReceipt: null,
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies ConnectedWebOperation;
  const polled: string[] = [];
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never,
    scheduler: manual.scheduler,
    clock: { now: () => now },
    secrets,
    store: {
      getOperationForOwner: async () => operation,
      claimDueOperations: async () => [operation],
      releaseOperationClaim: async () => true,
      recordOperationCheckpoint: async () => true,
      terminalizeOperation: async () => true,
      terminalizeReadOperationAndCompleteExecution: async () => true,
      claimDueOperationWakes: async () => [],
      completeOperationWake: async () => true,
      releaseOperationWakeClaim: async () => true,
    },
    provider: {
      pollHostedReadRun: async (runId) => {
        polled.push(runId);
        return { runId, status: "running" as const, observedAt: now };
      },
      readHostedRunEventDelta: async (input) => ({
        runId: input.runId,
        events: [],
        nextAfter: null,
        hasMore: false,
        observedAt: now,
      }),
      getHostedReadResult: async () => ({
        runId: "run-private-id", status: "completed" as const, result: null, totalCostUsd: "0", observedAt: now,
      }),
    },
  });

  runtime.start();
  manual.queued.shift()?.();
  await flush();
  expect(polled).toEqual(["run-private-id"]);
  runtime.stop();
});

test("D568 production composition preserves sealed read authority after a cursor checkpoint clones the claimed row", async () => {
  const manual = scheduler();
  const now = new Date("2026-09-04T12:00:00.000Z");
  const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "s".repeat(32) });
  const context = {
    operationId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
  };
  const operation = {
    ...context,
    id: context.operationId,
    initiatingAgentId: "44444444-4444-4444-8444-444444444444",
    initiatingRoomId: "55555555-5555-4555-8555-555555555555",
    initiatingThreadId: "thread-1",
    initiatingLane: "lane-1",
    deliveryId: "delivery-1",
    requestDigest: "a".repeat(64),
    sealedIntent: secrets.sealIntent({
      context,
      intent: JSON.stringify({
        version: 2,
        kind: "read_connected_web_account",
        fundingHumanUserId: context.ownerUserId,
        origin: "https://example.com",
        request: "Read the current balance.",
        delivery: "text",
        deliveryId: "delivery-1",
        threadId: "thread-1",
        lane: "lane-1",
        turnId: "turn-1",
      }),
    }),
    actionOperationId: null,
    effectIdempotencyKey: null,
    driver: "hosted" as const,
    lifecycle: "running" as const,
    controlEpoch: 1,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666",
    controlLeaseExpiresAt: null,
    sealedProviderRefs: secrets.sealProviderReferences({ context, coordinates: { runId: "run-private-id" } }),
    eventCursor: 0,
    safeActivity: { version: 1 as const, phase: "working" as const, code: "running", summary: "Working." },
    wakeFingerprint: null,
    nextCheckAt: now,
    supervisorClaimOwner: null,
    supervisorClaimExpiresAt: null,
    wakeClaimOwner: null,
    wakeClaimExpiresAt: null,
    wakeAttempts: 0,
    wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 0,
    remainingBudgetUsdMicros: 1_000_000,
    terminalReceipt: null,
    terminalReadResult: null,
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies ConnectedWebOperation;
  const terminalizations: Array<Record<string, unknown>> = [];
  const runtime = createConnectedWebOperationProductionRuntime({
    db: {} as never,
    scheduler: manual.scheduler,
    clock: { now: () => now },
    secrets,
    store: {
      getOperationForOwner: async () => operation,
      claimDueOperations: async () => [operation],
      releaseOperationClaim: async () => true,
      recordOperationCheckpoint: async () => true,
      terminalizeOperation: async () => true,
      terminalizeReadOperationAndCompleteExecution: async (input) => {
        terminalizations.push(input as unknown as Record<string, unknown>);
        return true;
      },
      getForOwner: async () => ({
        id: context.accountId,
        ownerUserId: context.ownerUserId,
        label: "Example",
        service: "example.com",
        origin: "https://example.com",
        status: "busy" as const,
        profileRef: "profile-private-id",
        lastVerifiedAt: null,
        executionCheckpoint: null,
        cleanupState: "not_required" as const,
        cleanupFailureCode: null,
        revokedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
      claimDueOperationWakes: async () => [],
      completeOperationWake: async () => true,
      releaseOperationWakeClaim: async () => true,
    },
    provider: {
      pollHostedReadRun: async (runId) => ({ runId, status: "completed" as const, observedAt: now }),
      readHostedRunEventDelta: async (input) => ({
        runId: input.runId,
        events: [{ eventId: 1, occurredAt: now, type: "run.completed", data: {} }],
        nextAfter: 1,
        hasMore: false,
        observedAt: now,
      }),
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed" as const,
        result: JSON.stringify({
          answer: "No current balance.",
          facts: [{ label: "Current balance", value: "$0" }],
          completeness: "complete",
          provenance: "authenticated_website",
          origin: "https://example.com",
        }),
        totalCostUsd: "0.01",
        observedAt: now,
      }),
    },
  });

  runtime.start();
  manual.queued.shift()?.();
  for (let step = 0; step < 20 && terminalizations.length === 0; step += 1) await Promise.resolve();
  expect(terminalizations).toHaveLength(1);
  expect(terminalizations[0]?.["receipt"]).toMatchObject({ outcome: "completed", code: "provider_completed" });
  expect(terminalizations[0]?.["terminalReadResult"]).toMatchObject({
    read: { answer: "No current balance.", completeness: "complete" },
  });
  runtime.stop();
});
