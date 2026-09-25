import { readTaskPreparation } from "@nautilo/types";
/**
 * M141 — Task primitive data-access layer (foundation).
 *
 * CRUD + observer-claim helpers + lifecycle status setters for the
 * `tasks` / `task_runs` tables. This module is BEHAVIOR-FREE substrate:
 * nothing calls it yet. Phase 2 (the `TaskObserver` engine) wires these
 * helpers to dispatch; do NOT add observer/dispatch logic here.
 *
 * Every helper takes an explicit `db` handle as its first argument (so
 * Phase 2 can pass either a pooled `DirectDatabase` or a transaction-
 * scoped handle) rather than reaching for a module-level singleton.
 */
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { tasks, type Task, type NewTask } from "../schema/tasks";
import { taskRuns, type TaskRun, type NewTaskRun } from "../schema/task-runs";
import { profiles } from "../schema/profiles";
import { jobs } from "../schema/jobs";
import { taskDefinitionCryptoRevisions } from "../schema/task-definition-crypto-revisions";

type TaskStatus = NonNullable<NewTask["status"]>;
type TaskRunStatus = NonNullable<NewTaskRun["status"]>;

const TERMINAL_TASK_STATUSES = ["completed", "cancelled", "errored"] as const;
const TERMINAL_TASK_RUN_STATUSES = ["completed", "cancelled", "errored"] as const;

/** Small enough for a compact Done surface while still showing recent work. */
const DEFAULT_RECENT_TERMINAL_TASK_LIMIT = 5;
/** Hard server-side ceiling: task history must never become an unbounded list. */
const MAX_RECENT_TERMINAL_TASK_LIMIT = 50;
const WRITER_REVIEW_AWAITING_METADATA_KEY = "writerReviewAwaiting";
export const WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY = "writerReviewAcceptedReceipt";

export type WriterReviewAwaitingMarker = Readonly<{
  version: 1;
  taskRunId: string;
  proposalId: string;
  /** Non-authorizing canonical write receipt retained for exact retry fencing. */
  acceptedResultRevision?: unknown;
  /** Exact non-authorizing D448 operation reserved before canonical Writer save. */
  pendingWorkspaceOperationId?: string;
  /** Stable D448 correlation; retained only while its canonical result is unknown. */
  pendingWorkspaceClientMutationId?: string;
  /** Internal Artifact row identity, retained only while outcome is unknown. */
  pendingWorkspaceArtifactId?: string;
  /** D448 lineage retained with an accepted result after the reservation settles. */
  acceptedWorkspaceOperationId?: string;
  acceptedWorkspaceClientMutationId?: string;
  acceptedWorkspaceArtifactId?: string;
  /** The one fresh run that consumes an accepted-save verification continuation. */
  verificationRunId?: string;
}>;

export type RecordWriterReviewAcceptedReceiptResult =
  | { status: "recorded" | "same"; task: Task }
  | { status: "already_requeued"; task: Task }
  | { status: "not_found" | "stale" | "conflict" };

export type CompleteWriterReviewAcceptedRunResult =
  | { status: "requeued" | "already_requeued"; task: Task; run: TaskRun }
  | { status: "not_found" | "stale" | "conflict" };

export type TerminalizeWriterReviewVerificationLostResult =
  | { transitioned: true; task: Task; run: TaskRun }
  | { transitioned: false; task?: Task; run?: TaskRun };

export interface ListAwaitingWriterReviewTasksOptions {
  /** Caller-owned observer batch size; every page has a stable continuation. */
  limit: number;
  /** Exclusive stable cursor from the preceding page. */
  after?: Readonly<{ startedAt: Date; runId: string }>;
}

function writerReviewAwaitingPredicate() {
  // Keep this predicate in SQL.  The restart path must never retrieve every
  // awaiting Task and infer lifecycle authority from arbitrary metadata in JS.
  return sql<boolean>`(
    ${tasks.metadata}->'writerReviewAwaiting' @> '{"version":1}'::jsonb
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAwaiting'->'taskRunId') = 'string'
    AND ${tasks.metadata}->'writerReviewAwaiting'->>'taskRunId' = ${taskRuns.id}::text
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAwaiting'->'proposalId') = 'string'
  )`;
}

function excludesWriterReviewAwaitingPredicate() {
  return sql<boolean>`NOT (${tasks.metadata} ? 'writerReviewAwaiting')`;
}

function writerReviewAcceptedReceiptPredicate() {
  return sql<boolean>`(
    ${tasks.metadata}->'writerReviewAwaiting' ? 'acceptedResultRevision'
    OR (
      ${tasks.metadata}->'writerReviewAwaiting' ? 'pendingWorkspaceOperationId'
      AND ${tasks.metadata}->'writerReviewAwaiting' ? 'pendingWorkspaceClientMutationId'
      AND ${tasks.metadata}->'writerReviewAwaiting' ? 'pendingWorkspaceArtifactId'
    )
  )`;
}

function writerReviewAcceptedRequeuePredicate() {
  // The accepted receipt is durable retry identity for an already-completed
  // review-producing run.  Startup uses this exact SQL shape to find the
  // narrow post-requeue window where a live verification binding is gone;
  // it must not infer this from arbitrary pending Task metadata in JS.
  return sql<boolean>`(
    ${tasks.metadata}->'writerReviewAcceptedReceipt' @> '{"version":1}'::jsonb
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAcceptedReceipt'->'taskRunId') = 'string'
    AND ${tasks.metadata}->'writerReviewAcceptedReceipt'->>'taskRunId' = ${taskRuns.id}::text
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAcceptedReceipt'->'proposalId') = 'string'
    AND ${tasks.metadata}->'writerReviewAcceptedReceipt' ? 'acceptedResultRevision'
    AND NOT (${tasks.metadata}->'writerReviewAcceptedReceipt' ? 'verificationRunId')
  )`;
}

function writerReviewVerificationRunPredicate() {
  return sql<boolean>`(
    ${tasks.metadata}->'writerReviewAcceptedReceipt' @> '{"version":1}'::jsonb
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAcceptedReceipt'->'taskRunId') = 'string'
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAcceptedReceipt'->'proposalId') = 'string'
    AND ${tasks.metadata}->'writerReviewAcceptedReceipt' ? 'acceptedResultRevision'
    AND jsonb_typeof(${tasks.metadata}->'writerReviewAcceptedReceipt'->'verificationRunId') = 'string'
    AND ${tasks.metadata}->'writerReviewAcceptedReceipt'->>'verificationRunId' = ${taskRuns.id}::text
    AND EXISTS (
      SELECT 1 FROM task_runs AS writer_review_producing_run
      WHERE writer_review_producing_run.id::text = ${tasks.metadata}->'writerReviewAcceptedReceipt'->>'taskRunId'
        AND writer_review_producing_run.task_id = ${tasks.id}
        AND writer_review_producing_run.status = 'completed'
    )
  )`;
}

// --- CRUD ---------------------------------------------------------------

export async function createTask(db: DirectDatabase, input: NewTask): Promise<Task> {
  const [row] = await db.insert(tasks).values(input).returning();
  if (!row) throw new Error("createTask: insert returned no row");
  return row;
}

export async function getTaskById(
  db: DirectDatabase,
  id: string,
): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row;
}

/**
 * Read a Task together with PostgreSQL's exact tuple version for a later
 * optimistic mutation. JavaScript Date cannot preserve PostgreSQL's
 * microsecond timestamp precision, so updated_at is unsuitable as a
 * round-tripped compare-and-swap token.
 */
export async function getTaskByIdWithMutationVersion(
  db: DirectDatabase,
  id: string,
): Promise<(Task & { mutationVersion: string }) | undefined> {
  const [row] = await db
    .select({
      ...getTableColumns(tasks),
      mutationVersion: sql<string>`${tasks}.xmin::text`,
    })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  return row;
}

export interface ListTasksForOwnerOpts {
  /** Filter to an exact status. Takes precedence over `includeTerminal`. */
  status?: TaskStatus;
  /**
   * Legacy complete terminal inclusion. Callers that need Mobile's bounded
   * recent window must also pass `includeRecentTerminal`.
   */
  includeTerminal?: boolean;
  /** Requested size of the bounded terminal window (clamped server-side). */
  recentTerminalLimit?: number;
  /** Use the default bounded recent-terminal window when no size is supplied. */
  includeRecentTerminal?: boolean;
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(
    status as (typeof TERMINAL_TASK_STATUSES)[number],
  );
}

function boundedRecentTerminalLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RECENT_TERMINAL_TASK_LIMIT;
  }
  return Math.max(
    1,
    Math.min(MAX_RECENT_TERMINAL_TASK_LIMIT, Math.trunc(limit)),
  );
}

export async function listTasksForOwner(
  db: DirectDatabase,
  ownerId: string,
  opts: ListTasksForOwnerOpts = {},
): Promise<Task[]> {
  if (opts.status) {
    const query = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.ownerId, ownerId), eq(tasks.status, opts.status)));
    // The HTTP route always requests bounded mode for an exact terminal
    // status. Preserve the established agent-tool listing behavior when the
    // new bounded window was not explicitly requested.
    if (
      isTerminalTaskStatus(opts.status)
      && (opts.includeRecentTerminal || opts.recentTerminalLimit !== undefined)
    ) {
      return query
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(boundedRecentTerminalLimit(opts.recentTerminalLimit));
    }
    return query.orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  const nonTerminalWhere = and(
    eq(tasks.ownerId, ownerId),
    sql`${tasks.status} NOT IN ('completed','cancelled','errored')`,
  );
  if (!opts.includeTerminal) {
    return db
      .select()
      .from(tasks)
      .where(nonTerminalWhere)
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  if (!opts.includeRecentTerminal && opts.recentTerminalLimit === undefined) {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.ownerId, ownerId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  // A repeatable-read snapshot makes the two partitions mutually exclusive:
  // a Task cannot appear as non-terminal in one query and terminal in the
  // other (or disappear between them) while this list is assembled.
  return db.transaction(async (tx) => {
    const nonTerminal = await tx
      .select()
      .from(tasks)
      .where(nonTerminalWhere)
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    const terminal = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.ownerId, ownerId),
          sql`${tasks.status} IN ('completed','cancelled','errored')`,
        ),
      )
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .limit(boundedRecentTerminalLimit(opts.recentTerminalLimit));
    return [...nonTerminal, ...terminal];
  }, { isolationLevel: "repeatable read" });
}

/**
 * Non-terminal Tasks associated with a Human-visible Room through either the
 * launch receipt (`callingRoomId`) or execution/report target (`targetRoomId`).
 * Used by canonical Room Stop so a pending background Task cannot escape merely
 * because it has not acquired an in-memory Job yet.
 */
export async function listStoppableTasksForOwnerRoom(
  db: DirectDatabase,
  ownerId: string,
  roomId: string,
): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        sql`${tasks.status} NOT IN ('completed','cancelled','errored')`,
        or(eq(tasks.callingRoomId, roomId), eq(tasks.targetRoomId, roomId)),
      ),
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
}

export async function updateTask(
  db: DirectDatabase,
  id: string,
  patch: Partial<NewTask>,
): Promise<Task | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return row;
}

/**
 * Owner-scoped optimistic update for an externally prepared Task PATCH.
 * Every authority coordinate observed before validation participates in the
 * write predicate, so an intervening lifecycle or protected-content update
 * wins instead of being overwritten. Internal lifecycle callers continue to
 * use `updateTask` where their own transaction supplies the authority fence.
 */
export async function updateTaskIfCurrent(
  db: DirectDatabase,
  input: Readonly<{
    id: string;
    ownerId: string;
    expectedStatus: "pending" | "paused";
    expectedMutationVersion: string;
    expectedContentRevision: number;
  }>,
  patch: Partial<NewTask>,
): Promise<Task | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(tasks.id, input.id),
      eq(tasks.ownerId, input.ownerId),
      eq(tasks.status, input.expectedStatus),
      sql`${tasks}.xmin::text = ${input.expectedMutationVersion}`,
      eq(tasks.contentRevision, input.expectedContentRevision),
    ))
    .returning();
  return row;
}

export async function insertTaskRun(
  db: DirectDatabase,
  input: NewTaskRun,
): Promise<TaskRun> {
  const [row] = await db.insert(taskRuns).values(input).returning();
  if (!row) throw new Error("insertTaskRun: insert returned no row");
  return row;
}

export async function getTaskRuns(
  db: DirectDatabase,
  taskId: string,
): Promise<TaskRun[]> {
  return db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(asc(taskRuns.startedAt));
}

/**
 * M152 — the `model_id` of each task's MOST RECENT run, for a set of task ids.
 * Used by list surfaces (`task list`, `GET /api/tasks`) to show which model a
 * task actually ran on without an N+1 per-task fetch. Returns a Map keyed by
 * `taskId`; a task with no runs (or a run with a null model) is simply absent.
 * One `DISTINCT ON (task_id) … ORDER BY task_id, started_at DESC` query.
 */
export async function getLatestRunModelByTask(
  db: DirectDatabase,
  taskIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([taskRuns.taskId], {
      taskId: taskRuns.taskId,
      modelId: taskRuns.modelId,
    })
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(taskRuns.taskId, desc(taskRuns.startedAt));
  for (const r of rows) out.set(r.taskId, r.modelId);
  return out;
}

/**
 * D307 — batched `profiles.name` lookup for a set of agent ids (one query).
 * Used by `GET /api/tasks` to populate `TaskSummary.agentName` without N+1.
 */
export async function getAgentDisplayNamesByAgentId(
  db: DirectDatabase,
  agentIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (agentIds.length === 0) return out;
  const unique = [...new Set(agentIds)];
  const rows = await db
    .select({ agentId: profiles.agentId, name: profiles.name })
    .from(profiles)
    .where(inArray(profiles.agentId, unique));
  for (const r of rows) out.set(r.agentId, r.name);
  return out;
}

/** Owner-fenced variant for Task projections. A malformed owner/agent link
 * must degrade to the shell identity, never borrow another owner's profile. */
export async function getOwnerAgentDisplayNamesByAgentId(
  db: DirectDatabase,
  ownerId: string,
  agentIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!ownerId || agentIds.length === 0) return out;
  const unique = [...new Set(agentIds)];
  const rows = await db
    .select({ agentId: profiles.agentId, name: profiles.name })
    .from(profiles)
    .where(and(eq(profiles.userId, ownerId), inArray(profiles.agentId, unique)));
  for (const row of rows) out.set(row.agentId, row.name);
  return out;
}

/**
 * M147 (R2) — the newest still-`running` run for a task that has a linked
 * `jobId` (the live abort target for pause). Stop uses the transactional
 * terminal transition below because it must also cancel a durable null-job
 * serialized run.
 */
export async function getActiveTaskRun(
  db: DirectDatabase,
  taskId: string,
): Promise<TaskRun | undefined> {
  const [row] = await db
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.taskId, taskId),
        eq(taskRuns.status, "running"),
        isNotNull(taskRuns.jobId),
      ),
    )
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  return row;
}

/** Pause shares the parent-row lock with resume admission and finalization. */
export async function transitionTaskLifecyclePaused(
  db: DirectDatabase,
  taskId: string,
): Promise<{
  task: Task | undefined;
  run: TaskRun | undefined;
  transitioned: boolean;
  outcome: "transitioned" | "not_found" | "already_paused" | "task_terminal" | "writer_review_pending";
}> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).for("update");
    if (!task) return { task, run: undefined, transitioned: false, outcome: "not_found" };
    if (task.status === "paused") return { task, run: undefined, transitioned: false, outcome: "already_paused" };
    if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
      return { task, run: undefined, transitioned: false, outcome: "task_terminal" };
    }
    const marker = task.metadata?.[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (task.status === "awaiting" && marker?.version === 1 &&
      typeof marker.taskRunId === "string" && typeof marker.proposalId === "string") {
      return { task, run: undefined, transitioned: false, outcome: "writer_review_pending" };
    }
    // Select newest first: never revive an older run behind a newer terminal
    // run. Awaiting checkpoints and resumed null-job runs are pauseable too.
    const [latest] = await tx.select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt)).limit(1).for("update");
    let run: TaskRun | undefined;
    if (latest?.status === "running" || latest?.status === "awaiting") {
      [run] = await tx.update(taskRuns).set({ status: "paused" })
        .where(eq(taskRuns.id, latest.id)).returning();
      if (!run) throw new Error("pause lost TaskRun after row lock");
    }
    const [updatedTask] = await tx.update(tasks).set({
      status: "paused", fireLockId: null, fireLockedAt: null, updatedAt: new Date(),
    }).where(eq(tasks.id, taskId)).returning();
    if (!updatedTask) throw new Error("pause lost Task after row lock");
    return { task: updatedTask, run, transitioned: true, outcome: "transitioned" };
  });
}

/** The result of one serialized terminal lifecycle transition. */
export interface TerminalTaskLifecycleTransition {
  task: Task | undefined;
  run: TaskRun | undefined;
  /** True only for the transaction which won the Task-row terminal transition. */
  transitioned: boolean;
  /** Distinguishes a same-terminal report-back retry from a Stop winner. */
  outcome: "transitioned" | "same_terminal" | "task_terminal" | "run_terminal" | "not_running" | "writer_review_pending" | "not_found" | "authority_changed";
}

export interface TransitionTaskLifecycleTerminalInput {
  taskId: string;
  /** Selective cancellation may only stop this Human's exact current run. */
  expectedInvocation?: { humanUserId: string; taskRunId: string };
  /** Omit for a recurring-run finalization that leaves its Task pending. */
  taskStatus?: Extract<TaskStatus, (typeof TERMINAL_TASK_STATUSES)[number]>;
  /** Terminal Task metadata intentionally allowed to lifecycle callers. */
  taskPatch?: {
    cancelledAt?: Date;
    lastError?: string | null;
    fireLockId?: null;
    fireLockedAt?: null;
  };
  /** Exact run finalizers bind their transition to this durable run id. */
  runId?: string;
  runStatus?: Extract<TaskRunStatus, (typeof TERMINAL_TASK_RUN_STATUSES)[number]>;
  /** Terminal TaskRun metadata intentionally allowed to lifecycle callers. */
  runPatch?: { resultText?: string; lastError?: string | null; completedAt?: Date };
  /** A completed export must not win over a Pause committed before this transaction. */
  requireRunningPair?: boolean;
  /** Stop-only durable fence for a Writer Artifact mutation already reserved. */
  blockPendingWriterWorkspaceAcceptance?: boolean;
}

/**
 * Serialize terminal lifecycle writers on the parent Task row.
 *
 * Stop selects the newest non-terminal run when no `runId` is supplied, so an
 * accepted serialized run with `jobId = null` is still cancelled. Completion
 * and error finalizers supply their exact run id. Both paths take the same
 * Task `FOR UPDATE` lock, making one transition the durable winner.
 */
export async function transitionTaskLifecycleTerminal(
  db: DirectDatabase,
  input: TransitionTaskLifecycleTerminalInput,
): Promise<TerminalTaskLifecycleTransition> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for("update");
    if (!task) return { task: undefined, run: undefined, transitioned: false, outcome: "not_found" };
    if (input.expectedInvocation) {
      const [expected] = await tx.select({ id: taskRuns.id }).from(taskRuns)
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.id, input.expectedInvocation.taskRunId))).for("update");
      // Compare database timestamps without JS millisecond truncation. An
      // ambiguous tie is not authority to stop either run.
      const [newer] = expected ? await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(
        eq(taskRuns.taskId, task.id), sql`${taskRuns.id} <> ${expected.id}::uuid`,
        sql`${taskRuns.startedAt} >= (SELECT started_at FROM task_runs WHERE id = ${expected.id}::uuid)`,
      )).limit(1) : [];
      if (task.requestorId !== input.expectedInvocation.humanUserId || !expected || newer) {
        return { task, run: undefined, transitioned: false, outcome: "authority_changed" };
      }
    }
    // Older callers and narrow test fixtures may not hydrate JSON metadata.
    // Treat that as no reservation; canonical persisted rows always carry it.
    const metadata = task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
      ? task.metadata
      : {};
    const marker = metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (
      input.blockPendingWriterWorkspaceAcceptance === true &&
      marker?.version === 1 &&
      typeof marker.pendingWorkspaceOperationId === "string" &&
      typeof marker.pendingWorkspaceClientMutationId === "string"
    ) {
      return { task, run: undefined, transitioned: false, outcome: "writer_review_pending" };
    }

    let run: TaskRun | undefined;
    if (input.runId) {
      [run] = await tx
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)))
        .limit(1)
        .for("update");
    } else if (input.runStatus) {
      [run] = await tx
        .select()
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.taskId, input.taskId),
            sql`${taskRuns.status} NOT IN ('completed', 'cancelled', 'errored')`,
          ),
        )
        .orderBy(desc(taskRuns.startedAt))
        .limit(1)
        .for("update");
    }

    const taskIsTerminal = TERMINAL_TASK_STATUSES.includes(
      task.status as (typeof TERMINAL_TASK_STATUSES)[number],
    );
    if (taskIsTerminal) {
      // Completion/error may be retried after a delivery failure only when the
      // exact durable Task + TaskRun pair already carry that same outcome.
      // A Stop/other terminal outcome is authoritative and suppresses stale
      // delivery without ever being overwritten.
      const isSameTerminal =
        Boolean(input.runId) &&
        task.status === input.taskStatus &&
        run?.status === input.runStatus;
      return {
        task,
        run,
        transitioned: false,
        outcome: isSameTerminal ? "same_terminal" : "task_terminal",
      };
    }

    if (input.requireRunningPair && (task.status !== "running" || run?.status !== "running")) {
      return { task, run, transitioned: false, outcome: "not_running" };
    }

    // Exact finalizers must not mutate a Task after their durable run already
    // terminalized (whether by Stop or a duplicate finalizer invocation).
    if (input.runId && !run) {
      return { task, run, transitioned: false, outcome: "run_terminal" };
    }
    if (
      input.runId &&
      TERMINAL_TASK_RUN_STATUSES.includes(run!.status as (typeof TERMINAL_TASK_RUN_STATUSES)[number])
    ) {
      // Repair a pre-CAS partial finalization (run terminal, Task still live)
      // using the same parent-row lock. A conflicting run terminal remains a
      // loser and never changes the Task.
      if (run!.status !== input.runStatus) {
        return { task, run, transitioned: false, outcome: "run_terminal" };
      }
      if (!input.taskStatus) {
        return { task, run, transitioned: false, outcome: "same_terminal" };
      }
    }

    let nextRun = run;
    if (run && input.runStatus && run.status !== input.runStatus) {
      const [updatedRun] = await tx
        .update(taskRuns)
        .set({ status: input.runStatus, ...input.runPatch })
        .where(eq(taskRuns.id, run.id))
        .returning();
      nextRun = updatedRun ?? run;
    }

    let nextTask = task;
    if (input.taskStatus) {
      const [updatedTask] = await tx
        .update(tasks)
        .set({ status: input.taskStatus, ...input.taskPatch, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      nextTask = updatedTask ?? task;
    }

    return { task: nextTask, run: nextRun, transitioned: true, outcome: "transitioned" };
  });
}

/**
 * D420 (Wave 2 task 2.2.2) — payload-free executable Task aggregate used by
 * the maintenance operator drain.
 *
 * `runningTaskRuns` counts every durable `task_runs.status = 'running'`
 * record, whether it has already been linked to its foreground Job or is in
 * the tiny dispatch window before that link is stamped. The runtime Job
 * aggregate excludes task-run Jobs, so a linked task run is never counted in
 * both categories.
 *
 * `claimedTasks` counts pending rows with a live fire lock: TaskObserver has
 * claimed them, but dispatch has not yet marked them running. Awaiting and
 * paused Tasks are deliberately excluded because they are parked, not
 * executable work.
 */
export interface ActiveTaskWorkCounts {
  runningTaskRuns: number;
  claimedTasks: number;
}

export async function countActiveTaskWorkWith(
  db: DirectDatabase,
): Promise<ActiveTaskWorkCounts> {
  const [running, claimed] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskRuns)
      .where(eq(taskRuns.status, "running")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          isNotNull(tasks.fireLockId),
        ),
      ),
  ]);
  return {
    runningTaskRuns: running[0]?.n ?? 0,
    claimedTasks: claimed[0]?.n ?? 0,
  };
}

/**
 * M147 (R4) — the run to RESUME on an unpause re-dispatch. Returns the task's
 * newest run, but ONLY if it is `paused`; supplies the `graphThreadId` the
 * resume must REUSE so the preserved LangGraph checkpoint matches (rather than
 * minting a fresh orphan thread). Returns `undefined` when the newest run is
 * not paused — critically, this prevents a later cron fire (whose previous run
 * already completed) from wrongly resuming a stale earlier checkpoint.
 */
export async function getLatestResumableTaskRun(
  db: DirectDatabase,
  taskId: string,
): Promise<TaskRun | undefined> {
  const [row] = await db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  return row?.status === "paused" ? row : undefined;
}

/**
 * M153 (R5) — an in-flight artifact-originated wake for coalescing. Returns a
 * `preset='ping'` task owned by `(ownerId, agentId)` whose `metadata.artifactId`
 * matches and whose status is still `pending` or `running`.
 */
export async function findOpenPingTask(
  db: DirectDatabase,
  params: { ownerId: string; agentId: string; artifactId: string },
): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.preset, "ping"),
        eq(tasks.ownerId, params.ownerId),
        eq(tasks.agentId, params.agentId),
        inArray(tasks.status, ["pending", "running"]),
        sql`${tasks.metadata}->>'artifactId' = ${params.artifactId}`,
      ),
    )
    .limit(1);
  return row;
}

/**
 * M151 (Phase 7a) — the newest `awaiting` task whose run is parked on this
 * room, when `fromUserId` is in its await set. Returns the task + the parked
 * run's `graphThreadId` (the checkpoint to resume). Owner-only enforcement is
 * the caller's job (the reply hook only resumes a task the replying human can
 * see by virtue of being a member of the target room).
 *
 * Matches when the replier is EITHER the requester (the namespace-await case,
 * where target_user_ids may be empty) OR a named target (the ask_peer peer,
 * who is in target_user_ids).
 */
export async function findAwaitingTaskForRoom(
  db: DirectDatabase,
  roomId: string,
  fromUserId: string,
): Promise<{ task: Task; graphThreadId: string; runId: string } | undefined> {
  const [row] = await db
    .select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.status, "awaiting"),
        eq(tasks.targetRoomId, roomId),
        eq(taskRuns.status, "awaiting"),
        excludesWriterReviewAwaitingPredicate(),
        or(
          eq(tasks.requestorId, fromUserId),
          sql`${fromUserId}::uuid = ANY(${tasks.targetUserIds})`,
        ),
      ),
    )
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  // Writer reviews are resolved only by their exact proposal receipt. The
  // SQL predicate keeps an external-review run out of this Human-reply query
  // while the newest ordinary checkpoint remains resumable.
  return row ? { task: row.task, graphThreadId: row.run.graphThreadId, runId: row.run.id } : undefined;
}

/**
 * Atomically park one model-finished Writer Task on its exact review proposal.
 * The marker is recovery identity only; it contains no session token, path, or
 * document content.
 */
export async function markTaskAwaitingWriterReview(
  db: DirectDatabase,
  input: { taskId: string; taskRunId: string; proposalId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    const [run] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .for("update");
    if (!task || !run || task.status !== "running" || run.status !== "running") return false;
    const existing = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (
      existing !== undefined &&
      (existing.version !== 1 ||
        existing.taskRunId !== input.taskRunId ||
        existing.proposalId !== input.proposalId)
    ) return false;
    const marker: WriterReviewAwaitingMarker = {
      version: 1,
      taskRunId: input.taskRunId,
      proposalId: input.proposalId,
      ...(existing && Object.prototype.hasOwnProperty.call(existing, "acceptedResultRevision")
        ? { acceptedResultRevision: structuredClone(existing.acceptedResultRevision) }
        : {}),
      ...(existing?.pendingWorkspaceOperationId && existing.pendingWorkspaceClientMutationId && existing.pendingWorkspaceArtifactId
        ? {
            pendingWorkspaceOperationId: existing.pendingWorkspaceOperationId,
            pendingWorkspaceClientMutationId: existing.pendingWorkspaceClientMutationId,
            pendingWorkspaceArtifactId: existing.pendingWorkspaceArtifactId,
          }
        : {}),
    };
    await tx.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({
      status: "awaiting",
      metadata: { ...task.metadata, [WRITER_REVIEW_AWAITING_METADATA_KEY]: marker },
      updatedAt: new Date(),
    }).where(eq(tasks.id, task.id));
    return true;
  });
}

export type ReserveTaskWriterReviewWorkspaceOperationResult =
  | { status: "reserved" | "same"; task: Task }
  | { status: "not_found" | "stale" | "conflict" };

/**
 * Persist an exact D448 operation identity before Writer invokes its one
 * canonical Artifact writer. This is recovery correlation only: it contains
 * no live capability, path, document bytes, or authority.
 */
export async function reserveTaskWriterReviewWorkspaceOperation(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    proposalId: string;
    operationId: string;
    clientMutationId: string;
    artifactInternalId: string;
  },
): Promise<ReserveTaskWriterReviewWorkspaceOperationResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return { status: "not_found" };
    const [run] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .for("update");
    if (!run) return { status: "stale" };
    const marker = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    const activePair =
      (task.status === "awaiting" && run.status === "awaiting") ||
      (task.status === "running" && run.status === "running");
    if (!activePair) return { status: "stale" };
    if (
      marker &&
      (marker.version !== 1 || marker.taskRunId !== input.taskRunId || marker.proposalId !== input.proposalId)
    ) return { status: "conflict" };
    if (marker?.pendingWorkspaceOperationId || marker?.pendingWorkspaceClientMutationId) {
      return marker.pendingWorkspaceOperationId === input.operationId
        && marker.pendingWorkspaceClientMutationId === input.clientMutationId
        && marker.pendingWorkspaceArtifactId === input.artifactInternalId
        ? { status: "same", task }
        : { status: "conflict" };
    }
    const next: WriterReviewAwaitingMarker = {
      version: 1,
      taskRunId: input.taskRunId,
      proposalId: input.proposalId,
      ...(marker && Object.prototype.hasOwnProperty.call(marker, "acceptedResultRevision")
        ? { acceptedResultRevision: structuredClone(marker.acceptedResultRevision) }
        : {}),
      pendingWorkspaceOperationId: input.operationId,
      pendingWorkspaceClientMutationId: input.clientMutationId,
      pendingWorkspaceArtifactId: input.artifactInternalId,
    };
    const [updated] = await tx.update(tasks).set({
      metadata: { ...task.metadata, [WRITER_REVIEW_AWAITING_METADATA_KEY]: next },
      updatedAt: new Date(),
    }).where(eq(tasks.id, task.id)).returning();
    if (!updated) throw new Error("reserve writer Workspace operation lost locked Task");
    return { status: "reserved", task: updated };
  });
}

/** Clear an uncommitted D448 reservation after a definite canonical-save failure. */
export async function releaseTaskWriterReviewWorkspaceOperation(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    proposalId: string;
    operationId: string;
    clientMutationId: string;
    artifactInternalId: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return false;
    const marker = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (
      marker?.version !== 1 ||
      marker.taskRunId !== input.taskRunId ||
      marker.proposalId !== input.proposalId ||
      marker.pendingWorkspaceOperationId !== input.operationId ||
      marker.pendingWorkspaceClientMutationId !== input.clientMutationId ||
      marker.pendingWorkspaceArtifactId !== input.artifactInternalId ||
      Object.prototype.hasOwnProperty.call(marker, "acceptedResultRevision")
    ) return false;
    const {
      pendingWorkspaceOperationId: _operationId,
      pendingWorkspaceClientMutationId: _clientMutationId,
      pendingWorkspaceArtifactId: _artifactId,
      ...next
    } = marker;
    await tx.update(tasks).set({
      metadata: { ...task.metadata, [WRITER_REVIEW_AWAITING_METADATA_KEY]: next },
      updatedAt: new Date(),
    }).where(eq(tasks.id, task.id));
    return true;
  });
}

/** Remove only the exact Writer review marker before a terminal transition. */
export async function clearTaskWriterReviewAwaitingMarker(
  db: DirectDatabase,
  input: { taskId: string; taskRunId: string; proposalId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return false;
    const marker = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (
      marker?.version !== 1 ||
      marker.taskRunId !== input.taskRunId ||
      marker.proposalId !== input.proposalId
    ) return false;
    const metadata = { ...task.metadata };
    delete metadata[WRITER_REVIEW_AWAITING_METADATA_KEY];
    if (Object.prototype.hasOwnProperty.call(marker, "acceptedResultRevision")) {
      metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] = {
        version: 1,
        taskRunId: input.taskRunId,
        proposalId: input.proposalId,
        acceptedResultRevision: structuredClone(marker.acceptedResultRevision),
        ...(marker.acceptedWorkspaceOperationId && marker.acceptedWorkspaceClientMutationId && marker.acceptedWorkspaceArtifactId
          ? {
              acceptedWorkspaceOperationId: marker.acceptedWorkspaceOperationId,
              acceptedWorkspaceClientMutationId: marker.acceptedWorkspaceClientMutationId,
              acceptedWorkspaceArtifactId: marker.acceptedWorkspaceArtifactId,
            }
          : {}),
      } satisfies WriterReviewAwaitingMarker;
    }
    await tx.update(tasks).set({ metadata, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
}

/**
 * Persist the canonical accepted-write receipt before finalization.  This is
 * identity-only recovery state: no session token, path, document contents, or
 * authority is stored.  A later retry must present the same TaskRun, proposal,
 * and result revision; Stop and every competing terminal transition win.
 */
export async function recordTaskWriterReviewAcceptedReceipt(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    proposalId: string;
    resultRevision: unknown;
  },
): Promise<RecordWriterReviewAcceptedReceiptResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return { status: "not_found" };
    const [run] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .for("update");
    if (!run) return { status: "stale" };
    const marker = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    const completedReceipt = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    if (
      completedReceipt?.version === 1
      && completedReceipt.taskRunId === input.taskRunId
      && completedReceipt.proposalId === input.proposalId
    ) {
      if (JSON.stringify(completedReceipt.acceptedResultRevision) !== JSON.stringify(input.resultRevision)) {
        return { status: "conflict" };
      }
      return run.status === "completed" && !TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])
        ? { status: "already_requeued", task }
        : { status: "stale" };
    }
    if (!marker) {
      if (task.status !== "running" || run.status !== "running") return { status: "stale" };
      const metadata = {
        ...task.metadata,
        [WRITER_REVIEW_AWAITING_METADATA_KEY]: {
          version: 1,
          taskRunId: input.taskRunId,
          proposalId: input.proposalId,
          acceptedResultRevision: structuredClone(input.resultRevision),
        } satisfies WriterReviewAwaitingMarker,
      };
      const [updated] = await tx.update(tasks)
        .set({ metadata, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      if (!updated) throw new Error("record writer review receipt lost locked Task");
      return { status: "recorded", task: updated };
    }
    if (
      marker?.version !== 1
      || marker.taskRunId !== input.taskRunId
      || marker.proposalId !== input.proposalId
    ) return { status: "stale" };

    const hasReceipt = Object.prototype.hasOwnProperty.call(marker, "acceptedResultRevision");
    if (hasReceipt && JSON.stringify(marker.acceptedResultRevision) !== JSON.stringify(input.resultRevision)) {
      return { status: "conflict" };
    }
    const activePair =
      (task.status === "awaiting" && run.status === "awaiting") ||
      (task.status === "running" && run.status === "running");
    if (!activePair) return { status: "stale" };

    if (!hasReceipt) {
      const metadata = {
        ...task.metadata,
        [WRITER_REVIEW_AWAITING_METADATA_KEY]: {
          version: 1,
          taskRunId: input.taskRunId,
          proposalId: input.proposalId,
          acceptedResultRevision: structuredClone(input.resultRevision),
          ...(marker.pendingWorkspaceOperationId && marker.pendingWorkspaceClientMutationId && marker.pendingWorkspaceArtifactId
            ? {
                acceptedWorkspaceOperationId: marker.pendingWorkspaceOperationId,
                acceptedWorkspaceClientMutationId: marker.pendingWorkspaceClientMutationId,
                acceptedWorkspaceArtifactId: marker.pendingWorkspaceArtifactId,
              }
            : {}),
        } satisfies WriterReviewAwaitingMarker,
      };
      const [updated] = await tx.update(tasks)
        .set({ metadata, updatedAt: new Date() })
        .where(eq(tasks.id, task.id))
        .returning();
      if (!updated) throw new Error("record writer review receipt lost locked Task");
      return { status: "recorded", task: updated };
    }
    return { status: "same", task };
  });
}

/**
 * Complete exactly the review-producing TaskRun and atomically put its parent
 * Task back on the existing observer queue for a fresh verification run. The
 * compact receipt remains after removing the awaiting marker so exact retries
 * are idempotent without retaining any live-session authority.
 */
export async function completeTaskRunAndRequeueWriterReviewAccepted(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    proposalId: string;
    resultRevision: unknown;
    resultText: string;
  },
): Promise<CompleteWriterReviewAcceptedRunResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return { status: "not_found" };
    const [run] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .for("update");
    if (!run) return { status: "stale" };

    const awaiting = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    const accepted = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    const sameIdentity = (marker: Partial<WriterReviewAwaitingMarker> | undefined): boolean =>
      marker?.version === 1
      && marker.taskRunId === input.taskRunId
      && marker.proposalId === input.proposalId;
    const exactReceipt = (marker: Partial<WriterReviewAwaitingMarker> | undefined): boolean => {
      if (!marker || !sameIdentity(marker)) return false;
      return Object.prototype.hasOwnProperty.call(marker, "acceptedResultRevision")
        && JSON.stringify(marker.acceptedResultRevision) === JSON.stringify(input.resultRevision);
    };

    if (
      run.status === "completed"
      && !TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])
      && exactReceipt(accepted)
    ) {
      return { status: "already_requeued", task, run };
    }
    if (sameIdentity(accepted) && !exactReceipt(accepted)) return { status: "conflict" };
    if (!exactReceipt(awaiting)) return { status: "stale" };
    const activePair =
      (task.status === "awaiting" && run.status === "awaiting")
      || (task.status === "running" && run.status === "running");
    if (!activePair) return { status: "stale" };

    const now = new Date();
    const metadata = { ...task.metadata };
    delete metadata[WRITER_REVIEW_AWAITING_METADATA_KEY];
    metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] = {
      version: 1,
      taskRunId: input.taskRunId,
      proposalId: input.proposalId,
      acceptedResultRevision: structuredClone(input.resultRevision),
      ...(awaiting?.acceptedWorkspaceOperationId && awaiting.acceptedWorkspaceClientMutationId && awaiting.acceptedWorkspaceArtifactId
        ? {
            acceptedWorkspaceOperationId: awaiting.acceptedWorkspaceOperationId,
            acceptedWorkspaceClientMutationId: awaiting.acceptedWorkspaceClientMutationId,
            acceptedWorkspaceArtifactId: awaiting.acceptedWorkspaceArtifactId,
          }
        : {}),
    } satisfies WriterReviewAwaitingMarker;
    const [updatedRun] = await tx.update(taskRuns)
      .set({ status: "completed", resultText: input.resultText, completedAt: now })
      .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, run.status)))
      .returning();
    if (!updatedRun) throw new Error("writer review requeue lost locked TaskRun");
    const [updatedTask] = await tx.update(tasks)
      .set({
        status: "pending",
        nextFireAt: now,
        fireLockId: null,
        fireLockedAt: null,
        metadata,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .returning();
    if (!updatedTask) throw new Error("writer review requeue lost locked Task");
    return { status: "requeued", task: updatedTask, run: updatedRun };
  });
}

/**
 * Atomically create the one post-save verification TaskRun and consume only
 * its prompt-continuation marker. The accepted receipt itself remains for
 * exact retry fencing, while later cron fires return to the ordinary brief.
 */
export async function startTaskRunForWriterReviewVerification(
  db: DirectDatabase,
  input: NewTaskRun,
): Promise<TaskRun | undefined> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task || task.status !== "pending") return undefined;
    const receipt = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as
      | Partial<WriterReviewAwaitingMarker>
      | undefined;
    if (
      receipt?.version !== 1 ||
      typeof receipt.taskRunId !== "string" ||
      receipt.taskRunId.length === 0 ||
      typeof receipt.proposalId !== "string" ||
      receipt.proposalId.length === 0 ||
      !Object.prototype.hasOwnProperty.call(receipt, "acceptedResultRevision") ||
      Object.prototype.hasOwnProperty.call(receipt, "verificationRunId")
    ) return undefined;
    const [producingRun] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, receipt.taskRunId), eq(taskRuns.taskId, task.id)))
      .for("update");
    if (!producingRun || producingRun.status !== "completed") return undefined;
    const [run] = await tx.insert(taskRuns).values(input).returning();
    if (!run) throw new Error("start writer review verification: insert returned no row");
    const metadata = {
      ...task.metadata,
      [WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY]: {
        version: 1,
        taskRunId: receipt.taskRunId,
        proposalId: receipt.proposalId,
        acceptedResultRevision: structuredClone(receipt.acceptedResultRevision),
        ...(receipt.acceptedWorkspaceOperationId && receipt.acceptedWorkspaceClientMutationId && receipt.acceptedWorkspaceArtifactId
          ? {
              acceptedWorkspaceOperationId: receipt.acceptedWorkspaceOperationId,
              acceptedWorkspaceClientMutationId: receipt.acceptedWorkspaceClientMutationId,
              acceptedWorkspaceArtifactId: receipt.acceptedWorkspaceArtifactId,
            }
          : {}),
        verificationRunId: run.id,
      } satisfies WriterReviewAwaitingMarker,
    };
    const [updated] = await tx.update(tasks).set({
      status: "running",
      metadata,
      updatedAt: new Date(),
    }).where(and(eq(tasks.id, task.id), eq(tasks.status, "pending"))).returning();
    if (!updated) throw new Error("start writer review verification lost locked Task");
    return run;
  });
}

/** Startup recovery set for process-local Writer reviews that cannot survive restart.
 * Includes a fast accepted-save receipt recorded before the model leg parked. */
export async function listAwaitingWriterReviewTasks(
  db: DirectDatabase,
  options: ListAwaitingWriterReviewTasksOptions,
): Promise<Array<{ task: Task; run: TaskRun; marker: WriterReviewAwaitingMarker }>> {
  const after = options.after;
  const rows = await db.select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(and(
      writerReviewAwaitingPredicate(),
      or(
        and(eq(tasks.status, "awaiting"), eq(taskRuns.status, "awaiting")),
        and(
          eq(tasks.status, "running"),
          eq(taskRuns.status, "running"),
          writerReviewAcceptedReceiptPredicate(),
        ),
      ),
      ...(after
        ? [or(
            gt(taskRuns.startedAt, after.startedAt),
            and(eq(taskRuns.startedAt, after.startedAt), gt(taskRuns.id, after.runId)),
          )]
        : []),
    ))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id))
    .limit(options.limit);
  return rows.map(({ task, run }) => {
    const marker = task.metadata[WRITER_REVIEW_AWAITING_METADATA_KEY] as Partial<WriterReviewAwaitingMarker> | undefined;
    // `writerReviewAwaitingPredicate` validates this exact shape and binds the
    // marker to the joined TaskRun. This cast is projection, never authority.
    return { task, run, marker: marker as WriterReviewAwaitingMarker };
  });
}

/**
 * Startup-only recovery set for a review that was already accepted and
 * atomically requeued for verification when the process died. The completed
 * producing run is joined by the exact durable receipt identity; no broad
 * pending-Task scan may substitute for this query.
 */
export async function listPendingWriterReviewVerificationTasks(
  db: DirectDatabase,
  options: ListAwaitingWriterReviewTasksOptions,
): Promise<Array<{ task: Task; run: TaskRun; receipt: WriterReviewAwaitingMarker }>> {
  const after = options.after;
  const rows = await db.select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(and(
      eq(tasks.status, "pending"),
      eq(taskRuns.status, "completed"),
      writerReviewAcceptedRequeuePredicate(),
      ...(after
        ? [or(
            gt(taskRuns.startedAt, after.startedAt),
            and(eq(taskRuns.startedAt, after.startedAt), gt(taskRuns.id, after.runId)),
          )]
        : []),
    ))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id))
    .limit(options.limit);
  return rows.map(({ task, run }) => {
    const receipt = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as WriterReviewAwaitingMarker;
    return { task, run, receipt };
  });
}

/**
 * Startup-only recovery set for a verification run that was atomically
 * started just before process death. Its live-session binding cannot survive,
 * so terminalize this exact running verifier rather than waiting for a timeout.
 */
export async function listRunningWriterReviewVerificationTasks(
  db: DirectDatabase,
  options: ListAwaitingWriterReviewTasksOptions,
): Promise<Array<{ task: Task; run: TaskRun; receipt: WriterReviewAwaitingMarker }>> {
  const after = options.after;
  const rows = await db.select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(and(
      eq(tasks.status, "running"),
      eq(taskRuns.status, "running"),
      writerReviewVerificationRunPredicate(),
      ...(after
        ? [or(
            gt(taskRuns.startedAt, after.startedAt),
            and(eq(taskRuns.startedAt, after.startedAt), gt(taskRuns.id, after.runId)),
          )]
        : []),
    ))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id))
    .limit(options.limit);
  return rows.map(({ task, run }) => {
    const receipt = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as WriterReviewAwaitingMarker;
    return { task, run, receipt };
  });
}

/**
 * Terminalize only the parent Task when an accepted Writer save cannot resume
 * its required verification after restart. The producing TaskRun deliberately
 * remains completed with its saved receipt; creating or mutating another run
 * would falsely imply that verification executed.
 */
export async function terminalizeTaskWriterReviewVerificationLost(
  db: DirectDatabase,
  input: { taskId: string; taskRunId: string; proposalId: string; error: string },
): Promise<TerminalizeWriterReviewVerificationLostResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).for("update");
    if (!task) return { transitioned: false };
    const [run] = await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, input.taskRunId), eq(taskRuns.taskId, input.taskId)))
      .for("update");
    if (!run) return { transitioned: false, task };
    const receipt = task.metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY] as
      | Partial<WriterReviewAwaitingMarker>
      | undefined;
    if (
      task.status !== "pending" ||
      run.status !== "completed" ||
      receipt?.version !== 1 ||
      receipt.taskRunId !== input.taskRunId ||
      receipt.proposalId !== input.proposalId ||
      !Object.prototype.hasOwnProperty.call(receipt, "acceptedResultRevision")
    ) return { transitioned: false, task, run };
    const [updated] = await tx.update(tasks).set({
      status: "errored",
      lastError: input.error,
      fireLockId: null,
      fireLockedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(tasks.id, task.id), eq(tasks.status, "pending"))).returning();
    if (!updated) return { transitioned: false, task, run };
    return { transitioned: true, task: updated, run };
  });
}

/**
 * M164 — the awaiting task + run for an approval/PIN/identity resume, matched by
 * `taskId` AND the parked run's `graphThreadId`. Returns the pair ONLY when BOTH
 * the task and its run are still `awaiting` (fail-closed: a run that already
 * completed / cancelled / errored is not resumable). Owner-only authorization is
 * the caller's job (compare `task.ownerId` to the session user). The
 * `graphThreadId` predicate binds the resume to the exact checkpoint the client
 * was prompted on, so a stale `threadId` cannot drive a resume on a different
 * run.
 */
export async function findAwaitingTaskRunForApproval(
  db: DirectDatabase,
  taskId: string,
  graphThreadId: string,
): Promise<{ task: Task; run: TaskRun } | undefined> {
  const [row] = await db
    .select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.id, taskId),
        eq(taskRuns.graphThreadId, graphThreadId),
        eq(tasks.status, "awaiting"),
        eq(taskRuns.status, "awaiting"),
        excludesWriterReviewAwaitingPredicate(),
      ),
    )
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  return row ? { task: row.task, run: row.run } : undefined;
}

/**
 * Claim or re-park the exact approval run without reviving stopped work.
 * Lock Task before TaskRun, matching the canonical lifecycle lock order.
 */
export async function transitionTaskApprovalExecution(
  db: DirectDatabase,
  input: {
    taskId: string;
    runId: string;
    graphThreadId: string;
    ownerId: string;
    from: "awaiting" | "running";
    to: "awaiting" | "running";
    /** Exact content-access continuation cannot claim an older run. */
    requireLatestRun?: boolean;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.ownerId, input.ownerId),
        eq(tasks.status, input.from), excludesWriterReviewAwaitingPredicate()))
      .for("update");
    if (!task) return false;
    if (input.requireLatestRun) {
      const [latest] = await tx.select({ id: taskRuns.id }).from(taskRuns)
        .where(eq(taskRuns.taskId, task.id)).orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1).for("update");
      if (latest?.id !== input.runId) return false;
    }
    const [run] = await tx.update(taskRuns).set({ status: input.to })
      .where(and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, task.id),
        eq(taskRuns.graphThreadId, input.graphThreadId), eq(taskRuns.status, input.from)))
      .returning({ id: taskRuns.id });
    if (!run) return false;
    await tx.update(tasks).set({ status: input.to, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return true;
  });
}

/** Repair only the crash window after a failed tools checkpoint was saved.
 * Caller holds the graph lock and proves that exact checkpoint/current admission.
 * Task→latest Run→original terminal Job locks fence Stop, replacement and linkage. */
export async function repairTaskContentAccessRecovery(db: DirectDatabase, input: {
  taskId: string; runId: string; graphThreadId: string; ownerId: string;
  requestorId: string; agentId: string; roomId: string; originalJobId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, input.taskId),
      eq(tasks.ownerId, input.ownerId), eq(tasks.requestorId, input.requestorId),
      eq(tasks.agentId, input.agentId), eq(tasks.targetRoomId, input.roomId), eq(tasks.status, "running"))).for("update");
    if (!task) return false;
    const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.taskId, task.id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1).for("update");
    if (!run || run.id !== input.runId || run.status !== "running" || run.graphThreadId !== input.graphThreadId
      || run.jobId !== input.originalJobId) return false;
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, input.originalJobId),
      eq(jobs.requestorId, input.requestorId), inArray(jobs.status, ["failed", "completed"]))).for("share");
    if (!job || job.input?.["taskId"] !== task.id || job.input["taskRunId"] !== run.id
      || job.input["graphThreadId"] !== run.graphThreadId || job.input["agentId"] !== task.agentId
      || job.input["roomId"] !== input.roomId || job.input["ownerId"] !== task.ownerId) return false;
    await tx.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({ status: "awaiting", updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
}

/**
 * Return the newest parked run for every awaiting Task owned by one Human.
 * Reconnect uses this bounded-to-active-work set to rebuild owner-private
 * approval/PIN events from the canonical LangGraph checkpoint.
 */
export async function listAwaitingTaskRunsForOwner(
  db: DirectDatabase,
  ownerId: string,
): Promise<Array<{ task: Task; run: TaskRun }>> {
  return db
    .selectDistinctOn([taskRuns.taskId], { task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        eq(tasks.status, "awaiting"),
        eq(taskRuns.status, "awaiting"),
        excludesWriterReviewAwaitingPredicate(),
      ),
    )
    .orderBy(taskRuns.taskId, desc(taskRuns.startedAt));
}

/**
 * M147 (R5) — the time-limit watchdog scan. Returns every `running` task with
 * a non-null `time_limit_seconds` whose active (running, job-linked) run has
 * been executing longer than its budget (`started_at + time_limit_seconds <
 * now`). The observer pauses each one via `pauseTask`.
 */
export async function findTimedOutRunningTasks(
  db: DirectDatabase,
  now: Date,
): Promise<Array<{ task: Task; run: TaskRun }>> {
  const rows = await db
    .select({ task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.status, "running"),
        isNotNull(tasks.timeLimitSeconds),
        eq(taskRuns.status, "running"),
        isNotNull(taskRuns.jobId),
        sql`${taskRuns.startedAt} + (${tasks.timeLimitSeconds} * interval '1 second') < ${now.toISOString()}::timestamptz`,
      ),
    );
  return rows;
}

// --- Observer claim / lock maintenance ---------------------------------

/**
 * Atomically claim up to `batch` due tasks for the observer.
 *
 * Selects `pending` + `next_fire_at <= now` + unlocked rows with
 * `FOR UPDATE SKIP LOCKED` (so concurrent observers claim DISJOINT rows),
 * then stamps a fresh per-row `fire_lock_id` + `fire_locked_at = now` on
 * the claimed rows before commit. Returns the claimed (locked) rows.
 */
export async function claimDueTasks(
  db: DirectDatabase,
  now: Date,
  batch: number,
): Promise<Task[]> {
  if (batch <= 0) return [];
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          eq(tasks.contentRepresentation, "ordinary"),
          lte(tasks.nextFireAt, now),
          isNull(tasks.fireLockId),
        ),
      )
      .orderBy(asc(tasks.nextFireAt))
      .limit(batch)
      .for("update", { skipLocked: true });

    if (due.length === 0) return [];
    const ids = due.map((r) => r.id);

    return tx
      .update(tasks)
      .set({ fireLockId: sql`gen_random_uuid()`, fireLockedAt: now })
      .where(inArray(tasks.id, ids))
      .returning();
  });
}

/** A pending protected Task cannot be dispatched while any reserved next
 * definition revision has not reached product mapping. Failed revisions stay
 * closed for repair instead of running old content with newer operations. */
export function protectedTaskPublicationIdlePredicate(db: DirectDatabase) {
  return notExists(
    db.select({ taskId: taskDefinitionCryptoRevisions.taskId })
      .from(taskDefinitionCryptoRevisions)
      .where(and(
        eq(taskDefinitionCryptoRevisions.taskId, tasks.id),
        eq(
          taskDefinitionCryptoRevisions.contentRevision,
          sql`${tasks.contentRevision} + 1`,
        ),
      )),
  );
}

/**
 * Claim only due Tasks whose protected representation is complete and current.
 * Plain scheduling keeps its independent `claimDueTasks` path.
 */
export async function claimDueProtectedTasks(
  db: DirectDatabase,
  now: Date,
  batch: number,
): Promise<Task[]> {
  if (batch <= 0) return [];
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          inArray(tasks.contentRepresentation, ["dual", "protected"]),
          eq(tasks.cryptoMappingState, "verified"),
          protectedTaskPublicationIdlePredicate(db),
          lte(tasks.nextFireAt, now),
          isNull(tasks.fireLockId),
        ),
      )
      .orderBy(asc(tasks.nextFireAt), asc(tasks.id))
      .limit(batch)
      .for("update", { skipLocked: true });

    if (due.length === 0) return [];
    const ids = due.map((row) => row.id);
    return tx
      .update(tasks)
      .set({ fireLockId: sql`gen_random_uuid()`, fireLockedAt: now })
      .where(inArray(tasks.id, ids))
      .returning();
  });
}

export type PrepareClaimedProtectedTaskOccurrenceInput = Readonly<{
  taskId: string;
  fireLockId: string;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  scheduledFor: Date;
  taskRunId: string;
  graphThreadId: string;
  /** Required only for cron and must advance beyond the claimed instant. */
  cronNextFireAt?: Date;
}>;

export type PrepareClaimedProtectedTaskOccurrenceResult =
  | Readonly<{ status: "prepared"; task: Task; run: TaskRun }>
  | Readonly<{ status: "stale" }>;

export type ProtectedAwaitingTaskRunCursor = Readonly<{
  taskRunId: string;
}>;

/**
 * Discover content-free protected occurrences that still need authorization.
 * Each row is keyed by its durable TaskRun identity so separate cron fires do
 * not collapse into one Task-level request. Terminal and explicitly parked
 * parent Tasks are excluded; a running parent may still have another cron
 * occurrence waiting for its own grant.
 */
export async function listProtectedAwaitingTaskRunsForAuthorization(
  db: DirectDatabase,
  batch: number,
  after?: ProtectedAwaitingTaskRunCursor,
): Promise<Array<{ task: Task; run: TaskRun }>> {
  if (batch <= 0) return [];
  return db
    .select({ task: tasks, run: taskRuns })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(
      eq(taskRuns.status, "awaiting"),
      inArray(tasks.status, ["pending", "awaiting", "running"]),
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
      eq(tasks.cryptoMappingState, "verified"),
      after ? gt(taskRuns.id, after.taskRunId) : undefined,
    ))
    .orderBy(asc(taskRuns.id))
    .limit(batch);
}

/**
 * Consume one exact protected fire-lock into one content-free awaiting run.
 * The Task schedule and occurrence row commit together, so a stale observer
 * cannot create a second run after another observer advances the Task.
 */
export async function prepareClaimedProtectedTaskOccurrence(
  db: DirectDatabase,
  input: PrepareClaimedProtectedTaskOccurrenceInput,
): Promise<PrepareClaimedProtectedTaskOccurrenceResult> {
  if (
    !(input.scheduledFor instanceof Date)
    || !Number.isFinite(input.scheduledFor.getTime())
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
  ) {
    throw new TypeError("Protected Task occurrence binding is malformed");
  }
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, "pending"),
        eq(tasks.fireLockId, input.fireLockId),
        eq(tasks.contentRepresentation, input.contentRepresentation),
        eq(tasks.cryptoMappingState, "verified"),
        eq(tasks.contentNamespaceId, input.contentNamespaceId),
        eq(tasks.contentRevision, input.contentRevision),
        eq(tasks.cryptoObjectId, input.cryptoObjectId),
        eq(
          tasks.cryptoRequiredNamespaceFingerprint,
          input.cryptoRequiredNamespaceFingerprint,
        ),
        eq(tasks.nextFireAt, input.scheduledFor),
      ))
      .limit(1)
      .for("update");
    if (!task) return { status: "stale" } as const;

    const isCron = task.scheduleKind === "cron";
    if (
      isCron
        ? !(input.cronNextFireAt instanceof Date)
          || !Number.isFinite(input.cronNextFireAt.getTime())
          || input.cronNextFireAt.getTime() <= input.scheduledFor.getTime()
        : input.cronNextFireAt !== undefined
    ) {
      throw new TypeError("Protected Task occurrence schedule advance is invalid");
    }

    const [run] = await tx
      .insert(taskRuns)
      .values({
        id: input.taskRunId,
        taskId: task.id,
        graphThreadId: input.graphThreadId,
        status: "awaiting",
        modelId: null,
        resultText: null,
      })
      .returning();
    if (!run) throw new Error("Protected Task occurrence insert returned no row");

    const [updatedTask] = await tx
      .update(tasks)
      .set(isCron
        ? {
            status: "pending",
            nextFireAt: input.cronNextFireAt!,
            lastFiredAt: input.scheduledFor,
            fireLockId: null,
            fireLockedAt: null,
            updatedAt: new Date(),
          }
        : {
            status: "awaiting",
            nextFireAt: null,
            lastFiredAt: input.scheduledFor,
            fireLockId: null,
            fireLockedAt: null,
            updatedAt: new Date(),
          })
      .where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "pending"),
        eq(tasks.fireLockId, input.fireLockId),
      ))
      .returning();
    if (!updatedTask) {
      throw new Error("Protected Task occurrence lost its locked Task");
    }
    return { status: "prepared", task: updatedTask, run } as const;
  });
}

/**
 * Clear fire-locks older than `olderThan` (stale-lock recovery — an
 * observer crashed mid-claim). Returns the number of rows cleared.
 */
export async function clearStaleFireLocks(
  db: DirectDatabase,
  olderThan: Date,
): Promise<number> {
  const cleared = await db
    .update(tasks)
    .set({ fireLockId: null, fireLockedAt: null })
    .where(
      and(isNotNull(tasks.fireLockedAt), lt(tasks.fireLockedAt, olderThan)),
    )
    .returning({ id: tasks.id });
  return cleared.length;
}

export interface AuthorizationPauseTransition {
  task: Task | undefined;
  run: TaskRun | undefined;
  transitioned: boolean;
}

/**
 * M254 R6 — pause only the exact pending Task claim whose requestor no longer
 * has Agent-invocation authority. The fire-lock predicate prevents a stale
 * observer from pausing a row that was unpaused, stopped, or reclaimed after
 * the observer read it.
 */
export async function pauseClaimedTaskForAuthorizationDenial(
  db: DirectDatabase,
  input: { taskId: string; fireLockId: string },
): Promise<AuthorizationPauseTransition> {
  const [task] = await db
    .update(tasks)
    .set({
      status: "paused",
      lastError: "invoke_agents_required",
      fireLockId: null,
      fireLockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, "pending"),
        eq(tasks.fireLockId, input.fireLockId),
      ),
    )
    .returning();
  return { task, run: undefined, transitioned: Boolean(task) };
}

/**
 * M254 R7/R8 — authorization-pause an exact parked Task checkpoint. Both the
 * Task and TaskRun are locked and matched to their awaiting state and durable
 * graph identity before either row changes, so a stale response cannot strand
 * or overwrite a newer run.
 */
export async function pauseAwaitingTaskRunForAuthorizationDenial(
  db: DirectDatabase,
  input: { taskId: string; taskRunId: string; graphThreadId: string },
): Promise<AuthorizationPauseTransition> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.status, "awaiting")))
      .limit(1)
      .for("update");
    if (!task) return { task: undefined, run: undefined, transitioned: false };

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.id, input.taskRunId),
          eq(taskRuns.taskId, input.taskId),
          eq(taskRuns.graphThreadId, input.graphThreadId),
          eq(taskRuns.status, "awaiting"),
        ),
      )
      .limit(1)
      .for("update");
    if (!run) return { task, run: undefined, transitioned: false };

    const [updatedRun] = await tx
      .update(taskRuns)
      .set({ status: "paused" })
      .where(
        and(
          eq(taskRuns.id, run.id),
          eq(taskRuns.taskId, task.id),
          eq(taskRuns.graphThreadId, input.graphThreadId),
          eq(taskRuns.status, "awaiting"),
        ),
      )
      .returning();
    if (!updatedRun) return { task, run, transitioned: false };

    const [updatedTask] = await tx
      .update(tasks)
      .set({
        status: "paused",
        lastError: "invoke_agents_required",
        fireLockId: null,
        fireLockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "awaiting")))
      .returning();
    if (!updatedTask) {
      // This can only happen if the transaction-local row changed
      // unexpectedly. Throw so the TaskRun update rolls back atomically.
      throw new Error("authorization pause lost awaiting Task after row lock");
    }
    return { task: updatedTask, run: updatedRun, transitioned: true };
  });
}

/**
 * Advance a cron task to its next occurrence. The cron-string →
 * next-occurrence computation is Phase 2; this helper just writes the
 * already-computed `nextFireAt`, stamps `last_fired_at = now`, clears the
 * fire-lock, and keeps the task `pending` for the next tick.
 */
export async function rescheduleCron(
  db: DirectDatabase,
  id: string,
  nextFireAt: Date,
): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({
      nextFireAt,
      lastFiredAt: now,
      fireLockId: null,
      fireLockedAt: null,
      status: "pending",
      updatedAt: now,
    })
    .where(eq(tasks.id, id));
}

// --- Lifecycle status setters ------------------------------------------

async function setTaskStatus(
  db: DirectDatabase,
  id: string,
  status: TaskStatus,
  extra: Partial<NewTask> = {},
): Promise<void> {
  await db
    .update(tasks)
    .set({ status, ...extra, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

export function markTaskRunning(db: DirectDatabase, id: string): Promise<void> {
  return setTaskStatus(db, id, "running");
}

export function markTaskAwaiting(db: DirectDatabase, id: string): Promise<void> {
  return setTaskStatus(db, id, "awaiting");
}

export function markTaskPaused(db: DirectDatabase, id: string): Promise<void> {
  return setTaskStatus(db, id, "paused");
}

export function markTaskCompleted(db: DirectDatabase, id: string): Promise<void> {
  return setTaskStatus(db, id, "completed");
}

export function markTaskCancelled(db: DirectDatabase, id: string): Promise<void> {
  return setTaskStatus(db, id, "cancelled", { cancelledAt: new Date() });
}

export function markTaskErrored(
  db: DirectDatabase,
  id: string,
  error: string,
): Promise<void> {
  return setTaskStatus(db, id, "errored", {
    lastError: error,
    fireLockId: null,
    fireLockedAt: null,
  });
}

/** Set a `task_runs` row status, optionally patching other run fields. */
export async function markTaskRunStatus(
  db: DirectDatabase,
  runId: string,
  status: TaskRunStatus,
  patch: Partial<NewTaskRun> = {},
): Promise<void> {
  await db
    .update(taskRuns)
    .set({ status, ...patch })
    .where(eq(taskRuns.id, runId));
}

/** Retain only fixed progress facts for the exact currently executing run. */
export async function recordTaskPreparation(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; preparation: unknown; updatedAt: string;
}): Promise<void> {
  const preparation = readTaskPreparation({ ...(input.preparation as object), taskRunId: input.taskRunId, updatedAt: input.updatedAt });
  if (!preparation) return;
  await db.update(tasks).set({
    metadata: sql`jsonb_set(coalesce(${tasks.metadata}, '{}'::jsonb), '{preparation}', ${JSON.stringify(preparation)}::jsonb)`,
  }).where(and(eq(tasks.id, input.taskId), eq(tasks.ownerId, input.ownerId), eq(tasks.status, "running"),
    sql`exists (select 1 from ${taskRuns} where ${taskRuns.id} = ${input.taskRunId} and ${taskRuns.taskId} = ${tasks.id} and ${taskRuns.status} = 'running')`));
}
