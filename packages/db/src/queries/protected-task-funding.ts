import { parseTaskFundingBinding, type TaskFundingBinding } from "@nautilo/types";
import { and, eq, isNull } from "drizzle-orm";

import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";
import { taskRuns } from "../schema/task-runs";
import { tasks } from "../schema/tasks";
import type {
  AttachProtectedTaskRunModelInput,
  ProtectedTaskDurableJobReference,
} from "./tasks";

export type BindProtectedTaskRunFundingInput =
  AttachProtectedTaskRunModelInput & Readonly<{
    fundingBinding: TaskFundingBinding;
  }>;

export type BindProtectedTaskRunFundingResult =
  | Readonly<{ status: "attached" | "same" }>
  | Readonly<{ status: "stale" }>;

const NATIVE_TASK_MODEL_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9/._-]*$/u;
const OPAQUE_CHECKPOINT_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONTINUATION_FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameBinding(left: unknown, right: TaskFundingBinding): boolean {
  try {
    return JSON.stringify(parseTaskFundingBinding(left))
      === JSON.stringify(right);
  } catch {
    return false;
  }
}

function exactReference(
  value: unknown,
  expected: ProtectedTaskDurableJobReference,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  const acceptance = expected.resumeAcceptanceId;
  const continuation = expected.resumeContinuationFingerprint;
  const expectedKeys = acceptance !== undefined
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
    : continuation !== undefined
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId";
  const continuationIsExact = expected.executionSegment === 1
    ? acceptance === undefined && continuation === undefined
    : (typeof acceptance === "string"
        && OPAQUE_CHECKPOINT_COORDINATE.test(acceptance)
        && continuation === undefined)
      || (acceptance === undefined
        && typeof continuation === "string"
        && CONTINUATION_FINGERPRINT.test(continuation));
  return continuationIsExact
    && Object.keys(reference).sort().join(",") === expectedKeys
    && reference["kind"] === expected.kind
    && reference["taskId"] === expected.taskId
    && reference["taskRunId"] === expected.taskRunId
    && reference["inputObjectId"] === expected.inputObjectId
    && reference["resultObjectId"] === expected.resultObjectId
    && reference["authorizationRequestId"] === expected.authorizationRequestId
    && reference["policyRevision"] === expected.policyRevision
    && reference["executionSegment"] === expected.executionSegment
    && reference["resumeAcceptanceId"] === acceptance
    && reference["resumeContinuationFingerprint"] === continuation;
}

function assertInput(input: BindProtectedTaskRunFundingInput): TaskFundingBinding {
  let binding: TaskFundingBinding;
  try {
    binding = parseTaskFundingBinding(input.fundingBinding);
  } catch {
    throw new TypeError("Protected Task funding binding is malformed");
  }
  if (
    !input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.jobId
    || !NATIVE_TASK_MODEL_ID.test(input.modelId)
    || input.contentRepresentation !== "dual"
      && input.contentRepresentation !== "protected"
    || !input.contentNamespaceId
    || !Number.isSafeInteger(input.contentRevision)
    || input.contentRevision < 1
    || !input.cryptoObjectId
    || !Number.isSafeInteger(input.cryptoAccessRevision)
    || input.cryptoAccessRevision < 0
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
    || input.jobReference.kind !== "protected_task_run_v1"
    || input.jobReference.taskId !== input.taskId
    || input.jobReference.taskRunId !== input.taskRunId
    || input.jobReference.inputObjectId !== input.cryptoObjectId
    || !input.jobReference.resultObjectId
    || !input.jobReference.authorizationRequestId
    || !Number.isSafeInteger(input.jobReference.policyRevision)
    || input.jobReference.policyRevision < 1
    || !Number.isSafeInteger(input.jobReference.executionSegment)
    || input.jobReference.executionSegment < 1
    || !exactReference(input.jobReference, input.jobReference)
  ) {
    throw new TypeError("Protected Task funding binding is malformed");
  }
  return binding;
}

/**
 * Bind one caller-funding decision to the exact running protected occurrence.
 * The opaque binding contains provider/credential identity and revision only;
 * credential material remains inside the server funding owner.
 */
export async function bindProtectedTaskRunFunding(
  db: DirectDatabase,
  input: BindProtectedTaskRunFundingInput,
): Promise<BindProtectedTaskRunFundingResult> {
  const binding = assertInput(input);
  return db.transaction(async tx => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return { status: "stale" } as const;
    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "running";
    if (task.status !== expectedTaskStatus
      || task.fundingMode !== "caller"
      || task.contentRepresentation !== input.contentRepresentation
      || task.contentNamespaceId !== input.contentNamespaceId
      || task.contentRevision !== input.contentRevision
      || task.cryptoObjectId !== input.cryptoObjectId
      || task.cryptoAccessRevision !== input.cryptoAccessRevision
      || task.cryptoMappingState !== "verified"
      || !sameBytes(
        task.cryptoRequiredNamespaceFingerprint,
        input.cryptoRequiredNamespaceFingerprint,
      )) {
      return { status: "stale" } as const;
    }

    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, task.id),
    )).limit(1).for("update");
    if (!run
      || run.graphThreadId !== input.graphThreadId
      || run.status !== "running"
      || run.jobId !== input.jobId
      || run.fundingPredecessorRunId !== null
      || run.modelId !== null && run.modelId !== input.modelId
      || run.fundingBinding !== null && !sameBinding(run.fundingBinding, binding)
      || (run.modelId === null) !== (run.fundingBinding === null)
      || run.resultText !== null
      || run.completedAt !== null
      || run.lastError !== null
      || run.resultRepresentation !== "ordinary"
      || run.resultContentNamespaceId !== null
      || run.resultRevision !== 0
      || run.resultCryptoObjectId !== null
      || run.resultCryptoAccessRevision !== 0
      || run.resultCryptoRequiredNamespaceFingerprint !== null
      || run.resultCryptoMappingState !== "unmapped") {
      return { status: "stale" } as const;
    }

    const [job] = await tx.select().from(jobs)
      .where(eq(jobs.id, input.jobId)).limit(1).for("share");
    if (!job
      || job.ownerId !== task.requestorId
      || job.requestorId !== task.requestorId
      || job.laneKey !== `task:${task.id}`
      || job.type !== "foreground"
      || job.status !== "queued" && job.status !== "running"
      || job.status === "queued" && job.startedAt !== null
      || job.status === "running" && job.startedAt === null
      || job.result !== null
      || job.message !== null
      || job.completedAt !== null
      || !exactReference(job.input, input.jobReference)) {
      return { status: "stale" } as const;
    }

    if (run.modelId === input.modelId
      && sameBinding(run.fundingBinding, binding)) {
      return { status: "same" } as const;
    }
    const [updated] = await tx.update(taskRuns).set({
      modelId: input.modelId,
      fundingBinding: binding,
    }).where(and(
      eq(taskRuns.id, run.id),
      eq(taskRuns.taskId, task.id),
      eq(taskRuns.graphThreadId, input.graphThreadId),
      eq(taskRuns.status, "running"),
      eq(taskRuns.jobId, job.id),
      isNull(taskRuns.modelId),
      isNull(taskRuns.fundingBinding),
      isNull(taskRuns.fundingPredecessorRunId),
      isNull(taskRuns.completedAt),
    )).returning();
    if (!updated) {
      throw new Error("Protected Task funding binding lost its locked TaskRun");
    }
    return { status: "attached" } as const;
  });
}
