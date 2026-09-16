import { describe, expect, test } from "bun:test";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import {
  connectedWebOperationWakeTurnId,
  createConnectedWebOperationWakeExecutor,
  deliverConnectedWebOperationWakes,
} from "../../src/connected-web-accounts/operation-wake";

const operation: ConnectedWebOperation = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  initiatingAgentId: "44444444-4444-4444-8444-444444444444",
  initiatingRoomId: "55555555-5555-4555-8555-555555555555",
  initiatingThreadId: "room:55555555-5555-4555-8555-555555555555:bot:44444444-4444-4444-8444-444444444444",
  initiatingLane: "room:55555555-5555-4555-8555-555555555555:user:22222222-2222-4222-8222-222222222222:bot:44444444-4444-4444-8444-444444444444",
  deliveryId: "delivery-1",
  requestDigest: "a".repeat(64),
  sealedIntent: "sealed:v1:not-visible",
  actionOperationId: null,
  effectIdempotencyKey: null,
  driver: "hosted",
  lifecycle: "running",
  controlEpoch: 3,
  controlLeaseToken: "66666666-6666-4666-8666-666666666666",
  controlLeaseExpiresAt: null,
  sealedProviderRefs: { version: 1, runRef: "sealed:run-1" },
  eventCursor: 12,
  safeActivity: { version: 1, phase: "working", code: "BROWSER_READY", summary: "Browser is ready for the requested work." },
  wakeFingerprint: "checkpoint-12",
  nextCheckAt: null,
  supervisorClaimOwner: null,
  supervisorClaimExpiresAt: null,
  wakeClaimOwner: "wake-worker",
  wakeClaimExpiresAt: new Date("2030-01-01T00:01:00.000Z"),
  wakeAttempts: 1,
  wakeDeliveredAt: null,
  cumulativeCostUsdMicros: 3,
  remainingBudgetUsdMicros: 97,
  terminalReceipt: null,
  terminalAt: null,
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
  updatedAt: new Date("2030-01-01T00:00:01.000Z"),
};

describe("D568 exact initiating-Genie operation wakes", () => {
  test("re-resolves and wakes exactly the stored Human, Genie, Room, thread, and lane with safe facts only", async () => {
    const acceptedInputs: Record<string, unknown>[] = [];
    const completed: Record<string, unknown>[] = [];
    const result = await deliverConnectedWebOperationWakes({
      db: {} as never,
      workerId: "wake-worker",
      now: () => new Date("2030-01-01T00:00:02.000Z"),
      resolveEnvelope: async (claim) => {
        expect(claim.id).toBe(operation.id);
        return { policy: "fresh" };
      },
      jobs: {
        async createSystemForegroundJob(_owner, _requestor, _lane, input) {
          acceptedInputs.push(input);
          return { id: "accepted", virtualJobId: "accepted" };
        },
      },
      operations: {
        claim: async () => [operation],
        load: async () => operation,
        complete: async (input) => { completed.push(input); return true; },
        release: async () => true,
      },
    });
    expect(result).toEqual({ claimed: 1, accepted: 1, delivered: 1 });
    expect(completed).toEqual([{
      operationId: operation.id,
      workerId: "wake-worker",
      expectedWakeFingerprint: operation.wakeFingerprint,
      now: new Date("2030-01-01T00:00:02.000Z"),
    }]);
    expect(acceptedInputs).toHaveLength(1);
    expect(acceptedInputs[0]).toMatchObject({
      ownerId: operation.ownerUserId,
      requestorId: operation.ownerUserId,
      agentId: operation.initiatingAgentId,
      roomId: operation.initiatingRoomId,
      graphThreadId: operation.initiatingThreadId,
      threadId: operation.initiatingThreadId,
      turnId: connectedWebOperationWakeTurnId(operation.id, operation.wakeFingerprint!),
      metadata: {
        originatedBy: "connected_web_operation",
        operationId: operation.id,
        controlEpoch: operation.controlEpoch,
        activity: operation.safeActivity,
        receipt: null,
      },
    });
    const safe = JSON.stringify(acceptedInputs[0]);
    expect(acceptedInputs[0]?.["message"]).toContain("Internal supervision checkpoint, not a new Human message");
    expect(acceptedInputs[0]?.["message"]).toContain("call skip with no target_handle");
    expect(acceptedInputs[0]?.["message"]).toContain("Inspect the latest evidence and take any needed control action");
    expect(acceptedInputs[0]?.["message"]).toContain("Do not start another read");
    expect(safe).not.toMatch(/sealed:v1|sealed:run|profile|provider|https?:\/\/|cdp|cookie|intent/iu);
  });

  test("is explicitly at-least-once if acceptance succeeds but durable completion loses the race", async () => {
    const turnIds: string[] = [];
    const jobs = {
      async createSystemForegroundJob(_owner: string, _requestor: string, _lane: string, input: Record<string, unknown>) {
        turnIds.push(String(input["turnId"]));
        return { id: `accepted-${turnIds.length}`, virtualJobId: `accepted-${turnIds.length}` };
      },
    };
    const operations = {
      claim: async () => [operation],
      load: async () => operation,
      complete: async () => false,
      release: async () => true,
    };
    const first = await deliverConnectedWebOperationWakes({
      db: {} as never, workerId: "wake-worker", resolveEnvelope: async () => ({ fresh: true }), jobs, operations,
    });
    const retry = await deliverConnectedWebOperationWakes({
      db: {} as never, workerId: "wake-worker", resolveEnvelope: async () => ({ fresh: true }), jobs, operations,
    });
    expect(first).toEqual({ claimed: 1, accepted: 1, delivered: 0 });
    expect(retry).toEqual({ claimed: 1, accepted: 1, delivered: 0 });
    expect(turnIds).toEqual([
      connectedWebOperationWakeTurnId(operation.id, operation.wakeFingerprint!),
      connectedWebOperationWakeTurnId(operation.id, operation.wakeFingerprint!),
    ]);
  });

  test("releases the exact claimed fingerprint when foreground acceptance fails", async () => {
    const released: Record<string, unknown>[] = [];
    const result = await deliverConnectedWebOperationWakes({
      db: {} as never,
      workerId: "wake-worker",
      now: () => new Date("2030-01-01T00:00:03.000Z"),
      resolveEnvelope: async () => ({ fresh: true }),
      jobs: { async createSystemForegroundJob() { throw new Error("queue unavailable"); } },
      operations: {
        claim: async () => [operation],
        load: async () => operation,
        complete: async () => true,
        release: async (input) => { released.push(input); return true; },
      },
    });
    expect(result).toEqual({ claimed: 1, accepted: 0, delivered: 0 });
    expect(released[0]).toMatchObject({
      operationId: operation.id,
      workerId: "wake-worker",
      expectedWakeFingerprint: operation.wakeFingerprint,
    });
  });
});

test("queued progress is discarded before invoking the Genie when completion supersedes it", async () => {
  const calls: unknown[] = [];
  const executor = createConnectedWebOperationWakeExecutor({
    expected: operation,
    load: async () => ({ ...operation, lifecycle: "terminal", wakeFingerprint: "completed" }),
    resolveEnvelope: async () => { throw new Error("stale wake must not execute"); },
    execute: async function* (input) { calls.push(input); yield* []; },
  });
  const events = [];
  for await (const event of executor({}, "job", operation.initiatingLane, new AbortController().signal)) events.push(event);
  expect(events).toEqual([]);
  expect(calls).toEqual([]);
});

test("a current wake refreshes authority and restores only the sealed initiating voice preference", async () => {
  for (const voiceMode of [true, false, undefined]) {
    const calls: Record<string, unknown>[] = [];
    const current = { ...operation, safeActivity: { ...operation.safeActivity, summary: "Latest safe status." } };
    const executor = createConnectedWebOperationWakeExecutor({
      expected: operation, load: async () => current,
      resolveEnvelope: async () => ({ fresh: true }),
      secrets: { unsealIntent: ({ context }) => { expect(context.ownerUserId).toBe(operation.ownerUserId); return JSON.stringify({ version: 1, kind: "read_connected_web_account", voiceMode }); } },
      execute: async function* (input) { calls.push(input); yield* []; },
    });
    for await (const _event of executor({ voiceMode: true, memoryAccessEnvelope: { stale: true } }, "job", operation.initiatingLane, new AbortController().signal)) { /* drain */ }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ voiceMode: voiceMode === true, memoryAccessEnvelope: { fresh: true } });
    expect(calls[0]?.["message"]).toContain("Latest safe status.");
  }
});
