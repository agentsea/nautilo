import { error as logError, log, warn } from "@nautilo/logger";
import {
  DURABLE_SLEEP_ALL_STAGE_ADMISSION,
  DurableSleepLatencyWindow,
  runDurableHierarchySleep,
  type DurableSleepRunBudget,
  type DurableSleepRunResult,
  type DurableSleepSemanticPort,
  type DurableSleepStageAdmission,
  type DurableSleepWorkPort,
} from "@nautilo/reflection";
import {
  EMPTY_REFLECTION_SEMANTIC_LATENCY,
  type ReflectionSemanticPressureReason,
  type ReflectionSemanticSchedulerStatus,
} from "@nautilo/types";

import type { MaintenanceGate } from "../maintenance-controller";

export type ReflectionSemanticWorkerHealthEvent =
  | Readonly<{
      status: "completed";
      result: DurableSleepRunResult;
      bootstrapAdmitted: number;
    }>
  | Readonly<{
      status: "skipped";
      reason: "maintenance";
    }>
  | Readonly<{
      status: "failed";
      failureCode: "unexpected_failure";
    }>;

export interface ReflectionSemanticWorkerDeps {
  maintenanceGate: Pick<MaintenanceGate, "isAcceptingWork">;
  work: DurableSleepWorkPort;
  semantic: DurableSleepSemanticPort;
  /** One declared, bounded budget is shared by every wakeup and timer poll. */
  budget: DurableSleepRunBudget;
  /** Lattice-owned stage ceiling resolved before any admission or claim. */
  resolveStageAdmission?(
    signal?: AbortSignal,
  ): Promise<DurableSleepStageAdmission>;
  bootstrap?: {
    bootstrapPage(input: Readonly<{
      limit: number;
      continuation?: string;
      stageAdmission: DurableSleepStageAdmission;
    }>): Promise<Readonly<{ admitted: number; continuation?: string }>>;
  };
  /** Aggregate durable state only; no Record or source coordinate crosses this seam. */
  readPressure?(): Promise<Readonly<{
    backlog: number;
    ready: number;
    oldestDueAt: Date | null;
  }>>;
  runSleep?: typeof runDurableHierarchySleep;
  onHealth?(event: ReflectionSemanticWorkerHealthEvent): void;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface ReflectionSemanticPressurePolicy {
  readonly maxPollElapsedMs: number;
  readonly pressureProbeIntervalMs: number;
  readonly repeatedFailureThreshold: number;
  readonly backlogGrowthPolls: number;
  readonly rollingWindowPolls: number;
  readonly amplificationMinimumCreated: number;
  readonly amplificationRatioPercent: number;
}

interface ReflectionSemanticWorkerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface ReflectionSemanticWorkerOptions {
  scanIntervalMs?: number;
  catchUpIntervalMs?: number;
  shutdownWaitMs?: number;
  pressure?: Partial<ReflectionSemanticPressurePolicy>;
  /** Deterministic virtual-clock seam. Production always uses the default clock. */
  clock?: ReflectionSemanticWorkerClock;
}

const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_CATCH_UP_INTERVAL_MS = 2_000;
const DEFAULT_SHUTDOWN_WAIT_MS = 10_000;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/**
 * V1 is anchored to existing contracts: one poll cannot outlive the two-minute
 * semantic-work lease; three failed polls match the existing degraded-attempt
 * threshold; four 15-second growth samples require a full delayed-health minute;
 * and an eight-poll window spans one lease. Parent-creation ratios remain an
 * operator diagnostic, but durable FIFO work admission—not a global pause—owns
 * recursive follow-up. A breaker probes real pressure every five minutes.
 */
export const REFLECTION_SEMANTIC_PRESSURE_POLICY_V1 = Object.freeze({
  maxPollElapsedMs: 2 * 60 * 1_000,
  pressureProbeIntervalMs: 5 * 60 * 1_000,
  repeatedFailureThreshold: 3,
  backlogGrowthPolls: 4,
  rollingWindowPolls: 8,
  amplificationMinimumCreated: 4,
  amplificationRatioPercent: 75,
} satisfies ReflectionSemanticPressurePolicy);

const SYSTEM_CLOCK: ReflectionSemanticWorkerClock = Object.freeze({
  now: () => Date.now(),
  setTimer(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

function requirePositiveMilliseconds(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(MAX_COUNTER, left + right);
}

function resultDatabaseWork(result: DurableSleepRunResult, bootstrapAdmitted: number): number {
  // This is a bounded durable-operation count, not an assertion about SQL query count.
  return [
    bootstrapAdmitted,
    result.claimed,
    result.checkpointed,
    result.completed,
    result.deferred,
    result.paused,
    result.quarantined,
    result.recovered,
    result.superseded,
    result.leaseLost,
  ].reduce(saturatingAdd, 0);
}

function resultMadeDurableProgress(result: DurableSleepRunResult): boolean {
  return [
    result.checkpointed,
    result.completed,
    result.deferred,
    result.paused,
    result.quarantined,
    result.recovered,
    result.superseded,
    result.leaseLost,
  ].some((count) => count > 0);
}

function resultLogFields(
  result: DurableSleepRunResult,
  bootstrapAdmitted: number,
  elapsedMs: number,
  schedulerState: ReflectionSemanticSchedulerStatus["state"],
  pauseReason: ReflectionSemanticPressureReason | null,
): Record<string, unknown> {
  return {
    schedulerState,
    pauseReason,
    elapsedMs,
    bootstrapAdmitted,
    claimed: result.claimed,
    checkpointed: result.checkpointed,
    completed: result.completed,
    deferred: result.deferred,
    paused: result.paused,
    quarantined: result.quarantined,
    recovered: result.recovered,
    superseded: result.superseded,
    leaseLost: result.leaseLost,
    budgetExhausted: result.budgetExhausted,
    modelCalls: result.usage.modelCalls,
    modelFailures: result.diagnostics.modelFailures,
    modelRetryAfterMilliseconds: result.modelRetryAfterMilliseconds ?? 0,
    authorityElapsedMs: result.diagnostics.authorityElapsedMs,
    searchProjectionElapsedMs: result.diagnostics.searchProjectionElapsedMs,
    candidateElapsedMs: result.diagnostics.candidateElapsedMs,
    modelElapsedMs: result.diagnostics.modelElapsedMs,
    publicationElapsedMs: result.diagnostics.publicationElapsedMs,
    deterministicNoChanges: result.diagnostics.deterministicNoChanges,
    modelBatches: result.diagnostics.modelBatches,
    modelBatchItems: result.diagnostics.modelBatchItems,
    batchStaleRescheduled: result.diagnostics.batchStaleRescheduled,
    visitedRecords: result.usage.visitedRecords,
    createdRecords: result.usage.createdRecords,
    traversalWork: result.usage.traversalWork,
    operationCounts: result.operations,
    failureCounts: result.failures,
    failureDetailCounts: result.failureDetails ?? {},
    terminalOutcomeCounts: result.terminalOutcomes,
    planningCounts: result.planning,
  };
}

function emptyLastPollDiagnostics() {
  return {
    modelFailures: 0,
    authorityElapsedMs: 0,
    searchProjectionElapsedMs: 0,
    candidateElapsedMs: 0,
    modelElapsedMs: 0,
    publicationElapsedMs: 0,
    deterministicNoChanges: 0,
    sameRoomPlans: 0,
    crossRoomPlans: 0,
    sameRoomCompletions: 0,
    crossRoomCompletions: 0,
    candidatesOpened: 0,
    unsupportedAuthorityShapes: 0,
    stalePlans: 0,
    capacityOutcomes: 0,
    noEffectiveAudience: 0,
    protectedExecutionUnavailable: 0,
  } as const;
}

interface WindowSample {
  readonly admitted: number;
  readonly completed: number;
  readonly created: number;
}

interface BacklogSample {
  readonly size: number;
  readonly ready: number;
  readonly oldestAgeMs: number;
}

type ReflectionSemanticFailurePhase =
  | "maintenance_gate"
  | "stage_admission"
  | "bootstrap"
  | "sleep"
  | "pressure_read"
  | "unknown";

class ReflectionSemanticPollPhaseError extends Error {
  constructor(readonly phase: ReflectionSemanticFailurePhase) {
    super("Reflection semantic poll phase failed");
  }
}

async function runPollPhase<Result>(
  phase: Exclude<ReflectionSemanticFailurePhase, "unknown">,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch {
    throw new ReflectionSemanticPollPhaseError(phase);
  }
}

type PollOutcome =
  | Readonly<{
      status: "completed";
      result: DurableSleepRunResult;
      bootstrapAdmitted: number;
      backlog: BacklogSample;
    }>
  | Readonly<{ status: "skipped"; reason: "maintenance" }>
  | Readonly<{ status: "aborted" }>;

export function disabledReflectionSemanticSchedulerStatus(
  recoveryIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
): ReflectionSemanticSchedulerStatus {
  return Object.freeze({
    state: "disabled",
    pauseReason: null,
    recoveryIntervalMs,
    nextEligiblePollAt: null,
    lastPoll: null,
    window: Object.freeze({ polls: 0, admitted: 0, completed: 0, created: 0 }),
    backlog: Object.freeze({ size: 0, oldestAgeMs: 0 }),
    latency: EMPTY_REFLECTION_SEMANTIC_LATENCY,
    amplification: "normal",
  });
}

/**
 * Runtime-owned supervision for durable, change-driven Reflection work.
 *
 * One completion-relative timeout owns recovery. Healthy runnable backlog uses
 * a short bounded catch-up interval; idle, provider-retry, and pressure lanes
 * retain their conservative delays. Durable admissions never bypass the active
 * delay. Pressure counters are process-local; durable work remains canonical.
 */
export class ReflectionSemanticWorker {
  private readonly scanIntervalMs: number;
  private readonly catchUpIntervalMs: number;
  private readonly shutdownWaitMs: number;
  private readonly pressure: ReflectionSemanticPressurePolicy;
  private readonly clock: ReflectionSemanticWorkerClock;
  private readonly logger: NonNullable<ReflectionSemanticWorkerDeps["logger"]>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAtMs: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private bootstrapContinuation: string | undefined;
  private stopped = true;
  private lifecycleToken: object = {};
  private schedulerState: ReflectionSemanticSchedulerStatus["state"] = "disabled";
  private pauseReason: ReflectionSemanticPressureReason | null = null;
  private probingReason: ReflectionSemanticPressureReason | null = null;
  private nextEligibleAtMs: number | null = null;
  private pressureProbeAtMs: number | null = null;
  private pollExceededBudget = false;
  private pendingAdmissions = 0;
  private consecutiveFailures = 0;
  private backlogGrowthCount = 0;
  private lastBacklog: BacklogSample | null = null;
  private readonly window: WindowSample[] = [];
  private readonly latencyWindow = new DurableSleepLatencyWindow();
  private lastPoll: ReflectionSemanticSchedulerStatus["lastPoll"] = null;

  constructor(
    private readonly deps: ReflectionSemanticWorkerDeps,
    options: ReflectionSemanticWorkerOptions = {},
  ) {
    this.scanIntervalMs = requirePositiveMilliseconds(
      "Reflection semantic scan interval",
      options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
    );
    this.catchUpIntervalMs = requirePositiveMilliseconds(
      "Reflection semantic catch-up interval",
      options.catchUpIntervalMs ?? DEFAULT_CATCH_UP_INTERVAL_MS,
    );
    this.shutdownWaitMs = requirePositiveMilliseconds(
      "Reflection semantic shutdown wait",
      options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS,
    );
    this.pressure = Object.freeze({
      ...REFLECTION_SEMANTIC_PRESSURE_POLICY_V1,
      ...options.pressure,
    });
    requirePositiveMilliseconds(
      "Reflection semantic maximum poll elapsed",
      this.pressure.maxPollElapsedMs,
    );
    requirePositiveMilliseconds(
      "Reflection semantic pressure probe interval",
      this.pressure.pressureProbeIntervalMs,
    );
    requirePositiveInteger(
      "Reflection semantic repeated failure threshold",
      this.pressure.repeatedFailureThreshold,
    );
    requirePositiveInteger(
      "Reflection semantic backlog growth polls",
      this.pressure.backlogGrowthPolls,
    );
    requirePositiveInteger(
      "Reflection semantic rolling window polls",
      this.pressure.rollingWindowPolls,
    );
    requirePositiveInteger(
      "Reflection semantic amplification minimum",
      this.pressure.amplificationMinimumCreated,
    );
    if (
      !Number.isSafeInteger(this.pressure.amplificationRatioPercent)
      || this.pressure.amplificationRatioPercent < 1
      || this.pressure.amplificationRatioPercent > 100
    ) throw new RangeError("Reflection semantic amplification ratio must be 1..100");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.logger = deps.logger ?? {
      info: (message, fields) => log(message, fields),
      warn: (message, fields) => warn(message, fields),
      error: (message, fields) => logError(message, fields),
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.lifecycleToken = {};
    this.stopped = false;
    this.pauseReason = null;
    this.pressureProbeAtMs = null;
    this.scheduleAt(Math.max(this.clock.now(), this.nextEligibleAtMs ?? 0));
  }

  /** Coalesce admission notifications into one rate-limited recovery poll. */
  wakeup(admitted = 0): void {
    if (!Number.isSafeInteger(admitted) || admitted < 0) {
      throw new RangeError("Reflection semantic admitted count must be non-negative");
    }
    if (this.stopped) return;
    this.pendingAdmissions = saturatingAdd(this.pendingAdmissions, admitted);
    if (this.inFlight !== null) return;
    const now = this.clock.now();
    const target = this.schedulerState === "pressure_paused" && admitted === 0
      ? Math.max(now, this.pressureProbeAtMs ?? now)
      : Math.max(now, this.nextEligibleAtMs ?? now);
    this.scheduleAt(target);
  }

  getHealth(): ReflectionSemanticSchedulerStatus {
    const window = this.getWindowTotals();
    const backlog = this.lastBacklog;
    return Object.freeze({
      state: this.stopped ? "disabled" : this.schedulerState,
      pauseReason: this.stopped ? null : this.pauseReason,
      recoveryIntervalMs: this.scanIntervalMs,
      nextEligiblePollAt: this.stopped || this.nextEligibleAtMs === null
        ? null
        : new Date(this.nextEligibleAtMs).toISOString(),
      lastPoll: this.lastPoll === null ? null : Object.freeze({ ...this.lastPoll }),
      window: Object.freeze(window),
      backlog: Object.freeze({
        size: backlog?.size ?? 0,
        oldestAgeMs: backlog?.oldestAgeMs ?? 0,
      }),
      latency: this.latencyWindow.snapshot(),
      amplification: this.amplificationClassification(window),
    });
  }

  private scheduleAt(targetMs: number): void {
    if (this.stopped || this.inFlight !== null) return;
    if (this.timer !== null && this.timerAtMs !== null && this.timerAtMs <= targetMs) return;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.nextEligibleAtMs = targetMs;
    this.timerAtMs = targetMs;
    this.schedulerState = this.pauseReason === null ? "cooldown" : "pressure_paused";
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.timerAtMs = null;
      this.beginPoll();
    }, Math.max(0, targetMs - this.clock.now()));
  }

  private beginPoll(): void {
    // An unexpected timer race while active is dropped, never converted into a
    // follow-up bit. Completion owns the next recovery timer.
    if (this.stopped || this.inFlight !== null) return;
    const startedAt = this.clock.now();
    const admissionsAtStart = this.pendingAdmissions;
    this.pendingAdmissions = 0;
    if (this.schedulerState === "pressure_paused") {
      this.probingReason = this.pauseReason;
      this.window.splice(0);
      this.consecutiveFailures = 0;
      this.backlogGrowthCount = 0;
      this.pauseReason = null;
      this.pressureProbeAtMs = null;
    }
    this.schedulerState = "running";
    this.nextEligibleAtMs = null;
    this.pollExceededBudget = false;
    const controller = new AbortController();
    const lifecycleToken = this.lifecycleToken;
    this.activeController = controller;
    this.deadlineTimer = this.clock.setTimer(() => {
      this.deadlineTimer = null;
      if (
        this.stopped
        || this.lifecycleToken !== lifecycleToken
        || this.activeController !== controller
      ) return;
      this.pollExceededBudget = true;
      this.openPressure("elapsed_budget", this.clock.now());
      this.safeLog("warn", "[reflection] semantic poll deadline exceeded", {
        schedulerState: this.schedulerState,
        pauseReason: this.pauseReason,
        failurePhase: "sleep",
        failureCode: "elapsed_budget",
      });
      controller.abort();
      // Abort is cooperative, so a provider may never settle. Detach this poll
      // generation at the deadline and schedule the breaker probe directly.
      // The token fences eventual completion; the probe interval exceeds the
      // durable lease, which fences any persisted work from this stale owner.
      this.lifecycleToken = {};
      this.activeController = null;
      this.inFlight = null;
      this.scheduleAt(this.pressureProbeAtMs ?? this.clock.now());
    }, this.pressure.maxPollElapsedMs);

    const running = this.runOnce(controller.signal)
      .then((outcome) => {
        if (this.lifecycleToken === lifecycleToken) {
          this.finishPoll(outcome, startedAt, admissionsAtStart);
        }
      })
      .catch((error: unknown) => {
        if (this.lifecycleToken === lifecycleToken) {
          this.finishFailure(
            startedAt,
            admissionsAtStart,
            error instanceof ReflectionSemanticPollPhaseError ? error.phase : "unknown",
          );
        }
      })
      .finally(() => {
        if (this.inFlight !== running) return;
        this.inFlight = null;
        this.activeController = null;
        if (this.deadlineTimer !== null) {
          this.clock.clearTimer(this.deadlineTimer);
          this.deadlineTimer = null;
        }
        if (this.stopped) return;
        const now = this.clock.now();
        if (this.lifecycleToken !== lifecycleToken) {
          this.scheduleAt(Math.max(now, this.nextEligibleAtMs ?? now));
          return;
        }
        const target = this.pauseReason === null
          ? Math.max(now, this.nextEligibleAtMs ?? now + this.scanIntervalMs)
          : this.pendingAdmissions > 0
            ? Math.max(now + this.scanIntervalMs, this.nextEligibleAtMs ?? 0)
            : Math.max(this.pressureProbeAtMs ?? now, this.nextEligibleAtMs ?? 0);
        this.scheduleAt(target);
      });
    this.inFlight = running;
  }

  private async runOnce(signal: AbortSignal): Promise<PollOutcome> {
    if (this.stopped || signal.aborted) return { status: "aborted" };
    if (!(await runPollPhase(
      "maintenance_gate",
      () => this.deps.maintenanceGate.isAcceptingWork(),
    ))) {
      return { status: "skipped", reason: "maintenance" };
    }
    if (this.stopped || signal.aborted) return { status: "aborted" };
    const resolvedStageAdmission = await runPollPhase(
      "stage_admission",
      () => this.deps.resolveStageAdmission?.(signal)
        ?? Promise.resolve(DURABLE_SLEEP_ALL_STAGE_ADMISSION),
    );
    if (![
      "authority_projection",
      "search_projection",
      "organization",
    ].includes(resolvedStageAdmission.maximumStage)) {
      throw new ReflectionSemanticPollPhaseError("stage_admission");
    }
    const stageAdmission: DurableSleepStageAdmission = Object.freeze({
      maximumStage: resolvedStageAdmission.maximumStage,
    });
    if (this.stopped || signal.aborted) return { status: "aborted" };
    let bootstrapAdmitted = 0;
    const bootstrap = this.deps.bootstrap;
    if (bootstrap !== undefined) {
      const page = await runPollPhase("bootstrap", () =>
        bootstrap.bootstrapPage({
          limit: this.deps.budget.maxWorkItems,
          stageAdmission,
          ...(this.bootstrapContinuation === undefined
            ? {}
            : { continuation: this.bootstrapContinuation }),
        }));
      if (signal.aborted || this.stopped) return { status: "aborted" };
      if (
        !Number.isSafeInteger(page.admitted)
        || page.admitted < 0
        || page.admitted > this.deps.budget.maxWorkItems
      ) throw new TypeError("Reflection bootstrap returned an invalid admitted count");
      bootstrapAdmitted = page.admitted;
      this.bootstrapContinuation = page.continuation;
    }
    // Bootstrap admission and semantic execution are separate bounded lanes.
    // Charging admissions against Sleep lets a full bootstrap page starve
    // expired-lease recovery and all ready work indefinitely.
    const result = await runPollPhase("sleep", () =>
      (this.deps.runSleep ?? runDurableHierarchySleep)({
          work: this.deps.work,
          semantic: this.deps.semantic,
          budget: this.deps.budget,
          stageAdmission,
          signal,
        }));
    if (signal.aborted || this.stopped) return { status: "aborted" };
    const pressure = await runPollPhase("pressure_read", () => this.readPressure());
    if (signal.aborted || this.stopped) return { status: "aborted" };
    return { status: "completed", result, bootstrapAdmitted, backlog: pressure };
  }

  private async readPressure(): Promise<BacklogSample> {
    if (this.deps.readPressure === undefined) {
      return this.lastBacklog ?? { size: 0, ready: 0, oldestAgeMs: 0 };
    }
    const health = await this.deps.readPressure();
    if (!Number.isSafeInteger(health.backlog) || health.backlog < 0) {
      throw new TypeError("Reflection semantic backlog must be non-negative");
    }
    if (!Number.isSafeInteger(health.ready) || health.ready < 0) {
      throw new TypeError("Reflection semantic ready work must be non-negative");
    }
    return {
      size: health.backlog,
      ready: health.ready,
      oldestAgeMs: health.oldestDueAt === null
        ? 0
        : Math.max(0, this.clock.now() - health.oldestDueAt.getTime()),
    };
  }

  private finishPoll(
    outcome: PollOutcome,
    startedAt: number,
    admissionsAtStart: number,
  ): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - startedAt);
    this.nextEligibleAtMs = now + this.scanIntervalMs;
    if (this.pollExceededBudget) {
      this.lastPoll = Object.freeze({
        elapsedMs,
        claims: 0,
        databaseWork: 0,
        modelCalls: 0,
        ...emptyLastPollDiagnostics(),
      });
      this.addWindow({ admitted: admissionsAtStart, completed: 0, created: 0 });
      this.openPressure("elapsed_budget", now);
      return;
    }
    if (outcome.status === "aborted") return;
    if (outcome.status === "skipped") {
      this.schedulerState = "cooldown";
      this.emitHealth(outcome);
      return;
    }

    const { result, bootstrapAdmitted } = outcome;
    this.latencyWindow.add(result.completedItemLatencies);
    // The store's aggregate readiness is intentionally representation-neutral.
    // A completed claim pass is the authoritative admission probe: when it
    // found no claim, rows reported ready are gated by the current stage or
    // representation policy and must not keep this worker on the catch-up loop.
    // Keep the total backlog and its age intact for truthful health reporting.
    const admittedReady = result.claimed === 0 ? 0 : outcome.backlog.ready;
    const healthyIntervalMs = admittedReady > 0
      ? this.catchUpIntervalMs
      : this.scanIntervalMs;
    this.nextEligibleAtMs = now + Math.max(
      healthyIntervalMs,
      result.modelRetryAfterMilliseconds ?? 0,
    );
    const previousBacklog = this.lastBacklog;
    this.lastBacklog = outcome.backlog;
    this.lastPoll = Object.freeze({
      elapsedMs,
      claims: result.claimed,
      databaseWork: resultDatabaseWork(result, bootstrapAdmitted),
      modelCalls: result.usage.modelCalls,
      modelFailures: result.diagnostics.modelFailures,
      authorityElapsedMs: result.diagnostics.authorityElapsedMs,
      searchProjectionElapsedMs: result.diagnostics.searchProjectionElapsedMs,
      candidateElapsedMs: result.diagnostics.candidateElapsedMs,
      modelElapsedMs: result.diagnostics.modelElapsedMs,
      publicationElapsedMs: result.diagnostics.publicationElapsedMs,
      deterministicNoChanges: result.diagnostics.deterministicNoChanges,
      sameRoomPlans: result.planning.sameRoomPlans,
      crossRoomPlans: result.planning.crossRoomPlans,
      sameRoomCompletions: result.planning.sameRoomCompletions,
      crossRoomCompletions: result.planning.crossRoomCompletions,
      candidatesOpened: result.planning.candidatesOpened,
      unsupportedAuthorityShapes:
        result.planning.unsupportedAuthorityShapes
        + (result.terminalOutcomes.unsupported_authority_shape ?? 0),
      stalePlans:
        (result.failureDetails?.candidate_projection_stale ?? 0)
        + (result.failureDetails?.candidate_fence_stale ?? 0)
        + (result.failureDetails?.candidate_record_changed ?? 0),
      capacityOutcomes:
        (result.failureDetails?.candidate_topology_capacity_exceeded ?? 0)
        + (result.failureDetails?.parent_conflict_capacity_exceeded ?? 0),
      noEffectiveAudience:
        result.terminalOutcomes.no_effective_audience ?? 0,
      protectedExecutionUnavailable:
        result.planning.protectedExecutionUnavailable
        + (result.terminalOutcomes.protected_execution_unavailable ?? 0),
    });
    this.addWindow({
      admitted: saturatingAdd(admissionsAtStart, bootstrapAdmitted),
      completed: result.completed,
      // Immutable successors are healthy evolution of one logical parent.
      // Only brand-new parent roots can amplify graph breadth.
      created: result.operations.create_parent,
    });
    // Record-local typed deferrals have their own bounded retry/quarantine
    // lifecycle. Only an unexpected lane/system failure may trip the global
    // breaker and stop unrelated Records from progressing.
    const madeDurableProgress = resultMadeDurableProgress(result);
    const systemFailures = result.failures.unexpected_failure ?? 0;
    this.consecutiveFailures = systemFailures > 0 && !madeDurableProgress
      ? saturatingAdd(this.consecutiveFailures, 1)
      : 0;
    this.backlogGrowthCount = !madeDurableProgress
      && bootstrapAdmitted === 0
      && previousBacklog !== null
      && outcome.backlog.size > previousBacklog.size
      && outcome.backlog.oldestAgeMs >= previousBacklog.oldestAgeMs
      ? saturatingAdd(this.backlogGrowthCount, 1)
      : 0;

    const probeStillPressured = this.probingReason === "repeated_failure"
        && systemFailures > 0 && !madeDurableProgress
      ? "repeated_failure" as const
      : this.probingReason === "backlog_growth"
          && !madeDurableProgress
          && bootstrapAdmitted === 0
          && previousBacklog !== null
          && outcome.backlog.size >= previousBacklog.size
          && outcome.backlog.oldestAgeMs >= previousBacklog.oldestAgeMs
        ? "backlog_growth" as const
        : null;
    const reason = probeStillPressured ?? this.pressureReason();
    if (reason === null) {
      this.schedulerState = "cooldown";
      this.pauseReason = null;
      this.probingReason = null;
    } else {
      this.openPressure(reason, now);
    }
    this.emitHealth({ status: "completed", result, bootstrapAdmitted });
    this.safeLog(
      result.quarantined > 0 || this.pauseReason !== null ? "warn" : "info",
      "[reflection] semantic poll completed",
      resultLogFields(
        result,
        bootstrapAdmitted,
        elapsedMs,
        this.schedulerState,
        this.pauseReason,
      ),
    );
  }

  private finishFailure(
    startedAt: number,
    admissionsAtStart: number,
    failurePhase: ReflectionSemanticFailurePhase,
  ): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - startedAt);
    this.nextEligibleAtMs = now + this.scanIntervalMs;
    this.lastPoll = Object.freeze({
      elapsedMs,
      claims: 0,
      databaseWork: 0,
      modelCalls: 0,
      ...emptyLastPollDiagnostics(),
    });
    this.addWindow({ admitted: admissionsAtStart, completed: 0, created: 0 });
    this.consecutiveFailures = saturatingAdd(this.consecutiveFailures, 1);
    if (this.pollExceededBudget) this.openPressure("elapsed_budget", now);
    else if (this.probingReason !== null) this.openPressure(this.probingReason, now);
    else if (this.consecutiveFailures >= this.pressure.repeatedFailureThreshold) {
      this.openPressure("repeated_failure", now);
    } else {
      this.schedulerState = "cooldown";
      this.pauseReason = null;
    }
    this.emitHealth({ status: "failed", failureCode: "unexpected_failure" });
    this.safeLog("error", "[reflection] semantic poll failed", {
      schedulerState: this.schedulerState,
      pauseReason: this.pauseReason,
      failurePhase,
      failureCode: "unexpected_failure",
    });
  }

  private addWindow(sample: WindowSample): void {
    this.window.push(sample);
    if (this.window.length > this.pressure.rollingWindowPolls) this.window.shift();
  }

  private amplificationClassification(window = this.getWindowTotals()):
    ReflectionSemanticSchedulerStatus["amplification"] {
    if (window.created < this.pressure.amplificationMinimumCreated) return "normal";
    const pressure = window.created * 100
      >= Math.max(1, window.completed) * this.pressure.amplificationRatioPercent;
    return pressure ? "pressure" : "watch";
  }

  private getWindowTotals(): ReflectionSemanticSchedulerStatus["window"] {
    return this.window.reduce<ReflectionSemanticSchedulerStatus["window"]>(
      (aggregate, sample) => ({
        polls: saturatingAdd(aggregate.polls, 1),
        admitted: saturatingAdd(aggregate.admitted, sample.admitted),
        completed: saturatingAdd(aggregate.completed, sample.completed),
        created: saturatingAdd(aggregate.created, sample.created),
      }),
      { polls: 0, admitted: 0, completed: 0, created: 0 },
    );
  }

  private pressureReason(): ReflectionSemanticPressureReason | null {
    if (this.consecutiveFailures >= this.pressure.repeatedFailureThreshold) {
      return "repeated_failure";
    }
    if (this.backlogGrowthCount >= this.pressure.backlogGrowthPolls) {
      return "backlog_growth";
    }
    return null;
  }

  private openPressure(reason: ReflectionSemanticPressureReason, now: number): void {
    this.pauseReason = reason;
    this.probingReason = null;
    this.schedulerState = "pressure_paused";
    this.pressureProbeAtMs = now + this.pressure.pressureProbeIntervalMs;
    this.nextEligibleAtMs = this.pressureProbeAtMs;
  }

  private emitHealth(event: ReflectionSemanticWorkerHealthEvent): void {
    try {
      this.deps.onHealth?.(Object.freeze(event));
    } catch {
      // Health observers cannot affect durable work or worker liveness.
    }
  }

  private safeLog(
    level: "info" | "warn" | "error",
    message: string,
    fields: Record<string, unknown>,
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging is an observation seam, not part of semantic correctness.
    }
  }

  async stop(): Promise<void> {
    if (this.inFlight !== null) {
      this.nextEligibleAtMs = Math.max(
        this.nextEligibleAtMs ?? 0,
        this.clock.now() + this.scanIntervalMs,
      );
    }
    this.lifecycleToken = {};
    this.stopped = true;
    this.schedulerState = "disabled";
    this.pauseReason = null;
    this.probingReason = null;
    this.pressureProbeAtMs = null;
    this.window.splice(0);
    this.latencyWindow.clear();
    this.pendingAdmissions = 0;
    this.consecutiveFailures = 0;
    this.backlogGrowthCount = 0;
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
      this.timerAtMs = null;
    }
    if (this.deadlineTimer !== null) {
      this.clock.clearTimer(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.activeController?.abort();
    const active = this.inFlight;
    if (active === null) return;
    const settled = await Promise.race([
      active.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.shutdownWaitMs);
        timer.unref?.();
      }),
    ]);
    if (!settled && this.inFlight === active) {
      // A provider may ignore AbortSignal indefinitely. Detach that stale
      // generation after the bounded shutdown wait so a later start remains
      // live. The lifecycle token prevents its eventual completion from
      // mutating this scheduler; durable lease fencing protects persisted work.
      this.inFlight = null;
      this.activeController = null;
    }
  }
}
