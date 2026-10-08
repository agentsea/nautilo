import { describe, expect, test } from "bun:test";

import type {
  DirectDatabase,
  ProtectedTaskPreexecutionRecoveryCursor,
  StartProtectedTaskRunInput,
} from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

import { createProtectedTaskPreexecutionRecovery } from
  "../../src/routes/protected-task-preexecution-recovery";

const START = 1_700_000_000_000;
const database = Object.freeze({}) as unknown as DirectDatabase;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function startInput(suffix = "a"): StartProtectedTaskRunInput {
  const ordinal = [...suffix].reduce((value, character) =>
    (value + character.codePointAt(0)!) % 0xffff_ffff, 0);
  const tail = ordinal.toString(16).padStart(12, "0");
  const taskId = `10000000-0000-4000-8000-${tail}`;
  const taskRunId = `20000000-0000-4000-8000-${tail}`;
  const inputObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "definition",
    taskId,
    contentRevision: 1,
  });
  return {
    taskId,
    taskRunId,
    graphThreadId: `thread-${suffix}`,
    jobId: `30000000-0000-4000-8000-${tail}`,
    contentRepresentation: "protected",
    contentNamespaceId: `namespace-${suffix}`,
    contentRevision: 1,
    cryptoObjectId: inputObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(9),
    jobReference: {
      kind: "protected_task_run_v1",
      taskId,
      taskRunId,
      inputObjectId,
      resultObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId,
        taskRunId,
        contentRevision: 1,
      }),
      authorizationRequestId: `authorization-${suffix}`,
      policyRevision: 5,
      executionSegment: 1,
    },
  };
}

function runningRecord(
  input: StartProtectedTaskRunInput,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorDigest = "ab".repeat(32);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: input.jobReference.authorizationRequestId,
    workId: input.taskRunId,
    namespaceId: input.contentNamespaceId,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "recipient-key",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 2_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: waiting.requestId,
    descriptorDigest,
    recipientKeyId: "recipient-key",
    recipientPublicKey: publicKey,
    expiresAt: START + 2_000,
    responseDigest: "bc".repeat(32),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: "human-a",
    issuingDeviceId: "device-a",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "claim-a",
    START + 3,
    START + 1_500,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(
      claimed,
      START + 4,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey:
      `task-runtime-stable-v1:${input.taskRunId}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "domain-a",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: input.jobReference.policyRevision,
    descriptorBytes: new Uint8Array([1, 2, 3]),
    acceptedMaterial: {
      responseBytes: new Uint8Array([4, 5, 6]),
      credentialId: "credential-a",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 2_500,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: input.contentNamespaceId,
        domainId: "domain-a",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: input.jobReference.policyRevision,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "domain-a",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  };
}

function deferredRecord(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  now: number,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      recipientGeneration: record.snapshot.recipientGeneration + 1,
      requestRevision: record.snapshot.requestRevision + 1,
      descriptorDigest: null,
      recipient: null,
      acceptedResponse: null,
      state: "awaiting_recipient",
      claimId: null,
      claimExpiresAt: null,
      lastRetryReason: "stale_authority",
      nextAttemptAt: now,
      updatedAt: now,
    } as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes: null,
    acceptedMaterial: null,
  };
}

function harness(options?: Readonly<{
  input?: StartProtectedTaskRunInput;
  current?: BackgroundAuthorizationRecord | null;
  now?: number;
  cancellations?: Array<"cancelled" | "exact_replay" | "ineligible">;
  failAfterAuthorization?: boolean;
  currentAfterCancel?: BackgroundAuthorizationRecord;
}>) {
  const start = options?.input ?? startInput();
  let current = options?.current === undefined
    ? runningRecord(start)
    : options.current;
  let now = options?.now ?? START + 1_000;
  const cancellations = options?.cancellations ?? ["cancelled"];
  let cancelCalls = 0;
  let resetCalls = 0;
  let deferCalls = 0;
  const recovery = createProtectedTaskPreexecutionRecovery({
    db: database,
    now: () => now,
    repository: {
      get: async requestId => current?.snapshot.requestId === requestId
        ? current
        : null,
      deferUnstartedTaskRuntimeRequest: async ({ expected, now: at }) => {
        deferCalls += 1;
        if (current !== expected) return { status: "stale", current };
        const next = deferredRecord(expected, at);
        current = next;
        return { status: "deferred", record: next };
      },
    },
    dependencies: {
      cancel: async () => {
        const result = cancellations[cancelCalls] ?? "ineligible";
        cancelCalls += 1;
        if (result !== "ineligible" && options?.currentAfterCancel !== undefined) {
          current = options.currentAfterCancel;
        }
        return result;
      },
      reset: async (_db, _input, deferAuthorization) => {
        resetCalls += 1;
        if (!await deferAuthorization()) return { status: "stale" };
        if (options?.failAfterAuthorization) {
          throw new Error("product reset interrupted");
        }
        return { status: resetCalls === 1 ? "deferred" : "exact_replay" };
      },
    },
  });
  return {
    start,
    recovery,
    current: () => current,
    setNow(value: number) {
      now = value;
    },
    counts: () => ({ cancelCalls, resetCalls, deferCalls }),
  };
}

describe("protected Task pre-execution recovery", () => {
  test("leaves a queued live grant untouched and defers it after the first expiry", async () => {
    const value = harness();
    expect(await value.recovery.recover(value.start, {
      immediate: false,
    })).toBe(false);
    expect(value.counts()).toEqual({
      cancelCalls: 0,
      resetCalls: 0,
      deferCalls: 0,
    });

    value.setNow(START + 1_500);
    expect(await value.recovery.recover(value.start, {
      immediate: false,
    })).toBe(true);
    expect(value.counts()).toEqual({
      cancelCalls: 1,
      resetCalls: 1,
      deferCalls: 1,
    });
    expect(value.current()).toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        lastRetryReason: "stale_authority",
        nextAttemptAt: START + 1_500,
        recipient: null,
        acceptedResponse: null,
      },
      descriptorBytes: null,
      acceptedMaterial: null,
    });
  });

  test("requires the exact unstarted Job cancellation proof", async () => {
    const value = harness({
      now: START + 3_000,
      cancellations: ["ineligible"],
    });
    expect(await value.recovery.recover(value.start, {
      immediate: false,
    })).toBe(false);
    expect(value.counts()).toEqual({
      cancelCalls: 1,
      resetCalls: 0,
      deferCalls: 0,
    });
  });

  test("treats the earliest claim, recipient, or authorization expiry as inactive", async () => {
    const start = startInput();
    const initial = runningRecord(start);
    const variants: BackgroundAuthorizationTaskRuntimeRecordV3[] = [
      {
        ...initial,
        snapshot: {
          ...initial.snapshot,
          claimExpiresAt: START + 5_000,
          recipient: {
            ...initial.snapshot.recipient!,
            expiresAt: START + 1_500,
          },
        },
        acceptedMaterial: {
          ...initial.acceptedMaterial!,
          authorizationExpiresAt: START + 5_000,
        },
      },
      {
        ...initial,
        snapshot: {
          ...initial.snapshot,
          claimExpiresAt: START + 5_000,
          recipient: {
            ...initial.snapshot.recipient!,
            expiresAt: START + 5_000,
          },
        },
        acceptedMaterial: {
          ...initial.acceptedMaterial!,
          authorizationExpiresAt: START + 1_500,
        },
      },
    ];
    for (const current of variants) {
      const value = harness({
        input: start,
        current,
        now: START + 1_500,
      });
      expect(await value.recovery.recover(start, { immediate: false })).toBe(true);
      expect(value.counts().cancelCalls).toBe(1);
    }
  });

  test("immediately defers an active grant after a locally proven cancellation", async () => {
    const value = harness({ cancellations: ["exact_replay"] });
    expect(await value.recovery.recover(value.start, {
      immediate: true,
    })).toBe(true);
    expect(value.counts()).toEqual({
      cancelCalls: 1,
      resetCalls: 1,
      deferCalls: 1,
    });
  });

  test("finishes the product reset after an interrupted crypto-first commit", async () => {
    const first = harness({
      cancellations: ["cancelled", "exact_replay"],
      failAfterAuthorization: true,
    });
    expect(await first.recovery.recover(first.start, {
      immediate: true,
    })).toBe(true);
    expect(first.current()?.snapshot.state).toBe("awaiting_recipient");
    expect(first.counts().deferCalls).toBe(1);

    const restart = harness({
      input: first.start,
      current: first.current(),
      cancellations: ["exact_replay"],
    });
    expect(await restart.recovery.recover(restart.start, {
      immediate: false,
    })).toBe(true);
    expect(restart.counts()).toEqual({
      cancelCalls: 1,
      resetCalls: 1,
      deferCalls: 0,
    });
  });

  test("does not reset the run around a newer authorization record", async () => {
    const start = startInput();
    const current = runningRecord(start);
    const newer: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...current,
      snapshot: {
        ...current.snapshot,
        requestRevision: current.snapshot.requestRevision + 1,
        claimId: "replacement-claim",
      },
    };
    const value = harness({
      input: start,
      current,
      currentAfterCancel: newer,
    });
    expect(await value.recovery.recover(start, { immediate: true })).toBe(true);
    expect(value.current()).toBe(newer);
    expect(value.counts()).toEqual({
      cancelCalls: 1,
      resetCalls: 1,
      deferCalls: 1,
    });
  });

  test("rejects missing, terminal, published, or substituted authority before mutation", async () => {
    const start = startInput();
    const current = runningRecord(start);
    const variants: Array<BackgroundAuthorizationRecord | null> = [
      null,
      {
        ...current,
        snapshot: { ...current.snapshot, namespaceId: "other-namespace" },
      },
      {
        ...current,
        snapshot: { ...current.snapshot, requestId: "other-request" },
      },
      { ...current, workKind: "task.dispatch", purpose: "task.dispatch" },
      {
        ...current,
        snapshot: {
          ...current.snapshot,
          credentialSubject: {
            kind: "runtime",
            runtimeKind: "agent",
            runtimeVersion: 1,
          },
        } as unknown as BackgroundAuthorizationRecord["snapshot"],
      },
      {
        ...current,
        snapshot: { ...current.snapshot, state: "terminal_failure" },
        finishedAt: START + 10,
      },
      {
        ...current,
        snapshot: { ...current.snapshot, state: "publication_reconciliation" },
      },
    ];
    for (const variant of variants) {
      const value = harness({ input: start, current: variant });
      expect(await value.recovery.recover(start, { immediate: true })).toBe(false);
      expect(value.counts()).toEqual({
        cancelCalls: 0,
        resetCalls: 0,
        deferCalls: 0,
      });
    }
  });

  test("continues a page after a candidate failure and preserves the raw continuation", async () => {
    const broken = startInput("broken");
    const valid = startInput("valid");
    let current: BackgroundAuthorizationRecord | null = runningRecord(valid);
    const through: ProtectedTaskPreexecutionRecoveryCursor = {
      createdAt: "2026-01-02T00:00:00.000000",
      jobId: "through",
    };
    const continuation: ProtectedTaskPreexecutionRecoveryCursor = {
      createdAt: "2026-01-01T00:00:00.000000",
      jobId: "continuation",
    };
    let resetCalls = 0;
    const recovery = createProtectedTaskPreexecutionRecovery({
      db: database,
      repository: {
        get: async requestId => {
          if (requestId === broken.jobReference.authorizationRequestId) {
            throw new Error("transient lookup failure");
          }
          return current;
        },
        deferUnstartedTaskRuntimeRequest: async ({ expected, now }) => {
          const next = deferredRecord(expected, now);
          current = next;
          return { status: "deferred", record: next };
        },
      },
      now: () => START + 1_000,
      dependencies: {
        boundary: async () => through,
        list: async () => ({
          candidates: [
            { input: broken, jobStatus: "cancelled", cursor: continuation },
            { input: valid, jobStatus: "cancelled", cursor: continuation },
          ],
          continuation,
        }),
        cancel: async () => "exact_replay",
        reset: async (_db, _input, deferAuthorization) => {
          resetCalls += 1;
          return await deferAuthorization()
            ? { status: "deferred" }
            : { status: "stale" };
        },
      },
    });

    expect(await recovery.recoverPage({ limit: 2 })).toEqual({
      attempted: 2,
      cancelledJobs: 1,
      resetRuns: 1,
      failures: 1,
      next: { through, after: continuation },
    });
    expect(resetCalls).toBe(1);
  });
});
