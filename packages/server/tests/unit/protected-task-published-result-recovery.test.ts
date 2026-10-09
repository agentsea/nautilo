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
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
} from "@nautilo/runtime";

import { createProtectedTaskPublishedResultRecovery } from
  "../../src/routes/protected-task-published-result-recovery";

const START = 1_700_100_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "30000000-0000-4000-8000-000000000003";
const NAMESPACE = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
const REQUEST = `task-run-authorization:${RUN}`;
const database = Object.freeze({}) as unknown as DirectDatabase;
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
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "published-result-recipient",
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "published-result-device",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "published-result-claim",
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(claimed, START + 4),
    workIdentityHash: new Uint8Array(32).fill(9),
    idempotencyKey:
      `task-runtime-stable-v1:${RUN}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "published-result-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: "published-result-credential",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: "published-result-domain",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "published-result-domain",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function reference(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): ProtectedTaskJobReferenceV1 {
  return Object.freeze({
    kind: "protected_task_run_v1",
    taskId: TASK,
    taskRunId: record.snapshot.workId,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: record.snapshot.requestId,
    policyRevision: record.expectedPolicyRevision,
    executionSegment: 1,
  });
}

async function custody(record: BackgroundAuthorizationTaskRuntimeRecordV3) {
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

function proof(record: BackgroundAuthorizationTaskRuntimeRecordV3) {
  return Object.freeze({
    contentNamespaceId: record.snapshot.namespaceId,
    requesterHumanId: HUMAN,
  });
}

function completedRecord(
  running: BackgroundAuthorizationTaskRuntimeRecordV3,
  at: number,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    ...running,
    snapshot: completeBackgroundAuthorizationRequest(
      running.snapshot,
      at,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    finishedAt: at,
  };
}

describe("protected Task published result recovery", () => {
  test("completes an expired grant only inside mapped product proof", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    let insideProof = false;
    let casInsideProof = false;
    try {
      const recovery = createProtectedTaskPublishedResultRecovery({
        db: database,
        repository: {
          get: id => repository.get(id),
          compareAndSwap: input => {
            casInsideProof = insideProof;
            return repository.compareAndSwap(input);
          },
        },
        recipients,
        now: () => START + 120_000,
        loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
        settle: async (_db, _job, complete) => {
          insideProof = true;
          try {
            expect(recipients.size).toBe(1);
            return await complete(proof(record));
          } finally {
            insideProof = false;
          }
        },
      });

      expect(await recovery.recover(RUN)).toBe(true);
      expect(casInsideProof).toBe(true);
      expect(await repository.get(REQUEST)).toMatchObject({
        snapshot: { state: "completed" },
        finishedAt: START + 120_000,
      });
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("replays canonical completion without another crypto mutation", async () => {
    const running = runningRecord();
    const completed = completedRecord(running, START + 10);
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(completed);
    const recipients = await custody(running);
    let casCalls = 0;
    try {
      const recovery = createProtectedTaskPublishedResultRecovery({
        db: database,
        repository: {
          get: id => repository.get(id),
          compareAndSwap: input => {
            casCalls += 1;
            return repository.compareAndSwap(input);
          },
        },
        recipients,
        loadJob: async () => ({ jobId: JOB, reference: reference(running) }),
        settle: async (_db, _job, complete) => complete(proof(running)),
      });

      expect(await recovery.recover(RUN)).toBe(true);
      expect(casCalls).toBe(0);
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("accepts a lost completion response and an exact concurrent winner", async () => {
    for (const outcome of ["lost_response", "concurrent_winner"] as const) {
      const record = runningRecord();
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const recipients = await custody(record);
      try {
        const recovery = createProtectedTaskPublishedResultRecovery({
          db: database,
          repository: {
            get: id => repository.get(id),
            compareAndSwap: async input => {
              if (outcome === "lost_response") {
                expect(await repository.compareAndSwap(input))
                  .toMatchObject({ status: "updated" });
                throw new Error("completion response lost");
              }
              const current = await repository.get(REQUEST);
              if (current === null) throw new Error("running grant missing");
              const winner = completedRecord(
                current as BackgroundAuthorizationTaskRuntimeRecordV3,
                current.snapshot.updatedAt + 1,
              );
              expect(await repository.compareAndSwap({
                expectedRequestRevision: current.snapshot.requestRevision,
                next: winner,
              })).toMatchObject({ status: "updated" });
              return repository.compareAndSwap(input);
            },
          },
          recipients,
          loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
          settle: async (_db, _job, complete) => complete(proof(record)),
        });

        expect(await recovery.recover(RUN)).toBe(true);
        expect((await repository.get(REQUEST))?.snapshot.state)
          .toBe("completed");
        expect(recipients.size).toBe(0);
      } finally {
        recipients.close();
      }
    }
  });

  test("rejects substituted proof, reference, revision, and lifecycle state", async () => {
    const scenarios = [
      "issuer",
      "namespace",
      "reference",
      "revision",
      "superseded",
    ] as const;
    for (const scenario of scenarios) {
      const running = runningRecord();
      const record = scenario === "superseded"
        ? {
            ...running,
            snapshot: cancelBackgroundAuthorizationRequest(
              running.snapshot,
              "superseded",
              START + 10,
            ),
            finishedAt: START + 10,
          } as BackgroundAuthorizationTaskRuntimeRecordV3
        : running;
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const recipients = await custody(running);
      const expectedReference = reference(running);
      const currentReference = scenario === "reference"
        ? { ...expectedReference, authorizationRequestId: "other-request" }
        : scenario === "revision"
          ? { ...expectedReference, policyRevision: 6 }
          : expectedReference;
      const currentProof = scenario === "issuer"
        ? { ...proof(running), requesterHumanId: "other-human" }
        : scenario === "namespace"
          ? { ...proof(running), contentNamespaceId: "other-namespace" }
          : proof(running);
      let casCalls = 0;
      try {
        const recovery = createProtectedTaskPublishedResultRecovery({
          db: database,
          repository: {
            get: id => repository.get(id),
            compareAndSwap: input => {
              casCalls += 1;
              return repository.compareAndSwap(input);
            },
          },
          recipients,
          loadJob: async () => ({
            jobId: JOB,
            reference: currentReference,
          }),
          settle: async (_db, _job, complete) => complete(currentProof),
        });

        expect(await recovery.recover(RUN)).toBe(false);
        expect(casCalls).toBe(0);
        expect(await repository.get(REQUEST)).toEqual(record);
        expect(recipients.size).toBe(1);
      } finally {
        recipients.close();
      }
    }
  });

  test("keeps custody on proof rejection and safely retries a split commit", async () => {
    for (const outcome of ["false", "throw_after_crypto"] as const) {
      const record = runningRecord();
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const recipients = await custody(record);
      let attempts = 0;
      try {
        const recovery = createProtectedTaskPublishedResultRecovery({
          db: database,
          repository,
          recipients,
          now: () => START + 10,
          loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
          settle: async (_db, _job, complete) => {
            attempts += 1;
            if (outcome === "false") return false;
            const completed = await complete(proof(record));
            if (attempts === 1) throw new Error("product settlement rolled back");
            return completed;
          },
        });

        if (outcome === "false") {
          expect(await recovery.recover(RUN)).toBe(false);
          expect(await repository.get(REQUEST)).toEqual(record);
        } else {
          const failure = await recovery.recover(RUN).catch(
            (error: unknown) => error,
          );
          expect(failure).toMatchObject({
            message: "product settlement rolled back",
          });
          expect((await repository.get(REQUEST))?.snapshot.state)
            .toBe("completed");
          expect(recipients.size).toBe(1);
          expect(await recovery.recover(RUN)).toBe(true);
          expect(attempts).toBe(2);
        }
        expect(recipients.size).toBe(outcome === "false" ? 1 : 0);
      } finally {
        recipients.close();
      }
    }
  });

  test("maps an exact unmapped result before using the existing settlement", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    const calls: string[] = [];
    try {
      const recovery = createProtectedTaskPublishedResultRecovery({
        db: database,
        repository,
        recipients,
        loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
        settle: async (_db, _job, complete) => {
          calls.push("settle");
          return calls.length === 1 ? false : complete(proof(record));
        },
        recoverUnmapped: async () => {
          calls.push("unmapped");
          return "mapped";
        },
      });

      expect(await recovery.recover(RUN)).toBe(true);
      expect(calls).toEqual(["settle", "unmapped", "settle"]);
      expect((await repository.get(REQUEST))?.snapshot.state)
        .toBe("completed");
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("reports pending and quarantined unmapped results without false mapping", async () => {
    for (const outcome of ["pending", "quarantined"] as const) {
      const record = runningRecord();
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const recipients = await custody(record);
      let settleCalls = 0;
      try {
        const recovery = createProtectedTaskPublishedResultRecovery({
          db: database,
          repository,
          recipients,
          loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
          settle: async () => {
            settleCalls += 1;
            return false;
          },
          recoverUnmapped: async () => outcome,
        });

        expect(await recovery.recover(RUN)).toBe(outcome === "quarantined");
        expect(settleCalls).toBe(1);
        expect((await repository.get(REQUEST))?.snapshot.state)
          .toBe("running");
        expect(recipients.size).toBe(1);
      } finally {
        recipients.close();
      }
    }
  });

  test("adopts an exact mapping after the recovery response is lost", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    let settleCalls = 0;
    try {
      const recovery = createProtectedTaskPublishedResultRecovery({
        db: database,
        repository,
        recipients,
        loadJob: async () => ({ jobId: JOB, reference: reference(record) }),
        settle: async (_db, _job, complete) => {
          settleCalls += 1;
          return settleCalls === 1 ? false : complete(proof(record));
        },
        recoverUnmapped: async () => {
          throw new Error("mapping response lost");
        },
      });

      expect(await recovery.recover(RUN)).toBe(true);
      expect(settleCalls).toBe(2);
      expect((await repository.get(REQUEST))?.snapshot.state)
        .toBe("completed");
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });

  test("isolates page failures and unavailable rows without starving later work", async () => {
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const recipients = await custody(record);
    const acceptedAt = new Date(START);
    const rows = [
      { taskRunId: "60000000-0000-4000-8000-000000000006", acceptedAt },
      { taskRunId: "70000000-0000-4000-8000-000000000007", acceptedAt },
      { taskRunId: RUN, acceptedAt },
    ];
    try {
      const recovery = createProtectedTaskPublishedResultRecovery({
        db: database,
        repository,
        recipients,
        list: async () => rows as never,
        loadJob: async taskRunId => {
          if (taskRunId === rows[0]!.taskRunId) {
            throw new Error("transient Job lookup failure");
          }
          return taskRunId === RUN
            ? { jobId: JOB, reference: reference(record) }
            : null;
        },
        settle: async (_db, _job, complete) => complete(proof(record)),
      });

      expect(await recovery.recoverPage({ limit: 3 })).toEqual({
        attempted: 3,
        settled: 1,
        failures: 1,
        next: { acceptedAt, taskRunId: RUN },
      });
      expect(recipients.size).toBe(0);
    } finally {
      recipients.close();
    }
  });
});
