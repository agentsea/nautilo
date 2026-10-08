import type { JobExecutor } from "../job";
import type { TaskRunResultPayloadV1 } from "@nautilo/lattice-bridge";
import type { ProtectedTaskJobReferenceV1 } from "./protected-task-job-reference";

/** Closed scheduling identity allowed outside a protected Task authorization. */
export type ProtectedTaskJobSchedulingFacts = Readonly<{
  ownerId: string;
  requestorId: string;
  agentId: string;
  roomId: string;
  callingRoomId: string | null;
  graphThreadId: string;
}>;

export type ProtectedTaskExecutionStartResult =
  | Readonly<{ status: "started" }>
  | Readonly<{ status: "stale" }>;

/** The candidate released its custody without calling the execution callback. */
export class ProtectedTaskExecutionDidNotBeginError extends Error {
  constructor() {
    super("Protected Task execution did not begin");
    this.name = "ProtectedTaskExecutionDidNotBeginError";
  }
}

/**
 * One process-local accepted authority. Implementations open the protected
 * Task definition inside `run`, release all plaintext and capability material
 * before it returns, and cannot be reconstructed from the durable reference.
 */
export interface ProtectedTaskExecutionCandidate {
  /**
   * Attach the already-persisted content-free Job to the exact TaskRun before
   * protected input can be opened. This transition is one-shot.
   */
  start(jobId: string): Promise<ProtectedTaskExecutionStartResult>;
  run<T>(
    work: (
      transientInput: Record<string, unknown>,
      authorizationSignal: AbortSignal,
      publication: Readonly<{
        publish(payload: TaskRunResultPayloadV1): Promise<void>;
        awaitPublished(): Promise<boolean>;
      }>,
    ) => Promise<T>,
  ): Promise<T>;
  /** Reconcile only after the exact durable Job is proved cancelled and unstarted. */
  deferBeforeExecution?(jobId: string): Promise<boolean>;
  onIneligible(): void;
}

export type CreateProtectedTaskJobInput = Readonly<{
  scheduling: ProtectedTaskJobSchedulingFacts;
  reference: ProtectedTaskJobReferenceV1;
  executor: JobExecutor;
  candidate: ProtectedTaskExecutionCandidate;
  modelAttribution?: "external";
}>;
