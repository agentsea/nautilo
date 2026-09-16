import { afterEach, expect, test } from "bun:test";
import {
  getConnectedWebOperationToolRuntime,
  resetConnectedWebAccountReadToolRuntimeForTests,
} from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";

import type { BrowserUseCloudAdapter } from "../../src/browser-use/browser-use-cloud";
import { createConnectedWebOperationLiveRuntime } from "../../src/connected-web-accounts/operation-live-runtime";
import type { ConnectedWebOperationProductionRuntimeScheduler } from "../../src/connected-web-accounts/operation-production-runtime";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import type {
  ConnectedWebAccountStore,
  ConnectedWebOperation,
} from "../../src/connected-web-accounts/store";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const OPERATION = "55555555-5555-4555-8555-555555555555";

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

function authorizedDb(): DirectDatabase {
  return {
    select(selection: Record<string, unknown>) {
      const rows = "roomOwnerId" in selection
        ? [
            {
              roomOwnerId: OWNER,
              roomKind: "private",
              roomType: "private",
              roomArchivedAt: null,
              actorOwnerId: OWNER,
              actorKind: "user",
              actorAgentId: null,
            },
            {
              roomOwnerId: OWNER,
              roomKind: "private",
              roomType: "private",
              roomArchivedAt: null,
              actorOwnerId: OWNER,
              actorKind: "agent",
              actorAgentId: AGENT,
            },
          ]
        : [{ ownerId: OWNER, agentId: AGENT, kind: "agent" }];
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => Promise.resolve(rows),
      };
      return query;
    },
  } as unknown as DirectDatabase;
}

function operation(): ConnectedWebOperation {
  const now = new Date("2026-09-03T12:00:00.000Z");
  return {
    id: OPERATION,
    ownerUserId: OWNER,
    accountId: ACCOUNT,
    initiatingAgentId: AGENT,
    initiatingRoomId: ROOM,
    initiatingThreadId: "graph-thread-d568",
    initiatingLane: `room:${ROOM}`,
    deliveryId: "delivery-d568",
    requestDigest: "a".repeat(64),
    sealedIntent: new ConnectedWebOperationSecrets({ stableServerSecret: "s".repeat(32) }).sealIntent({
      context: { operationId: OPERATION, ownerUserId: OWNER, accountId: ACCOUNT },
      intent: JSON.stringify({ version: 1, kind: "read_connected_web_account", origin: "https://example.com", request: "Read the requested page", delivery: "text",
        deliveryId: "delivery-d568", threadId: "graph-thread-d568", lane: `room:${ROOM}`, turnId: "turn-d568" }),
    }),
    actionOperationId: null,
    effectIdempotencyKey: null,
    driver: "hosted",
    lifecycle: "running",
    controlEpoch: 1,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666",
    controlLeaseExpiresAt: null,
    sealedProviderRefs: { version: 1 },
    eventCursor: 0,
    safeActivity: { version: 1, phase: "working", code: "running", summary: "Working." },
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
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

test("D568 listener-owned runtime installs exact DB-authorized management and clears only its singleton on stop", async () => {
  const queued: Array<() => void> = [];
  const scheduler: ConnectedWebOperationProductionRuntimeScheduler = {
    queue: (callback) => { queued.push(callback); },
    setInterval: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
  };
  const connectedOperation = operation();
  const store = {
    getOperationForOwner: async () => connectedOperation,
    scheduleOperationCheck: async () => true,
    rotateOperationProviderRunByControl: async () => 2,
    claimDueOperations: async () => [],
    releaseOperationClaim: async () => true,
    recordOperationCheckpoint: async () => true,
    terminalizeOperation: async () => true,
    claimDueOperationWakes: async () => [],
    completeOperationWake: async () => true,
    releaseOperationWakeClaim: async () => true,
  } as unknown as ConnectedWebAccountStore;
  const runtime = createConnectedWebOperationLiveRuntime({
    db: authorizedDb(),
    store,
    provider: {} as BrowserUseCloudAdapter,
    stableServerSecret: "s".repeat(32),
    scheduler,
  });

  expect(getConnectedWebOperationToolRuntime()).toBeNull();
  await runtime.start();
  const management = getConnectedWebOperationToolRuntime();
  expect(management).not.toBeNull();
  const result = await management!.manage({
    userId: OWNER,
    agentId: AGENT,
    roomId: ROOM,
    callingRoomId: null,
    memoryAccessEnvelope: { toolPolicy: { read_connected_web_account: "allow" } } as never,
    toolCallId: "tool-call-d568",
    currentThreadId: "graph-thread-d568",
    turnId: "turn-d568",
    laneKey: `room:${ROOM}`,
  }, {
    operation: "inspect",
    operationId: OPERATION,
    expectedControlEpoch: 1,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("management inspect was rejected");
  expect(result.accepted).toBe("inspect");

  await runtime.stop();
  expect(getConnectedWebOperationToolRuntime()).toBeNull();
  queued.shift()?.();
  await Promise.resolve();
  expect(getConnectedWebOperationToolRuntime()).toBeNull();
});

test("D568 listener-owned runtime refuses unstable secret material before installing management", () => {
  expect(() => createConnectedWebOperationLiveRuntime({
    db: {} as DirectDatabase,
    store: {} as ConnectedWebAccountStore,
    provider: {} as BrowserUseCloudAdapter,
    stableServerSecret: "short",
  })).toThrow();
  expect(getConnectedWebOperationToolRuntime()).toBeNull();
});
