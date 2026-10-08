import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "@nautilo/db";
import { LatticeCrypto, TaskRuntimeRecipientRegistry } from
  "@nautilo/lattice-crypto";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  cancelBackgroundAuthorizationRequest,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeCancellationCandidate,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

import { createProtectedTaskCancellationRecovery } from
  "../../src/routes/protected-task-cancellation-recovery";

const START = 1_700_000_000_000;
const database = Object.freeze({}) as unknown as DirectDatabase;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(
  suffix = "a",
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const workId = `20000000-0000-4000-8000-${suffix.codePointAt(0)!.toString(16).padStart(12, "0")}`;
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: `authorization-${suffix}`,
    workId,
    namespaceId: `namespace-${suffix}`,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: `recipient-${suffix}`,
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: waiting.requestId,
    descriptorDigest,
    recipientKeyId: `recipient-${suffix}`,
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: "human-a",
    issuingDeviceId: "device-a",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    `claim-${suffix}`,
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(
      claimed,
      START + 4,
    ),
    workIdentityHash: new Uint8Array(32).fill(suffix.codePointAt(0)!),
    idempotencyKey: `task-runtime-stable-v1:${workId}:${suffix.repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "domain-a",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: `credential-${suffix}`,
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: `namespace-${suffix}`,
        domainId: "domain-a",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "domain-a",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function candidate(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): BackgroundAuthorizationTaskRuntimeCancellationCandidate {
  return Object.freeze({
    requestId: record.snapshot.requestId,
    workId: record.snapshot.workId,
    namespaceId: record.snapshot.namespaceId,
    recipientGeneration: record.snapshot.recipientGeneration,
    requestRevision: record.snapshot.requestRevision,
    updatedAt: record.snapshot.updatedAt,
  });
}

async function custody(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
) {
  const recipients = new TaskRuntimeRecipientRegistry(new LatticeCrypto(), {
    now: () => START,
  });
  const created = await recipients.createAttempt({
    requestId: record.snapshot.requestId,
    workId: record.snapshot.workId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    expiresAt: START + 60_000,
  });
  expect(created.status).toBe("created");
  return recipients;
}

describe("protected Task cancellation recovery", () => {
  test("cancels canonical active authority only inside accepted product proof", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    const facts: unknown[] = [];
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository,
        recipients,
        now: () => START + 10,
        settle: async (_db, input, cancel) => {
          facts.push(input);
          return cancel();
        },
      });
      expect(await recovery.recover(candidate(record))).toBe(true);
      expect(facts).toEqual([{
        taskRunId: record.snapshot.workId,
        contentNamespaceId: record.snapshot.namespaceId,
        authorizationRequestId: record.snapshot.requestId,
        policyRevision: record.expectedPolicyRevision,
      }]);
      expect(await repository.get(record.snapshot.requestId)).toMatchObject({
        snapshot: {
          state: "cancelled",
          terminalReason: "cancelled",
          requestRevision: record.snapshot.requestRevision + 1,
        },
        finishedAt: START + 10,
      });
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("proof rejection leaves the active grant and local custody unchanged", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    let callbackCalls = 0;
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository,
        recipients,
        settle: async () => {
          callbackCalls += 1;
          return false;
        },
      });
      expect(await recovery.recover(candidate(record))).toBe(false);
      expect(callbackCalls).toBe(1);
      expect(await repository.get(record.snapshot.requestId)).toEqual(record);
      expect(recipients.size).toBe(1);
    } finally {
      recipients.close();
    }
  });

  test("retries local cleanup for an already-cancelled durable grant", async () => {
    const active = runningRecord();
    const at = START + 10;
    const record = {
      ...active,
      snapshot: cancelBackgroundAuthorizationRequest(
        active.snapshot,
        "cancelled",
        at,
      ),
      finishedAt: at,
    } as BackgroundAuthorizationTaskRuntimeRecordV3;
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(active);
    let casCalls = 0;
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository: {
          get: requestId => repository.get(requestId),
          listTaskRuntimeCancellationPage: input =>
            repository.listTaskRuntimeCancellationPage(input),
          compareAndSwap: input => {
            casCalls += 1;
            return repository.compareAndSwap(input);
          },
        },
        recipients,
        settle: async (_db, _input, cancel) => cancel(),
      });
      expect(await recovery.recover(candidate(record))).toBe(true);
      expect(casCalls).toBe(0);
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("stale revision or recipient generation has no product or custody effect", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    let settlementCalls = 0;
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository,
        recipients,
        settle: async () => {
          settlementCalls += 1;
          return true;
        },
      });
      expect(await recovery.recover({
        ...candidate(record),
        requestRevision: record.snapshot.requestRevision + 1,
      })).toBe(false);
      expect(await recovery.recover({
        ...candidate(record),
        recipientGeneration: record.snapshot.recipientGeneration + 1,
      })).toBe(false);
      expect(settlementCalls).toBe(0);
      expect(await repository.get(record.snapshot.requestId)).toEqual(record);
      expect(recipients.size).toBe(1);
    } finally {
      recipients.close();
    }
  });

  test("retries product settlement after the crypto cancellation CAS committed", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    let attempts = 0;
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository,
        recipients,
        now: () => START + 10,
        settle: async (_db, _input, cancel) => {
          attempts += 1;
          const result = await cancel();
          if (attempts === 1) throw new Error("product commit failed");
          return result;
        },
      });
      const failure = await recovery.recover(candidate(record)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("product commit failed");
      expect(await repository.get(record.snapshot.requestId)).toMatchObject({
        snapshot: { state: "cancelled", terminalReason: "cancelled" },
      });
      expect(recipients.size).toBe(1);

      const current = await repository.get(record.snapshot.requestId);
      expect(current).not.toBeNull();
      expect(await recovery.recover(candidate(
        current as BackgroundAuthorizationTaskRuntimeRecordV3,
      ))).toBe(true);
      expect(attempts).toBe(2);
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("isolates candidate failures and preserves one frozen page watermark", async () => {
    const broken = runningRecord("b");
    const valid = runningRecord("c");
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(valid);
    const recipients = await custody(valid);
    const continuation = {
      updatedAt: START + 6,
      requestId: valid.snapshot.requestId,
    };
    let observedPage: unknown;
    let clock = START + 100;
    try {
      const recovery = createProtectedTaskCancellationRecovery({
        db: database,
        repository: {
          get: async requestId => {
            if (requestId === broken.snapshot.requestId) {
              throw new Error("transient lookup failure");
            }
            return repository.get(requestId);
          },
          compareAndSwap: input => repository.compareAndSwap(input),
          listTaskRuntimeCancellationPage: async input => {
            observedPage = input;
            clock += 100;
            return {
              candidates: [candidate(broken), candidate(valid)],
              continuation,
            };
          },
        },
        recipients,
        now: () => clock,
        settle: async (_db, _input, cancel) => cancel(),
      });
      expect(await recovery.recoverPage({ limit: 2 })).toEqual({
        attempted: 2,
        settled: 1,
        failures: 1,
        next: {
          throughUpdatedAt: START + 100,
          after: continuation,
        },
      });
      expect(observedPage).toEqual({
        throughUpdatedAt: START + 100,
        limit: 2,
      });
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });
});
