import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  type ProtectedTaskRunWakeReferenceV1,
  type ProtectedTaskWakeScheduling,
  type ProtectedTaskSemanticAuthorityRequirements,
} from "@nautilo/db";
import type { EncryptedCheckpointPhysicalManifest } from "@nautilo/agent";
import type { JobExecutor } from "../job";

export type ProtectedTaskWakeCheckpointBinding = Readonly<{
  retainedSourceNamespaceIds: readonly string[];
  sourceEnvelopeDigest: Uint8Array;
  initialPolicyRevision: number;
  initialAgentAuthorizationRevision: number;
}>;

export type ProtectedTaskWakeSettlementResult =
  | Readonly<{ kind: "transitioned" | "existing_terminal";
      status: "completed" | "failed" | "cancelled" | "timed_out" }>
  | Readonly<{ kind: "rejected" }>;

export type ProtectedTaskWakeParkRequest = Readonly<{
  interruptId: string;
  additionalAuthorizationRequestId: string;
  effectDisposition: "not_started_v1";
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
  semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  checkpointBinding: ProtectedTaskWakeCheckpointBinding;
  checkpointThreadId: string;
  checkpoint: EncryptedCheckpointPhysicalManifest;
}>;

export type ProtectedTaskWakeParkResult = Readonly<{
  status: "parked" | "exact_replay" | "stale";
}>;

/** Exists only inside the authenticated candidate callback. */
export interface ProtectedTaskWakeExecutionCustody {
  park(input: ProtectedTaskWakeParkRequest): Promise<ProtectedTaskWakeParkResult>;
}

/** Server-owned live authority; the durable wake reference cannot reconstruct it. */
export interface ProtectedTaskWakeExecutionCandidate {
  start(jobId: string): Promise<Readonly<{ status: "started" | "stale" }>>;
  run<T>(work: (
    transientInput: Record<string, unknown>,
    authorizationSignal: AbortSignal,
    custody: ProtectedTaskWakeExecutionCustody,
  ) => Promise<T>): Promise<T>;
  settle(jobId: string, requested: "completed" | "failed"): Promise<ProtectedTaskWakeSettlementResult>;
  onIneligible(): void;
}

const wakeParkedBrand: unique symbol = Symbol("ProtectedTaskWakeParked");
class ProtectedTaskWakeParked extends Error {
  readonly [wakeParkedBrand] = true;

  constructor() {
    super("Protected Task wake parked");
    this.name = "ProtectedTaskWakeParked";
  }
}

/** Private Runtime control outcome; never serialize it as a Job result. */
export function protectedTaskWakeParked(): ProtectedTaskWakeParked {
  return Object.freeze(new ProtectedTaskWakeParked());
}

export function isProtectedTaskWakeParked(
  value: unknown,
): value is ProtectedTaskWakeParked {
  return typeof value === "object" && value !== null
    && Reflect.get(value, wakeParkedBrand) === true;
}

export type AdoptProtectedTaskWakeJobInput = Readonly<{
  scheduling: ProtectedTaskWakeScheduling;
  reference: ProtectedTaskRunWakeReferenceV1;
  executor: JobExecutor;
  candidate: ProtectedTaskWakeExecutionCandidate;
}>;

export type AdoptProtectedTaskWakeJobResult = Readonly<{
  status: "adopted" | "existing" | "ineligible";
  jobId: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const THREAD = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

/** Closed metadata only; snapshots also fence caller mutation while queued. */
export function snapshotProtectedTaskWakeAdoption(input: AdoptProtectedTaskWakeJobInput): AdoptProtectedTaskWakeJobInput {
  const { scheduling: schedulingInput, reference: referenceInput, executor, candidate } = input;
  const reference = Object.freeze({ ...referenceInput });
  const scheduling = Object.freeze({ ...schedulingInput, reference: Object.freeze({ ...schedulingInput.reference }) });
  if (Object.keys(input).sort().join(",") !== "candidate,executor,reference,scheduling"
    || Object.keys(reference).sort().join(",") !== "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    || Object.keys(scheduling).sort().join(",") !== "agentId,graphThreadId,jobId,jobState,laneKey,namespaceId,ownerId,reference,requestorId,roomId,sessionId,sessionOwnerId,taskId,taskRunId"
    || reference.kind !== "protected_task_delivery_v1"
    || ![scheduling.taskId, scheduling.taskRunId, scheduling.jobId, scheduling.ownerId,
      scheduling.requestorId, scheduling.agentId, scheduling.roomId, scheduling.namespaceId,
      scheduling.sessionId, scheduling.sessionOwnerId].every(id => UUID.test(id))
    || reference.taskId !== scheduling.taskId || reference.taskRunId !== scheduling.taskRunId
    || reference.bindingId !== protectedTaskRunOutputBindingId(reference.taskRunId)
    || reference.wakeOperationId !== protectedTaskRunWakeOperationId(reference.taskRunId)
    || reference.resultObjectId !== protectedTaskRunResultObjectId(reference.taskId, reference.taskRunId)
      && reference.resultObjectId !== protectedTaskRunCancelledResultObjectId(reference.taskId, reference.taskRunId)
    || scheduling.jobId !== protectedTaskRunWakeJobId(reference.taskRunId)
    || scheduling.laneKey !== `room:${scheduling.roomId}`
    || !THREAD.test(scheduling.graphThreadId)
    || !["queued", "running", "completed"].includes(scheduling.jobState)
    || Object.keys(scheduling.reference).sort().join(",") !== Object.keys(reference).sort().join(",")
    || Object.entries(reference).some(([key, value]) => Reflect.get(scheduling.reference, key) !== value)
    || typeof executor !== "function" || typeof candidate?.start !== "function"
    || typeof candidate.run !== "function" || typeof candidate.settle !== "function"
    || typeof candidate.onIneligible !== "function") {
    throw new TypeError("Protected Task wake adoption is invalid");
  }
  return Object.freeze({ scheduling, reference, executor, candidate: Object.freeze({
    start: candidate.start.bind(candidate), run: candidate.run.bind(candidate),
    settle: candidate.settle.bind(candidate), onIneligible: candidate.onIneligible.bind(candidate),
  }) });
}
