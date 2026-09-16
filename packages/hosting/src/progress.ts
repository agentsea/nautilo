/** Redacted hosting-progress contract shared by installed CLI and future Cloud workers. */
export const HOST_PROGRESS_SCHEMA_VERSION = 1 as const;

export type HostProgressMode = "auto" | "plain" | "jsonl" | "none";
export type HostProgressKind = "started" | "completed" | "heartbeat" | "retry" | "warning" | "terminal";
export type HostProgressEvent = Readonly<{
  readonly schemaVersion: typeof HOST_PROGRESS_SCHEMA_VERSION;
  readonly launchId?: string;
  readonly stage: string;
  readonly kind: HostProgressKind;
  readonly elapsedMs: number;
  readonly messageCode: string;
}>;
export interface HostProgressSink { emit(event: HostProgressEvent): void; }
export interface HostProgressClock { now(): number; }
export interface HostProgressCoordinator {
  emit(input: Omit<HostProgressEvent, "schemaVersion" | "launchId" | "elapsedMs">): void;
}

/** Stamps only typed events; rendering, storage, prompting, and sleeping stay outside. */
export function createHostProgressCoordinator(input: {
  readonly clock: HostProgressClock;
  readonly sink?: HostProgressSink | undefined;
  readonly launchId?: string | undefined;
}): HostProgressCoordinator {
  const startedAt = input.clock.now();
  return { emit(event) {
    if (input.sink === undefined) return;
    try {
      input.sink.emit({
        schemaVersion: HOST_PROGRESS_SCHEMA_VERSION,
        ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
        ...event,
        elapsedMs: Math.max(0, input.clock.now() - startedAt),
      });
    } catch {
      // Observation can never alter checkpointed hosting execution.
    }
  } };
}

export interface HostProgressScheduler extends HostProgressClock {
  sleep(milliseconds: number): Promise<void>;
  every(milliseconds: number, callback: () => void): () => void;
}
export interface HostInterruptController {
  readonly interrupted: () => boolean;
  /** Optional request cancellation authority for provider/HTTPS transports. */
  readonly signal?: AbortSignal | undefined;
  dispose(): void;
}
export interface HostPollingAttempt<State> {
  readonly state: State;
  readonly outcome: "complete" | "pending" | "failure";
  readonly failureCode?: string | undefined;
  readonly durableStageTransitions?: boolean | undefined;
}
export interface HostPollingResult<State> {
  readonly state: State;
  readonly outcome: "complete" | "pending" | "failure" | "interrupted";
  readonly failureCode?: string | undefined;
}

/** Process-free polling adapter for CLI and Cloud orchestration. */
export async function pollHostProgress<State>(input: {
  readonly initialState: State;
  readonly stage: (state: State) => string;
  readonly execute: (state: State) => Promise<HostPollingAttempt<State>>;
  readonly coordinator: HostProgressCoordinator;
  readonly scheduler: HostProgressScheduler;
  readonly interruption: HostInterruptController;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly heartbeatIntervalMs: number;
}): Promise<HostPollingResult<State>> {
  let state = input.initialState;
  let outcome: HostPollingResult<State>["outcome"] = "pending";
  let failureCode: string | undefined;
  let attempts = 0;
  let lastHeartbeatAt = input.scheduler.now();
  const heartbeat = () => {
    if (input.scheduler.now() - lastHeartbeatAt < input.heartbeatIntervalMs) return;
    input.coordinator.emit({ stage: input.stage(state), kind: "heartbeat", messageCode: "hosting.poll.heartbeat" });
    lastHeartbeatAt = input.scheduler.now();
  };
  input.coordinator.emit({ stage: input.stage(state), kind: "started", messageCode: "hosting.stage.started" });
  let stopHeartbeat: () => void;
  try {
    stopHeartbeat = input.scheduler.every(input.heartbeatIntervalMs, heartbeat);
  } catch {
    input.coordinator.emit({ stage: input.stage(state), kind: "terminal", messageCode: "hosting.scheduler.failed" });
    return { state, outcome: "failure", failureCode: "hosting.progress.scheduler-failed" };
  }
  try {
    while (attempts < input.maxAttempts && outcome === "pending") {
      if (input.interruption.interrupted()) {
        input.coordinator.emit({ stage: input.stage(state), kind: "terminal", messageCode: "hosting.interrupted" });
        return { state, outcome: "interrupted" };
      }
      const priorStage = input.stage(state);
      let attempt: HostPollingAttempt<State>;
      try { attempt = await input.execute(state); } catch {
        input.coordinator.emit({ stage: priorStage, kind: "terminal", messageCode: "hosting.execution.failed" });
        return { state, outcome: "failure", failureCode: "hosting.progress.execution-failed" };
      }
      attempts += 1;
      state = attempt.state;
      outcome = attempt.outcome;
      failureCode = attempt.failureCode;
      const nextStage = input.stage(state);
      if (nextStage !== priorStage && attempt.durableStageTransitions !== true) {
        input.coordinator.emit({ stage: priorStage, kind: "completed", messageCode: "hosting.stage.completed" });
        input.coordinator.emit({ stage: nextStage, kind: "started", messageCode: "hosting.stage.started" });
      }
      if (outcome !== "pending") break;
      input.coordinator.emit({ stage: nextStage, kind: "retry", messageCode: "hosting.poll.retry" });
      try { await input.scheduler.sleep(input.retryDelayMs); } catch {
        input.coordinator.emit({ stage: nextStage, kind: "terminal", messageCode: "hosting.scheduler.failed" });
        return { state, outcome: "failure", failureCode: "hosting.progress.scheduler-failed" };
      }
      heartbeat();
    }
    if (outcome === "pending") input.coordinator.emit({ stage: input.stage(state), kind: "terminal", messageCode: "hosting.poll.pending" });
    else if (outcome === "failure") input.coordinator.emit({ stage: input.stage(state), kind: "terminal", messageCode: "hosting.failed" });
    else {
      input.coordinator.emit({ stage: input.stage(state), kind: "completed", messageCode: "hosting.stage.completed" });
      input.coordinator.emit({ stage: input.stage(state), kind: "terminal", messageCode: "hosting.complete" });
    }
    return { state, outcome, ...(failureCode === undefined ? {} : { failureCode }) };
  } finally {
    try { stopHeartbeat(); } catch {
      // Observation timer cleanup cannot replace the deployment result.
    }
  }
}
