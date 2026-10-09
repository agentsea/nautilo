import { createHash } from "node:crypto";

import { expect, test } from "bun:test";
import type {
  StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "@nautilo/db";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

import {
  createProtectedTaskParkedPreexecutionRecovery,
} from "../../src/routes/protected-task-parked-preexecution-recovery";

const NOW = 1_900_000_000_000;
const RUN = "50000000-0000-4000-8000-000000000005";
const REQUEST = "task-run-authorization:v2:parked-recovery";
const CLAIM = "parked-recovery-claim";

function claimedRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const descriptorDigest = createHash("sha256")
    .update(descriptorBytes)
    .digest("hex");
  const recipientPublicKey = Buffer.from(new Uint8Array(65).fill(4))
    .toString("base64url");
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: REQUEST,
    workId: RUN,
    namespaceId: "70000000-0000-4000-8000-000000000007",
    now: NOW,
  });
  const awaitingDevice = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    descriptorDigest,
    recipientKeyId: "parked-recovery-recipient",
    recipientPublicKey,
    expiresAt: NOW + 60_000,
    now: NOW + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(awaitingDevice, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "parked-recovery-recipient",
    recipientPublicKey,
    expiresAt: NOW + 60_000,
    responseDigest: createHash("sha256")
      .update(new Uint8Array([4, 5, 6]))
      .digest("hex"),
    credentialDigest: "33".repeat(32),
    issuingHumanId: "parked-recovery-human",
    issuingDeviceId: "parked-recovery-device",
    recipientGeneration: 0,
    now: NOW + 2,
  });
  return {
    snapshot: claimBackgroundAuthorizationRequest(
      ready,
      CLAIM,
      NOW + 3,
      NOW + 30_000,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    workIdentityHash: new Uint8Array(32).fill(5),
    idempotencyKey:
      `task-runtime-stable-v1:${RUN}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "parked-recovery-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 2,
    expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: 7,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes: new Uint8Array([4, 5, 6]),
      credentialId: "parked-recovery-authorization",
      issuingDeviceAuthorizationRevision: 3,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(6),
      authorizationExpiresAt: NOW + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: initial.namespaceId,
        domainId: "parked-recovery-domain",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 7,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "parked-recovery-domain",
        expectedEpoch: 2,
        expectedAuthorizationRevision: 3,
      }],
    },
  };
}

function startInput(): StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput {
  return {
    taskRunId: RUN,
    contentNamespaceId: "70000000-0000-4000-8000-000000000007",
    jobReference: {
      authorizationRequestId: REQUEST,
      policyRevision: 7,
    },
  } as unknown as StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
}

test("defers authority only after the product owner durably cancels the Job", async () => {
  const expected = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  expect((await repository.create(expected)).status).toBe("created");
  let durableCancellation = false;
  let deferralSawCancellation = false;
  const recover = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never,
    repository: {
      get: requestId => repository.get(requestId),
      deferUnstartedTaskRuntimeRequest: input => {
        deferralSawCancellation = durableCancellation;
        return repository.deferUnstartedTaskRuntimeRequest(input);
      },
    },
    now: () => NOW + 5,
  }, async (_db, _start, _recoveredAt, defer) => {
    durableCancellation = true;
    return await defer()
      ? { status: "recovered" as const }
      : { status: "stale" as const };
  });

  expect(await recover(startInput(), expected)).toBe(true);
  expect(deferralSawCancellation).toBe(true);
  expect((await repository.get(REQUEST))?.snapshot).toMatchObject({
    state: "awaiting_recipient",
    recipientGeneration: 1,
    lastRetryReason: "stale_authority",
  });
});

test("accepts only the exact claimed or running record and its deferred successor", async () => {
  for (const state of ["claimed", "running", "deferred"] as const) {
    const expected = claimedRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const current = state === "running"
      ? { ...expected, snapshot: markBackgroundAuthorizationRunning(
          expected.snapshot,
          NOW + 4,
        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] }
      : expected;
    expect((await repository.create(current)).status).toBe("created");
    if (state === "deferred") {
      expect((await repository.deferUnstartedTaskRuntimeRequest({
        expected: current,
        now: NOW + 5,
      })).status).toBe("deferred");
    }
    const recover = createProtectedTaskParkedPreexecutionRecovery({
      db: {} as never,
      repository,
      now: () => NOW + 5,
    }, async (_db, _start, _recoveredAt, defer) => await defer()
      ? { status: "exact_replay" as const }
      : { status: "stale" as const });
    expect(await recover(startInput(), expected)).toBe(true);
  }

  const expected = claimedRecord();
  const substituted = { ...expected,
    idempotencyKey: `task-runtime-stable-v1:${RUN}:${"b".repeat(43)}` };
  const repository = new InMemoryBackgroundAuthorizationRepository();
  expect((await repository.create(substituted)).status).toBe("created");
  const recover = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never,
    repository,
    now: () => NOW + 5,
  }, async (_db, _start, _recoveredAt, defer) => await defer()
    ? { status: "recovered" as const }
    : { status: "stale" as const });
  expect(await recover(startInput(), expected)).toBe(false);
});

test("suppresses execution when the product reset remains stale", async () => {
  const expected = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  expect((await repository.create(expected)).status).toBe("created");
  let deferred = false;
  const recover = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never,
    repository,
    now: () => NOW + 5,
  }, async (_db, _start, _recoveredAt, defer) => {
    deferred = await defer();
    return { status: "stale" as const };
  });

  expect(await recover(startInput(), expected)).toBe(false);
  expect(deferred).toBe(true);
});


test("restart recovery waits for a live claim and then defers an expired exact request", async () => {
  const claimed = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimed);
  let clock = NOW + 10;
  let cancellations = 0;
  const recovery = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never, repository, now: () => clock,
  }, async (_db, _start, _time, defer) => {
    cancellations += 1;
    return await defer() ? { status: "recovered" as const } : { status: "cancelled" as const };
  });
  expect(await recovery.recoverDiscovered(startInput(), { immediate: false }))
    .toEqual({ cancelled: false, reset: false, failed: false });
  expect(cancellations).toBe(0);
  clock = NOW + 60_001;
  expect(await recovery.recoverDiscovered(startInput(), { immediate: false }))
    .toEqual({ cancelled: true, reset: true, failed: false });
  expect(cancellations).toBe(1);
  const deferred = await repository.get(REQUEST);
  expect(deferred?.snapshot.state).toBe("awaiting_recipient");
  expect(await recovery.recoverDiscovered(startInput(), { immediate: true }))
    .toEqual({ cancelled: true, reset: true, failed: false });
  expect((await repository.get(REQUEST))?.snapshot.requestRevision)
    .toBe(deferred?.snapshot.requestRevision);
});

test("restart recovery preserves cancellation when authorization settlement must retry", async () => {
  const claimed = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimed);
  const recovery = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never, repository, now: () => NOW + 60_001,
  }, () => Promise.resolve({ status: "cancelled" }));
  expect(await recovery.recoverDiscovered(startInput(), { immediate: false }))
    .toEqual({ cancelled: true, reset: false, failed: true });
});

function parkedClaimProof() {
  const expected = {
    occurrence: {
      task: { id: "parked-task", contentNamespaceId: "parked-namespace", cryptoObjectId: "input",
        cryptoRequiredNamespaceFingerprint: new Uint8Array(32) },
      run: { id: RUN, jobId: "prior-job", startedAt: new Date(NOW) },
    },
    authorizationRequestId: REQUEST,
    priorJob: { reference: { resultObjectId: "result" } },
    nextExecutionSegment: 2,
    continuationFingerprint: "fingerprint",
  } as unknown as import("@nautilo/db").ParkedProtectedTaskAdditionalAuthority;
  return { expected, jobReference: {
    kind: "protected_task_run_v1" as const,
    taskId: expected.occurrence.task.id, taskRunId: RUN,
    inputObjectId: "input", resultObjectId: "result",
    authorizationRequestId: REQUEST, policyRevision: 7, executionSegment: 2,
    resumeContinuationFingerprint: "fingerprint",
  } };
}

test("claim recovery needs no returned Job id and retains execution retries", async () => {
  const claimed = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimed);
  const proof = parkedClaimProof();
  let absenceProven = false;
  const recovery = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never,
    repository: {
      get: id => repository.get(id),
      deferUnstartedTaskRuntimeRequest: value => {
        expect(absenceProven).toBe(true);
        return repository.deferUnstartedTaskRuntimeRequest(value);
      },
    },
    now: () => NOW + 10,
  }, undefined, {
    recoverClaim: async (_db, selected, _at, defer) => {
      expect(selected).toEqual(proof);
      absenceProven = true;
      return await defer() ? { status: "recovered" } : { status: "stale" };
    },
  });
  expect(await recovery.recoverClaim(proof, claimed)).toBe(true);
  expect((await repository.get(REQUEST))?.snapshot).toMatchObject({
    state: "awaiting_recipient", recipientGeneration: 1,
    retryCount: claimed.snapshot.retryCount,
  });
  expect(await recovery.recoverClaim(proof, claimed)).toBe(true);
  expect((await repository.get(REQUEST))?.snapshot.recipientGeneration).toBe(1);
});

test("claim recovery cannot defer when the DB finds execution or changed product proof", async () => {
  const claimed = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimed);
  const recovery = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never, repository, now: () => NOW + 60_001,
  }, undefined, { recoverClaim: async () => ({ status: "stale" }) });
  expect(await recovery.recoverClaim(parkedClaimProof(), claimed)).toBe(false);
  expect((await repository.get(REQUEST))?.snapshot.state).toBe("claimed");
});


test("observer recovers an expired no-Job claim without device or content authority", async () => {
  const claimed = claimedRecord();
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(claimed);
  const proof = parkedClaimProof();
  let now = NOW + 10;
  let proofs = 0;
  const recovery = createProtectedTaskParkedPreexecutionRecovery({
    db: {} as never, repository, now: () => now,
  }, undefined, {
    discover: async () => proof.expected,
    recoverClaim: async (_db, actual, _at, defer) => {
      expect(actual).toEqual(proof);
      proofs += 1;
      return await defer() ? { status: "recovered" } : { status: "stale" };
    },
  });
  expect(await recovery.recoverExpiredClaim(proof.expected.occurrence)).toBe(false);
  expect(proofs).toBe(0);
  now = NOW + 30_000;
  expect(await recovery.recoverExpiredClaim(proof.expected.occurrence)).toBe(true);
  expect(proofs).toBe(1);
  expect((await repository.get(REQUEST))?.snapshot.state).toBe("awaiting_recipient");
  expect(await recovery.recoverExpiredClaim(proof.expected.occurrence)).toBe(false);
  expect(proofs).toBe(1);
});
