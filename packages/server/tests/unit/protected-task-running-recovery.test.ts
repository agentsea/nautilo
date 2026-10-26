import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  ProtectedTaskRunningAuthorizationProof,
  ProtectedTaskRunningAuthorizationSettlement,
  ProtectedTaskRunningRecoveryResult,
} from "@nautilo/db";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

import { createProtectedTaskRunningRecovery } from
  "../../src/routes/protected-task-running-recovery";

const START = 1_700_000_000_000;
const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  namespace: "40000000-0000-4000-8000-000000000004",
};
const requestId = `task-run-authorization:${ids.run}`;
const database = Object.freeze({}) as DirectDatabase;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(
  overrides: Partial<BackgroundAuthorizationTaskRuntimeRecordV3> = {},
  executionRequestId: string = requestId,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const requestId = executionRequestId;
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId, workId: ids.run, namespaceId: ids.namespace, now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0, recipientKeyId: "recipient-a", recipientPublicKey: publicKey,
    descriptorDigest, expiresAt: START + 120_000, now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime", requestId, descriptorDigest,
    recipientKeyId: "recipient-a", recipientPublicKey: publicKey,
    expiresAt: START + 120_000, responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32), issuingHumanId: "human-a",
    issuingDeviceId: "device-a", recipientGeneration: 0, now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready, "claim-a", START + 3, START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(claimed, START + 4),
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey: `task-runtime-stable-v1:${ids.run}:${"a".repeat(43)}`,
    workKind: "task.execute", purpose: "task.execute", domainId: "domain-a",
    processorAuthorizationRevision: null, expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4, expectedPolicyRevision: 7,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes, credentialId: "credential-a",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 120_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{ ordinal: 0, namespaceId: ids.namespace,
        domainId: "domain-a", operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4, expectedPolicyRevision: 7 }],
      domainRequirements: [{ ordinal: 0, domainId: "domain-a", expectedEpoch: 3,
        expectedAuthorizationRevision: 8 }],
    },
    ...overrides,
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function proof(
  overrides: Partial<ProtectedTaskRunningAuthorizationProof> = {},
): ProtectedTaskRunningAuthorizationProof {
  return {
    taskId: ids.task, taskRunId: ids.run, jobId: ids.job,
    jobStatus: "running", authorizationRequestId: requestId,
    contentNamespaceId: ids.namespace, acceptedPolicyRevision: 7,
    executionSegment: 1, ...overrides,
  };
}

type Settle = (
  db: DirectDatabase,
  candidate: Readonly<{ taskId: string; taskRunId: string }>,
  authorize: (proof: ProtectedTaskRunningAuthorizationProof) =>
    Promise<ProtectedTaskRunningAuthorizationSettlement | null>,
) => Promise<ProtectedTaskRunningRecoveryResult>;

function settleWith(
  value: ProtectedTaskRunningAuthorizationProof,
  options: Readonly<{ failAfterAuthorization?: boolean }> = {},
): Settle {
  return async (_db, _candidate, authorize) => {
    const settlement = await authorize(value);
    if (options.failAfterAuthorization) throw new Error("product rollback");
    if (settlement === null) return { status: "inactive" };
    return {
      status: "settled",
      cleanup: { requestId: value.authorizationRequestId,
        generation: settlement.recipientGeneration },
    };
  };
}

describe("protected Task running restart recovery", () => {
  test("an expired exact running claim settles and releases custody after commit", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const deleted: unknown[] = [];
    const recovery = createProtectedTaskRunningRecovery({
      db: database, repository,
      recipients: { delete: (...args) => { deleted.push(args); return true; } },
      now: () => START + 30_000,
    }, { settle: settleWith(proof()) });
    expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(true);
    expect(await repository.get(requestId)).toMatchObject({
      snapshot: { state: "terminal_failure", terminalReason: "provider_outcome_unknown",
        requestRevision: record.snapshot.requestRevision + 1 },
      finishedAt: START + 30_000,
    });
    expect(deleted).toEqual([[requestId, 0]]);
  });

  test("an abandoned renewed checkpoint segment settles its own claim without replay", async () => {
    const continuationId = `task-checkpoint-continuation:${ids.run}:2:${"b".repeat(43)}`;
    const record = runningRecord({}, continuationId);
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const deleted: unknown[] = [];
    const recovery = createProtectedTaskRunningRecovery({
      db: database, repository,
      recipients: { delete: (...args) => { deleted.push(args); return true; } },
      now: () => START + 30_000,
    }, { settle: settleWith(proof({
      authorizationRequestId: continuationId, executionSegment: 2,
    })) });
    expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(true);
    expect(await repository.get(continuationId)).toMatchObject({
      snapshot: { state: "terminal_failure", terminalReason: "provider_outcome_unknown" },
    });
    expect(await repository.get(requestId)).toBeNull();
    expect(deleted).toEqual([[continuationId, 0]]);
  });

  test("an unexpired running Job is not inferred dead", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    let deletes = 0;
    const recovery = createProtectedTaskRunningRecovery({
      db: database, repository,
      recipients: { delete: () => { deletes += 1; return true; } },
      now: () => START + 29_999,
    }, { settle: settleWith(proof()) });
    expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(false);
    expect(await repository.get(requestId)).toEqual(record);
    expect(deletes).toBe(0);
  });

  test.each(["failed", "timed_out", "cancelled"] as const)(
    "an exact terminal linked Job is sufficient without claim expiry (%s)",
    async jobStatus => {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(runningRecord());
      const recovery = createProtectedTaskRunningRecovery({
        db: database, repository, recipients: { delete: () => true },
        now: () => START + 10,
      }, { settle: settleWith(proof({ jobStatus })) });
      expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(true);
      expect(await repository.get(requestId)).toMatchObject({
        snapshot: { state: "terminal_failure", terminalReason: "provider_outcome_unknown" },
      });
    },
  );

  test("lost CAS response adopts only the exact terminal successor", async () => {
    const base = new InMemoryBackgroundAuthorizationRepository();
    await base.create(runningRecord());
    const recovery = createProtectedTaskRunningRecovery({
      db: database,
      repository: {
        get: id => base.get(id),
        compareAndSwap: async input => {
          await base.compareAndSwap(input);
          throw new Error("response lost");
        },
      },
      recipients: { delete: () => true }, now: () => START + 30_000,
    }, { settle: settleWith(proof()) });
    expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(true);
  });

  test("wrong policy, work kind, or idempotency identity cannot settle", async () => {
    for (const record of [
      runningRecord({ workKind: "task.deliver_result", purpose: "task.deliver_result" }),
      runningRecord({ idempotencyKey: "not-the-task-run-identity" }),
    ]) {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const recovery = createProtectedTaskRunningRecovery({
        db: database, repository, recipients: { delete: () => true },
        now: () => START + 30_000,
      }, { settle: settleWith(proof()) });
      expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(false);
    }
    for (const changedProof of [
      proof({ acceptedPolicyRevision: 8 }),
      proof({ contentNamespaceId: "50000000-0000-4000-8000-000000000006" }),
    ]) {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(runningRecord());
      const recovery = createProtectedTaskRunningRecovery({
        db: database, repository, recipients: { delete: () => true },
        now: () => START + 30_000,
      }, { settle: settleWith(changedProof) });
      expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(false);
    }
  });

  test("product rollback after the authorization CAS retains custody for retry", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(runningRecord());
    let deletes = 0;
    const recovery = createProtectedTaskRunningRecovery({
      db: database, repository,
      recipients: { delete: () => { deletes += 1; return true; } },
      now: () => START + 30_000,
    }, { settle: settleWith(proof(), { failAfterAuthorization: true }) });
    expect(recovery.recover({ taskId: ids.task, taskRunId: ids.run }))
      .rejects.toThrow("product rollback");
    expect(deletes).toBe(0);
    expect(await repository.get(requestId)).toMatchObject({
      snapshot: { state: "terminal_failure", terminalReason: "provider_outcome_unknown" },
    });
  });

  test("an exact prior provider-unknown terminal record completes product retry", async () => {
    const active = runningRecord();
    const terminalAt = START + 30_000;
    const terminal = parseBackgroundAuthorizationRecord({
      ...active,
      snapshot: failBackgroundAuthorizationRequest(
        active.snapshot, "provider_outcome_unknown", terminalAt,
      ),
      finishedAt: terminalAt,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3;
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(terminal);
    const recovery = createProtectedTaskRunningRecovery({
      db: database, repository, recipients: { delete: () => true },
      now: () => terminalAt + 1,
    }, { settle: settleWith(proof()) });
    expect(await recovery.recover({ taskId: ids.task, taskRunId: ids.run })).toBe(true);
  });
});
