import {
  settleCancelledProtectedTaskRunAuthorization,
  type DirectDatabase,
} from "@nautilo/db";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  cancelBackgroundAuthorizationRequest,
  isTaskRuntimeStableIdempotencyKey,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeCancellationCandidate,
  type BackgroundAuthorizationTaskRuntimeCancellationCursor,
  type BackgroundAuthorizationTaskRuntimeCancellationDiscoveryRepository,
} from "@nautilo/runtime";

type Repository = Pick<BackgroundAuthorizationTaskRuntimeCancellationDiscoveryRepository,
  "get" | "compareAndSwap" | "listTaskRuntimeCancellationPage">;

export type ProtectedTaskCancellationRecoveryCursor = Readonly<{
  throughUpdatedAt: number;
  after: BackgroundAuthorizationTaskRuntimeCancellationCursor;
}>;

function sameTaskRequest(
  record: BackgroundAuthorizationRecord | null,
  candidate: BackgroundAuthorizationTaskRuntimeCancellationCandidate,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record !== null
    && record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.snapshot.requestId === candidate.requestId
    && record.snapshot.workId === candidate.workId
    && record.snapshot.namespaceId === candidate.namespaceId
    && record.snapshot.recipientGeneration === candidate.recipientGeneration
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.authoritySet !== undefined
    && isTaskRuntimeStableIdempotencyKey(record.idempotencyKey, candidate.workId);
}

function cancelled(record: BackgroundAuthorizationRecord): boolean {
  return record.snapshot.state === "cancelled"
    && record.snapshot.terminalReason === "cancelled"
    && record.finishedAt !== null;
}

function active(record: BackgroundAuthorizationRecord): boolean {
  return record.finishedAt === null
    && record.snapshot.state !== "completed"
    && record.snapshot.state !== "cancelled"
    && record.snapshot.state !== "terminal_failure";
}

/** Revoke stopped Task authority; this never resumes or replays execution. */
export function createProtectedTaskCancellationRecovery(input: Readonly<{
  db: DirectDatabase;
  repository: Repository;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  now?: () => number;
  settle?: typeof settleCancelledProtectedTaskRunAuthorization;
}>) {
  const now = input.now ?? Date.now;
  const settle = input.settle ?? settleCancelledProtectedTaskRunAuthorization;

  const recover = async (
    candidate: BackgroundAuthorizationTaskRuntimeCancellationCandidate,
  ): Promise<boolean> => {
    const selected = await input.repository.get(candidate.requestId);
    if (!sameTaskRequest(selected, candidate)
      || selected.snapshot.requestRevision !== candidate.requestRevision
      || (!active(selected) && !cancelled(selected))) return false;

    const settled = await settle(input.db, {
      taskRunId: candidate.workId,
      contentNamespaceId: candidate.namespaceId,
      authorizationRequestId: candidate.requestId,
      policyRevision: selected.expectedPolicyRevision,
    }, async () => {
      const current = await input.repository.get(candidate.requestId);
      if (!sameTaskRequest(current, candidate)
        || current.snapshot.requestRevision !== candidate.requestRevision
        || current.expectedPolicyRevision !== selected.expectedPolicyRevision) {
        return false;
      }
      if (cancelled(current)) return true;
      if (!active(current)) return false;
      const cancelledAt = now();
      const snapshot = cancelBackgroundAuthorizationRequest(
        current.snapshot, "cancelled", cancelledAt,
      );
      const result = await input.repository.compareAndSwap({
        expectedRequestRevision: current.snapshot.requestRevision,
        next: parseBackgroundAuthorizationRecord({
          ...current, snapshot, finishedAt: cancelledAt,
        }),
      });
      const stored = result.status === "updated" ? result.record : result.current;
      return sameTaskRequest(stored, candidate)
        && stored.snapshot.requestRevision > current.snapshot.requestRevision
        && stored.expectedPolicyRevision === current.expectedPolicyRevision
        && cancelled(stored);
    });
    if (settled) {
      // Each process releases its own custody, including after a remote CAS win.
      input.recipients.delete(candidate.requestId, candidate.recipientGeneration);
    }
    return settled;
  };

  return Object.freeze({
    recover,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskCancellationRecoveryCursor;
    }>): Promise<Readonly<{
      attempted: number;
      settled: number;
      failures: number;
      next?: ProtectedTaskCancellationRecoveryCursor;
    }>> {
      const throughUpdatedAt = options.after?.throughUpdatedAt ?? now();
      const page = await input.repository.listTaskRuntimeCancellationPage({
        throughUpdatedAt,
        limit: options.limit,
        ...(options.after === undefined ? {} : { after: options.after.after }),
      });
      let settled = 0;
      let failures = 0;
      for (const candidate of page.candidates) {
        try {
          if (await recover(candidate)) settled += 1;
        } catch {
          failures += 1;
        }
      }
      return Object.freeze({
        attempted: page.candidates.length,
        settled,
        failures,
        ...(page.continuation === null ? {} : {
          next: Object.freeze({ throughUpdatedAt, after: page.continuation }),
        }),
      });
    },
  });
}
