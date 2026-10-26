import { expect, test } from "bun:test";
import { protectedTaskRunOutputBindingId, protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId, protectedTaskRunMessageOperationId,
  protectedTaskRunWakeOperationId, type ProtectedTaskRunOutputBinding } from "@nautilo/db";
import { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import { createProtectedTaskTerminalMessageComposition } from "../../src/routes/protected-task-terminal-message-composition";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "10000000-0000-4000-8000-000000000002";
const ROOM = "10000000-0000-4000-8000-000000000003";
const NS = "10000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-10-12T10:00:00Z");

function binding(overrides: Partial<ProtectedTaskRunOutputBinding> = {}): ProtectedTaskRunOutputBinding {
  return { taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN),
    deliveryMode: "raw_and_wake", destinationRoomId: ROOM, destinationNamespaceId: NS,
    resultRevision: 2, resultOperationId: protectedTaskRunCancelledResultOperationId(RUN),
    resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    messageOperationId: protectedTaskRunMessageOperationId(RUN), wakeOperationId: protectedTaskRunWakeOperationId(RUN),
    acceptedPolicyRevision: 7, acceptedAt: NOW, resultTerminalAt: NOW, resultAttachedAt: NOW,
    messageId: null, messagePublishedAt: null, wakeJobId: null, wakeScheduledAt: null,
    completedAt: null, ...overrides };
}

type Overrides = NonNullable<Parameters<typeof createProtectedTaskTerminalMessageComposition>[1]>;
function fixture(overrides: Overrides = {}) {
  const calls: string[] = [];
  const crypto = new LatticeCrypto();
  const composition = createProtectedTaskTerminalMessageComposition({
    db: {} as never, restricted: {} as never, crypto, owner: {} as never,
    recipients: new TaskRuntimeRecipientRegistry(crypto), serverScope: "https://nautilo.example",
    recipientTtlMs: 300_000, now: () => NOW.getTime(),
  }, {
    readPolicy: async () => ({ mode: "encrypted_only", shadowBehavior: "strict", revision: 7,
      shadowEncryptionStartedAt: NOW, updatedAt: NOW }),
    list: async () => { calls.push("list"); return [binding()]; },
    taskId: async () => TASK,
    preparation: { prepare: async () => { calls.push("prepare"); return { status: "not_ready" }; }, resolvePlan: async () => null },
    claim: async () => { calls.push("claim"); return null; },
    recovery: { recoverCoordinates: async () => { calls.push("recover"); return "mapped"; }, recover: async () => "mapped" },
    scheduleWake: async () => { calls.push("wake"); return { status: "rejected", reason: "not_found" }; },
    repository: async () => { calls.push("repository"); throw new Error("unexpected repository"); },
    ...overrides,
  });
  return { composition, calls };
}

test("Plain observation does not query outputs, grants, allocation or wake scheduling", async () => {
  const f = fixture({ readPolicy: async () => ({ mode: "plaintext_only", shadowBehavior: "strict", revision: 8,
    shadowEncryptionStartedAt: null, updatedAt: NOW }) });
  expect(await f.composition.recoverPage({ limit: 5 })).toEqual({
    attempted: 0, published: 0, wakesScheduled: 0, pending: 0, failures: 0,
  });
  expect(f.calls).toEqual([]);
});

test("durable Message recovery precedes structural wake scheduling", async () => {
  const f = fixture();
  const result = await f.composition.recoverPage({ limit: 5 });
  expect(f.calls).toEqual(["list", "recover", "wake"]);
  expect(result).toMatchObject({ published: 1, pending: 1, failures: 0 });
});

test("pending or quarantined ciphertext is neither re-prepared nor followed by a wake", async () => {
  for (const outcome of ["pending", "quarantined"] as const) {
    const f = fixture({ recovery: { recoverCoordinates: async () => outcome, recover: async () => "pending" } });
    expect(await f.composition.recoverPage({ limit: 5 })).toMatchObject({ published: 0, pending: 1, failures: 0 });
    expect(f.calls).toEqual(["list"]);
  }
});

test("unstaged output requests preparation and waits for device authority", async () => {
  const f = fixture({ recovery: { recoverCoordinates: async () => "missing", recover: async () => "pending" } });
  expect(await f.composition.recoverPage({ limit: 5 })).toMatchObject({ pending: 1, failures: 0 });
  expect(f.calls).toEqual(["list", "prepare"]);
});

test("an existing raw receipt is reused while a wake waits; result inspection is not invoked", async () => {
  const f = fixture({ list: async () => [binding({ messageId: 41, messagePublishedAt: NOW })] });
  expect(await f.composition.recoverPage({ limit: 5 })).toMatchObject({ published: 0, pending: 1, failures: 0 });
  expect(f.calls).toEqual(["wake"]);
});

test("an unread normal result is not substituted by the fixed cancellation notice", async () => {
  const f = fixture({ list: async () => [binding({ resultRevision: 1 })] });
  expect(await f.composition.recoverPage({ limit: 1 })).toMatchObject({ pending: 1,
    next: { taskRunId: RUN, acceptedAt: NOW } });
  expect(f.calls).toEqual([]);
});

test("aborted observation performs no per-output publication or wake", async () => {
  const f = fixture();
  expect(await Promise.allSettled([
    f.composition.recoverPage({ limit: 5, signal: AbortSignal.abort() }),
  ])).toMatchObject([{ status: "rejected" }]);
  expect(f.calls).toEqual(["list"]);
});
