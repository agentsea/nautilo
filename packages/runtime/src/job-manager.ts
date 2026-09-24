import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Job, type JobExecutor } from "./job";
import type { LaneLock, TryAcquireResult } from "./types";
import { laneLock as defaultLaneLock } from "./lane-lock";
import {
  LaneCoalescer,
  coalescedInputToJobInput,
  jobInputToCoalescedInput,
  type CoalescedInput,
} from "./lane-coalescer";
import { coalescedToSlice } from "./fork/fork-metadata";
import { langgraphExecutor } from "./executors/langgraph-executor";
import { forkLanggraphExecutor } from "./executors/fork-langgraph-executor";
import { slowTaskExecutor } from "./executors/slow-task-executor";
import { deepResearchExecutor } from "./executors/deep-research-executor";
import { getJobById, persistJob, updateJobStatus } from "@nautilo/db";
import {
  insertAcceptance as defaultInsertAcceptance,
  linkAcceptancesToJob as defaultLinkAcceptances,
  terminalizeAllAccepted as defaultTerminalizeAllAccepted,
  userCancelAcceptances as defaultUserCancelAcceptances,
  WORK_ACCEPTANCE_REASONS,
  type WorkAcceptanceKind,
  type WorkAcceptanceReason,
} from "@nautilo/db";
import type { JobPublicationPolicy, PersistJobPayload } from "@nautilo/db";
import type { InitiatingClientSurfaceV1, JobStatus } from "@nautilo/types";
import {
  runWithInitiatingClientSurface,
  readOrdinaryContentAccessRecovery,
  resumeOrdinaryContentAccessRecovery,
  OrdinaryContentAccessRecoveryUnavailableError,
  type OrdinaryContentAccessRecoveryScope,
  type OrdinaryContentAccessRecoveryCoordinate,
  type OrdinaryContentAccessRecoveryDeps,
  type StreamEventProcessor,
  type DeepResearchReturnContext,
} from "@nautilo/agent";
import { log } from "@nautilo/logger";
import { eventBus } from "./event-bus";
import type {
  ForegroundTurnCandidate,
  ForegroundTurnCoalescingContext,
} from "./foreground-turn-lifecycle";
import { forkCoordinator } from "./fork/fork-coordinator";
import type { ForkRunMetadata } from "./fork/fork-metadata";
import {
  assertAcceptedInvocationAuthoritySubject,
  createAcceptedInvocationAuthority,
  getAcceptedInvocationAuthoritySubject,
  getAcceptedInvocationAuthorityOrigin,
  bindAcceptedInvocationAuthorityOrigin,
  isInvocationAccessAllowed,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import {
  getMaintenanceGate,
  createMaintenanceAcceptanceAuthority,
  type MaintenanceGate,
  type MaintenanceAcceptanceAuthority,
} from "./maintenance-controller";

/**
 * D420 — execution-local authority for work that has already crossed an
 * admission boundary. Agent tools (notably deep-research) run inside
 * `Job.execute()`, so the server's background-job hook can retrieve this
 * authority without introducing an agent → runtime import cycle.
 */
const acceptedWorkAuthorityStorage = new AsyncLocalStorage<MaintenanceAcceptanceAuthority>();
const acceptedInvocationAuthorityStorage =
  new AsyncLocalStorage<AcceptedInvocationAuthority>();

/** Authority of the currently executing accepted Job, if any. */
export function getCurrentAcceptedWorkAuthority(): MaintenanceAcceptanceAuthority | undefined {
  return acceptedWorkAuthorityStorage.getStore();
}

/** Invocation authority of the currently executing accepted Job, if any. */
export function getCurrentAcceptedInvocationAuthority():
  | AcceptedInvocationAuthority
  | undefined {
  return acceptedInvocationAuthorityStorage.getStore();
}

/**
 * Run trusted accepted child work with invocation authority in async context.
 * The ingress owns subject validation; this seam deliberately carries no
 * serializable identity alongside the opaque authority.
 */
export function runWithAcceptedInvocationAuthority<T>(
  authority: AcceptedInvocationAuthority,
  work: () => Promise<T>,
): Promise<T> {
  return acceptedInvocationAuthorityStorage.run(authority, work);
}

/** Run one already-admitted continuation with both independent authorities. */
export function runWithAcceptedWorkAuthorities<T>(
  maintenanceAuthority: MaintenanceAcceptanceAuthority,
  invocationAuthority: AcceptedInvocationAuthority,
  work: () => Promise<T>,
): Promise<T> {
  return acceptedWorkAuthorityStorage.run(maintenanceAuthority, () =>
    runWithAcceptedInvocationAuthority(invocationAuthority, work),
  );
}

function getExecutor(type: "foreground" | "background", input?: Record<string, unknown>): JobExecutor {
  if (type === "background" && input?.["type"] === "deep-research") return deepResearchExecutor;
  const forkRun = input?.["forkRun"] as ForkRunMetadata | undefined;
  if (type === "foreground" && forkRun?.mode === "fork") return forkLanggraphExecutor;
  return type === "foreground" ? langgraphExecutor : slowTaskExecutor;
}

export type CreateForegroundJobResult = {
  /** Alias of `virtualJobId` until the merged job is persisted (HTTP omits real DB id until `job.dispatched`). */
  id: string;
  virtualJobId: string;
  /**
   * D420 — opaque authority minted after durable acceptance. Internal
   * continuations (Task report-back) retain it; HTTP callers never receive it.
   */
  acceptanceAuthority?: MaintenanceAcceptanceAuthority;
  /** M254 — opaque, Human-bound invocation continuation authority. */
  invocationAcceptanceAuthority?: AcceptedInvocationAuthority;
};

/**
 * The execution policy bound to one accepted foreground turn.
 *
 * This deliberately travels with the virtual turn until it is linked to its
 * concrete Job. It is not a mutable property of a graph thread: multiple
 * people can target one bot checkpoint thread without being able to replace
 * each other's executor or scheduling policy before either turn runs.
 */
export interface ForegroundExecutionRoute {
  /** The executor that receives the persisted Job id at execution time. */
  executor: JobExecutor;
  /** External executors own model identity outside Nautilo's curated model domain. */
  modelAttribution?: "external";
  /** Whether this accepted turn may join its lane's normal burst buffer. */
  coalescing: "coalesce" | "separate";
  /** Optional process-local fence applied before otherwise compatible turns coalesce. */
  coalescingBoundary?: "exact-client";
  /** What to do when its graph thread already has a running main turn. */
  contention: "fork" | "serialize";
}

function defaultForegroundExecutionRoute(executor?: JobExecutor): ForegroundExecutionRoute {
  return {
    executor: executor ?? langgraphExecutor,
    coalescing: "coalesce",
    contention: "fork",
  };
}

/** Ordinary Human-to-Agent turns fork when their Agent checkpoint thread is busy. */
export function ordinaryConversationExecutionRoute(): ForegroundExecutionRoute {
  return {
    executor: langgraphExecutor,
    coalescing: "coalesce",
    coalescingBoundary: "exact-client",
    contention: "fork",
  };
}

/** M298 Browser-private turns stay uncoalesced but may use a root-session fork. */
export function liveShadowConversationExecutionRoute(): ForegroundExecutionRoute {
  return {
    executor: langgraphExecutor,
    coalescing: "separate",
    contention: "fork",
  };
}

function routesAreCompatible(
  left: ForegroundExecutionRoute,
  right: ForegroundExecutionRoute,
): boolean {
  return (
    left.executor === right.executor &&
    left.modelAttribution === right.modelAttribution &&
    left.coalescing === right.coalescing &&
    left.coalescingBoundary === right.coalescingBoundary &&
    left.contention === right.contention
  );
}

/** Private admission fence; no raw session or origin bytes reach serializable work. */
type ForegroundCoalescingBoundary = {
  readonly clientSessionToken: symbol;
  readonly initiatingClientSurface: InitiatingClientSurfaceV1;
  readonly ordinaryOriginToken: symbol | null;
};

function createForegroundCoalescingBoundary(
  candidate: ForegroundTurnCandidate | undefined,
  input: Record<string, unknown>,
): ForegroundCoalescingBoundary {
  const context: ForegroundTurnCoalescingContext | undefined = candidate?.coalescingContext;
  return {
    // Missing/old clients have no exact-session identity, so each admission
    // stays standalone rather than inheriting a previous burst's context.
    clientSessionToken: context?.clientSessionToken ?? Symbol("unbound-client-session"),
    initiatingClientSurface: context?.initiatingClientSurface ?? "unknown",
    // Any verified origin is standalone. It is host authority, not UI surface,
    // and a coalescer must never retain it across a request boundary.
    ordinaryOriginToken:
      input["verifiedOrdinaryOrigin"] === undefined || input["verifiedOrdinaryOrigin"] === null
        ? null
        : Symbol("verified-ordinary-origin"),
  };
}

function coalescingBoundariesAreCompatible(
  left: ForegroundCoalescingBoundary,
  right: ForegroundCoalescingBoundary,
): boolean {
  return left.clientSessionToken === right.clientSessionToken
    && left.initiatingClientSurface === right.initiatingClientSurface
    && left.ordinaryOriginToken === right.ordinaryOriginToken;
}

/** A coalescer-flushed turn awaiting dispatch on its bot checkpoint thread. */
interface PendingTurn {
  /** Per-(room,user,bot) coalescing lane — bookkeeping only; NOT the serialization axis. */
  laneKey: string;
  merged: CoalescedInput;
  virtualIds: readonly string[];
  /** Immutable route selected when this accepted turn crossed admission. */
  route: ForegroundExecutionRoute;
  /** Process-local only; intentionally excluded from the serialized Job input. */
  initiatingClientSurface: InitiatingClientSurfaceV1;
  /**
   * M144 — a system-originated turn (task report-back wake). Such turns must
   * run as strict sequential MAIN turns, never as M085 forks: forking a wake
   * leaks its synthetic `[TASK RESULT …]` row (the fork-replay path does not
   * honor the `originatedBy:"task"` suppression) and is semantically wrong
   * (task results should arrive one-by-one, in order). When the thread is busy,
   * a system turn stays queued and runs as a main turn once the lock frees.
   */
  system?: boolean;
}

/** M147 — why a live job was aborted. Drives the executor's silent-abort
 * branch (a pause/stop is NOT a failure → no report-back error turn). */
export type AbortReason = "pause" | "stop";
export interface StopScopeResult {
  stoppedJobs: number;
  droppedQueuedTurns: number;
  droppedBufferedLanes: number;
}

/** Redacted release-readiness snapshot: counts only, never job input. */
export interface ForegroundWorkSummary {
  runningJobs: number;
  queuedTurns: number;
  bufferedLanes: number;
}

/**
 * D420 (Wave 2 task 2.2.2) — payload-free executable Job work summary for
 * maintenance drain decisions. Task-backed foreground jobs are deliberately
 * excluded from `runningForegroundJobs`: the task query owns those through
 * their task-run rows, which avoids reporting the same running Task as both a
 * foreground Job and a Task.
 *
 * Queued turns and buffered lanes remain independent scheduler aggregates.
 * They may describe where a newly claimed Task is waiting, but they do not
 * carry task identity or payload and all categories must be zero before the
 * operator may advance.
 */
export interface ExecutableJobWorkSummary {
  /** Running foreground Jobs that are not task-run Jobs. */
  runningForegroundJobs: number;
  /** Running background Jobs. */
  runningBackgroundJobs: number;
  /** Per-thread foreground turns waiting for dispatch. */
  queuedTurns: number;
  /** Coalescer lanes holding buffered foreground work. */
  bufferedLanes: number;
}

/**
 * D420 — payload-free work-acceptance ledger sinks (injectable so unit
 * tests run DB-free). The production singleton wires the real
 * `@nautilo/db` sinks; tests inject no-op stubs that return
 * process-local ids so the linkage logic is exercised without a DB.
 */
export interface WorkAcceptanceSinks {
  /** Persist one acceptance row BEFORE enqueue; return its id. */
  insertAcceptance: (kind: WorkAcceptanceKind) => Promise<string>;
  /**
   * Link a coalesced group of acceptances to the created Job at dispatch.
   * Returns the count of rows that actually transitioned `accepted →
   * dispatched`. A count LESS than the number of acceptance ids means a
   * concurrent user Stop terminalized some of them as `user_cancelled`
   * (the dispatch-vs-Stop race); the runtime compensates the never-dispatched
   * Job instead of executing it (D420 task 2.2.3 correction, R8).
   */
  linkAcceptancesToJob: (
    acceptanceIds: readonly string[],
    jobId: string,
  ) => Promise<number>;
  /**
   * D420 (Wave 2 task 2.2.3) — terminalize EVERY durable `accepted` (un-
   * dispatched) acceptance row as `maintenance_cancelled` with a bounded
   * reason. Returns the count terminalized. Called at the drain deadline so
   * the ledger tells the truth about queued/buffered intent that never
   * started (R8/R11). Injectable so unit tests run DB-free.
   */
  terminalizeAllAcceptedWork: (reason: WorkAcceptanceReason) => Promise<number>;
  /**
   * D420 (Wave 2 task 2.2.3 correction) — terminalize an EXACT, ID-scoped set
   * of still-`accepted` acceptance rows as `user_cancelled` with a bounded
   * user-stop reason. Idempotent: rows already `dispatched` or terminal are
   * untouched. Returns the count terminalized so the runtime can detect a
   * dispatch-vs-Stop race. Injectable so unit tests run DB-free.
   */
  userCancelAcceptedWork: (
    acceptanceIds: readonly string[],
    reason: WorkAcceptanceReason,
  ) => Promise<number>;
}

/**
 * DB-free in-memory ledger for unit-test-only JobManager instances. Production
 * always wires the durable DB sinks below. Crucially, this is never used as a
 * fallback after a durable insert failure: production insert failures reject
 * before enqueue.
 */
function localAcceptanceId(): string {
  return randomUUID();
}

const defaultAcceptanceSinks: WorkAcceptanceSinks = {
  insertAcceptance: () => Promise.resolve(localAcceptanceId()),
  linkAcceptancesToJob: (acceptanceIds) => Promise.resolve(acceptanceIds.length),
  terminalizeAllAcceptedWork: () => Promise.resolve(0),
  userCancelAcceptedWork: () => Promise.resolve(0),
};

export interface PlannedShutdownResult extends ForegroundWorkSummary {
  cancelledJobs: number;
}

const PLANNED_SHUTDOWN_CANCELLATION_REASON =
  "Cancelled because the server is shutting down for planned maintenance";
const ACCEPTANCE_LINK_FAILURE_CANCELLATION_REASON =
  "Cancelled before dispatch because durable acceptance linkage failed";
/**
 * D420 (Wave 2 task 2.2.3) — operator-visible reason stamped on every running
 * Job terminalized at the `--wait-for` deadline. Mirrors the acceptance
 * ledger's `maintenanceDrain` reason text so a cancelled unit reports one
 * truthful outcome whether it had started (Job cancelled) or not (acceptance
 * `maintenance_cancelled`).
 */
const MAINTENANCE_DRAIN_CANCELLATION_REASON = "Cancelled by maintenance drain";
/**
 * D420 (Wave 2 task 2.2.3 correction) — operator-visible reason stamped on a
 * running Job when the dispatch-vs-Stop race is lost (a concurrent user Stop
 * claimed part of the coalesced group before execution). The Job is compensated
 * (cancelled) before it executes; the user_cancelled acceptance rows carry the
 * truthful user-stop outcome. Distinct from a maintenance drain.
 */
const DISPATCH_VS_STOP_RACE_CANCELLATION_REASON =
  "Cancelled before dispatch because a concurrent user Stop claimed part of the coalesced group";

/**
 * D420 (Wave 2 task 2.2.3) — result of terminalizing all remaining executable
 * work at the drain deadline. Counts only (payload-free); the operator API
 * surfaces them via the aggregate maintenance status, never job/room/lane ids.
 */
export interface MaintenanceCancellationResult {
  /** Running foreground/background Jobs terminalized (incl. task-run Jobs). */
  cancelledJobs: number;
  /** Running task-run Jobs terminalized via the task lifecycle (`stopTask`). */
  cancelledTaskRuns: number;
  /** Per-thread queued turns dropped before dispatch. */
  droppedQueuedTurns: number;
  /** Coalescer buffered lanes dropped before flush. */
  droppedBufferedLanes: number;
  /** Durable `accepted` ledger rows terminalized as `maintenance_cancelled`. */
  terminalizedAcceptances: number;
}

type InvocationWorkScope = Readonly<{
  roomId?: string;
  taskId?: string;
  taskRunId?: string;
  originRoomId?: string;
  originTaskId?: string;
}>;

type InvocationTaskStop = (input: {
  humanUserId: string; taskId: string; taskRunId: string;
}) => Promise<void>;

function invocationWorkScope(input: Record<string, unknown>, authority?: AcceptedInvocationAuthority): InvocationWorkScope {
  return {
    ...(typeof input["roomId"] === "string" && input["roomId"] ? { roomId: input["roomId"] } : {}),
    ...(typeof input["taskId"] === "string" ? { taskId: input["taskId"] } : {}),
    ...(typeof input["taskRunId"] === "string" ? { taskRunId: input["taskRunId"] } : {}),
    ...(authority ? getAcceptedInvocationAuthorityOrigin(authority) : {}),
  };
}

function acceptedInputOrigin(input: Record<string, unknown>): { originRoomId?: string; originTaskId?: string } {
  const scope = invocationWorkScope(input);
  return scope.taskId ? { originTaskId: scope.taskId } : scope.roomId ? { originRoomId: scope.roomId } : {};
}

function bindInvocationOrigin(humanUserId: string, input: Record<string, unknown>, authority?: AcceptedInvocationAuthority): AcceptedInvocationAuthority {
  if (authority) {
    assertAcceptedInvocationAuthoritySubject(authority, humanUserId);
    return bindAcceptedInvocationAuthorityOrigin(authority, acceptedInputOrigin(input));
  }
  return createAcceptedInvocationAuthority(humanUserId, acceptedInputOrigin(input));
}

export class JobManager {
  private active = new Map<string, Job>();
  /**
   * M147 — abort-reason side-channel keyed by `jobId`, set by
   * {@link abortJob} and read via {@link getAbortReason}. The distinction
   * pause-vs-stop lives in the `tasks`/`task_runs` status (the lifecycle fns
   * write it); at the job level every abort is the same terminal-cancel. The
   * map is purely advisory metadata for callers that want to know WHY a job
   * was aborted; it is cleared when the job leaves `active`.
   */
  private readonly abortReasons = new Map<string, AbortReason>();
  /** Route selected for each accepted virtual turn until durable Job linkage. */
  private readonly virtualToExecutionRoute = new Map<string, ForegroundExecutionRoute>();
  /**
   * D453 — a TaskRun becomes durable before its serial foreground Job can be
   * dispatched. Keep its Task identity with the accepted virtual turn so a
   * Room/Thread Stop can terminalize a queued external Task through the same
   * lifecycle seam as an already-running task-backed Job. Without this map,
   * Stop correctly removed the queued scheduler work but left the durable
   * Task/TaskRun marked running.
   */
  private readonly virtualToTaskId = new Map<string, string>();
  /** Route of the currently buffered coalescing burst for a lane. */
  private readonly bufferedRouteByLane = new Map<string, ForegroundExecutionRoute>();
  /** M254 — coalescing is permitted only for one canonical Human subject. */
  private readonly bufferedInvocationSubjectByLane = new Map<string, string>();
  /** D513 Phase 6.1 private fence for the current buffered ordinary burst. */
  private readonly bufferedCoalescingBoundaryByLane = new Map<string, ForegroundCoalescingBoundary>();
  /**
   * M136 — per-thread FIFO of coalescer-flushed turns waiting to dispatch.
   * Keyed on `graphThreadId` so turns from DIFFERENT users' coalescing lanes
   * that target the same bot serialize against each other (D-C). Drained in
   * strict arrival order by {@link drainThread}.
   */
  private readonly pendingByThread = new Map<string, PendingTurn[]>();
  /** Threads with an active {@link drainThread} loop (re-entrancy guard). */
  private readonly drainingThreads = new Set<string>();
  /** D349 — conversation-scoped stop/quiesce. Cleared by the next user send. */
  private readonly stoppedThreads = new Set<string>();
  /** D349 — stop intent for a room before/without a known checkpoint thread. */
  private readonly stoppedRooms = new Set<string>();
  private readonly laneLockRef: LaneLock;
  private readonly readRecoveryJob: typeof getJobById;
  private readonly coalescer: LaneCoalescer;
  /** Job persistence sinks — injectable so concurrency unit tests run DB-free. */
  private readonly persistJobFn: (payload: PersistJobPayload) => Promise<string>;
  private readonly updateJobStatusFn: (
    jobId: string,
    status: JobStatus,
    fields?: { message?: string; result?: Record<string, unknown> },
    publicationPolicy?: JobPublicationPolicy,
  ) => Promise<void>;
  /**
   * D420 — payload-free work-acceptance ledger sinks. Defaults are
   * DB-free stubs so existing unit tests stay hermetic; the production
   * singleton wires the real `@nautilo/db` sinks.
   */
  private readonly acceptanceSinks: WorkAcceptanceSinks;
  /**
   * D420 (Wave 2 task 2.2.3) — task lifecycle terminalization sink for running
   * task-run Jobs. `null` means no task terminalization (hermetic tests); the
   * production singleton wires a `stopTask`-backed sink.
   */
  private readonly taskStopSink: ((taskId: string) => Promise<void>) | null;
  /** Collapse duplicate active/queued/concurrent Stop observations to one Task lifecycle request. */
  private readonly taskStopRequests = new Map<string, Promise<void>>();
  /**
   * D420 (Wave 2 task 2.2.1) — maintenance admission gate. `null` means
   * resolve the runtime singleton at call time (permissive until `createApp`
   * wires production). An explicit gate is used to test drain behavior.
   */
  private readonly maintenanceGate: MaintenanceGate | null;
  /** D420 — authority for accepted virtual work until it is linked to a Job. */
  private readonly virtualToAuthority = new Map<string, MaintenanceAcceptanceAuthority>();
  /** D420 — authority propagated through an executing accepted Job. */
  private readonly jobToAuthority = new Map<string, MaintenanceAcceptanceAuthority>();
  /** M254 — Human-bound authority retained with accepted virtual work. */
  private readonly virtualToInvocationAuthority =
    new Map<string, AcceptedInvocationAuthority>();
  private readonly virtualInvocationScopes = new Map<string, InvocationWorkScope & { withdrawn: boolean }>();
  private readonly checkInvocationAccess: typeof isInvocationAccessAllowed;
  private readonly invocationTaskStop: InvocationTaskStop | undefined;
  /** Retained through failed durable cancellation; bounded by accepted work. */
  private readonly pendingInvocationJobStops = new Map<string, { job: Job; humanUserId: string; reason: string }>();
  /** M254 — invocation authority propagated through an executing Job. */
  private readonly jobToInvocationAuthority =
    new Map<string, AcceptedInvocationAuthority>();
  /**
   * D420 — `virtualJobId → acceptanceId` for accepted units not yet
   * dispatched. Populated only after durable acceptance insert succeeds;
   * entries are removed only after a durable link succeeds. A link failure
   * preserves the map entry and prevents the Job from executing.
   */
  private readonly virtualToAcceptance = new Map<string, string>();
  /**
   * Scope companion for still-accepted rows whose Job was not created. Its
   * cardinality cannot exceed `virtualToAcceptance`; exact Stop removes it,
   * maintenance clears it after the durable accepted-row sweep, and restart
   * drops only this process-local index while the durable sweep remains able
   * to recover the acceptance itself.
   */
  private readonly failedPrePersistenceScope = new Map<
    string,
    Readonly<{ threadId: string; roomId: string }>
  >();
  /** D513 — opaque server-private candidate, installed before enqueue only. */
  private readonly virtualToForegroundCandidate = new Map<string, ForegroundTurnCandidate>();

  constructor(opts?: {
    laneLock?: LaneLock;
    /** Existing durable Job read; override only for DB-free recovery tests. */
    readRecoveryJob?: typeof getJobById;
    /** Sliding silence between appends (default 2000 ms). */
    coalescerWindowMs?: number;
    /**
     * Max quiet time before flushing when only **one** segment is buffered — keeps lone
     * sends responsive without waiting the full sliding window (Spacebot-style flush timer).
     */
    coalescerFirstSegmentQuietMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    /** Override job persistence (DB-free unit tests). Defaults to the real `@nautilo/db` sinks. */
    persist?: (payload: PersistJobPayload) => Promise<string>;
    updateStatus?: (
      jobId: string,
      status: JobStatus,
      fields?: { message?: string; result?: Record<string, unknown> },
      publicationPolicy?: JobPublicationPolicy,
    ) => Promise<void>;
    /**
     * D420 — payload-free work-acceptance ledger sinks. Defaults are
     * DB-free stubs; the production singleton wires the real sinks.
     */
    acceptanceSinks?: WorkAcceptanceSinks;
    /**
     * D420 (Wave 2 task 2.2.3) — terminalize a RUNNING task-run Job through
     * the task lifecycle (`stopTask`) so the durable `task_runs`/`tasks` rows
     * are stamped `cancelled`. Plain `Job.cancel()` on a task-run Job would
     * leave the durable run `running` (the task-run executor's abort path
     * assumes the lifecycle fn already wrote the terminal status). Omitted by
     * default (hermetic tests); the production singleton wires a sink that
     * calls `stopTask` with the task-run DB handle.
     */
    taskStopSink?: (taskId: string) => Promise<void>;
    /** Production uses fresh DB authority; injected tests remain DB-free. */
    checkInvocationAccess?: typeof isInvocationAccessAllowed;
    invocationTaskStop?: InvocationTaskStop;
    /**
     * D420 (Wave 2 task 2.2.1) — maintenance admission gate. Defaults to the
     * runtime singleton (permissive until `createApp` wires the production
     * gate), so hermetic unit tests stay DB-free while production gates every
     * executable start. Pass an explicit gate to test drain behavior.
     */
    maintenanceGate?: MaintenanceGate;
  }) {
    this.laneLockRef = opts?.laneLock ?? defaultLaneLock;
    this.readRecoveryJob = opts?.readRecoveryJob ?? getJobById;
    this.persistJobFn = opts?.persist ?? persistJob;
    this.updateJobStatusFn = opts?.updateStatus ?? updateJobStatus;
    this.acceptanceSinks = opts?.acceptanceSinks ?? defaultAcceptanceSinks;
    this.taskStopSink = opts?.taskStopSink ?? null;
    this.checkInvocationAccess = opts?.checkInvocationAccess ?? (() => Promise.resolve(true));
    this.invocationTaskStop = opts?.invocationTaskStop;
    this.maintenanceGate = opts?.maintenanceGate ?? null;
    this.coalescer = new LaneCoalescer(
      opts?.setTimer ?? setTimeout,
      opts?.clearTimer ?? clearTimeout,
      (laneKey, merged, virtualIds) => {
        this.onLaneFlush(laneKey, merged, virtualIds);
      },
      opts?.coalescerWindowMs,
      opts?.coalescerFirstSegmentQuietMs,
    );
  }

  createForegroundJob(
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    executorOverride?: JobExecutor,
    /**
     * D420 (Wave 2 task 2.2.1) — presented by continuation paths (conductor
     * wakes, task report-back) to bypass the drain gate. Omitted by NEW-work
     * ingresses so the gate can reject before acceptance/enqueue.
     */
    authority?: MaintenanceAcceptanceAuthority,
    /**
     * D453 — optional explicit route for an accepted turn. It is last so all
     * existing callers retain their positional argument contract.
     */
    executionRoute?: ForegroundExecutionRoute,
    /** M254 — accepted parent authority for an in-process continuation. */
    invocationAuthority?: AcceptedInvocationAuthority,
    /** D513 — never serialized; reserved for exact-client eligibility only. */
    foregroundTurnCandidate?: ForegroundTurnCandidate,
    /**
     * M282 — server-reserved idempotent live-turn identity. This is generated
     * by the trusted dispatch boundary and durably bound before runtime
     * acceptance, never accepted from a client or serialized into Job input.
     */
    preferredVirtualJobId?: string,
  ): Promise<CreateForegroundJobResult> {
    // D420 — gate NEW executable starts BEFORE any side effect (stop-intent
    // clear, executor pin, acceptance ledger insert, coalescer enqueue). A
    // draining gate throws `MaintenanceDrainError` here; continuation paths
    // pass `authority` and pass through. The acceptance insert + coalescer
    // enqueue below are the "persisted/accepted" boundary the gate protects.
    return this.resolveGate()
      .assertAcceptingNewWork(authority)
      .then(() => {
        if (invocationAuthority) {
          assertAcceptedInvocationAuthoritySubject(invocationAuthority, requestorId);
        }
        if (executionRoute && executorOverride && executionRoute.executor !== executorOverride) {
          throw new Error("Foreground execution route conflicts with executor override");
        }
        const route = executionRoute ?? defaultForegroundExecutionRoute(executorOverride);
        const threadId =
          typeof input["graphThreadId"] === "string" ? input["graphThreadId"] : laneKey;
        this.clearStopIntent(threadId, roomIdFromInput(input));

        const virtualJobId = preferredVirtualJobId ?? randomUUID();
        if (
          this.virtualToAcceptance.has(virtualJobId)
          || this.virtualToExecutionRoute.has(virtualJobId)
          || this.virtualToAuthority.has(virtualJobId)
        ) {
          throw new Error(`Foreground virtual Job id is already active: ${virtualJobId}`);
        }
        // D420 — persist the payload-free acceptance row BEFORE enqueue. A
        // durable insert failure rejects this call; it must never enqueue,
        // emit `job.coalesced`, or return an accepted virtual job id.
        return this.acceptForegroundAcceptance(virtualJobId, "foreground").then(() => {
          const acceptedAuthority = authority ?? createMaintenanceAcceptanceAuthority();
          const acceptedInvocationAuthority =
            bindInvocationOrigin(requestorId, input, invocationAuthority);
          // The durable ledger insert is the acceptance boundary. Mint a fresh
          // authority only after it succeeds, unless a prior accepted
          // continuation explicitly carried one in.
          this.virtualToAuthority.set(virtualJobId, acceptedAuthority);
          this.virtualToInvocationAuthority.set(
            virtualJobId,
            acceptedInvocationAuthority,
          );
          this.virtualInvocationScopes.set(virtualJobId, { ...invocationWorkScope(input, acceptedInvocationAuthority), withdrawn: false });
          this.virtualToExecutionRoute.set(virtualJobId, route);
          if (foregroundTurnCandidate) {
            this.virtualToForegroundCandidate.set(virtualJobId, foregroundTurnCandidate);
          }
          // Exact-client burst isolation is independent of what happens after
          // the burst flushes. Ordinary turns retain this fence whether they
          // later run as the main turn or fork behind a busy Agent thread.
          const coalescingBoundary = route.coalescingBoundary === "exact-client"
            ? createForegroundCoalescingBoundary(foregroundTurnCandidate, input)
            : undefined;
          const taskId = taskIdFromInput(input);
          if (taskId) this.virtualToTaskId.set(virtualJobId, taskId);
          const merged = jobInputToCoalescedInput(input, laneKey, ownerId, requestorId);
          if (route.coalescing === "separate") {
            this.onLaneFlush(laneKey, merged, [virtualJobId], false, coalescingBoundary);
          } else {
            const bufferedRoute = this.bufferedRouteByLane.get(laneKey);
            // A lane can only contain compatible turns. Flush the old burst
            // before accepting the new one into a fresh buffer so no flush can
            // ever have to choose between two caller-selected executors.
            if (bufferedRoute && !routesAreCompatible(bufferedRoute, route)) {
              this.coalescer.flushIfPending(laneKey);
            }
            const bufferedSubject = this.bufferedInvocationSubjectByLane.get(laneKey);
            if (bufferedSubject !== undefined && bufferedSubject !== requestorId) {
              this.coalescer.flushIfPending(laneKey);
            }
            const bufferedBoundary = this.bufferedCoalescingBoundaryByLane.get(laneKey);
            if (coalescingBoundary && bufferedBoundary
              && !coalescingBoundariesAreCompatible(bufferedBoundary, coalescingBoundary)) {
              this.coalescer.flushIfPending(laneKey);
            }
            this.bufferedRouteByLane.set(laneKey, route);
            this.bufferedInvocationSubjectByLane.set(laneKey, requestorId);
            if (coalescingBoundary) {
              this.bufferedCoalescingBoundaryByLane.set(laneKey, coalescingBoundary);
            }
            this.coalescer.enqueue(merged, virtualJobId);
          }
          eventBus.emit({
            type: "job.coalesced",
            virtualJobId,
            laneKey,
          });
          return {
            id: virtualJobId,
            virtualJobId,
            acceptanceAuthority: acceptedAuthority,
            invocationAcceptanceAuthority: acceptedInvocationAuthority,
          };
        });
      });
  }

  /**
   * M144 — dispatch a SYSTEM-originated foreground turn that BYPASSES the
   * coalescer. Used by the task report-back finalizer (`wakeCallingRoom`): each
   * completed task's wake must land as its OWN agent reply, not merge with a
   * sibling task wake or a human's in-flight burst on the same room lane (which
   * `createForegroundJob`'s coalescing window would collapse into one turn).
   *
   * It still routes onto the per-thread FIFO (`onLaneFlush` → `pendingByThread`),
   * so concurrent system turns on the same bot thread SERIALIZE (run one after
   * another) rather than race — they just never coalesce into a single prompt.
   */
  createSystemForegroundJob(
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    executorOverride?: JobExecutor,
    /**
     * D420 — required to bypass an active drain. System-originated work is not
     * inherently continuation: callers without an authority are NEW starts
     * and must be rejected while draining.
     */
    authority?: MaintenanceAcceptanceAuthority,
    executionRoute?: ForegroundExecutionRoute,
    /** M254 — accepted parent authority for an in-process continuation. */
    invocationAuthority?: AcceptedInvocationAuthority,
  ): Promise<CreateForegroundJobResult> {
    // D420 — reject genuinely new system starts before any queue mutation.
    // Report-back callers present their task-run authority, minted only after
    // the originating task Job was admitted.
    return this.resolveGate()
      .assertAcceptingNewWork(authority)
      .then(() => {
        if (invocationAuthority) {
          assertAcceptedInvocationAuthoritySubject(invocationAuthority, requestorId);
        }
        if (executionRoute && executorOverride && executionRoute.executor !== executorOverride) {
          throw new Error("Foreground execution route conflicts with executor override");
        }
        const route = executionRoute ?? defaultForegroundExecutionRoute(executorOverride);
        const virtualJobId = randomUUID();
        return this.acceptForegroundAcceptance(virtualJobId, "system_report_back").then(() => {
          const acceptedAuthority = authority ?? createMaintenanceAcceptanceAuthority();
          const acceptedInvocationAuthority =
            bindInvocationOrigin(requestorId, input, invocationAuthority);
          this.virtualToAuthority.set(virtualJobId, acceptedAuthority);
          this.virtualToInvocationAuthority.set(
            virtualJobId,
            acceptedInvocationAuthority,
          );
          this.virtualInvocationScopes.set(virtualJobId, { ...invocationWorkScope(input, acceptedInvocationAuthority), withdrawn: false });
          this.virtualToExecutionRoute.set(virtualJobId, route);
          const taskId = taskIdFromInput(input);
          if (taskId) this.virtualToTaskId.set(virtualJobId, taskId);
          // Single-input "merged" turn — skip `coalescer.enqueue` entirely and hand it
          // straight to the per-thread serialization queue.
          const merged = jobInputToCoalescedInput(input, laneKey, ownerId, requestorId);
          this.onLaneFlush(laneKey, merged, [virtualJobId], true);
          return {
            id: virtualJobId,
            virtualJobId,
            acceptanceAuthority: acceptedAuthority,
            invocationAcceptanceAuthority: acceptedInvocationAuthority,
          };
        });
      });
  }

  /**
   * M136 — a coalescing lane flushed one user's merged burst. Enqueue it on
   * the bot's checkpoint thread (the serialization axis) and kick the drain.
   * Coalescing stays per-lane (D-B); serialization is per-thread (D-C).
   */
  private onLaneFlush(
    laneKey: string,
    merged: CoalescedInput,
    virtualIds: readonly string[],
    system = false,
    explicitCoalescingBoundary?: ForegroundCoalescingBoundary,
  ): void {
    // D513 Phase 3.2 — a burst may run normally, but only a single direct
    // foreground source can retain eligibility. Resolve private candidates
    // before scheduling so merged sends cannot inherit the first turn id.
    if (system || virtualIds.length !== 1) this.invalidateForegroundCandidates(virtualIds);
    const route = this.routeForVirtualIds(virtualIds);
    const initiatingClientSurface = system
      ? "unknown"
      : explicitCoalescingBoundary?.initiatingClientSurface
        ?? this.bufferedCoalescingBoundaryByLane.get(laneKey)?.initiatingClientSurface
        ?? "unknown";
    const bufferedRoute = this.bufferedRouteByLane.get(laneKey);
    if (bufferedRoute && routesAreCompatible(bufferedRoute, route)) {
      this.bufferedRouteByLane.delete(laneKey);
      this.bufferedInvocationSubjectByLane.delete(laneKey);
      this.bufferedCoalescingBoundaryByLane.delete(laneKey);
    }
    const threadId = merged.graphThreadId;
    // M136 §8.5 — fail-closed: a turn with no checkpoint thread must NEVER
    // run, because locking on a fallback (`laneKey`) silently re-introduces
    // the per-(user,bot) race this issue fixes. Drop + log a grep-able error.
    if (!threadId) {
      this.invalidateForegroundCandidates(virtualIds);
      // This turn cannot be dispatched. Keep the durable acceptance mapping
      // for the maintenance reconciler, but discard the in-memory route so a
      // malformed input cannot retain executable authority indefinitely.
      for (const virtualId of virtualIds) {
        this.virtualToExecutionRoute.delete(virtualId);
        this.virtualToTaskId.delete(virtualId);
        this.virtualToInvocationAuthority.delete(virtualId);
        this.virtualInvocationScopes.delete(virtualId);
      }
      log(
        `[lane] serialization_thread_missing lane=${laneKey} turn=${merged.turnId} — refusing to dispatch (no graphThreadId)`,
      );
      return;
    }
    if (this.isThreadStopped(threadId) || this.isRoomStopped(merged.roomId)) {
      this.invalidateForegroundCandidates(virtualIds);
      this.coalescer.dropLane(laneKey);
      // D420 (Wave 2 task 2.2.3) — preserve the virtual IDs: a Stop claimed
      // this flushed lane. Durably terminalize their mapped acceptances as
      // user_cancelled. Fire-and-forget with loud logging: this is a race
      // fallback (stopRoom/stopThread normally terminalize before the flush
      // timer fires), and onLaneFlush is synchronous. The Stop route itself
      // is the awaitable, fail-loud path.
      void this.terminalizeUserStoppedVirtualIds(virtualIds).catch((err) => {
        log(
          `[lane] user_stop terminalization failed for flushed lane=${laneKey} thread=${threadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      log(
        `[lane] thread=${threadId} stop intent active — dropping flushed lane=${laneKey}`,
      );
      return;
    }
    const item: PendingTurn = {
      laneKey,
      merged,
      virtualIds,
      route,
      initiatingClientSurface,
      ...(system ? { system: true } : {}),
    };
    const q = this.pendingByThread.get(threadId);
    if (q) q.push(item);
    else this.pendingByThread.set(threadId, [item]);
    void this.drainThread(threadId);
  }

  /**
   * M136 — drain the per-thread pending queue in strict arrival (FIFO) order.
   * The first turn on a free, fully-reconciled thread runs as the MAIN turn
   * (holds the thread lock); every turn that finds the thread busy or with an
   * unreconciled lower fork runs as a FORK (M085 machinery, re-keyed on the
   * thread). Sequence numbers are allocated here in queue order, so ordering
   * holds regardless of which user triggered each turn (R1–R4).
   */
  private async drainThread(threadId: string): Promise<void> {
    if (this.drainingThreads.has(threadId)) return;
    this.drainingThreads.add(threadId);
    try {
      for (;;) {
        if (this.isThreadStopped(threadId)) {
          // D420 (Wave 2 task 2.2.3) — preserve the queued virtual IDs: a Stop
          // claimed this thread. Durably terminalize their mapped acceptances
          // as user_cancelled before dropping the queue (race fallback; the
          // primary awaitable path is stopThread/stopRoom).
          const q = this.pendingByThread.get(threadId);
          this.pendingByThread.delete(threadId);
          if (q) {
            const vids = q.flatMap((item) => item.virtualIds);
            await this.terminalizeUserStoppedVirtualIds(vids).catch((err) => {
              log(
                `[lane] user_stop terminalization failed for stopped thread=${threadId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          break;
        }
        const q = this.pendingByThread.get(threadId);
        if (!q || q.length === 0) {
          this.pendingByThread.delete(threadId);
          break;
        }

        const tryRes = await this.laneLockRef.tryAcquire(threadId);
        if (this.isThreadStopped(threadId)) {
          if (tryRes.acquired) await tryRes.release();
          const q2 = this.pendingByThread.get(threadId);
          this.pendingByThread.delete(threadId);
          if (q2) {
            const vids = q2.flatMap((item) => item.virtualIds);
            await this.terminalizeUserStoppedVirtualIds(vids).catch((err) => {
              log(
                `[lane] user_stop terminalization failed for stopped thread=${threadId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          break;
        }

        if (q.length === 0) {
          if (tryRes.acquired) await tryRes.release();
          continue;
        }

        // BLOCKER #1 (M085, re-keyed): even with the lock free, an earlier
        // fork may be paused (approval / prove_it) or pending splice. Running
        // a main turn on the parent checkpoint now would put a later sequence
        // ahead of an earlier unresolved one. Route as a fork instead.
        if (
          tryRes.acquired &&
          forkCoordinator.hasUnreconciledLowerTurns(threadId) &&
          q[0]?.route.contention === "fork"
        ) {
          const item = q.shift()!;
          await tryRes.release();
          log(
            `[lane] thread=${threadId} serialized user=${item.merged.requestorId} action=fork reason=unreconciled`,
          );
          await this.dispatchForkForegroundJob(threadId, item);
          continue;
        }

        // A serialize route is deliberately never allowed to jump an
        // unreconciled fork. There is no running main turn in this branch to
        // wake us; the earlier fork's normal completion/reconciliation path
        // re-drains the thread after it becomes safe.
        if (tryRes.acquired && forkCoordinator.hasUnreconciledLowerTurns(threadId)) {
          await tryRes.release();
          break;
        }

        if (!tryRes.acquired) {
          // M144 — a system turn (task wake) must not fork. The busy thread
          // lock is always held by a running MAIN turn, whose completion
          // re-drains this thread — so leaving the system turn at the head of
          // the FIFO lets it run as a sequential main turn next, in order, with
          // no synthetic-row leak. Stall-free: a busy lock ⇒ a main turn that
          // will re-drain.
          if (q[0]?.system || q[0]?.route.contention === "serialize") {
            break;
          }
          const item = q.shift()!;
          log(
            `[lane] thread=${threadId} serialized user=${item.merged.requestorId} action=fork reason=busy`,
          );
          await this.dispatchForkForegroundJob(threadId, item);
          continue;
        }

        const item = q.shift()!;
        log(
          `[lane] thread=${threadId} serialized user=${item.merged.requestorId} action=run reason=free`,
        );
        await this.runMainTurn(threadId, item, tryRes);
      }
    } finally {
      this.drainingThreads.delete(threadId);
    }
  }

  /**
   * Dispatch a main foreground turn on the bot checkpoint thread. Holds
   * `tryRes` (the thread lock) for the whole turn; on EVERY terminal path it
   * releases the lock, advances fork-coordinator ordering, and re-drains the
   * thread so the next queued turn (possibly from another user's lane) runs
   * (R5/R6). Does not await execution so the caller's drain loop can keep
   * allocating sequence numbers for contending turns (they fork while busy).
   */
  private async runMainTurn(
    threadId: string,
    item: PendingTurn,
    tryRes: Extract<TryAcquireResult, { acquired: true }>,
  ): Promise<void> {
    const { merged, virtualIds, route, initiatingClientSurface } = item;
    const inputRecord = coalescedInputToJobInput(merged);
    const durableCandidate = virtualIds.length === 1
      ? this.virtualToForegroundCandidate.get(virtualIds[0]!)
      : undefined;
    const hasFullCandidate = virtualIds.some((virtualId) =>
      this.virtualToForegroundCandidate.get(virtualId)
        ?.durableJobInputDisposition === "full"
    );
    if (
      hasFullCandidate
      && durableCandidate?.durableJobInputReference === undefined
    ) {
      this.failAcceptedForegroundBeforePersistence(
        virtualIds, merged.laneKey, threadId, merged.roomId,
        "invalid_full_reference",
      );
      await this.releaseLaneAfterPrePersistenceFailure(tryRes);
      return;
    }
    const durableInputReference = durableCandidate?.durableJobInputReference;
    const durableInputDisposition = durableCandidate?.durableJobInputDisposition;
    const executor = route.executor;
    // M077 — `jobs.owner_id` is the authenticated human (`requestorId`) for
    // `GET /api/jobs/:id`; LangGraph input still carries memory-scoped
    // `ownerId` via `coalescedInputToJobInput`.
    const job = new Job({
      ownerId: merged.requestorId,
      requestorId: merged.requestorId,
      laneKey: merged.laneKey,
      type: "foreground",
      input: inputRecord,
      ...(durableInputReference === undefined
        ? {}
        : { durableInputReference }),
      ...(durableInputDisposition === undefined
        ? {}
        : { durableInputDisposition }),
      executor,
      persist: this.persistJobFn,
      updateStatus: this.updateJobStatusFn,
    });

    try {
      await job.persist();
    } catch {
      this.failAcceptedForegroundBeforePersistence(
        virtualIds, merged.laneKey, threadId, merged.roomId,
        "job_persistence_unavailable",
      );
      await this.releaseLaneAfterPrePersistenceFailure(tryRes);
      return;
    }
    this.active.set(job.id, job);
    const sequence = forkCoordinator.nextSequence(threadId);

    // D420 — execution may begin only after every coalesced acceptance has
    // been durably linked to this Job. On failure the job is explicitly
    // compensated as cancelled-before-dispatch; the acceptance rows remain
    // `accepted` for later 2.2.3 terminalization, never mislabeled as
    // cancelled after executing.
    try {
      const linked = await this.linkAcceptancesForVirtualIds(
        virtualIds,
        job.id,
        merged.requestorId,
      );
      this.jobToAuthority.set(job.id, linked.maintenance);
      this.jobToInvocationAuthority.set(job.id, linked.invocation);
    } catch (err) {
      this.abandonInvocationAuthorities(virtualIds);
      this.invalidateForegroundCandidates(virtualIds);
      try {
        await this.cancelUndispatchedJobForLedgerFailure(job, err);
      } catch (compensationErr) {
        log(
          `[maintenance] main job=${job.id} could not be fully compensated after durable acceptance link failure: ${
            compensationErr instanceof Error
              ? compensationErr.message
              : String(compensationErr)
          }`,
        );
      } finally {
        await tryRes.release();
        void this.drainThread(threadId);
      }
      return;
    }

    // D420 (Wave 2 task 2.2.3 correction) — close the dispatch-vs-Stop race:
    // if the thread/room was stopped while this Job was being persisted and
    // durably linked, a concurrent user Stop won. Compensate the never-
    // dispatched Job instead of executing it. (Linkage already verified every
    // expected acceptance remained eligible; this gate covers the window
    // between a successful link and execution.) The user_cancelled acceptance
    // rows carry the truthful outcome; no synthetic cancelled Job is created.
    if (this.isThreadStopped(threadId) || this.isRoomStopped(merged.roomId)) {
      this.invalidateForegroundCandidates(virtualIds);
      try {
        await this.cancelUndispatchedJobForLedgerFailure(
          job,
          new Error(
            `dispatch-vs-stop race: thread/room stopped before execution for job=${job.id}`,
          ),
          DISPATCH_VS_STOP_RACE_CANCELLATION_REASON,
        );
      } catch (compensationErr) {
        log(
          `[maintenance] main job=${job.id} could not be fully compensated after dispatch-vs-stop race: ${
            compensationErr instanceof Error ? compensationErr.message : String(compensationErr)
          }`,
        );
      } finally {
        await tryRes.release();
        void this.drainThread(threadId);
      }
      return;
    }

    forkCoordinator.registerTurn(threadId, {
      sequence,
      jobId: job.id,
      turnId: merged.turnId,
      kind: "main",
      mergedSlice: coalescedToSlice(merged),
    });

    eventBus.emit({
      type: "job.dispatched",
      virtualJobIds: [...virtualIds],
      jobId: job.id,
      laneKey: merged.laneKey,
    });

    const foregroundCandidate = this.armForegroundCandidateForMain(
      virtualIds,
      merged.turnId,
    );

    const authority = this.jobToAuthority.get(job.id)!;
    const invocationAuthority = this.jobToInvocationAuthority.get(job.id)!;
    const execute = (
      inputOverride?: Readonly<{ message: string }>,
      authorizationSignal?: AbortSignal,
    ) => {
      if (inputOverride !== undefined) {
        // M296: on a successful shared-Room Shadow path, the Agent consumes the
        // canonical content reconstructed from the opened protected input set.
        // The persisted ordinary sibling remains the transition fallback.
        job.input["message"] = inputOverride.message;
      }
      return runWithAcceptedWorkAuthorities(
        authority,
        invocationAuthority,
        () => runWithInitiatingClientSurface(
          initiatingClientSurface,
          () => this.executeWithCurrentInvocationAccess(job, invocationAuthority, authorizationSignal),
        ),
      );
    };
    void (foregroundCandidate?.runMainTurn
      ? foregroundCandidate.runMainTurn(merged.turnId, execute)
      : execute())
      .catch(async (error: unknown) => {
        await job.fail(error);
      })
      .finally(() => {
        void tryRes.release();
        forkCoordinator.markMainCompleted(threadId, job.id);
        if (job.isTerminal()) {
          this.active.delete(job.id);
          this.abortReasons.delete(job.id);
          this.jobToAuthority.delete(job.id);
          this.jobToInvocationAuthority.delete(job.id);
        }
        if (this.isThreadStopped(threadId)) {
          const vids = this.coalescer.dropLaneVirtualIds(merged.laneKey);
          if (vids) {
            // D420 (Wave 2 task 2.2.3) — a buffered burst arrived mid-turn and
            // the thread is now stopped; terminalize its queued acceptances as
            // user_cancelled. Fire-and-forget with loud logging (race fallback
            // after the main turn completed; the Stop route is the awaitable
            // path).
            void this.terminalizeUserStoppedVirtualIds(vids).catch((err) => {
              log(
                `[lane] user_stop terminalization failed for post-turn lane=${merged.laneKey} thread=${threadId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          return;
        }
        // Same-lane burst that arrived mid-turn → flush it promptly.
        this.coalescer.flushIfPending(merged.laneKey);
        // Cross-user handoff (R5): wake whatever is queued for this thread,
        // regardless of which user's lane buffered it.
        void this.drainThread(threadId);
      })
      .catch(() => {
        log(`[lane] foreground_candidate_failure_status_persist_failed job=${job.id}`);
      });
  }

  private async dispatchForkForegroundJob(
    threadId: string,
    item: PendingTurn,
  ): Promise<void> {
    const { merged, virtualIds, route, initiatingClientSurface } = item;
    const sequence = forkCoordinator.nextSequence(threadId);
    const parentThreadId = merged.graphThreadId;
    const suffix = randomBytes(4).toString("hex");
    const forkThreadId = `${parentThreadId}:fork:${merged.turnId}:${suffix}`;
    const preds = forkCoordinator.getTurnsBeforeSequence(threadId, sequence);
    const parentJobId = forkCoordinator.getActiveMainJobId(threadId);

    // M170 — slim to identity only. Predecessor *content* now comes from the
    // DB transcript rebuild (R1); the count drives the R2b in-flight marker.
    const pendingTurns = preds.map((t) => ({
      sequence: t.sequence,
      turnId: t.turnId,
    }));

    const forkRun: ForkRunMetadata = {
      mode: "fork",
      parentThreadId,
      forkThreadId,
      checkpointThreadId: forkThreadId,
      transcriptThreadId: parentThreadId,
      sequence,
      ...(parentJobId ? { parentJobId } : {}),
      pendingTurns,
    };

    const inputRecord: Record<string, unknown> = {
      ...coalescedInputToJobInput(merged),
      forkRun,
    };
    const durableCandidate = virtualIds.length === 1
      ? this.virtualToForegroundCandidate.get(virtualIds[0]!)
      : undefined;
    const hasFullCandidate = virtualIds.some((virtualId) =>
      this.virtualToForegroundCandidate.get(virtualId)
        ?.durableJobInputDisposition === "full"
    );
    if (
      hasFullCandidate
      && durableCandidate?.durableJobInputReference === undefined
    ) {
      this.failAcceptedForegroundBeforePersistence(
        virtualIds, merged.laneKey, threadId, merged.roomId,
        "invalid_full_reference",
      );
      forkCoordinator.markForkCompleted(threadId, sequence);
      return;
    }
    const durableInputReference = durableCandidate?.durableJobInputReference;
    const durableInputDisposition = durableCandidate?.durableJobInputDisposition;

    /** Native LangGraph forks use their dedicated executor; injected routes keep their exact executor. */
    const executor =
      route.executor !== langgraphExecutor
        ? route.executor
        : getExecutor("foreground", inputRecord);

    const job = new Job({
      ownerId: merged.requestorId,
      requestorId: merged.requestorId,
      laneKey: merged.laneKey,
      type: "foreground",
      input: inputRecord,
      ...(durableInputReference === undefined
        ? {}
        : { durableInputReference }),
      ...(durableInputDisposition === undefined
        ? {}
        : { durableInputDisposition }),
      executor,
      persist: this.persistJobFn,
      updateStatus: this.updateJobStatusFn,
    });

    try {
      await job.persist();
    } catch {
      this.failAcceptedForegroundBeforePersistence(
        virtualIds, merged.laneKey, threadId, merged.roomId,
        "job_persistence_unavailable",
      );
      forkCoordinator.markForkCompleted(threadId, sequence);
      return;
    }
    this.active.set(job.id, job);

    // D420 — do not run a fork until its acceptance rows are durably linked.
    try {
      const linked = await this.linkAcceptancesForVirtualIds(
        virtualIds,
        job.id,
        merged.requestorId,
      );
      this.jobToAuthority.set(job.id, linked.maintenance);
      this.jobToInvocationAuthority.set(job.id, linked.invocation);
    } catch (err) {
      this.abandonInvocationAuthorities(virtualIds);
      this.invalidateForegroundCandidates(virtualIds);
      try {
        await this.cancelUndispatchedJobForLedgerFailure(job, err);
      } catch (compensationErr) {
        log(
          `[maintenance] fork job=${job.id} could not be fully compensated after durable acceptance link failure: ${
            compensationErr instanceof Error
              ? compensationErr.message
              : String(compensationErr)
          }`,
        );
      }
      return;
    }

    // D420 (Wave 2 task 2.2.3 correction) — dispatch-vs-Stop race gate for
    // forks (mirrors runMainTurn): if the thread/room was stopped while this
    // fork Job was persisted + linked, compensate it instead of executing.
    if (this.isThreadStopped(threadId) || this.isRoomStopped(merged.roomId)) {
      this.invalidateForegroundCandidates(virtualIds);
      try {
        await this.cancelUndispatchedJobForLedgerFailure(
          job,
          new Error(
            `dispatch-vs-stop race: thread/room stopped before fork execution for job=${job.id}`,
          ),
          DISPATCH_VS_STOP_RACE_CANCELLATION_REASON,
        );
      } catch (compensationErr) {
        log(
          `[maintenance] fork job=${job.id} could not be fully compensated after dispatch-vs-stop race: ${
            compensationErr instanceof Error ? compensationErr.message : String(compensationErr)
          }`,
        );
      }
      return;
    }

    const foregroundCandidate = this.armForegroundCandidateForFork(
      virtualIds,
      merged.turnId,
    );

    forkCoordinator.registerForkTurn(threadId, {
      sequence,
      jobId: job.id,
      turnId: merged.turnId,
      mergedSlice: coalescedToSlice(merged),
      forkThreadId,
    });

    eventBus.emit({
      type: "job.dispatched",
      virtualJobIds: [...virtualIds],
      jobId: job.id,
      laneKey: merged.laneKey,
    });

    eventBus.emit({
      type: "job.forked",
      laneKey: merged.laneKey,
      jobId: job.id,
      virtualJobIds: [...virtualIds],
      parentThreadId,
      forkThreadId,
      ...(parentJobId ? { parentJobId } : {}),
      syntheticNoteCount: preds.length,
      sequence,
    });

    const authority = this.jobToAuthority.get(job.id)!;
    const invocationAuthority = this.jobToInvocationAuthority.get(job.id)!;
    const execute = (
      inputOverride?: Readonly<{ message: string }>,
      authorizationSignal?: AbortSignal,
    ) => {
      if (inputOverride !== undefined) job.input["message"] = inputOverride.message;
      return runWithAcceptedWorkAuthorities(
        authority,
        invocationAuthority,
        () => runWithInitiatingClientSurface(
          initiatingClientSurface,
          () => this.executeWithCurrentInvocationAccess(job, invocationAuthority, authorizationSignal),
        ),
      );
    };
    void (foregroundCandidate?.runForkTurn
      ? foregroundCandidate.runForkTurn(merged.turnId, execute)
      : execute())
      .catch(async (error: unknown) => {
        await job.fail(error);
      })
      .finally(() => {
        if (job.isTerminal()) {
          this.active.delete(job.id);
          this.abortReasons.delete(job.id);
          this.jobToAuthority.delete(job.id);
          this.jobToInvocationAuthority.delete(job.id);
        }
        // M170 — a clean fork advances its own ordering from the executor
        // (after persisting its reply rows). A failed/cancelled fork wrote no
        // reply, so advance ordering here so the lane never hangs (R4). A
        // paused fork (interrupt) is NOT terminal-failed: it stays unreconciled
        // until the resume path advances it (R6).
        const fr = inputRecord["forkRun"] as ForkRunMetadata | undefined;
        if (fr?.mode === "fork") {
          const st = job.status;
          if (st === "failed" || st === "cancelled") {
            forkCoordinator.markForkCompleted(threadId, fr.sequence);
          }
        }
        if (this.isThreadStopped(threadId)) {
          const vids = this.coalescer.dropLaneVirtualIds(merged.laneKey);
          if (vids) {
            // D420 (Wave 2 task 2.2.3) — fork post-completion stop: terminalize
            // any buffered burst's queued acceptances as user_cancelled.
            void this.terminalizeUserStoppedVirtualIds(vids).catch((err) => {
              log(
                `[lane] user_stop terminalization failed for post-fork lane=${merged.laneKey} thread=${threadId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          return;
        }
        this.coalescer.flushIfPending(merged.laneKey);
        void this.drainThread(threadId);
      })
      .catch(() => {
        log(`[lane] fork_candidate_failure_status_persist_failed job=${job.id}`);
      });
  }

  async createBackgroundJob(
    ownerId: string,
    requestorId: string,
    input: Record<string, unknown>,
    /**
     * D420 (Wave 2 task 2.2.1) — presented by in-turn background spawns
     * (e.g. deep-research) which are continuation of an already-accepted
     * foreground turn. Omitted by the `POST /api/jobs` route so new external
     * background work is rejected during drain.
     */
    authority?: MaintenanceAcceptanceAuthority,
    /** M254 — accepted parent authority for an in-process continuation. */
    invocationAuthority?: AcceptedInvocationAuthority,
    /** Trusted Room return route, accepted only for the Deep Research tool. */
    deepResearchReturnContext?: DeepResearchReturnContext | null,
  ): Promise<Job> {
    // D420 — gate NEW background starts before the Job row is persisted. A
    // draining gate throws `MaintenanceDrainError` (no `authority`); an
    // in-turn spawn passes `authority` and is admitted as continuation.
    await this.resolveGate().assertAcceptingNewWork(authority);
    if (invocationAuthority) {
      assertAcceptedInvocationAuthoritySubject(invocationAuthority, requestorId);
    }
    const acceptedAuthority = authority ?? createMaintenanceAcceptanceAuthority();

    const isDeepResearch = input["type"] === "deep-research";
    if (
      deepResearchReturnContext &&
      (!isDeepResearch ||
        deepResearchReturnContext.ownerId !== ownerId ||
        deepResearchReturnContext.requestorId !== requestorId ||
        deepResearchReturnContext.laneKey !== `room:${deepResearchReturnContext.roomId}`)
    ) {
      throw new TypeError("Deep Research return context does not match accepted authority");
    }
    let acceptedInput = input;
    if (isDeepResearch) {
      const {
        deep_research_return_context: _untrustedReturnContext,
        ...inputWithoutReturnContext
      } = input;
      acceptedInput = {
        ...inputWithoutReturnContext,
        ...(deepResearchReturnContext
          ? {
              roomId: deepResearchReturnContext.roomId,
              deep_research_return_context: deepResearchReturnContext,
            }
          : {}),
      };
    }

    const job = new Job({
      ownerId,
      requestorId,
      laneKey: isDeepResearch && deepResearchReturnContext
        ? deepResearchReturnContext.laneKey
        : null,
      type: "background",
      input: acceptedInput,
      executor: getExecutor("background", acceptedInput),
      persist: this.persistJobFn,
      updateStatus: this.updateJobStatusFn,
    });

    await job.persist();
    const acceptedInvocationAuthority =
      bindInvocationOrigin(requestorId, acceptedInput, invocationAuthority);
    this.active.set(job.id, job);
    this.jobToAuthority.set(job.id, acceptedAuthority);
    this.jobToInvocationAuthority.set(job.id, acceptedInvocationAuthority);

    void runWithAcceptedWorkAuthorities(
      acceptedAuthority,
      acceptedInvocationAuthority,
      () => runWithInitiatingClientSurface("unknown", () => this.executeWithCurrentInvocationAccess(job, acceptedInvocationAuthority)),
    )
      .finally(() => {
        if (job.isTerminal()) {
          this.active.delete(job.id);
          this.abortReasons.delete(job.id);
          this.jobToAuthority.delete(job.id);
          this.jobToInvocationAuthority.delete(job.id);
        }
      })
      .catch(() => {});

    return job;
  }

  private async stopInvocationTask(humanUserId: string, scope: InvocationWorkScope): Promise<void> {
    if (!scope.taskId) return;
    if (!scope.taskRunId || !this.invocationTaskStop) {
      throw new Error("Exact Task invocation cancellation unavailable");
    }
    await this.invocationTaskStop({ humanUserId, taskId: scope.taskId, taskRunId: scope.taskRunId });
  }

  private async cancelInvocationJob(job: Job, humanUserId: string, reason: string = WORK_ACCEPTANCE_REASONS.accessWithdrawn): Promise<void> {
    this.pendingInvocationJobStops.set(job.id, { job, humanUserId, reason });
    await this.stopInvocationTask(humanUserId, invocationWorkScope(job.input));
    await job.cancel(reason);
    this.pendingInvocationJobStops.delete(job.id);
  }

  private async executeWithCurrentInvocationAccess(
    job: Job, authority: AcceptedInvocationAuthority, signal?: AbortSignal,
  ): Promise<void> {
    if (job.isTerminal()) return;
    const humanUserId = getAcceptedInvocationAuthoritySubject(authority);
    let allowed = false;
    let reason: string = WORK_ACCEPTANCE_REASONS.accessWithdrawn;
    try {
      allowed = await this.checkInvocationAccess({ humanUserId, ...invocationWorkScope(job.input, authority) });
    } catch {
      reason = "Cancelled because current invocation access could not be verified";
    }
    if (!allowed) {
      try {
        await this.cancelInvocationJob(job, humanUserId, reason);
      } catch {
        // Keep the exact work in the pending index for receipt recovery. No
        // executor starts, and a failed Task write cannot be mistaken for Stop.
        log("[invocation] durable cancellation pending; execution withheld");
      }
      return;
    }
    if (!job.isTerminal()) await job.execute(signal);
  }

  /** Every process checks its own accepted work against shared current authority.
   * No receipt cursor or winner on another server can suppress this sweep.
   */
  async reconcileAllInvocationAccess(): Promise<void> {
    const humans = new Set<string>();
    for (const authority of this.virtualToInvocationAuthority.values()) humans.add(getAcceptedInvocationAuthoritySubject(authority));
    for (const authority of this.jobToInvocationAuthority.values()) humans.add(getAcceptedInvocationAuthoritySubject(authority));
    for (const pending of this.pendingInvocationJobStops.values()) humans.add(pending.humanUserId);
    const failures: unknown[] = [];
    for (const human of humans) {
      try { await this.reconcileInvocationAccess(human); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
  }

  /** Reconcile only the initiating Human, using current access rather than replaying a ban. */
  async reconcileInvocationAccess(humanUserId: string): Promise<void> {
    const virtual = [...this.virtualToInvocationAuthority].flatMap(([id, authority]) => {
      if (getAcceptedInvocationAuthoritySubject(authority) !== humanUserId) return [];
      const scope = this.virtualInvocationScopes.get(id);
      return scope ? [{ id, scope }] : [];
    });
    const jobs = new Map<string, Job>();
    for (const [id, authority] of this.jobToInvocationAuthority) {
      if (getAcceptedInvocationAuthoritySubject(authority) !== humanUserId) continue;
      const job = this.active.get(id);
      if (job) jobs.set(id, job);
    }
    for (const [id, pending] of this.pendingInvocationJobStops) {
      if (pending.humanUserId === humanUserId) jobs.set(id, pending.job);
    }

    const errors: unknown[] = [];
    const denied: Array<{ id: string; scope: InvocationWorkScope }> = [];
    for (const { id, scope } of virtual) {
      try {
        if (!scope.withdrawn && await this.checkInvocationAccess({ humanUserId, ...scope })) continue;
        // A concurrent dispatch may have linked this unit during the query.
        // Its own execution gate then owns the fresh check.
        if (this.virtualInvocationScopes.get(id) !== scope) continue;
        scope.withdrawn = true;
        denied.push({ id, scope });
      } catch (error) { errors.push(error); }
    }
    const ids = new Set(denied.map(item => item.id));
    for (const lane of this.coalescer.removeVirtualJobs(ids)) {
      this.bufferedRouteByLane.delete(lane);
      this.bufferedInvocationSubjectByLane.delete(lane);
      this.bufferedCoalescingBoundaryByLane.delete(lane);
    }
    for (const queue of this.pendingByThread.values()) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]!.virtualIds.every(id => ids.has(id))) queue.splice(index, 1);
      }
    }
    const stopped: string[] = [];
    for (const { id, scope } of denied) {
      try { await this.stopInvocationTask(humanUserId, scope); stopped.push(id); }
      catch (error) { errors.push(error); }
    }
    try {
      await this.terminalizeUserStoppedVirtualIds(stopped, WORK_ACCEPTANCE_REASONS.accessWithdrawn);
    } catch (error) { errors.push(error); }
    for (const job of jobs.values()) {
      try {
        if (!this.pendingInvocationJobStops.has(job.id)
          && (job.isTerminal() || await this.checkInvocationAccess({ humanUserId,
            ...invocationWorkScope(job.input, this.jobToInvocationAuthority.get(job.id)) }))) continue;
        await this.cancelInvocationJob(job, humanUserId, this.pendingInvocationJobStops.get(job.id)?.reason);
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }

  getJob(id: string): Job | undefined {
    return this.active.get(id);
  }

  getActiveJobs(): Job[] {
    return Array.from(this.active.values()).filter((j) => j.isRunning());
  }

  /** Includes registered resume workers before their running event. */
  hasTaskContentAccessRecoveryWorker(graphThreadId: string, laneKey: string): boolean {
    return [...this.active.values()].some((job) => !job.isTerminal()
      && (job.input["graphThreadId"] === graphThreadId || job.laneKey === laneKey));
  }

  /**
   * D420 — the admission gate for this manager. An explicit constructor gate
   * wins (test injection); otherwise the runtime singleton is resolved at
   * call time so `createApp`'s boot wiring takes effect for the production
   * singleton without reconstructing it.
   */
  private resolveGate(): MaintenanceGate {
    return this.maintenanceGate ?? getMaintenanceGate();
  }

  /**
   * Recover the immutable route selected at acceptance. Coalescer buffers are
   * split before incompatible routes can enter, so a mismatch here is an
   * internal invariant failure rather than a last-writer-wins policy choice.
   */
  private routeForVirtualIds(virtualIds: readonly string[]): ForegroundExecutionRoute {
    const firstVirtualId = virtualIds[0];
    const first = firstVirtualId
      ? this.virtualToExecutionRoute.get(firstVirtualId)
      : undefined;
    if (!first) {
      throw new Error(
        `Missing foreground execution route for virtual job ${firstVirtualId ?? "(empty group)"}`,
      );
    }
    for (const virtualId of virtualIds) {
      const route = this.virtualToExecutionRoute.get(virtualId);
      if (!route || !routesAreCompatible(first, route)) {
        throw new Error(
          `Incompatible foreground execution routes in accepted group ${virtualIds.join(",")}`,
        );
      }
    }
    return first;
  }

  /**
   * D420 — persist a payload-free acceptance row for `virtualJobId` before
   * enqueue and remember the `virtualJobId → acceptanceId` binding for
   * link-at-dispatch. Insert errors deliberately propagate: without a durable
   * acceptance row, this unit must never enter the coalescer.
   */
  private async acceptForegroundAcceptance(
    virtualJobId: string,
    kind: WorkAcceptanceKind,
  ): Promise<void> {
    const acceptanceId = await this.acceptanceSinks.insertAcceptance(kind);
    this.virtualToAcceptance.set(virtualJobId, acceptanceId);
  }

  /**
   * D420 — link the coalesced group's acceptance rows to the created Job
   * (`accepted → dispatched`) before it can execute. Bindings are removed
   * only after the durable write succeeds. A missing binding is also a
   * fail-closed error: running that unit would make its acceptance ledger
   * untruthful.
   *
   * D420 (Wave 2 task 2.2.3 correction) — the durable link must verify EVERY
   * expected acceptance remained eligible for linking. The sink returns the
   * count of rows that actually transitioned `accepted → dispatched`; if that
   * is less than the group size, a concurrent user Stop terminalized some of
   * them as `user_cancelled` (the dispatch-vs-Stop race). Stop won for those
   * units, so this method throws and the caller compensates the never-
   * dispatched Job instead of executing it. The user_cancelled rows already
   * record the truthful outcome; no synthetic cancelled Job is created and
   * `dispatched` is never used as an arbitrary terminal value.
   */
  private async linkAcceptancesForVirtualIds(
    virtualIds: readonly string[],
    jobId: string,
    humanUserId: string,
  ): Promise<{
    maintenance: MaintenanceAcceptanceAuthority;
    invocation: AcceptedInvocationAuthority;
  }> {
    if (virtualIds.some(id => this.virtualInvocationScopes.get(id)?.withdrawn)) {
      throw new Error("Accepted invocation access withdrawn");
    }
    // Keep references across the ledger await: durable cancellation can clear
    // the indexes before the in-flight link returns.
    const invocationScopes = virtualIds.map(id => this.virtualInvocationScopes.get(id));
    const acceptanceIds = virtualIds.map((virtualId) => {
      const acceptanceId = this.virtualToAcceptance.get(virtualId);
      if (!acceptanceId) {
        throw new Error(
          `Missing durable acceptance mapping for virtual job ${virtualId}`,
        );
      }
      return acceptanceId;
    });
    const authority = this.virtualToAuthority.get(virtualIds[0] ?? "");
    if (!authority) {
      throw new Error(
        `Missing accepted-work authority for virtual job ${virtualIds[0] ?? "(empty group)"}`,
      );
    }
    for (const virtualId of virtualIds) {
      if (!this.virtualToAuthority.has(virtualId)) {
        throw new Error(`Missing accepted-work authority for virtual job ${virtualId}`);
      }
    }
    let invocationAuthority: AcceptedInvocationAuthority | undefined;
    for (const virtualId of virtualIds) {
      const candidate = this.virtualToInvocationAuthority.get(virtualId);
      if (!candidate) {
        throw new Error(
          `Missing accepted invocation authority for virtual job ${virtualId}`,
        );
      }
      // This is also the final fail-closed coalescing invariant: every merged
      // turn must belong to the one Human carried by the merged input.
      assertAcceptedInvocationAuthoritySubject(candidate, humanUserId);
      invocationAuthority = candidate;
    }
    if (!invocationAuthority) {
      throw new Error("Missing accepted invocation authority for empty group");
    }
    const linkedCount = await this.acceptanceSinks.linkAcceptancesToJob(
      acceptanceIds,
      jobId,
    );
    if (invocationScopes.some(scope => scope?.withdrawn)) {
      throw new Error("Accepted invocation access withdrawn during linkage");
    }
    if (linkedCount !== acceptanceIds.length) {
      // Dispatch-vs-Stop race: a concurrent user Stop terminalized some of the
      // expected acceptances as user_cancelled (or a prior link/terminalize
      // claimed them). Stop won; compensate the Job, do not execute. The
      // rows that DID link are `dispatched` against this real (compensated)
      // Job; the rest are terminal on the ledger.
      throw new Error(
        `acceptance link race for job=${jobId}: expected ${acceptanceIds.length} accepted rows but ${linkedCount} remained eligible (concurrent user Stop)`,
      );
    }
    for (const virtualId of virtualIds) {
      this.virtualToAcceptance.delete(virtualId);
      this.virtualToAuthority.delete(virtualId);
      this.virtualToInvocationAuthority.delete(virtualId);
      this.virtualInvocationScopes.delete(virtualId);
      this.virtualToExecutionRoute.delete(virtualId);
      this.virtualToTaskId.delete(virtualId);
    }
    return { maintenance: authority, invocation: invocationAuthority };
  }

  private invalidateForegroundCandidates(virtualIds: readonly string[]): void {
    for (const virtualId of virtualIds) {
      const candidate = this.virtualToForegroundCandidate.get(virtualId);
      this.virtualToForegroundCandidate.delete(virtualId);
      try {
        candidate?.onIneligible();
      } catch {
        // Exact-client eligibility must never affect scheduler truth.
      }
    }
  }

  /**
   * A durable acceptance exists, but no Job row was created. Preserve every
   * acceptance/authority mapping for Stop or maintenance recovery and emit a
   * payload-free terminal signal against the virtual IDs the caller knows.
   */
  private failAcceptedForegroundBeforePersistence(
    virtualIds: readonly string[],
    laneKey: string,
    threadId: string,
    roomId: string,
    reason: "invalid_full_reference" | "job_persistence_unavailable",
  ): void {
    this.invalidateForegroundCandidates(virtualIds);
    log(`[lane] foreground_pre_persistence_failed reason=${reason}`);
    for (const virtualJobId of virtualIds) {
      this.failedPrePersistenceScope.set(virtualJobId, { threadId, roomId });
      eventBus.emit({
        type: "job.status",
        jobId: virtualJobId,
        status: "failed",
        laneKey,
      });
    }
  }

  private async releaseLaneAfterPrePersistenceFailure(
    lock: Extract<TryAcquireResult, { acquired: true }>,
  ): Promise<void> {
    try {
      await lock.release();
    } catch {
      // A failed release must not become another unhandled drain rejection.
      // The lock implementation owns recovery; never expose its raw error.
      log("[lane] foreground_pre_persistence_lock_release_failed");
    }
  }

  private armForegroundCandidateForMain(
    virtualIds: readonly string[],
    turnId: string,
  ): ForegroundTurnCandidate | undefined {
    if (virtualIds.length !== 1 || !turnId) {
      this.invalidateForegroundCandidates(virtualIds);
      return undefined;
    }
    const virtualId = virtualIds[0]!;
    const candidate = this.virtualToForegroundCandidate.get(virtualId);
    this.virtualToForegroundCandidate.delete(virtualId);
    try {
      candidate?.onMainTurn(turnId);
    } catch {
      // Exact-client eligibility must never affect scheduler truth.
      try {
        candidate?.onIneligible();
      } catch {
        // Candidate cleanup is subordinate to scheduler truth.
      }
      return undefined;
    }
    return candidate;
  }

  private armForegroundCandidateForFork(
    virtualIds: readonly string[],
    turnId: string,
  ): ForegroundTurnCandidate | undefined {
    if (virtualIds.length !== 1 || !turnId) {
      this.invalidateForegroundCandidates(virtualIds);
      return undefined;
    }
    const virtualId = virtualIds[0]!;
    const candidate = this.virtualToForegroundCandidate.get(virtualId);
    this.virtualToForegroundCandidate.delete(virtualId);
    if (candidate?.onForkTurn === undefined) {
      try {
        candidate?.onIneligible();
      } catch {
        // Candidate cleanup is subordinate to scheduler truth.
      }
      return undefined;
    }
    try {
      candidate.onForkTurn(turnId);
    } catch {
      try {
        candidate.onIneligible();
      } catch {
        // Candidate cleanup is subordinate to scheduler truth.
      }
      return undefined;
    }
    return candidate;
  }

  /**
   * D420 (Wave 2 task 2.2.3 correction) — durably terminalize the mapped
   * acceptances of discarded queued/buffered virtual IDs as `user_cancelled`
   * (a D349 user Stop), then clear only the resolved in-memory mappings.
   * Idempotent: virtual IDs without a mapping (already linked/dispatched or
   * already cleared) contribute no acceptance id and are skipped; the durable
   * op itself only touches still-`accepted` rows, so a double call is a no-op.
   * Errors propagate so the Stop route can fail loudly (R8).
   */
  private async terminalizeUserStoppedVirtualIds(
    virtualIds: readonly string[],
    reason: WorkAcceptanceReason = WORK_ACCEPTANCE_REASONS.userStop,
  ): Promise<number> {
    this.invalidateForegroundCandidates(virtualIds);
    if (virtualIds.length === 0) return 0;
    const acceptanceIds: string[] = [];
    for (const virtualId of virtualIds) {
      const acceptanceId = this.virtualToAcceptance.get(virtualId);
      if (acceptanceId) acceptanceIds.push(acceptanceId);
    }
    if (acceptanceIds.length === 0) return 0;
    const terminalized = await this.acceptanceSinks.userCancelAcceptedWork(
      acceptanceIds,
      reason,
    );
    // Clear only the resolved mappings (those that had an acceptance binding).
    for (const virtualId of virtualIds) {
      if (this.virtualToAcceptance.has(virtualId)) {
        this.virtualToAcceptance.delete(virtualId);
        this.virtualToAuthority.delete(virtualId);
        this.virtualToInvocationAuthority.delete(virtualId);
        this.virtualInvocationScopes.delete(virtualId);
        this.virtualToExecutionRoute.delete(virtualId);
        this.virtualToTaskId.delete(virtualId);
        this.failedPrePersistenceScope.delete(virtualId);
      }
    }
    return terminalized;
  }

  /** Drop only the non-durable M254 projection when accepted work is abandoned. */
  private abandonInvocationAuthorities(virtualIds: readonly string[]): void {
    for (const virtualId of virtualIds) {
      if (this.virtualInvocationScopes.get(virtualId)?.withdrawn) continue;
      this.virtualToInvocationAuthority.delete(virtualId);
      this.virtualInvocationScopes.delete(virtualId);
    }
  }

  /**
   * Stop the canonical Task lifecycle for accepted task-run work that has not
   * reached a concrete Job yet. This is intentionally keyed by the virtual
   * acceptance rather than by a Room or graph thread: the latter are routing
   * facts, while the Task is the durable terminalization authority.
   */
  private async stopQueuedTaskRuns(
    virtualIds: readonly string[],
    alreadyStopped = new Set<string>(),
  ): Promise<void> {
    if (!this.taskStopSink) return;
    for (const virtualId of virtualIds) {
      const taskId = this.virtualToTaskId.get(virtualId);
      if (!taskId || alreadyStopped.has(taskId)) continue;
      alreadyStopped.add(taskId);
      await this.requestTaskStop(taskId);
    }
  }

  private async requestTaskStop(taskId: string): Promise<void> {
    if (!this.taskStopSink) return;
    const existing = this.taskStopRequests.get(taskId);
    if (existing) return existing;
    const request = Promise.resolve().then(() => this.taskStopSink!(taskId));
    this.taskStopRequests.set(taskId, request);
    try {
      await request;
    } finally {
      if (this.taskStopRequests.get(taskId) === request) {
        this.taskStopRequests.delete(taskId);
      }
    }
  }

  /**
   * D420 — explicit compensation for a Job row written before the acceptance
   * link failed (or before a concurrent user Stop claimed the group). The job
   * is terminalized before it has executed or emitted `job.dispatched`; the
   * untouched acceptance mappings remain `accepted` for the later 2.2.3 owner
   * to terminalize truthfully, or were already terminalized as
   * `user_cancelled` by the winning Stop.
   */
  private async cancelUndispatchedJobForLedgerFailure(
    job: Job,
    cause: unknown,
    reason: string = ACCEPTANCE_LINK_FAILURE_CANCELLATION_REASON,
  ): Promise<void> {
    try {
      await job.cancel(reason);
    } catch (err) {
      log(
        `[maintenance] failed to compensate job=${job.id} after acceptance link failure: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    } finally {
      this.active.delete(job.id);
      this.abortReasons.delete(job.id);
      this.jobToAuthority.delete(job.id);
      this.jobToInvocationAuthority.delete(job.id);
    }
    log(
      `[maintenance] cancelled undispatched job=${job.id} because durable acceptance linkage failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  /**
   * Release-readiness view of committed foreground work. This deliberately
   * exposes only aggregate counts: prompt text, job ids, lane keys, room ids,
   * and any other input metadata stay inside the runtime.
   */
  getForegroundWorkSummary(): ForegroundWorkSummary {
    let runningJobs = 0;
    for (const job of this.active.values()) {
      if (job.type === "foreground" && job.isRunning()) runningJobs += 1;
    }

    let queuedTurns = 0;
    for (const queue of this.pendingByThread.values()) queuedTurns += queue.length;

    return {
      runningJobs,
      queuedTurns,
      bufferedLanes: this.coalescer.getBufferedLaneCount(),
    };
  }

  /**
   * D420 (Wave 2 task 2.2.2) — maintenance executable-work view. This is
   * intentionally distinct from the legacy release-readiness summary above:
   * task jobs are counted by the durable task-run aggregate rather than here,
   * so a running Task backed by a foreground Job cannot be double-counted.
   */
  getExecutableJobWorkSummary(): ExecutableJobWorkSummary {
    let runningForegroundJobs = 0;
    let runningBackgroundJobs = 0;
    for (const job of this.active.values()) {
      if (!job.isRunning()) continue;
      if (job.type === "background") {
        runningBackgroundJobs += 1;
        continue;
      }
      // Task dispatch places its durable task-run id on the Job input before
      // enqueue. The task query reports every running task-run (including
      // these Job-backed runs), so keep the categories mutually exclusive.
      if (typeof job.input["taskRunId"] !== "string") {
        runningForegroundJobs += 1;
      }
    }

    let queuedTurns = 0;
    for (const queue of this.pendingByThread.values()) queuedTurns += queue.length;

    return {
      runningForegroundJobs,
      runningBackgroundJobs,
      queuedTurns,
      bufferedLanes: this.coalescer.getBufferedLaneCount(),
    };
  }

  /**
   * Terminalize live foreground work before a deliberate process shutdown.
   * Queued/buffered turns have no persisted Job row yet, so they are dropped;
   * active Jobs are cancelled with a durable, operator-visible reason. As in
   * Room Stop and the maintenance-deadline drain, task-backed Jobs first route
   * through the canonical Task lifecycle so their Task/TaskRun rows cannot be
   * left `running`; a missing or failed sink falls back to direct Job cancel.
   * D420 acceptance terminalization is deliberately NOT wired here: without
   * the maintenance ownership/gate/timeout transaction from task 2.2.3, this
   * old process-shutdown path cannot promise a truthful durable outcome for
   * every queued or buffered acceptance. Their `accepted` rows remain for
   * 2.2.3's explicit terminalization policy. Foreground work is intentionally
   * not resumed after restart.
   */
  async cancelForegroundJobsForPlannedShutdown(): Promise<PlannedShutdownResult> {
    const summary = this.getForegroundWorkSummary();
    const jobs = Array.from(this.active.values()).filter(
      (job) => job.type === "foreground" && job.isRunning(),
    );

    // Prevent drain loops from dispatching their current queue while the
    // cancellation persistence below is in flight.
    for (const threadId of this.pendingByThread.keys()) this.stoppedThreads.add(threadId);
    this.pendingByThread.clear();
    this.coalescer.dropAllLanes();
    this.virtualToExecutionRoute.clear();
    this.virtualToInvocationAuthority.clear();
    this.virtualInvocationScopes.clear();
    this.bufferedRouteByLane.clear();
    this.bufferedInvocationSubjectByLane.clear();
    this.bufferedCoalescingBoundaryByLane.clear();

    await Promise.all(
      jobs.map(async (job) => {
        const taskId = typeof job.input["taskId"] === "string" ? job.input["taskId"] : null;
        const taskRunId =
          typeof job.input["taskRunId"] === "string" ? job.input["taskRunId"] : null;
        if (taskId && taskRunId && this.taskStopSink) {
          try {
            await this.requestTaskStop(taskId);
            return;
          } catch (err) {
            log(
              `[maintenance] planned-shutdown stopTask failed for task=${taskId} run=${taskRunId}: ${
                err instanceof Error ? err.message : String(err)
              } — falling back to direct job cancel`,
            );
          }
        }
        await job.cancel(PLANNED_SHUTDOWN_CANCELLATION_REASON, "process_lost");
      }),
    );

    return { ...summary, cancelledJobs: jobs.length };
  }

  /**
   * D420 (Wave 2 task 2.2.3) — terminalize ALL remaining executable work at the
   * `--wait-for` drain deadline so the upgrade transaction may proceed against a
   * settled server (R8). This is the operator action the CLI invokes when the
   * bounded drain cannot reach zero on its own.
   *
   * It terminalizes, in one pass:
   *  - running foreground AND background Jobs (cancelled with a durable,
   *    operator-visible maintenance reason);
   *  - per-thread queued turns and coalescer buffered lanes (dropped before
   *    dispatch — they have no persisted Job row);
   *  - every durable `accepted` (un-dispatched) work-acceptance ledger row
   *    (terminalized `maintenance_cancelled` so the ledger never silently drops
   *    queued/buffered intent — R11).
   *
   * Preserved (NOT touched here):
   *  - durable background work already `paused` or `awaiting` human reply. Those
   *    task runs are not running Jobs (their Jobs already terminated when the
   *    graph parked), so they are not in `this.active`; their durable rows keep
   *    their `paused`/`awaiting` state across the drain. No pause/resume/replay
   *    recovery is claimed (D422 owns that).
   *
   * Running task-run Jobs are terminalized through the task lifecycle
   * ({@link taskStopSink} → `stopTask`) so the durable `task_runs`/`tasks` rows
   * are stamped `cancelled`; a plain `Job.cancel()` would abort the in-memory
   * Job but leave the durable run `running` (the task-run executor's abort path
   * assumes the lifecycle fn already wrote the terminal status). When no sink is
   * wired (hermetic tests), task-run Jobs fall back to a direct cancel.
   *
   * Errors from the acceptance sweep propagate (fail closed): without a truthful
   * durable outcome for every queued/buffered unit, the upgrade must not proceed.
   */
  async terminalizeExecutableWorkForMaintenance(): Promise<MaintenanceCancellationResult> {
    // Snapshot running Jobs before any mutation; `job.cancel()` and `stopTask`
    // both modify `this.active` (via the executor's terminal `.finally()`).
    const runningJobs = Array.from(this.active.values()).filter((job) => job.isRunning());

    // Freeze drain loops out of their current queue: mark every thread stopped
    // so a racing `drainThread` no-ops, then drop queued turns + buffered lanes.
    let droppedQueuedTurns = 0;
    for (const [threadId, queue] of this.pendingByThread.entries()) {
      this.stoppedThreads.add(threadId);
      droppedQueuedTurns += queue.length;
    }
    this.pendingByThread.clear();
    const droppedBufferedLanes = this.coalescer.dropAllLanes();

    // Cancel running Jobs. Task-run Jobs go through the task lifecycle so the
    // durable task run is terminalized; everything else cancels directly. A
    // failed `stopTask` falls back to a direct cancel so the in-memory Job is
    // never left running, and the error is logged for the reconcile to surface.
    let cancelledJobs = 0;
    let cancelledTaskRuns = 0;
    for (const job of runningJobs) {
      const taskId = typeof job.input["taskId"] === "string" ? job.input["taskId"] : null;
      const taskRunId =
        typeof job.input["taskRunId"] === "string" ? job.input["taskRunId"] : null;
      if (taskId && taskRunId && this.taskStopSink) {
        try {
          await this.requestTaskStop(taskId);
          cancelledTaskRuns += 1;
        } catch (err) {
          log(
            `[maintenance] stopTask failed for task=${taskId} run=${taskRunId}: ${
              err instanceof Error ? err.message : String(err)
            } — falling back to direct job cancel`,
          );
          await job.cancel(MAINTENANCE_DRAIN_CANCELLATION_REASON).catch(() => {});
        }
      } else {
        await job.cancel(MAINTENANCE_DRAIN_CANCELLATION_REASON).catch(() => {});
      }
      cancelledJobs += 1;
    }

    // Terminalize every durable accepted (un-dispatched) ledger row. This is a
    // blanket sweep so orphaned `accepted` rows from a prior restart are also
    // reconciled and the aggregate `acceptedWork` count reaches zero truthfully.
    // The sweep filters on `status='accepted'`, so `user_cancelled` rows
    // (D349 user-Stop outcomes recorded by stopRoom/stopThread) are left
    // untouched — a maintenance drain never relabels a user stop (R8).
    const terminalizedAcceptances = await this.acceptanceSinks.terminalizeAllAcceptedWork(
      WORK_ACCEPTANCE_REASONS.maintenanceDrain,
    );

    // The in-memory pending-acceptance tracking is now fully resolved: every
    // tracked virtual id was either dispatched earlier (linked) or just
    // terminalized by the sweep. Drop the bindings so a post-cancel status read
    // cannot observe stale pending state.
    this.virtualToAcceptance.clear();
    this.failedPrePersistenceScope.clear();
    this.virtualToAuthority.clear();
    this.virtualToInvocationAuthority.clear();
    this.virtualInvocationScopes.clear();
    this.virtualToExecutionRoute.clear();
    this.invalidateForegroundCandidates([...this.virtualToForegroundCandidate.keys()]);
    this.virtualToTaskId.clear();
    this.bufferedRouteByLane.clear();
    this.bufferedInvocationSubjectByLane.clear();
    this.bufferedCoalescingBoundaryByLane.clear();

    return {
      cancelledJobs,
      cancelledTaskRuns,
      droppedQueuedTurns,
      droppedBufferedLanes,
      terminalizedAcceptances,
    };
  }

  /**
   * D353 — ids of currently-running (non-terminal) jobs whose room matches.
   * Read seam for the client's reconnect run-state reconcile: lets the
   * workbench rebuild `liveJobIdsRef`/`isRunning` from server truth after a
   * WS gap dropped a terminal `job.status`. Mirrors `stopRoom`'s room match
   * (`jobRoomId`) on the read side. Includes forks (same parent room).
   */
  getActiveJobIdsForRoom(roomId: string): string[] {
    if (!roomId) return [];
    const ids: string[] = [];
    for (const job of this.active.values()) {
      if (job.isRunning() && jobBelongsToRoom(job, roomId)) ids.push(job.id);
    }
    return ids;
  }

  /**
   * Reconcile an approval-paused native fork and wake any serialized
   * foreground route waiting behind it. The resume path must use this seam
   * instead of advancing the coordinator alone: a serialize route deliberately
   * stays queued while an earlier fork is unresolved, so ordering advancement
   * and queue wakeup are one runtime operation.
   */
  reconcileForkAndResumePendingTurns(forkThreadId: string): void {
    const parentThreadId =
      forkCoordinator.markForkCompletedByCheckpoint(forkThreadId);
    if (parentThreadId) void this.drainThread(parentThreadId);
  }

  async cancelJob(id: string): Promise<boolean> {
    const job = this.active.get(id);
    if (!job) return false;
    await job.cancel();
    return true;
  }

  /**
   * M147 (R1) — the shared, job-kind-agnostic abort seam. Looks up the live
   * `Job` in `this.active` (keyed by `jobId`); if found, aborts it via the
   * SAME `Job.cancel()` machinery `cancelJob` uses (fires the
   * `AbortController`, marks the job terminal `cancelled`, persists, emits
   * `job.status:cancelled`) and returns `true`. Returns `false` for an
   * unknown / already-terminal id (it is no longer in `active`).
   *
   * This is the universal primitive every stop surface funnels through: a
   * foreground main turn, an M085 fork, a task run, or a background job —
   * all live in `this.active` by `jobId`. The optional `reason` records WHY
   * (pause vs stop) for advisory consumers (see {@link getAbortReason}); the
   * job-level effect is identical regardless of reason.
   *
   * Unlike `cancelJob`, this does not await the cancel (callers — the task
   * lifecycle fns + the `/api/jobs/:id/stop` route — only need to know the
   * job was live); the abort is synchronous (the controller fires before
   * `cancel()` yields) so the executor's signal is already aborted on return.
   */
  abortJob(jobId: string, reason?: AbortReason, taskRun?: { taskId: string; taskRunId: string }): boolean {
    // Approval resumes belong to the same durable TaskRun, but its original
    // persisted Job has already completed at the interrupt. Their ephemeral
    // Jobs share this active registry and must receive the same cancellation.
    const jobs = taskRun
      ? [...this.active.values()].filter((job) => job.input["taskId"] === taskRun.taskId && job.input["taskRunId"] === taskRun.taskRunId)
      : [this.active.get(jobId)].filter((job): job is Job => job !== undefined);
    for (const job of jobs) {
      if (reason) this.abortReasons.set(job.id, reason);
      void job.cancel().catch(() => {});
    }
    return jobs.length > 0;
  }

  /**
   * D349 — stop a conversation thread. D420 (Wave 2 task 2.2.3 correction)
   * makes this async and awaitably durably terminalizes the discarded queued
   * turns' and buffered lanes' mapped acceptances as `user_cancelled` BEFORE
   * returning, so the Stop route's caller never receives success before the
   * durable outcome completes. A terminalization failure propagates (fail
   * loudly). Running Jobs are aborted via {@link abortJob}; their acceptances
   * were already linked (`dispatched`) so they are not re-terminalized here.
   */
  async stopThread(threadId: string): Promise<StopScopeResult> {
    if (!threadId) return { stoppedJobs: 0, droppedQueuedTurns: 0, droppedBufferedLanes: 0 };
    this.stoppedThreads.add(threadId);
    const q = this.pendingByThread.get(threadId);
    const droppedQueuedTurns = q?.length ?? 0;
    // Preserve the queued virtual IDs BEFORE clearing the queue.
    const queuedVirtualIds = q ? q.flatMap((item) => item.virtualIds) : [];
    const failedVirtualIds = [...this.failedPrePersistenceScope]
      .filter(([, scope]) => scope.threadId === threadId)
      .map(([virtualId]) => virtualId);
    this.pendingByThread.delete(threadId);

    const lanes = new Set<string>();
    const stoppedTaskIds = new Set<string>();
    for (const job of this.active.values()) {
      const jobThread = threadIdForJob(job);
      if (jobThread === threadId) {
        if (job.laneKey) lanes.add(job.laneKey);
        const taskId = typeof job.input["taskId"] === "string" ? job.input["taskId"] : null;
        const taskRunId = typeof job.input["taskRunId"] === "string" ? job.input["taskRunId"] : null;
        // A task-backed Job has durable Task/TaskRun state in addition to its
        // in-memory Job. Route it through the existing task lifecycle so Room
        // Stop cannot leave that durable run behind as `running`. The lifecycle
        // owns the single abort; do not follow it with a second direct abort.
        if (taskId && taskId.length > 0 && taskRunId && taskRunId.length > 0 && this.taskStopSink) {
          if (!stoppedTaskIds.has(taskId)) {
            stoppedTaskIds.add(taskId);
            await this.requestTaskStop(taskId);
          }
          continue;
        }
        this.abortJob(job.id, "stop");
      }
    }
    for (const item of q ?? []) lanes.add(item.laneKey);

    let droppedBufferedLanes = 0;
    const laneVirtualIds: string[] = [];
    for (const lane of lanes) {
      const vids = this.coalescer.dropLaneVirtualIds(lane);
      this.bufferedRouteByLane.delete(lane);
      this.bufferedInvocationSubjectByLane.delete(lane);
      this.bufferedCoalescingBoundaryByLane.delete(lane);
      if (vids) {
        droppedBufferedLanes += 1;
        laneVirtualIds.push(...vids);
      }
    }

    // A queued task-run has no concrete Job yet, so the active-Job loop above
    // cannot find it. Terminalize it before releasing the accepted virtual
    // work. The same sink is used for active task-backed Jobs, so duplicate
    // Stop remains idempotent at the canonical Task lifecycle.
    await this.stopQueuedTaskRuns(
      [...queuedVirtualIds, ...laneVirtualIds, ...failedVirtualIds],
      stoppedTaskIds,
    );

    // D420 (2.2.3) — durably terminalize the discarded queued + buffered
    // acceptances as user_cancelled before returning (R8). Idempotent; clears
    // only the resolved mappings.
    await this.terminalizeUserStoppedVirtualIds([
      ...queuedVirtualIds,
      ...laneVirtualIds,
      ...failedVirtualIds,
    ]);

    return {
      stoppedJobs: Array.from(this.active.values()).filter(
        (job) => threadIdForJob(job) === threadId && this.getAbortReason(job.id) === "stop",
      ).length,
      droppedQueuedTurns,
      droppedBufferedLanes,
    };
  }

  /**
   * D349 — stop a room. D420 (Wave 2 task 2.2.3 correction) makes this async
   * and awaitably durably terminalizes the room's discarded queued turns and
   * buffered lanes as `user_cancelled` before returning (R8). Delegates the
   * per-thread queued + buffered terminalization to {@link stopThread}; the
   * room-level buffered lanes (whose thread may not yet be known) are
   * terminalized here. `dropLanesForRoom` runs first so `stopThread`'s per-
   * lane drop is an idempotent no-op and no virtual ID is terminalized twice.
   */
  async stopRoom(roomId: string): Promise<StopScopeResult> {
    if (!roomId) return { stoppedJobs: 0, droppedQueuedTurns: 0, droppedBufferedLanes: 0 };
    this.stoppedRooms.add(roomId);
    const threadIds = new Set<string>();
    for (const [threadId, q] of this.pendingByThread.entries()) {
      if (q.some((item) => item.merged.roomId === roomId)) threadIds.add(threadId);
    }
    for (const job of this.active.values()) {
      if (jobBelongsToRoom(job, roomId)) {
        const threadId = threadIdForJob(job);
        if (threadId) threadIds.add(threadId);
      }
    }
    for (const scope of this.failedPrePersistenceScope.values()) {
      if (scope.roomId === roomId) threadIds.add(scope.threadId);
    }

    // Drop ALL buffered lanes for this room first and collect their virtual
    // IDs for durable user_cancelled terminalization.
    const roomLanes = this.coalescer.dropLanesForRoom(roomId);
    const roomLanePrefix = `room:${roomId}:`;
    for (const laneKey of this.bufferedRouteByLane.keys()) {
      if (laneKey.startsWith(roomLanePrefix)) {
        this.bufferedRouteByLane.delete(laneKey);
        this.bufferedInvocationSubjectByLane.delete(laneKey);
        this.bufferedCoalescingBoundaryByLane.delete(laneKey);
      }
    }

    let stoppedJobs = 0;
    let droppedQueuedTurns = 0;
    let droppedBufferedLanes = roomLanes.lanes;
    for (const threadId of threadIds) {
      const result = await this.stopThread(threadId);
      stoppedJobs += result.stoppedJobs;
      droppedQueuedTurns += result.droppedQueuedTurns;
      droppedBufferedLanes += result.droppedBufferedLanes;
    }
    // `stopThread` handles queued turns with an established serialization
    // thread. A just-buffered room lane can have no pending entry yet, while
    // its TaskRun is already durable, so it needs the same lifecycle stop.
    await this.stopQueuedTaskRuns(roomLanes.virtualJobIds);
    // D420 (2.2.3) — durably terminalize the room-level buffered lane
    // acceptances as user_cancelled before returning (fail loudly). R8.
    await this.terminalizeUserStoppedVirtualIds(roomLanes.virtualJobIds);
    return { stoppedJobs, droppedQueuedTurns, droppedBufferedLanes };
  }

  /** M147 (R3) — the recorded abort reason for a job, or `undefined`. */
  getAbortReason(jobId: string): AbortReason | undefined {
    return this.abortReasons.get(jobId);
  }

  /**
   * D353 follow-up — wrap an approval-resumed (or other resume) chain in an
   * in-memory Job lifecycle so the workbench can clear `isRunning` when the
   * resumed stream settles and the existing Room Stop spine can abort it.
   *
   * Background: when `interrupt()` parks the graph mid-turn, the original
   * foreground Job's executor generator returns cleanly and `Job.runExecutor`
   * emits `job.status:completed` for the ORIGINAL job id. The workbench
   * retires that id from `liveJobIdsRef`. The user then clicks approve →
   * `submitApprovalAsk` optimistically calls `setIsRunning(true)`. The
   * server resumes the graph via `resumeGraphWithAskReply` (or sibling
   * resume helpers), which runs the graph OUTSIDE any Job — its events
   * flow through the persisting processor directly onto the eventBus, so
   * NO terminal `job.status` fires when the resumed stream finishes. The
   * workbench's `isRunning` stays true and the Stop button stays enabled
   * ("stale Stop state").
   *
   * This method emits the missing lifecycle events around `resume`:
   *   `job.dispatched` → `job.status:running` → terminal
   *   `job.status:completed|failed`
   * The synthetic `jobId` is a fresh UUID; the workbench routes the
   * terminal event via `laneKey` (the D353 laneKey fallback in
   * `ws-event-room.ts` covers a `jobIdToRoomId` map miss) and clears
   * `liveJobIdsRef` + `isRunning` on receipt.
   *
   * The Job is deliberately ephemeral: the resume is part of the original
   * turn, so a second durable `jobs` row would misrepresent the transcript.
   * It is nevertheless registered in `this.active` with the real room/thread
   * identity. That makes `stopRoom` and reconnect reconciliation use the same
   * execution authority as ordinary foreground work. Its AbortSignal is the
   * single cancellation seam threaded through LangGraph and relay dispatch.
   */
  async runResumeJobLifecycle(
    scope: {
      laneKey: string;
      roomId: string;
      graphThreadId: string;
      /** Exact resumed turn and Agent; emitted only as safe lifecycle metadata. */
      turnId?: string;
      authorAgentId?: string;
      /** Canonical Human whose accepted reply/resume is executing. */
      humanUserId: string;
      /** Full resume sink privacy without fabricating a second durable input. */
      ephemeralSinkDisposition?: "full";
      /** Exact durable TaskRun resumed by this otherwise ephemeral worker. */
      taskRun?: { taskId: string; taskRunId: string };
    },
    resume: (signal: AbortSignal) => Promise<void>,
    invocationAuthority: AcceptedInvocationAuthority,
    maintenanceAuthority?: MaintenanceAcceptanceAuthority,
  ): Promise<void> {
    assertAcceptedInvocationAuthoritySubject(
      invocationAuthority,
      scope.humanUserId,
    );
    invocationAuthority = bindInvocationOrigin(scope.humanUserId, { roomId: scope.roomId, ...(scope.taskRun ?? {}) }, invocationAuthority);
    await this.resolveGate().assertAcceptingNewWork(maintenanceAuthority);
    const acceptedMaintenanceAuthority =
      maintenanceAuthority ?? createMaintenanceAcceptanceAuthority();
    const jobId = randomUUID();
    let resumeFailed = false;
    let resumeError: unknown;
    const job = new Job({
      ownerId: "",
      requestorId: "",
      laneKey: scope.laneKey,
      type: "foreground",
      input: {
        roomId: scope.roomId,
        graphThreadId: scope.graphThreadId,
        ...(scope.taskRun ?? {}),
      },
      ...(scope.turnId !== undefined && scope.authorAgentId !== undefined
        ? { lifecycleIdentity: {
            turnId: scope.turnId,
            authorAgentId: scope.authorAgentId,
          } }
        : {}),
      ...(scope.ephemeralSinkDisposition === undefined
        ? {}
        : { ephemeralSinkDisposition: scope.ephemeralSinkDisposition }),
      executor: async function* (_input, _jobId, _laneKey, signal) {
        try {
          await resume(signal);
        } catch (err) {
          resumeFailed = true;
          resumeError = err;
          throw err;
        }
        yield* [];
      },
      // The resume belongs to the original durable turn. Reuse Job's
      // cancellation/status machinery without creating a duplicate DB row.
      persist: () => Promise.resolve(jobId),
      updateStatus: () => Promise.resolve(),
    });
    await job.persist();
    this.active.set(job.id, job);
    this.jobToAuthority.set(job.id, acceptedMaintenanceAuthority);
    this.jobToInvocationAuthority.set(job.id, invocationAuthority);
    eventBus.emit({
      type: "job.dispatched",
      virtualJobIds: [jobId],
      jobId,
      laneKey: scope.laneKey,
    });
    try {
      await runWithAcceptedWorkAuthorities(
        acceptedMaintenanceAuthority,
        invocationAuthority,
        () => runWithInitiatingClientSurface("unknown", () => this.executeWithCurrentInvocationAccess(job, invocationAuthority)),
      );
      if (resumeFailed) {
        if (resumeError instanceof Error) throw resumeError;
        throw new Error(String(resumeError));
      }
    } finally {
      if (job.isTerminal()) {
        this.active.delete(job.id);
        this.abortReasons.delete(job.id);
        this.jobToAuthority.delete(job.id);
        this.jobToInvocationAuthority.delete(job.id);
      }
    }
  }

  /** Current durable Job evidence complements, but never replaces, the failed checkpoint. */
  private async ordinaryRecoveryJobMatches(coordinate: OrdinaryContentAccessRecoveryCoordinate): Promise<boolean> {
    const job = await this.readRecoveryJob(coordinate.originalJobId);
    if (coordinate.executionOwner?.kind === "task") return false; // TaskRun lifecycle owns this continuation.
    const owner = coordinate.executionOwner;
    const fork = job?.input?.["forkRun"] as ForkRunMetadata | undefined;
    const executionMatches = owner?.kind === "fork"
      ? fork?.mode === "fork" && fork.checkpointThreadId === coordinate.graphThreadId
        && fork.forkThreadId === coordinate.graphThreadId && fork.parentThreadId === owner.parentThreadId
        && fork.transcriptThreadId === owner.transcriptThreadId
        && owner.parentThreadId === owner.transcriptThreadId
        && job?.input?.["graphThreadId"] === owner.parentThreadId
      : !fork && job?.input?.["graphThreadId"] === coordinate.graphThreadId;
    return job !== null && job.input !== null && job.type === "foreground"
      && (job.status === "failed" || job.status === "completed")
      && job.requestorId === coordinate.humanUserId
      && executionMatches
      && job.input["turnId"] === coordinate.turnId
      && job.input["agentId"] === coordinate.agentId
      && job.input["roomId"] === coordinate.roomId
      && !job.input["taskRunId"];
  }

  /** Discovery is read-only; the HTTP owner supplies canonical Room/Job locators. */
  async discoverOrdinaryContentAccessRecovery(
    scope: OrdinaryContentAccessRecoveryScope,
    deps: OrdinaryContentAccessRecoveryDeps,
    invocationAuthority: AcceptedInvocationAuthority,
  ): Promise<OrdinaryContentAccessRecoveryCoordinate | null> {
    assertAcceptedInvocationAuthoritySubject(invocationAuthority, scope.humanUserId);
    const coordinate = await readOrdinaryContentAccessRecovery(scope, deps);
    return coordinate !== null && await this.ordinaryRecoveryJobMatches(coordinate) ? coordinate : null;
  }

  /** Explicit same-operation continuation, never an automatic retry or a new turn. */
  async runOrdinaryContentAccessRecovery(
    expected: OrdinaryContentAccessRecoveryCoordinate,
    deps: OrdinaryContentAccessRecoveryDeps,
    processor: StreamEventProcessor,
    invocationAuthority: AcceptedInvocationAuthority,
    maintenanceAuthority?: MaintenanceAcceptanceAuthority,
  ): Promise<"completed" | "busy" | "unavailable"> {
    assertAcceptedInvocationAuthoritySubject(invocationAuthority, expected.humanUserId);
    const lock = await this.laneLockRef.tryAcquire(expected.graphThreadId);
    if (!lock.acquired) return "busy";
    try {
      // Approval workers are currently registered outside the main thread lock.
      // Do not enter their checkpoint while one of those workers is still live.
      if ([...this.active.values()].some((job) => job.isRunning()
        && job.input["graphThreadId"] === expected.graphThreadId)) return "busy";
      // This explicit request is the new acceptance boundary. Clear older
      // idle Stop intent before asynchronous reads, never a Stop arriving
      // while this request is validating its checkpoint.
      this.clearStopIntent(expected.graphThreadId, expected.roomId);
      const actual = await this.discoverOrdinaryContentAccessRecovery(expected, deps, invocationAuthority);
      if (actual === null || actual.checkpointId !== expected.checkpointId
        || actual.turnId !== expected.turnId || actual.toolCallId !== expected.toolCallId) return "unavailable";
      if (this.isThreadStopped(expected.graphThreadId) || this.isRoomStopped(expected.roomId)) return "unavailable";
      await this.runResumeJobLifecycle({
        laneKey: expected.laneKey, roomId: expected.roomId,
        graphThreadId: expected.graphThreadId, turnId: expected.turnId,
        authorAgentId: expected.agentId, humanUserId: expected.humanUserId,
      }, (signal) => {
        // The maintenance gate can yield before the ephemeral Job is active.
        if (this.isThreadStopped(expected.graphThreadId) || this.isRoomStopped(expected.roomId)) {
          throw new DOMException("Stopped before content access recovery", "AbortError");
        }
        return resumeOrdinaryContentAccessRecovery(expected, deps, processor, signal);
      },
      invocationAuthority, maintenanceAuthority);
      if (expected.executionOwner?.kind === "fork") this.reconcileForkAndResumePendingTurns(expected.graphThreadId);
      return "completed";
    } catch (error) {
      if (error instanceof OrdinaryContentAccessRecoveryUnavailableError) return "unavailable";
      throw error;
    } finally {
      await lock.release();
      void this.drainThread(expected.graphThreadId);
    }
  }

  private isThreadStopped(threadId: string): boolean {
    return this.stoppedThreads.has(threadId);
  }

  private isRoomStopped(roomId: string): boolean {
    return this.stoppedRooms.has(roomId);
  }

  private clearStopIntent(threadId: string, roomId: string | null): void {
    if (threadId) this.stoppedThreads.delete(threadId);
    if (roomId) this.stoppedRooms.delete(roomId);
  }
}

function threadIdForJob(job: Job): string | null {
  const input = job.input;
  const forkRun = input["forkRun"] as { parentThreadId?: unknown } | undefined;
  if (typeof forkRun?.parentThreadId === "string" && forkRun.parentThreadId) {
    return forkRun.parentThreadId;
  }
  const graphThreadId = input["graphThreadId"];
  if (typeof graphThreadId === "string" && graphThreadId) return graphThreadId;
  return job.laneKey;
}

function jobRoomId(job: Job): string | null {
  return roomIdFromInput(job.input);
}

/**
 * Background Tasks execute in an orphan/target Room but remain owned by the
 * Room that launched them. Human Room Stop must therefore match either side
 * of that canonical association; matching only the execution Room strands the
 * exact `in_background` Task the Human is looking at.
 */
function jobBelongsToRoom(job: Job, roomId: string): boolean {
  if (jobRoomId(job) === roomId) return true;
  const callingRoomId = job.input["callingRoomId"];
  return typeof callingRoomId === "string" && callingRoomId === roomId;
}

function roomIdFromInput(input: Record<string, unknown>): string | null {
  const roomId = input["roomId"];
  return typeof roomId === "string" && roomId ? roomId : null;
}

function taskIdFromInput(input: Record<string, unknown>): string | null {
  const taskId = input["taskId"];
  const taskRunId = input["taskRunId"];
  return typeof taskId === "string" && taskId.length > 0
    && typeof taskRunId === "string" && taskRunId.length > 0
    ? taskId
    : null;
}

/**
 * D420 — production acceptance-ledger sinks backed by the real
 * `@nautilo/db` store (lazy internal pool, mirrors `persistJob`). The
 * default `JobManager` constructor sinks are DB-free stubs so unit tests
 * stay hermetic; the singleton overrides them here so production
 * persists payload-free acceptance rows before enqueue, links coalesced
 * groups to the created Job before execution. Task 2.2.3 owns durable
 * terminalization of un-started acceptances.
 */
const productionAcceptanceSinks: WorkAcceptanceSinks = {
  insertAcceptance: (kind) => defaultInsertAcceptance(kind),
  linkAcceptancesToJob: (acceptanceIds, jobId) =>
    defaultLinkAcceptances(acceptanceIds, jobId),
  terminalizeAllAcceptedWork: (reason) => defaultTerminalizeAllAccepted(reason),
  userCancelAcceptedWork: (acceptanceIds, reason) =>
    defaultUserCancelAcceptances(acceptanceIds, reason),
};

/**
 * D420 (Wave 2 task 2.2.3) — production sink that terminalizes a running
 * task-run Job through the task lifecycle (`stopTask`) so the durable
 * `task_runs`/`tasks` rows are stamped `cancelled`. Uses a lazy import so the
 * core runtime module does not take a static dependency on the tasks subsystem
 * (which would risk a load-order cycle), and a holder for the `jobManager`
 * singleton because `stopTask` needs the `abortJob` seam and the singleton is
 * constructed below. The task-run DB handle is the process singleton published
 * by the observer (`setTaskRunDb`); it is set before any task dispatches, so it
 * is available when the drain deadline fires.
 */
let _jobManagerForTaskStop: JobManager | null = null;
const productionTaskStopSink = async (taskId: string): Promise<void> => {
  if (!_jobManagerForTaskStop) {
    throw new Error("maintenance task-stop sink: jobManager not initialized");
  }
  const { stopTask } = await import("./tasks/lifecycle");
  const { getTaskRunDb } = await import("./tasks/task-runtime-context");
  await stopTask({ db: getTaskRunDb(), jobManager: _jobManagerForTaskStop }, taskId);
};

export const jobManager = new JobManager({
  acceptanceSinks: productionAcceptanceSinks,
  taskStopSink: productionTaskStopSink,
  checkInvocationAccess: isInvocationAccessAllowed,
  invocationTaskStop: async ({ humanUserId, taskId, taskRunId }) => {
    const { stopTask } = await import("./tasks/lifecycle");
    const { getTaskRunDb } = await import("./tasks/task-runtime-context");
    const result = await stopTask({ db: getTaskRunDb(), jobManager }, taskId, { humanUserId, taskRunId });
    if (!result.ok && result.status !== "authority_changed" && result.status !== "not_found") {
      throw new Error("Task invocation cancellation pending");
    }
  },
});
_jobManagerForTaskStop = jobManager;
