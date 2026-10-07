import {
  parseTaskFundingBinding,
  readTaskPreparation,
  type TaskFundingBinding,
  type TaskFundingFailureCode,
} from "@nautilo/types";
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
import { and, arrayContains, asc, desc, eq, exists, getTableColumns, gt, inArray, isNotNull, isNull, lt, lte, notExists, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../config/direct-database";
import { tasks, type Task, type NewTask } from "../schema/tasks";
import { taskRuns, type TaskRun, type NewTaskRun } from "../schema/task-runs";
import { profiles } from "../schema/profiles";
import { jobs, type Job } from "../schema/jobs";
import { rooms } from "../schema/rooms";
import { sessionMessages, sessions } from "../schema/sessions";
import { sessionMessageCryptoRevisions } from "../schema/session-message-crypto-revisions";
import { conversationSharedAgentShadowOperations } from
  "../schema/conversation-shared-agent-shadow-operations";
import {
  taskDefinitionCryptoRevisions,
  type TaskDefinitionCryptoRevision,
} from "../schema/task-definition-crypto-revisions";
import {
  taskRunResultCryptoRevisions,
  type TaskRunResultCryptoRevision,
} from "../schema/task-run-result-crypto-revisions";
import { encryptionTransitionPolicy } from "../schema/encryption-transition";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from
  "../schema/protected-task-run-output-bindings";
import { protectedTaskRunResultObjectId } from
  "./protected-task-output-binding-identities";
import {
  sealProtectedTaskContinuationReceiptInTx,
  sealProtectedTaskExecutionSegmentReceiptInTx,
  type SealProtectedTaskContinuationReceiptInput,
  type SealProtectedTaskContinuationReceiptResult,
  type SealProtectedTaskExecutionSegmentReceiptInput,
  type SealProtectedTaskExecutionSegmentReceiptResult,
} from "./protected-task-execution-receipts";
import { readProtectedTaskTranscriptManifestInTx } from
  "./task-run-message-associations";

type TaskStatus = NonNullable<NewTask["status"]>;
type TaskRunStatus = NonNullable<NewTaskRun["status"]>;

const TERMINAL_TASK_STATUSES = ["completed", "cancelled", "errored"] as const;
const TERMINAL_TASK_RUN_STATUSES = ["completed", "cancelled", "errored"] as const;

/** Small enough for a compact Done surface while still showing recent work. */
const DEFAULT_RECENT_TERMINAL_TASK_LIMIT = 5;
/** Hard server-side ceiling: task history must never become an unbounded list. */
const MAX_RECENT_TERMINAL_TASK_LIMIT = 50;
const WRITER_REVIEW_AWAITING_METADATA_KEY = "writerReviewAwaiting";
const taskRunOrderReference = alias(taskRuns, "task_run_order_reference");
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

/** Reload one TaskRun by both identities before protected dispatch. */
export async function getTaskRunForTask(
  db: DirectDatabase,
  taskId: string,
  taskRunId: string,
): Promise<TaskRun | undefined> {
  const [row] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.id, taskRunId),
    eq(taskRuns.taskId, taskId),
  )).limit(1);
  return row;
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
  representation?: "ordinary" | "protected" | "dual",
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
        ...(representation === undefined ? [] : [eq(tasks.contentRepresentation, representation)]),
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

export type ProtectedTaskDurableJobReference = Readonly<{
  kind: "protected_task_run_v1";
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  authorizationRequestId: string;
  policyRevision: number;
  executionSegment: number;
  /** Present only on a resumed segment; binds it to one durable acceptance. */
  resumeAcceptanceId?: string;
}>;

export type StartProtectedTaskRunInput = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  jobId: string;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  jobReference: ProtectedTaskDurableJobReference;
}>;

export type StartProtectedTaskRunResult =
  | Readonly<{ status: "started" }>
  | Readonly<{ status: "stale" }>;

export type AttachProtectedTaskRunModelInput = StartProtectedTaskRunInput &
  Readonly<{ modelId: string }>;

export type AttachProtectedTaskRunModelResult =
  | Readonly<{ status: "attached" | "same" }>
  | Readonly<{ status: "stale" }>;

const NATIVE_TASK_MODEL_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9/._-]*$/u;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactProtectedTaskJobReference(
  value: unknown,
  expected: ProtectedTaskDurableJobReference,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  const expectedKeys = expected.resumeAcceptanceId === undefined
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId";
  return (expected.executionSegment === 1
      ? expected.resumeAcceptanceId === undefined
      : opaqueCheckpointCoordinate(expected.resumeAcceptanceId))
    && Object.keys(reference).sort().join(",")
      === expectedKeys
    && reference["kind"] === expected.kind
    && reference["taskId"] === expected.taskId
    && reference["taskRunId"] === expected.taskRunId
    && reference["inputObjectId"] === expected.inputObjectId
    && reference["resultObjectId"] === expected.resultObjectId
    && reference["authorizationRequestId"] === expected.authorizationRequestId
    && reference["policyRevision"] === expected.policyRevision
    && reference["executionSegment"] === expected.executionSegment
    && reference["resumeAcceptanceId"] === expected.resumeAcceptanceId;
}

/**
 * Attach one persisted, content-free Job to its exact protected TaskRun before
 * any transient plaintext is opened. Task -> TaskRun -> Job lock order matches
 * the existing lifecycle writers. A duplicate, stale authorization, changed
 * crypto coordinate, user Stop/Pause, or unrelated Job returns `stale` without
 * changing either lifecycle row.
 *
 * One-shot Tasks enter `running`; cron Tasks remain `pending` because their
 * next occurrence was already advanced when this run was prepared. In both
 * cases only the exact awaiting TaskRun enters `running` with the Job link.
 */
export async function startProtectedTaskRun(
  db: DirectDatabase,
  input: StartProtectedTaskRunInput,
): Promise<StartProtectedTaskRunResult> {
  if (
    !input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.jobId
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
    || input.jobReference === null
    || typeof input.jobReference !== "object"
    || Array.isArray(input.jobReference)
    || input.jobReference.kind !== "protected_task_run_v1"
    || input.jobReference.taskId !== input.taskId
    || input.jobReference.taskRunId !== input.taskRunId
    || input.jobReference.inputObjectId !== input.cryptoObjectId
    || input.jobReference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !input.jobReference.authorizationRequestId
    || !Number.isSafeInteger(input.jobReference.policyRevision)
    || input.jobReference.policyRevision < 1
    || input.jobReference.executionSegment !== 1
    || input.jobReference.resumeAcceptanceId !== undefined
    || !exactProtectedTaskJobReference(input.jobReference, input.jobReference)
  ) {
    throw new TypeError("Protected Task start binding is malformed");
  }

  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for("update");
    if (!task) return { status: "stale" } as const;

    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    if (
      task.status !== expectedTaskStatus
      || task.contentRepresentation !== input.contentRepresentation
      || task.contentNamespaceId !== input.contentNamespaceId
      || task.contentRevision !== input.contentRevision
      || task.cryptoObjectId !== input.cryptoObjectId
      || task.cryptoAccessRevision !== input.cryptoAccessRevision
      || task.cryptoMappingState !== "verified"
      || task.cryptoRequiredNamespaceFingerprint === null
      || !sameBytes(
        task.cryptoRequiredNamespaceFingerprint,
        input.cryptoRequiredNamespaceFingerprint,
      )
    ) {
      return { status: "stale" } as const;
    }

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, task.id),
      ))
      .limit(1)
      .for("update");
    if (
      !run
      || run.graphThreadId !== input.graphThreadId
      || run.status !== "awaiting"
      || run.jobId !== null
      || run.modelId !== null
      || run.resultText !== null
      || run.completedAt !== null
      || run.lastError !== null
      || run.resultRepresentation !== "ordinary"
      || run.resultContentNamespaceId !== null
      || run.resultRevision !== 0
      || run.resultCryptoObjectId !== null
      || run.resultCryptoAccessRevision !== 0
      || run.resultCryptoRequiredNamespaceFingerprint !== null
      || run.resultCryptoMappingState !== "unmapped"
    ) {
      return { status: "stale" } as const;
    }

    const [outputBinding] = await tx.select()
      .from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, run.id))
      .limit(1).for("share");
    if (!outputBinding
      || outputBinding.bindingId !== `task-run-output:${run.id}`
      || outputBinding.resultOperationId !== `task-run-result:${run.id}`
      || outputBinding.resultObjectId !== input.jobReference.resultObjectId
      || outputBinding.acceptedPolicyRevision
        !== input.jobReference.policyRevision
      || outputBinding.resultTerminalAt !== null
      || outputBinding.resultAttachedAt !== null
      || outputBinding.messageId !== null
      || outputBinding.messagePublishedAt !== null
      || outputBinding.wakeJobId !== null
      || outputBinding.wakeScheduledAt !== null
      || outputBinding.completedAt !== null
      || (task.callingRoomId === null
        ? outputBinding.deliveryMode !== "none"
          || outputBinding.destinationRoomId !== null
          || outputBinding.destinationNamespaceId !== null
        : outputBinding.deliveryMode !== task.resultDelivery
          || outputBinding.destinationRoomId !== task.callingRoomId
          || outputBinding.destinationNamespaceId === null)) {
      return { status: "stale" } as const;
    }
    if (outputBinding.destinationRoomId !== null) {
      const [destination] = await tx.select({ id: rooms.id })
        .from(rooms).where(and(
          eq(rooms.id, outputBinding.destinationRoomId),
          eq(rooms.namespaceId, outputBinding.destinationNamespaceId!),
          isNull(rooms.archivedAt),
        )).limit(1).for("share");
      if (!destination) return { status: "stale" } as const;
    }

    const [job] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .limit(1)
      .for("share");
    if (
      !job
      || job.ownerId !== task.requestorId
      || job.requestorId !== task.requestorId
      || job.laneKey !== `task:${task.id}`
      || job.type !== "foreground"
      || job.status !== "queued"
      || job.result !== null
      || job.message !== null
      || job.startedAt !== null
      || job.completedAt !== null
      || !exactProtectedTaskJobReference(job.input, input.jobReference)
    ) {
      return { status: "stale" } as const;
    }

    const [updatedRun] = await tx
      .update(taskRuns)
      .set({ status: "running", jobId: job.id })
      .where(and(
        eq(taskRuns.id, run.id),
        eq(taskRuns.taskId, task.id),
        eq(taskRuns.graphThreadId, input.graphThreadId),
        eq(taskRuns.status, "awaiting"),
        isNull(taskRuns.jobId),
      ))
      .returning();
    if (!updatedRun) {
      throw new Error("Protected Task start lost its locked TaskRun");
    }

    if (task.scheduleKind === "cron") {
      return { status: "started" } as const;
    }

    const [updatedTask] = await tx
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "awaiting"),
      ))
      .returning();
    if (!updatedTask) {
      throw new Error("Protected Task start lost its locked Task");
    }
    return { status: "started" } as const;
  });
}

/**
 * Persist the already-resolved native model on one exact running protected
 * TaskRun. This is deliberately separate from the start transition: model
 * selection can perform asynchronous policy/catalog work only after the
 * protected definition has been opened, while this CAS revalidates the full
 * durable Task -> TaskRun -> Job chain before recording the result.
 *
 * Exact retries are idempotent. A different model, terminal work, changed
 * crypto coordinates, or a stopped/unrelated Job returns `stale` without a
 * write. Plain TaskRuns cannot satisfy the protected representation checks.
 */
export async function attachProtectedTaskRunModel(
  db: DirectDatabase,
  input: AttachProtectedTaskRunModelInput,
): Promise<AttachProtectedTaskRunModelResult> {
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
    || input.jobReference === null
    || typeof input.jobReference !== "object"
    || Array.isArray(input.jobReference)
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
    || !exactProtectedTaskJobReference(input.jobReference, input.jobReference)
  ) {
    throw new TypeError("Protected Task model binding is malformed");
  }

  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
      .for("update");
    if (!task) return { status: "stale" } as const;

    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "running";
    if (
      task.status !== expectedTaskStatus
      || task.contentRepresentation !== input.contentRepresentation
      || task.contentNamespaceId !== input.contentNamespaceId
      || task.contentRevision !== input.contentRevision
      || task.cryptoObjectId !== input.cryptoObjectId
      || task.cryptoAccessRevision !== input.cryptoAccessRevision
      || task.cryptoMappingState !== "verified"
      || task.cryptoRequiredNamespaceFingerprint === null
      || !sameBytes(
        task.cryptoRequiredNamespaceFingerprint,
        input.cryptoRequiredNamespaceFingerprint,
      )
    ) {
      return { status: "stale" } as const;
    }

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, task.id),
      ))
      .limit(1)
      .for("update");
    if (
      !run
      || run.graphThreadId !== input.graphThreadId
      || run.status !== "running"
      || run.jobId !== input.jobId
      || run.modelId !== null && run.modelId !== input.modelId
      || run.resultText !== null
      || run.completedAt !== null
      || run.lastError !== null
      || run.resultRepresentation !== "ordinary"
      || run.resultContentNamespaceId !== null
      || run.resultRevision !== 0
      || run.resultCryptoObjectId !== null
      || run.resultCryptoAccessRevision !== 0
      || run.resultCryptoRequiredNamespaceFingerprint !== null
      || run.resultCryptoMappingState !== "unmapped"
    ) {
      return { status: "stale" } as const;
    }

    const [job] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .limit(1)
      .for("share");
    if (
      !job
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
      || !exactProtectedTaskJobReference(job.input, input.jobReference)
    ) {
      return { status: "stale" } as const;
    }

    if (run.modelId === input.modelId) {
      return { status: "same" } as const;
    }

    const [updatedRun] = await tx
      .update(taskRuns)
      .set({ modelId: input.modelId })
      .where(and(
        eq(taskRuns.id, run.id),
        eq(taskRuns.taskId, task.id),
        eq(taskRuns.graphThreadId, input.graphThreadId),
        eq(taskRuns.status, "running"),
        eq(taskRuns.jobId, job.id),
        isNull(taskRuns.modelId),
        isNull(taskRuns.completedAt),
      ))
      .returning();
    if (!updatedRun) {
      throw new Error("Protected Task model binding lost its locked TaskRun");
    }
    return { status: "attached" } as const;
  });
}

const PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY =
  "nautilo.protectedTaskRunPark.v1";
const PROTECTED_TASK_AWAIT_REPLY_ACCEPTANCE_METADATA_KEY =
  "nautilo.protectedTaskAwaitReplyAcceptance.v1";
const PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY =
  "nautilo.protectedTaskRunTerminal.v1";
const OPAQUE_CHECKPOINT_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_MESSAGE_SERIAL = /^[1-9][0-9]{0,9}$/u;

export type ProtectedTaskRunInterruptKind =
  | "approval"
  | "prove_it"
  | "identity"
  | "await_reply"
  | "additional_authority";

export type ProtectedTaskRunInterruptCoordinate = Readonly<{
  id: string;
  kind: ProtectedTaskRunInterruptKind;
  requestId?: string;
}>;

export type ProtectedTaskAwaitReplyMessageReference = Readonly<{
  roomId: string;
  sessionId: string;
  messageId: string;
  editRevision: number;
  cryptoObjectId: string;
  namespaceId: string;
  sourceUserId: string;
}>;

export type ProtectedTaskAwaitReplyAcceptance = Readonly<{
  acceptanceId: string;
  interruptId: string;
  message: ProtectedTaskAwaitReplyMessageReference;
  acceptedAt: Date;
}>;

export type AcceptProtectedTaskAwaitReplyInput = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: Date;
  priorJobReference: ProtectedTaskDurableJobReference;
  acceptance: ProtectedTaskAwaitReplyAcceptance;
}>;

export type AcceptProtectedTaskAwaitReplyResult =
  | Readonly<{ status: "accepted" | "exact_replay" }>
  | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

export type ResolvePublishedProtectedTaskAwaitReplyResult =
  | Readonly<{ status: "no_match" | "ambiguous" }>
  | Readonly<{
      status: "resolved";
      input: AcceptProtectedTaskAwaitReplyInput;
    }>;

export type ParkProtectedTaskRunInput = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  jobId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: Date;
  jobReference: ProtectedTaskDurableJobReference;
}>;

export type ParkProtectedTaskRunResult =
  | Readonly<{ status: "parked" | "exact_replay" }>
  | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

type SegmentReceiptEvidence = Omit<
  SealProtectedTaskExecutionSegmentReceiptInput,
  | "taskId"
  | "taskRunId"
  | "jobId"
  | "executionSegment"
  | "transcript"
  | "sealedAt"
>;

type WithoutContinuationIdentity<
  Input extends SealProtectedTaskContinuationReceiptInput,
> = Input extends SealProtectedTaskContinuationReceiptInput
  ? Omit<
      Input,
      "taskId" | "taskRunId" | "jobId" | "executionSegment" | "sealedAt"
    >
  : never;

export type SealAndParkProtectedTaskRunContinuation = Readonly<
  Omit<WithoutContinuationIdentity<Extract<
    SealProtectedTaskContinuationReceiptInput,
    { kind: "pre_effect_interrupt_v1" }
  >>, "reason"> & { reason: "additional_authority" }
>;

export type SealAndParkProtectedTaskRunInput = Readonly<{
  park: ParkProtectedTaskRunInput;
  segment: SegmentReceiptEvidence;
  continuation: SealAndParkProtectedTaskRunContinuation;
}>;

export type SealAndParkProtectedTaskRunResult =
  | Readonly<{ status: "parked" | "exact_replay" }>
  | Readonly<{
      status: "rejected";
      stage: "segment";
      reason: Extract<
        SealProtectedTaskExecutionSegmentReceiptResult,
        { status: "rejected" }
      >["reason"];
    }>
  | Readonly<{
      status: "rejected";
      stage: "continuation";
      reason: Extract<
        SealProtectedTaskContinuationReceiptResult,
        { status: "rejected" }
      >["reason"];
    }>
  | Readonly<{
      status: "rejected";
      stage: "park";
      reason: Extract<ParkProtectedTaskRunResult, { status: "rejected" }>["reason"];
    }>;

export type StartParkedProtectedTaskRunSegmentInput = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  jobId: string;
  generation: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: Date;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  priorJobReference: ProtectedTaskDurableJobReference;
  jobReference: ProtectedTaskDurableJobReference;
  acceptance: ProtectedTaskAwaitReplyAcceptance;
}>;

export type StartParkedProtectedTaskRunSegmentResult =
  | Readonly<{ status: "started" | "exact_replay" }>
  | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

type ProtectedTaskRunParkReceipt = Readonly<{
  version: 1;
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: string;
}>;

type ProtectedTaskAwaitReplyAcceptanceReceipt = Readonly<{
  version: 1;
  acceptanceId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  generation: number;
  executionSegment: number;
  nextExecutionSegment: number;
  interrupt: Readonly<{ id: string; kind: "await_reply" }>;
  message: ProtectedTaskAwaitReplyMessageReference;
  acceptedAt: string;
  consumedByJobId?: string;
}>;

function opaqueCheckpointCoordinate(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_CHECKPOINT_COORDINATE.test(value);
}

function canonicalMessageSerial(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_MESSAGE_SERIAL.test(value)) {
    return false;
  }
  return value.length < 10 || value <= "2147483647";
}

function exactMessageReference(
  value: unknown,
  expected: ProtectedTaskAwaitReplyMessageReference,
): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",")
      === "cryptoObjectId,editRevision,messageId,namespaceId,roomId,sessionId,sourceUserId"
    && value["roomId"] === expected.roomId
    && value["sessionId"] === expected.sessionId
    && value["messageId"] === expected.messageId
    && value["editRevision"] === expected.editRevision
    && value["cryptoObjectId"] === expected.cryptoObjectId
    && value["namespaceId"] === expected.namespaceId
    && value["sourceUserId"] === expected.sourceUserId;
}

function assertProtectedTaskAwaitReplyAcceptance(
  acceptance: ProtectedTaskAwaitReplyAcceptance,
): void {
  if (
    !isRecord(acceptance)
    || Object.keys(acceptance).sort().join(",")
      !== "acceptanceId,acceptedAt,interruptId,message"
    || !isRecord(acceptance.message)
    || Object.keys(acceptance.message).sort().join(",")
      !== "cryptoObjectId,editRevision,messageId,namespaceId,roomId,sessionId,sourceUserId"
  ) {
    throw new TypeError("Protected Task await-reply acceptance is malformed");
  }
  const message = acceptance.message;
  if (
    !opaqueCheckpointCoordinate(acceptance.acceptanceId)
    || !opaqueCheckpointCoordinate(acceptance.interruptId)
    || !(acceptance.acceptedAt instanceof Date)
    || !Number.isFinite(acceptance.acceptedAt.getTime())
    || !CANONICAL_UUID.test(message.roomId)
    || !CANONICAL_UUID.test(message.sessionId)
    || !canonicalMessageSerial(message.messageId)
    || !Number.isSafeInteger(message.editRevision)
    || message.editRevision < 0
    || !opaqueCheckpointCoordinate(message.cryptoObjectId)
    || !CANONICAL_UUID.test(message.namespaceId)
    || !CANONICAL_UUID.test(message.sourceUserId)
  ) {
    throw new TypeError("Protected Task await-reply acceptance is malformed");
  }
}

function canonicalInterruptCoordinates(
  value: readonly ProtectedTaskRunInterruptCoordinate[],
): readonly ProtectedTaskRunInterruptCoordinate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Protected Task park binding is malformed");
  }
  const coordinates = value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new TypeError("Protected Task park binding is malformed");
    }
    const keys = Object.keys(candidate).sort().join(",");
    if (
      keys !== "id,kind" && keys !== "id,kind,requestId"
      || !opaqueCheckpointCoordinate(candidate["id"])
      || ![
        "approval",
        "prove_it",
        "identity",
        "await_reply",
        "additional_authority",
      ].includes(
        candidate["kind"] as string,
      )
    ) {
      throw new TypeError("Protected Task park binding is malformed");
    }
    const coordinate = {
      id: candidate["id"],
      kind: candidate["kind"] as ProtectedTaskRunInterruptKind,
    };
    if (keys === "id,kind") return Object.freeze(coordinate);
    const requestId = candidate["requestId"];
    if (!opaqueCheckpointCoordinate(requestId)) {
      throw new TypeError("Protected Task park binding is malformed");
    }
    return Object.freeze({ ...coordinate, requestId });
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (coordinates.some((coordinate, index) =>
    index > 0 && coordinates[index - 1]!.id === coordinate.id
  )) {
    throw new TypeError("Protected Task park binding is malformed");
  }
  return Object.freeze(coordinates);
}

function parkReceipt(
  input: ParkProtectedTaskRunInput,
): ProtectedTaskRunParkReceipt {
  return Object.freeze({
    version: 1,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.jobId,
    graphThreadId: input.graphThreadId,
    generation: input.generation,
    executionSegment: input.executionSegment,
    interrupts: canonicalInterruptCoordinates(input.interrupts),
    parkedAt: input.parkedAt.toISOString(),
  });
}

function awaitReplyAcceptanceReceipt(
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    graphThreadId: string;
    priorJobId: string;
    generation: number;
    executionSegment: number;
    interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
    parkedAt: Date;
    acceptance: ProtectedTaskAwaitReplyAcceptance;
  }>,
): ProtectedTaskAwaitReplyAcceptanceReceipt {
  assertProtectedTaskAwaitReplyAcceptance(input.acceptance);
  if (
    !Number.isSafeInteger(input.executionSegment)
    || input.executionSegment < 1
    || input.executionSegment === Number.MAX_SAFE_INTEGER
    || input.acceptance.acceptedAt.getTime() < input.parkedAt.getTime()
  ) {
    throw new TypeError("Protected Task await-reply acceptance is malformed");
  }
  const selected = canonicalInterruptCoordinates(input.interrupts).filter(
    (coordinate) => coordinate.id === input.acceptance.interruptId
      && coordinate.kind === "await_reply"
      && coordinate.requestId === undefined,
  );
  if (selected.length !== 1) {
    throw new TypeError("Protected Task await-reply acceptance is malformed");
  }
  return Object.freeze({
    version: 1,
    acceptanceId: input.acceptance.acceptanceId,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.priorJobId,
    graphThreadId: input.graphThreadId,
    generation: input.generation,
    executionSegment: input.executionSegment,
    nextExecutionSegment: input.executionSegment + 1,
    interrupt: Object.freeze({
      id: input.acceptance.interruptId,
      kind: "await_reply" as const,
    }),
    message: Object.freeze({ ...input.acceptance.message }),
    acceptedAt: input.acceptance.acceptedAt.toISOString(),
  });
}

function exactInterruptCoordinates(
  value: unknown,
  expected: readonly ProtectedTaskRunInterruptCoordinate[],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((candidate, index) => {
    const coordinate = expected[index]!;
    if (!isRecord(candidate)) return false;
    const keys = Object.keys(candidate).sort().join(",");
    return (keys === "id,kind" || keys === "id,kind,requestId")
      && candidate["id"] === coordinate.id
      && candidate["kind"] === coordinate.kind
      && candidate["requestId"] === coordinate.requestId;
  });
}

function exactParkReceipt(
  value: unknown,
  expected: ProtectedTaskRunParkReceipt,
): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",")
      === "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,taskId,taskRunId,version"
    && value["version"] === expected.version
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["jobId"] === expected.jobId
    && value["graphThreadId"] === expected.graphThreadId
    && value["generation"] === expected.generation
    && value["executionSegment"] === expected.executionSegment
    && exactInterruptCoordinates(value["interrupts"], expected.interrupts)
    && value["parkedAt"] === expected.parkedAt;
}

function exactAwaitReplyAcceptanceReceipt(
  value: unknown,
  expected: ProtectedTaskAwaitReplyAcceptanceReceipt,
  consumedByJobId?: string,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = consumedByJobId === undefined
    ? "acceptanceId,acceptedAt,executionSegment,generation,graphThreadId,interrupt,jobId,message,nextExecutionSegment,taskId,taskRunId,version"
    : "acceptanceId,acceptedAt,consumedByJobId,executionSegment,generation,graphThreadId,interrupt,jobId,message,nextExecutionSegment,taskId,taskRunId,version";
  const interrupt = value["interrupt"];
  return Object.keys(value).sort().join(",") === expectedKeys
    && value["version"] === expected.version
    && value["acceptanceId"] === expected.acceptanceId
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["jobId"] === expected.jobId
    && value["graphThreadId"] === expected.graphThreadId
    && value["generation"] === expected.generation
    && value["executionSegment"] === expected.executionSegment
    && value["nextExecutionSegment"] === expected.nextExecutionSegment
    && isRecord(interrupt)
    && Object.keys(interrupt).sort().join(",") === "id,kind"
    && interrupt["id"] === expected.interrupt.id
    && interrupt["kind"] === "await_reply"
    && exactMessageReference(value["message"], expected.message)
    && value["acceptedAt"] === expected.acceptedAt
    && value["consumedByJobId"] === consumedByJobId;
}

function pristineProtectedTaskRun(run: TaskRun): boolean {
  return run.resultText === null
    && run.completedAt === null
    && run.lastError === null
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

type ProtectedTaskParkTx = Pick<DirectDatabase, "select" | "update">;

type LockedProtectedTaskParkRows = Readonly<{
  status: "locked";
  task: Task;
  run: TaskRun;
  job: Job;
}>;

function prepareProtectedTaskParkReceipt(
  input: ParkProtectedTaskRunInput,
): ProtectedTaskRunParkReceipt {
  if (
    !input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.jobId
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0
    || !Number.isSafeInteger(input.executionSegment)
    || input.executionSegment < 1
    || !(input.parkedAt instanceof Date)
    || !Number.isFinite(input.parkedAt.getTime())
    || input.jobReference === null
    || typeof input.jobReference !== "object"
    || Array.isArray(input.jobReference)
    || input.jobReference.kind !== "protected_task_run_v1"
    || input.jobReference.taskId !== input.taskId
    || input.jobReference.taskRunId !== input.taskRunId
    || !input.jobReference.inputObjectId
    || input.jobReference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !input.jobReference.authorizationRequestId
    || !Number.isSafeInteger(input.jobReference.policyRevision)
    || input.jobReference.policyRevision < 1
    || input.jobReference.executionSegment !== input.executionSegment
    || !exactProtectedTaskJobReference(input.jobReference, input.jobReference)
  ) {
    throw new TypeError("Protected Task park binding is malformed");
  }
  return parkReceipt(input);
}

async function lockProtectedTaskParkRows(
  tx: Pick<DirectDatabase, "select">,
  input: ParkProtectedTaskRunInput,
): Promise<LockedProtectedTaskParkRows | Extract<
  ParkProtectedTaskRunResult,
  { status: "rejected" }
>> {
  const [task] = await tx.select().from(tasks)
    .where(eq(tasks.id, input.taskId)).limit(1).for("update");
  if (!task) return { status: "rejected", reason: "not_found" };

  const [run] = await tx.select().from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, task.id),
  )).limit(1).for("update");
  if (!run) return { status: "rejected", reason: "not_found" };

  const [job] = await tx.select().from(jobs)
    .where(eq(jobs.id, input.jobId)).limit(1).for("update");
  if (!job) return { status: "rejected", reason: "not_found" };

  return { status: "locked", task, run, job };
}

async function parkProtectedTaskRunWithLockedRows(
  tx: ProtectedTaskParkTx,
  input: ParkProtectedTaskRunInput,
  receipt: ProtectedTaskRunParkReceipt,
  rows: LockedProtectedTaskParkRows,
): Promise<ParkProtectedTaskRunResult> {
  const { task, run, job } = rows;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const existingReceipt = metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY];
  const exactProtectedTask = (
    task.contentRepresentation === "dual"
      || task.contentRepresentation === "protected"
  )
    && task.contentNamespaceId !== null
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified"
    && task.lastError === null
    && (task.contentRepresentation !== "protected" || (
      task.prompt === ""
      && task.expectedOutput === null
    ));
  const exactRunIdentity = run.graphThreadId === input.graphThreadId
    && run.jobId === input.jobId
    && pristineProtectedTaskRun(run);
  const exactJobIdentity = job.ownerId === task.requestorId
    && job.requestorId === task.requestorId
    && job.laneKey === `task:${task.id}`
    && job.type === "foreground"
    && job.result === null
    && job.message === null
    && job.startedAt !== null
    && metadata["nautilo.protectedTaskRunTerminal.v1"] === undefined
    && input.jobReference.inputObjectId === task.cryptoObjectId
    && exactProtectedTaskJobReference(job.input, input.jobReference);
  const expectedTaskParkedStatus = task.scheduleKind === "cron"
    ? "pending"
    : "awaiting";
  if (
    task.status === expectedTaskParkedStatus
    && run.status === "awaiting"
    && run.jobId === job.id
    && job.status === "completed"
  ) {
    if (
      !exactProtectedTask
      || !exactRunIdentity
      || !exactJobIdentity
      || !exactParkReceipt(existingReceipt, receipt)
      || job.completedAt?.getTime() !== input.parkedAt.getTime()
    ) return { status: "rejected", reason: "conflict" };
    return { status: "exact_replay" };
  }

  if (
    task.status !== (task.scheduleKind === "cron" ? "pending" : "running")
    || !exactProtectedTask
    || run.status !== "running"
    || !exactRunIdentity
    || !exactJobIdentity
    || job.status !== "running"
    || job.completedAt !== null
    || existingReceipt !== undefined
  ) return { status: "rejected", reason: "stale" };

  const [updatedJob] = await tx.update(jobs).set({
    status: "completed",
    completedAt: new Date(input.parkedAt.getTime()),
    metadata: {
      ...metadata,
      [PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY]: receipt,
    },
  }).where(and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    isNull(jobs.result),
    isNull(jobs.message),
    isNull(jobs.completedAt),
  )).returning();
  if (!updatedJob) throw new Error("Protected Task park CAS lost its Job");

  const [updatedRun] = await tx.update(taskRuns).set({
    status: "awaiting",
  }).where(and(
    eq(taskRuns.id, run.id),
    eq(taskRuns.taskId, task.id),
    eq(taskRuns.graphThreadId, input.graphThreadId),
    eq(taskRuns.jobId, job.id),
    eq(taskRuns.status, "running"),
    isNull(taskRuns.completedAt),
  )).returning();
  if (!updatedRun) throw new Error("Protected Task park CAS lost its TaskRun");

  if (task.scheduleKind !== "cron") {
    const [updatedTask] = await tx.update(tasks).set({
      status: "awaiting",
      updatedAt: new Date(input.parkedAt.getTime()),
    }).where(and(
      eq(tasks.id, task.id),
      eq(tasks.status, "running"),
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
    )).returning();
    if (!updatedTask) throw new Error("Protected Task park CAS lost its Task");
  }
  return { status: "parked" };
}

/**
 * Park one clean protected graph interruption after its encrypted checkpoint
 * is durable. The Job receipt contains only closed checkpoint coordinates; it
 * never stores interrupt arguments, reasons, replies, or a content digest.
 *
 * This transition shares Task -> TaskRun -> Job row-lock order with terminal
 * result publication, so exactly one outcome can win. A later continuation
 * may attach a fresh Job to this awaiting run after reopening the checkpoint.
 */
export async function parkProtectedTaskRun(
  db: DirectDatabase,
  input: ParkProtectedTaskRunInput,
): Promise<ParkProtectedTaskRunResult> {
  const receipt = prepareProtectedTaskParkReceipt(input);

  return db.transaction(async (tx) => {
    const locked = await lockProtectedTaskParkRows(tx, input);
    return locked.status === "rejected"
      ? locked
      : parkProtectedTaskRunWithLockedRows(tx, input, receipt, locked);
  });
}

type SealAndParkRejection = Extract<
  SealAndParkProtectedTaskRunResult,
  { status: "rejected" }
>;

class SealAndParkRollback extends Error {
  readonly rejection: SealAndParkRejection;

  constructor(rejection: SealAndParkRejection) {
    super("Protected Task seal-and-park transaction rejected");
    this.name = "SealAndParkRollback";
    this.rejection = rejection;
  }
}

function rollbackSealAndPark(rejection: SealAndParkRejection): never {
  throw new SealAndParkRollback(Object.freeze(rejection));
}

/**
 * Atomically seal one native pre-effect continuation and park its exact
 * protected TaskRun. Lifecycle rows are locked Task -> TaskRun -> Job before
 * transcript evidence is read or immutable receipts are inserted. Any staged
 * rejection aborts the transaction so a park cannot retain partial proof.
 */
export async function sealAndParkProtectedTaskRun(
  db: DirectDatabase,
  input: SealAndParkProtectedTaskRunInput,
): Promise<SealAndParkProtectedTaskRunResult> {
  const parkReceiptValue = prepareProtectedTaskParkReceipt(input.park);
  const park = Object.freeze({
    ...input.park,
    interrupts: parkReceiptValue.interrupts,
    parkedAt: new Date(input.park.parkedAt.getTime()),
    jobReference: Object.freeze({ ...input.park.jobReference }),
  });
  const segment = input.segment;
  if (segment.route !== "native_langgraph_v1"
    || segment.checkpoint.contract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(segment.checkpoint.expectedCheckpointCount)
    || segment.checkpoint.expectedCheckpointCount < 1) {
    throw new TypeError("Protected Task seal-and-park segment is malformed");
  }
  const segmentSnapshot = Object.freeze({
    route: segment.route,
    checkpoint: Object.freeze({
      ...segment.checkpoint,
      checkpointOrderedDigest:
        segment.checkpoint.checkpointOrderedDigest?.slice() ?? null,
      blobOrderedDigest: segment.checkpoint.blobOrderedDigest?.slice() ?? null,
      pendingWriteOrderedDigest:
        segment.checkpoint.pendingWriteOrderedDigest?.slice() ?? null,
    }),
  });
  const continuation = input.continuation;
  if (!isRecord(continuation)
    || continuation.kind !== "pre_effect_interrupt_v1"
    || continuation.reason !== "additional_authority"
    || !(continuation.requestDigest instanceof Uint8Array)
    || !(continuation.requiredAuthorityDigest instanceof Uint8Array)) {
    throw new TypeError("Protected Task seal-and-park continuation is malformed");
  }
  const continuationSnapshot = Object.freeze({
    kind: continuation.kind,
    reason: continuation.reason,
    effectDisposition: continuation.effectDisposition,
    interruptId: continuation.interruptId,
    operationId: continuation.operationId,
    requestDigest: continuation.requestDigest.slice(),
    requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
  });
  const interrupt = parkReceiptValue.interrupts.find(candidate =>
    candidate.id === continuationSnapshot.interruptId
  );
  if (interrupt === undefined || interrupt.kind !== "additional_authority") {
    throw new TypeError("Protected Task seal-and-park continuation is malformed");
  }

  try {
    return await db.transaction(async (tx) => {
      const locked = await lockProtectedTaskParkRows(tx, park);
      if (locked.status === "rejected") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "park",
          reason: locked.reason,
        });
      }

      const transcript = await readProtectedTaskTranscriptManifestInTx(tx, {
        taskId: park.taskId,
        taskRunId: park.taskRunId,
        graphThreadId: park.graphThreadId,
      });
      const segmentResult = await sealProtectedTaskExecutionSegmentReceiptInTx(
        tx,
        {
          ...segmentSnapshot,
          taskId: park.taskId,
          taskRunId: park.taskRunId,
          jobId: park.jobId,
          executionSegment: park.executionSegment,
          transcript,
          sealedAt: new Date(park.parkedAt.getTime()),
        },
      );
      if (segmentResult.status === "rejected") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "segment",
          reason: segmentResult.reason,
        });
      }

      const continuationResult = await sealProtectedTaskContinuationReceiptInTx(
        tx,
        {
          ...continuationSnapshot,
          taskId: park.taskId,
          taskRunId: park.taskRunId,
          jobId: park.jobId,
          executionSegment: park.executionSegment,
          sealedAt: new Date(park.parkedAt.getTime()),
        },
      );
      if (continuationResult.status === "rejected") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "continuation",
          reason: continuationResult.reason,
        });
      }

      const parkResult = await parkProtectedTaskRunWithLockedRows(
        tx,
        park,
        parkReceiptValue,
        locked,
      );
      if (parkResult.status === "rejected") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "park",
          reason: parkResult.reason,
        });
      }
      if (parkResult.status === "exact_replay"
        && (segmentResult.status !== "exact_replay"
          || continuationResult.status !== "exact_replay")) {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "park",
          reason: "conflict",
        });
      }
      return Object.freeze({ status: parkResult.status });
    });
  } catch (error) {
    if (error instanceof SealAndParkRollback) return error.rejection;
    throw error;
  }
}

type PublishedProtectedTaskReplyMessage = Readonly<{
  operationId: string;
  operationSessionId: string;
  operationRoomId: string;
  operationMessageId: number;
  operationNamespaceId: string;
  operationCryptoObjectId: string;
  terminalAt: Date | null;
  roomId: string | null;
  sessionId: string;
  messageId: number;
  editRevision: number;
  cryptoObjectId: string | null;
  namespaceId: string;
  sourceUserId: string;
  role: string;
  createdAt: Date;
  lifecycleNamespaceId: string;
  lifecycleRoomId: string;
  lifecycleCryptoObjectId: string;
  lifecycleOperationId: string | null;
  lifecycleKeyClass: string;
  lifecycleAuthorRole: string;
  lifecyclePayloadVersion: number;
  lifecycleCompletion: string;
  lifecycleDisposition: string;
}>;

function publishedProtectedTaskReplyReference(
  row: PublishedProtectedTaskReplyMessage,
  operationId: string,
  messageId: number,
): Readonly<{
  acceptedAt: Date;
  message: ProtectedTaskAwaitReplyMessageReference;
}> | null {
  if (
    row.operationId !== operationId
    || row.operationMessageId !== messageId
    || row.messageId !== messageId
    || row.operationSessionId !== row.sessionId
    || row.operationRoomId !== row.roomId
    || row.operationNamespaceId !== row.namespaceId
    || row.operationCryptoObjectId !== row.cryptoObjectId
    || row.lifecycleOperationId !== operationId
    || row.lifecycleNamespaceId !== row.namespaceId
    || row.lifecycleRoomId !== row.roomId
    || row.lifecycleCryptoObjectId !== row.cryptoObjectId
    || row.lifecycleKeyClass !== "ai"
    || row.lifecycleAuthorRole !== "user"
    || row.lifecyclePayloadVersion !== 2
    || row.lifecycleCompletion !== "complete"
    || row.lifecycleDisposition !== "mapped"
    || row.role !== "user"
    || row.roomId === null
    || row.cryptoObjectId === null
    || !CANONICAL_UUID.test(row.roomId)
    || !CANONICAL_UUID.test(row.sessionId)
    || !CANONICAL_UUID.test(row.namespaceId)
    || !CANONICAL_UUID.test(row.sourceUserId)
    || !Number.isSafeInteger(row.messageId)
    || row.messageId < 1
    || !Number.isSafeInteger(row.editRevision)
    || row.editRevision < 0
    || !opaqueCheckpointCoordinate(row.cryptoObjectId)
    || !(row.terminalAt instanceof Date)
    || !Number.isFinite(row.terminalAt.getTime())
    || !(row.createdAt instanceof Date)
    || !Number.isFinite(row.createdAt.getTime())
    || row.terminalAt.getTime() < row.createdAt.getTime()
  ) return null;
  return Object.freeze({
    acceptedAt: new Date(row.terminalAt.getTime()),
    message: Object.freeze({
      roomId: row.roomId,
      sessionId: row.sessionId,
      messageId: String(row.messageId),
      editRevision: row.editRevision,
      cryptoObjectId: row.cryptoObjectId,
      namespaceId: row.namespaceId,
      sourceUserId: row.sourceUserId,
    }),
  });
}

function parkedProtectedTaskAwaitReplyInput(
  row: Readonly<{ task: Task; run: TaskRun; job: Job }>,
  publication: Readonly<{
    operationId: string;
    acceptedAt: Date;
    message: ProtectedTaskAwaitReplyMessageReference;
  }>,
): AcceptProtectedTaskAwaitReplyInput | null {
  const { task, run, job } = row;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const rawReceipt = metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY];
  if (!isRecord(rawReceipt)) return null;
  const parkedAtText = rawReceipt["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  if (
    Object.keys(rawReceipt).sort().join(",")
      !== "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,taskId,taskRunId,version"
    || rawReceipt["version"] !== 1
    || !Number.isSafeInteger(rawReceipt["generation"])
    || (rawReceipt["generation"] as number) < 0
    || !Number.isSafeInteger(rawReceipt["executionSegment"])
    || (rawReceipt["executionSegment"] as number) < 1
    || rawReceipt["executionSegment"] === Number.MAX_SAFE_INTEGER
    || !Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || publication.acceptedAt.getTime() < parkedAt.getTime()
  ) return null;

  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      rawReceipt["interrupts"] as readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  const awaitReply = interrupts.filter((interrupt) =>
    interrupt.kind === "await_reply" && interrupt.requestId === undefined
  );
  if (awaitReply.length !== 1) return null;

  const reference = job.input as ProtectedTaskDurableJobReference;
  const receipt: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawReceipt["generation"] as number,
    executionSegment: rawReceipt["executionSegment"] as number,
    interrupts,
    parkedAt: parkedAt.toISOString(),
  });
  const expectedTaskStatus = task.scheduleKind === "cron" ? "pending" : "awaiting";
  if (
    task.status !== expectedTaskStatus
    || (task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected")
    || task.cryptoMappingState !== "verified"
    || task.targetRoomId !== publication.message.roomId
    || (task.requestorId !== publication.message.sourceUserId
      && !task.targetUserIds.includes(publication.message.sourceUserId))
    || run.status !== "awaiting"
    || run.taskId !== task.id
    || run.jobId !== job.id
    || !pristineProtectedTaskRun(run)
    || job.status !== "completed"
    || job.completedAt?.getTime() !== parkedAt.getTime()
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.result !== null
    || job.message !== null
    || job.startedAt === null
    || metadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] !== undefined
    || !exactProtectedTaskJobReference(job.input, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.executionSegment !== receipt.executionSegment
    || !exactParkReceipt(rawReceipt, receipt)
  ) return null;

  return Object.freeze({
    taskId: task.id,
    taskRunId: run.id,
    graphThreadId: run.graphThreadId,
    priorJobId: job.id,
    generation: receipt.generation,
    executionSegment: receipt.executionSegment,
    interrupts,
    parkedAt,
    priorJobReference: Object.freeze({ ...reference }),
    acceptance: Object.freeze({
      acceptanceId: publication.operationId,
      interruptId: awaitReply[0]!.id,
      message: publication.message,
      acceptedAt: publication.acceptedAt,
    }),
  });
}

/**
 * Resolve one published AI-readable Human Message to the exact parked
 * protected Task interruption it may satisfy. This is discovery only: it
 * returns content-free coordinates for `acceptProtectedTaskAwaitReply` and
 * never advances the Task or opens protected bytes.
 */
export async function resolvePublishedProtectedTaskAwaitReply(
  db: DirectDatabase,
  input: Readonly<{ operationId: string; messageId: number }>,
): Promise<ResolvePublishedProtectedTaskAwaitReplyResult> {
  if (
    !opaqueCheckpointCoordinate(input.operationId)
    || !Number.isSafeInteger(input.messageId)
    || input.messageId < 1
  ) return { status: "no_match" };

  const [published] = await db.select({
    operationId: conversationSharedAgentShadowOperations.operationId,
    operationSessionId: conversationSharedAgentShadowOperations.sessionId,
    operationRoomId: conversationSharedAgentShadowOperations.roomId,
    operationMessageId:
      conversationSharedAgentShadowOperations.humanMessageId,
    operationNamespaceId: conversationSharedAgentShadowOperations.namespaceId,
    operationCryptoObjectId:
      conversationSharedAgentShadowOperations.cryptoObjectId,
    terminalAt: conversationSharedAgentShadowOperations.terminalAt,
    roomId: sessions.roomId,
    sessionId: sessionMessages.sessionId,
    messageId: sessionMessages.id,
    editRevision: sessionMessages.editRevision,
    cryptoObjectId: sessionMessages.cryptoObjectId,
    namespaceId: rooms.namespaceId,
    sourceUserId: sessions.ownerId,
    role: sessionMessages.role,
    createdAt: sessionMessages.createdAt,
    lifecycleNamespaceId:
      sessionMessageCryptoRevisions.namespaceIdAtAllocation,
    lifecycleRoomId: sessionMessageCryptoRevisions.roomId,
    lifecycleCryptoObjectId: sessionMessageCryptoRevisions.cryptoObjectId,
    lifecycleOperationId:
      sessionMessageCryptoRevisions.sharedAgentShadowOperationId,
    lifecycleKeyClass: sessionMessageCryptoRevisions.keyClass,
    lifecycleAuthorRole: sessionMessageCryptoRevisions.authorRole,
    lifecyclePayloadVersion: sessionMessageCryptoRevisions.payloadVersion,
    lifecycleCompletion: sessionMessageCryptoRevisions.completion,
    lifecycleDisposition: sessionMessageCryptoRevisions.disposition,
  }).from(conversationSharedAgentShadowOperations)
    .innerJoin(sessionMessages, and(
      eq(sessionMessages.sessionId,
        conversationSharedAgentShadowOperations.sessionId),
      eq(sessionMessages.id,
        conversationSharedAgentShadowOperations.humanMessageId),
    ))
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .innerJoin(rooms, eq(rooms.id, sessions.roomId))
    .innerJoin(sessionMessageCryptoRevisions, and(
      eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
      eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
      eq(sessionMessageCryptoRevisions.editRevision,
        sessionMessages.editRevision),
    ))
    .where(and(
      eq(conversationSharedAgentShadowOperations.operationId,
        input.operationId),
      eq(conversationSharedAgentShadowOperations.humanMessageId,
        input.messageId),
      eq(conversationSharedAgentShadowOperations.state, "published"),
      isNotNull(conversationSharedAgentShadowOperations.terminalAt),
    )).limit(1);
  if (!published) return { status: "no_match" };
  const publication = publishedProtectedTaskReplyReference(
    published,
    input.operationId,
    input.messageId,
  );
  if (publication === null) return { status: "no_match" };

  // The broad status query also finds parked Tasks with unrelated interrupts.
  // Page through it until two *validated* park receipts are found; counting
  // rows before receipt validation would reject an otherwise unique reply.
  const pageSize = 64;
  let afterRunId: string | null = null;
  let resolved: AcceptProtectedTaskAwaitReplyInput | null = null;
  while (true) {
    const candidates = await db.select({ task: tasks, run: taskRuns, job: jobs })
      .from(tasks)
      .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
      .where(and(
        eq(tasks.targetRoomId, publication.message.roomId),
        inArray(tasks.contentRepresentation, ["dual", "protected"]),
        eq(tasks.cryptoMappingState, "verified"),
        or(
          and(eq(tasks.scheduleKind, "cron"), eq(tasks.status, "pending")),
          and(
            inArray(tasks.scheduleKind, ["now", "one_shot"]),
            eq(tasks.status, "awaiting"),
          ),
        ),
        eq(taskRuns.status, "awaiting"),
        eq(jobs.status, "completed"),
        or(
          eq(tasks.requestorId, publication.message.sourceUserId),
          arrayContains(tasks.targetUserIds, [publication.message.sourceUserId]),
        ),
        afterRunId === null ? undefined : gt(taskRuns.id, afterRunId),
      ))
      .orderBy(asc(taskRuns.id))
      .limit(pageSize);
    for (const candidate of candidates) {
      const match = parkedProtectedTaskAwaitReplyInput(candidate, {
        operationId: input.operationId,
        ...publication,
      });
      if (match === null) continue;
      if (resolved !== null) return { status: "ambiguous" };
      resolved = match;
    }
    if (candidates.length < pageSize) break;
    afterRunId = candidates[candidates.length - 1]!.run.id;
  }
  return resolved === null
    ? { status: "no_match" }
    : { status: "resolved", input: resolved };
}

/**
 * Accept one exact protected Human reply for a durably parked await-reply
 * interrupt. The completed Job retains only immutable Message coordinates;
 * ciphertext and plaintext stay in their canonical stores. A retry with the
 * same receipt is idempotent, while a second reply for the same parked Job is
 * a conflict.
 */
export async function acceptProtectedTaskAwaitReply(
  db: DirectDatabase,
  input: AcceptProtectedTaskAwaitReplyInput,
): Promise<AcceptProtectedTaskAwaitReplyResult> {
  const reference = input.priorJobReference;
  if (
    !input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.priorJobId
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0
    || !Number.isSafeInteger(input.executionSegment)
    || input.executionSegment < 1
    || !(input.parkedAt instanceof Date)
    || !Number.isFinite(input.parkedAt.getTime())
    || reference === null
    || typeof reference !== "object"
    || Array.isArray(reference)
    || reference.kind !== "protected_task_run_v1"
    || reference.taskId !== input.taskId
    || reference.taskRunId !== input.taskRunId
    || !reference.inputObjectId
    || reference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !reference.authorizationRequestId
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || reference.executionSegment !== input.executionSegment
    || !exactProtectedTaskJobReference(reference, reference)
  ) {
    throw new TypeError("Protected Task await-reply acceptance is malformed");
  }
  const receipt = awaitReplyAcceptanceReceipt(input);
  const park = parkReceipt({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    jobId: input.priorJobId,
    generation: input.generation,
    executionSegment: input.executionSegment,
    interrupts: input.interrupts,
    parkedAt: input.parkedAt,
    jobReference: reference,
  });
  const messageId = Number(receipt.message.messageId);

  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return { status: "rejected", reason: "not_found" } as const;

    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, task.id),
    )).limit(1).for("update");
    if (!run) return { status: "rejected", reason: "not_found" } as const;

    const [priorJob] = await tx.select().from(jobs)
      .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
    if (!priorJob) {
      return { status: "rejected", reason: "not_found" } as const;
    }

    const metadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    const existing = metadata[PROTECTED_TASK_AWAIT_REPLY_ACCEPTANCE_METADATA_KEY];
    const exactProtectedTask = (
      task.contentRepresentation === "dual"
        || task.contentRepresentation === "protected"
    )
      && task.contentNamespaceId !== null
      && task.contentRevision > 0
      && task.cryptoObjectId === reference.inputObjectId
      && task.cryptoAccessRevision >= 0
      && task.cryptoRequiredNamespaceFingerprint !== null
      && task.cryptoRequiredNamespaceFingerprint.length === 32
      && task.cryptoMappingState === "verified"
      && task.lastError === null
      && task.targetRoomId === receipt.message.roomId
      && (
        task.requestorId === receipt.message.sourceUserId
        || task.targetUserIds.includes(receipt.message.sourceUserId)
      )
      && (task.contentRepresentation !== "protected" || (
        task.prompt === ""
        && task.expectedOutput === null
      ));
    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    const exactRun = run.graphThreadId === input.graphThreadId
      && run.status === "awaiting"
      && run.jobId === priorJob.id
      && pristineProtectedTaskRun(run);
    const exactPriorJob = priorJob.ownerId === task.requestorId
      && priorJob.requestorId === task.requestorId
      && priorJob.laneKey === `task:${task.id}`
      && priorJob.type === "foreground"
      && priorJob.status === "completed"
      && priorJob.result === null
      && priorJob.message === null
      && priorJob.startedAt !== null
      && priorJob.completedAt?.getTime() === input.parkedAt.getTime()
      && metadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] === undefined
      && exactProtectedTaskJobReference(priorJob.input, reference);
    if (!exactParkReceipt(
      metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
      park,
    )) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (
      task.status !== expectedTaskStatus
      || !exactProtectedTask
      || !exactRun
      || !exactPriorJob
    ) {
      return { status: "rejected", reason: "stale" } as const;
    }
    if (existing !== undefined) {
      return exactAwaitReplyAcceptanceReceipt(existing, receipt)
        ? { status: "exact_replay" } as const
        : { status: "rejected", reason: "conflict" } as const;
    }

    const [message] = await tx.select({
      roomId: sessions.roomId,
      sessionId: sessionMessages.sessionId,
      messageId: sessionMessages.id,
      editRevision: sessionMessages.editRevision,
      cryptoObjectId: sessionMessages.cryptoObjectId,
      namespaceId: rooms.namespaceId,
      sourceUserId: sessions.ownerId,
      role: sessionMessages.role,
      createdAt: sessionMessages.createdAt,
      lifecycleNamespaceId:
        sessionMessageCryptoRevisions.namespaceIdAtAllocation,
      lifecycleRoomId: sessionMessageCryptoRevisions.roomId,
      lifecycleCryptoObjectId: sessionMessageCryptoRevisions.cryptoObjectId,
      lifecycleKeyClass: sessionMessageCryptoRevisions.keyClass,
      lifecycleAuthorRole: sessionMessageCryptoRevisions.authorRole,
      lifecyclePayloadVersion: sessionMessageCryptoRevisions.payloadVersion,
      lifecycleCompletion: sessionMessageCryptoRevisions.completion,
      lifecycleDisposition: sessionMessageCryptoRevisions.disposition,
    }).from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .innerJoin(sessionMessageCryptoRevisions, and(
        eq(sessionMessageCryptoRevisions.sessionId, sessionMessages.sessionId),
        eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
        eq(
          sessionMessageCryptoRevisions.editRevision,
          sessionMessages.editRevision,
        ),
      )).where(and(
        eq(sessionMessages.id, messageId),
        eq(sessionMessages.sessionId, receipt.message.sessionId),
      )).limit(1).for("share");
    if (!message) {
      return { status: "rejected", reason: "not_found" } as const;
    }
    if (
      message.roomId !== receipt.message.roomId
      || message.sessionId !== receipt.message.sessionId
      || String(message.messageId) !== receipt.message.messageId
      || message.editRevision !== receipt.message.editRevision
      || message.cryptoObjectId !== receipt.message.cryptoObjectId
      || message.namespaceId !== receipt.message.namespaceId
      || message.sourceUserId !== receipt.message.sourceUserId
      || message.role !== "user"
      || message.createdAt.getTime() < input.parkedAt.getTime()
      || input.acceptance.acceptedAt.getTime() < message.createdAt.getTime()
      || message.lifecycleNamespaceId !== receipt.message.namespaceId
      || message.lifecycleRoomId !== receipt.message.roomId
      || message.lifecycleCryptoObjectId !== receipt.message.cryptoObjectId
      || message.lifecycleKeyClass !== "ai"
      || message.lifecycleAuthorRole !== "user"
      || message.lifecyclePayloadVersion !== 2
      || message.lifecycleCompletion !== "complete"
      || message.lifecycleDisposition !== "mapped"
    ) {
      return { status: "rejected", reason: "stale" } as const;
    }

    const [updatedJob] = await tx.update(jobs).set({
      metadata: {
        ...metadata,
        [PROTECTED_TASK_AWAIT_REPLY_ACCEPTANCE_METADATA_KEY]: receipt,
      },
    }).where(and(
      eq(jobs.id, priorJob.id),
      eq(jobs.status, "completed"),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning();
    if (!updatedJob) {
      throw new Error("Protected Task await-reply acceptance lost its Job");
    }
    return { status: "accepted" } as const;
  });
}

/**
 * Advance one durably parked protected TaskRun to a fresh execution segment.
 * The old Job and its exact park receipt remain the immutable hand-off proof;
 * the replacement Job was persisted separately and stays queued for its
 * in-memory executor. This operation does not create a grant or make an
 * awaiting run eligible on its own.
 */
export async function startParkedProtectedTaskRunSegment(
  db: DirectDatabase,
  input: StartParkedProtectedTaskRunSegmentInput,
): Promise<StartParkedProtectedTaskRunSegmentResult> {
  const priorReference = input.priorJobReference;
  const nextReference = input.jobReference;
  if (
    !input.taskId
    || !input.taskRunId
    || !input.graphThreadId
    || !input.priorJobId
    || !input.jobId
    || input.priorJobId === input.jobId
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0
    || !(input.parkedAt instanceof Date)
    || !Number.isFinite(input.parkedAt.getTime())
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
    || input.acceptance === null
    || typeof input.acceptance !== "object"
    || Array.isArray(input.acceptance)
    || priorReference === null
    || typeof priorReference !== "object"
    || Array.isArray(priorReference)
    || nextReference === null
    || typeof nextReference !== "object"
    || Array.isArray(nextReference)
    || priorReference.kind !== "protected_task_run_v1"
    || nextReference.kind !== "protected_task_run_v1"
    || !exactProtectedTaskJobReference(priorReference, priorReference)
    || !exactProtectedTaskJobReference(nextReference, nextReference)
    || priorReference.taskId !== input.taskId
    || priorReference.taskRunId !== input.taskRunId
    || priorReference.inputObjectId !== input.cryptoObjectId
    || priorReference.resultObjectId
      !== protectedTaskRunResultObjectId(input.taskId, input.taskRunId)
    || !priorReference.authorizationRequestId
    || !Number.isSafeInteger(priorReference.policyRevision)
    || priorReference.policyRevision < 1
    || !Number.isSafeInteger(priorReference.executionSegment)
    || priorReference.executionSegment < 1
    || nextReference.taskId !== priorReference.taskId
    || nextReference.taskRunId !== priorReference.taskRunId
    || nextReference.inputObjectId !== priorReference.inputObjectId
    || nextReference.resultObjectId !== priorReference.resultObjectId
    || nextReference.policyRevision !== priorReference.policyRevision
    || !Number.isSafeInteger(nextReference.executionSegment)
    || nextReference.executionSegment !== priorReference.executionSegment + 1
    || !nextReference.authorizationRequestId
    || nextReference.authorizationRequestId === priorReference.authorizationRequestId
    || nextReference.resumeAcceptanceId !== input.acceptance.acceptanceId
    || nextReference.resumeAcceptanceId === priorReference.resumeAcceptanceId
  ) {
    throw new TypeError("Protected Task parked segment binding is malformed");
  }
  const receipt = parkReceipt({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    jobId: input.priorJobId,
    generation: input.generation,
    executionSegment: priorReference.executionSegment,
    interrupts: input.interrupts,
    parkedAt: input.parkedAt,
    jobReference: priorReference,
  });
  const acceptanceReceipt = awaitReplyAcceptanceReceipt({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    priorJobId: input.priorJobId,
    generation: input.generation,
    executionSegment: priorReference.executionSegment,
    interrupts: input.interrupts,
    parkedAt: input.parkedAt,
    acceptance: input.acceptance,
  });

  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return { status: "rejected", reason: "not_found" } as const;

    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, task.id),
    )).limit(1).for("update");
    if (!run) return { status: "rejected", reason: "not_found" } as const;

    const [priorJob] = await tx.select().from(jobs)
      .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
    if (!priorJob) return { status: "rejected", reason: "not_found" } as const;

    const [nextJob] = await tx.select().from(jobs)
      .where(eq(jobs.id, input.jobId)).limit(1).for("update");
    if (!nextJob) return { status: "rejected", reason: "not_found" } as const;

    const priorMetadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    const nextMetadata = isRecord(nextJob.metadata) ? nextJob.metadata : {};
    const exactProtectedTask = (
      task.contentRepresentation === input.contentRepresentation
      && task.contentNamespaceId === input.contentNamespaceId
      && task.contentRevision === input.contentRevision
      && task.cryptoObjectId === input.cryptoObjectId
      && task.cryptoAccessRevision === input.cryptoAccessRevision
      && task.cryptoRequiredNamespaceFingerprint !== null
      && sameBytes(
        task.cryptoRequiredNamespaceFingerprint,
        input.cryptoRequiredNamespaceFingerprint,
      )
      && task.cryptoMappingState === "verified"
      && task.lastError === null
      && task.targetRoomId === acceptanceReceipt.message.roomId
      && (
        task.requestorId === acceptanceReceipt.message.sourceUserId
        || task.targetUserIds.includes(acceptanceReceipt.message.sourceUserId)
      )
      && (task.contentRepresentation !== "protected" || (
        task.prompt === ""
        && task.expectedOutput === null
      ))
    );
    const exactRun = run.graphThreadId === input.graphThreadId
      && pristineProtectedTaskRun(run);
    const exactPriorJob = priorJob.ownerId === task.requestorId
      && priorJob.requestorId === task.requestorId
      && priorJob.laneKey === `task:${task.id}`
      && priorJob.type === "foreground"
      && priorJob.status === "completed"
      && priorJob.result === null
      && priorJob.message === null
      && priorJob.startedAt !== null
      && priorJob.completedAt?.getTime() === input.parkedAt.getTime()
      && priorMetadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] === undefined
      && exactProtectedTaskJobReference(priorJob.input, priorReference);
    const exactPriorReceipt = exactParkReceipt(
      priorMetadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
      receipt,
    );
    const existingAcceptance =
      priorMetadata[PROTECTED_TASK_AWAIT_REPLY_ACCEPTANCE_METADATA_KEY];
    const exactUnconsumedAcceptance = exactAwaitReplyAcceptanceReceipt(
      existingAcceptance,
      acceptanceReceipt,
    );
    const exactConsumedAcceptance = exactAwaitReplyAcceptanceReceipt(
      existingAcceptance,
      acceptanceReceipt,
      nextJob.id,
    );
    const exactNextJobIdentity = nextJob.ownerId === task.requestorId
      && nextJob.requestorId === task.requestorId
      && nextJob.laneKey === `task:${task.id}`
      && nextJob.type === "foreground"
      && nextJob.result === null
      && nextJob.message === null
      && nextJob.completedAt === null
      && Object.keys(nextMetadata).length === 0
      && exactProtectedTaskJobReference(nextJob.input, nextReference);
    const nextJobIsPristineQueued = nextJob.status === "queued"
      && nextJob.startedAt === null;
    const nextJobIsLiveRunning = nextJob.status === "running"
      && nextJob.startedAt !== null;
    if (!exactPriorReceipt) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (!exactUnconsumedAcceptance && !exactConsumedAcceptance) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (!exactProtectedTask || !exactRun || !exactPriorJob || !exactNextJobIdentity) {
      return { status: "rejected", reason: "stale" } as const;
    }

    const expectedParkedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    const expectedRunningTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "running";
    if (
      task.status === expectedRunningTaskStatus
      && run.status === "running"
      && run.jobId === nextJob.id
      && (nextJobIsPristineQueued || nextJobIsLiveRunning)
      && exactConsumedAcceptance
    ) {
      return { status: "exact_replay" } as const;
    }
    if (
      task.status !== expectedParkedTaskStatus
      || run.status !== "awaiting"
      || run.jobId !== priorJob.id
      || !nextJobIsPristineQueued
      || !exactUnconsumedAcceptance
    ) {
      return { status: "rejected", reason: "stale" } as const;
    }

    const [updatedPriorJob] = await tx.update(jobs).set({
      metadata: {
        ...priorMetadata,
        [PROTECTED_TASK_AWAIT_REPLY_ACCEPTANCE_METADATA_KEY]: {
          ...acceptanceReceipt,
          consumedByJobId: nextJob.id,
        },
      },
    }).where(and(
      eq(jobs.id, priorJob.id),
      eq(jobs.status, "completed"),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning();
    if (!updatedPriorJob) {
      throw new Error("Protected Task parked segment CAS lost its acceptance");
    }

    const [updatedRun] = await tx.update(taskRuns).set({
      status: "running",
      jobId: nextJob.id,
    }).where(and(
      eq(taskRuns.id, run.id),
      eq(taskRuns.taskId, task.id),
      eq(taskRuns.graphThreadId, input.graphThreadId),
      eq(taskRuns.status, "awaiting"),
      eq(taskRuns.jobId, priorJob.id),
      isNull(taskRuns.completedAt),
    )).returning();
    if (!updatedRun) {
      throw new Error("Protected Task parked segment CAS lost its TaskRun");
    }

    if (task.scheduleKind !== "cron") {
      const [updatedTask] = await tx.update(tasks).set({
        status: "running",
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "awaiting"),
        inArray(tasks.contentRepresentation, ["dual", "protected"]),
      )).returning();
      if (!updatedTask) {
        throw new Error("Protected Task parked segment CAS lost its Task");
      }
    }
    return { status: "started" } as const;
  });
}

const TASK_RUN_RESULT_OBJECT_ID = /^task-run-result:v1:[0-9a-f]{64}$/u;
const TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1 = 1024 * 1024;

export type ProtectedTaskRunTerminalOutcome = "completed" | "errored";

type TaskRunTerminalInputCommon = Readonly<{
  taskId: string;
  taskRunId: string;
  scheduleKind: "now" | "one_shot" | "cron";
  operationId: string;
  requestDigest: Uint8Array;
  resultObjectId: string;
  resultRevision: 1;
  outcome: ProtectedTaskRunTerminalOutcome;
  completedAt: Date;
  requiredRunStatus: "running";
}>;

export type ProtectedTaskRunTerminalInput = TaskRunTerminalInputCommon &
  Readonly<{
    /** Full-only; this operation never accepts or writes plaintext. */
    resultRepresentation: "protected";
  }>;

export type DualTaskRunResultPayloadV1 = Readonly<{
  formatVersion: 1;
  resultText: string | null;
  lastError: string | null;
}>;

export type DualTaskRunTerminalInput = TaskRunTerminalInputCommon & Readonly<{
  resultRepresentation: "dual";
  ordinaryResult: DualTaskRunResultPayloadV1;
}>;

type TaskRunTerminalInput =
  | ProtectedTaskRunTerminalInput
  | DualTaskRunTerminalInput;

export type ProtectedTaskRunTerminalResult =
  | Readonly<{ status: "transitioned" | "exact_replay" }>
  | Readonly<{
      status: "rejected";
      reason:
        | "authority_changed"
        | "conflict"
        | "not_found"
        | "not_running"
        | "run_terminal"
        | "task_terminal";
    }>;

type ProtectedTaskRunTerminalReceipt = Readonly<{
  version: 1;
  taskId: string;
  taskRunId: string;
  operationId: string;
  requestDigest: string;
  resultObjectId: string;
  resultRevision: 1;
  resultRepresentation: "protected" | "dual";
  outcome: ProtectedTaskRunTerminalOutcome;
  completedAt: string;
}>;

function terminalRejected(
  reason: Extract<ProtectedTaskRunTerminalResult, { status: "rejected" }>["reason"],
): ProtectedTaskRunTerminalResult {
  return Object.freeze({ status: "rejected" as const, reason });
}

function terminalRequestDigestHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function terminalReceipt(
  input: TaskRunTerminalInput,
): ProtectedTaskRunTerminalReceipt {
  return Object.freeze({
    version: 1,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    operationId: input.operationId,
    requestDigest: terminalRequestDigestHex(input.requestDigest),
    resultObjectId: input.resultObjectId,
    resultRevision: input.resultRevision,
    resultRepresentation: input.resultRepresentation,
    outcome: input.outcome,
    completedAt: input.completedAt.toISOString(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactTerminalReceipt(
  value: unknown,
  expected: ProtectedTaskRunTerminalReceipt,
): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).sort().join(",")
      !== "completedAt,operationId,outcome,requestDigest,resultObjectId,resultRepresentation,resultRevision,taskId,taskRunId,version"
  ) return false;
  return value["version"] === expected.version
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["operationId"] === expected.operationId
    && value["requestDigest"] === expected.requestDigest
    && value["resultObjectId"] === expected.resultObjectId
    && value["resultRevision"] === expected.resultRevision
    && value["resultRepresentation"] === expected.resultRepresentation
    && value["outcome"] === expected.outcome
    && value["completedAt"] === expected.completedAt;
}

function assertProtectedTaskRunTerminalInput(
  input: ProtectedTaskRunTerminalInput,
): void {
  assertTaskRunTerminalInput(input);
  if (input.resultRepresentation !== "protected") {
    throw new TypeError("Protected Task result terminal binding is malformed");
  }
}

function assertTaskRunTerminalInput(
  input: TaskRunTerminalInput,
): void {
  if (
    !input.taskId
    || !input.taskRunId
    || input.operationId !== `task-run-result:${input.taskRunId}`
    || !(input.requestDigest instanceof Uint8Array)
    || input.requestDigest.length !== 32
    || !TASK_RUN_RESULT_OBJECT_ID.test(input.resultObjectId)
    || input.resultRevision !== 1
    || input.resultRepresentation !== "protected"
      && input.resultRepresentation !== "dual"
    || input.outcome !== "completed" && input.outcome !== "errored"
    || input.scheduleKind !== "now"
      && input.scheduleKind !== "one_shot"
      && input.scheduleKind !== "cron"
    || !(input.completedAt instanceof Date)
    || !Number.isFinite(input.completedAt.getTime())
    || input.requiredRunStatus !== "running"
  ) throw new TypeError("Protected Task result terminal binding is malformed");
}

function assertWellFormedTaskResultText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Dual Task result contains malformed Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Dual Task result contains malformed Unicode");
    }
  }
}

function canonicalDualTaskRunResult(
  value: DualTaskRunResultPayloadV1,
): DualTaskRunResultPayloadV1 {
  if (!isRecord(value)) {
    throw new TypeError("Dual Task result payload must be an object");
  }
  const fields = ["formatVersion", "resultText", "lastError"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) {
    throw new TypeError("Dual Task result payload has an invalid field set");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string"
      || !fields.includes(key)
      || descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) throw new TypeError("Dual Task result payload has an invalid field set");
  }
  if (
    value["formatVersion"] !== 1
    || value["resultText"] !== null && typeof value["resultText"] !== "string"
    || value["lastError"] !== null && typeof value["lastError"] !== "string"
    || value["resultText"] === null && value["lastError"] === null
  ) throw new TypeError("Dual Task result payload is invalid");
  if (value["resultText"] !== null) {
    assertWellFormedTaskResultText(value["resultText"]);
  }
  if (value["lastError"] !== null) {
    assertWellFormedTaskResultText(value["lastError"]);
  }
  const canonical = `{"formatVersion":1,` +
    `"resultText":${JSON.stringify(value["resultText"])},` +
    `"lastError":${JSON.stringify(value["lastError"])}}`;
  if (new TextEncoder().encode(canonical).length
    > TASK_RUN_RESULT_PAYLOAD_MAX_WIRE_BYTES_V1) {
    throw new RangeError("Dual Task result payload exceeds its wire limit");
  }
  return Object.freeze({
    formatVersion: 1,
    resultText: value["resultText"],
    lastError: value["lastError"],
  });
}

function exactTaskDefinition(
  task: Task,
  revision: TaskDefinitionCryptoRevision | undefined,
  representation: "protected" | "dual",
): boolean {
  return task.contentRepresentation === representation
    && task.contentNamespaceId !== null
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified"
    && task.lastError === null
    && (representation !== "protected" || (
      task.prompt === "" && task.expectedOutput === null
    ))
    && revision !== undefined
    && revision.taskId === task.id
    && revision.contentNamespaceId === task.contentNamespaceId
    && revision.contentRevision === task.contentRevision
    && revision.cryptoObjectId === task.cryptoObjectId
    && revision.representation === representation
    && revision.payloadVersion === 1
    && revision.cryptoAccessRevision === task.cryptoAccessRevision
    && sameBytes(
      revision.requiredNamespaceFingerprint,
      task.cryptoRequiredNamespaceFingerprint,
    )
    && revision.completion === "complete"
    && revision.disposition === "mapped"
    && revision.failureCode === null;
}

function protectedTaskJobPolicyRevision(
  task: Task,
  run: TaskRun,
  job: Job | undefined,
  input: TaskRunTerminalInput,
): number | null {
  const executionSegment = isRecord(job?.input)
    ? job.input["executionSegment"]
    : undefined;
  const resumeAcceptanceId = isRecord(job?.input)
    ? job.input["resumeAcceptanceId"]
    : undefined;
  const expectedKeys = executionSegment === 1
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId";
  if (
    job === undefined
    || job.id !== run.jobId
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.result !== null
    || job.message !== null
    || !isRecord(job.input)
    || Object.keys(job.input).sort().join(",")
      !== expectedKeys
    || job.input["kind"] !== "protected_task_run_v1"
    || job.input["taskId"] !== input.taskId
    || job.input["taskRunId"] !== input.taskRunId
    || job.input["inputObjectId"] !== task.cryptoObjectId
    || job.input["resultObjectId"] !== input.resultObjectId
    || typeof job.input["authorizationRequestId"] !== "string"
    || job.input["authorizationRequestId"].length === 0
    || !Number.isSafeInteger(job.input["policyRevision"])
    || (job.input["policyRevision"] as number) < 1
    || !Number.isSafeInteger(executionSegment)
    || (executionSegment as number) < 1
    || (executionSegment === 1
      ? resumeAcceptanceId !== undefined
      : !opaqueCheckpointCoordinate(resumeAcceptanceId))
  ) return null;
  return job.input["policyRevision"] as number;
}

function exactResultReservation(
  task: Task,
  revision: TaskRunResultCryptoRevision | undefined,
  input: TaskRunTerminalInput,
): boolean {
  return revision !== undefined
    && revision.taskId === input.taskId
    && revision.taskRunId === input.taskRunId
    && revision.contentNamespaceId === task.contentNamespaceId
    && revision.resultRevision === input.resultRevision
    && revision.operationId === input.operationId
    && sameBytes(revision.requestDigest, input.requestDigest)
    && revision.requesterHumanId === task.requestorId
    && revision.anchorNamespaceId === task.contentNamespaceId
    && revision.cryptoObjectId === input.resultObjectId
    && revision.representation === input.resultRepresentation
    && revision.payloadVersion === 1
    && revision.cryptoAccessRevision === 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && sameBytes(
      revision.requiredNamespaceFingerprint,
      task.cryptoRequiredNamespaceFingerprint,
    )
    && revision.failureCode === null
    && (
      revision.disposition === "active"
        && (revision.completion === "pending" || revision.completion === "complete")
      || revision.disposition === "mapped" && revision.completion === "complete"
    );
}

function exactTerminalRunMapping(
  run: TaskRun,
  revision: TaskRunResultCryptoRevision,
  input: TaskRunTerminalInput,
  ordinaryResult: DualTaskRunResultPayloadV1 | null,
): boolean {
  const unmapped = run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped"
    && revision.disposition === "active";
  const mapped = run.resultRepresentation === input.resultRepresentation
    && run.resultContentNamespaceId === revision.contentNamespaceId
    && run.resultRevision === input.resultRevision
    && run.resultCryptoObjectId === input.resultObjectId
    && run.resultCryptoAccessRevision === revision.cryptoAccessRevision
    && run.resultCryptoRequiredNamespaceFingerprint !== null
    && sameBytes(
      run.resultCryptoRequiredNamespaceFingerprint,
      revision.requiredNamespaceFingerprint,
    )
    && run.resultCryptoMappingState === "verified"
    && revision.completion === "complete"
    && revision.disposition === "mapped";
  const exactOrdinary = ordinaryResult === null
    ? run.resultText === null && run.lastError === null
    : run.resultText === ordinaryResult.resultText
      && run.lastError === ordinaryResult.lastError;
  return exactOrdinary && (unmapped || mapped);
}

function pristineTerminalRun(
  run: TaskRun,
  revision: TaskRunResultCryptoRevision,
): boolean {
  return run.resultText === null
    && run.lastError === null
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped"
    && revision.disposition === "active";
}

function exactTerminalOutputBinding(
  binding: ProtectedTaskRunOutputBinding | undefined,
  input: TaskRunTerminalInput,
  policyRevision: number,
): boolean {
  return binding !== undefined
    && binding.taskRunId === input.taskRunId
    && binding.bindingId === `task-run-output:${input.taskRunId}`
    && binding.resultOperationId === input.operationId
    && binding.resultObjectId === input.resultObjectId
    && binding.acceptedPolicyRevision === policyRevision;
}

type TaskRunTerminalPlan = Readonly<{
  input: TaskRunTerminalInput;
  ordinaryResult: DualTaskRunResultPayloadV1 | null;
}>;

/**
 * Content-free terminal CAS for one protected Task result. The linked Job
 * carries only an exact idempotency receipt; TaskRun remains lifecycle owner.
 */
export async function terminalizeProtectedTaskRunResult(
  db: DirectDatabase,
  input: ProtectedTaskRunTerminalInput,
): Promise<ProtectedTaskRunTerminalResult> {
  assertProtectedTaskRunTerminalInput(input);
  return terminalizeTaskRunResult(db, Object.freeze({
    input,
    ordinaryResult: null,
  }));
}

/** Shadow-only dual product callback; the ordinary sibling is written once. */
export async function terminalizeDualTaskRunResult(
  db: DirectDatabase,
  input: DualTaskRunTerminalInput,
): Promise<ProtectedTaskRunTerminalResult> {
  assertTaskRunTerminalInput(input);
  if (input.resultRepresentation !== "dual") {
    throw new TypeError("Dual Task result terminal binding is malformed");
  }
  const ordinaryResult = canonicalDualTaskRunResult(input.ordinaryResult);
  return terminalizeTaskRunResult(db, Object.freeze({
    input,
    ordinaryResult,
  }));
}

async function terminalizeTaskRunResult(
  db: DirectDatabase,
  plan: TaskRunTerminalPlan,
): Promise<ProtectedTaskRunTerminalResult> {
  const { input, ordinaryResult } = plan;
  const receipt = terminalReceipt(input);
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return terminalRejected("not_found");

    const [run] = await tx.select().from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
    )).limit(1).for("update");
    if (!run) return terminalRejected("not_found");

    if (run.jobId === null) return terminalRejected("conflict");
    const [job] = await tx.select().from(jobs)
      .where(eq(jobs.id, run.jobId)).limit(1).for("update");
    const policyRevision = protectedTaskJobPolicyRevision(task, run, job, input);
    if (policyRevision === null) return terminalRejected("conflict");

    const [definitionRevision] = await tx.select()
      .from(taskDefinitionCryptoRevisions).where(and(
        eq(taskDefinitionCryptoRevisions.taskId, task.id),
        eq(taskDefinitionCryptoRevisions.contentRevision, task.contentRevision),
      )).limit(1).for("share");
    if (!exactTaskDefinition(
      task,
      definitionRevision,
      input.resultRepresentation,
    )) {
      return terminalRejected("conflict");
    }

    const [resultRevision] = await tx.select()
      .from(taskRunResultCryptoRevisions).where(and(
        eq(taskRunResultCryptoRevisions.operationId, input.operationId),
        eq(taskRunResultCryptoRevisions.taskId, input.taskId),
        eq(taskRunResultCryptoRevisions.taskRunId, input.taskRunId),
        eq(taskRunResultCryptoRevisions.resultRevision, input.resultRevision),
      )).limit(1).for("share");
    if (!exactResultReservation(task, resultRevision, input)) {
      return terminalRejected("conflict");
    }

    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");
    if (
      !policy
      || policy.revision !== policyRevision
      || policy.mode !== (input.resultRepresentation === "dual"
        ? "shadow_encryption"
        : "encrypted_only")
    ) return terminalRejected("authority_changed");

    const [outputBinding] = await tx.select()
      .from(protectedTaskRunOutputBindings)
      .where(eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId))
      .limit(1).for("update");
    if (!exactTerminalOutputBinding(outputBinding, input, policyRevision)) {
      return terminalRejected("conflict");
    }

    if (task.scheduleKind !== input.scheduleKind) {
      return terminalRejected("authority_changed");
    }
    const taskStatus = input.scheduleKind === "cron" ? "pending" : input.outcome;
    const taskIsExactTerminal = task.status === taskStatus;
    const runIsExactTerminal = run.status === input.outcome;
    const existingReceipt = isRecord(job!.metadata)
      ? job!.metadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY]
      : undefined;
    if (taskIsExactTerminal && runIsExactTerminal) {
      if (
        !exactTerminalReceipt(existingReceipt, receipt)
        || run.completedAt?.getTime() !== input.completedAt.getTime()
        || outputBinding!.resultTerminalAt?.getTime()
          !== input.completedAt.getTime()
        || !exactTerminalRunMapping(run, resultRevision!, input, ordinaryResult)
        || !["running", "completed"].includes(job!.status)
      ) return terminalRejected("conflict");
      return Object.freeze({ status: "exact_replay" as const });
    }
    if (TERMINAL_TASK_STATUSES.includes(
      task.status as (typeof TERMINAL_TASK_STATUSES)[number],
    )) return terminalRejected("task_terminal");
    if (TERMINAL_TASK_RUN_STATUSES.includes(
      run.status as (typeof TERMINAL_TASK_RUN_STATUSES)[number],
    )) return terminalRejected("run_terminal");
    if (
      task.status !== (input.scheduleKind === "cron" ? "pending" : "running")
      || run.status !== input.requiredRunStatus
    ) return terminalRejected("not_running");
    if (
      job!.status !== "running"
      || existingReceipt !== undefined
      || run.completedAt !== null
      || outputBinding!.resultTerminalAt !== null
      || outputBinding!.resultAttachedAt !== null
      || !pristineTerminalRun(run, resultRevision!)
    ) return terminalRejected("conflict");

    const jobMetadata = isRecord(job!.metadata) ? job!.metadata : {};
    const [updatedJob] = await tx.update(jobs).set({
      metadata: {
        ...jobMetadata,
        [PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY]: receipt,
      },
    }).where(and(eq(jobs.id, job!.id), eq(jobs.status, "running"))).returning();
    if (!updatedJob) throw new Error("Protected Task terminal CAS lost its Job");

    const [updatedRun] = await tx.update(taskRuns).set({
      status: input.outcome,
      completedAt: new Date(input.completedAt.getTime()),
      ...(ordinaryResult === null ? {} : {
        resultText: ordinaryResult.resultText,
        lastError: ordinaryResult.lastError,
      }),
    }).where(and(
      eq(taskRuns.id, run.id),
      eq(taskRuns.taskId, task.id),
      eq(taskRuns.jobId, job!.id),
      eq(taskRuns.status, input.requiredRunStatus),
      isNull(taskRuns.resultText),
      isNull(taskRuns.lastError),
    )).returning();
    if (!updatedRun) throw new Error("Protected Task terminal CAS lost its TaskRun");

    if (input.scheduleKind !== "cron") {
      const [updatedTask] = await tx.update(tasks).set({
        status: input.outcome,
        updatedAt: new Date(input.completedAt.getTime()),
      }).where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "running"),
        eq(tasks.contentRepresentation, input.resultRepresentation),
        isNull(tasks.lastError),
      )).returning();
      if (!updatedTask) throw new Error("Protected Task terminal CAS lost its Task");
    }
    const [updatedOutputBinding] = await tx
      .update(protectedTaskRunOutputBindings)
      .set({ resultTerminalAt: new Date(input.completedAt.getTime()) })
      .where(and(
        eq(protectedTaskRunOutputBindings.taskRunId, input.taskRunId),
        eq(protectedTaskRunOutputBindings.resultOperationId, input.operationId),
        eq(protectedTaskRunOutputBindings.resultObjectId, input.resultObjectId),
        isNull(protectedTaskRunOutputBindings.resultTerminalAt),
        isNull(protectedTaskRunOutputBindings.resultAttachedAt),
      )).returning();
    if (!updatedOutputBinding) {
      throw new Error("Protected Task terminal CAS lost its output binding");
    }
    return Object.freeze({ status: "transitioned" as const });
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
 * Park only the exact claimed occurrence whose funding admission failed.
 * Requestor and fire-lock predicates prevent a stale or cross-Human denial
 * from mutating a later claim, while releasing this claim for explicit repair.
 */
export async function pauseClaimedTaskForFundingDenial(
  db: DirectDatabase,
  input: {
    taskId: string;
    requestorId: string;
    fireLockId: string;
    reason: TaskFundingFailureCode;
  },
): Promise<AuthorizationPauseTransition> {
  const [task] = await db
    .update(tasks)
    .set({
      status: "paused",
      lastError: input.reason,
      fireLockId: null,
      fireLockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
        eq(tasks.status, "pending"),
        eq(tasks.fireLockId, input.fireLockId),
      ),
    )
    .returning();
  return { task, run: undefined, transitioned: Boolean(task) };
}

/**
 * Settle the exact active run after funding is denied. Locking the Task first
 * serializes this transition with lifecycle operations. The newest occurrence
 * parks with the definition for repair; an older overlapping occurrence
 * terminalizes independently and cannot pause a newer run or schedule.
 */
export async function pauseTaskRunForFundingDenial(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    requestorId: string;
    reason: TaskFundingFailureCode;
  },
): Promise<AuthorizationPauseTransition> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ))
      .limit(1)
      .for("update");
    if (!task) return { task: undefined, run: undefined, transitioned: false };

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      ))
      .limit(1)
      .for("update");
    if (
      !run
      || run.id !== input.taskRunId
      || (run.status !== "running" && run.status !== "awaiting")
    ) {
      return { task, run, transitioned: false };
    }

    const [newerRun] = await tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(and(
        eq(taskRuns.taskId, input.taskId),
        exists(tx.select({ id: taskRunOrderReference.id })
          .from(taskRunOrderReference)
          .where(and(
            eq(taskRunOrderReference.id, input.taskRunId),
            eq(taskRunOrderReference.taskId, input.taskId),
            or(
              gt(taskRuns.startedAt, taskRunOrderReference.startedAt),
              and(
                eq(taskRuns.startedAt, taskRunOrderReference.startedAt),
                gt(taskRuns.id, taskRunOrderReference.id),
              ),
            ),
          ))),
      ))
      .limit(1);

    // Recurring occurrences may overlap. A denial from an older worker still
    // settles that exact run, but it cannot pause the definition or displace a
    // newer occurrence's schedule and lifecycle state.
    if (newerRun) {
      const completedAt = new Date();
      const [updatedRun] = await tx
        .update(taskRuns)
        .set({
          status: "errored",
          lastError: input.reason,
          completedAt,
        })
        .where(and(
          eq(taskRuns.id, input.taskRunId),
          eq(taskRuns.taskId, input.taskId),
          inArray(taskRuns.status, ["running", "awaiting"]),
        ))
        .returning();
      if (!updatedRun) {
        throw new Error("funding denial lost its locked older TaskRun");
      }
      return { task: undefined, run: updatedRun, transitioned: true };
    }

    const [updatedRun] = await tx
      .update(taskRuns)
      .set({ status: "paused", lastError: input.reason })
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
        inArray(taskRuns.status, ["running", "awaiting"]),
      ))
      .returning();
    const [updatedTask] = await tx
      .update(tasks)
      .set({
        status: "paused",
        lastError: input.reason,
        fireLockId: null,
        fireLockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ))
      .returning();
    if (!updatedRun || !updatedTask) {
      throw new Error("funding pause lost its locked Task aggregate");
    }
    return { task: updatedTask, run: updatedRun, transitioned: true };
  });
}

export interface RecordTaskWakeFundingFailureResult {
  task: Task | undefined;
  run: TaskRun | undefined;
  recorded: boolean;
  taskErrorRecorded: boolean;
}

export type CallerFundedRunningTaskRunCursor = Readonly<{
  /** PostgreSQL-authored timestamptz text preserves precision beyond JS Date. */
  startedAt: string;
  runId: string;
}>;

/** Freeze the newest process-start candidate using database-authored ordering. */
export async function getCallerFundedRunningTaskRunRestartBoundary(
  db: DirectDatabase,
): Promise<CallerFundedRunningTaskRunCursor | undefined> {
  const [row] = await db
    .select({
      startedAt: sql<string>`${taskRuns.startedAt}::text`,
      runId: taskRuns.id,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(
      eq(tasks.fundingMode, "caller"),
      inArray(tasks.status, ["pending", "running"]),
      eq(taskRuns.status, "running"),
    ))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
    .limit(1);
  return row;
}

/** Bounded startup candidates whose process-local caller funding vanished. */
export async function listCallerFundedRunningTaskRunsForRestart(
  db: DirectDatabase,
  options: Readonly<{
    limit: number;
    through: CallerFundedRunningTaskRunCursor;
    after?: CallerFundedRunningTaskRunCursor;
  }>,
): Promise<Array<{
  task: Task;
  run: TaskRun;
  cursor: CallerFundedRunningTaskRunCursor;
}>> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) return [];
  const after = options.after;
  const rows = await db
    .select({
      task: tasks,
      run: taskRuns,
      cursorStartedAt: sql<string>`${taskRuns.startedAt}::text`,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(
      eq(tasks.fundingMode, "caller"),
      inArray(tasks.status, ["pending", "running"]),
      eq(taskRuns.status, "running"),
      or(
        lt(taskRuns.startedAt, sql`${options.through.startedAt}::timestamptz`),
        and(
          eq(taskRuns.startedAt, sql`${options.through.startedAt}::timestamptz`),
          lte(taskRuns.id, options.through.runId),
        ),
      ),
      after
        ? or(
            gt(taskRuns.startedAt, sql`${after.startedAt}::timestamptz`),
            and(
              eq(taskRuns.startedAt, sql`${after.startedAt}::timestamptz`),
              gt(taskRuns.id, after.runId),
            ),
          )
        : undefined,
    ))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id))
    .limit(options.limit);
  return rows.map(({ cursorStartedAt, ...row }) => ({
    ...row,
    cursor: { startedAt: cursorStartedAt, runId: row.run.id },
  }));
}

export interface ReconcileCallerFundedTaskRunResult {
  task: Task | undefined;
  run: TaskRun | undefined;
  transitioned: boolean;
}

function sameTaskFundingBinding(
  left: TaskFundingBinding,
  right: TaskFundingBinding,
): boolean {
  return left.kind === right.kind
    && left.providerRoute === right.providerRoute
    && (left.kind === "server"
      || (right.kind === "personal"
        && left.credentialId === right.credentialId
        && left.credentialRevision === right.credentialRevision));
}

/**
 * Consume one exact observer claim into a caller-funded TaskRun. Any paused
 * continuation is bound to the locked latest predecessor before the new row
 * exists, so Stop or a newer occurrence cannot be overwritten by dispatch.
 */
export async function startClaimedCallerTaskRun(
  db: DirectDatabase,
  input: Readonly<{
    taskId: string;
    requestorId: string;
    fireLockId: string;
    graphThreadId: string;
    modelId: string;
    fundingBinding: TaskFundingBinding;
    fundingPredecessorRunId?: string;
  }>,
): Promise<TaskRun | undefined> {
  if (!input.taskId || !input.requestorId || !input.fireLockId
    || !input.graphThreadId || !input.modelId) {
    throw new TypeError("caller-funded TaskRun claim is incomplete");
  }
  const binding = parseTaskFundingBinding(input.fundingBinding);
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.requestorId, input.requestorId),
      eq(tasks.fundingMode, "caller"),
      eq(tasks.status, "pending"),
      eq(tasks.fireLockId, input.fireLockId),
    )).limit(1).for("update");
    if (
      !task
      || task.requestorId !== input.requestorId
      || task.fundingMode !== "caller"
      || task.status !== "pending"
      || task.fireLockId !== input.fireLockId
    ) return undefined;

    if (input.fundingPredecessorRunId) {
      const [predecessor] = await tx.select().from(taskRuns)
        .where(eq(taskRuns.taskId, input.taskId))
        .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
        .limit(1)
        .for("update");
      if (
        !predecessor
        || predecessor.id !== input.fundingPredecessorRunId
        || predecessor.taskId !== input.taskId
        || predecessor.status !== "paused"
        || predecessor.graphThreadId !== input.graphThreadId
        || predecessor.modelId !== input.modelId
        || predecessor.fundingBinding === null
      ) return undefined;
      let predecessorBinding: TaskFundingBinding;
      try {
        predecessorBinding = parseTaskFundingBinding(predecessor.fundingBinding);
      } catch {
        return undefined;
      }
      if (!sameTaskFundingBinding(predecessorBinding, binding)) return undefined;
    }

    const [run] = await tx.insert(taskRuns).values({
      taskId: input.taskId,
      graphThreadId: input.graphThreadId,
      status: "running",
      modelId: input.modelId,
      fundingBinding: binding,
      fundingPredecessorRunId: input.fundingPredecessorRunId ?? null,
    }).returning();
    if (!run) throw new Error("caller-funded TaskRun insert returned no row");
    const [updatedTask] = await tx.update(tasks).set({
      status: "running",
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.requestorId, input.requestorId),
      eq(tasks.fundingMode, "caller"),
      eq(tasks.status, "pending"),
      eq(tasks.fireLockId, input.fireLockId),
    )).returning();
    if (!updatedTask) throw new Error("caller-funded TaskRun start lost its locked Task claim");
    return run;
  });
}

/**
 * Settle an exact run whose process-local caller funding disappeared on
 * restart. Every interrupted occurrence becomes terminal so it can never
 * resume or replay. Only the newest occurrence may project that failure onto
 * the Task aggregate: older overlapping cron runs cannot overwrite a newer
 * occurrence's already-advanced schedule or lifecycle state.
 */
export async function reconcileCallerFundedTaskRunAfterRestart(
  db: DirectDatabase,
  input: Readonly<{ taskId: string; taskRunId: string }>,
): Promise<ReconcileCallerFundedTaskRunResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (
      !task
      || task.fundingMode !== "caller"
      || (task.status !== "pending" && task.status !== "running")
    ) return { task, run: undefined, transitioned: false };

    const [run] = await tx.select().from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      ))
      .limit(1)
      .for("update");
    if (!run || run.id !== input.taskRunId || run.status !== "running") {
      return { task, run, transitioned: false };
    }

    const [newerRun] = await tx.select({ id: taskRuns.id }).from(taskRuns)
      .where(and(
        eq(taskRuns.taskId, input.taskId),
        exists(tx.select({ id: taskRunOrderReference.id })
          .from(taskRunOrderReference)
          .where(and(
            eq(taskRunOrderReference.id, input.taskRunId),
            eq(taskRunOrderReference.taskId, input.taskId),
            or(
              gt(taskRuns.startedAt, taskRunOrderReference.startedAt),
              and(
                eq(taskRuns.startedAt, taskRunOrderReference.startedAt),
                gt(taskRuns.id, taskRunOrderReference.id),
              ),
            ),
          ))),
      ))
      .limit(1);

    const completedAt = new Date();
    const [updatedRun] = await tx.update(taskRuns).set({
      status: "errored",
      lastError: "funding_interrupted_uncertain",
      completedAt,
    }).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId),
      eq(taskRuns.status, "running"),
    )).returning();
    if (newerRun) {
      if (!updatedRun) {
        throw new Error("caller-funded restart reconciliation lost its locked older TaskRun");
      }
      return { task, run: updatedRun, transitioned: true };
    }

    const preserveCronSchedule = task.scheduleKind === "cron";
    const [updatedTask] = await tx.update(tasks).set({
      status: preserveCronSchedule ? "pending" : "paused",
      lastError: "funding_interrupted_uncertain",
      fireLockId: null,
      fireLockedAt: null,
      updatedAt: completedAt,
    }).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.fundingMode, "caller"),
      inArray(tasks.status, ["pending", "running"]),
    )).returning();
    if (!updatedRun || !updatedTask) {
      throw new Error("caller-funded restart reconciliation lost its locked Task aggregate");
    }
    return { task: updatedTask, run: updatedRun, transitioned: true };
  });
}

/**
 * Bind the executor's accepted Job to its exact caller-funded run. Recurring
 * occurrences may overlap, so a newer run must not invalidate an older
 * eligible executor. Task lifecycle plus exact run/graph predicates keep a
 * delayed executor from claiming a replay. Re-reading the same Job is
 * idempotent; another Job is rejected.
 */
export async function claimCallerTaskRunJob(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    requestorId: string;
    graphThreadId: string;
    jobId: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
        eq(tasks.fundingMode, "caller"),
      ))
      .limit(1)
      .for("update");
    if (!task) return false;

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      ))
      .limit(1)
      .for("update");
    if (
      !run
      || run.id !== input.taskRunId
      || run.graphThreadId !== input.graphThreadId
      || run.status !== "running"
    ) return false;
    // A delayed executor for an overlapping cron occurrence may still claim
    // its exact run while the definition remains live. If lifecycle already
    // parked or terminalized the aggregate, settle this exact run to the same
    // canonical state rather than letting even an idempotent claim reactivate
    // work after Pause or Stop.
    if (task.status === "paused") {
      const [parkedRun] = await tx.update(taskRuns)
        .set({ status: "paused", lastError: task.lastError })
        .where(and(
          eq(taskRuns.id, run.id),
          eq(taskRuns.taskId, task.id),
          eq(taskRuns.status, "running"),
        ))
        .returning({ id: taskRuns.id });
      if (!parkedRun) throw new Error("delayed caller-funded claim lost its paused TaskRun");
      return false;
    }
    if (TERMINAL_TASK_STATUSES.includes(
      task.status as (typeof TERMINAL_TASK_STATUSES)[number],
    )) {
      const [terminalRun] = await tx.update(taskRuns).set({
        status: task.status === "cancelled" ? "cancelled" : "errored",
        lastError: task.lastError,
        completedAt: new Date(),
      }).where(and(
        eq(taskRuns.id, run.id),
        eq(taskRuns.taskId, task.id),
        eq(taskRuns.status, "running"),
      )).returning({ id: taskRuns.id });
      if (!terminalRun) throw new Error("delayed caller-funded claim lost its terminal TaskRun");
      return false;
    }

    if (run.jobId === input.jobId) return true;
    if (run.jobId !== null) return false;

    const [claimed] = await tx
      .update(taskRuns)
      .set({ jobId: input.jobId })
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
        eq(taskRuns.graphThreadId, input.graphThreadId),
        eq(taskRuns.status, "running"),
        isNull(taskRuns.jobId),
      ))
      .returning({ id: taskRuns.id });
    return Boolean(claimed);
  });
}

/**
 * Record a report-back funding failure without changing completed work or a
 * recurring Task's lifecycle. Only the latest producing run may project its
 * safe reason onto the Task row.
 */
export async function recordTaskWakeFundingFailure(
  db: DirectDatabase,
  input: {
    taskId: string;
    taskRunId: string;
    requestorId: string;
    reason: TaskFundingFailureCode;
  },
): Promise<RecordTaskWakeFundingFailureResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
      ))
      .limit(1)
      .for("update");
    if (!task) {
      return {
        task: undefined,
        run: undefined,
        recorded: false,
        taskErrorRecorded: false,
      };
    }

    const [run] = await tx
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
        eq(taskRuns.status, "completed"),
      ))
      .limit(1)
      .for("update");
    if (!run) {
      return { task, run: undefined, recorded: false, taskErrorRecorded: false };
    }
    const [latest] = await tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, input.taskId))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
      .limit(1);

    const [updatedRun] = await tx
      .update(taskRuns)
      .set({ lastError: input.reason })
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
        eq(taskRuns.status, "completed"),
      ))
      .returning();
    if (!updatedRun) throw new Error("funding wake failure lost its locked TaskRun");

    if (latest?.id !== input.taskRunId) {
      return {
        task,
        run: updatedRun,
        recorded: true,
        taskErrorRecorded: false,
      };
    }
    const [updatedTask] = await tx
      .update(tasks)
      .set({ lastError: input.reason, updatedAt: new Date() })
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.requestorId, input.requestorId),
      ))
      .returning();
    if (!updatedTask) throw new Error("funding wake failure lost its locked Task");
    return {
      task: updatedTask,
      run: updatedRun,
      recorded: true,
      taskErrorRecorded: true,
    };
  });
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
