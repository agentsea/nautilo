import type { JobExecutor } from "../job";
import type {
  CreateProtectedTaskJobInput,
  ProtectedTaskExecutionCandidate,
  ProtectedTaskJobSchedulingFacts,
} from "./protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from "./protected-task-job-reference";
import type {
  ProtectedTaskOccurrence,
  ProtectedTaskOccurrencePort,
} from "./task-observer";

/** The JobManager slice used after an exact authorization claim succeeds. */
export interface ProtectedTaskOccurrenceJobManager {
  createProtectedTaskJob(
    input: CreateProtectedTaskJobInput,
  ): Promise<Readonly<{ id: string; virtualJobId: string }>>;
}

/**
 * A one-use, already-claimed dispatch. The claim port must obtain the durable
 * authorization CAS before returning this value. Its candidate remains opaque:
 * plaintext Task content may exist only inside `candidate.run` and must be
 * released when that callback returns.
 */
export type ClaimedProtectedTaskOccurrence = Readonly<{
  reference: ProtectedTaskJobReferenceV1;
  scheduling: ProtectedTaskJobSchedulingFacts;
  executor: JobExecutor;
  candidate: ProtectedTaskExecutionCandidate;
  modelAttribution?: "external";
}>;

export type ClaimProtectedTaskOccurrenceResult =
  | Readonly<{
    status: "awaiting_authorization" | "already_claimed" | "inactive";
  }>
  | Readonly<{
    status: "claimed";
    dispatch: ClaimedProtectedTaskOccurrence;
  }>;

/**
 * Server-owned crypto boundary. Implementations prepare or find the exact V3
 * Runtime request, retain its HPKE private key only in process memory, verify
 * current authority, and atomically claim the request before returning a
 * dispatch. A durable request alone can never produce a claimed dispatch.
 */
export interface ProtectedTaskOccurrenceClaimPort {
  prepareOrClaimExact(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ClaimProtectedTaskOccurrenceResult>;
}

export interface ProtectedTaskOccurrenceCoordinatorDeps {
  authorization: ProtectedTaskOccurrenceClaimPort;
  jobManager: ProtectedTaskOccurrenceJobManager;
  /** Wakes the observer after an accepted device response. */
  kick(): void;
}

function rejectCandidate(candidate: ProtectedTaskExecutionCandidate): void {
  try {
    candidate.onIneligible();
  } catch {
    // Closed rejection remains authoritative over cleanup diagnostics.
  }
}

function exactDispatch(
  occurrence: ProtectedTaskOccurrence,
  dispatch: ClaimedProtectedTaskOccurrence,
): CreateProtectedTaskJobInput {
  const { reference, scheduling, candidate, executor } = dispatch;
  if (
    reference.taskId !== occurrence.task.id
    || reference.taskRunId !== occurrence.run.id
    || reference.inputObjectId !== occurrence.task.cryptoObjectId
    || scheduling.ownerId !== occurrence.task.ownerId
    || scheduling.requestorId !== occurrence.task.requestorId
    || scheduling.agentId !== occurrence.task.agentId
    || scheduling.callingRoomId !== occurrence.task.callingRoomId
    || scheduling.graphThreadId !== occurrence.run.graphThreadId
  ) {
    rejectCandidate(candidate);
    throw new TypeError(
      "Claimed protected Task dispatch disagrees with its exact occurrence",
    );
  }
  return {
    scheduling,
    reference,
    executor,
    candidate,
    ...(dispatch.modelAttribution === undefined
      ? {}
      : { modelAttribution: dispatch.modelAttribution }),
  };
}

/**
 * Bridge from the content-free Task observer to the server-owned Runtime
 * authorization and Job boundaries. Ordinary Tasks never cross this class.
 */
export class ProtectedTaskOccurrenceCoordinator
implements ProtectedTaskOccurrencePort {
  private readonly observationsInFlight = new Set<string>();

  constructor(private readonly deps: ProtectedTaskOccurrenceCoordinatorDeps) {}

  /**
   * Device grant acceptance is automatic. The response route calls this after
   * its exact durable CAS; the normal observer recovery page then re-offers the
   * awaiting occurrence without changing the Task to a user-paused state.
   */
  authorizationAccepted(): void {
    this.deps.kick();
  }

  async observeProtectedTaskOccurrence(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<void> {
    const occurrenceId = occurrence.run.id;
    if (this.observationsInFlight.has(occurrenceId)) return;
    this.observationsInFlight.add(occurrenceId);
    try {
      const claimed = await this.deps.authorization.prepareOrClaimExact(
        occurrence,
      );
      if (claimed.status !== "claimed") return;
      await this.deps.jobManager.createProtectedTaskJob(
        exactDispatch(occurrence, claimed.dispatch),
      );
    } finally {
      this.observationsInFlight.delete(occurrenceId);
    }
  }
}

export function createProtectedTaskOccurrenceCoordinator(
  deps: ProtectedTaskOccurrenceCoordinatorDeps,
): ProtectedTaskOccurrenceCoordinator {
  return new ProtectedTaskOccurrenceCoordinator(deps);
}
