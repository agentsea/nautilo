import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  ExactProtectedTaskRunResultPublicationProof,
  PostgresJsBridgeConnection,
  ProtectedTaskRunResultPublicationTransaction,
} from "@nautilo/db";
import {
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  ConversationProductCanonicalTransactionRunner,
  CryptoPostgresHandle,
  PostgresTaskRunResultRecoveryInput,
} from "@nautilo/lattice-bridge/server";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
} from "@nautilo/runtime";

import {
  createProtectedTaskUnmappedResultRecovery,
  settleProtectedTaskUnmappedResultIntegrityFailure,
} from "../../src/routes/protected-task-unmapped-result-recovery";

const START = 1_700_200_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "30000000-0000-4000-8000-000000000003";
const NAMESPACE = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
const USER = "60000000-0000-4000-8000-000000000006";
const AGENT = "70000000-0000-4000-8000-000000000007";
const ROOM = "80000000-0000-4000-8000-000000000008";
const LEASE = "90000000-0000-4000-8000-000000000009";
const REQUEST = `task-run-authorization:${RUN}`;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: REQUEST,
    workId: RUN,
    namespaceId: NAMESPACE,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "unmapped-result-recipient",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "unmapped-result-recipient",
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "unmapped-result-device",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "unmapped-result-claim",
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(
      claimed,
      START + 4,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    workIdentityHash: new Uint8Array(32).fill(9),
    idempotencyKey: `task-runtime-stable-v1:${RUN}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "unmapped-result-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: "unmapped-result-credential",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: "unmapped-result-domain",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "unmapped-result-domain",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  };
}

function reference(): ProtectedTaskJobReferenceV1 {
  return Object.freeze({
    kind: "protected_task_run_v1",
    taskId: TASK,
    taskRunId: RUN,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: REQUEST,
    policyRevision: 5,
    executionSegment: 1,
  });
}

function proof(
  jobStatus: "running" | "failed" | "completed" = "running",
): ExactProtectedTaskRunResultPublicationProof {
  return {
    phase: "unmapped",
    reference: reference(),
    task: { id: TASK, requestorId: USER },
    run: {
      id: RUN,
      outcome: "completed",
      completedAt: new Date(START + 6),
    },
    job: {
      id: JOB,
      status: jobStatus,
      startedAt: new Date(START + 4),
      completedAt: jobStatus === "running" ? null : new Date(START + 7),
    },
    binding: {
      bindingId: `task-run-output:${RUN}`,
      deliveryMode: "none",
      resultAttachedAt: null,
      completedAt: null,
    },
    lifecycle: {
      sequence: 1,
      operationId: `task-run-result:${RUN}`,
      authorityFingerprint: new Uint8Array(32).fill(2),
      requesterHumanId: HUMAN,
      contentNamespaceId: NAMESPACE,
      cryptoObjectId: reference().resultObjectId,
      representation: "protected",
      requiredNamespaceFingerprint: new Uint8Array(32).fill(3),
      attemptCount: 4,
      leaseToken: LEASE,
      cryptoCompletedAt: null,
    },
  };
}

function productTransaction(updates: unknown[]) {
  return {
    update: () => ({
      set: (value: unknown) => {
        updates.push(value);
        return {
          where: () => ({
            returning: async () => [{ id: JOB }],
          }),
        };
      },
    }),
  } as unknown as ProtectedTaskRunResultPublicationTransaction;
}

describe("protected Task unmapped result recovery", () => {
  test("fails the exact grant and running Job, including a lost CAS response", async () => {
    for (const lostResponse of [false, true]) {
      const running = runningRecord();
      const stored = new InMemoryBackgroundAuthorizationRepository();
      await stored.create(running);
      const updates: unknown[] = [];
      const settled = await settleProtectedTaskUnmappedResultIntegrityFailure({
        transaction: productTransaction(updates),
        proof: proof(),
        repository: {
          get: id => stored.get(id),
          compareAndSwap: async input => {
            const result = await stored.compareAndSwap(input);
            if (lostResponse) throw new Error("lost integrity CAS response");
            return result;
          },
        },
        now: () => START + 10,
      });

      expect(settled).toMatchObject({
        snapshot: {
          state: "terminal_failure",
          terminalReason: "integrity_failure",
        },
        finishedAt: START + 10,
      });
      expect(updates).toEqual([{
        status: "failed",
        completedAt: new Date(START + 10),
      }]);
    }
  });

  test("adopts only an exact prior integrity failure", async () => {
    const running = runningRecord();
    const failedAt = START + 10;
    const exact = {
      ...running,
      snapshot: failBackgroundAuthorizationRequest(
        running.snapshot,
        "integrity_failure",
        failedAt,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: failedAt,
    };
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(exact);
    const updates: unknown[] = [];

    expect(await settleProtectedTaskUnmappedResultIntegrityFailure({
      transaction: productTransaction(updates),
      proof: proof(),
      repository,
      now: () => START + 20,
    })).toEqual(exact);
    expect(updates).toHaveLength(1);

    const substituted = {
      ...exact,
      domainId: "substituted-domain",
    };
    const rejectedUpdates: unknown[] = [];
    expect(await settleProtectedTaskUnmappedResultIntegrityFailure({
      transaction: productTransaction(rejectedUpdates),
      proof: proof(),
      repository: {
        get: async () => running,
        compareAndSwap: async () => ({
          status: "stale" as const,
          current: substituted,
        }),
      },
      now: () => START + 20,
    })).toBeNull();
    expect(rejectedUpdates).toEqual([]);
  });

  test("does not rewrite a completed Job or mutate its grant", async () => {
    const running = runningRecord();
    let repositoryCalls = 0;
    expect(await settleProtectedTaskUnmappedResultIntegrityFailure({
      transaction: productTransaction([]),
      proof: proof("completed"),
      repository: {
        get: async () => {
          repositoryCalls += 1;
          return running;
        },
        compareAndSwap: async () => {
          repositoryCalls += 1;
          throw new Error("unexpected CAS");
        },
      },
      now: () => START + 20,
    })).toBeNull();
    expect(repositoryCalls).toBe(0);
  });

  test("constructs exact held authority coordinates and verifies outside product locks", async () => {
    const seen: PostgresTaskRunResultRecoveryInput[] = [];
    const recovery = createProtectedTaskUnmappedResultRecovery({
      db: Object.freeze({}) as DirectDatabase,
      restricted: Object.freeze({}) as PostgresJsBridgeConnection,
      crypto: new LatticeCrypto(),
      cryptoHandle: Object.freeze({}) as CryptoPostgresHandle,
      serverScope: "https://server.example",
      recipients: { delete: () => false },
    }, {
      loadCoordinates: async () => ({
        taskId: TASK,
        taskRunId: RUN,
        requesterUserId: USER,
        requesterHumanId: HUMAN,
        agentId: AGENT,
        contentNamespaceId: NAMESPACE,
      }),
      resolveRequesterPrivateRoom: async () => ({
        roomId: ROOM,
        namespaceId: NAMESPACE,
      }),
      createProductContext: async () => ({
        canonicalRunner: Object.freeze({}) as
          ConversationProductCanonicalTransactionRunner,
      }),
      createLeaseToken: () => LEASE,
      verify: async () => null,
      createGrantRepository: async () =>
        new InMemoryBackgroundAuthorizationRepository(),
      reconcile: async input => {
        seen.push(input);
        return "mapped";
      },
    });

    expect(await recovery.recover({ jobId: JOB, reference: reference() }))
      .toBe("mapped");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      authority: {
        taskId: TASK,
        requesterUserId: USER,
        requesterHumanId: HUMAN,
        agentId: AGENT,
        contentNamespaceId: NAMESPACE,
        sourceRoomId: ROOM,
        expectedPolicyRevision: 5,
      },
      publication: { jobId: JOB },
      leaseToken: LEASE,
    });
  });

  test("releases recipient custody only after quarantine commits", async () => {
    const running = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(running);
    const deleted: Array<[string, number]> = [];
    const updates: unknown[] = [];
    const recovery = createProtectedTaskUnmappedResultRecovery({
      db: Object.freeze({}) as DirectDatabase,
      restricted: Object.freeze({}) as PostgresJsBridgeConnection,
      crypto: new LatticeCrypto(),
      cryptoHandle: Object.freeze({}) as CryptoPostgresHandle,
      serverScope: "https://server.example",
      recipients: {
        delete: (requestId, generation) => {
          deleted.push([requestId, generation]);
          return true;
        },
      },
      // Recovery is independent of the expired live device/grant window; the
      // durable manifest verifier owns historical signer resolution.
      now: () => START + 120_000,
    }, {
      loadCoordinates: async () => ({
        taskId: TASK,
        taskRunId: RUN,
        requesterUserId: USER,
        requesterHumanId: HUMAN,
        agentId: AGENT,
        contentNamespaceId: NAMESPACE,
      }),
      resolveRequesterPrivateRoom: async () => ({ roomId: ROOM,
        namespaceId: NAMESPACE }),
      createProductContext: async () => ({
        canonicalRunner: Object.freeze({}) as
          ConversationProductCanonicalTransactionRunner,
      }),
      createLeaseToken: () => LEASE,
      verify: async () => null,
      createGrantRepository: async () => repository,
      reconcile: async input => {
        expect(deleted).toEqual([]);
        const settled = await input.settleIntegrityFailure(
          productTransaction(updates),
          proof(),
          Object.freeze({}) as PostgresJsBridgeConnection,
        );
        expect(settled).toBe(true);
        expect(deleted).toEqual([]);
        return "quarantined";
      },
    });

    expect(await recovery.recover({ jobId: JOB, reference: reference() }))
      .toBe("quarantined");
    expect(deleted).toEqual([[REQUEST, 0]]);
  });
});
