import type { JobExecutor } from "../job";
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

/**
 * One process-local accepted authority. Implementations open the protected
 * Task definition inside `run`, release all plaintext and capability material
 * before it returns, and cannot be reconstructed from the durable reference.
 */
export interface ProtectedTaskExecutionCandidate {
  run<T>(
    work: (
      transientInput: Record<string, unknown>,
      authorizationSignal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
  onIneligible(): void;
}

export type CreateProtectedTaskJobInput = Readonly<{
  scheduling: ProtectedTaskJobSchedulingFacts;
  reference: ProtectedTaskJobReferenceV1;
  executor: JobExecutor;
  candidate: ProtectedTaskExecutionCandidate;
  modelAttribution?: "external";
}>;
