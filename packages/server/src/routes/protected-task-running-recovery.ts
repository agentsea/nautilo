import {
  getProtectedTaskRunningRecoveryBoundary,
  listProtectedTaskRunningRecoveryCandidates,
  settleAbandonedProtectedTaskRun,
  type DirectDatabase,
  type ProtectedTaskRunningAuthorizationProof,
  type ProtectedTaskRunningRecoveryCursor,
} from "@nautilo/db";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  failBackgroundAuthorizationRequest,
  isTaskExecutionWorkKind,
  isTaskRuntimeStableIdempotencyKey,
  parseBackgroundAuthorizationRecord,
  sameBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";

type Repository = Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">;

type Dependencies = Readonly<{
  boundary: typeof getProtectedTaskRunningRecoveryBoundary;
  list: typeof listProtectedTaskRunningRecoveryCandidates;
  settle: typeof settleAbandonedProtectedTaskRun;
}>;

function sameExecutionCoordinates(
  record: BackgroundAuthorizationRecord,
  proof: ProtectedTaskRunningAuthorizationProof,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  const snapshot = record.snapshot;
  if (snapshot.formatVersion !== 3
    || snapshot.credentialSubject.kind !== "runtime"
    || snapshot.credentialSubject.runtimeKind !== "task"
    || snapshot.credentialSubject.runtimeVersion !== 1
    || snapshot.requestId !== proof.authorizationRequestId
    || snapshot.workId !== proof.taskRunId
    || snapshot.namespaceId !== proof.contentNamespaceId
    || !isTaskExecutionWorkKind(record.workKind)
    || proof.executionSegment === 1 && (record.workKind !== "task.execute"
        || proof.authorizationRequestId !== `task-run-authorization:${proof.taskRunId}`)
    || record.purpose !== record.workKind
    || !isTaskRuntimeStableIdempotencyKey(record.idempotencyKey, proof.taskRunId)
    || record.processorAuthorizationRevision !== null
    || record.expectedPolicyRevision !== proof.acceptedPolicyRevision
    || record.authoritySet === undefined) return false;
  const namespaces = record.authoritySet.namespaceRequirements;
  const domains = record.authoritySet.domainRequirements;
  return namespaces.length >= 1 && domains.length >= 1
    && namespaces.some(requirement =>
      requirement.namespaceId === proof.contentNamespaceId
      && requirement.operations.includes("decrypt")
      && requirement.operations.includes("encrypt")
      && requirement.expectedPolicyRevision === proof.acceptedPolicyRevision);
}

function exactUnknownOutcome(
  current: BackgroundAuthorizationRecord | null,
  source: BackgroundAuthorizationTaskRuntimeRecordV3,
): current is BackgroundAuthorizationTaskRuntimeRecordV3 {
  if (current === null
    || current.snapshot.state !== "terminal_failure"
    || current.snapshot.terminalReason !== "provider_outcome_unknown"
    || current.finishedAt !== current.snapshot.updatedAt) return false;
  try {
    const expected = parseBackgroundAuthorizationRecord({
      ...source,
      snapshot: failBackgroundAuthorizationRequest(
        source.snapshot, "provider_outcome_unknown", current.snapshot.updatedAt,
      ),
      finishedAt: current.snapshot.updatedAt,
    });
    return sameBackgroundAuthorizationRecord(current, expected);
  } catch {
    return false;
  }
}

function exactInitialTerminal(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return record.snapshot.state === "terminal_failure"
    && record.snapshot.terminalReason === "provider_outcome_unknown"
    && record.finishedAt === record.snapshot.updatedAt
    && record.snapshot.claimId === null
    && record.snapshot.claimExpiresAt === null;
}

/** Recover protected runs without replaying a model or inferring process death. */
export function createProtectedTaskRunningRecovery(input: Readonly<{
  db: DirectDatabase;
  repository: Repository;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const now = input.now ?? Date.now;
  const boundary = overrides.boundary ?? getProtectedTaskRunningRecoveryBoundary;
  const list = overrides.list ?? listProtectedTaskRunningRecoveryCandidates;
  const settle = overrides.settle ?? settleAbandonedProtectedTaskRun;

  const recover = async (candidate: Readonly<{
    taskId: string;
    taskRunId: string;
  }>): Promise<boolean> => {
    const result = await settle(input.db, candidate, async proof => {
      const raw = await input.repository.get(proof.authorizationRequestId);
      if (raw === null) return null;
      const selected = parseBackgroundAuthorizationRecord(raw);
      if (!sameExecutionCoordinates(selected, proof)) return null;
      let terminal: BackgroundAuthorizationTaskRuntimeRecordV3;
      if (exactInitialTerminal(selected)) {
        terminal = selected;
      } else {
        const claimExpiresAt = selected.snapshot.claimExpiresAt;
        const observedAt = now();
        if (selected.finishedAt !== null || selected.snapshot.state !== "running"
          || selected.snapshot.claimId === null || claimExpiresAt === null
          || !Number.isSafeInteger(observedAt)
          || proof.jobStatus === "running" && observedAt < claimExpiresAt) return null;
        const next = parseBackgroundAuthorizationRecord({
          ...selected,
          snapshot: failBackgroundAuthorizationRequest(
            selected.snapshot, "provider_outcome_unknown", observedAt,
          ),
          finishedAt: observedAt,
        }) as BackgroundAuthorizationTaskRuntimeRecordV3;
        let stored: BackgroundAuthorizationRecord | null;
        try {
          const compared = await input.repository.compareAndSwap({
            expectedRequestRevision: selected.snapshot.requestRevision,
            next,
          });
          stored = compared.status === "updated" ? compared.record : compared.current;
        } catch {
          stored = await input.repository.get(selected.snapshot.requestId);
        }
        if (stored !== null && sameBackgroundAuthorizationRecord(stored, next)) {
          terminal = next;
        } else if (exactUnknownOutcome(stored, selected)) {
          terminal = stored;
        } else return null;
      }
      return Object.freeze({
        requestRevision: terminal.snapshot.requestRevision,
        recipientGeneration: terminal.snapshot.recipientGeneration,
        settledAt: new Date(terminal.snapshot.updatedAt),
      });
    });
    if ((result.status === "settled" || result.status === "exact_replay")
      && result.cleanup !== undefined) {
      input.recipients.delete(result.cleanup.requestId, result.cleanup.generation);
      return true;
    }
    return false;
  };

  return Object.freeze({
    recover,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskRunningRecoveryCursor;
      through?: ProtectedTaskRunningRecoveryCursor;
    }>): Promise<Readonly<{
      attempted: number;
      settled: number;
      failures: number;
      next?: Readonly<{
        through: ProtectedTaskRunningRecoveryCursor;
        after: ProtectedTaskRunningRecoveryCursor;
      }>;
    }>> {
      const through = options.through ?? await boundary(input.db);
      if (through === null) return { attempted: 0, settled: 0, failures: 0 };
      const page = await list(input.db, {
        limit: options.limit, through,
        ...(options.after === undefined ? {} : { after: options.after }),
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
        attempted: page.candidates.length, settled, failures,
        ...(page.next === null ? {} : {
          next: Object.freeze({ through, after: page.next }),
        }),
      });
    },
  });
}
