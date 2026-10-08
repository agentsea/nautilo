import {
  and,
  eq,
  inArray,
  jobs,
  listProtectedTaskRunOutputBindingsNeedingDelivery,
  settlePublishedProtectedTaskRunAuthorization,
  taskRuns,
  type DirectDatabase,
  type ProtectedTaskRunOutputRecoveryCursor,
} from "@nautilo/db";
import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  assertProtectedTaskJobReferenceV1,
  completeBackgroundAuthorizationRequest,
  isExactCompletedTaskRuntimeSuccessor,
  isTaskRuntimeStableIdempotencyKey,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskJobReferenceV1,
} from "@nautilo/runtime";

type PublishedJob = Readonly<{
  jobId: string;
  reference: ProtectedTaskJobReferenceV1;
}>;

function exactTaskRecord(
  record: BackgroundAuthorizationRecord | null,
  reference: ProtectedTaskJobReferenceV1,
  proof: Readonly<{ contentNamespaceId: string; requesterHumanId: string }>,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record !== null
    && record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.snapshot.requestId === reference.authorizationRequestId
    && record.snapshot.workId === reference.taskRunId
    && record.snapshot.namespaceId === proof.contentNamespaceId
    && record.snapshot.acceptedResponse?.issuingHumanId === proof.requesterHumanId
    && record.expectedPolicyRevision === reference.policyRevision
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.authoritySet !== undefined
    && isTaskRuntimeStableIdempotencyKey(record.idempotencyKey, reference.taskRunId);
}

/** Close a verified publication's split Job/grant commit without opening content. */
export function createProtectedTaskPublishedResultRecovery(input: Readonly<{
  db: DirectDatabase;
  repository: Pick<BackgroundAuthorizationRepository, "get" | "compareAndSwap">;
  recipients: Pick<TaskRuntimeRecipientRegistry, "delete">;
  now?: () => number;
  settle?: typeof settlePublishedProtectedTaskRunAuthorization;
  list?: typeof listProtectedTaskRunOutputBindingsNeedingDelivery;
  loadJob?: (taskRunId: string) => Promise<PublishedJob | null>;
}>) {
  const now = input.now ?? Date.now;
  const settle = input.settle ?? settlePublishedProtectedTaskRunAuthorization;
  const list = input.list ?? listProtectedTaskRunOutputBindingsNeedingDelivery;
  const loadJob = input.loadJob ?? (async (taskRunId: string): Promise<PublishedJob | null> => {
    const [row] = await input.db.select({ jobId: jobs.id, reference: jobs.input })
      .from(taskRuns)
      .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
      .where(and(
        eq(taskRuns.id, taskRunId),
        inArray(taskRuns.resultRepresentation, ["dual", "protected"]),
        inArray(taskRuns.status, ["completed", "errored"]),
        eq(taskRuns.resultCryptoMappingState, "verified"),
        inArray(jobs.status, ["running", "failed", "completed"]),
      )).limit(1);
    if (row === undefined) return null;
    assertProtectedTaskJobReferenceV1(row.reference);
    if (row.reference.taskRunId !== taskRunId) return null;
    return Object.freeze({ jobId: row.jobId, reference: row.reference });
  });

  const recover = async (taskRunId: string): Promise<boolean> => {
    const job = await loadJob(taskRunId);
    if (job === null) return false;
    let released: Readonly<{ requestId: string; generation: number }> | undefined;
    const settled = await settle(input.db, job, async proof => {
      const raw = await input.repository.get(job.reference.authorizationRequestId);
      const record = raw === null ? null : parseBackgroundAuthorizationRecord(raw);
      if (!exactTaskRecord(record, job.reference, proof)) return false;
      if (record.snapshot.state === "completed") {
        if (record.finishedAt !== record.snapshot.updatedAt) return false;
      } else {
        if (record.finishedAt !== null
          || (record.snapshot.state !== "running"
            && record.snapshot.state !== "publication_reconciliation")) return false;
        const completedAt = now();
        const next = parseBackgroundAuthorizationRecord({
          ...record,
          snapshot: completeBackgroundAuthorizationRequest(record.snapshot, completedAt),
          finishedAt: completedAt,
        });
        let completed: BackgroundAuthorizationRecord | null;
        try {
          const result = await input.repository.compareAndSwap({
            expectedRequestRevision: record.snapshot.requestRevision,
            next,
          });
          completed = result.status === "updated" ? result.record : result.current;
        } catch {
          completed = await input.repository.get(record.snapshot.requestId);
        }
        if (!isExactCompletedTaskRuntimeSuccessor(completed, record)) return false;
      }
      released = { requestId: record.snapshot.requestId,
        generation: record.snapshot.recipientGeneration };
      return true;
    });
    if (settled && released !== undefined) {
      input.recipients.delete(released.requestId, released.generation);
    }
    return settled;
  };

  return Object.freeze({
    recover,
    async recoverPage(options: Readonly<{
      limit: number;
      after?: ProtectedTaskRunOutputRecoveryCursor;
    }>): Promise<Readonly<{
      attempted: number;
      settled: number;
      failures: number;
      next?: ProtectedTaskRunOutputRecoveryCursor;
    }>> {
      const rows = await list(input.db, options.limit, options.after);
      let settled = 0;
      let failures = 0;
      for (const row of rows) {
        try {
          if (await recover(row.taskRunId)) settled += 1;
        } catch {
          failures += 1;
        }
      }
      const last = rows.at(-1);
      return Object.freeze({
        attempted: rows.length,
        settled,
        failures,
        ...(rows.length === options.limit && last !== undefined ? {
          next: Object.freeze({ acceptedAt: last.acceptedAt, taskRunId: last.taskRunId }),
        } : {}),
      });
    },
  });
}
