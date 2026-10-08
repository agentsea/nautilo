import {
  cancelUnstartedProtectedTaskJobWithDatabase,
  getUnstartedProtectedTaskRunRecoveryBoundary,
  listUnstartedProtectedTaskRunRecoveryCandidates,
  recoverUnstartedProtectedTaskRun,
  type DirectDatabase,
  type ProtectedTaskPreexecutionRecoveryCursor,
  type StartProtectedTaskRunInput,
} from "@nautilo/db";
import {
  isTaskRuntimeStableIdempotencyKey,
  type BackgroundAuthorizationTaskRuntimeDeferralRepository,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";

type AuthorizationRepository = Pick<BackgroundAuthorizationTaskRuntimeDeferralRepository,
  "get" | "deferUnstartedTaskRuntimeRequest">;

type Dependencies = Readonly<{
  cancel: typeof cancelUnstartedProtectedTaskJobWithDatabase;
  reset: typeof recoverUnstartedProtectedTaskRun;
  boundary: typeof getUnstartedProtectedTaskRunRecoveryBoundary;
  list: typeof listUnstartedProtectedTaskRunRecoveryCandidates;
}>;

const productionDependencies: Dependencies = Object.freeze({
  cancel: cancelUnstartedProtectedTaskJobWithDatabase,
  reset: recoverUnstartedProtectedTaskRun,
  boundary: getUnstartedProtectedTaskRunRecoveryBoundary,
  list: listUnstartedProtectedTaskRunRecoveryCandidates,
});

export type ProtectedTaskPreexecutionRecoveryPageCursor = Readonly<{
  through: ProtectedTaskPreexecutionRecoveryCursor;
  after: ProtectedTaskPreexecutionRecoveryCursor;
}>;

export type ProtectedTaskPreexecutionRecoveryPageResult = Readonly<{
  attempted: number;
  cancelledJobs: number;
  resetRuns: number;
  failures: number;
  next?: ProtectedTaskPreexecutionRecoveryPageCursor;
}>;

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactInput(input: StartProtectedTaskRunInput): boolean {
  const reference = input.jobReference;
  if (!(input.taskId.length > 0
    && input.taskRunId.length > 0
    && input.graphThreadId.length > 0
    && input.jobId.length > 0
    && (input.contentRepresentation === "dual"
      || input.contentRepresentation === "protected")
    && input.contentNamespaceId.length > 0
    && Number.isSafeInteger(input.contentRevision)
    && input.contentRevision >= 1
    && input.cryptoAccessRevision === 0
    && input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array
    && input.cryptoRequiredNamespaceFingerprint.length === 32
    && reference.kind === "protected_task_run_v1"
    && Object.keys(reference).sort().join(",")
      === "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    && reference.taskId === input.taskId
    && reference.taskRunId === input.taskRunId
    && reference.inputObjectId === input.cryptoObjectId
    && reference.authorizationRequestId.length > 0
    && Number.isSafeInteger(reference.policyRevision)
    && reference.policyRevision >= 1
    && reference.executionSegment === 1
    && reference.resumeAcceptanceId === undefined
    && reference.resumeContinuationFingerprint === undefined)) return false;
  try {
    return reference.resultObjectId === deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      contentRevision: 1,
    })
      && input.cryptoObjectId === deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: input.taskId,
      contentRevision: input.contentRevision,
    });
  } catch {
    return false;
  }
}

function exactTaskRuntimeRecord(
  input: StartProtectedTaskRunInput,
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  if (record.snapshot.formatVersion !== 3
    || record.snapshot.credentialSubject.kind !== "runtime"
    || record.snapshot.credentialSubject.runtimeKind !== "task"
    || record.snapshot.credentialSubject.runtimeVersion !== 1
    || record.authoritySet === undefined) return false;
  const content = record.authoritySet.namespaceRequirements.filter(
    requirement => requirement.namespaceId === input.contentNamespaceId,
  );
  const anchored = content[0];
  const domains = anchored === undefined
    ? []
    : record.authoritySet.domainRequirements.filter(
      requirement => requirement.domainId === anchored.domainId,
    );
  return record.snapshot.requestId
      === input.jobReference.authorizationRequestId
    && record.snapshot.workId === input.taskRunId
    && record.snapshot.namespaceId === input.contentNamespaceId
    && isTaskRuntimeStableIdempotencyKey(
      record.idempotencyKey,
      input.taskRunId,
    )
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.expectedPolicyRevision === input.jobReference.policyRevision
    && record.expectedDomainEpoch !== null
    && record.finishedAt === null
    && content.length === 1
    && anchored !== undefined
    && anchored.domainId === record.domainId
    && anchored.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && anchored.expectedPolicyRevision === record.expectedPolicyRevision
    && anchored.operations.length === 2
    && anchored.operations[0] === "decrypt"
    && anchored.operations[1] === "encrypt"
    && record.authoritySet.namespaceRequirements.every(
      requirement => requirement.expectedPolicyRevision
        === record.expectedPolicyRevision,
    )
    && domains.length === 1
    && domains[0]?.expectedEpoch === record.expectedDomainEpoch;
}

function activeGrant(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return (record.snapshot.state === "claimed"
      || record.snapshot.state === "running")
    && record.snapshot.claimId !== null
    && record.snapshot.claimExpiresAt !== null
    && record.snapshot.recipient !== null
    && record.snapshot.acceptedResponse !== null
    && record.descriptorBytes !== null
    && record.acceptedMaterial !== null;
}

function recoverableDeferredGrant(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return record.snapshot.state === "awaiting_recipient"
    && record.snapshot.recipientGeneration > 0
    && record.snapshot.requestRevision > 0
    && record.snapshot.descriptorDigest === null
    && record.snapshot.recipient === null
    && record.snapshot.acceptedResponse === null
    && record.snapshot.claimId === null
    && record.snapshot.claimExpiresAt === null
    && record.snapshot.lastRetryReason === "stale_authority"
    && record.snapshot.nextAttemptAt === record.snapshot.updatedAt
    && record.descriptorBytes === null
    && record.acceptedMaterial === null;
}

function activeGrantExpired(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  now: number,
): boolean {
  const claimExpiresAt = record.snapshot.claimExpiresAt;
  const recipientExpiresAt = record.snapshot.recipient?.expiresAt;
  const authorizationExpiresAt = record.acceptedMaterial?.authorizationExpiresAt;
  return claimExpiresAt !== null
    && recipientExpiresAt !== undefined
    && authorizationExpiresAt !== undefined
    && (now >= claimExpiresAt
      || now >= recipientExpiresAt
      || now >= authorizationExpiresAt);
}

export function createProtectedTaskPreexecutionRecovery(input: Readonly<{
  db: DirectDatabase;
  repository: AuthorizationRepository;
  now?: () => number;
  dependencies?: Partial<Dependencies>;
}>) {
  const dependencies: Dependencies = {
    ...productionDependencies,
    ...input.dependencies,
  };
  const now = input.now ?? Date.now;

  const recoverDetailed = async (
    start: StartProtectedTaskRunInput,
    options: Readonly<{ immediate: boolean }>,
  ): Promise<Readonly<{
    cancelled: boolean;
    reset: boolean;
    failed: boolean;
  }>> => {
    if (!exactInput(start)) {
      return { cancelled: false, reset: false, failed: false };
    }
    const selected = await input.repository.get(
      start.jobReference.authorizationRequestId,
    );
    if (selected === null || !exactTaskRuntimeRecord(start, selected)) {
      return { cancelled: false, reset: false, failed: false };
    }
    const active = activeGrant(selected);
    const deferred = recoverableDeferredGrant(selected);
    if (!active && !deferred) {
      return { cancelled: false, reset: false, failed: false };
    }
    const observedAt = now();
    if (!validTime(observedAt)) {
      throw new TypeError("Protected Task pre-execution recovery clock is invalid");
    }
    if (!options.immediate && active
      && !activeGrantExpired(selected, observedAt)) {
      return { cancelled: false, reset: false, failed: false };
    }

    const cancelled = await dependencies.cancel(
      input.db,
      start.jobId,
      start.jobReference,
    );
    if (cancelled === "ineligible") {
      return { cancelled: false, reset: false, failed: false };
    }

    // From this point the exact durable Job is proven cancelled and unstarted.
    // Reset remains best-effort and replayable across the crypto/product split.
    try {
      const reset = await dependencies.reset(input.db, start, async () => {
        const current = await input.repository.get(
          start.jobReference.authorizationRequestId,
        );
        if (current === null || !exactTaskRuntimeRecord(start, current)) {
          return false;
        }
        if (deferred) {
          return recoverableDeferredGrant(current)
            && current.snapshot.requestRevision
              === selected.snapshot.requestRevision
            && current.snapshot.recipientGeneration
              === selected.snapshot.recipientGeneration;
        }
        const deferredAt = now();
        if (!validTime(deferredAt)) return false;
        const result = await input.repository.deferUnstartedTaskRuntimeRequest({
          expected: selected,
          now: deferredAt,
        });
        return result.status === "deferred"
          || result.status === "exact_replay";
      });
      return {
        cancelled: true,
        reset: reset.status === "deferred" || reset.status === "exact_replay",
        failed: false,
      };
    } catch {
      // The caller must still suppress ordinary failure handling once the
      // guarded cancellation has proved that execution never began.
      return { cancelled: true, reset: false, failed: true };
    }
  };

  const recover = async (
    start: StartProtectedTaskRunInput,
    options: Readonly<{ immediate: boolean }>,
  ): Promise<boolean> => (await recoverDetailed(start, options)).cancelled;

  return Object.freeze({
    recover,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskPreexecutionRecoveryPageCursor;
    }>): Promise<ProtectedTaskPreexecutionRecoveryPageResult> {
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        return Object.freeze({
          attempted: 0,
          cancelledJobs: 0,
          resetRuns: 0,
          failures: 0,
        });
      }
      const through = options.after?.through
        ?? await dependencies.boundary(input.db);
      if (through === undefined) {
        return Object.freeze({
          attempted: 0,
          cancelledJobs: 0,
          resetRuns: 0,
          failures: 0,
        });
      }
      const page = await dependencies.list(input.db, {
        limit: options.limit,
        through,
        ...(options.after === undefined ? {} : { after: options.after.after }),
      });
      let cancelledJobs = 0;
      let resetRuns = 0;
      let failures = 0;
      for (const candidate of page.candidates) {
        try {
          const result = await recoverDetailed(candidate.input, {
            immediate: candidate.jobStatus === "cancelled",
          });
          if (result.cancelled) cancelledJobs += 1;
          if (result.reset) resetRuns += 1;
          if (result.failed) failures += 1;
        } catch {
          failures += 1;
        }
      }
      return Object.freeze({
        attempted: page.candidates.length,
        cancelledJobs,
        resetRuns,
        failures,
        ...(page.continuation === undefined ? {} : {
          next: Object.freeze({ through, after: page.continuation }),
        }),
      });
    },
  });
}
