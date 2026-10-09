import {
  eq,
  jobs,
  parkedTaskAdditionalAuthorityJobProjection,
  parkedTaskAdditionalAuthorityRunProjection,
  parkedTaskAdditionalAuthorityTaskProjection,
  readParkedProtectedTaskAdditionalAuthority,
  sameParkedProtectedTaskAdditionalAuthority,
  taskRuns,
  tasks,
  discoverParkedProtectedTaskAdditionalAuthority,
  type DirectDatabase,
  type ParkedProtectedTaskAdditionalAuthority,
} from "@nautilo/db";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  completeBackgroundAuthorizationRequest,
  isExactCompletedTaskRuntimeSuccessor,
  isTaskRuntimeStableIdempotencyKey,
  parseBackgroundAuthorizationRecord,
  sameBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";

export type ProtectedTaskParkedAuthorizationSettlementStatus =
  | "settled"
  | "inactive"
  | "pending";

type Dependencies = Readonly<{
  discover: typeof discoverParkedProtectedTaskAdditionalAuthority;
  read: typeof readParkedProtectedTaskAdditionalAuthority;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameOccurrence(
  left: ProtectedTaskOccurrence,
  right: ProtectedTaskOccurrence,
): boolean {
  return left.task.id === right.task.id
    && left.task.ownerId === right.task.ownerId
    && left.task.requestorId === right.task.requestorId
    && left.task.agentId === right.task.agentId
    && left.task.callingRoomId === right.task.callingRoomId
    && left.task.scheduleKind === right.task.scheduleKind
    && left.task.contentRepresentation === right.task.contentRepresentation
    && left.task.contentNamespaceId === right.task.contentNamespaceId
    && left.task.contentRevision === right.task.contentRevision
    && left.task.cryptoObjectId === right.task.cryptoObjectId
    && left.task.cryptoAccessRevision === right.task.cryptoAccessRevision
    && sameBytes(
      left.task.cryptoRequiredNamespaceFingerprint,
      right.task.cryptoRequiredNamespaceFingerprint,
    )
    && left.run.id === right.run.id
    && left.run.taskId === right.run.taskId
    && left.run.jobId === right.run.jobId
    && left.run.graphThreadId === right.run.graphThreadId
    && left.run.status === right.run.status
    && left.run.startedAt.getTime() === right.run.startedAt.getTime();
}

function exactPriorGrant(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  expected: ParkedProtectedTaskAdditionalAuthority,
): boolean {
  const reference = expected.priorJob.reference;
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.snapshot.requestId === reference.authorizationRequestId
    && record.snapshot.workId === expected.occurrence.run.id
    && record.snapshot.recipientGeneration === expected.priorJob.generation
    && record.snapshot.namespaceId
      === expected.occurrence.task.contentNamespaceId
    && record.expectedPolicyRevision === reference.policyRevision
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.authoritySet !== undefined
    && isTaskRuntimeStableIdempotencyKey(
      record.idempotencyKey,
      expected.occurrence.run.id,
    );
}

/**
 * Reconcile product-first park settlement with its prior running grant. This
 * reads only content-free lifecycle and receipt projections and never requires
 * current device, grant, policy, or protected-content authority.
 */
export function createProtectedTaskParkedAuthorizationSettlement(input: Readonly<{
  db: DirectDatabase;
  repository: Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
}>, overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    discover: discoverParkedProtectedTaskAdditionalAuthority,
    read: readParkedProtectedTaskAdditionalAuthority,
    ...overrides,
  };

  const settle = async (
    observed: ProtectedTaskOccurrence,
  ): Promise<ProtectedTaskParkedAuthorizationSettlementStatus> => {
    const occurrence = structuredClone(observed);
    if (occurrence.run.jobId === null) return "inactive";
    const discovered = await dependencies.discover(input.db, {
      taskRunId: occurrence.run.id,
    });
    if (discovered === null
      || !sameOccurrence(occurrence, discovered.occurrence)) return "inactive";
    const expected = structuredClone(discovered);
    let release: Readonly<{
      requestId: string;
      generation: number;
    }> | undefined;
    const status = await input.db.transaction(async tx => {
      const taskRows = await tx.select(parkedTaskAdditionalAuthorityTaskProjection)
        .from(tasks)
        .where(eq(tasks.id, expected.occurrence.task.id))
        .limit(2)
        .for("update");
      if (taskRows.length !== 1) return "inactive" as const;
      const runRows = await tx.select(parkedTaskAdditionalAuthorityRunProjection)
        .from(taskRuns)
        .where(eq(taskRuns.id, expected.occurrence.run.id))
        .limit(2)
        .for("update");
      if (runRows.length !== 1) return "inactive" as const;
      const jobRows = await tx.select(parkedTaskAdditionalAuthorityJobProjection)
        .from(jobs)
        .where(eq(jobs.id, expected.priorJob.id))
        .limit(2)
        .for("update");
      if (jobRows.length !== 1) return "inactive" as const;

      const current = await dependencies.read(tx, {
        taskRunId: expected.occurrence.run.id,
        authorizationRequestId: expected.authorizationRequestId,
      });
      if (current === null
        || !sameParkedProtectedTaskAdditionalAuthority(current, expected)) {
        return "inactive" as const;
      }

      const raw = await input.repository.get(
        expected.priorJob.reference.authorizationRequestId,
      );
      if (raw === null) return "pending" as const;
      let record: BackgroundAuthorizationTaskRuntimeRecordV3;
      try {
        const parsed = parseBackgroundAuthorizationRecord(raw);
        if (parsed.snapshot.formatVersion !== 3
          || parsed.authoritySet === undefined) return "pending" as const;
        record = parsed as BackgroundAuthorizationTaskRuntimeRecordV3;
      } catch {
        return "pending" as const;
      }
      if (!exactPriorGrant(record, expected)) return "pending" as const;
      const parkedAt = expected.priorJob.parkedAt.getTime();
      if (!Number.isSafeInteger(parkedAt) || parkedAt < 0) {
        return "pending" as const;
      }
      if (record.snapshot.state === "completed") {
        if (record.finishedAt !== parkedAt
          || record.snapshot.updatedAt !== parkedAt
          || !sameBackgroundAuthorizationRecord(raw, record)) {
          return "pending" as const;
        }
      } else {
        if (record.snapshot.state !== "running" || record.finishedAt !== null) {
          return "pending" as const;
        }
        let next: BackgroundAuthorizationTaskRuntimeRecordV3;
        try {
          next = {
            ...record,
            snapshot: completeBackgroundAuthorizationRequest(
              record.snapshot,
              parkedAt,
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
            finishedAt: parkedAt,
          };
        } catch {
          return "pending" as const;
        }
        let completed: BackgroundAuthorizationRecord | null;
        try {
          const result = await input.repository.compareAndSwap({
            expectedRequestRevision: record.snapshot.requestRevision,
            next,
          });
          completed = result.status === "updated"
            ? result.record
            : result.current;
        } catch {
          completed = await input.repository.get(record.snapshot.requestId);
        }
        if (completed === null
          || (sameBackgroundAuthorizationRecord(completed, next)
            ? completed.snapshot.updatedAt !== parkedAt
              || completed.finishedAt !== parkedAt
            : !isExactCompletedTaskRuntimeSuccessor(completed, record)
              || completed.snapshot.updatedAt !== parkedAt
              || completed.finishedAt !== parkedAt)) {
          return "pending" as const;
        }
      }
      release = {
        requestId: record.snapshot.requestId,
        generation: record.snapshot.recipientGeneration,
      };
      return "settled" as const;
    });
    if (status === "settled" && release !== undefined) {
      input.recipients.delete(release.requestId, release.generation);
    }
    return status;
  };

  return Object.freeze({ settle });
}
