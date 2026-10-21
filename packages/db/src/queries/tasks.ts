import { parseProtectedTaskCheckpointAadBinding, sameProtectedTaskCheckpointAadBinding, type ProtectedTaskCheckpointAadBinding } from "./protected-task-checkpoint-aad-binding";
import { protectedTaskDefinitionSupportsPolicy } from "../utils/encryption-transition-queries";
import { createHash } from "node:crypto";
import {
  parseTaskFundingBinding,
  TASK_FUNDING_FAILURE_CODES,
  parseLocalExecutionDelegation,
  readTaskPreparation,
  type ApprovalReplyVerb,
  type TaskFundingBinding,
  type TaskFundingFailureCode,
} from "@nautilo/types";
/**
 * Task data access, observer claims, and lifecycle status transitions.
 * Observer and dispatch orchestration belong to Runtime.
 *
 * Every helper takes an explicit database handle, allowing either a pooled
 * DirectDatabase or a transaction-scoped handle. No singleton is required.
 */
import { and, arrayContains, asc, desc, eq, exists, getTableColumns, gt, inArray, isNotNull, isNull, lt, lte, ne, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../config/direct-database";
import { tasks, type Task, type NewTask } from "../schema/tasks";
import { llmUsageEvents } from "../schema/llm-usage";
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
import { actors } from "../schema/trust";
import { users } from "../schema/users";
import {
  protectedTaskExecutionSegmentReceipts,
  type ProtectedTaskExecutionSegmentReceipt,
} from "../schema/protected-task-execution-segment-receipts";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from
  "../schema/protected-task-run-output-bindings";
import { protectedTaskRunResultObjectId } from
  "./protected-task-output-binding-identities";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
  readProtectedTaskExecutionContinuationProof,
  sameProtectedTaskSemanticAuthorityRequirements,
  sealProtectedTaskContinuationReceiptInTx,
  sealProtectedTaskExecutionSegmentReceiptInTx,
  type SealProtectedTaskContinuationReceiptInput,
  type SealProtectedTaskContinuationReceiptResult,
  type ProtectedTaskCheckpointManifestReceipt,
  type ProtectedTaskExecutionContinuationProof,
  type ProtectedTaskSemanticAuthorityRequirements,
  type SealProtectedTaskExecutionSegmentReceiptInput,
  type SealProtectedTaskExecutionSegmentReceiptResult,
} from "./protected-task-execution-receipts";
import { readProtectedTaskTranscriptManifestInTx } from
  "./task-run-message-associations";
import {
  exactParkedProtectedTaskAdditionalAuthorityProof,
  exactParkedProtectedTaskHumanProof,
  prepareParkedProtectedTaskAdditionalAuthorityStart,
  prepareParkedProtectedTaskHumanStart,
} from "./protected-task-parked-start-proof";

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
  /** Exact non-authorizing operation reserved before canonical Writer save. */
  pendingWorkspaceOperationId?: string;
  /** Stable operation correlation; retained only while its canonical result is unknown. */
  pendingWorkspaceClientMutationId?: string;
  /** Internal Artifact row identity, retained only while outcome is unknown. */
  pendingWorkspaceArtifactId?: string;
  /** Operation lineage retained with an accepted result after the reservation settles. */
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

function lifecycleFundingFailure(column: typeof tasks.lastError | typeof taskRuns.lastError) {
  return sql<string | null>`CASE WHEN ${inArray(column, [...TASK_FUNDING_FAILURE_CODES])}
    THEN ${column} ELSE NULL END`;
}

const taskLifecycleMetadataProjection = {
  ...getTableColumns(tasks),
  prompt: sql<string>`''::text`,
  expectedOutput: sql<string | null>`null::text`,
  lastError: lifecycleFundingFailure(tasks.lastError),
  metadata: sql<Record<string, unknown>>`jsonb_build_object('execution', jsonb_build_object('harnessId', case
    when ${tasks.metadata}->'execution'->>'harnessId' in ('codex', 'claude-code', 'hermes-acp', 'opencode-acp')
    then ${tasks.metadata}->'execution'->>'harnessId' else null end))`,
};

type JsonbProjectionField = string | readonly [key: string, value: SQL];

function jsonbField(source: SQL, key: string): SQL {
  return sql`(${source}->${key}::text)`;
}

function jsonbPrimitiveField(source: SQL, key: string): SQL {
  const value = jsonbField(source, key);
  return sql`CASE WHEN jsonb_typeof(${value}) IN ('null', 'boolean', 'number', 'string')
    THEN ${value} ELSE 'null'::jsonb END`;
}

/** Build a JSON object exclusively from the named fields, retaining present nulls. */
function closedJsonbProjection(
  source: SQL,
  fields: readonly JsonbProjectionField[],
  acceptedFields: readonly string[] = fields.map((field) =>
    typeof field === "string" ? field : field[0]),
): SQL<Record<string, unknown>> {
  const projected = sql`(${sql.join(fields.map((field) => {
    const key = typeof field === "string" ? field : field[0];
    const value = typeof field === "string" ? jsonbPrimitiveField(source, key) : field[1];
    return sql`CASE WHEN ${source} ? ${key}
      THEN jsonb_build_object(${key}::text, ${value}) ELSE '{}'::jsonb END`;
  }), sql` || `)})`;
  const accepted = sql`ARRAY[${sql.join(
    acceptedFields.map((key) => sql`${key}::text`),
    sql`, `,
  )}]::text[]`;
  return sql<Record<string, unknown>>`CASE
    WHEN jsonb_typeof(${source}) = 'object'
      AND ${source} - ${accepted} = '{}'::jsonb
    THEN ${projected}
    ELSE 'null'::jsonb
  END`;
}

const metadataSource = sql`${tasks.metadata}`;
const executionSource = jsonbField(metadataSource, "execution");
const preparationSource = jsonbField(metadataSource, "preparation");
const interruptionSource = jsonbField(metadataSource, "lastInterruption");
const researchSource = jsonbField(metadataSource, "deepResearch");
const modelFundingSource = jsonbField(researchSource, "modelFunding");
const fundingFields = ["kind", "providerRoute", "credentialId", "credentialRevision"] as const;
const researchLanes = ["supervisor", "research", "summarization", "compression", "finalReport"] as const;
const writerFields = [
  "version", "taskRunId", "proposalId", "pendingWorkspaceOperationId",
  "pendingWorkspaceClientMutationId", "pendingWorkspaceArtifactId",
  "acceptedWorkspaceOperationId", "acceptedWorkspaceClientMutationId",
  "acceptedWorkspaceArtifactId", "verificationRunId",
] as const;

const taskProtectedMutationMetadata = closedJsonbProjection(metadataSource, [
  ["execution", closedJsonbProjection(executionSource, [
    "version", "harnessId", "source", "collaborationMode", "harnessModelId",
    ["outputContract", closedJsonbProjection(jsonbField(executionSource, "outputContract"), [
      "version", "capabilityModelId", "catalogVersion", "contextTokens", "outputTokens",
    ])],
    ["readiness", closedJsonbProjection(jsonbField(executionSource, "readiness"), [
      "relayId", "pairingGenerationRef", "capabilityRevision", "relaySessionId",
      "desktopSessionId", "selectedProtocolVersion",
    ])],
    "profileRef", "catalogModelId", "selectedModel", "executionProfile",
  ], ["version", "harnessId", "source", "collaborationMode", "harnessModelId",
    "outputContract", "readiness", "workingDirectory", "profileRef", "catalogModelId",
    "selectedModel", "executionProfile"])],
  ["preparation", closedJsonbProjection(preparationSource, [
    "stage", "probe", "filesObserved", "directoriesObserved", "activity",
    ["contextRecovery", closedJsonbProjection(jsonbField(preparationSource, "contextRecovery"), [
      "pendingInputs", "phase", "recoveredInputBytes", "retainedUnconsolidatedPages",
    ])],
    ["contextPage", closedJsonbProjection(jsonbField(preparationSource, "contextPage"), [
      "startByte", "endByte", "totalBytes",
    ])],
    ["research", closedJsonbProjection(jsonbField(preparationSource, "research"), [
      "unitsTotal", "unitsCompleted", "unitsPending", "filesTotal", "filesAssigned",
    ])],
    ["researchWork", closedJsonbProjection(jsonbField(preparationSource, "researchWork"), [
      "role", "reviewDecision",
    ], ["role", "subject", "reviewDecision"])],
    "taskRunId", "updatedAt",
  ])],
  ["lastInterruption", closedJsonbProjection(interruptionSource, [
    "code", "cause", "stoppedBy", "outcome", "observedAt", "taskRunId",
    "graphThreadId", "checkpointId", "modelId", "attemptId", "timeoutMs", "elapsedMs",
    "abortRequested", "visibleOutput", "partialState", "safeToFallback", "resumable",
    "desktopExitCause", "resumeRequiresValidation",
  ], ["code", "cause", "stoppedBy", "outcome", "observedAt", "taskRunId",
    "graphThreadId", "checkpointId", "modelId", "attemptId", "timeoutMs", "elapsedMs",
    "abortRequested", "visibleOutput", "partialState", "safeToFallback", "resumable",
    "desktopExitCause", "toolName", "operation", "resumeRequiresValidation"])],
  ["deepResearch", closedJsonbProjection(researchSource, [
    "version",
    ["modelPlan", closedJsonbProjection(jsonbField(researchSource, "modelPlan"), [
      "version", "supervisorModel", "researchModel", "summarizationModel",
      "compressionModel", "finalReportModel",
    ])],
    "invokingModelId",
    ["preferenceRevisions", closedJsonbProjection(jsonbField(researchSource, "preferenceRevisions"), researchLanes)],
    ["modelFunding", closedJsonbProjection(modelFundingSource, researchLanes.map((lane) => [
      lane, closedJsonbProjection(jsonbField(modelFundingSource, lane), fundingFields),
    ] as const))],
    ["tavilyFunding", closedJsonbProjection(jsonbField(researchSource, "tavilyFunding"), fundingFields)],
  ], ["version", "reportLanguage", "modelPlan", "invokingModelId",
    "preferenceRevisions", "modelFunding", "tavilyFunding"])],
  "mode", "publish", "bringBack", "ordinaryArtifactPeer", "expectedArtifactPeerActorId",
  "artifactAwareAskPeer", "source",
  ["liveMiniAppTaskDelegation", closedJsonbProjection(jsonbField(metadataSource, "liveMiniAppTaskDelegation"), [
    "version", "appId",
  ])],
  ...(["writerReviewAwaiting", "writerReviewAcceptedReceipt"] as const).map((key) => {
    const writerSource = jsonbField(metadataSource, key);
    return [key, closedJsonbProjection(writerSource, [
      ...writerFields,
      ["acceptedResultRevision", closedJsonbProjection(jsonbField(writerSource, "acceptedResultRevision"), [
        "kind", "revision", "sha256",
      ])],
    ])] as const;
  }),
], ["execution", "preparation", "lastInterruption", "deepResearch", "target", "mode",
  "publish", "instructions", "bringBack", "ordinaryArtifactPeer",
  "expectedArtifactPeerActorId", "artifactAwareAskPeer", "artifactRefs",
  "artifactOperationId", "artifactId", "topic", "source", "liveMiniAppTaskDelegation",
  "writerReviewAwaiting", "writerReviewAcceptedReceipt"]);

const taskProtectedMutationProjection = {
  ...getTableColumns(tasks),
  prompt: sql<string>`''::text`,
  expectedOutput: sql<string | null>`null::text`,
  lastError: sql<string | null>`null::text`,
  metadata: taskProtectedMutationMetadata,
};

export async function getTaskById(
  db: DirectDatabase,
  id: string,
  options?: Readonly<{ ordinaryOnly?: boolean; lifecycleOnly?: false }>
    | Readonly<{ lifecycleOnly: true; ownerId: string }>,
): Promise<Task | undefined> {
  const fields = options?.lifecycleOnly ? taskLifecycleMetadataProjection : getTableColumns(tasks);
  const [row] = await db.select(fields).from(tasks).where(and(eq(tasks.id, id),
    ...(options?.lifecycleOnly ? [eq(tasks.ownerId, options.ownerId)] : []),
    ...(options?.lifecycleOnly !== true && options?.ordinaryOnly === true
      ? [eq(tasks.contentRepresentation, "ordinary")] : []))).limit(1);
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
  options?: Readonly<{ ordinaryOnly?: boolean; lifecycleOnly?: false }>
    | Readonly<{ lifecycleOnly: true; ownerId: string }>,
): Promise<(Task & { mutationVersion: string }) | undefined> {
  const fields = options?.lifecycleOnly === true ? taskLifecycleMetadataProjection : getTableColumns(tasks);
  const [row] = await db
    .select({
      ...fields,
      mutationVersion: sql<string>`${tasks}.xmin::text`,
    })
    .from(tasks)
    .where(and(eq(tasks.id, id),
      ...(options?.lifecycleOnly === true ? [eq(tasks.ownerId, options.ownerId)] : []),
      ...(options?.lifecycleOnly !== true && options?.ordinaryOnly === true
        ? [eq(tasks.contentRepresentation, "ordinary")] : [])))
    .limit(1);
  return row;
}

/**
 * Read the exact Task mutation source without materializing its ordinary
 * definition body. The owner fence and xmin token remain part of the same
 * PostgreSQL statement used by protected publication CAS.
 */
export async function getProtectedTaskMutationSourceById(
  db: DirectDatabase,
  id: string,
  ownerId: string,
): Promise<(Task & { mutationVersion: string }) | undefined> {
  const [row] = await db
    .select({
      ...taskProtectedMutationProjection,
      mutationVersion: sql<string>`${tasks}.xmin::text`,
    })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
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
  projection?: Readonly<{ lifecycleOnly: true }>,
): Promise<Task[]> {
  // The protected metadata reader selects no ordinary content siblings. These
  // placeholders keep the existing lifecycle query/snapshot ordering shared;
  // callers must mark ordinary definitions unavailable, never consume them.
  const fields = projection?.lifecycleOnly ? taskLifecycleMetadataProjection : getTableColumns(tasks);
  if (opts.status) {
    const query = db
      .select(fields)
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
      .select(fields)
      .from(tasks)
      .where(nonTerminalWhere)
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  if (!opts.includeRecentTerminal && opts.recentTerminalLimit === undefined) {
    return db
      .select(fields)
      .from(tasks)
      .where(eq(tasks.ownerId, ownerId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
  }

  // A repeatable-read snapshot makes the two partitions mutually exclusive:
  // a Task cannot appear as non-terminal in one query and terminal in the
  // other (or disappear between them) while this list is assembled.
  return db.transaction(async (tx) => {
    const nonTerminal = await tx
      .select(fields)
      .from(tasks)
      .where(nonTerminalWhere)
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    const terminal = await tx
      .select(fields)
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

const TASK_DEFINITION_KEYS: readonly (keyof Task)[] = ["ownerId", "requestorId", "agentId", "prompt", "expectedOutput",
    "preset", "scheduleKind", "runAt", "cron", "timezone", "catchup", "callingRoomId", "targetChat", "targetChatHandle",
    "targetRoomId", "targetUserIds", "resultDelivery", "useScope", "scopeId", "toolsMode", "toolsWhitelist", "awaitResponse",
    "selectionProfile", "selectionSpec", "requestedModelId", "fundingMode", "timeLimitSeconds", "parentTaskId", "depth",
    "metadata", "contentRepresentation", "contentNamespaceId", "contentRevision", "cryptoObjectId"];

// Crypto access can change without a definition edit. Cache writes must still
// match the exact protected source observed before execution setup.
const TASK_EXECUTION_SOURCE_KEYS: readonly (keyof Task)[] = [
  ...TASK_DEFINITION_KEYS, "cryptoAccessRevision", "cryptoRequiredNamespaceFingerprint", "cryptoMappingState",
];

/** Durable pre-model wait; the recorded phase preserves saved graph identity. */
export const TASK_LOCAL_EXECUTION_OFFLINE_WAIT = "TASK_LOCAL_EXECUTION_OFFLINE_WAIT";
export const TASK_LOCAL_EXECUTION_OFFLINE_TEXT = "Waiting for the original Mac. Reconnect it with the same pairing and project access to continue.";
const TASK_LOCAL_EXECUTION_MANUAL_PAUSE_TEXT = "Paused by you. Resume waits for the original Mac.";

function canonicalOfflineFact(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(canonicalOfflineFact);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalOfflineFact(item)]),
  );
  return value;
}

/** The digest records the original definition, not authority or plaintext. */
export function taskLocalExecutionOfflineMarker(task: Task, phase: "cold" | "checkpoint" = "cold"): string {
  const facts = Object.fromEntries([...TASK_EXECUTION_SOURCE_KEYS, "localExecutionDelegation" as const]
    .map(key => [key, task[key]]));
  return `${TASK_LOCAL_EXECUTION_OFFLINE_WAIT}:${phase}:${createHash("sha256").update(JSON.stringify(canonicalOfflineFact(facts))).digest("hex")}`;
}

function untouchedOfflineRun(run: TaskRun): boolean {
  return run.resultText === null && run.completedAt === null && run.resultRepresentation === "ordinary"
    && run.resultRevision === 0 && run.resultCryptoObjectId === null;
}
export function taskLocalExecutionOfflinePhase(task: Task, run: TaskRun): "cold" | "checkpoint" | null {
  if (!parseLocalExecutionDelegation(task.localExecutionDelegation) || run.taskId !== task.id || run.status !== "paused" || !untouchedOfflineRun(run)) return null;
  for (const phase of ["cold", "checkpoint"] as const) {
    if (run.lastError === taskLocalExecutionOfflineMarker(task, phase)) return phase;
  }
  return null;
}
export function isTaskLocalExecutionOfflineWait(task: Task, run: TaskRun): boolean {
  return taskLocalExecutionOfflinePhase(task, run) !== null;
}

function exactOfflineTaskPredicate(task: Task) {
  const columns = getTableColumns(tasks);
  return and(eq(tasks.id, task.id), eq(tasks.status, task.status),
    task.lastError === null ? isNull(tasks.lastError) : eq(tasks.lastError, task.lastError),
    task.fireLockId === null ? isNull(tasks.fireLockId) : eq(tasks.fireLockId, task.fireLockId),
    task.localExecutionDelegation === null ? isNull(tasks.localExecutionDelegation) : eq(tasks.localExecutionDelegation, task.localExecutionDelegation),
    ...TASK_EXECUTION_SOURCE_KEYS.map(key => task[key] === null ? isNull(columns[key]) : eq(columns[key], task[key])));
}
function exactOfflineRunPredicate(run: TaskRun) {
  return and(eq(taskRuns.id, run.id), eq(taskRuns.taskId, run.taskId), eq(taskRuns.status, run.status),
    eq(taskRuns.graphThreadId, run.graphThreadId),
    run.modelId === null ? isNull(taskRuns.modelId) : eq(taskRuns.modelId, run.modelId),
    run.jobId === null ? isNull(taskRuns.jobId) : eq(taskRuns.jobId, run.jobId),
    run.lastError === null ? isNull(taskRuns.lastError) : eq(taskRuns.lastError, run.lastError),
    run.fundingBinding === null ? isNull(taskRuns.fundingBinding) : eq(taskRuns.fundingBinding, run.fundingBinding),
    run.fundingPredecessorRunId === null ? isNull(taskRuns.fundingPredecessorRunId) : eq(taskRuns.fundingPredecessorRunId, run.fundingPredecessorRunId),
    isNull(taskRuns.resultText), isNull(taskRuns.completedAt), eq(taskRuns.resultRepresentation, "ordinary"),
    eq(taskRuns.resultRevision, 0), isNull(taskRuns.resultCryptoObjectId));
}
async function lockOfflinePair(db: Pick<DirectDatabase, "select">, task: Task, run: TaskRun) {
  const [current] = await db.select().from(tasks).where(exactOfflineTaskPredicate(task)).limit(1).for("update");
  if (!current) return false;
  const [latest] = await db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1).for("update");
  if (latest?.id !== run.id) return false;
  const [exact] = await db.select().from(taskRuns).where(exactOfflineRunPredicate(run)).limit(1).for("update");
  return Boolean(exact);
}

export async function parkTaskLocalExecutionOffline(db: DirectDatabase, input: { task: Task; run: TaskRun; jobId: string; phase: "cold" | "checkpoint" }): Promise<boolean> {
  const { task, run } = input;
  if (!["cold", "checkpoint"].includes(input.phase) || !parseLocalExecutionDelegation(task.localExecutionDelegation) || run.taskId !== task.id || run.status !== "running" || run.jobId !== input.jobId
    || run.lastError !== null || !untouchedOfflineRun(run)
    || !(task.status === "running" || task.status === "pending" && task.scheduleKind === "cron")) return false;
  return db.transaction(async tx => {
    if (!await lockOfflinePair(tx, task, run)) return false;
    await tx.update(taskRuns).set({ status: "paused", lastError: taskLocalExecutionOfflineMarker(task, input.phase) }).where(eq(taskRuns.id, run.id));
    await tx.update(tasks).set({ status: "paused", lastError: TASK_LOCAL_EXECUTION_OFFLINE_TEXT,
      fireLockId: null, fireLockedAt: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
}

/** Existing observer pagination; the caller supplies its existing batch size. */
export async function listTaskLocalExecutionOfflineWaits(db: DirectDatabase, input: { limit: number; afterTaskId?: string }) {
  return db.select({ task: tasks, run: taskRuns }).from(tasks).innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(and(eq(tasks.status, "paused"), eq(tasks.lastError, TASK_LOCAL_EXECUTION_OFFLINE_TEXT),
      eq(taskRuns.status, "paused"), sql`${taskRuns.lastError} LIKE ${`${TASK_LOCAL_EXECUTION_OFFLINE_WAIT}:%`}`,
      // Filter before pagination: a historical paused occurrence cannot fill
      // this Task's page or masquerade as the current offline wait.
      notExists(db.select({ id: taskRunOrderReference.id }).from(taskRunOrderReference).where(and(
        eq(taskRunOrderReference.taskId, taskRuns.taskId),
        or(gt(taskRunOrderReference.startedAt, taskRuns.startedAt), and(
          eq(taskRunOrderReference.startedAt, taskRuns.startedAt), gt(taskRunOrderReference.id, taskRuns.id))),
      ))),
      input.afterTaskId ? gt(tasks.id, input.afterTaskId) : undefined))
    .orderBy(asc(tasks.id)).limit(input.limit);
}

/** Fresh source and exact target readiness precede this non-authorizing CAS. */
export async function rearmTaskLocalExecutionOffline(db: DirectDatabase, input: { task: Task; run: TaskRun }): Promise<boolean> {
  const { task, run } = input;
  if (task.status !== "paused" || task.lastError !== TASK_LOCAL_EXECUTION_OFFLINE_TEXT || !isTaskLocalExecutionOfflineWait(task, run)) return false;
  return db.transaction(async tx => {
    if (!await lockOfflinePair(tx, task, run)) return false;
    await tx.update(tasks).set({ status: "pending", nextFireAt: new Date(), fireLockId: null, fireLockedAt: null,
      updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return true;
  });
}

/** Reclaim the original Run; its recorded phase determines saved-graph resumption. */
export async function claimTaskLocalExecutionOfflineRun(db: DirectDatabase, input: { task: Task; run: TaskRun; fireLockId: string | null }): Promise<TaskRun | undefined> {
  const { task, run } = input;
  if (task.status !== "pending" || task.fireLockId !== input.fireLockId || !input.fireLockId
    || !isTaskLocalExecutionOfflineWait(task, run)) return undefined;
  return db.transaction(async tx => {
    if (!await lockOfflinePair(tx, task, run)) return undefined;
    const [resumed] = await tx.update(taskRuns).set({ status: "running", lastError: null, jobId: null }).where(eq(taskRuns.id, run.id)).returning();
    await tx.update(tasks).set({ status: "running", lastError: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return resumed;
  });
}

/** Definition edits invalidate saved local execution consent in the same write.
 * Scheduler/lifecycle bookkeeping alone does not alter the definition. */
export const TASK_LOCAL_EXECUTION_RECREATE_TEXT = "Project access was removed by a Task edit. Recreate this Task from its original chat on the intended Mac.";

export function taskRequiresLocalExecutionRecapture(task: Pick<Task, "localExecutionDelegation" | "lastError">): boolean {
  return task.localExecutionDelegation === null && task.lastError === TASK_LOCAL_EXECUTION_RECREATE_TEXT;
}

function excludesLocalExecutionRecapture() {
  return sql`NOT (${tasks.localExecutionDelegation} IS NULL AND ${tasks.lastError} IS NOT DISTINCT FROM ${TASK_LOCAL_EXECUTION_RECREATE_TEXT})`;
}

/** SQL evaluates the old row, so consent removal and its repair state cannot race. */
export function taskLocalExecutionDefinitionInvalidationPatch(fallback: Partial<NewTask> = {}) {
  const repair = sql`(${tasks.localExecutionDelegation} IS NOT NULL OR ${tasks.lastError} IS NOT DISTINCT FROM ${TASK_LOCAL_EXECUTION_RECREATE_TEXT}) AND ${tasks.status} NOT IN ('completed', 'cancelled', 'errored')`;
  const prior = <Key extends keyof NewTask>(key: Key) => Object.prototype.hasOwnProperty.call(fallback, key)
    ? sql.param(fallback[key], getTableColumns(tasks)[key]) : getTableColumns(tasks)[key];
  return {
    localExecutionDelegation: null,
    status: sql<TaskStatus>`CASE WHEN ${repair} THEN 'paused' ELSE ${prior("status")} END`,
    lastError: sql<string | null>`CASE WHEN ${repair} THEN ${TASK_LOCAL_EXECUTION_RECREATE_TEXT} ELSE ${prior("lastError")} END`,
    fireLockId: sql<string | null>`CASE WHEN ${repair} THEN NULL ELSE ${prior("fireLockId")} END`,
    fireLockedAt: sql<Date | null>`CASE WHEN ${repair} THEN NULL ELSE ${prior("fireLockedAt")} END`,
  };
}

function isDefinitionMutation(patch: Partial<NewTask>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, "localExecutionDelegation")
    || TASK_DEFINITION_KEYS.some(key => Object.prototype.hasOwnProperty.call(patch, key));
}
function taskMutationPatch(patch: Partial<NewTask>) {
  if (Object.prototype.hasOwnProperty.call(patch, "localExecutionDelegation")
    && patch.localExecutionDelegation !== null) {
    throw new TypeError("Task updates cannot author local execution delegation");
  }
  return { ...patch, ...(isDefinitionMutation(patch) ? taskLocalExecutionDefinitionInvalidationPatch(patch) : {}) };
}

/** The exact old worker can settle, but cannot publish against removed consent. */
async function cancelTaskRunForLocalExecutionRecapture(db: Pick<DirectDatabase, "update">, run: TaskRun): Promise<TaskRun> {
  if (TERMINAL_TASK_RUN_STATUSES.includes(run.status as (typeof TERMINAL_TASK_RUN_STATUSES)[number])) return run;
  const [cancelled] = await db.update(taskRuns).set({ status: "cancelled", lastError: TASK_LOCAL_EXECUTION_RECREATE_TEXT,
    completedAt: new Date() }).where(eq(taskRuns.id, run.id)).returning();
  if (!cancelled) throw new Error("Task recapture cancellation lost locked Run");
  return cancelled;
}

/** Publish an interrupt only when the same current Run still owns the Task. */
export async function markTaskAwaitingIfCurrentRun(db: DirectDatabase, input: { taskId: string; taskRunId: string }) {
  return db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, input.taskId))).limit(1).for("update");
    if (!task || !run) return { task, run, transitioned: false };
    if (taskRequiresLocalExecutionRecapture(task)) {
      return { task, run: await cancelTaskRunForLocalExecutionRecapture(tx, run), transitioned: false };
    }
    if (run.status !== "running" || !(task.status === "running" || task.status === "pending" && task.scheduleKind === "cron")) {
      return { task, run, transitioned: false };
    }
    const [latest] = await tx.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.taskId, task.id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1).for("update");
    if (latest?.id !== run.id) return { task, run, transitioned: false };
    const [awaitingRun] = await tx.update(taskRuns).set({ status: "awaiting" }).where(eq(taskRuns.id, run.id)).returning();
    const [awaitingTask] = await tx.update(tasks).set({ status: "awaiting", updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
    if (!awaitingTask || !awaitingRun) throw new Error("Task interrupt lost locked pair");
    return { task: awaitingTask, run: awaitingRun, transitioned: true };
  });
}

export async function updateTask(
  db: DirectDatabase,
  id: string,
  patch: Partial<NewTask>,
): Promise<Task | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ ...taskMutationPatch(patch), updatedAt: new Date() })
    .where(and(eq(tasks.id, id), isDefinitionMutation(patch) || patch.status === "cancelled" ? undefined : excludesLocalExecutionRecapture()))
    .returning();
  return row;
}

/** Internal execution caches may advance only against the unchanged admitted
 * definition. External definition updates invalidate saved consent. */
export async function memoizeTaskExecutionCoordinates(
  db: DirectDatabase,
  observed: Task,
  patch: Partial<Pick<Task, "targetRoomId" | "targetUserIds" | "scopeId">>,
): Promise<Task> {
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some(key => !["targetRoomId", "targetUserIds", "scopeId"].includes(key))) {
    throw new TypeError("Invalid Task execution cache update");
  }
  const columns = getTableColumns(tasks);
  const matches = TASK_EXECUTION_SOURCE_KEYS.map(key => {
    const value = observed[key];
    const original = value === null ? isNull(columns[key]) : eq(columns[key], value);
    if (key === "targetRoomId" || key === "targetUserIds" || key === "scopeId") {
      const next = patch[key];
      return next === undefined ? original : or(original, next === null ? isNull(columns[key]) : eq(columns[key], next));
    }
    return original;
  });
  const [row] = await db.update(tasks).set({ ...patch, updatedAt: new Date() }).where(and(
    eq(tasks.id, observed.id),
    observed.localExecutionDelegation === null ? isNull(tasks.localExecutionDelegation)
      : eq(tasks.localExecutionDelegation, observed.localExecutionDelegation),
    ...matches,
  )).returning();
  if (!row) throw new Error("Task definition changed during execution setup");
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
    .set({ ...taskMutationPatch(patch), updatedAt: new Date() })
    .where(and(
      eq(tasks.id, input.id),
      eq(tasks.ownerId, input.ownerId),
      eq(tasks.status, input.expectedStatus),
      sql`${tasks}.xmin::text = ${input.expectedMutationVersion}`,
      eq(tasks.contentRevision, input.expectedContentRevision),
      isDefinitionMutation(patch) || patch.status === "cancelled" ? undefined : excludesLocalExecutionRecapture(),
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
  projection?: Readonly<{ lifecycleOnly: true }>,
): Promise<TaskRun[]> {
  const fields = projection?.lifecycleOnly ? {
    ...getTableColumns(taskRuns),
    resultText: sql<string | null>`null::text`,
    // Preserve only canonical funding diagnostics, never provider error text.
    lastError: lifecycleFundingFailure(taskRuns.lastError),
  } : getTableColumns(taskRuns);
  return db
    .select(fields)
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
 * The `model_id` of each task's MOST RECENT run, for a set of task ids.
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
 * Batched `profiles.name` lookup for a set of agent ids (one query).
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
 * The newest still-`running` run for a task that has a linked
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

/** Content-free state returned by protected lifecycle controls. */
export type ProtectedTaskLifecycleTaskState = Pick<Task,
  "id" | "ownerId" | "requestorId" | "status" | "contentRepresentation"
  | "pauseRequestId" | "pauseRequestedAt" | "pauseReason">;
export type ProtectedTaskLifecycleRunState = Pick<TaskRun, "id" | "taskId" | "jobId" | "status">;

const protectedTaskLifecycleStateProjection = {
  id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId,
  status: tasks.status, contentRepresentation: tasks.contentRepresentation,
  pauseRequestId: tasks.pauseRequestId, pauseRequestedAt: tasks.pauseRequestedAt,
  pauseReason: tasks.pauseReason,
};
const protectedTaskLifecycleRunProjection = {
  id: taskRuns.id, taskId: taskRuns.taskId, jobId: taskRuns.jobId, status: taskRuns.status,
};

/** Pause shares the parent-row lock with resume admission and finalization. */
export async function transitionTaskLifecyclePaused(
  db: DirectDatabase,
  taskId: string,
): Promise<{
  task: Task | undefined;
  run: TaskRun | undefined;
  protectedTask?: ProtectedTaskLifecycleTaskState;
  transitioned: boolean;
  outcome: "transitioned" | "not_found" | "already_paused" | "task_terminal"
    | "writer_review_pending" | "protected_checkpoint_required";
}> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select(protectedTaskLifecycleStateProjection).from(tasks)
      .where(eq(tasks.id, taskId)).limit(1).for("update");
    if (!locked) return { task: undefined, run: undefined, transitioned: false, outcome: "not_found" };
    // Conversion and lifecycle controls share this lock. A stale ordinary
    // caller receives only structural protected state, never Shadow siblings.
    if (locked.contentRepresentation !== "ordinary") {
      return { task: undefined, run: undefined, protectedTask: locked, transitioned: false,
        outcome: "protected_checkpoint_required" };
    }
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId),
      eq(tasks.contentRepresentation, "ordinary"))).limit(1);
    if (!task) throw new Error("pause lost its locked ordinary Task");
    if (task.status === "paused") {
      // Explicit Pause disables automatic reconnect, while preserving the
      // original Run for a later explicit Resume.
      if (task.lastError === TASK_LOCAL_EXECUTION_OFFLINE_TEXT) {
        const [held] = await tx.update(tasks).set({ lastError: TASK_LOCAL_EXECUTION_MANUAL_PAUSE_TEXT,
          updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
        return { task: held ?? task, run: undefined, transitioned: false, outcome: "already_paused" };
      }
      return { task, run: undefined, transitioned: false, outcome: "already_paused" };
    }
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
    const [latest] = await tx.select({ id: taskRuns.id, status: taskRuns.status,
      resultRepresentation: taskRuns.resultRepresentation }).from(taskRuns).where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt)).limit(1).for("update");
    if (latest !== undefined && latest.resultRepresentation !== "ordinary") {
      return { task: undefined, run: undefined, protectedTask: locked, transitioned: false,
        outcome: "protected_checkpoint_required" };
    }
    let run: TaskRun | undefined;
    if (latest?.status === "running" || latest?.status === "awaiting") {
      [run] = await tx.update(taskRuns).set({ status: "paused" })
        .where(and(eq(taskRuns.id, latest.id), eq(taskRuns.resultRepresentation, "ordinary"))).returning();
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
  protectedTask?: ProtectedTaskLifecycleTaskState;
  protectedRun?: ProtectedTaskLifecycleRunState;
  /** True only for the transaction which won the Task-row terminal transition. */
  transitioned: boolean;
  /** Distinguishes a same-terminal report-back retry from a Stop winner. */
  outcome: "transitioned" | "same_terminal" | "task_terminal" | "run_terminal" | "not_running" | "writer_review_pending" | "not_found" | "authority_changed";
}

export interface TransitionTaskLifecycleTerminalInput {
  taskId: string;
  /** Selective cancellation may only stop this Human's exact current run. */
  expectedInvocation?: {
    humanUserId: string;
    taskRunId: string;
    /** Bind a durable Job stop to the exact Job still attached to this run. */
    jobId?: string;
  };
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
  /** An approval-resumed cron occurrence owns a running Task until it settles.
   * Return only that latest exact pair to the already-advanced schedule. */
  returnRecurringTaskToPending?: boolean;
  /** Stop-only durable fence for a Writer Artifact mutation already reserved. */
  blockPendingWriterWorkspaceAcceptance?: boolean;
}

type ProtectedTaskLifecycleRun = Pick<TaskRun, "id" | "jobId">;
type ProtectedTaskLifecycleTask = Pick<
  Task,
  "id" | "requestorId" | "contentRepresentation" | "cryptoObjectId"
>;
type ProtectedTaskLifecycleJob = Pick<
  Job,
  | "id"
  | "ownerId"
  | "requestorId"
  | "laneKey"
  | "type"
  | "status"
  | "input"
  | "startedAt"
  | "completedAt"
> & Readonly<{
  resultIsNull: boolean;
  messageIsNull: boolean;
}>;
type ProtectedTaskLifecycleTx = Pick<DirectDatabase, "select" | "update">;

type ProtectedTaskLifecycleJobDisposition =
  | "active"
  | "cancelled"
  | "completed"
  | "failed"
  | "timed_out"
  | "invalid";

function protectedTaskLifecycleJobDisposition(
  job: ProtectedTaskLifecycleJob,
): ProtectedTaskLifecycleJobDisposition {
  if (job.status === "queued"
    && job.startedAt === null
    && job.completedAt === null) return "active";
  if (job.status === "running"
    && job.startedAt !== null
    && job.completedAt === null) return "active";
  if (job.status === "cancelled" && job.completedAt !== null) {
    return "cancelled";
  }
  if (job.status === "completed"
    && job.startedAt !== null
    && job.completedAt !== null) return "completed";
  if ((job.status === "failed" || job.status === "timed_out")
    && job.completedAt !== null) return job.status;
  return "invalid";
}

function exactProtectedTaskLifecycleJobIdentity(
  task: ProtectedTaskLifecycleTask,
  run: ProtectedTaskLifecycleRun,
  job: ProtectedTaskLifecycleJob,
  expectedJobId: string,
): job is ProtectedTaskLifecycleJob & { input: ProtectedTaskDurableJobReference } {
  if (
    job.id !== expectedJobId
    || run.jobId !== job.id
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || !job.resultIsNull
    || !job.messageIsNull
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || job.input === null
    || typeof job.input !== "object"
    || Array.isArray(job.input)
  ) return false;
  const reference = job.input as ProtectedTaskDurableJobReference;
  return reference.kind === "protected_task_run_v1"
    && typeof reference.authorizationRequestId === "string"
    && reference.authorizationRequestId.length > 0
    && Number.isSafeInteger(reference.policyRevision)
    && reference.policyRevision > 0
    && exactProtectedTaskJobReference(reference, reference)
    && reference.taskId === task.id
    && reference.taskRunId === run.id
    && reference.inputObjectId === task.cryptoObjectId
    && reference.resultObjectId
      === protectedTaskRunResultObjectId(task.id, run.id);
}

function exactProtectedTaskLifecycleJob(
  task: ProtectedTaskLifecycleTask,
  run: ProtectedTaskLifecycleRun,
  job: ProtectedTaskLifecycleJob,
  expectedJobId: string,
): job is ProtectedTaskLifecycleJob & { input: ProtectedTaskDurableJobReference } {
  const disposition = protectedTaskLifecycleJobDisposition(job);
  return exactProtectedTaskLifecycleJobIdentity(task, run, job, expectedJobId)
    && (disposition === "active" || disposition === "cancelled");
}

async function lockProtectedTaskLifecycleJob(
  tx: Pick<DirectDatabase, "select">,
  jobId: string,
): Promise<ProtectedTaskLifecycleJob | undefined> {
  const projection = {
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  };
  const [job] = await tx.select(projection).from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
    .for("update");
  return job;
}

async function cancelProtectedTaskLifecycleJob(
  tx: ProtectedTaskLifecycleTx,
  job: ProtectedTaskLifecycleJob & { input: ProtectedTaskDurableJobReference },
): Promise<boolean> {
  if (protectedTaskLifecycleJobDisposition(job) === "cancelled") return true;
  const [cancelledJob] = await tx.update(jobs).set({
    status: "cancelled",
    completedAt: new Date(),
  }).where(and(
    eq(jobs.id, job.id),
    inArray(jobs.status, ["queued", "running"]),
    isNull(jobs.completedAt),
    isNull(jobs.result),
    isNull(jobs.message),
    eq(jobs.input, job.input),
  )).returning({ id: jobs.id });
  return cancelledJob !== undefined;
}

/** Stop needs structural state only; ordinary result writers never enter here. */
async function transitionProtectedTaskLifecycleStop(
  tx: Pick<DirectDatabase, "select" | "update" | "insert">,
  task: ProtectedTaskLifecycleTaskState & Pick<Task, "cryptoObjectId"> & Readonly<{
    requiresLocalRecapture: boolean; writerReviewPending: boolean;
  }>,
  input: TransitionTaskLifecycleTerminalInput,
): Promise<TerminalTaskLifecycleTransition> {
  let state: ProtectedTaskLifecycleTaskState = {
    id: task.id, ownerId: task.ownerId, requestorId: task.requestorId, status: task.status,
    contentRepresentation: task.contentRepresentation, pauseRequestId: task.pauseRequestId,
    pauseRequestedAt: task.pauseRequestedAt, pauseReason: task.pauseReason,
  };
  let run: ProtectedTaskLifecycleRunState | undefined;
  const result = (outcome: TerminalTaskLifecycleTransition["outcome"], transitioned = false): TerminalTaskLifecycleTransition => ({
    task: undefined, run: undefined, protectedTask: state,
    ...(run === undefined ? {} : { protectedRun: run }), transitioned, outcome,
  });
  if (input.taskStatus !== "cancelled" || input.runStatus !== "cancelled"
    || input.runPatch?.resultText !== undefined || input.runPatch?.lastError !== undefined
    || input.taskPatch?.lastError !== undefined) return result("authority_changed");
  let expectedJob: (ProtectedTaskLifecycleJob & { input: ProtectedTaskDurableJobReference }) | undefined;
  if (input.expectedInvocation) {
    const expectedJobId = input.expectedInvocation.jobId;
    const predicate = and(eq(taskRuns.taskId, task.id), eq(taskRuns.id, input.expectedInvocation.taskRunId));
    const [expected]: Array<Pick<TaskRun, "id"> & { jobId?: string | null }> = expectedJobId === undefined
      ? await tx.select({ id: taskRuns.id }).from(taskRuns).where(predicate).for("update")
      : await tx.select({ id: taskRuns.id, jobId: taskRuns.jobId }).from(taskRuns).where(predicate).for("update");
    const [newer] = expected ? await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(
      eq(taskRuns.taskId, task.id), sql`${taskRuns.id} <> ${expected.id}::uuid`,
      sql`${taskRuns.startedAt} >= (SELECT started_at FROM task_runs WHERE id = ${expected.id}::uuid)`,
    )).limit(1) : [];
    if (task.requestorId !== input.expectedInvocation.humanUserId || !expected || newer
      || expectedJobId !== undefined && expected.jobId !== expectedJobId) return result("authority_changed");
    if (expectedJobId !== undefined) {
      const job = await lockProtectedTaskLifecycleJob(tx, expectedJobId);
      if (!job || !exactProtectedTaskLifecycleJob(task, { id: expected.id, jobId: expectedJobId }, job, expectedJobId)) return result("authority_changed");
      expectedJob = job;
    }
  }
  if (input.blockPendingWriterWorkspaceAcceptance === true && task.writerReviewPending) return result("writer_review_pending");
  if (input.runId) {
    [run] = await tx.select(protectedTaskLifecycleRunProjection).from(taskRuns)
      .where(and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId))).limit(1).for("update");
  } else {
    [run] = await tx.select(protectedTaskLifecycleRunProjection).from(taskRuns)
      .where(and(eq(taskRuns.taskId, input.taskId),
        sql`${taskRuns.status} NOT IN ('completed', 'cancelled', 'errored')`))
      .orderBy(desc(taskRuns.startedAt)).limit(1).for("update");
  }
  if (typeof run?.jobId === "string" && expectedJob === undefined) {
    const linked = await lockProtectedTaskLifecycleJob(tx, run.jobId);
    if (!linked || !exactProtectedTaskLifecycleJobIdentity(task, run, linked, run.jobId)) return result("authority_changed");
    const disposition = protectedTaskLifecycleJobDisposition(linked);
    if (disposition === "active" || disposition === "cancelled") expectedJob = linked;
    else if (disposition !== "completed" && disposition !== "failed" && disposition !== "timed_out") return result("authority_changed");
  }
  const cancelJob = async () => {
    if (expectedJob !== undefined && expectedJob.status !== "cancelled"
      && !await cancelProtectedTaskLifecycleJob(tx, expectedJob)) throw new Error("Task stop lost its locked protected Job");
  };
  if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
    const same = Boolean(input.runId) && task.status === input.taskStatus && run?.status === input.runStatus;
    if (same && expectedJob !== undefined && expectedJob.status !== "cancelled") {
      await cancelJob();
      return result("transitioned", true);
    }
    return result(same ? "same_terminal" : "task_terminal");
  }
  if (input.runId && task.requiresLocalRecapture) return result("authority_changed");
  if (input.requireRunningPair && (task.status !== "running" || run?.status !== "running")) return result("not_running");
  if (input.runId && (!run || TERMINAL_TASK_RUN_STATUSES.includes(run.status as (typeof TERMINAL_TASK_RUN_STATUSES)[number])
    && run.status !== input.runStatus)) return result("run_terminal");
  await cancelJob();
  const stoppedAt = input.taskPatch?.cancelledAt ?? new Date();
  if (!run) {
    const [inserted] = await tx.insert(taskRuns).values({ taskId: task.id,
      graphThreadId: `task-cancelled:${task.id}`, status: "cancelled", startedAt: stoppedAt,
      completedAt: stoppedAt }).returning(protectedTaskLifecycleRunProjection);
    if (!inserted) throw new Error("Protected Task Stop lost its history receipt");
    run = inserted;
  } else if (run.status !== "cancelled") {
    const [updated] = await tx.update(taskRuns).set({ status: "cancelled", completedAt: stoppedAt })
      .where(eq(taskRuns.id, run.id)).returning(protectedTaskLifecycleRunProjection);
    run = updated ?? run;
  }
  const [updated] = await tx.update(tasks).set({ ...input.taskPatch, status: "cancelled",
    cancelledAt: stoppedAt, pauseRequestId: null, pauseRequestedAt: null, pauseReason: null,
    updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning(protectedTaskLifecycleStateProjection);
  state = updated ?? state;
  return result("transitioned", true);
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
  if (
    input.expectedInvocation?.jobId !== undefined
    && (input.taskStatus !== "cancelled"
      || input.runStatus !== "cancelled"
      || input.runId !== input.expectedInvocation.taskRunId)
  ) {
    throw new TypeError("Job-bound Task terminal transition must be an exact Stop");
  }
  if (input.returnRecurringTaskToPending && (!input.requireRunningPair || !input.runId
    || (input.runStatus !== "completed" && input.runStatus !== "errored") || input.taskStatus)) {
    throw new TypeError("Recurring completion requires an exact running pair");
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ ...protectedTaskLifecycleStateProjection,
      cryptoObjectId: tasks.cryptoObjectId,
      requiresLocalRecapture: sql<boolean>`(${tasks.localExecutionDelegation} IS NULL AND ${tasks.lastError} IS NOT DISTINCT FROM ${TASK_LOCAL_EXECUTION_RECREATE_TEXT})`,
      writerReviewPending: sql<boolean>`coalesce((
        ${tasks.metadata}->${WRITER_REVIEW_AWAITING_METADATA_KEY}->'version' = '1'::jsonb
        AND jsonb_typeof(${tasks.metadata}->${WRITER_REVIEW_AWAITING_METADATA_KEY}->'pendingWorkspaceOperationId') = 'string'
        AND jsonb_typeof(${tasks.metadata}->${WRITER_REVIEW_AWAITING_METADATA_KEY}->'pendingWorkspaceClientMutationId') = 'string'), false)`,
    }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!locked) return { task: undefined, run: undefined, transitioned: false, outcome: "not_found" };
    if (locked.contentRepresentation !== "ordinary") {
      return transitionProtectedTaskLifecycleStop(tx, locked, input);
    }
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, input.taskId),
      eq(tasks.contentRepresentation, "ordinary"))).limit(1);
    if (!task) throw new Error("terminal transition lost its locked ordinary Task");
    if (input.expectedInvocation) {
      const expectedJobId = input.expectedInvocation.jobId;
      const expectedRunPredicate = and(
        eq(taskRuns.taskId, task.id),
        eq(taskRuns.id, input.expectedInvocation.taskRunId),
      );
      const [expected]: Array<Pick<TaskRun, "id"> & {
        jobId?: string | null;
      }> = expectedJobId === undefined
        ? await tx.select({ id: taskRuns.id }).from(taskRuns)
            .where(expectedRunPredicate).for("update")
        : await tx.select({ id: taskRuns.id, jobId: taskRuns.jobId }).from(taskRuns)
            .where(expectedRunPredicate).for("update");
      // Compare database timestamps without JS millisecond truncation. An
      // ambiguous tie is not authority to stop either run.
      const [newer] = expected ? await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(
        eq(taskRuns.taskId, task.id), sql`${taskRuns.id} <> ${expected.id}::uuid`,
        sql`${taskRuns.startedAt} >= (SELECT started_at FROM task_runs WHERE id = ${expected.id}::uuid)`,
      )).limit(1) : [];
      if (
        task.requestorId !== input.expectedInvocation.humanUserId
        || !expected
        || newer
        || (expectedJobId !== undefined && expected.jobId !== expectedJobId)
      ) {
        return { task, run: undefined, transitioned: false, outcome: "authority_changed" };
      }
      // A Job-bound invocation is exclusively a protected execution Stop.
      if (expectedJobId !== undefined) return { task, run: undefined, transitioned: false, outcome: "authority_changed" };
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

    let selectedRun: Pick<TaskRun, "id" | "resultRepresentation"> | undefined;
    if (input.runId) {
      [selectedRun] = await tx
        .select({ id: taskRuns.id, resultRepresentation: taskRuns.resultRepresentation })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)))
        .limit(1)
        .for("update");
    } else if (input.runStatus) {
      [selectedRun] = await tx
        .select({ id: taskRuns.id, resultRepresentation: taskRuns.resultRepresentation })
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

    if (selectedRun !== undefined && selectedRun.resultRepresentation !== "ordinary") {
      return { task, run: undefined, transitioned: false, outcome: "authority_changed" };
    }
    const [run] = selectedRun === undefined ? [] : await tx.select().from(taskRuns)
      .where(and(eq(taskRuns.id, selectedRun.id), eq(taskRuns.taskId, input.taskId),
        eq(taskRuns.resultRepresentation, "ordinary"))).limit(1).for("update");
    if (selectedRun !== undefined && run === undefined) throw new Error("terminal transition lost its locked ordinary Run");

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

    // Old workers cannot terminalize a definition whose project consent was removed.
    // Human Stop has no runId and remains available.
    if (input.runId && taskRequiresLocalExecutionRecapture(task)) {
      return { task, run: run ? await cancelTaskRunForLocalExecutionRecapture(tx, run) : run,
        transitioned: false, outcome: "authority_changed" };
    }

    if (input.returnRecurringTaskToPending) {
      const [latest] = await tx.select({ id: taskRuns.id }).from(taskRuns)
        .where(eq(taskRuns.taskId, task.id)).orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1).for("update");
      if (task.scheduleKind !== "cron" || latest?.id !== run?.id) {
        return { task, run, transitioned: false, outcome: "not_running" };
      }
      // A failed report-back may retry its already committed outcome. This
      // returns evidence only, without rearming a paused or newer occurrence.
      if (task.status === "pending" && run?.status === input.runStatus) {
        return { task, run, transitioned: false, outcome: "same_terminal" };
      }
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
        .where(and(eq(taskRuns.id, run.id), eq(taskRuns.resultRepresentation, "ordinary")))
        .returning();
      nextRun = updatedRun ?? run;
    }

    let nextTask = task;
    if (input.taskStatus || input.returnRecurringTaskToPending) {
      const [updatedTask] = await tx
        .update(tasks)
        .set({ ...input.taskPatch,
          ...(input.returnRecurringTaskToPending
            ? { status: "pending" as const, fireLockId: null, fireLockedAt: null }
            : { status: input.taskStatus! }), updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.contentRepresentation, "ordinary")))
        .returning();
      nextTask = updatedTask ?? task;
    }

    return { task: nextTask, run: nextRun, transitioned: true, outcome: "transitioned" };
  });
}

/**
 * Payload-free executable Task aggregate used by
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
  db: Pick<DirectDatabase, "select">,
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
 * The run to RESUME on an unpause re-dispatch. Returns the task's
 * newest run, but ONLY if it is `paused`; supplies the `graphThreadId` the
 * resume must REUSE so the preserved LangGraph checkpoint matches (rather than
 * minting a fresh orphan thread). Returns `undefined` when the newest run is
 * not paused — critically, this prevents a later cron fire (whose previous run
 * already completed) from wrongly resuming a stale earlier checkpoint.
 */
type TaskFundingRunProjection = Readonly<Pick<TaskRun,
  | "id" | "taskId" | "jobId" | "graphThreadId" | "status" | "modelId"
  | "fundingBinding" | "fundingPredecessorRunId"
>>;

export function getLatestResumableTaskRun(
  db: DirectDatabase,
  taskId: string,
): Promise<TaskRun | undefined>;
export function getLatestResumableTaskRun(
  db: DirectDatabase,
  taskId: string,
  projection: Readonly<{ fundingOnly: true }>,
): Promise<TaskFundingRunProjection | undefined>;
export async function getLatestResumableTaskRun(
  db: DirectDatabase,
  taskId: string,
  projection?: Readonly<{ fundingOnly: true }>,
): Promise<TaskRun | TaskFundingRunProjection | undefined> {
  if (projection?.fundingOnly !== true) {
    const [row] = await db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt))
      .limit(1);
    return row?.status === "paused" ? row : undefined;
  }
  const [row] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      jobId: taskRuns.jobId,
      graphThreadId: taskRuns.graphThreadId,
      status: taskRuns.status,
      modelId: taskRuns.modelId,
      fundingBinding: taskRuns.fundingBinding,
      fundingPredecessorRunId: taskRuns.fundingPredecessorRunId,
    })
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(desc(taskRuns.startedAt))
    .limit(1);
  return row?.status === "paused" ? row : undefined;
}

/**
 * An in-flight artifact-originated wake for coalescing. Returns a
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
 * The newest `awaiting` task whose run is parked on this
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
 * Persist an exact operation identity before Writer invokes its one
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

/** Clear an uncommitted reservation after a definite canonical-save failure. */
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
      eq(tasks.contentRepresentation, "ordinary"),
      eq(taskRuns.resultRepresentation, "ordinary"),
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
      eq(tasks.contentRepresentation, "ordinary"),
      eq(taskRuns.resultRepresentation, "ordinary"),
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
      eq(tasks.contentRepresentation, "ordinary"),
      eq(taskRuns.resultRepresentation, "ordinary"),
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
 * The awaiting task + run for an approval/PIN/identity resume, matched by
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
  if (row) return { task: row.task, run: row.run };

  const [protectedCron] = await db.select({
    task: tasks,
    run: taskRuns,
    parkReceipt: sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
  }).from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .where(and(
      eq(tasks.id, taskId),
      eq(taskRuns.graphThreadId, graphThreadId),
      eq(tasks.scheduleKind, "cron"),
      eq(tasks.status, "pending"),
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
      eq(tasks.cryptoMappingState, "verified"),
      eq(taskRuns.status, "awaiting"),
      eq(jobs.status, "completed"),
      excludesWriterReviewAwaitingPredicate(),
    )).orderBy(desc(taskRuns.startedAt)).limit(1);
  if (!protectedCron || !isRecord(protectedCron.parkReceipt)) return undefined;
  try {
    const interrupts = canonicalInterruptCoordinates(
      protectedCron.parkReceipt["interrupts"] as
        readonly ProtectedTaskRunInterruptCoordinate[],
    );
    return interrupts.some(interrupt => interrupt.kind === "approval")
      ? { task: protectedCron.task, run: protectedCron.run }
      : undefined;
  } catch {
    return undefined;
  }
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
  options?: { approvalRecipient: true },
): Promise<Array<{ task: Task; run: TaskRun }>> {
  return db
    .selectDistinctOn([taskRuns.taskId], { task: tasks, run: taskRuns })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        options?.approvalRecipient
          ? or(and(isNull(tasks.localExecutionDelegation), eq(tasks.ownerId, ownerId)),
            and(isNotNull(tasks.localExecutionDelegation), eq(tasks.requestorId, ownerId)))
          : eq(tasks.ownerId, ownerId),
        eq(tasks.contentRepresentation, "ordinary"),
        eq(tasks.status, "awaiting"),
        eq(taskRuns.status, "awaiting"),
        excludesWriterReviewAwaitingPredicate(),
      ),
    )
    .orderBy(taskRuns.taskId, desc(taskRuns.startedAt));
}

/**
 * The time-limit watchdog scan. Returns every `running` task with
 * a non-null `time_limit_seconds` whose active (running, job-linked) run has
 * been executing longer than its budget (`started_at + time_limit_seconds <
 * now`). The observer pauses each one via `pauseTask`.
 */
export async function findTimedOutRunningTasks(
  db: DirectDatabase,
  now: Date,
): Promise<Array<{ task: Pick<Task, "id" | "contentRepresentation"> }>> {
  const rows = await db
    .select({ task: { id: tasks.id, contentRepresentation: tasks.contentRepresentation } })
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
          isNull(tasks.pauseRequestId),
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
  | Readonly<{ status: "prepared"; task: Task & ProtectedDefinitionHistoricalMetadata; run: TaskRun }>
  | Readonly<{ status: "stale" }>;

/** Exact mapped ledger metadata; no ciphertext or source text enters occurrence discovery. */
export const protectedTaskDefinitionHistoricalRepairProjection = sql<TaskDefinitionCryptoRevision["historicalRepair"]>`(${new QueryBuilder()
  .select({ historicalRepair: taskDefinitionCryptoRevisions.historicalRepair })
  .from(taskDefinitionCryptoRevisions).where(and(
    eq(taskDefinitionCryptoRevisions.taskId, tasks.id),
    eq(taskDefinitionCryptoRevisions.contentRevision, tasks.contentRevision),
    eq(taskDefinitionCryptoRevisions.contentNamespaceId, tasks.contentNamespaceId),
    eq(taskDefinitionCryptoRevisions.cryptoObjectId, tasks.cryptoObjectId),
    eq(taskDefinitionCryptoRevisions.cryptoAccessRevision, 0),
    eq(taskDefinitionCryptoRevisions.representation, tasks.contentRepresentation),
    eq(taskDefinitionCryptoRevisions.requiredNamespaceFingerprint, tasks.cryptoRequiredNamespaceFingerprint),
    eq(taskDefinitionCryptoRevisions.completion, "complete"),
    eq(taskDefinitionCryptoRevisions.disposition, "mapped"),
    isNull(taskDefinitionCryptoRevisions.failureCode),
  )).limit(1)})`;

type ProtectedDefinitionHistoricalMetadata = Readonly<{
  definitionHistoricalRepair?: Readonly<Record<string, unknown>> | null;
}>;

function copyDefinitionHistoricalMetadata(task: ProtectedDefinitionHistoricalMetadata): ProtectedDefinitionHistoricalMetadata {
  return task.definitionHistoricalRepair == null ? {} : {
    definitionHistoricalRepair: Object.freeze(structuredClone(task.definitionHistoricalRepair)),
  };
}

export type ProtectedAwaitingTaskRunCursor = Readonly<{
  taskRunId: string;
}>;

export type ProtectedAwaitingTaskRunForAuthorization = Readonly<{
  task: Pick<Task,
    | "id"
    | "ownerId"
    | "requestorId"
    | "agentId"
    | "callingRoomId"
    | "scheduleKind"
    | "contentRepresentation"
    | "contentNamespaceId"
    | "contentRevision"
    | "cryptoObjectId"
    | "cryptoAccessRevision"
    | "cryptoRequiredNamespaceFingerprint"
  > & ProtectedDefinitionHistoricalMetadata;
  run: Pick<TaskRun,
    | "id"
    | "taskId"
    | "jobId"
    | "graphThreadId"
    | "status"
    | "startedAt"
  >;
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
): Promise<ProtectedAwaitingTaskRunForAuthorization[]> {
  if (batch <= 0) return [];
  const rows = await db
    .select({
      task: {
        id: tasks.id,
        ownerId: tasks.ownerId,
        requestorId: tasks.requestorId,
        agentId: tasks.agentId,
        callingRoomId: tasks.callingRoomId,
        scheduleKind: tasks.scheduleKind,
        contentRepresentation: tasks.contentRepresentation,
        contentNamespaceId: tasks.contentNamespaceId,
        contentRevision: tasks.contentRevision,
        cryptoObjectId: tasks.cryptoObjectId,
        definitionHistoricalRepair: protectedTaskDefinitionHistoricalRepairProjection,
        cryptoAccessRevision: tasks.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          tasks.cryptoRequiredNamespaceFingerprint,
      },
      run: {
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        jobId: taskRuns.jobId,
        graphThreadId: taskRuns.graphThreadId,
        status: taskRuns.status,
        startedAt: taskRuns.startedAt,
      },
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(and(
      eq(taskRuns.status, "awaiting"),
      isNull(tasks.pauseRequestId),
      inArray(tasks.status, ["pending", "awaiting", "running"]),
      inArray(tasks.contentRepresentation, ["dual", "protected"]),
      eq(tasks.cryptoMappingState, "verified"),
      after ? gt(taskRuns.id, after.taskRunId) : undefined,
    ))
    .orderBy(asc(taskRuns.id))
    .limit(batch);
  return rows.map(({ task, run }) => {
    const { definitionHistoricalRepair, ...ordinaryShape } = task;
    return { task: { ...ordinaryShape, ...copyDefinitionHistoricalMetadata({ definitionHistoricalRepair }) }, run };
  });
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
      .select({ ...getTableColumns(tasks), definitionHistoricalRepair: protectedTaskDefinitionHistoricalRepairProjection })
      .from(tasks)
      .where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, "pending"),
        isNull(tasks.pauseRequestId),
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
    if (!task || task.pauseRequestId != null) return { status: "stale" } as const;

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
    return { status: "prepared", task: { ...updatedTask, ...copyDefinitionHistoricalMetadata(task) }, run } as const;
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
  /** Present only on an authority-resumed segment; binds its immutable proof. */
  resumeContinuationFingerprint?: string;
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

function sameBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
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
  const acceptance = expected.resumeAcceptanceId;
  const continuation = expected.resumeContinuationFingerprint;
  const expectedKeys = acceptance !== undefined
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
    : continuation !== undefined
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId";
  return (expected.executionSegment === 1
      ? acceptance === undefined && continuation === undefined
      : (opaqueCheckpointCoordinate(acceptance)
        && continuation === undefined)
        || (acceptance === undefined
          && canonicalContinuationFingerprint(continuation)))
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
    && reference["resumeAcceptanceId"] === acceptance
    && reference["resumeContinuationFingerprint"] === continuation;
}

function exactCancelledProtectedTaskContinuationOrphan(
  task: ProtectedTaskLifecycleTask,
  run: ProtectedTaskLifecycleRun,
  job: ProtectedTaskLifecycleJob,
  input: SettleCancelledProtectedTaskRunAuthorizationInput,
): job is ProtectedTaskLifecycleJob & { input: ProtectedTaskDurableJobReference } {
  if (job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "queued"
    || job.startedAt !== null
    || job.completedAt !== null
    || !job.resultIsNull
    || !job.messageIsNull
    || job.input === null
    || typeof job.input !== "object"
    || Array.isArray(job.input)) return false;
  const reference = job.input as ProtectedTaskDurableJobReference;
  return reference.kind === "protected_task_run_v1"
    && reference.taskId === task.id
    && reference.taskRunId === run.id
    && reference.inputObjectId === task.cryptoObjectId
    && reference.resultObjectId
      === protectedTaskRunResultObjectId(task.id, run.id)
    && reference.authorizationRequestId === input.authorizationRequestId
    && reference.policyRevision === input.policyRevision
    && Number.isSafeInteger(reference.executionSegment)
    && reference.executionSegment > 1
    && reference.resumeAcceptanceId === undefined
    && canonicalContinuationFingerprint(
      reference.resumeContinuationFingerprint,
    )
    && exactProtectedTaskJobReference(reference, reference);
}

async function lockCancelledProtectedTaskContinuationOrphans(
  tx: Pick<DirectDatabase, "select">,
  task: ProtectedTaskLifecycleTask,
  run: ProtectedTaskLifecycleRun,
  input: SettleCancelledProtectedTaskRunAuthorizationInput,
): Promise<Array<ProtectedTaskLifecycleJob & {
  input: ProtectedTaskDurableJobReference;
}>> {
  const rows = await tx.select({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(and(
    eq(jobs.ownerId, task.requestorId),
    eq(jobs.requestorId, task.requestorId),
    eq(jobs.laneKey, `task:${task.id}`),
    eq(jobs.type, "foreground"),
    eq(jobs.status, "queued"),
    isNull(jobs.startedAt),
    isNull(jobs.completedAt),
    isNull(jobs.result),
    isNull(jobs.message),
    run.jobId === null ? undefined : ne(jobs.id, run.jobId),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
    sql`${jobs.input} ->> 'taskId' = ${task.id}`,
    sql`${jobs.input} ->> 'taskRunId' = ${run.id}`,
    sql`${jobs.input} ->> 'inputObjectId' = ${task.cryptoObjectId}`,
    sql`${jobs.input} ->> 'resultObjectId' = ${
      protectedTaskRunResultObjectId(task.id, run.id)
    }`,
    sql`${jobs.input} ->> 'authorizationRequestId' = ${
      input.authorizationRequestId
    }`,
    sql`${jobs.input} ->> 'policyRevision' = ${String(input.policyRevision)}`,
    sql`${jobs.input} ? 'resumeContinuationFingerprint'`,
  )).orderBy(asc(jobs.id)).for("update");
  return rows.filter(job => exactCancelledProtectedTaskContinuationOrphan(
    task,
    run,
    job,
    input,
  ));
}

export type SettleCancelledProtectedTaskRunAuthorizationInput = Readonly<{
  taskRunId: string;
  contentNamespaceId: string;
  authorizationRequestId: string;
  policyRevision: number;
}>;

/**
 * Revoke one protected Task runtime authorization only while its exact product
 * Task and TaskRun remain durably cancelled. The callback owns the crypto
 * transaction; product locks stay held until linked and exact pre-link Job
 * cleanup commits in this transaction.
 */
export async function settleCancelledProtectedTaskRunAuthorization(
  db: DirectDatabase,
  input: SettleCancelledProtectedTaskRunAuthorizationInput,
  cancelAuthorization: () => Promise<boolean>,
): Promise<boolean> {
  if (
    input.taskRunId.length === 0
    || input.contentNamespaceId.length === 0
    || input.authorizationRequestId.length === 0
    || !Number.isSafeInteger(input.policyRevision)
    || input.policyRevision < 1
    || typeof cancelAuthorization !== "function"
  ) {
    throw new TypeError("Protected Task cancellation settlement is invalid");
  }

  const [located] = await db.select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(eq(taskRuns.id, input.taskRunId))
    .limit(1);
  if (!located) return false;

  return db.transaction(async (tx) => {
    const [task] = await tx.select({
      id: tasks.id,
      requestorId: tasks.requestorId,
      status: tasks.status,
      contentRepresentation: tasks.contentRepresentation,
      contentNamespaceId: tasks.contentNamespaceId,
      cryptoObjectId: tasks.cryptoObjectId,
    }).from(tasks)
      .where(eq(tasks.id, located.taskId))
      .limit(1)
      .for("update");
    if (
      !task
      || task.status !== "cancelled"
      || task.contentRepresentation !== "dual"
        && task.contentRepresentation !== "protected"
      || task.contentNamespaceId !== input.contentNamespaceId
      || task.cryptoObjectId === null
      || task.cryptoObjectId.length === 0
    ) return false;

    const [run] = await tx.select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
      jobId: taskRuns.jobId,
      status: taskRuns.status,
    }).from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, task.id),
      ))
      .limit(1)
      .for("update");
    if (!run || run.status !== "cancelled") return false;

    let linkedJob: (ProtectedTaskLifecycleJob & {
      input: ProtectedTaskDurableJobReference;
    }) | undefined;
    if (run.jobId !== null) {
      const job = await lockProtectedTaskLifecycleJob(tx, run.jobId);
      if (!job || !exactProtectedTaskLifecycleJobIdentity(
        task,
        { id: run.id, jobId: run.jobId },
        job,
        run.jobId,
      )) return false;
      const disposition = protectedTaskLifecycleJobDisposition(job);
      if (disposition === "active") linkedJob = job;
      else if (disposition !== "cancelled"
        && disposition !== "completed"
        && disposition !== "failed"
        && disposition !== "timed_out") {
        return false;
      }
    }
    const continuationOrphans =
      await lockCancelledProtectedTaskContinuationOrphans(tx, task, run, input);

    if (!await cancelAuthorization()) return false;

    if (linkedJob !== undefined
      && !await cancelProtectedTaskLifecycleJob(tx, linkedJob)) {
      throw new Error("Protected Task cancellation lost its linked Job");
    }
    for (const orphan of continuationOrphans) {
      if (!await cancelProtectedTaskLifecycleJob(tx, orphan)) {
        throw new Error(
          "Protected Task cancellation lost its queued continuation Job",
        );
      }
    }

    const initialReference: ProtectedTaskDurableJobReference = Object.freeze({
      kind: "protected_task_run_v1",
      taskId: task.id,
      taskRunId: run.id,
      inputObjectId: task.cryptoObjectId,
      resultObjectId: protectedTaskRunResultObjectId(task.id, run.id),
      authorizationRequestId: input.authorizationRequestId,
      policyRevision: input.policyRevision,
      executionSegment: 1,
    });
    await tx.update(jobs).set({
      status: "cancelled",
      completedAt: new Date(),
    }).where(and(
      eq(jobs.ownerId, task.requestorId),
      eq(jobs.requestorId, task.requestorId),
      eq(jobs.laneKey, `task:${task.id}`),
      eq(jobs.type, "foreground"),
      eq(jobs.status, "queued"),
      isNull(jobs.startedAt),
      isNull(jobs.completedAt),
      isNull(jobs.result),
      isNull(jobs.message),
      eq(jobs.input, initialReference),
    ));
    return true;
  });
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
    || input.jobReference.resumeContinuationFingerprint !== undefined
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
      task.pauseRequestId != null
      || task.status !== expectedTaskStatus
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

export const PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY =
  "nautilo.protectedTaskRunPark.v1";
export const PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY =
  "nautilo.protectedTaskHumanContinuationAcceptance.v1";
export const PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY =
  "nautilo.protectedTaskHumanApprovalPolicy.v1";
export const PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY =
  "nautilo.protectedTaskRunTerminal.v1";
const OPAQUE_CHECKPOINT_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONTINUATION_FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
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
  allowedVerbs?: readonly ApprovalReplyVerb[];
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

export type ProtectedTaskHumanContinuationAcceptance = Readonly<{
  acceptanceId: string;
  acceptedBy: Readonly<{ userId: string; humanActorId: string }>;
  interrupt: ProtectedTaskRunInterruptCoordinate;
  acceptedAt: Date;
  response:
    | Readonly<{
        kind: "approval";
        verb: "once" | "room" | "always" | "deny";
      }>
    | Readonly<{ kind: "prove_it"; approved: boolean }>
    | Readonly<{ kind: "identity" }>
    | Readonly<{
        kind: "await_reply";
        message: ProtectedTaskAwaitReplyMessageReference;
      }>;
}>;

export type AcceptProtectedTaskHumanContinuationInput = Readonly<{
  checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: Date;
  stableRoutingDigest: Uint8Array;
  priorJobReference: ProtectedTaskDurableJobReference;
  acceptance: ProtectedTaskHumanContinuationAcceptance;
}>;

export type AcceptProtectedTaskHumanContinuationResult =
  | Readonly<{
      status: "accepted" | "exact_replay";
      acceptance: ProtectedTaskHumanContinuationAcceptance;
    }>
  | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

export type ResolveParkedProtectedTaskHumanContinuationAcceptanceInput =
  Readonly<{
    taskId: string;
    graphThreadId: string;
    acceptedBy: Readonly<{ userId: string; humanActorId: string }>;
    interrupt: Readonly<{
      kind: Exclude<ProtectedTaskRunInterruptKind, "additional_authority">;
      id?: string;
      requestId?: string;
    }>;
  }>;

export type ResolveParkedProtectedTaskHumanContinuationAcceptanceResult =
  | Readonly<{ status: "no_match" | "ambiguous" }>
  | Readonly<{
      status: "resolved";
      input: Omit<AcceptProtectedTaskHumanContinuationInput, "acceptance">;
      interrupt: ProtectedTaskRunInterruptCoordinate;
    }>;

export type ResolvePublishedProtectedTaskAwaitReplyResult =
  | Readonly<{ status: "no_match" | "ambiguous" }>
  | Readonly<{
      status: "resolved";
      input: Omit<AcceptProtectedTaskHumanContinuationInput, "acceptance"> &
        Readonly<{
          acceptance: Omit<ProtectedTaskHumanContinuationAcceptance,
            "acceptanceId">;
        }>;
    }>;

type ResolvedPublishedProtectedTaskAwaitReplyInput = Extract<
  ResolvePublishedProtectedTaskAwaitReplyResult,
  { status: "resolved" }
>["input"];

export type ParkProtectedTaskRunInput = Readonly<{
  checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
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
    { kind: "pre_effect_interrupt_v1"; reason: "additional_authority" }
  >>, "reason"> & { reason: "additional_authority" }
>;

export type SealAndParkProtectedTaskRunInput = Readonly<{
  park: ParkProtectedTaskRunInput;
  segment: SegmentReceiptEvidence;
  continuation: SealAndParkProtectedTaskRunContinuation;
}>;

export type SealAndParkProtectedTaskCheckpointRunInput = Readonly<{
  park: Omit<ParkProtectedTaskRunInput, "interrupts"> & Readonly<{ interrupts: readonly [] }>;
  segment: SegmentReceiptEvidence;
  continuation: Readonly<{
    kind: "checkpoint_safe_v1";
    reason: "manual_pause" | "time_limit" | "grant_refresh";
    effectDisposition: "none_v1";
  }>;
  pauseRequestId: string | null;
  stableRoutingDigest: Uint8Array;
}>;

export type SealAndParkProtectedTaskHumanRunInput = Readonly<{
  park: ParkProtectedTaskRunInput;
  segment: SegmentReceiptEvidence;
  stableRoutingDigest: Uint8Array;
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

export type SealAndParkProtectedTaskHumanRunResult = Exclude<
  SealAndParkProtectedTaskRunResult,
  Readonly<{ status: "rejected"; stage: "continuation"; reason: unknown }>
>;

/** Content-free Task projection accepted by parked-authority discovery. */
export type ParkedProtectedTaskAdditionalAuthorityTaskRow = ProtectedDefinitionHistoricalMetadata & Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
  scheduleKind: "now" | "one_shot" | "cron";
  status: string;
  contentRepresentation: "ordinary" | "dual" | "protected";
  contentNamespaceId: string | null;
  contentRevision: number;
  cryptoObjectId: string | null;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array | null;
  cryptoMappingState: "unmapped" | "verified" | "stale";
  /** Derived without returning prompt, expected output, or last-error text. */
  contentPristine: boolean;
}>;

/** Content-free TaskRun projection accepted by parked-authority discovery. */
export type ParkedProtectedTaskAdditionalAuthorityRunRow = Readonly<{
  id: string;
  taskId: string;
  jobId: string | null;
  graphThreadId: string;
  status: string;
  startedAt: Date;
  /** Derived without returning result, error, or funding payloads. */
  pristine: boolean;
}>;

/** Narrow prior-Job projection; only protected reference/park JSON is read. */
export type ParkedProtectedTaskAdditionalAuthorityJobRow = Readonly<{
  id: string;
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  reference: unknown;
  parkReceipt: unknown;
  /** Derived without returning Job result, message, or full metadata. */
  pristine: boolean;
}>;

export type ParkedProtectedTaskAdditionalAuthorityProof = Readonly<{
  segment: ProtectedTaskExecutionContinuationProof["segment"];
  continuation: Omit<
    ProtectedTaskExecutionContinuationProof["continuation"],
    "semanticAuthorityRequirements" | "stableRoutingDigest"
  > & Readonly<{
    stableRoutingDigest: Uint8Array;
    semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  }>;
}>;

export type ParkedProtectedTaskAdditionalAuthority = Readonly<{
  occurrence: Readonly<{
    task: ProtectedDefinitionHistoricalMetadata & Readonly<{
      id: string;
      ownerId: string;
      requestorId: string;
      agentId: string;
      callingRoomId: string | null;
      scheduleKind: "now" | "one_shot" | "cron";
      status: "awaiting" | "pending";
      contentRepresentation: "dual" | "protected";
      contentNamespaceId: string;
      contentRevision: number;
      cryptoObjectId: string;
      cryptoAccessRevision: number;
      cryptoRequiredNamespaceFingerprint: Uint8Array;
    }>;
    run: Readonly<{
      id: string;
      taskId: string;
      jobId: string;
      graphThreadId: string;
      status: "awaiting";
      startedAt: Date;
    }>;
  }>;
  priorJob: Readonly<{
    checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
    id: string;
    generation: number;
    parkedAt: Date;
    interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
    reference: ProtectedTaskDurableJobReference;
  }>;
  proof: ParkedProtectedTaskAdditionalAuthorityProof;
  authorizationRequestId: string;
  continuationFingerprint: string;
  nextExecutionSegment: number;
}>;

export type ParkedProtectedTaskHumanContinuationJobRow =
  ParkedProtectedTaskAdditionalAuthorityJobRow & Readonly<{
    acceptanceReceipt: unknown;
  }>;

export type ParkedProtectedTaskHumanContinuationTaskRow =
  ParkedProtectedTaskAdditionalAuthorityTaskRow & Readonly<{
    targetRoomId: string | null;
    targetUserIds: readonly string[];
    localExecutionDelegation: unknown;
  }>;

export type ParkedProtectedTaskHumanContinuation = Readonly<{
  occurrence: ParkedProtectedTaskAdditionalAuthority["occurrence"];
  priorJob: ParkedProtectedTaskAdditionalAuthority["priorJob"];
  segment: ProtectedTaskExecutionSegmentReceipt;
  stableRoutingDigest: Uint8Array;
  acceptance: ProtectedTaskHumanContinuationAcceptance;
  authorizationRequestId: string;
  nextExecutionSegment: number;
}>;

export type ParkedProtectedTaskCheckpointContinuation = Readonly<{
  occurrence: ParkedProtectedTaskAdditionalAuthority["occurrence"];
  priorJob: ParkedProtectedTaskAdditionalAuthority["priorJob"];
  proof: ProtectedTaskExecutionContinuationProof;
  stableRoutingDigest: Uint8Array;
  continuationFingerprint: string;
  authorizationRequestId: string;
  nextExecutionSegment: number;
}>;

export type StartParkedProtectedTaskCheckpointSegmentInput = Readonly<
  Omit<StartParkedProtectedTaskHumanRunSegmentInput, "acceptance" | "interrupts"> & {
    interrupts: readonly [];
    continuationFingerprint: string;
  }
>;
export type StartParkedProtectedTaskCheckpointSegmentResult =
  StartParkedProtectedTaskHumanRunSegmentResult;

export type ProtectedTaskPendingAttentionViewer = Readonly<{
  userId: string;
  humanActorId: string;
}>;

export type ProtectedTaskPendingAttentionCursor = Readonly<{
  startedAt: Date;
  taskRunId: string;
}>;

export type ProtectedTaskPendingAttentionInterrupt = Readonly<{
  id: string;
  kind: "approval" | "prove_it" | "identity";
  requestId?: string;
  allowedVerbs?: readonly ApprovalReplyVerb[];
}>;

/** Content-free durable identity of one Human-actionable protected park. */
export type ProtectedTaskPendingAttentionCandidate = Readonly<{
  occurrence: Readonly<{
    task: ParkedProtectedTaskAdditionalAuthority["occurrence"]["task"] &
      Readonly<{
        targetRoomId: string | null;
        cryptoMappingState: "verified";
      }>;
    run: ParkedProtectedTaskAdditionalAuthority["occurrence"]["run"];
  }>;
  priorJob: ParkedProtectedTaskAdditionalAuthority["priorJob"];
  stableRoutingDigest: Uint8Array;
  /** Only Human dialog kinds; await-reply is deliberately absent. */
  pendingAttentionInterrupts: readonly ProtectedTaskPendingAttentionInterrupt[];
  checkpointManifest: ProtectedTaskCheckpointManifestReceipt & Readonly<{
    contract: "encrypted_langgraph_v1";
    checkpointOrderedDigest: Uint8Array;
    blobOrderedDigest: Uint8Array;
    pendingWriteOrderedDigest: Uint8Array;
  }>;
}>;

export type ProtectedTaskPendingAttentionPage = Readonly<{
  candidates: readonly ProtectedTaskPendingAttentionCandidate[];
  nextCursor: ProtectedTaskPendingAttentionCursor | null;
}>;

export type ProtectedTaskHumanApprovalPolicy = Readonly<{
  interruptId: string;
  requestId: string;
  allowedVerbs: readonly ApprovalReplyVerb[];
}>;

export type SealProtectedTaskHumanApprovalPolicyInput = Readonly<{
  viewer: ProtectedTaskPendingAttentionViewer;
  candidate: ProtectedTaskPendingAttentionCandidate;
  policies: readonly ProtectedTaskHumanApprovalPolicy[];
}>;

export type SealProtectedTaskHumanApprovalPolicyResult = Readonly<{
  status: "sealed" | "exact_replay" | "not_needed";
}> | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

export type StartParkedProtectedTaskHumanRunSegmentInput = Readonly<{
  checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  priorJobId: string;
  jobId: string;
  generation: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: Date;
  stableRoutingDigest: Uint8Array;
  contentRepresentation: "dual" | "protected";
  contentNamespaceId: string;
  contentRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  cryptoRequiredNamespaceFingerprint: Uint8Array;
  checkpointManifest: ProtectedTaskCheckpointManifestReceipt;
  priorJobReference: ProtectedTaskDurableJobReference;
  jobReference: ProtectedTaskDurableJobReference;
  acceptance: ProtectedTaskHumanContinuationAcceptance;
}>;

export type StartParkedProtectedTaskHumanRunSegmentResult =
  | Readonly<{ status: "started" | "exact_replay" }>
  | Readonly<{ status: "rejected"; reason: "conflict" | "not_found" | "stale" }>;

export type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput =
  Readonly<
    Omit<StartParkedProtectedTaskHumanRunSegmentInput,
      "acceptance" | "stableRoutingDigest"> & {
      checkpointManifest: ProtectedTaskCheckpointManifestReceipt;
      continuation: Readonly<{
        interruptId: string;
        operationId: string;
        requestDigest: Uint8Array;
        requiredAuthorityDigest: Uint8Array;
        stableRoutingDigest: Uint8Array;
        semanticAuthorityRequirements:
          ProtectedTaskSemanticAuthorityRequirements;
      }>;
    }
  >;

export type StartParkedProtectedTaskRunAdditionalAuthoritySegmentResult =
  StartParkedProtectedTaskHumanRunSegmentResult;

type ProtectedTaskRunParkReceipt = Readonly<{
  checkpointAadBinding?: ProtectedTaskCheckpointAadBinding;
  version: 1;
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  generation: number;
  executionSegment: number;
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  parkedAt: string;
  stableRoutingDigest?: string;
}>;

type ProtectedTaskHumanContinuationAcceptanceReceipt = Readonly<{
  version: 1;
  acceptanceId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  graphThreadId: string;
  generation: number;
  executionSegment: number;
  nextExecutionSegment: number;
  acceptedBy: Readonly<{ userId: string; humanActorId: string }>;
  interrupt: ProtectedTaskRunInterruptCoordinate;
  response: ProtectedTaskHumanContinuationAcceptance["response"];
  acceptedAt: string;
  consumedByJobId?: string;
}>;

type ProtectedTaskHumanApprovalPolicyReceipt = Readonly<{
  version: 1;
  taskId: string;
  taskRunId: string;
  jobId: string;
  generation: number;
  executionSegment: number;
  parkReceiptDigest: string;
  checkpointManifestDigest: string;
  policies: readonly ProtectedTaskHumanApprovalPolicy[];
}>;

function opaqueCheckpointCoordinate(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_CHECKPOINT_COORDINATE.test(value);
}

function canonicalContinuationFingerprint(value: unknown): value is string {
  return typeof value === "string" && CONTINUATION_FINGERPRINT.test(value);
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

async function hasExactCurrentProtectedTaskReplyMessage(
  tx: Pick<DirectDatabase, "select">,
  reference: ProtectedTaskAwaitReplyMessageReference,
): Promise<boolean> {
  const [message] = await tx.select({
    roomId: sessions.roomId,
    sessionId: sessionMessages.sessionId,
    messageId: sessionMessages.id,
    editRevision: sessionMessages.editRevision,
    cryptoObjectId: sessionMessages.cryptoObjectId,
    namespaceId: rooms.namespaceId,
    sourceUserId: sessions.ownerId,
    role: sessionMessages.role,
    lifecycleNamespaceId: sessionMessageCryptoRevisions.namespaceIdAtAllocation,
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
      eq(sessionMessages.id, Number(reference.messageId)),
      eq(sessionMessages.sessionId, reference.sessionId),
    )).limit(1).for("share");
  return message !== undefined
    && message.roomId === reference.roomId
    && message.sessionId === reference.sessionId
    && String(message.messageId) === reference.messageId
    && message.editRevision === reference.editRevision
    && message.cryptoObjectId === reference.cryptoObjectId
    && message.namespaceId === reference.namespaceId
    && message.sourceUserId === reference.sourceUserId
    && message.role === "user"
    && message.lifecycleNamespaceId === reference.namespaceId
    && message.lifecycleRoomId === reference.roomId
    && message.lifecycleCryptoObjectId === reference.cryptoObjectId
    && message.lifecycleKeyClass === "ai"
    && message.lifecycleAuthorRole === "user"
    && message.lifecyclePayloadVersion === 2
    && message.lifecycleCompletion === "complete"
    && message.lifecycleDisposition === "mapped";
}

function assertProtectedTaskHumanContinuationAcceptance(
  acceptance: ProtectedTaskHumanContinuationAcceptance,
): void {
  if (
    !isRecord(acceptance)
    || Object.keys(acceptance).sort().join(",")
      !== "acceptanceId,acceptedAt,acceptedBy,interrupt,response"
    || !isRecord(acceptance.acceptedBy)
    || Object.keys(acceptance.acceptedBy).sort().join(",")
      !== "humanActorId,userId"
    || !isRecord(acceptance.interrupt)
    || !isRecord(acceptance.response)
  ) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  if (
    !opaqueCheckpointCoordinate(acceptance.acceptanceId)
    || !CANONICAL_UUID.test(acceptance.acceptedBy.userId)
    || !CANONICAL_UUID.test(acceptance.acceptedBy.humanActorId)
    || !(acceptance.acceptedAt instanceof Date)
    || !Number.isFinite(acceptance.acceptedAt.getTime())
  ) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const interrupt = canonicalInterruptCoordinates([acceptance.interrupt])[0]!;
  if (interrupt.kind === "additional_authority"
    || interrupt.kind !== acceptance.response.kind
    || interrupt.kind === "approval" && interrupt.requestId === undefined
    || interrupt.kind === "prove_it" && interrupt.requestId !== undefined
    || interrupt.kind === "await_reply" && interrupt.requestId !== undefined) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const responseKeys = Object.keys(acceptance.response).sort().join(",");
  if (acceptance.response.kind === "approval") {
    if (responseKeys !== "kind,verb"
      || !["once", "room", "always", "deny"].includes(
        acceptance.response.verb,
      )) {
      throw new TypeError("Protected Task Human acceptance is malformed");
    }
  } else if (acceptance.response.kind === "prove_it") {
    if (responseKeys !== "approved,kind"
      || typeof acceptance.response.approved !== "boolean") {
      throw new TypeError("Protected Task Human acceptance is malformed");
    }
  } else if (acceptance.response.kind === "identity") {
    if (responseKeys !== "kind") {
      throw new TypeError("Protected Task Human acceptance is malformed");
    }
  } else {
    const message = acceptance.response.message;
    if (responseKeys !== "kind,message"
      || !isRecord(message)
      || Object.keys(message).sort().join(",")
        !== "cryptoObjectId,editRevision,messageId,namespaceId,roomId,sessionId,sourceUserId"
      || !CANONICAL_UUID.test(message.roomId)
      || !CANONICAL_UUID.test(message.sessionId)
      || !canonicalMessageSerial(message.messageId)
      || !Number.isSafeInteger(message.editRevision)
      || message.editRevision < 0
      || !opaqueCheckpointCoordinate(message.cryptoObjectId)
      || !CANONICAL_UUID.test(message.namespaceId)
      || !CANONICAL_UUID.test(message.sourceUserId)) {
      throw new TypeError("Protected Task Human acceptance is malformed");
    }
  }
}

function encodeRoutingDigest(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError("Protected Task stable routing digest is malformed");
  }
  return Buffer.from(value).toString("base64url");
}

function decodeRoutingDigest(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !CONTINUATION_FINGERPRINT.test(value)) {
    return null;
  }
  const decoded = new Uint8Array(Buffer.from(value, "base64url"));
  return decoded.length === 32 && encodeRoutingDigest(decoded) === value
    ? decoded
    : null;
}

function canonicalInterruptCoordinates(
  value: readonly ProtectedTaskRunInterruptCoordinate[],
  allowCheckpointEmpty = false,
): readonly ProtectedTaskRunInterruptCoordinate[] {
  if (!Array.isArray(value) || (!allowCheckpointEmpty && value.length === 0)) {
    throw new TypeError("Protected Task park binding is malformed");
  }
  const coordinates = value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new TypeError("Protected Task park binding is malformed");
    }
    const keys = Object.keys(candidate).sort().join(",");
    if (
      keys !== "id,kind" && keys !== "id,kind,requestId"
        && keys !== "allowedVerbs,id,kind,requestId"
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
    if (keys === "id,kind,requestId") {
      return Object.freeze({ ...coordinate, requestId });
    }
    if (candidate["kind"] !== "approval") {
      throw new TypeError("Protected Task park binding is malformed");
    }
    const allowedVerbs = canonicalApprovalReplyVerbs(candidate["allowedVerbs"]);
    return Object.freeze({ ...coordinate, requestId, allowedVerbs });
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (coordinates.some((coordinate, index) =>
    index > 0 && coordinates[index - 1]!.id === coordinate.id
  )) {
    throw new TypeError("Protected Task park binding is malformed");
  }
  return Object.freeze(coordinates);
}

const APPROVAL_REPLY_VERBS = Object.freeze([
  "once", "room", "always", "deny",
] as const satisfies readonly ApprovalReplyVerb[]);

function canonicalApprovalReplyVerbs(value: unknown): readonly ApprovalReplyVerb[] {
  if (!Array.isArray(value) || value.length === 0
    || new Set(value).size !== value.length
    || !value.includes("deny")
    || value.some(verb => !APPROVAL_REPLY_VERBS.includes(verb as ApprovalReplyVerb))) {
    throw new TypeError("Protected Task approval policy is malformed");
  }
  const canonical = APPROVAL_REPLY_VERBS.filter(verb => value.includes(verb));
  if (canonical.length !== value.length
    || canonical.some((verb, index) => value[index] !== verb)) {
    throw new TypeError("Protected Task approval policy is malformed");
  }
  return Object.freeze([...canonical]);
}

function canonicalApprovalPolicies(
  value: readonly ProtectedTaskHumanApprovalPolicy[],
): readonly ProtectedTaskHumanApprovalPolicy[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Protected Task approval policy is malformed");
  }
  const policies = value.map(policy => {
    if (!isRecord(policy)
      || Object.keys(policy).sort().join(",") !== "allowedVerbs,interruptId,requestId"
      || !opaqueCheckpointCoordinate(policy["interruptId"])
      || !opaqueCheckpointCoordinate(policy["requestId"])) {
      throw new TypeError("Protected Task approval policy is malformed");
    }
    return Object.freeze({
      interruptId: policy["interruptId"],
      requestId: policy["requestId"],
      allowedVerbs: canonicalApprovalReplyVerbs(policy["allowedVerbs"]),
    });
  }).sort((left, right) => left.interruptId < right.interruptId ? -1
    : left.interruptId > right.interruptId ? 1 : 0);
  if (policies.some((policy, index) => index > 0
    && policies[index - 1]!.interruptId === policy.interruptId)) {
    throw new TypeError("Protected Task approval policy is malformed");
  }
  return Object.freeze(policies);
}

function approvalPolicyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function approvalPolicyParkReceiptDigest(
  receipt: ProtectedTaskRunParkReceipt,
): string {
  return approvalPolicyDigest({
    version: receipt.version,
    taskId: receipt.taskId,
    taskRunId: receipt.taskRunId,
    jobId: receipt.jobId,
    graphThreadId: receipt.graphThreadId,
    generation: receipt.generation,
    executionSegment: receipt.executionSegment,
    interrupts: receipt.interrupts.map(interrupt => ({
      id: interrupt.id,
      kind: interrupt.kind,
      requestId: interrupt.requestId ?? null,
      allowedVerbs: interrupt.allowedVerbs ?? null,
    })),
    parkedAt: receipt.parkedAt,
    stableRoutingDigest: receipt.stableRoutingDigest ?? null,
  });
}

function approvalPolicyCheckpointManifestDigest(
  segment: ProtectedTaskExecutionSegmentReceipt,
): string {
  return approvalPolicyDigest({
    taskRunId: segment.taskRunId,
    jobId: segment.jobId,
    executionSegment: segment.executionSegment,
    contract: segment.checkpointContract,
    expectedCheckpointCount: segment.expectedCheckpointCount,
    checkpointDigest: segment.checkpointDigest === null ? null
      : Buffer.from(segment.checkpointDigest).toString("base64url"),
    expectedBlobCount: segment.expectedCheckpointBlobCount,
    blobDigest: segment.checkpointBlobDigest === null ? null
      : Buffer.from(segment.checkpointBlobDigest).toString("base64url"),
    expectedPendingWriteCount: segment.expectedPendingWriteCount,
    pendingWriteDigest: segment.pendingWriteDigest === null ? null
      : Buffer.from(segment.pendingWriteDigest).toString("base64url"),
  });
}

function protectedTaskHumanApprovalPolicyReceipt(
  raw: unknown,
  receipt: ProtectedTaskRunParkReceipt,
  segment: ProtectedTaskExecutionSegmentReceipt,
): ProtectedTaskHumanApprovalPolicyReceipt | null {
  if (!isRecord(raw)
    || Object.keys(raw).sort().join(",") !== "checkpointManifestDigest,executionSegment,generation,jobId,parkReceiptDigest,policies,taskId,taskRunId,version"
    || raw["version"] !== 1
    || raw["taskId"] !== receipt.taskId
    || raw["taskRunId"] !== receipt.taskRunId
    || raw["jobId"] !== receipt.jobId
    || raw["generation"] !== receipt.generation
    || raw["executionSegment"] !== receipt.executionSegment
    || raw["parkReceiptDigest"] !== approvalPolicyParkReceiptDigest(receipt)
    || raw["checkpointManifestDigest"] !== approvalPolicyCheckpointManifestDigest(segment)) return null;
  let policies: readonly ProtectedTaskHumanApprovalPolicy[];
  try {
    policies = canonicalApprovalPolicies(
      raw["policies"] as readonly ProtectedTaskHumanApprovalPolicy[],
    );
  } catch {
    return null;
  }
  return Object.freeze({
    version: 1,
    taskId: receipt.taskId,
    taskRunId: receipt.taskRunId,
    jobId: receipt.jobId,
    generation: receipt.generation,
    executionSegment: receipt.executionSegment,
    parkReceiptDigest: raw["parkReceiptDigest"],
    checkpointManifestDigest: raw["checkpointManifestDigest"],
    policies,
  });
}

function parkAadFields(
  value: Readonly<Record<string, unknown>>,
  namespaceId?: string | null,
  maximumPolicyRevision?: number,
): Readonly<{ checkpointAadBinding?: ProtectedTaskCheckpointAadBinding }> {
  const binding = parseProtectedTaskCheckpointAadBinding(value["checkpointAadBinding"]);
  return binding === null || namespaceId !== undefined && binding.namespaceId !== namespaceId
    || maximumPolicyRevision !== undefined && binding.policyRevision > maximumPolicyRevision
    ? {} : { checkpointAadBinding: binding };
}

function parkKeys(value: Readonly<Record<string, unknown>>): string {
  return Object.keys(value).filter(key => key !== "checkpointAadBinding"
    || parseProtectedTaskCheckpointAadBinding(value[key]) === null).sort().join(",");
}

function parkReceipt(
  input: ParkProtectedTaskRunInput,
  stableRoutingDigest?: Uint8Array,
  allowCheckpointEmpty = false,
): ProtectedTaskRunParkReceipt {
  return Object.freeze({
    version: 1,
    ...parkAadFields(input),
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    jobId: input.jobId,
    graphThreadId: input.graphThreadId,
    generation: input.generation,
    executionSegment: input.executionSegment,
    interrupts: canonicalInterruptCoordinates(input.interrupts, allowCheckpointEmpty),
    parkedAt: input.parkedAt.toISOString(),
    ...(stableRoutingDigest === undefined
      ? {}
      : { stableRoutingDigest: encodeRoutingDigest(stableRoutingDigest) }),
  });
}

function humanContinuationAcceptanceReceipt(
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    graphThreadId: string;
    priorJobId: string;
    generation: number;
    executionSegment: number;
    interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
    parkedAt: Date;
    acceptance: ProtectedTaskHumanContinuationAcceptance;
  }>,
): ProtectedTaskHumanContinuationAcceptanceReceipt {
  assertProtectedTaskHumanContinuationAcceptance(input.acceptance);
  if (
    !Number.isSafeInteger(input.executionSegment)
    || input.executionSegment < 1
    || input.executionSegment === Number.MAX_SAFE_INTEGER
    || input.acceptance.acceptedAt.getTime() < input.parkedAt.getTime()
  ) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const selected = canonicalInterruptCoordinates(input.interrupts).filter(
    (coordinate) => coordinate.id === input.acceptance.interrupt.id
      && coordinate.kind === input.acceptance.interrupt.kind
      && coordinate.requestId === input.acceptance.interrupt.requestId,
  );
  if (selected.length !== 1) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const expectedAcceptanceId = protectedTaskHumanContinuationAcceptanceId({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    priorJobId: input.priorJobId,
    executionSegment: input.executionSegment,
    acceptedBy: input.acceptance.acceptedBy,
    interrupt: selected[0]!,
    response: input.acceptance.response,
  });
  if (input.acceptance.acceptanceId !== expectedAcceptanceId) {
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const response = input.acceptance.response.kind === "await_reply"
    ? Object.freeze({
        kind: "await_reply" as const,
        message: Object.freeze({ ...input.acceptance.response.message }),
      })
    : Object.freeze({ ...input.acceptance.response });
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
    acceptedBy: Object.freeze({ ...input.acceptance.acceptedBy }),
    interrupt: Object.freeze({
      id: selected[0]!.id,
      kind: selected[0]!.kind,
      ...(selected[0]!.requestId === undefined
        ? {}
        : { requestId: selected[0]!.requestId }),
      ...(selected[0]!.allowedVerbs === undefined
        ? {}
        : { allowedVerbs: Object.freeze([...selected[0]!.allowedVerbs]) }),
    }),
    response,
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
    const expectedKeys = coordinate.allowedVerbs === undefined
      ? coordinate.requestId === undefined ? "id,kind" : "id,kind,requestId"
      : "allowedVerbs,id,kind,requestId";
    return Object.keys(candidate).sort().join(",") === expectedKeys
      && candidate["id"] === coordinate.id
      && candidate["kind"] === coordinate.kind
      && candidate["requestId"] === coordinate.requestId
      && (coordinate.allowedVerbs === undefined
        ? candidate["allowedVerbs"] === undefined
        : Array.isArray(candidate["allowedVerbs"])
          && candidate["allowedVerbs"].length === coordinate.allowedVerbs.length
          && candidate["allowedVerbs"].every((verb, verbIndex) =>
            verb === coordinate.allowedVerbs![verbIndex]));
  });
}

function exactParkReceipt(
  value: unknown,
  expected: ProtectedTaskRunParkReceipt,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = expected.stableRoutingDigest === undefined
    ? "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,taskId,taskRunId,version"
    : "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,stableRoutingDigest,taskId,taskRunId,version";
  return parkKeys(value) === expectedKeys
    && sameProtectedTaskCheckpointAadBinding(
      value["checkpointAadBinding"] === undefined ? undefined
        : parseProtectedTaskCheckpointAadBinding(value["checkpointAadBinding"]) ?? undefined,
      expected.checkpointAadBinding)
    && value["version"] === expected.version
    && value["taskId"] === expected.taskId
    && value["taskRunId"] === expected.taskRunId
    && value["jobId"] === expected.jobId
    && value["graphThreadId"] === expected.graphThreadId
    && value["generation"] === expected.generation
    && value["executionSegment"] === expected.executionSegment
    && exactInterruptCoordinates(value["interrupts"], expected.interrupts)
    && value["parkedAt"] === expected.parkedAt
    && value["stableRoutingDigest"] === expected.stableRoutingDigest;
}

function exactHumanContinuationResponse(
  value: unknown,
  expected: ProtectedTaskHumanContinuationAcceptance["response"],
): boolean {
  if (!isRecord(value) || value["kind"] !== expected.kind) return false;
  if (expected.kind === "approval") {
    return Object.keys(value).sort().join(",") === "kind,verb"
      && value["verb"] === expected.verb;
  }
  if (expected.kind === "prove_it") {
    return Object.keys(value).sort().join(",") === "approved,kind"
      && value["approved"] === expected.approved;
  }
  if (expected.kind === "identity") {
    return Object.keys(value).sort().join(",") === "kind";
  }
  return Object.keys(value).sort().join(",") === "kind,message"
    && exactMessageReference(value["message"], expected.message);
}

function computeProtectedTaskHumanAcceptanceId(
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    priorJobId: string;
    executionSegment: number;
    acceptedBy: ProtectedTaskHumanContinuationAcceptance["acceptedBy"];
    interrupt: ProtectedTaskRunInterruptCoordinate;
    response: ProtectedTaskHumanContinuationAcceptance["response"];
  }>,
): string {
  const response = input.response.kind === "await_reply"
    ? {
        kind: input.response.kind,
        message: {
          roomId: input.response.message.roomId,
          sessionId: input.response.message.sessionId,
          messageId: input.response.message.messageId,
          editRevision: input.response.message.editRevision,
          cryptoObjectId: input.response.message.cryptoObjectId,
          namespaceId: input.response.message.namespaceId,
          sourceUserId: input.response.message.sourceUserId,
        },
      }
    : input.response.kind === "approval"
      ? { kind: input.response.kind, verb: input.response.verb }
      : input.response.kind === "prove_it"
        ? { kind: input.response.kind, approved: input.response.approved }
        : { kind: input.response.kind };
  const digest = createHash("sha256").update(JSON.stringify({
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    priorJobId: input.priorJobId,
    executionSegment: input.executionSegment,
    acceptedBy: {
      userId: input.acceptedBy.userId,
      humanActorId: input.acceptedBy.humanActorId,
    },
    interrupt: {
      id: input.interrupt.id,
      kind: input.interrupt.kind,
      requestId: input.interrupt.requestId ?? null,
    },
    response,
  })).digest("base64url");
  return `human-continuation:${digest}`;
}

export function protectedTaskHumanContinuationAcceptanceId(
  input: Parameters<typeof computeProtectedTaskHumanAcceptanceId>[0],
): string {
  assertProtectedTaskHumanContinuationAcceptance({
    acceptedBy: input.acceptedBy,
    interrupt: input.interrupt,
    response: input.response,
    acceptanceId: "pending",
    acceptedAt: new Date(0),
  });
  if (!CANONICAL_UUID.test(input.taskId)
    || !CANONICAL_UUID.test(input.taskRunId)
    || !CANONICAL_UUID.test(input.priorJobId)
    || !Number.isSafeInteger(input.executionSegment)
    || input.executionSegment < 1) {
    throw new TypeError("Protected Task Human acceptance identity is malformed");
  }
  return computeProtectedTaskHumanAcceptanceId(input);
}

function exactHumanContinuationAcceptanceReceipt(
  value: unknown,
  expected: ProtectedTaskHumanContinuationAcceptanceReceipt,
  consumedByJobId?: string,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = consumedByJobId === undefined
    ? "acceptanceId,acceptedAt,acceptedBy,executionSegment,generation,graphThreadId,interrupt,jobId,nextExecutionSegment,response,taskId,taskRunId,version"
    : "acceptanceId,acceptedAt,acceptedBy,consumedByJobId,executionSegment,generation,graphThreadId,interrupt,jobId,nextExecutionSegment,response,taskId,taskRunId,version";
  const interrupt = value["interrupt"];
  const acceptedBy = value["acceptedBy"];
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
    && isRecord(acceptedBy)
    && Object.keys(acceptedBy).sort().join(",") === "humanActorId,userId"
    && acceptedBy["userId"] === expected.acceptedBy.userId
    && acceptedBy["humanActorId"] === expected.acceptedBy.humanActorId
    && isRecord(interrupt)
    && Object.keys(interrupt).sort().join(",")
      === (expected.interrupt.allowedVerbs !== undefined
        ? "allowedVerbs,id,kind,requestId"
        : expected.interrupt.requestId === undefined
        ? "id,kind"
        : "id,kind,requestId")
    && interrupt["id"] === expected.interrupt.id
    && interrupt["kind"] === expected.interrupt.kind
    && interrupt["requestId"] === expected.interrupt.requestId
    && (expected.interrupt.allowedVerbs === undefined
      ? interrupt["allowedVerbs"] === undefined
      : Array.isArray(interrupt["allowedVerbs"])
        && interrupt["allowedVerbs"].length === expected.interrupt.allowedVerbs.length
        && interrupt["allowedVerbs"].every((verb, index) =>
          verb === expected.interrupt.allowedVerbs![index]))
    && exactHumanContinuationResponse(value["response"], expected.response)
    && value["acceptedAt"] === expected.acceptedAt
    && value["consumedByJobId"] === consumedByJobId;
}

export function exactProtectedTaskHumanContinuationAcceptanceReceipt(
  value: unknown,
  input: AcceptProtectedTaskHumanContinuationInput,
  consumedByJobId?: string,
): boolean {
  try {
    return exactHumanContinuationAcceptanceReceipt(
      value,
      humanContinuationAcceptanceReceipt(input),
      consumedByJobId,
    );
  } catch {
    return false;
  }
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
  stableRoutingDigest?: Uint8Array,
  allowCheckpointEmpty = false,
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
  if (input.checkpointAadBinding !== undefined && (
    parseProtectedTaskCheckpointAadBinding(input.checkpointAadBinding) === null
    || input.checkpointAadBinding.policyRevision > input.jobReference.policyRevision)) {
    throw new TypeError("Protected Task checkpoint ciphertext binding is malformed");
  }
  return parkReceipt(input, stableRoutingDigest, allowCheckpointEmpty);
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
  allowPausedCheckpointReplay = false,
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
  const exactRunIdentity = (receipt.checkpointAadBinding === undefined
      || receipt.checkpointAadBinding.namespaceId === task.contentNamespaceId)
    && run.graphThreadId === input.graphThreadId
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
    (task.status === expectedTaskParkedStatus
      || allowPausedCheckpointReplay && task.status === "paused")
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
    || !(continuation.requiredAuthorityDigest instanceof Uint8Array)
    || !(continuation.stableRoutingDigest instanceof Uint8Array)
    || continuation.stableRoutingDigest.length !== 32) {
    throw new TypeError("Protected Task seal-and-park continuation is malformed");
  }
  let semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(
        continuation.semanticAuthorityRequirements,
      );
    const semanticDigest = protectedTaskSemanticAuthorityRequirementsDigest(
      semanticAuthorityRequirements,
    );
    const digestMatches = sameBytes(
      semanticDigest,
      continuation.requiredAuthorityDigest,
    );
    semanticDigest.fill(0);
    if (!digestMatches) {
      throw new TypeError(
        "Protected Task seal-and-park continuation is malformed",
      );
    }
  } catch (error) {
    if (error instanceof TypeError
      && error.message === "Protected Task seal-and-park continuation is malformed") {
      throw error;
    }
    throw new TypeError(
      "Protected Task seal-and-park continuation is malformed",
      { cause: error },
    );
  }
  const continuationSnapshot = Object.freeze({
    kind: continuation.kind,
    reason: continuation.reason,
    effectDisposition: continuation.effectDisposition,
    interruptId: continuation.interruptId,
    operationId: continuation.operationId,
    requestDigest: continuation.requestDigest.slice(),
    requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
    stableRoutingDigest: continuation.stableRoutingDigest.slice(),
    semanticAuthorityRequirements,
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

/** Seal a Human-resumable native segment and park it without fabricating an
 * additional-authority continuation receipt. The routing digest is content
 * free and becomes immutable with the exact park receipt. */
export async function sealAndParkProtectedTaskHumanRun(
  db: DirectDatabase,
  input: SealAndParkProtectedTaskHumanRunInput,
): Promise<SealAndParkProtectedTaskHumanRunResult> {
  const routingDigest = input.stableRoutingDigest.slice();
  const parkReceiptValue = prepareProtectedTaskParkReceipt(
    input.park,
    routingDigest,
  );
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
    || segment.checkpoint.expectedCheckpointCount < 1
    || !parkReceiptValue.interrupts.some(interrupt =>
      interrupt.kind !== "additional_authority"
    )) {
    throw new TypeError("Protected Task Human seal-and-park input is malformed");
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

  try {
    return await db.transaction(async tx => {
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
        && segmentResult.status !== "exact_replay") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "park",
          reason: "conflict",
        });
      }
      return Object.freeze({ status: parkResult.status });
    });
  } catch (error) {
    if (error instanceof SealAndParkRollback) {
      return error.rejection as SealAndParkProtectedTaskHumanRunResult;
    }
    throw error;
  } finally {
    routingDigest.fill(0);
  }
}

/** Seal an explicit cooperative checkpoint before parking its exact Run. */
export async function sealAndParkProtectedTaskCheckpointRun(
  db: DirectDatabase,
  input: SealAndParkProtectedTaskCheckpointRunInput,
): Promise<SealAndParkProtectedTaskRunResult> {
  if (!(input.stableRoutingDigest instanceof Uint8Array)
    || input.stableRoutingDigest.length !== 32 || input.park.interrupts.length !== 0
    || input.continuation.kind !== "checkpoint_safe_v1"
    || input.continuation.effectDisposition !== "none_v1"
    || !["manual_pause", "time_limit", "grant_refresh"].includes(input.continuation.reason)
    || (input.continuation.reason === "grant_refresh"
      ? input.pauseRequestId !== null : !input.pauseRequestId)) {
    throw new TypeError("Protected Task checkpoint pause input is malformed");
  }
  const continuation = Object.freeze({ ...input.continuation });
  const pauseRequestId = input.pauseRequestId;
  const routingDigest = Uint8Array.from(input.stableRoutingDigest);
  const parkReceiptValue = prepareProtectedTaskParkReceipt(
    input.park,
    routingDigest,
    true,
  );
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
    throw new TypeError("Protected Task checkpoint seal-and-park input is malformed");
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

  try {
    return await db.transaction(async tx => {
      const locked = await lockProtectedTaskParkRows(tx, park);
      if (locked.status === "rejected") {
        return rollbackSealAndPark({
          status: "rejected",
          stage: "park",
          reason: locked.reason,
        });
      }
      // A refresh checkpoint may finish after a manual pause request arrives.
      // It only parks this segment; the independent Task intent still fences
      // scheduling and every successor start until aggregate unpause.
      if (continuation.reason !== "grant_refresh" && (
        locked.task.pauseRequestId !== pauseRequestId
        || locked.task.pauseReason !== continuation.reason
        || locked.task.pauseRequestedAt === null
        || locked.task.pauseRequestedAt.getTime() > park.parkedAt.getTime()
      )) {
        return rollbackSealAndPark({ status: "rejected", stage: "park", reason: "stale" });
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
      const continuationResult = await sealProtectedTaskContinuationReceiptInTx(tx, {
        ...continuation,
        taskId: park.taskId, taskRunId: park.taskRunId, jobId: park.jobId,
        executionSegment: park.executionSegment,
        sealedAt: new Date(park.parkedAt.getTime()),
      });
      if (continuationResult.status === "rejected") {
        return rollbackSealAndPark({ status: "rejected", stage: "continuation", reason: continuationResult.reason });
      }
      const parkResult = await parkProtectedTaskRunWithLockedRows(
        tx,
        park,
        parkReceiptValue,
        locked,
        true,
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
    if (error instanceof SealAndParkRollback) {
      return error.rejection;
    }
    throw error;
  } finally {
    routingDigest.fill(0);
  }
}

function cloneProtectedTaskExecutionSegment(
  segment: ProtectedTaskExecutionSegmentReceipt,
): ProtectedTaskExecutionSegmentReceipt {
  return Object.freeze({
    ...segment,
    transcriptAssociationDigest:
      segment.transcriptAssociationDigest?.slice() ?? null,
    checkpointDigest: segment.checkpointDigest?.slice() ?? null,
    checkpointBlobDigest: segment.checkpointBlobDigest?.slice() ?? null,
    pendingWriteDigest: segment.pendingWriteDigest?.slice() ?? null,
    sealedAt: new Date(segment.sealedAt.getTime()),
  });
}

async function readProtectedTaskExecutionSegment(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskRunId: string;
    jobId: string;
    executionSegment: number;
  }>,
): Promise<ProtectedTaskExecutionSegmentReceipt | null> {
  const rows = await db.select().from(protectedTaskExecutionSegmentReceipts)
    .where(and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, input.taskRunId),
      eq(protectedTaskExecutionSegmentReceipts.jobId, input.jobId),
      eq(
        protectedTaskExecutionSegmentReceipts.executionSegment,
        input.executionSegment,
      ),
    )).limit(2);
  if (rows.length !== 1) return null;
  return cloneProtectedTaskExecutionSegment(rows[0]!);
}

function cloneProtectedTaskExecutionContinuationProof(
  proof: ProtectedTaskExecutionContinuationProof,
): ProtectedTaskExecutionContinuationProof {
  return Object.freeze({
    segment: Object.freeze({
      ...proof.segment,
      transcriptAssociationDigest:
        proof.segment.transcriptAssociationDigest?.slice() ?? null,
      checkpointDigest: proof.segment.checkpointDigest?.slice() ?? null,
      checkpointBlobDigest: proof.segment.checkpointBlobDigest?.slice() ?? null,
      pendingWriteDigest: proof.segment.pendingWriteDigest?.slice() ?? null,
      sealedAt: new Date(proof.segment.sealedAt.getTime()),
    }),
    continuation: Object.freeze({
      ...proof.continuation,
      requestDigest: proof.continuation.requestDigest?.slice() ?? null,
      requiredAuthorityDigest:
        proof.continuation.requiredAuthorityDigest?.slice() ?? null,
      stableRoutingDigest:
        proof.continuation.stableRoutingDigest?.slice() ?? null,
      semanticAuthorityRequirements:
        proof.continuation.semanticAuthorityRequirements === null
          ? null
          : canonicalProtectedTaskSemanticAuthorityRequirements(
              proof.continuation.semanticAuthorityRequirements,
            ),
      sealedAt: new Date(proof.continuation.sealedAt.getTime()),
    }),
  });
}

function copyProtectedTaskInterrupts(
  interrupts: readonly ProtectedTaskRunInterruptCoordinate[],
): readonly ProtectedTaskRunInterruptCoordinate[] {
  return Object.freeze(interrupts.map(interrupt => Object.freeze({
    id: interrupt.id,
    kind: interrupt.kind,
    ...(interrupt.requestId === undefined
      ? {}
      : { requestId: interrupt.requestId }),
    ...(interrupt.allowedVerbs === undefined
      ? {}
      : { allowedVerbs: Object.freeze([...interrupt.allowedVerbs]) }),
  })));
}

/**
 * Validate a narrow, content-free parked-run projection and immutable proof.
 * The returned descriptor is an unlocked discovery candidate, never current
 * execution authority. Callers must re-read and parse the same facts while
 * holding the product lifecycle locks before opening protected material.
 */
export function parseParkedProtectedTaskAdditionalAuthority(input: Readonly<{
  task: ParkedProtectedTaskAdditionalAuthorityTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskAdditionalAuthorityJobRow;
  proof: ProtectedTaskExecutionContinuationProof | null;
  authorizationRequestId: string;
}>): ParkedProtectedTaskAdditionalAuthority | null {
  const { task, run, job, proof, authorizationRequestId } = input;
  if (!opaqueCheckpointCoordinate(authorizationRequestId)
    || !CANONICAL_UUID.test(task.id)
    || !CANONICAL_UUID.test(task.ownerId)
    || !CANONICAL_UUID.test(task.requestorId)
    || !CANONICAL_UUID.test(task.agentId)
    || task.callingRoomId !== null
      && !CANONICAL_UUID.test(task.callingRoomId)
    || task.scheduleKind !== "now"
      && task.scheduleKind !== "one_shot"
      && task.scheduleKind !== "cron"
    || task.status !== (task.scheduleKind === "cron" ? "pending" : "awaiting")
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null
    || !CANONICAL_UUID.test(task.contentNamespaceId)
    || !Number.isSafeInteger(task.contentRevision)
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || task.cryptoObjectId.length === 0
    || !Number.isSafeInteger(task.cryptoAccessRevision)
    || task.cryptoAccessRevision < 0
    || !(task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || task.contentPristine !== true
    || !CANONICAL_UUID.test(run.id)
    || run.taskId !== task.id
    || run.jobId !== job.id
    || typeof run.graphThreadId !== "string"
    || run.graphThreadId.length === 0
    || run.status !== "awaiting"
    || !(run.startedAt instanceof Date)
    || !Number.isFinite(run.startedAt.getTime())
    || run.pristine !== true
    || !CANONICAL_UUID.test(job.id)
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "completed"
    || !(job.startedAt instanceof Date)
    || !Number.isFinite(job.startedAt.getTime())
    || !(job.completedAt instanceof Date)
    || !Number.isFinite(job.completedAt.getTime())
    || job.pristine !== true
    || !isRecord(job.reference)
    || !isRecord(job.parkReceipt)
    || proof === null) return null;

  const reference = job.reference as ProtectedTaskDurableJobReference;
  if (!exactProtectedTaskJobReference(job.reference, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.inputObjectId !== task.cryptoObjectId
    || reference.resultObjectId !== protectedTaskRunResultObjectId(task.id, run.id)
    || !opaqueCheckpointCoordinate(reference.authorizationRequestId)
    || reference.authorizationRequestId === authorizationRequestId
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || !Number.isSafeInteger(reference.executionSegment)
    || reference.executionSegment < 1
    || reference.executionSegment === Number.MAX_SAFE_INTEGER) return null;

  const rawReceipt = job.parkReceipt;
  const parkedAtText = rawReceipt["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  if (parkKeys(rawReceipt)
      !== "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,taskId,taskRunId,version"
    || rawReceipt["version"] !== 1
    || !Number.isSafeInteger(rawReceipt["generation"])
    || (rawReceipt["generation"] as number) < 0
    || rawReceipt["executionSegment"] !== reference.executionSegment
    || !Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || job.completedAt.getTime() !== parkedAt.getTime()) return null;

  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      rawReceipt["interrupts"] as readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  const receipt: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    ...parkAadFields(rawReceipt, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawReceipt["generation"] as number,
    executionSegment: reference.executionSegment,
    interrupts,
    parkedAt: parkedAt.toISOString(),
  });
  const continuation = proof.continuation;
  const segment = proof.segment;
  const matchingInterrupts = interrupts.filter(interrupt =>
    interrupt.kind === "additional_authority"
      && interrupt.requestId === authorizationRequestId
  );
  if (!exactParkReceipt(rawReceipt, receipt)
    || matchingInterrupts.length !== 1
    || matchingInterrupts[0]!.id !== continuation.interruptId
    || segment.taskRunId !== run.id
    || segment.jobId !== job.id
    || segment.executionSegment !== reference.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.transcriptContract !== "protected_message_associations_v1"
    || !Number.isSafeInteger(segment.expectedTranscriptAssociationCount)
    || segment.expectedTranscriptAssociationCount < 0
    || !(segment.transcriptAssociationDigest instanceof Uint8Array)
    || segment.transcriptAssociationDigest.length !== 32
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(segment.expectedCheckpointCount)
    || segment.expectedCheckpointCount < 1
    || !(segment.checkpointDigest instanceof Uint8Array)
    || segment.checkpointDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedCheckpointBlobCount)
    || segment.expectedCheckpointBlobCount < 0
    || !(segment.checkpointBlobDigest instanceof Uint8Array)
    || segment.checkpointBlobDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedPendingWriteCount)
    || segment.expectedPendingWriteCount < 0
    || !(segment.pendingWriteDigest instanceof Uint8Array)
    || segment.pendingWriteDigest.length !== 32
    || !(segment.sealedAt instanceof Date)
    || segment.sealedAt.getTime() !== parkedAt.getTime()
    || continuation.taskRunId !== run.id
    || continuation.jobId !== job.id
    || continuation.executionSegment !== reference.executionSegment
    || continuation.kind !== "pre_effect_interrupt_v1"
    || continuation.reason !== "additional_authority"
    || continuation.effectDisposition !== "not_started_v1"
    || !opaqueCheckpointCoordinate(continuation.interruptId)
    || !opaqueCheckpointCoordinate(continuation.operationId)
    || !(continuation.requestDigest instanceof Uint8Array)
    || continuation.requestDigest.length !== 32
    || !(continuation.requiredAuthorityDigest instanceof Uint8Array)
    || continuation.requiredAuthorityDigest.length !== 32
    || !(continuation.stableRoutingDigest instanceof Uint8Array)
    || continuation.stableRoutingDigest.length !== 32
    || continuation.semanticAuthorityRequirements === null
    || !(continuation.sealedAt instanceof Date)
    || continuation.sealedAt.getTime() !== parkedAt.getTime()) return null;

  let semanticAuthorityRequirements: ProtectedTaskSemanticAuthorityRequirements;
  try {
    semanticAuthorityRequirements =
      canonicalProtectedTaskSemanticAuthorityRequirements(
        continuation.semanticAuthorityRequirements,
      );
    const semanticDigest = protectedTaskSemanticAuthorityRequirementsDigest(
      semanticAuthorityRequirements,
    );
    const digestMatches = sameBytes(
      semanticDigest,
      continuation.requiredAuthorityDigest,
    );
    semanticDigest.fill(0);
    if (!digestMatches) return null;
  } catch {
    return null;
  }

  const continuationFingerprint =
    protectedTaskAdditionalAuthorityContinuationFingerprint(continuation);
  const copiedReference = Object.freeze({ ...reference });
  const genericProof = cloneProtectedTaskExecutionContinuationProof(proof);
  const copiedProof: ParkedProtectedTaskAdditionalAuthorityProof =
    Object.freeze({
      segment: genericProof.segment,
      continuation: Object.freeze({
        ...genericProof.continuation,
        stableRoutingDigest: continuation.stableRoutingDigest.slice(),
        semanticAuthorityRequirements,
      }),
    });
  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: task.id,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        agentId: task.agentId,
        callingRoomId: task.callingRoomId,
        scheduleKind: task.scheduleKind,
        status: task.status,
        contentRepresentation: task.contentRepresentation,
        contentNamespaceId: task.contentNamespaceId,
        contentRevision: task.contentRevision,
        cryptoObjectId: task.cryptoObjectId,
        ...copyDefinitionHistoricalMetadata(task),
        cryptoAccessRevision: task.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          task.cryptoRequiredNamespaceFingerprint.slice(),
      }),
      run: Object.freeze({
        id: run.id,
        taskId: run.taskId,
        jobId: job.id,
        graphThreadId: run.graphThreadId,
        status: "awaiting" as const,
        startedAt: new Date(run.startedAt.getTime()),
      }),
    }),
    priorJob: Object.freeze({
      ...parkAadFields(receipt),
      id: job.id,
      generation: receipt.generation,
      parkedAt: new Date(parkedAt.getTime()),
      interrupts: copyProtectedTaskInterrupts(interrupts),
      reference: copiedReference,
    }),
    proof: copiedProof,
    authorizationRequestId,
    continuationFingerprint,
    nextExecutionSegment: reference.executionSegment + 1,
  });
}

function checkpointContinuationFingerprint(
  proof: ProtectedTaskExecutionContinuationProof,
  stableRoutingDigest: Uint8Array,
): string {
  const s = proof.segment;
  const c = proof.continuation;
  return createHash("sha256").update(JSON.stringify([
    "nautilo.protected-task-checkpoint-continuation.v1",
    s.taskRunId, s.executionSegment, s.jobId, s.route,
    s.transcriptContract, s.expectedTranscriptAssociationCount,
    s.transcriptAssociationDigest === null ? null : encodeRoutingDigest(s.transcriptAssociationDigest),
    s.checkpointContract, s.expectedCheckpointCount,
    s.checkpointDigest === null ? null : encodeRoutingDigest(s.checkpointDigest),
    s.expectedCheckpointBlobCount, s.checkpointBlobDigest === null ? null : encodeRoutingDigest(s.checkpointBlobDigest),
    s.expectedPendingWriteCount, s.pendingWriteDigest === null ? null : encodeRoutingDigest(s.pendingWriteDigest),
    s.sealedAt.toISOString(), c.taskRunId, c.executionSegment, c.jobId,
    c.kind, c.reason, c.effectDisposition, c.interruptId, c.operationId,
    c.requestDigest, c.requiredAuthorityDigest, c.stableRoutingDigest,
    c.semanticAuthorityRequirements, c.sealedAt.toISOString(),
    encodeRoutingDigest(stableRoutingDigest),
  ])).digest("base64url");
}

export function parseParkedProtectedTaskCheckpointContinuation(input: Readonly<{
  task: ParkedProtectedTaskAdditionalAuthorityTaskRow & Readonly<{ pauseRequestId?: string | null }>;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskAdditionalAuthorityJobRow;
  proof: ProtectedTaskExecutionContinuationProof | null;
}>): ParkedProtectedTaskCheckpointContinuation | null {
  const { task, run, job, proof } = input;
  if (task.pauseRequestId != null
    || !CANONICAL_UUID.test(task.id)
    || !CANONICAL_UUID.test(task.ownerId)
    || !CANONICAL_UUID.test(task.requestorId)
    || !CANONICAL_UUID.test(task.agentId)
    || task.callingRoomId !== null
      && !CANONICAL_UUID.test(task.callingRoomId)
    || task.scheduleKind !== "now"
      && task.scheduleKind !== "one_shot"
      && task.scheduleKind !== "cron"
    || task.status !== (task.scheduleKind === "cron" ? "pending" : "awaiting")
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null
    || !CANONICAL_UUID.test(task.contentNamespaceId)
    || !Number.isSafeInteger(task.contentRevision)
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || task.cryptoObjectId.length === 0
    || !Number.isSafeInteger(task.cryptoAccessRevision)
    || task.cryptoAccessRevision < 0
    || !(task.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || task.contentPristine !== true
    || !CANONICAL_UUID.test(run.id)
    || run.taskId !== task.id
    || run.jobId !== job.id
    || typeof run.graphThreadId !== "string"
    || run.graphThreadId.length === 0
    || run.status !== "awaiting"
    || !(run.startedAt instanceof Date)
    || !Number.isFinite(run.startedAt.getTime())
    || run.pristine !== true
    || !CANONICAL_UUID.test(job.id)
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "completed"
    || !(job.startedAt instanceof Date)
    || !Number.isFinite(job.startedAt.getTime())
    || !(job.completedAt instanceof Date)
    || !Number.isFinite(job.completedAt.getTime())
    || job.pristine !== true
    || !isRecord(job.reference)
    || !isRecord(job.parkReceipt)
    || proof === null) return null;

  const reference = job.reference as ProtectedTaskDurableJobReference;
  if (reference.kind !== "protected_task_run_v1"
    || !exactProtectedTaskJobReference(job.reference, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.inputObjectId !== task.cryptoObjectId
    || reference.resultObjectId !== protectedTaskRunResultObjectId(task.id, run.id)
    || !opaqueCheckpointCoordinate(reference.authorizationRequestId)
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || !Number.isSafeInteger(reference.executionSegment)
    || reference.executionSegment < 1
    || reference.executionSegment === Number.MAX_SAFE_INTEGER) return null;

  const rawReceipt = job.parkReceipt;
  const parkedAtText = rawReceipt["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  if (parkKeys(rawReceipt)
      !== "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,stableRoutingDigest,taskId,taskRunId,version"
    || rawReceipt["version"] !== 1
    || !Number.isSafeInteger(rawReceipt["generation"])
    || (rawReceipt["generation"] as number) < 0
    || rawReceipt["executionSegment"] !== reference.executionSegment
    || !Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || job.completedAt.getTime() !== parkedAt.getTime()) return null;

  const stableRoutingDigest = decodeRoutingDigest(rawReceipt["stableRoutingDigest"]);
  if (stableRoutingDigest === null || !Array.isArray(rawReceipt["interrupts"])
    || rawReceipt["interrupts"].length !== 0) return null;
  const interrupts = Object.freeze([]);
  const receipt: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    ...parkAadFields(rawReceipt, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawReceipt["generation"] as number,
    executionSegment: reference.executionSegment,
    interrupts,
    parkedAt: parkedAt.toISOString(),
    stableRoutingDigest: encodeRoutingDigest(stableRoutingDigest),
  });
  const continuation = proof.continuation;
  const segment = proof.segment;
  if (!exactParkReceipt(rawReceipt, receipt)
    || segment.taskRunId !== run.id
    || segment.jobId !== job.id
    || segment.executionSegment !== reference.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.transcriptContract !== "protected_message_associations_v1"
    || !Number.isSafeInteger(segment.expectedTranscriptAssociationCount)
    || segment.expectedTranscriptAssociationCount < 0
    || !(segment.transcriptAssociationDigest instanceof Uint8Array)
    || segment.transcriptAssociationDigest.length !== 32
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(segment.expectedCheckpointCount)
    || segment.expectedCheckpointCount < 1
    || !(segment.checkpointDigest instanceof Uint8Array)
    || segment.checkpointDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedCheckpointBlobCount)
    || segment.expectedCheckpointBlobCount < 0
    || !(segment.checkpointBlobDigest instanceof Uint8Array)
    || segment.checkpointBlobDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedPendingWriteCount)
    || segment.expectedPendingWriteCount < 0
    || !(segment.pendingWriteDigest instanceof Uint8Array)
    || segment.pendingWriteDigest.length !== 32
    || !(segment.sealedAt instanceof Date)
    || segment.sealedAt.getTime() !== parkedAt.getTime()
    || continuation.taskRunId !== run.id
    || continuation.jobId !== job.id
    || continuation.executionSegment !== reference.executionSegment
    || continuation.kind !== "checkpoint_safe_v1"
    || !["manual_pause", "time_limit", "grant_refresh"].includes(continuation.reason)
    || continuation.effectDisposition !== "none_v1"
    || continuation.interruptId !== null || continuation.operationId !== null
    || continuation.requestDigest !== null || continuation.requiredAuthorityDigest !== null
    || continuation.stableRoutingDigest !== null
    || continuation.semanticAuthorityRequirements !== null
    || !(continuation.sealedAt instanceof Date)
    || continuation.sealedAt.getTime() !== parkedAt.getTime()) return null;

  const copiedProof = Object.freeze({
    segment: Object.freeze({ ...segment,
      transcriptAssociationDigest: Uint8Array.from(segment.transcriptAssociationDigest),
      checkpointDigest: Uint8Array.from(segment.checkpointDigest),
      checkpointBlobDigest: Uint8Array.from(segment.checkpointBlobDigest),
      pendingWriteDigest: Uint8Array.from(segment.pendingWriteDigest),
      sealedAt: new Date(segment.sealedAt.getTime()),
    }),
    continuation: Object.freeze({ ...continuation,
      sealedAt: new Date(continuation.sealedAt.getTime()),
    }),
  });
  const continuationFingerprint = checkpointContinuationFingerprint(copiedProof, stableRoutingDigest);
  const authorizationRequestId = `task-checkpoint-continuation:${run.id}:${reference.executionSegment + 1}:${continuationFingerprint}`;
  if (authorizationRequestId === reference.authorizationRequestId) return null;
  const copiedReference = Object.freeze({ ...reference });
  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: task.id,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        agentId: task.agentId,
        callingRoomId: task.callingRoomId,
        scheduleKind: task.scheduleKind,
        status: task.status,
        contentRepresentation: task.contentRepresentation,
        contentNamespaceId: task.contentNamespaceId,
        contentRevision: task.contentRevision,
        cryptoObjectId: task.cryptoObjectId,
        ...copyDefinitionHistoricalMetadata(task),
        cryptoAccessRevision: task.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          Uint8Array.from(task.cryptoRequiredNamespaceFingerprint),
      }),
      run: Object.freeze({
        id: run.id,
        taskId: run.taskId,
        jobId: job.id,
        graphThreadId: run.graphThreadId,
        status: "awaiting" as const,
        startedAt: new Date(run.startedAt.getTime()),
      }),
    }),
    priorJob: Object.freeze({
      ...parkAadFields(receipt),
      id: job.id,
      generation: receipt.generation,
      parkedAt: new Date(parkedAt.getTime()),
      interrupts: copyProtectedTaskInterrupts(interrupts),
      reference: copiedReference,
    }),
    proof: copiedProof,
    stableRoutingDigest: Uint8Array.from(stableRoutingDigest),
    authorizationRequestId,
    continuationFingerprint,
    nextExecutionSegment: reference.executionSegment + 1,
  });
}

/** Parse one accepted, content-free Human continuation occurrence. */
export function parseParkedProtectedTaskHumanContinuation(input: Readonly<{
  task: ParkedProtectedTaskHumanContinuationTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskHumanContinuationJobRow;
  segment: ProtectedTaskExecutionSegmentReceipt | null;
}>): ParkedProtectedTaskHumanContinuation | null {
  const { task, run, job, segment } = input;
  if (!CANONICAL_UUID.test(task.id)
    || !CANONICAL_UUID.test(task.ownerId)
    || !CANONICAL_UUID.test(task.requestorId)
    || !CANONICAL_UUID.test(task.agentId)
    || task.status !== (task.scheduleKind === "cron" ? "pending" : "awaiting")
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null
    || task.cryptoObjectId === null
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || task.contentPristine !== true
    || run.taskId !== task.id
    || run.jobId !== job.id
    || run.status !== "awaiting"
    || run.pristine !== true
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "completed"
    || job.startedAt === null
    || job.completedAt === null
    || job.pristine !== true
    || !isRecord(job.reference)
    || !isRecord(job.parkReceipt)
    || !isRecord(job.acceptanceReceipt)
    || segment === null) return null;
  const reference = job.reference as ProtectedTaskDurableJobReference;
  if (!exactProtectedTaskJobReference(job.reference, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.inputObjectId !== task.cryptoObjectId
    || reference.resultObjectId !== protectedTaskRunResultObjectId(task.id, run.id)
    || reference.executionSegment < 1
    || reference.executionSegment === Number.MAX_SAFE_INTEGER) return null;
  const rawPark = job.parkReceipt;
  const parkedAtText = rawPark["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  const stableRoutingDigest = decodeRoutingDigest(rawPark["stableRoutingDigest"]);
  if (!Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || job.completedAt.getTime() !== parkedAt.getTime()
    || !Number.isSafeInteger(rawPark["generation"])
    || (rawPark["generation"] as number) < 0
    || stableRoutingDigest === null) return null;
  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      rawPark["interrupts"] as readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  const park: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    ...parkAadFields(rawPark, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawPark["generation"] as number,
    executionSegment: reference.executionSegment,
    interrupts,
    parkedAt: parkedAt.toISOString(),
    stableRoutingDigest: rawPark["stableRoutingDigest"] as string,
  });
  if (!exactParkReceipt(rawPark, park)
    || segment.taskRunId !== run.id
    || segment.jobId !== job.id
    || segment.executionSegment !== reference.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.transcriptContract !== "protected_message_associations_v1"
    || !(segment.transcriptAssociationDigest instanceof Uint8Array)
    || segment.transcriptAssociationDigest.length !== 32
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || segment.expectedCheckpointCount < 1
    || !(segment.checkpointDigest instanceof Uint8Array)
    || segment.checkpointDigest.length !== 32
    || !(segment.checkpointBlobDigest instanceof Uint8Array)
    || segment.checkpointBlobDigest.length !== 32
    || !(segment.pendingWriteDigest instanceof Uint8Array)
    || segment.pendingWriteDigest.length !== 32
    || segment.sealedAt.getTime() !== parkedAt.getTime()) return null;
  const rawAcceptance = job.acceptanceReceipt;
  const acceptedAtText = rawAcceptance["acceptedAt"];
  const acceptedAt = typeof acceptedAtText === "string"
    ? new Date(acceptedAtText)
    : new Date(Number.NaN);
  if (!Number.isFinite(acceptedAt.getTime())
    || acceptedAt.toISOString() !== acceptedAtText
    || rawAcceptance["consumedByJobId"] !== undefined) return null;
  const acceptance = Object.freeze({
    acceptanceId: rawAcceptance["acceptanceId"],
    acceptedBy: rawAcceptance["acceptedBy"],
    interrupt: rawAcceptance["interrupt"],
    response: rawAcceptance["response"],
    acceptedAt,
  }) as ProtectedTaskHumanContinuationAcceptance;
  let expectedAcceptance: ProtectedTaskHumanContinuationAcceptanceReceipt;
  try {
    expectedAcceptance = humanContinuationAcceptanceReceipt({
      taskId: task.id,
      taskRunId: run.id,
      graphThreadId: run.graphThreadId,
      priorJobId: job.id,
      generation: park.generation,
      executionSegment: reference.executionSegment,
      interrupts,
      parkedAt,
      acceptance,
    });
  } catch {
    return null;
  }
  if (!exactHumanContinuationAcceptanceReceipt(
    rawAcceptance,
    expectedAcceptance,
  )) return null;
  const delegation = task.localExecutionDelegation === null
    || task.localExecutionDelegation === undefined
    ? null
    : parseLocalExecutionDelegation(task.localExecutionDelegation);
  const recipient = task.localExecutionDelegation === null
    || task.localExecutionDelegation === undefined
    ? task.ownerId
    : delegation !== null
        && delegation.humanUserId === task.requestorId
        && delegation.agentId === task.agentId
      ? delegation.humanUserId
      : null;
  const response = expectedAcceptance.response;
  if (response.kind === "await_reply"
    ? expectedAcceptance.acceptedBy.userId !== response.message.sourceUserId
      || task.targetRoomId !== response.message.roomId
      || task.requestorId !== response.message.sourceUserId
        && !task.targetUserIds.includes(response.message.sourceUserId)
    : recipient === null || expectedAcceptance.acceptedBy.userId !== recipient) {
    return null;
  }
  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: task.id,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        agentId: task.agentId,
        callingRoomId: task.callingRoomId,
        scheduleKind: task.scheduleKind,
        status: task.status,
        contentRepresentation: task.contentRepresentation,
        contentNamespaceId: task.contentNamespaceId,
        contentRevision: task.contentRevision,
        cryptoObjectId: task.cryptoObjectId,
        ...copyDefinitionHistoricalMetadata(task),
        cryptoAccessRevision: task.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          task.cryptoRequiredNamespaceFingerprint.slice(),
      }),
      run: Object.freeze({
        id: run.id,
        taskId: run.taskId,
        jobId: job.id,
        graphThreadId: run.graphThreadId,
        status: "awaiting" as const,
        startedAt: new Date(run.startedAt.getTime()),
      }),
    }),
    priorJob: Object.freeze({
      ...parkAadFields(park),
      id: job.id,
      generation: park.generation,
      parkedAt: new Date(parkedAt.getTime()),
      interrupts: copyProtectedTaskInterrupts(interrupts),
      reference: Object.freeze({ ...reference }),
    }),
    segment: cloneProtectedTaskExecutionSegment(segment),
    stableRoutingDigest: stableRoutingDigest.slice(),
    acceptance: Object.freeze({
      acceptanceId: expectedAcceptance.acceptanceId,
      acceptedBy: Object.freeze({ ...expectedAcceptance.acceptedBy }),
      interrupt: Object.freeze({ ...expectedAcceptance.interrupt }),
      response: response.kind === "await_reply"
        ? Object.freeze({
            kind: "await_reply" as const,
            message: Object.freeze({ ...response.message }),
          })
        : Object.freeze({ ...response }),
      acceptedAt: new Date(acceptedAt.getTime()),
    }),
    authorizationRequestId: expectedAcceptance.acceptanceId,
    nextExecutionSegment: reference.executionSegment + 1,
  });
}

/** Exact comparison for a discovered candidate re-read under lifecycle locks. */
export function sameParkedProtectedTaskAdditionalAuthority(
  left: ParkedProtectedTaskAdditionalAuthority,
  right: ParkedProtectedTaskAdditionalAuthority,
): boolean {
  const leftTask = left.occurrence.task;
  const rightTask = right.occurrence.task;
  const leftRun = left.occurrence.run;
  const rightRun = right.occurrence.run;
  const leftJob = left.priorJob;
  const rightJob = right.priorJob;
  const leftSegment = left.proof.segment;
  const rightSegment = right.proof.segment;
  const leftContinuation = left.proof.continuation;
  const rightContinuation = right.proof.continuation;
  return leftTask.id === rightTask.id
    && leftTask.ownerId === rightTask.ownerId
    && leftTask.requestorId === rightTask.requestorId
    && leftTask.agentId === rightTask.agentId
    && leftTask.callingRoomId === rightTask.callingRoomId
    && leftTask.scheduleKind === rightTask.scheduleKind
    && leftTask.status === rightTask.status
    && leftTask.contentRepresentation === rightTask.contentRepresentation
    && leftTask.contentNamespaceId === rightTask.contentNamespaceId
    && leftTask.contentRevision === rightTask.contentRevision
    && leftTask.cryptoObjectId === rightTask.cryptoObjectId
    && JSON.stringify(leftTask.definitionHistoricalRepair ?? null) === JSON.stringify(rightTask.definitionHistoricalRepair ?? null)
    && leftTask.cryptoAccessRevision === rightTask.cryptoAccessRevision
    && sameBytes(
      leftTask.cryptoRequiredNamespaceFingerprint,
      rightTask.cryptoRequiredNamespaceFingerprint,
    )
    && leftRun.id === rightRun.id
    && leftRun.taskId === rightRun.taskId
    && leftRun.jobId === rightRun.jobId
    && leftRun.graphThreadId === rightRun.graphThreadId
    && leftRun.status === rightRun.status
    && leftRun.startedAt.getTime() === rightRun.startedAt.getTime()
    && sameProtectedTaskCheckpointAadBinding(leftJob.checkpointAadBinding, rightJob.checkpointAadBinding)
    && leftJob.id === rightJob.id
    && leftJob.generation === rightJob.generation
    && leftJob.parkedAt.getTime() === rightJob.parkedAt.getTime()
    && exactInterruptCoordinates(leftJob.interrupts, rightJob.interrupts)
    && exactProtectedTaskJobReference(leftJob.reference, rightJob.reference)
    && leftSegment.taskRunId === rightSegment.taskRunId
    && leftSegment.executionSegment === rightSegment.executionSegment
    && leftSegment.jobId === rightSegment.jobId
    && leftSegment.route === rightSegment.route
    && leftSegment.transcriptContract === rightSegment.transcriptContract
    && leftSegment.expectedTranscriptAssociationCount
      === rightSegment.expectedTranscriptAssociationCount
    && sameBytes(
      leftSegment.transcriptAssociationDigest,
      rightSegment.transcriptAssociationDigest,
    )
    && leftSegment.checkpointContract === rightSegment.checkpointContract
    && leftSegment.expectedCheckpointCount
      === rightSegment.expectedCheckpointCount
    && sameBytes(leftSegment.checkpointDigest, rightSegment.checkpointDigest)
    && leftSegment.expectedCheckpointBlobCount
      === rightSegment.expectedCheckpointBlobCount
    && sameBytes(
      leftSegment.checkpointBlobDigest,
      rightSegment.checkpointBlobDigest,
    )
    && leftSegment.expectedPendingWriteCount
      === rightSegment.expectedPendingWriteCount
    && sameBytes(leftSegment.pendingWriteDigest, rightSegment.pendingWriteDigest)
    && leftSegment.sealedAt.getTime() === rightSegment.sealedAt.getTime()
    && leftContinuation.taskRunId === rightContinuation.taskRunId
    && leftContinuation.executionSegment === rightContinuation.executionSegment
    && leftContinuation.jobId === rightContinuation.jobId
    && leftContinuation.kind === rightContinuation.kind
    && leftContinuation.reason === rightContinuation.reason
    && leftContinuation.effectDisposition === rightContinuation.effectDisposition
    && leftContinuation.interruptId === rightContinuation.interruptId
    && leftContinuation.operationId === rightContinuation.operationId
    && sameBytes(leftContinuation.requestDigest, rightContinuation.requestDigest)
    && sameBytes(
      leftContinuation.requiredAuthorityDigest,
      rightContinuation.requiredAuthorityDigest,
    )
    && sameBytes(
      leftContinuation.stableRoutingDigest,
      rightContinuation.stableRoutingDigest,
    )
    && leftContinuation.semanticAuthorityRequirements !== null
    && rightContinuation.semanticAuthorityRequirements !== null
    && sameProtectedTaskSemanticAuthorityRequirements(
      leftContinuation.semanticAuthorityRequirements,
      rightContinuation.semanticAuthorityRequirements,
    )
    && leftContinuation.sealedAt.getTime()
      === rightContinuation.sealedAt.getTime()
    && left.authorizationRequestId === right.authorizationRequestId
    && left.continuationFingerprint === right.continuationFingerprint
    && left.nextExecutionSegment === right.nextExecutionSegment;
}

export function sameParkedProtectedTaskHumanContinuation(
  left: ParkedProtectedTaskHumanContinuation,
  right: ParkedProtectedTaskHumanContinuation,
): boolean {
  const leftTask = left.occurrence.task;
  const rightTask = right.occurrence.task;
  const leftRun = left.occurrence.run;
  const rightRun = right.occurrence.run;
  const leftJob = left.priorJob;
  const rightJob = right.priorJob;
  const leftSegment = left.segment;
  const rightSegment = right.segment;
  return leftTask.id === rightTask.id
    && leftTask.ownerId === rightTask.ownerId
    && leftTask.requestorId === rightTask.requestorId
    && leftTask.agentId === rightTask.agentId
    && leftTask.callingRoomId === rightTask.callingRoomId
    && leftTask.scheduleKind === rightTask.scheduleKind
    && leftTask.status === rightTask.status
    && leftTask.contentRepresentation === rightTask.contentRepresentation
    && leftTask.contentNamespaceId === rightTask.contentNamespaceId
    && leftTask.contentRevision === rightTask.contentRevision
    && leftTask.cryptoObjectId === rightTask.cryptoObjectId
    && JSON.stringify(leftTask.definitionHistoricalRepair ?? null) === JSON.stringify(rightTask.definitionHistoricalRepair ?? null)
    && leftTask.cryptoAccessRevision === rightTask.cryptoAccessRevision
    && sameBytes(
      leftTask.cryptoRequiredNamespaceFingerprint,
      rightTask.cryptoRequiredNamespaceFingerprint,
    )
    && leftRun.id === rightRun.id
    && leftRun.taskId === rightRun.taskId
    && leftRun.jobId === rightRun.jobId
    && leftRun.graphThreadId === rightRun.graphThreadId
    && leftRun.status === rightRun.status
    && leftRun.startedAt.getTime() === rightRun.startedAt.getTime()
    && sameProtectedTaskCheckpointAadBinding(leftJob.checkpointAadBinding, rightJob.checkpointAadBinding)
    && leftJob.id === rightJob.id
    && leftJob.generation === rightJob.generation
    && leftJob.parkedAt.getTime() === rightJob.parkedAt.getTime()
    && exactInterruptCoordinates(leftJob.interrupts, rightJob.interrupts)
    && exactProtectedTaskJobReference(leftJob.reference, rightJob.reference)
    && leftSegment.taskRunId === rightSegment.taskRunId
    && leftSegment.executionSegment === rightSegment.executionSegment
    && leftSegment.jobId === rightSegment.jobId
    && leftSegment.route === rightSegment.route
    && leftSegment.transcriptContract === rightSegment.transcriptContract
    && leftSegment.expectedTranscriptAssociationCount
      === rightSegment.expectedTranscriptAssociationCount
    && sameBytes(
      leftSegment.transcriptAssociationDigest,
      rightSegment.transcriptAssociationDigest,
    )
    && leftSegment.checkpointContract === rightSegment.checkpointContract
    && leftSegment.expectedCheckpointCount
      === rightSegment.expectedCheckpointCount
    && sameBytes(leftSegment.checkpointDigest, rightSegment.checkpointDigest)
    && leftSegment.expectedCheckpointBlobCount
      === rightSegment.expectedCheckpointBlobCount
    && sameBytes(
      leftSegment.checkpointBlobDigest,
      rightSegment.checkpointBlobDigest,
    )
    && leftSegment.expectedPendingWriteCount
      === rightSegment.expectedPendingWriteCount
    && sameBytes(leftSegment.pendingWriteDigest, rightSegment.pendingWriteDigest)
    && leftSegment.sealedAt.getTime() === rightSegment.sealedAt.getTime()
    && sameBytes(left.stableRoutingDigest, right.stableRoutingDigest)
    && left.acceptance.acceptanceId === right.acceptance.acceptanceId
    && left.acceptance.acceptedBy.userId === right.acceptance.acceptedBy.userId
    && left.acceptance.acceptedBy.humanActorId
      === right.acceptance.acceptedBy.humanActorId
    && exactInterruptCoordinates(
      [left.acceptance.interrupt],
      [right.acceptance.interrupt],
    )
    && exactHumanContinuationResponse(
      left.acceptance.response,
      right.acceptance.response,
    )
    && left.acceptance.acceptedAt.getTime()
      === right.acceptance.acceptedAt.getTime()
    && left.authorizationRequestId === right.authorizationRequestId
    && left.nextExecutionSegment === right.nextExecutionSegment;
}

/** Validate and detach one parked authority descriptor for later locked use. */
export function copyParkedProtectedTaskAdditionalAuthority(
  expected: ParkedProtectedTaskAdditionalAuthority,
): ParkedProtectedTaskAdditionalAuthority {
  try {
    const task = expected.occurrence.task;
    const run = expected.occurrence.run;
    const priorJob = expected.priorJob;
    const copy = parseParkedProtectedTaskAdditionalAuthority({
      task: {
        ...task,
        cryptoRequiredNamespaceFingerprint:
          task.cryptoRequiredNamespaceFingerprint.slice(),
        cryptoMappingState: "verified",
        contentPristine: true,
      },
      run: {
        ...run,
        startedAt: new Date(run.startedAt.getTime()),
        pristine: true,
      },
      job: {
        id: priorJob.id,
        ownerId: task.requestorId,
        requestorId: task.requestorId,
        laneKey: `task:${task.id}`,
        type: "foreground",
        status: "completed",
        startedAt: new Date(run.startedAt.getTime()),
        completedAt: new Date(priorJob.parkedAt.getTime()),
        reference: { ...priorJob.reference },
        parkReceipt: {
          version: 1,
          taskId: task.id,
          taskRunId: run.id,
          jobId: priorJob.id,
          graphThreadId: run.graphThreadId,
          generation: priorJob.generation,
          executionSegment: priorJob.reference.executionSegment,
          interrupts: priorJob.interrupts.map(interrupt => ({ ...interrupt })),
          parkedAt: priorJob.parkedAt.toISOString(),
          ...parkAadFields(priorJob),
        },
        pristine: true,
      },
      proof: expected.proof,
      authorizationRequestId: expected.authorizationRequestId,
    });
    if (copy === null
      || !sameParkedProtectedTaskAdditionalAuthority(expected, copy)) {
      throw new TypeError("Parked Task authority descriptor is invalid");
    }
    return copy;
  } catch (error) {
    if (error instanceof TypeError
      && error.message === "Parked Task authority descriptor is invalid") {
      throw error;
    }
    throw new TypeError("Parked Task authority descriptor is invalid", {
      cause: error,
    });
  }
}

function checkpointDescriptorTuple(value: ParkedProtectedTaskCheckpointContinuation): readonly unknown[] {
  const t = value.occurrence.task;
  const r = value.occurrence.run;
  const p = value.priorJob;
  const j = p.reference;
  return [t.id, t.ownerId, t.requestorId, t.agentId, t.callingRoomId, t.scheduleKind,
    t.status, t.contentRepresentation, t.contentNamespaceId, t.contentRevision,
    t.cryptoObjectId, t.cryptoAccessRevision, encodeRoutingDigest(t.cryptoRequiredNamespaceFingerprint),
    t.definitionHistoricalRepair ?? null,
    r.id, r.taskId, r.jobId, r.graphThreadId, r.status, r.startedAt.toISOString(),
    p.id, p.generation, p.parkedAt.toISOString(), p.interrupts, p.checkpointAadBinding,
    j.kind, j.taskId, j.taskRunId, j.inputObjectId, j.resultObjectId,
    j.authorizationRequestId, j.policyRevision, j.executionSegment,
    j.resumeAcceptanceId, j.resumeContinuationFingerprint,
    checkpointContinuationFingerprint(value.proof, value.stableRoutingDigest),
    value.continuationFingerprint, value.authorizationRequestId, value.nextExecutionSegment];
}

export function sameParkedProtectedTaskCheckpointContinuation(
  left: ParkedProtectedTaskCheckpointContinuation,
  right: ParkedProtectedTaskCheckpointContinuation,
): boolean {
  try { return JSON.stringify(checkpointDescriptorTuple(left)) === JSON.stringify(checkpointDescriptorTuple(right)); }
  catch { return false; }
}

export function copyParkedProtectedTaskCheckpointContinuation(
  expected: ParkedProtectedTaskCheckpointContinuation,
): ParkedProtectedTaskCheckpointContinuation {
  const t = expected.occurrence.task;
  const r = expected.occurrence.run;
  const p = expected.priorJob;
  const copy = parseParkedProtectedTaskCheckpointContinuation({
    task: { ...t, cryptoMappingState: "verified", contentPristine: true },
    run: { ...r, pristine: true },
    job: { id: p.id, ownerId: t.requestorId, requestorId: t.requestorId,
      laneKey: `task:${t.id}`, type: "foreground", status: "completed",
      startedAt: r.startedAt, completedAt: p.parkedAt, reference: p.reference,
      pristine: true, parkReceipt: {
        version: 1, taskId: t.id, taskRunId: r.id, jobId: p.id,
        graphThreadId: r.graphThreadId, generation: p.generation,
        executionSegment: p.reference.executionSegment, interrupts: p.interrupts,
        ...parkAadFields(p),
        parkedAt: p.parkedAt.toISOString(), stableRoutingDigest: encodeRoutingDigest(expected.stableRoutingDigest),
      } },
    proof: expected.proof,
  });
  if (copy === null || !sameParkedProtectedTaskCheckpointContinuation(expected, copy)) {
    throw new TypeError("Parked Task checkpoint descriptor is invalid");
  }
  return copy;
}

export function copyParkedProtectedTaskHumanContinuation(
  expected: ParkedProtectedTaskHumanContinuation,
): ParkedProtectedTaskHumanContinuation {
  try {
    if (expected.priorJob.checkpointAadBinding !== undefined && (
      parseProtectedTaskCheckpointAadBinding(expected.priorJob.checkpointAadBinding) === null
      || expected.priorJob.checkpointAadBinding.namespaceId !== expected.occurrence.task.contentNamespaceId
      || expected.priorJob.checkpointAadBinding.policyRevision > expected.priorJob.reference.policyRevision)) {
      throw new TypeError("Parked Task Human descriptor is invalid");
    }
    assertProtectedTaskHumanContinuationAcceptance(expected.acceptance);
    if (expected.acceptance.acceptanceId
      !== protectedTaskHumanContinuationAcceptanceId({
        taskId: expected.occurrence.task.id,
        taskRunId: expected.occurrence.run.id,
        priorJobId: expected.priorJob.id,
        executionSegment: expected.priorJob.reference.executionSegment,
        acceptedBy: expected.acceptance.acceptedBy,
        interrupt: expected.acceptance.interrupt,
        response: expected.acceptance.response,
      })
      || expected.authorizationRequestId !== expected.acceptance.acceptanceId
      || expected.nextExecutionSegment
        !== expected.priorJob.reference.executionSegment + 1
      || expected.stableRoutingDigest.length !== 32) {
      throw new TypeError("Parked Task Human descriptor is invalid");
    }
    const response = expected.acceptance.response;
    const copy: ParkedProtectedTaskHumanContinuation = Object.freeze({
      occurrence: Object.freeze({
        task: Object.freeze({
          ...expected.occurrence.task,
          cryptoRequiredNamespaceFingerprint:
            expected.occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
        }),
        run: Object.freeze({
          ...expected.occurrence.run,
          startedAt: new Date(expected.occurrence.run.startedAt.getTime()),
        }),
      }),
      priorJob: Object.freeze({
        ...expected.priorJob,
        ...parkAadFields(expected.priorJob),
        parkedAt: new Date(expected.priorJob.parkedAt.getTime()),
        interrupts: copyProtectedTaskInterrupts(expected.priorJob.interrupts),
        reference: Object.freeze({ ...expected.priorJob.reference }),
      }),
      segment: cloneProtectedTaskExecutionSegment(expected.segment),
      stableRoutingDigest: expected.stableRoutingDigest.slice(),
      acceptance: Object.freeze({
        acceptanceId: expected.acceptance.acceptanceId,
        acceptedBy: Object.freeze({ ...expected.acceptance.acceptedBy }),
        interrupt: Object.freeze({ ...expected.acceptance.interrupt }),
        response: response.kind === "await_reply"
          ? Object.freeze({
              kind: "await_reply" as const,
              message: Object.freeze({ ...response.message }),
            })
          : Object.freeze({ ...response }),
        acceptedAt: new Date(expected.acceptance.acceptedAt.getTime()),
      }),
      authorizationRequestId: expected.authorizationRequestId,
      nextExecutionSegment: expected.nextExecutionSegment,
    });
    if (!sameParkedProtectedTaskHumanContinuation(expected, copy)) {
      throw new TypeError("Parked Task Human descriptor is invalid");
    }
    return copy;
  } catch (error) {
    if (error instanceof TypeError
      && error.message === "Parked Task Human descriptor is invalid") throw error;
    throw new TypeError("Parked Task Human descriptor is invalid", {
      cause: error,
    });
  }
}

/** Shared content-free projections for discovery and locked revalidation. */
export const parkedTaskAdditionalAuthorityTaskProjection = Object.freeze({
  pauseRequestId: tasks.pauseRequestId,
  id: tasks.id,
  ownerId: tasks.ownerId,
  requestorId: tasks.requestorId,
  agentId: tasks.agentId,
  callingRoomId: tasks.callingRoomId,
  scheduleKind: tasks.scheduleKind,
  status: tasks.status,
  contentRepresentation: tasks.contentRepresentation,
  contentNamespaceId: tasks.contentNamespaceId,
  contentRevision: tasks.contentRevision,
  cryptoObjectId: tasks.cryptoObjectId,
  definitionHistoricalRepair: protectedTaskDefinitionHistoricalRepairProjection,
  cryptoAccessRevision: tasks.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint:
    tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
  contentPristine: and(
    isNull(tasks.lastError),
    or(ne(tasks.contentRepresentation, "protected"), and(
      eq(tasks.prompt, ""), isNull(tasks.expectedOutput),
    )),
  )!.mapWith(Boolean),
});

export const parkedTaskAdditionalAuthorityRunProjection = Object.freeze({
  id: taskRuns.id,
  taskId: taskRuns.taskId,
  jobId: taskRuns.jobId,
  graphThreadId: taskRuns.graphThreadId,
  status: taskRuns.status,
  startedAt: taskRuns.startedAt,
  pristine: and(
    isNull(taskRuns.resultText),
    isNull(taskRuns.completedAt),
    isNull(taskRuns.lastError),
    eq(taskRuns.resultRepresentation, "ordinary"),
    isNull(taskRuns.resultContentNamespaceId),
    eq(taskRuns.resultRevision, 0),
    isNull(taskRuns.resultCryptoObjectId),
    eq(taskRuns.resultCryptoAccessRevision, 0),
    isNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
    eq(taskRuns.resultCryptoMappingState, "unmapped"),
  )!.mapWith(Boolean),
});

// Only closed execution coordinates may cross this categorical owner. The
// nested CASE also rejects non-object JSON before applying object operators.
const protectedApprovalJobInput = sql<Record<string, unknown> | null>`CASE
  WHEN jsonb_typeof(${jobs.input}) = 'object' THEN CASE WHEN
    (${jobs.input} - ARRAY['kind','taskId','taskRunId','inputObjectId','resultObjectId',
      'authorizationRequestId','policyRevision','executionSegment',
      'resumeAcceptanceId','resumeContinuationFingerprint']::text[]) = '{}'::jsonb
    AND ${sql.join(["kind", "taskId", "taskRunId", "inputObjectId", "resultObjectId",
      "authorizationRequestId"].map(key =>
      sql`jsonb_typeof(${jobs.input} -> ${key}) = 'string'`), sql` AND `)}
    AND jsonb_typeof(${jobs.input} -> 'policyRevision') = 'number'
    AND jsonb_typeof(${jobs.input} -> 'executionSegment') = 'number'
    AND ${sql.join(["resumeAcceptanceId", "resumeContinuationFingerprint"].map(key =>
      sql`(NOT (${jobs.input} ? ${key}) OR jsonb_typeof(${jobs.input} -> ${key}) = 'string')`), sql` AND `)}
  THEN ${jobs.input} ELSE NULL END ELSE NULL END`;

export const parkedTaskAdditionalAuthorityJobProjection = Object.freeze({
  id: jobs.id,
  ownerId: jobs.ownerId,
  requestorId: jobs.requestorId,
  laneKey: jobs.laneKey,
  type: jobs.type,
  status: jobs.status,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  reference: protectedApprovalJobInput,
  parkReceipt: sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY}`,
  pristine: and(
    isNull(jobs.result),
    isNull(jobs.message),
    sql<boolean>`NOT (${jobs.metadata} ? ${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY})`,
  )!.mapWith(Boolean),
});

const parkedTaskHumanContinuationTaskProjection = Object.freeze({
  ...parkedTaskAdditionalAuthorityTaskProjection,
  targetRoomId: tasks.targetRoomId,
  targetUserIds: tasks.targetUserIds,
  localExecutionDelegation: tasks.localExecutionDelegation,
});

const parkedTaskHumanContinuationJobProjection = Object.freeze({
  ...parkedTaskAdditionalAuthorityJobProjection,
  acceptanceReceipt:
    sql<unknown>`${jobs.metadata} -> ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}`,
});

// Preserve explicit JSON null: a malformed existing receipt must conflict,
// rather than look absent and become eligible for a first write.
const protectedApprovalJobMetadata = sql<Record<string, unknown>>`(${sql.join([
  PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY,
  PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY,
  PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY,
  PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY,
].map(key => sql`CASE WHEN ${jobs.metadata} ? ${key}
  THEN jsonb_build_object(${key}::text, ${jobs.metadata} -> ${key})
  ELSE '{}'::jsonb END`), sql` || `)})`;

const protectedApprovalJobProjection = Object.freeze({
  id: jobs.id, ownerId: jobs.ownerId, requestorId: jobs.requestorId,
  laneKey: jobs.laneKey, type: jobs.type, status: jobs.status,
  startedAt: jobs.startedAt, completedAt: jobs.completedAt,
  input: protectedApprovalJobInput,
  metadata: protectedApprovalJobMetadata,
  metadataEmpty: sql<boolean>`${jobs.metadata} = '{}'::jsonb`.mapWith(Boolean),
  pristine: parkedTaskAdditionalAuthorityJobProjection.pristine,
});

type ProtectedApprovalTaskRow = ParkedProtectedTaskHumanContinuationTaskRow
  & Readonly<{ pauseRequestId: string | null }>;
type ProtectedApprovalJobRow = Pick<Job,
  "id" | "ownerId" | "requestorId" | "laneKey" | "type" | "status"
  | "startedAt" | "completedAt" | "input" | "metadata">
  & Readonly<{ pristine: boolean; metadataEmpty: boolean }>;

function setProtectedApprovalReceipt(key: string, receipt: unknown) {
  return sql`jsonb_set(${jobs.metadata}, ARRAY[${key}]::text[],
    ${JSON.stringify(receipt)}::jsonb, true)`;
}

const protectedTaskPendingAttentionProjection = Object.freeze({
  task: parkedTaskHumanContinuationTaskProjection,
  run: parkedTaskAdditionalAuthorityRunProjection,
  job: parkedTaskHumanContinuationJobProjection,
  segment: getTableColumns(protectedTaskExecutionSegmentReceipts),
  human: Object.freeze({
    humanActorId: actors.id,
    userId: actors.ownerId,
    kind: actors.kind,
    disabledAt: users.disabledAt,
  }),
});

export type LockedParkedProtectedTaskAdditionalAuthorityTaskRow =
  ParkedProtectedTaskAdditionalAuthorityTaskRow & Readonly<{
    preset: string;
    targetUserIds: unknown;
    useScope: boolean;
    scopeId: string | null;
    targetChat: string;
    targetRoomId: string | null;
    wideBringBack: boolean;
  }>;

export type LockedParkedProtectedTaskHumanContinuationTaskRow =
  LockedParkedProtectedTaskAdditionalAuthorityTaskRow & Readonly<{
    targetRoomId: string | null;
    targetUserIds: readonly string[];
    localExecutionDelegation: unknown;
  }>;

const lockedParkedTaskAdditionalAuthorityTaskProjection = Object.freeze({
  ...parkedTaskAdditionalAuthorityTaskProjection,
  preset: tasks.preset,
  targetUserIds: tasks.targetUserIds,
  useScope: tasks.useScope,
  scopeId: tasks.scopeId,
  targetChat: tasks.targetChat,
  targetRoomId: tasks.targetRoomId,
  wideBringBack:
    sql<boolean>`(${tasks.metadata} -> 'bringBack') IS DISTINCT FROM 'false'::jsonb`
      .mapWith(Boolean).as("wide_bring_back"),
});

const lockedParkedTaskHumanContinuationTaskProjection = Object.freeze({
  ...lockedParkedTaskAdditionalAuthorityTaskProjection,
  targetRoomId: tasks.targetRoomId,
  targetUserIds: tasks.targetUserIds,
  localExecutionDelegation: tasks.localExecutionDelegation,
});

/**
 * Re-read one parked additional-authority descriptor while holding the
 * canonical Task -> Run -> prior Job lifecycle locks.
 */
export async function lockParkedProtectedTaskAdditionalAuthority(
  transaction: Pick<DirectDatabase, "select">,
  supplied: ParkedProtectedTaskAdditionalAuthority,
): Promise<Readonly<{
  current: ParkedProtectedTaskAdditionalAuthority;
  task: LockedParkedProtectedTaskAdditionalAuthorityTaskRow;
}> | null> {
  const expected = copyParkedProtectedTaskAdditionalAuthority(supplied);
  const taskRows = await transaction.select(
    lockedParkedTaskAdditionalAuthorityTaskProjection,
  ).from(tasks).where(eq(tasks.id, expected.occurrence.task.id))
    .limit(2).for("update");
  const task = taskRows.length === 1
    ? taskRows[0] as LockedParkedProtectedTaskAdditionalAuthorityTaskRow
    : undefined;
  if (task === undefined) return null;

  const runRows = await transaction.select(
    parkedTaskAdditionalAuthorityRunProjection,
  ).from(taskRuns).where(and(
    eq(taskRuns.id, expected.occurrence.run.id),
    eq(taskRuns.taskId, task.id),
  )).limit(2).for("update");
  const run = runRows.length === 1
    ? runRows[0] as ParkedProtectedTaskAdditionalAuthorityRunRow
    : undefined;
  if (run === undefined || run.jobId !== expected.priorJob.id) return null;

  const jobRows = await transaction.select(
    parkedTaskAdditionalAuthorityJobProjection,
  ).from(jobs).where(and(
    eq(jobs.id, expected.priorJob.id),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
  )).limit(2).for("update");
  const job = jobRows.length === 1
    ? jobRows[0] as ParkedProtectedTaskAdditionalAuthorityJobRow
    : undefined;
  if (job === undefined) return null;

  const proof = await readProtectedTaskExecutionContinuationProof(
    transaction,
    {
      taskId: task.id,
      taskRunId: run.id,
      jobId: job.id,
      executionSegment: expected.priorJob.reference.executionSegment,
    },
  );
  const current = parseParkedProtectedTaskAdditionalAuthority({
    task,
    run,
    job,
    proof,
    authorizationRequestId: expected.authorizationRequestId,
  });
  return current !== null
      && sameParkedProtectedTaskAdditionalAuthority(expected, current)
    ? Object.freeze({ current, task })
    : null;
}

/**
 * Discover one parked additional-authority candidate without taking lifecycle
 * locks. The descriptor is content-free and must be revalidated by its later
 * authority owner before any protected execution is admitted.
 */
async function readParkedProtectedTaskAdditionalAuthorityCandidate(
  db: Pick<DirectDatabase, "select">,
  taskRunId: string,
): Promise<Readonly<{
  row: Readonly<{
    task: ParkedProtectedTaskAdditionalAuthorityTaskRow & Readonly<{ pauseRequestId?: string | null }>;
    run: ParkedProtectedTaskAdditionalAuthorityRunRow;
    job: ParkedProtectedTaskAdditionalAuthorityJobRow;
  }>;
  proof: ProtectedTaskExecutionContinuationProof;
}> | null> {
  if (!CANONICAL_UUID.test(taskRunId)) {
    throw new TypeError(
      "Protected Task additional-authority discovery identity is malformed",
    );
  }
  const rows = await db.select({
    task: parkedTaskAdditionalAuthorityTaskProjection,
    run: parkedTaskAdditionalAuthorityRunProjection,
    job: parkedTaskAdditionalAuthorityJobProjection,
  }).from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .where(and(
      eq(taskRuns.id, taskRunId),
      eq(taskRuns.status, "awaiting"),
      eq(jobs.status, "completed"),
      sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
    )).limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!isRecord(row.job.reference)
    || !Number.isSafeInteger(row.job.reference["executionSegment"])) {
    return null;
  }
  const proof = await readProtectedTaskExecutionContinuationProof(db, {
    taskId: row.task.id,
    taskRunId: row.run.id,
    jobId: row.job.id,
    executionSegment: row.job.reference["executionSegment"] as number,
  });
  return proof === null ? null : Object.freeze({ row, proof });
}

export async function discoverParkedProtectedTaskCheckpointContinuation(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string }>,
): Promise<ParkedProtectedTaskCheckpointContinuation | null> {
  const candidate = await readParkedProtectedTaskAdditionalAuthorityCandidate(db, input.taskRunId);
  return candidate === null ? null : parseParkedProtectedTaskCheckpointContinuation({ ...candidate.row, proof: candidate.proof });
}

export async function readParkedProtectedTaskCheckpointContinuation(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string; authorizationRequestId: string }>,
): Promise<ParkedProtectedTaskCheckpointContinuation | null> {
  const current = await discoverParkedProtectedTaskCheckpointContinuation(db, input);
  return current?.authorizationRequestId === input.authorizationRequestId ? current : null;
}

export async function lockParkedProtectedTaskCheckpointContinuation(
  transaction: Pick<DirectDatabase, "select">,
  supplied: ParkedProtectedTaskCheckpointContinuation,
): Promise<Readonly<{ current: ParkedProtectedTaskCheckpointContinuation;
  task: LockedParkedProtectedTaskAdditionalAuthorityTaskRow }> | null> {
  const expected = copyParkedProtectedTaskCheckpointContinuation(supplied);
  const [task] = await transaction.select(lockedParkedTaskAdditionalAuthorityTaskProjection)
    .from(tasks).where(eq(tasks.id, expected.occurrence.task.id)).limit(1).for("update");
  if (!task || task.pauseRequestId !== null) return null;
  const [run] = await transaction.select(parkedTaskAdditionalAuthorityRunProjection)
    .from(taskRuns).where(and(eq(taskRuns.id, expected.occurrence.run.id), eq(taskRuns.taskId, task.id)))
    .limit(1).for("update");
  if (!run || run.jobId !== expected.priorJob.id) return null;
  const [job] = await transaction.select(parkedTaskAdditionalAuthorityJobProjection)
    .from(jobs).where(eq(jobs.id, expected.priorJob.id)).limit(1).for("update");
  if (!job) return null;
  const proof = await readProtectedTaskExecutionContinuationProof(transaction, {
    taskId: task.id, taskRunId: run.id, jobId: job.id,
    executionSegment: expected.priorJob.reference.executionSegment,
  });
  const current = parseParkedProtectedTaskCheckpointContinuation({ task, run, job, proof });
  return current !== null && sameParkedProtectedTaskCheckpointContinuation(expected, current)
    ? Object.freeze({ current, task }) : null;
}

/**
 * Discover one parked candidate for an already known authorization request.
 * The request filter is retained for callers correlating an external row.
 */
export async function readParkedProtectedTaskAdditionalAuthority(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string; authorizationRequestId: string }>,
): Promise<ParkedProtectedTaskAdditionalAuthority | null> {
  const authorizationRequestId = input.authorizationRequestId;
  if (!opaqueCheckpointCoordinate(authorizationRequestId)) {
    throw new TypeError(
      "Protected Task additional-authority discovery identity is malformed",
    );
  }
  const candidate = await readParkedProtectedTaskAdditionalAuthorityCandidate(
    db,
    input.taskRunId,
  );
  if (candidate === null) return null;
  return parseParkedProtectedTaskAdditionalAuthority({
    ...candidate.row,
    proof: candidate.proof,
    authorizationRequestId,
  });
}

/**
 * Restart discovery derives the exact request from the immutable park/proof.
 * It never guesses from a mutable authorization row or caller coordinate.
 */
export async function discoverParkedProtectedTaskAdditionalAuthority(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string }>,
): Promise<ParkedProtectedTaskAdditionalAuthority | null> {
  const candidate = await readParkedProtectedTaskAdditionalAuthorityCandidate(
    db,
    input.taskRunId,
  );
  if (candidate === null) return null;
  const continuation = candidate.proof.continuation;
  if (continuation.kind !== "pre_effect_interrupt_v1"
    || continuation.reason !== "additional_authority"
    || typeof continuation.interruptId !== "string"
    || !isRecord(candidate.row.job.parkReceipt)) return null;
  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      candidate.row.job.parkReceipt["interrupts"] as
        readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  const matching = interrupts.filter(interrupt =>
    interrupt.id === continuation.interruptId
      && interrupt.kind === "additional_authority"
      && typeof interrupt.requestId === "string"
      && opaqueCheckpointCoordinate(interrupt.requestId)
  );
  if (matching.length !== 1 || matching[0]?.requestId === undefined) return null;
  return parseParkedProtectedTaskAdditionalAuthority({
    ...candidate.row,
    proof: candidate.proof,
    authorizationRequestId: matching[0].requestId,
  });
}

async function readCurrentEnabledHumanActor(
  db: Pick<DirectDatabase, "select">,
  acceptedBy: ProtectedTaskHumanContinuationAcceptance["acceptedBy"],
  lock: boolean,
): Promise<boolean> {
  const query = db.select({
    humanActorId: actors.id,
    userId: actors.ownerId,
    kind: actors.kind,
    disabledAt: users.disabledAt,
  }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
    eq(actors.id, acceptedBy.humanActorId),
    eq(actors.ownerId, acceptedBy.userId),
    eq(actors.kind, "user"),
    isNull(users.disabledAt),
  )).limit(2);
  const rows = lock ? await query.for("share") : await query;
  return rows.length === 1
    && rows[0]!.humanActorId === acceptedBy.humanActorId
    && rows[0]!.userId === acceptedBy.userId
    && rows[0]!.kind === "user"
    && rows[0]!.disabledAt === null;
}

type ProtectedTaskPendingAttentionRow = Readonly<{
  task: ParkedProtectedTaskHumanContinuationTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskHumanContinuationJobRow;
  segment: ProtectedTaskExecutionSegmentReceipt;
  human: Readonly<{
    humanActorId: string;
    userId: string;
    kind: string;
    disabledAt: Date | null;
  }>;
}>;

function protectedTaskPendingAttentionPredicate(
  viewer: ProtectedTaskPendingAttentionViewer,
) {
  return and(
    eq(actors.id, viewer.humanActorId),
    eq(actors.ownerId, viewer.userId),
    eq(actors.kind, "user"),
    eq(users.id, viewer.userId),
    isNull(users.disabledAt),
    or(
      and(isNull(tasks.localExecutionDelegation), eq(tasks.ownerId, viewer.userId)),
      and(
        isNotNull(tasks.localExecutionDelegation),
        eq(tasks.requestorId, viewer.userId),
      ),
    ),
    or(
      and(eq(tasks.scheduleKind, "cron"), eq(tasks.status, "pending")),
      and(notInArray(tasks.scheduleKind, ["cron"]), eq(tasks.status, "awaiting")),
    ),
    inArray(tasks.contentRepresentation, ["dual", "protected"]),
    eq(tasks.cryptoMappingState, "verified"),
    eq(taskRuns.status, "awaiting"),
    eq(jobs.status, "completed"),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
    sql`NOT (${jobs.metadata} ? ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY})`,
  );
}

function parseProtectedTaskPendingAttentionRow(
  row: ProtectedTaskPendingAttentionRow,
  viewer: ProtectedTaskPendingAttentionViewer,
): ProtectedTaskPendingAttentionCandidate | null {
  const { task, run, job, segment, human } = row;
  if (human.humanActorId !== viewer.humanActorId
    || human.userId !== viewer.userId
    || human.kind !== "user"
    || human.disabledAt !== null
    || !CANONICAL_UUID.test(task.id)
    || !CANONICAL_UUID.test(task.ownerId)
    || !CANONICAL_UUID.test(task.requestorId)
    || !CANONICAL_UUID.test(task.agentId)
    || task.status !== (task.scheduleKind === "cron" ? "pending" : "awaiting")
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null
    || task.cryptoObjectId === null
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || task.contentPristine !== true
    || run.taskId !== task.id
    || run.jobId !== job.id
    || run.status !== "awaiting"
    || run.pristine !== true
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || job.status !== "completed"
    || job.startedAt === null
    || job.completedAt === null
    || job.pristine !== true
    || !isRecord(job.reference)
    || !isRecord(job.parkReceipt)
    || job.acceptanceReceipt !== null
    || segment === null) return null;

  const delegation = task.localExecutionDelegation === null
    || task.localExecutionDelegation === undefined
    ? null
    : parseLocalExecutionDelegation(task.localExecutionDelegation);
  const recipient = task.localExecutionDelegation === null
    || task.localExecutionDelegation === undefined
    ? task.ownerId
    : delegation !== null
        && delegation.humanUserId === task.requestorId
        && delegation.agentId === task.agentId
      ? delegation.humanUserId
      : null;
  if (recipient !== viewer.userId) return null;

  const reference = job.reference as ProtectedTaskDurableJobReference;
  if (!exactProtectedTaskJobReference(job.reference, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.inputObjectId !== task.cryptoObjectId
    || reference.resultObjectId !== protectedTaskRunResultObjectId(task.id, run.id)
    || reference.executionSegment < 1
    || reference.executionSegment === Number.MAX_SAFE_INTEGER) return null;

  const rawPark = job.parkReceipt;
  const parkedAtText = rawPark["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  const stableRoutingDigest = decodeRoutingDigest(rawPark["stableRoutingDigest"]);
  if (!Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || job.completedAt.getTime() !== parkedAt.getTime()
    || !Number.isSafeInteger(rawPark["generation"])
    || (rawPark["generation"] as number) < 0
    || stableRoutingDigest === null) return null;

  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      rawPark["interrupts"] as readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  const park: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    ...parkAadFields(rawPark, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawPark["generation"] as number,
    executionSegment: reference.executionSegment,
    interrupts,
    parkedAt: parkedAt.toISOString(),
    stableRoutingDigest: rawPark["stableRoutingDigest"] as string,
  });
  if (!exactParkReceipt(rawPark, park)
    || segment.taskRunId !== run.id
    || segment.jobId !== job.id
    || segment.executionSegment !== reference.executionSegment
    || segment.route !== "native_langgraph_v1"
    || segment.transcriptContract !== "protected_message_associations_v1"
    || !Number.isSafeInteger(segment.expectedTranscriptAssociationCount)
    || segment.expectedTranscriptAssociationCount < 0
    || !(segment.transcriptAssociationDigest instanceof Uint8Array)
    || segment.transcriptAssociationDigest.length !== 32
    || segment.checkpointContract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(segment.expectedCheckpointCount)
    || segment.expectedCheckpointCount < 1
    || !(segment.checkpointDigest instanceof Uint8Array)
    || segment.checkpointDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedCheckpointBlobCount)
    || segment.expectedCheckpointBlobCount < 0
    || !(segment.checkpointBlobDigest instanceof Uint8Array)
    || segment.checkpointBlobDigest.length !== 32
    || !Number.isSafeInteger(segment.expectedPendingWriteCount)
    || segment.expectedPendingWriteCount < 0
    || !(segment.pendingWriteDigest instanceof Uint8Array)
    || segment.pendingWriteDigest.length !== 32
    || !(segment.sealedAt instanceof Date)
    || segment.sealedAt.getTime() !== parkedAt.getTime()) return null;

  const pendingAttentionInterrupts: ProtectedTaskPendingAttentionInterrupt[] = [];
  for (const interrupt of interrupts) {
    if (interrupt.kind === "approval" && interrupt.requestId !== undefined) {
      pendingAttentionInterrupts.push(Object.freeze({
        id: interrupt.id,
        kind: "approval",
        requestId: interrupt.requestId,
        ...(interrupt.allowedVerbs === undefined ? {} : {
          allowedVerbs: Object.freeze([...interrupt.allowedVerbs]),
        }),
      }));
    } else if (interrupt.kind === "prove_it"
      && interrupt.requestId === undefined) {
      pendingAttentionInterrupts.push(Object.freeze({
        id: interrupt.id,
        kind: "prove_it",
      }));
    } else if (interrupt.kind === "identity") {
      pendingAttentionInterrupts.push(Object.freeze({
        id: interrupt.id,
        kind: "identity",
        ...(interrupt.requestId === undefined
          ? {}
          : { requestId: interrupt.requestId }),
      }));
    }
  }
  if (pendingAttentionInterrupts.length === 0) return null;

  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: task.id,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        agentId: task.agentId,
        callingRoomId: task.callingRoomId,
        scheduleKind: task.scheduleKind,
        status: task.status,
        contentRepresentation: task.contentRepresentation,
        contentNamespaceId: task.contentNamespaceId,
        contentRevision: task.contentRevision,
        cryptoObjectId: task.cryptoObjectId,
        ...copyDefinitionHistoricalMetadata(task),
        cryptoAccessRevision: task.cryptoAccessRevision,
        cryptoRequiredNamespaceFingerprint:
          task.cryptoRequiredNamespaceFingerprint.slice(),
        targetRoomId: task.targetRoomId,
        cryptoMappingState: "verified" as const,
      }),
      run: Object.freeze({
        id: run.id,
        taskId: run.taskId,
        jobId: job.id,
        graphThreadId: run.graphThreadId,
        status: "awaiting" as const,
        startedAt: new Date(run.startedAt.getTime()),
      }),
    }),
    priorJob: Object.freeze({
      ...parkAadFields(park),
      id: job.id,
      generation: park.generation,
      parkedAt: new Date(parkedAt.getTime()),
      interrupts: copyProtectedTaskInterrupts(interrupts),
      reference: Object.freeze({ ...reference }),
    }),
    stableRoutingDigest: stableRoutingDigest.slice(),
    pendingAttentionInterrupts: Object.freeze(pendingAttentionInterrupts),
    checkpointManifest: Object.freeze({
      contract: "encrypted_langgraph_v1" as const,
      expectedCheckpointCount: segment.expectedCheckpointCount,
      checkpointOrderedDigest: segment.checkpointDigest.slice(),
      expectedBlobCount: segment.expectedCheckpointBlobCount,
      blobOrderedDigest: segment.checkpointBlobDigest.slice(),
      expectedPendingWriteCount: segment.expectedPendingWriteCount,
      pendingWriteOrderedDigest: segment.pendingWriteDigest.slice(),
    }),
  });
}

function assertProtectedTaskPendingAttentionViewer(
  viewer: ProtectedTaskPendingAttentionViewer,
): void {
  if (!CANONICAL_UUID.test(viewer.userId)
    || !CANONICAL_UUID.test(viewer.humanActorId)) {
    throw new TypeError("Protected Task pending-attention viewer is malformed");
  }
}

/** Page active content-free Human dialog coordinates in stable Run order. */
export async function listProtectedTaskPendingAttentionCandidates(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    viewer: ProtectedTaskPendingAttentionViewer;
    limit: number;
    after?: ProtectedTaskPendingAttentionCursor;
  }>,
): Promise<ProtectedTaskPendingAttentionPage> {
  assertProtectedTaskPendingAttentionViewer(input.viewer);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new TypeError("Protected Task pending-attention limit is malformed");
  }
  if (input.after !== undefined
    && (!(input.after.startedAt instanceof Date)
      || !Number.isFinite(input.after.startedAt.getTime())
      || !CANONICAL_UUID.test(input.after.taskRunId))) {
    throw new TypeError("Protected Task pending-attention cursor is malformed");
  }
  const rows = await db.select(protectedTaskPendingAttentionProjection)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .innerJoin(protectedTaskExecutionSegmentReceipts, and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, taskRuns.id),
      eq(protectedTaskExecutionSegmentReceipts.jobId, jobs.id),
    ))
    .innerJoin(actors, eq(actors.id, input.viewer.humanActorId))
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(
      protectedTaskPendingAttentionPredicate(input.viewer),
      ...(input.after === undefined ? [] : [or(
        gt(taskRuns.startedAt, input.after.startedAt),
        and(
          eq(taskRuns.startedAt, input.after.startedAt),
          gt(taskRuns.id, input.after.taskRunId),
        ),
      )]),
    ))
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.id))
    .limit(input.limit);
  const candidates = rows.flatMap(row => {
    const parsed = parseProtectedTaskPendingAttentionRow(
      row as ProtectedTaskPendingAttentionRow,
      input.viewer,
    );
    return parsed === null ? [] : [parsed];
  });
  const last = rows.length === input.limit ? rows.at(-1)?.run : undefined;
  return Object.freeze({
    candidates: Object.freeze(candidates),
    nextCursor: last === undefined ? null : Object.freeze({
      startedAt: new Date(last.startedAt.getTime()),
      taskRunId: last.id,
    }),
  });
}

/** Re-read one exact Task/Run pair under the same discovery predicates. */
export async function readProtectedTaskPendingAttentionCandidate(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{
    viewer: ProtectedTaskPendingAttentionViewer;
    taskId: string;
    taskRunId: string;
  }>,
): Promise<ProtectedTaskPendingAttentionCandidate | null> {
  assertProtectedTaskPendingAttentionViewer(input.viewer);
  if (!CANONICAL_UUID.test(input.taskId) || !CANONICAL_UUID.test(input.taskRunId)) {
    throw new TypeError("Protected Task pending-attention identity is malformed");
  }
  const rows = await db.select(protectedTaskPendingAttentionProjection)
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .innerJoin(protectedTaskExecutionSegmentReceipts, and(
      eq(protectedTaskExecutionSegmentReceipts.taskRunId, taskRuns.id),
      eq(protectedTaskExecutionSegmentReceipts.jobId, jobs.id),
    ))
    .innerJoin(actors, eq(actors.id, input.viewer.humanActorId))
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(
      protectedTaskPendingAttentionPredicate(input.viewer),
      eq(tasks.id, input.taskId),
      eq(taskRuns.id, input.taskRunId),
    ))
    .limit(2);
  return rows.length === 1
    ? parseProtectedTaskPendingAttentionRow(
        rows[0] as ProtectedTaskPendingAttentionRow,
        input.viewer,
      )
    : null;
}

function protectedTaskPendingAttentionBindingDigest(
  candidate: ProtectedTaskPendingAttentionCandidate,
): string {
  return approvalPolicyDigest({
    taskId: candidate.occurrence.task.id,
    taskRunId: candidate.occurrence.run.id,
    graphThreadId: candidate.occurrence.run.graphThreadId,
    jobId: candidate.priorJob.id,
    generation: candidate.priorJob.generation,
    executionSegment: candidate.priorJob.reference.executionSegment,
    parkedAt: candidate.priorJob.parkedAt.toISOString(),
    reference: candidate.priorJob.reference,
    stableRoutingDigest: Buffer.from(candidate.stableRoutingDigest).toString("base64url"),
    interrupts: candidate.priorJob.interrupts.map(interrupt => ({
      id: interrupt.id, kind: interrupt.kind,
      requestId: interrupt.requestId ?? null,
      allowedVerbs: interrupt.allowedVerbs ?? null,
    })),
    checkpointManifest: {
      contract: candidate.checkpointManifest.contract,
      expectedCheckpointCount: candidate.checkpointManifest.expectedCheckpointCount,
      checkpointOrderedDigest: Buffer.from(
        candidate.checkpointManifest.checkpointOrderedDigest,
      ).toString("base64url"),
      expectedBlobCount: candidate.checkpointManifest.expectedBlobCount,
      blobOrderedDigest: Buffer.from(
        candidate.checkpointManifest.blobOrderedDigest,
      ).toString("base64url"),
      expectedPendingWriteCount: candidate.checkpointManifest.expectedPendingWriteCount,
      pendingWriteOrderedDigest: Buffer.from(
        candidate.checkpointManifest.pendingWriteOrderedDigest,
      ).toString("base64url"),
    },
  });
}

/** First-write the categorical policy recovered by an authenticated legacy
 * checkpoint read. The sidecar is bound to the immutable park and checkpoint
 * manifests; it never stores tool names, arguments, reasons, or plaintext. */
export async function sealProtectedTaskHumanApprovalPolicy(
  db: DirectDatabase,
  input: SealProtectedTaskHumanApprovalPolicyInput,
): Promise<SealProtectedTaskHumanApprovalPolicyResult> {
  assertProtectedTaskPendingAttentionViewer(input.viewer);
  const policies = canonicalApprovalPolicies(input.policies);
  const legacyApprovals = input.candidate.pendingAttentionInterrupts.filter(
    interrupt => interrupt.kind === "approval"
      && interrupt.allowedVerbs === undefined,
  );
  if (legacyApprovals.length === 0) return { status: "not_needed" };
  if (policies.length !== legacyApprovals.length
    || !legacyApprovals.every((interrupt, index) => {
      const policy = policies[index];
      return policy?.interruptId === interrupt.id
        && policy.requestId === interrupt.requestId;
    })) return { status: "rejected", reason: "conflict" };

  const expectedBinding = protectedTaskPendingAttentionBindingDigest(input.candidate);
  return db.transaction(async tx => {
    const [task] = await tx.select({ id: tasks.id }).from(tasks).where(
      eq(tasks.id, input.candidate.occurrence.task.id),
    ).limit(1).for("update");
    if (!task) return { status: "rejected", reason: "not_found" } as const;
    const [run] = await tx.select({ id: taskRuns.id }).from(taskRuns).where(and(
      eq(taskRuns.id, input.candidate.occurrence.run.id),
      eq(taskRuns.taskId, task.id),
    )).limit(1).for("update");
    if (!run) return { status: "rejected", reason: "not_found" } as const;
    const [job] = await tx.select(protectedApprovalJobProjection).from(jobs).where(
      eq(jobs.id, input.candidate.priorJob.id),
    ).limit(1).for("update");
    if (!job) return { status: "rejected", reason: "not_found" } as const;
    const current = await readProtectedTaskPendingAttentionCandidate(tx, {
      viewer: input.viewer,
      taskId: task.id,
      taskRunId: run.id,
    });
    if (current === null
      || protectedTaskPendingAttentionBindingDigest(current) !== expectedBinding) {
      return { status: "rejected", reason: "stale" } as const;
    }
    const segment = await readProtectedTaskExecutionSegment(tx, {
      taskRunId: run.id,
      jobId: job.id,
      executionSegment: current.priorJob.reference.executionSegment,
    });
    if (segment === null) return { status: "rejected", reason: "conflict" } as const;
    const receipt = parkReceipt({
      ...parkAadFields(current.priorJob),
      taskId: current.occurrence.task.id,
      taskRunId: current.occurrence.run.id,
      graphThreadId: current.occurrence.run.graphThreadId,
      jobId: current.priorJob.id,
      generation: current.priorJob.generation,
      executionSegment: current.priorJob.reference.executionSegment,
      interrupts: current.priorJob.interrupts,
      parkedAt: current.priorJob.parkedAt,
      jobReference: current.priorJob.reference,
    }, current.stableRoutingDigest);
    const sealed: ProtectedTaskHumanApprovalPolicyReceipt = Object.freeze({
      version: 1,
      taskId: receipt.taskId,
      taskRunId: receipt.taskRunId,
      jobId: receipt.jobId,
      generation: receipt.generation,
      executionSegment: receipt.executionSegment,
      parkReceiptDigest: approvalPolicyParkReceiptDigest(receipt),
      checkpointManifestDigest: approvalPolicyCheckpointManifestDigest(segment),
      policies,
    });
    const metadata = isRecord(job.metadata) ? job.metadata : {};
    const existing = metadata[PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY];
    if (existing !== undefined) {
      const parsed = protectedTaskHumanApprovalPolicyReceipt(
        existing, receipt, segment,
      );
      return parsed !== null && JSON.stringify(parsed) === JSON.stringify(sealed)
        ? { status: "exact_replay" } as const
        : { status: "rejected", reason: "conflict" } as const;
    }
    if (metadata[PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY] !== undefined) {
      return { status: "rejected", reason: "stale" } as const;
    }
    const [updated] = await tx.update(jobs).set({ metadata: setProtectedApprovalReceipt(
      PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY, sealed,
    ) }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.status, "completed"),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning({ id: jobs.id });
    return updated === undefined
      ? { status: "rejected", reason: "stale" } as const
      : { status: "sealed" } as const;
  });
}

async function readAcceptedParkedProtectedTaskHumanCandidate(
  db: Pick<DirectDatabase, "select">,
  taskRunId: string,
): Promise<ParkedProtectedTaskHumanContinuation | null> {
  if (!CANONICAL_UUID.test(taskRunId)) {
    throw new TypeError("Protected Task Human discovery identity is malformed");
  }
  const rows = await db.select({
    task: parkedTaskHumanContinuationTaskProjection,
    run: parkedTaskAdditionalAuthorityRunProjection,
    job: parkedTaskHumanContinuationJobProjection,
  }).from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .where(and(
      eq(taskRuns.id, taskRunId),
      eq(taskRuns.status, "awaiting"),
      eq(jobs.status, "completed"),
      sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
      sql`${jobs.metadata} ? ${PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY}`,
    )).limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!isRecord(row.job.reference)
    || !Number.isSafeInteger(row.job.reference["executionSegment"])) {
    return null;
  }
  const segment = await readProtectedTaskExecutionSegment(db, {
    taskRunId: row.run.id,
    jobId: row.job.id,
    executionSegment: row.job.reference["executionSegment"] as number,
  });
  const parsed = parseParkedProtectedTaskHumanContinuation({
    task: row.task as ParkedProtectedTaskHumanContinuationTaskRow,
    run: row.run as ParkedProtectedTaskAdditionalAuthorityRunRow,
    job: row.job as ParkedProtectedTaskHumanContinuationJobRow,
    segment,
  });
  if (parsed === null
    || !await readCurrentEnabledHumanActor(db, parsed.acceptance.acceptedBy, false)) {
    return null;
  }
  return parsed;
}

export async function readAcceptedParkedProtectedTaskHumanContinuation(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string; acceptanceId: string }>,
): Promise<ParkedProtectedTaskHumanContinuation | null> {
  if (!opaqueCheckpointCoordinate(input.acceptanceId)) {
    throw new TypeError("Protected Task Human discovery identity is malformed");
  }
  const candidate = await readAcceptedParkedProtectedTaskHumanCandidate(
    db,
    input.taskRunId,
  );
  return candidate?.acceptance.acceptanceId === input.acceptanceId
    ? candidate
    : null;
}

export async function discoverAcceptedParkedProtectedTaskHumanContinuation(
  db: Pick<DirectDatabase, "select">,
  input: Readonly<{ taskRunId: string }>,
): Promise<ParkedProtectedTaskHumanContinuation | null> {
  return readAcceptedParkedProtectedTaskHumanCandidate(db, input.taskRunId);
}

export async function lockParkedProtectedTaskHumanContinuation(
  transaction: Pick<DirectDatabase, "select">,
  supplied: ParkedProtectedTaskHumanContinuation,
): Promise<Readonly<{
  current: ParkedProtectedTaskHumanContinuation;
  task: LockedParkedProtectedTaskHumanContinuationTaskRow;
}> | null> {
  const expected = copyParkedProtectedTaskHumanContinuation(supplied);
  const taskRows = await transaction.select(
    lockedParkedTaskHumanContinuationTaskProjection,
  ).from(tasks).where(eq(tasks.id, expected.occurrence.task.id))
    .limit(2).for("update");
  const task = taskRows.length === 1
    ? taskRows[0] as LockedParkedProtectedTaskHumanContinuationTaskRow
    : undefined;
  if (task === undefined) return null;
  const runRows = await transaction.select(
    parkedTaskAdditionalAuthorityRunProjection,
  ).from(taskRuns).where(and(
    eq(taskRuns.id, expected.occurrence.run.id),
    eq(taskRuns.taskId, task.id),
  )).limit(2).for("update");
  const run = runRows.length === 1
    ? runRows[0] as ParkedProtectedTaskAdditionalAuthorityRunRow
    : undefined;
  if (run === undefined || run.jobId !== expected.priorJob.id) return null;
  const jobRows = await transaction.select(
    parkedTaskHumanContinuationJobProjection,
  ).from(jobs).where(and(
    eq(jobs.id, expected.priorJob.id),
    sql`${jobs.input} ->> 'kind' = 'protected_task_run_v1'`,
  )).limit(2).for("update");
  const job = jobRows.length === 1
    ? jobRows[0] as ParkedProtectedTaskHumanContinuationJobRow
    : undefined;
  if (job === undefined) return null;
  const segment = await readProtectedTaskExecutionSegment(transaction, {
    taskRunId: run.id,
    jobId: job.id,
    executionSegment: expected.priorJob.reference.executionSegment,
  });
  const current = parseParkedProtectedTaskHumanContinuation({
    task,
    run,
    job,
    segment,
  });
  return current !== null
      && sameParkedProtectedTaskHumanContinuation(expected, current)
      && await readCurrentEnabledHumanActor(
        transaction,
        current.acceptance.acceptedBy,
        true,
      )
    ? Object.freeze({ current, task })
    : null;
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
    acceptedAt: Date;
    message: ProtectedTaskAwaitReplyMessageReference;
    humanActorId: string;
  }>,
): ResolvedPublishedProtectedTaskAwaitReplyInput | null {
  const { task, run, job } = row;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const rawReceipt = metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY];
  if (!isRecord(rawReceipt)) return null;
  const parkedAtText = rawReceipt["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  if (
    parkKeys(rawReceipt)
      !== "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,stableRoutingDigest,taskId,taskRunId,version"
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
  const stableRoutingDigest = decodeRoutingDigest(
    rawReceipt["stableRoutingDigest"],
  );
  if (stableRoutingDigest === null) return null;

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
    ...parkAadFields(rawReceipt, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawReceipt["generation"] as number,
    executionSegment: rawReceipt["executionSegment"] as number,
    interrupts,
    parkedAt: parkedAt.toISOString(),
    stableRoutingDigest: rawReceipt["stableRoutingDigest"] as string,
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
    ...parkAadFields(receipt),
    executionSegment: receipt.executionSegment,
    interrupts,
    parkedAt,
    stableRoutingDigest,
    priorJobReference: Object.freeze({ ...reference }),
    acceptance: Object.freeze({
      acceptedBy: Object.freeze({
        userId: publication.message.sourceUserId,
        humanActorId: publication.humanActorId,
      }),
      interrupt: awaitReply[0]!,
      acceptedAt: publication.acceptedAt,
      response: Object.freeze({
        kind: "await_reply" as const,
        message: publication.message,
      }),
    }),
  });
}

function parkedProtectedTaskHumanAcceptanceCoordinates(
  row: Readonly<{ task: ProtectedApprovalTaskRow; run: ParkedProtectedTaskAdditionalAuthorityRunRow; job: ProtectedApprovalJobRow;
    segment: ProtectedTaskExecutionSegmentReceipt }>,
  selector: ResolveParkedProtectedTaskHumanContinuationAcceptanceInput[
    "interrupt"
  ],
): Readonly<{
  input: Omit<AcceptProtectedTaskHumanContinuationInput, "acceptance">;
  interrupt: ProtectedTaskRunInterruptCoordinate;
}> | null {
  const { task, run, job } = row;
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const rawReceipt = metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY];
  if (!isRecord(rawReceipt)) return null;
  const parkedAtText = rawReceipt["parkedAt"];
  const parkedAt = typeof parkedAtText === "string"
    ? new Date(parkedAtText)
    : new Date(Number.NaN);
  const stableRoutingDigest = decodeRoutingDigest(
    rawReceipt["stableRoutingDigest"],
  );
  if (parkKeys(rawReceipt)
      !== "executionSegment,generation,graphThreadId,interrupts,jobId,parkedAt,stableRoutingDigest,taskId,taskRunId,version"
    || rawReceipt["version"] !== 1
    || !Number.isSafeInteger(rawReceipt["generation"])
    || (rawReceipt["generation"] as number) < 0
    || !Number.isSafeInteger(rawReceipt["executionSegment"])
    || (rawReceipt["executionSegment"] as number) < 1
    || rawReceipt["executionSegment"] === Number.MAX_SAFE_INTEGER
    || !Number.isFinite(parkedAt.getTime())
    || parkedAt.toISOString() !== parkedAtText
    || stableRoutingDigest === null) return null;
  let interrupts: readonly ProtectedTaskRunInterruptCoordinate[];
  try {
    interrupts = canonicalInterruptCoordinates(
      rawReceipt["interrupts"] as readonly ProtectedTaskRunInterruptCoordinate[],
    );
  } catch {
    return null;
  }
  let selected = interrupts.filter(interrupt =>
    interrupt.kind === selector.kind
      && (selector.id === undefined || interrupt.id === selector.id)
      && (selector.requestId === undefined
        || interrupt.requestId === selector.requestId)
  );
  if (selected.length !== 1 || selected[0]!.kind === "additional_authority") {
    return null;
  }
  if (!isRecord(job.input)) return null;
  const reference = job.input as ProtectedTaskDurableJobReference;
  const receipt: ProtectedTaskRunParkReceipt = Object.freeze({
    version: 1,
    ...parkAadFields(rawReceipt, task.contentNamespaceId, reference.policyRevision),
    taskId: task.id,
    taskRunId: run.id,
    jobId: job.id,
    graphThreadId: run.graphThreadId,
    generation: rawReceipt["generation"] as number,
    executionSegment: rawReceipt["executionSegment"] as number,
    interrupts,
    parkedAt: parkedAt.toISOString(),
    stableRoutingDigest: rawReceipt["stableRoutingDigest"] as string,
  });
  const expectedTaskStatus = task.scheduleKind === "cron" ? "pending" : "awaiting";
  if (task.status !== expectedTaskStatus
    || task.contentRepresentation !== "dual"
      && task.contentRepresentation !== "protected"
    || task.contentNamespaceId === null
    || task.contentRevision < 1
    || task.cryptoObjectId === null
    || task.cryptoAccessRevision < 0
    || task.cryptoRequiredNamespaceFingerprint === null
    || task.cryptoRequiredNamespaceFingerprint.length !== 32
    || task.cryptoMappingState !== "verified"
    || !task.contentPristine
    || run.status !== "awaiting"
    || run.taskId !== task.id
    || run.jobId !== job.id
    || !run.pristine
    || job.status !== "completed"
    || job.completedAt?.getTime() !== parkedAt.getTime()
    || job.ownerId !== task.requestorId
    || job.requestorId !== task.requestorId
    || job.laneKey !== `task:${task.id}`
    || job.type !== "foreground"
    || !job.pristine
    || job.startedAt === null
    || metadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] !== undefined
    || metadata[PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY] !== undefined
    || !exactProtectedTaskJobReference(job.input, reference)
    || reference.taskId !== task.id
    || reference.taskRunId !== run.id
    || reference.executionSegment !== receipt.executionSegment
    || !exactParkReceipt(rawReceipt, receipt)) return null;
  if (selected[0]!.kind === "approval"
    && selected[0]!.allowedVerbs === undefined) {
    const policyReceipt = protectedTaskHumanApprovalPolicyReceipt(
      metadata[PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY],
      receipt,
      row.segment,
    );
    const policy = policyReceipt?.policies.filter(candidate =>
      candidate.interruptId === selected[0]!.id
        && candidate.requestId === selected[0]!.requestId)[0];
    if (policy !== undefined) selected = [Object.freeze({
      ...selected[0]!, allowedVerbs: Object.freeze([...policy.allowedVerbs]),
    })];
  }
  return Object.freeze({
    input: Object.freeze({
      taskId: task.id,
      taskRunId: run.id,
      graphThreadId: run.graphThreadId,
      priorJobId: job.id,
      generation: receipt.generation,
      ...parkAadFields(receipt),
      executionSegment: receipt.executionSegment,
      interrupts: copyProtectedTaskInterrupts(interrupts),
      parkedAt: new Date(parkedAt.getTime()),
      stableRoutingDigest: stableRoutingDigest.slice(),
      priorJobReference: Object.freeze({ ...reference }),
    }),
    interrupt: Object.freeze({ ...selected[0]! }),
  });
}

/** Resolve one exact, still-pending Human interrupt without exposing Job JSON
 * to the HTTP route. Ambiguous coordinates fail closed. */
export async function resolveParkedProtectedTaskHumanContinuationAcceptance(
  db: Pick<DirectDatabase, "select">,
  input: ResolveParkedProtectedTaskHumanContinuationAcceptanceInput,
): Promise<ResolveParkedProtectedTaskHumanContinuationAcceptanceResult> {
  if (!CANONICAL_UUID.test(input.taskId)
    || !input.graphThreadId
    || !CANONICAL_UUID.test(input.acceptedBy.userId)
    || !CANONICAL_UUID.test(input.acceptedBy.humanActorId)
    || !isRecord(input.interrupt)
    || !["approval", "prove_it", "identity", "await_reply"].includes(
      input.interrupt.kind,
    )
    || input.interrupt.id !== undefined
      && !opaqueCheckpointCoordinate(input.interrupt.id)
    || input.interrupt.requestId !== undefined
      && !opaqueCheckpointCoordinate(input.interrupt.requestId)) {
    return { status: "no_match" };
  }
  const [human] = await db.select({
    humanActorId: actors.id,
    userId: actors.ownerId,
    kind: actors.kind,
    disabledAt: users.disabledAt,
  }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
    eq(actors.id, input.acceptedBy.humanActorId),
    eq(actors.ownerId, input.acceptedBy.userId),
    eq(actors.kind, "user"),
    isNull(users.disabledAt),
  )).limit(1);
  if (!human
    || human.humanActorId !== input.acceptedBy.humanActorId
    || human.userId !== input.acceptedBy.userId
    || human.kind !== "user"
    || human.disabledAt !== null) return { status: "no_match" };
  const rows = await db.select({ task: parkedTaskHumanContinuationTaskProjection,
    run: parkedTaskAdditionalAuthorityRunProjection, job: protectedApprovalJobProjection })
    .from(tasks)
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .innerJoin(jobs, eq(jobs.id, taskRuns.jobId))
    .where(and(
      eq(tasks.id, input.taskId),
      eq(taskRuns.graphThreadId, input.graphThreadId),
      eq(taskRuns.status, "awaiting"),
      eq(jobs.status, "completed"),
    )).limit(3);
  let resolved: Extract<
    ResolveParkedProtectedTaskHumanContinuationAcceptanceResult,
    { status: "resolved" }
  > | null = null;
  for (const row of rows) {
    const delegation = row.task.localExecutionDelegation === null
      || row.task.localExecutionDelegation === undefined
      ? null
      : parseLocalExecutionDelegation(row.task.localExecutionDelegation);
    const recipient = row.task.localExecutionDelegation === null
      || row.task.localExecutionDelegation === undefined
      ? row.task.ownerId
      : delegation !== null
          && delegation.humanUserId === row.task.requestorId
          && delegation.agentId === row.task.agentId
        ? delegation.humanUserId
        : null;
    if (recipient !== input.acceptedBy.userId) continue;
    const reference = row.job.input;
    if (!isRecord(reference)
      || !Number.isSafeInteger(reference["executionSegment"])) continue;
    const segment = await readProtectedTaskExecutionSegment(db, {
      taskRunId: row.run.id,
      jobId: row.job.id,
      executionSegment: reference["executionSegment"] as number,
    });
    if (segment === null) continue;
    const candidate = parkedProtectedTaskHumanAcceptanceCoordinates(
      { ...row, segment },
      input.interrupt,
    );
    if (candidate === null) continue;
    if (resolved !== null) return { status: "ambiguous" };
    resolved = Object.freeze({ status: "resolved" as const, ...candidate });
  }
  return resolved ?? { status: "no_match" };
}

/**
 * Resolve one published AI-readable Human Message to the exact parked
 * protected Task interruption it may satisfy. This is discovery only: it
 * returns content-free coordinates for `acceptProtectedTaskHumanContinuation` and
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
  const humanRows = await db.select({
    humanActorId: actors.id,
    userId: actors.ownerId,
    kind: actors.kind,
    disabledAt: users.disabledAt,
  }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
    eq(actors.ownerId, publication.message.sourceUserId),
    eq(actors.kind, "user"),
    isNull(users.disabledAt),
  )).limit(2);
  if (humanRows.length !== 1
    || humanRows[0]!.userId !== publication.message.sourceUserId
    || humanRows[0]!.kind !== "user"
    || humanRows[0]!.disabledAt !== null) return { status: "no_match" };

  // The broad status query also finds parked Tasks with unrelated interrupts.
  // Page through it until two *validated* park receipts are found; counting
  // rows before receipt validation would reject an otherwise unique reply.
  const pageSize = 64;
  let afterRunId: string | null = null;
  let resolved: Extract<ResolvePublishedProtectedTaskAwaitReplyResult,
    { status: "resolved" }>["input"] | null = null;
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
        humanActorId: humanRows[0]!.humanActorId,
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
export async function acceptProtectedTaskHumanContinuation(
  db: DirectDatabase,
  input: AcceptProtectedTaskHumanContinuationInput,
): Promise<AcceptProtectedTaskHumanContinuationResult> {
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
    throw new TypeError("Protected Task Human acceptance is malformed");
  }
  const receipt = humanContinuationAcceptanceReceipt(input);
  const park = parkReceipt({
    ...parkAadFields(input),
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    jobId: input.priorJobId,
    generation: input.generation,
    executionSegment: input.executionSegment,
    interrupts: input.interrupts,
    parkedAt: input.parkedAt,
    jobReference: reference,
  }, input.stableRoutingDigest);
  const messageReference = receipt.response.kind === "await_reply"
    ? receipt.response.message
    : null;

  return db.transaction(async (tx) => {
    const [task] = await tx.select(parkedTaskHumanContinuationTaskProjection).from(tasks)
      .where(eq(tasks.id, input.taskId)).limit(1).for("update");
    if (!task) return { status: "rejected", reason: "not_found" } as const;

    const [run] = await tx.select(parkedTaskAdditionalAuthorityRunProjection).from(taskRuns).where(and(
      eq(taskRuns.id, input.taskRunId),
      eq(taskRuns.taskId, task.id),
    )).limit(1).for("update");
    if (!run) return { status: "rejected", reason: "not_found" } as const;

    const [priorJob] = await tx.select(protectedApprovalJobProjection).from(jobs)
      .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
    if (!priorJob) {
      return { status: "rejected", reason: "not_found" } as const;
    }

    const metadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    const existing = metadata[PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY];
    const delegation = task.localExecutionDelegation === null
      || task.localExecutionDelegation === undefined
      ? null
      : parseLocalExecutionDelegation(task.localExecutionDelegation);
    const recipientUserId = task.localExecutionDelegation === null
      || task.localExecutionDelegation === undefined
      ? task.ownerId
      : delegation !== null
          && delegation.humanUserId === task.requestorId
          && delegation.agentId === task.agentId
        ? delegation.humanUserId
        : null;
    const exactHumanResponseBinding = messageReference === null
      ? receipt.acceptedBy.userId === recipientUserId
      : receipt.acceptedBy.userId === messageReference.sourceUserId
        && task.targetRoomId === messageReference.roomId
        && (task.requestorId === messageReference.sourceUserId
          || task.targetUserIds.includes(messageReference.sourceUserId));
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
      && task.contentPristine
      && recipientUserId !== null
      && exactHumanResponseBinding;
    const expectedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    const exactRun = run.graphThreadId === input.graphThreadId
      && run.status === "awaiting"
      && run.jobId === priorJob.id
      && run.pristine;
    const exactPriorJob = priorJob.ownerId === task.requestorId
      && priorJob.requestorId === task.requestorId
      && priorJob.laneKey === `task:${task.id}`
      && priorJob.type === "foreground"
      && priorJob.status === "completed"
      && priorJob.pristine
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
    if (receipt.response.kind === "approval") {
      const selectedInterrupt = park.interrupts.find(interrupt =>
        interrupt.id === receipt.interrupt.id
          && interrupt.kind === "approval"
          && interrupt.requestId === receipt.interrupt.requestId);
      const rawPolicy = metadata[PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY];
      const segment = selectedInterrupt?.allowedVerbs === undefined
          && rawPolicy !== undefined
        ? await readProtectedTaskExecutionSegment(tx, {
            taskRunId: run.id,
            jobId: priorJob.id,
            executionSegment: input.executionSegment,
          })
        : null;
      if (rawPolicy !== undefined && selectedInterrupt?.allowedVerbs === undefined
        && segment === null) {
        return { status: "rejected", reason: "conflict" } as const;
      }
      const policyReceipt = selectedInterrupt?.allowedVerbs === undefined
          && rawPolicy !== undefined && segment !== null
        ? protectedTaskHumanApprovalPolicyReceipt(rawPolicy, park, segment)
        : null;
      const allowedVerbs = selectedInterrupt?.allowedVerbs
        ?? policyReceipt?.policies.find(policy =>
          policy.interruptId === selectedInterrupt?.id
            && policy.requestId === selectedInterrupt.requestId)?.allowedVerbs
        ?? ["deny"];
      if (!allowedVerbs.includes(receipt.response.verb)
        || receipt.response.verb === "room" && task.targetRoomId === null) {
        return { status: "rejected", reason: "stale" } as const;
      }
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
      const storedAcceptedAt = isRecord(existing)
        && typeof existing["acceptedAt"] === "string"
        ? new Date(existing["acceptedAt"])
        : new Date(Number.NaN);
      const durableAcceptance = Object.freeze({
        ...input.acceptance,
        acceptedBy: Object.freeze({ ...input.acceptance.acceptedBy }),
        interrupt: Object.freeze({ ...input.acceptance.interrupt }),
        response: input.acceptance.response.kind === "await_reply"
          ? Object.freeze({
              kind: "await_reply" as const,
              message: Object.freeze({
                ...input.acceptance.response.message,
              }),
            })
          : Object.freeze({ ...input.acceptance.response }),
        acceptedAt: storedAcceptedAt,
      });
      const durableReceipt = Number.isFinite(storedAcceptedAt.getTime())
        ? humanContinuationAcceptanceReceipt({
            ...input,
            acceptance: durableAcceptance,
          })
        : null;
      return durableReceipt !== null
          && exactHumanContinuationAcceptanceReceipt(existing, durableReceipt)
        ? { status: "exact_replay", acceptance: durableAcceptance } as const
        : { status: "rejected", reason: "conflict" } as const;
    }

    const [human] = await tx.select({
      humanActorId: actors.id,
      userId: actors.ownerId,
      kind: actors.kind,
      disabledAt: users.disabledAt,
    }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
      eq(actors.id, receipt.acceptedBy.humanActorId),
      eq(actors.ownerId, receipt.acceptedBy.userId),
      eq(actors.kind, "user"),
      isNull(users.disabledAt),
    )).limit(1).for("share");
    if (!human
      || human.humanActorId !== receipt.acceptedBy.humanActorId
      || human.userId !== receipt.acceptedBy.userId
      || human.kind !== "user"
      || human.disabledAt !== null) {
      return { status: "rejected", reason: "stale" } as const;
    }

    let message: {
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
      lifecycleKeyClass: string;
      lifecycleAuthorRole: string;
      lifecyclePayloadVersion: number;
      lifecycleCompletion: string;
      lifecycleDisposition: string;
    } | undefined;
    if (messageReference !== null) [message] = await tx.select({
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
        eq(sessionMessages.id, Number(messageReference.messageId)),
        eq(sessionMessages.sessionId, messageReference.sessionId),
      )).limit(1).for("share");
    if (messageReference !== null && !message) {
      return { status: "rejected", reason: "not_found" } as const;
    }
    if (messageReference !== null && message !== undefined && (
      message.roomId !== messageReference.roomId
      || message.sessionId !== messageReference.sessionId
      || String(message.messageId) !== messageReference.messageId
      || message.editRevision !== messageReference.editRevision
      || message.cryptoObjectId !== messageReference.cryptoObjectId
      || message.namespaceId !== messageReference.namespaceId
      || message.sourceUserId !== messageReference.sourceUserId
      || message.role !== "user"
      || message.createdAt.getTime() < input.parkedAt.getTime()
      || input.acceptance.acceptedAt.getTime() < message.createdAt.getTime()
      || message.lifecycleNamespaceId !== messageReference.namespaceId
      || message.lifecycleRoomId !== messageReference.roomId
      || message.lifecycleCryptoObjectId !== messageReference.cryptoObjectId
      || message.lifecycleKeyClass !== "ai"
      || message.lifecycleAuthorRole !== "user"
      || message.lifecyclePayloadVersion !== 2
      || message.lifecycleCompletion !== "complete"
      || message.lifecycleDisposition !== "mapped"
    )) {
      return { status: "rejected", reason: "stale" } as const;
    }

    const [updatedJob] = await tx.update(jobs).set({
      metadata: setProtectedApprovalReceipt(
        PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY, receipt,
      ),
    }).where(and(
      eq(jobs.id, priorJob.id),
      eq(jobs.status, "completed"),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning({ id: jobs.id });
    if (!updatedJob) {
      throw new Error("Protected Task Human acceptance lost its Job");
    }
    return {
      status: "accepted",
      acceptance: Object.freeze({
        ...input.acceptance,
        acceptedBy: Object.freeze({ ...input.acceptance.acceptedBy }),
        interrupt: Object.freeze({ ...input.acceptance.interrupt }),
        response: input.acceptance.response.kind === "await_reply"
          ? Object.freeze({
              kind: "await_reply" as const,
              message: Object.freeze({
                ...input.acceptance.response.message,
              }),
            })
          : Object.freeze({ ...input.acceptance.response }),
        acceptedAt: new Date(input.acceptance.acceptedAt.getTime()),
      }),
    } as const;
  });
}

type StartParkedProtectedTaskSegmentTx = Pick<
  DirectDatabase,
  "select" | "update"
>;

type LockedParkedProtectedTaskSegmentRows = Readonly<{
  task: ProtectedApprovalTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  priorJob: ProtectedApprovalJobRow;
  nextJob: ProtectedApprovalJobRow;
}>;

async function lockParkedProtectedTaskSegmentRows(
  tx: Pick<DirectDatabase, "select">,
  input: Readonly<{
    taskId: string;
    taskRunId: string;
    priorJobId: string;
    jobId: string;
  }>,
): Promise<LockedParkedProtectedTaskSegmentRows | null> {
  const [task] = await tx.select(parkedTaskHumanContinuationTaskProjection).from(tasks)
    .where(eq(tasks.id, input.taskId)).limit(1).for("update");
  if (!task) return null;
  const [run] = await tx.select(parkedTaskAdditionalAuthorityRunProjection).from(taskRuns).where(and(
    eq(taskRuns.id, input.taskRunId),
    eq(taskRuns.taskId, task.id),
  )).limit(1).for("update");
  if (!run) return null;
  const [priorJob] = await tx.select(protectedApprovalJobProjection).from(jobs)
    .where(eq(jobs.id, input.priorJobId)).limit(1).for("update");
  if (!priorJob) return null;
  const [nextJob] = await tx.select(protectedApprovalJobProjection).from(jobs)
    .where(eq(jobs.id, input.jobId)).limit(1).for("update");
  return nextJob ? { task, run, priorJob, nextJob } : null;
}

async function advanceParkedProtectedTaskSegment(
  tx: StartParkedProtectedTaskSegmentTx,
  rows: LockedParkedProtectedTaskSegmentRows,
  input: Readonly<{
    graphThreadId: string;
    freshAuthorized: boolean;
    replayAuthorized: boolean;
    beforeStart?: () => Promise<void>;
  }>,
): Promise<StartParkedProtectedTaskHumanRunSegmentResult> {
  const { task, run, priorJob, nextJob } = rows;
  if (task.pauseRequestId != null) return { status: "rejected", reason: "stale" };
  const nextJobIsPristineQueued = nextJob.status === "queued"
    && nextJob.startedAt === null;
  const nextJobIsLiveRunning = nextJob.status === "running"
    && nextJob.startedAt !== null;
  const expectedParkedTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : "awaiting";
  const expectedRunningTaskStatus = task.scheduleKind === "cron"
    ? "pending"
    : "running";
  if (task.status === expectedRunningTaskStatus
    && run.status === "running"
    && run.jobId === nextJob.id
    && (nextJobIsPristineQueued || nextJobIsLiveRunning)
    && input.replayAuthorized) {
    return { status: "exact_replay" };
  }
  if (task.status !== expectedParkedTaskStatus
    || run.status !== "awaiting"
    || run.jobId !== priorJob.id
    || !nextJobIsPristineQueued
    || !input.freshAuthorized) {
    return { status: "rejected", reason: "stale" };
  }

  await input.beforeStart?.();
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
  )).returning({ id: taskRuns.id });
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
    )).returning({ id: tasks.id });
    if (!updatedTask) {
      throw new Error("Protected Task parked segment CAS lost its Task");
    }
  }
  return { status: "started" };
}

/**
 * Advance one durably parked protected TaskRun to a fresh execution segment.
 * The old Job and its exact park receipt remain the immutable hand-off proof;
 * the replacement Job was persisted separately and stays queued for its
 * in-memory executor. This operation does not create a grant or make an
 * awaiting run eligible on its own.
 */
export async function startParkedProtectedTaskHumanRunSegment(
  db: DirectDatabase,
  input: StartParkedProtectedTaskHumanRunSegmentInput,
): Promise<StartParkedProtectedTaskHumanRunSegmentResult> {
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
    || !Number.isSafeInteger(nextReference.policyRevision)
    || nextReference.policyRevision < priorReference.policyRevision
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
    ...parkAadFields(input),
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    graphThreadId: input.graphThreadId,
    jobId: input.priorJobId,
    generation: input.generation,
    executionSegment: priorReference.executionSegment,
    interrupts: input.interrupts,
    parkedAt: input.parkedAt,
    jobReference: priorReference,
  }, input.stableRoutingDigest);
  const acceptanceReceipt = humanContinuationAcceptanceReceipt({
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
  const prepared = prepareParkedProtectedTaskHumanStart(input);

  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server")).limit(1).for("share");
    if (!policy || policy.revision !== nextReference.policyRevision
      || !protectedTaskDefinitionSupportsPolicy(input.contentRepresentation, policy.mode)) {
      return { status: "rejected", reason: "stale" } as const;
    }
    const rows = await lockParkedProtectedTaskSegmentRows(tx, input);
    if (rows === null) {
      return { status: "rejected", reason: "not_found" } as const;
    }
    const { task, run, priorJob, nextJob } = rows;
    if (!await parkedOutputBindingAllowsPolicy(tx, run.id, priorReference, nextReference.policyRevision)) {
      return { status: "rejected", reason: "conflict" } as const;
    }

    const priorMetadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    const segment = await readProtectedTaskExecutionSegment(tx, {
      taskRunId: input.taskRunId,
      jobId: input.priorJobId,
      executionSegment: priorReference.executionSegment,
    });
    const expectedParkedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    const freshLifecycleCandidate = task.status === expectedParkedTaskStatus
      && run.status === "awaiting"
      && run.jobId === priorJob.id
      && nextJob.status === "queued"
      && nextJob.startedAt === null;
    const transcript = freshLifecycleCandidate
      ? await readProtectedTaskTranscriptManifestInTx(tx, {
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          graphThreadId: input.graphThreadId,
        })
      : null;
    if (!exactParkedProtectedTaskHumanProof(
      segment,
      priorMetadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
      prepared,
      freshLifecycleCandidate,
    ) || freshLifecycleCandidate && (
      transcript === null
      || segment === null
      || !exactAdditionalAuthorityTranscriptManifest(segment, transcript)
    )) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (acceptanceReceipt.response.kind === "approval") {
      if (segment === null) {
        return { status: "rejected", reason: "conflict" } as const;
      }
      const selectedInterrupt = receipt.interrupts.find(interrupt =>
        interrupt.id === acceptanceReceipt.interrupt.id
          && interrupt.kind === "approval"
          && interrupt.requestId === acceptanceReceipt.interrupt.requestId);
      const policyReceipt = selectedInterrupt?.allowedVerbs === undefined
        ? protectedTaskHumanApprovalPolicyReceipt(
            priorMetadata[PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY],
            receipt,
            segment,
          )
        : null;
      const allowedVerbs = selectedInterrupt?.allowedVerbs
        ?? policyReceipt?.policies.find(policy =>
          policy.interruptId === selectedInterrupt?.id
            && policy.requestId === selectedInterrupt.requestId)?.allowedVerbs
        ?? ["deny"];
      if (!allowedVerbs.includes(acceptanceReceipt.response.verb)
        || acceptanceReceipt.response.verb === "room"
          && task.targetRoomId === null) {
        return { status: "rejected", reason: "stale" } as const;
      }
    }
    const delegation = task.localExecutionDelegation === null
      || task.localExecutionDelegation === undefined
      ? null
      : parseLocalExecutionDelegation(task.localExecutionDelegation);
    const recipientUserId = task.localExecutionDelegation === null
      || task.localExecutionDelegation === undefined
      ? task.ownerId
      : delegation !== null
          && delegation.humanUserId === task.requestorId
          && delegation.agentId === task.agentId
        ? delegation.humanUserId
        : null;
    const messageReference = acceptanceReceipt.response.kind === "await_reply"
      ? acceptanceReceipt.response.message
      : null;
    const exactHumanResponseBinding = messageReference === null
      ? acceptanceReceipt.acceptedBy.userId === recipientUserId
      : acceptanceReceipt.acceptedBy.userId === messageReference.sourceUserId
        && task.targetRoomId === messageReference.roomId
        && (task.requestorId === messageReference.sourceUserId
          || task.targetUserIds.includes(messageReference.sourceUserId));
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
      && task.contentPristine
      && recipientUserId !== null
      && exactHumanResponseBinding
    );
    const exactRun = run.graphThreadId === input.graphThreadId
      && run.pristine;
    const exactPriorJob = priorJob.ownerId === task.requestorId
      && priorJob.requestorId === task.requestorId
      && priorJob.laneKey === `task:${task.id}`
      && priorJob.type === "foreground"
      && priorJob.status === "completed"
      && priorJob.pristine
      && priorJob.startedAt !== null
      && priorJob.completedAt?.getTime() === input.parkedAt.getTime()
      && priorMetadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY] === undefined
      && exactProtectedTaskJobReference(priorJob.input, priorReference);
    const exactPriorReceipt = exactParkReceipt(
      priorMetadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
      receipt,
    );
    const existingAcceptance =
      priorMetadata[PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY];
    const exactUnconsumedAcceptance = exactHumanContinuationAcceptanceReceipt(
      existingAcceptance,
      acceptanceReceipt,
    );
    const exactConsumedAcceptance = exactHumanContinuationAcceptanceReceipt(
      existingAcceptance,
      acceptanceReceipt,
      nextJob.id,
    );
    const exactNextJobIdentity = nextJob.ownerId === task.requestorId
      && nextJob.requestorId === task.requestorId
      && nextJob.laneKey === `task:${task.id}`
      && nextJob.type === "foreground"
      && nextJob.pristine
      && nextJob.completedAt === null
      && nextJob.metadataEmpty
      && exactProtectedTaskJobReference(nextJob.input, nextReference);
    const [human] = await tx.select({
      humanActorId: actors.id,
      userId: actors.ownerId,
      kind: actors.kind,
      disabledAt: users.disabledAt,
    }).from(actors).innerJoin(users, eq(users.id, actors.ownerId)).where(and(
      eq(actors.id, acceptanceReceipt.acceptedBy.humanActorId),
      eq(actors.ownerId, acceptanceReceipt.acceptedBy.userId),
      eq(actors.kind, "user"),
      isNull(users.disabledAt),
    )).limit(1).for("share");
    const exactCurrentMessage = messageReference === null
      || await hasExactCurrentProtectedTaskReplyMessage(tx, messageReference);
    if (!exactPriorReceipt) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (!exactUnconsumedAcceptance && !exactConsumedAcceptance) {
      return { status: "rejected", reason: "conflict" } as const;
    }
    if (!exactProtectedTask
      || !exactRun
      || !exactPriorJob
      || !exactNextJobIdentity
      || !human
      || human.humanActorId !== acceptanceReceipt.acceptedBy.humanActorId
      || human.userId !== acceptanceReceipt.acceptedBy.userId
      || human.kind !== "user"
      || human.disabledAt !== null
      || !exactCurrentMessage) {
      return { status: "rejected", reason: "stale" } as const;
    }

    return advanceParkedProtectedTaskSegment(tx, rows, {
      graphThreadId: input.graphThreadId,
      freshAuthorized: exactUnconsumedAcceptance,
      replayAuthorized: exactConsumedAcceptance,
      beforeStart: async () => {
        const [updatedPriorJob] = await tx.update(jobs).set({
          metadata: setProtectedApprovalReceipt(
            PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY, {
              ...acceptanceReceipt, consumedByJobId: nextJob.id,
            },
          ),
        }).where(and(
          eq(jobs.id, priorJob.id),
          eq(jobs.status, "completed"),
          isNull(jobs.result),
          isNull(jobs.message),
        )).returning({ id: jobs.id });
        if (!updatedPriorJob) {
          throw new Error("Protected Task parked segment CAS lost its acceptance");
        }
      },
    });
  });
}

function exactAdditionalAuthorityTranscriptManifest(
  receipt: ProtectedTaskExecutionContinuationProof["segment"],
  manifest: Awaited<ReturnType<typeof readProtectedTaskTranscriptManifestInTx>>,
): boolean {
  return receipt.transcriptContract === manifest.contract
    && receipt.expectedTranscriptAssociationCount
      === manifest.expectedAssociationCount
    && sameBytes(receipt.transcriptAssociationDigest, manifest.orderedDigest);
}

/**
 * Advance a parked native pre-effect authority interruption to one fresh Job.
 * The immutable receipts and the freshly supplied physical checkpoint manifest
 * are identity evidence for this product CAS; the native runtime must obtain
 * and validate that manifest from its held saver before invoking this owner.
 */
export async function startParkedProtectedTaskRunAdditionalAuthoritySegment(
  db: DirectDatabase,
  input: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
): Promise<StartParkedProtectedTaskRunAdditionalAuthoritySegmentResult> {
  const prepared = prepareParkedProtectedTaskAdditionalAuthorityStart(input);
  const {
    taskId,
    taskRunId,
    graphThreadId,
    priorJobId,
    jobId,
    contentRepresentation,
    contentNamespaceId,
    contentRevision,
    cryptoObjectId,
    cryptoAccessRevision,
  } = prepared;
  const priorReference = prepared.priorJobReference;
  const nextReference = prepared.jobReference;
  const parkedAt = prepared.parkedAt;
  const cryptoRequiredNamespaceFingerprint =
    prepared.cryptoRequiredNamespaceFingerprint;

  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server")).limit(1).for("share");
    if (!policy || policy.revision !== nextReference.policyRevision
      || nextReference.policyRevision < priorReference.policyRevision
      || !protectedTaskDefinitionSupportsPolicy(contentRepresentation, policy.mode)) {
      return { status: "rejected", reason: "stale" } as const;
    }
    const rows = await lockParkedProtectedTaskSegmentRows(tx, {
      taskId,
      taskRunId,
      priorJobId,
      jobId,
    });
    if (rows === null) {
      return { status: "rejected", reason: "not_found" } as const;
    }
    const { task, run, priorJob, nextJob } = rows;
    if (!await parkedOutputBindingAllowsPolicy(tx, run.id, priorReference, nextReference.policyRevision)) {
      return { status: "rejected", reason: "conflict" } as const;
    }

    const proof = await readProtectedTaskExecutionContinuationProof(tx, {
      taskId: taskId,
      taskRunId: taskRunId,
      jobId: priorJobId,
      executionSegment: priorReference.executionSegment,
    });
    const expectedParkedTaskStatus = task.scheduleKind === "cron"
      ? "pending"
      : "awaiting";
    const freshLifecycleCandidate = task.status === expectedParkedTaskStatus
      && run.status === "awaiting"
      && run.jobId === priorJob.id
      && nextJob.status === "queued"
      && nextJob.startedAt === null;
    const transcript = freshLifecycleCandidate
      ? await readProtectedTaskTranscriptManifestInTx(tx, {
        taskId,
        taskRunId,
        graphThreadId,
      })
      : null;
    const priorMetadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    if (!exactParkedProtectedTaskAdditionalAuthorityProof(
      proof,
      priorMetadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
      prepared,
      freshLifecycleCandidate,
    ) || freshLifecycleCandidate && (
      transcript === null
      || !exactAdditionalAuthorityTranscriptManifest(proof!.segment, transcript)
    )) {
      return { status: "rejected", reason: "conflict" } as const;
    }

    const exactProtectedTask = (
      task.contentRepresentation === contentRepresentation
      && task.contentNamespaceId === contentNamespaceId
      && task.contentRevision === contentRevision
      && task.cryptoObjectId === cryptoObjectId
      && task.cryptoAccessRevision === cryptoAccessRevision
      && task.cryptoRequiredNamespaceFingerprint !== null
      && sameBytes(
        task.cryptoRequiredNamespaceFingerprint,
        cryptoRequiredNamespaceFingerprint,
      )
      && task.cryptoMappingState === "verified"
      && task.contentPristine
    );
    const exactRun = run.graphThreadId === graphThreadId
      && run.pristine;
    const exactPriorJob = priorJob.ownerId === task.requestorId
      && priorJob.requestorId === task.requestorId
      && priorJob.laneKey === `task:${task.id}`
      && priorJob.type === "foreground"
      && priorJob.status === "completed"
      && priorJob.pristine
      && priorJob.startedAt !== null
      && priorJob.completedAt?.getTime() === parkedAt.getTime()
      && priorMetadata[PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY]
        === undefined
      && exactProtectedTaskJobReference(priorJob.input, priorReference);
    const exactNextJobIdentity = nextJob.ownerId === task.requestorId
      && nextJob.requestorId === task.requestorId
      && nextJob.laneKey === `task:${task.id}`
      && nextJob.type === "foreground"
      && nextJob.pristine
      && nextJob.completedAt === null
      && nextJob.metadataEmpty
      && exactProtectedTaskJobReference(nextJob.input, nextReference);
    if (!exactProtectedTask || !exactRun || !exactPriorJob || !exactNextJobIdentity) {
      return { status: "rejected", reason: "stale" } as const;
    }
    return advanceParkedProtectedTaskSegment(tx, rows, {
      graphThreadId,
      freshAuthorized: true,
      replayAuthorized: true,
    });
  });
}

async function parkedOutputBindingAllowsPolicy(
  tx: Pick<DirectDatabase, "select">,
  taskRunId: string,
  prior: ProtectedTaskDurableJobReference,
  currentPolicyRevision: number,
): Promise<boolean> {
  const [binding] = await tx.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, taskRunId)).limit(1).for("share");
  return binding !== undefined && binding.bindingId === `task-run-output:${taskRunId}`
    && binding.resultRevision === 1 && binding.resultObjectId === prior.resultObjectId
    && binding.resultOperationId === `task-run-result:${taskRunId}`
    && currentPolicyRevision >= binding.acceptedPolicyRevision
    && binding.resultTerminalAt === null && binding.resultAttachedAt === null
    && binding.messageId === null && binding.messagePublishedAt === null
    && binding.wakeJobId === null && binding.wakeScheduledAt === null && binding.completedAt === null;
}

/** Start only from an immutable safe checkpoint under fresh current policy. */
export async function startParkedProtectedTaskCheckpointSegment(
  db: DirectDatabase,
  supplied: StartParkedProtectedTaskCheckpointSegmentInput,
): Promise<StartParkedProtectedTaskCheckpointSegmentResult> {
  const input = structuredClone(supplied);
  const prior = input.priorJobReference;
  const next = input.jobReference;
  const checkpoint = input.checkpointManifest;
  if (!Array.isArray(input.interrupts) || input.interrupts.length !== 0
    || input.priorJobId === input.jobId || !CANONICAL_UUID.test(input.jobId)
    || !(input.stableRoutingDigest instanceof Uint8Array) || input.stableRoutingDigest.length !== 32
    || !(input.cryptoRequiredNamespaceFingerprint instanceof Uint8Array)
    || input.cryptoRequiredNamespaceFingerprint.length !== 32
    || !canonicalContinuationFingerprint(input.continuationFingerprint)
    || prior.kind !== "protected_task_run_v1" || next.kind !== "protected_task_run_v1"
    || !exactProtectedTaskJobReference(prior, prior)
    || !exactProtectedTaskJobReference(next, next)
    || prior.taskId !== input.taskId || prior.taskRunId !== input.taskRunId
    || prior.inputObjectId !== input.cryptoObjectId
    || prior.executionSegment >= Number.MAX_SAFE_INTEGER
    || next.taskId !== prior.taskId || next.taskRunId !== prior.taskRunId
    || next.inputObjectId !== prior.inputObjectId || next.resultObjectId !== prior.resultObjectId
    || next.executionSegment !== prior.executionSegment + 1
    || !Number.isSafeInteger(next.policyRevision) || next.policyRevision < prior.policyRevision
    || next.resumeContinuationFingerprint !== input.continuationFingerprint
    || next.authorizationRequestId !== `task-checkpoint-continuation:${input.taskRunId}:${next.executionSegment}:${input.continuationFingerprint}`
    || checkpoint.contract !== "encrypted_langgraph_v1"
    || !Number.isSafeInteger(checkpoint.expectedCheckpointCount) || checkpoint.expectedCheckpointCount < 1
    || !Number.isSafeInteger(checkpoint.expectedBlobCount) || checkpoint.expectedBlobCount < 0
    || !Number.isSafeInteger(checkpoint.expectedPendingWriteCount) || checkpoint.expectedPendingWriteCount < 0
    || ![checkpoint.checkpointOrderedDigest, checkpoint.blobOrderedDigest,
      checkpoint.pendingWriteOrderedDigest].every(bytes => bytes instanceof Uint8Array && bytes.length === 32)) {
    throw new TypeError("Protected Task checkpoint segment binding is malformed");
  }
  const receipt = prepareProtectedTaskParkReceipt({ ...input, jobId: input.priorJobId,
    executionSegment: prior.executionSegment, jobReference: prior }, input.stableRoutingDigest, true);
  return db.transaction(async tx => {
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server")).limit(1).for("share");
    if (!policy || policy.revision !== next.policyRevision
      || !protectedTaskDefinitionSupportsPolicy(input.contentRepresentation, policy.mode)) {
      return { status: "rejected", reason: "stale" };
    }
    const rows = await lockParkedProtectedTaskSegmentRows(tx, input);
    if (rows === null) return { status: "rejected", reason: "not_found" };
    const { task, run, priorJob, nextJob } = rows;
    if (task.pauseRequestId != null) return { status: "rejected", reason: "stale" };
    const proof = await readProtectedTaskExecutionContinuationProof(tx, {
      taskId: task.id, taskRunId: run.id, jobId: priorJob.id, executionSegment: prior.executionSegment,
    });
    const metadata = isRecord(priorJob.metadata) ? priorJob.metadata : {};
    // Normalize only for parsing retained prior proof on an exact started replay;
    // the actual lifecycle remains separately checked by the shared CAS below.
    const current = parseParkedProtectedTaskCheckpointContinuation({
      task: { ...task, status: task.scheduleKind === "cron" ? "pending" : "awaiting",
        contentPristine: task.contentPristine },
      run: { ...run, status: "awaiting", jobId: priorJob.id, pristine: run.pristine },
      job: { ...priorJob, reference: priorJob.input,
        parkReceipt: metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY],
        pristine: priorJob.pristine },
      proof,
    });
    if (!current || current.continuationFingerprint !== input.continuationFingerprint
      || current.authorizationRequestId !== next.authorizationRequestId
      || !exactParkReceipt(metadata[PROTECTED_TASK_RUN_PARK_RECEIPT_METADATA_KEY], receipt)
      || !exactProtectedTaskJobReference(priorJob.input, prior)
      || run.graphThreadId !== input.graphThreadId
      || task.contentRepresentation !== input.contentRepresentation
      || task.contentNamespaceId !== input.contentNamespaceId
      || task.contentRevision !== input.contentRevision || task.cryptoObjectId !== input.cryptoObjectId
      || task.cryptoAccessRevision !== input.cryptoAccessRevision
      || !sameBytes(task.cryptoRequiredNamespaceFingerprint, input.cryptoRequiredNamespaceFingerprint)) {
      return { status: "rejected", reason: "conflict" };
    }
    if (!await parkedOutputBindingAllowsPolicy(tx, run.id, prior, next.policyRevision)) {
      return { status: "rejected", reason: "conflict" };
    }
    if (nextJob.ownerId !== task.requestorId || nextJob.requestorId !== task.requestorId
      || nextJob.laneKey !== `task:${task.id}` || nextJob.type !== "foreground"
      || !nextJob.pristine || nextJob.completedAt !== null
      || !nextJob.metadataEmpty || !exactProtectedTaskJobReference(nextJob.input, next)) {
      return { status: "rejected", reason: "stale" };
    }
    const segment = current.proof.segment;
    const fresh = run.status === "awaiting" && run.jobId === priorJob.id;
    if (fresh) {
      const transcript = await readProtectedTaskTranscriptManifestInTx(tx, {
        taskId: task.id, taskRunId: run.id, graphThreadId: run.graphThreadId,
      });
      if (!exactAdditionalAuthorityTranscriptManifest(segment, transcript)
        || segment.checkpointContract !== checkpoint.contract
        || segment.expectedCheckpointCount !== checkpoint.expectedCheckpointCount
        || !sameBytes(segment.checkpointDigest, checkpoint.checkpointOrderedDigest)
        || segment.expectedCheckpointBlobCount !== checkpoint.expectedBlobCount
        || !sameBytes(segment.checkpointBlobDigest, checkpoint.blobOrderedDigest)
        || segment.expectedPendingWriteCount !== checkpoint.expectedPendingWriteCount
        || !sameBytes(segment.pendingWriteDigest, checkpoint.pendingWriteOrderedDigest)) {
        return { status: "rejected", reason: "conflict" };
      }
    }
    return advanceParkedProtectedTaskSegment(tx, rows, {
      graphThreadId: input.graphThreadId, freshAuthorized: true, replayAuthorized: true,
    });
  });
}

const TASK_RUN_RESULT_OBJECT_ID = /^task-run-result:v1:[0-9a-f]{64}$/u;
// Lexical correlation only; current publication/execution validates the exact mapped definition ledger.
const TASK_DEFINITION_OBJECT_ID = /^(?:task-definition|task-historical):v1:[0-9a-f]{64}$/u;
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
  return protectedTaskDefinitionSupportsPolicy(task.contentRepresentation,
      representation === "protected" ? "encrypted_only" : "shadow_encryption")
    && task.contentNamespaceId !== null
    && task.contentRevision > 0
    && task.cryptoObjectId !== null
    && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint !== null
    && task.cryptoRequiredNamespaceFingerprint.length === 32
    && task.cryptoMappingState === "verified"
    && task.lastError === null
    && (task.contentRepresentation !== "protected" || (
      task.prompt === "" && task.expectedOutput === null
    ))
    && revision !== undefined
    && revision.taskId === task.id
    && revision.contentNamespaceId === task.contentNamespaceId
    && revision.contentRevision === task.contentRevision
    && revision.cryptoObjectId === task.cryptoObjectId
    && revision.representation === task.contentRepresentation
    && revision.payloadVersion === 1
    // Definition ledger retains genesis; only the authenticated mapped Task head advances.
    && revision.cryptoAccessRevision === 0
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
  const resumeContinuationFingerprint = isRecord(job?.input)
    ? job.input["resumeContinuationFingerprint"]
    : undefined;
  const expectedKeys = executionSegment === 1
    ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    : resumeAcceptanceId !== undefined
      ? "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeAcceptanceId,taskId,taskRunId"
      : "authorizationRequestId,executionSegment,inputObjectId,kind,policyRevision,resultObjectId,resumeContinuationFingerprint,taskId,taskRunId";
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
        || resumeContinuationFingerprint !== undefined
      : !(
        opaqueCheckpointCoordinate(resumeAcceptanceId)
          && resumeContinuationFingerprint === undefined
        || resumeAcceptanceId === undefined
          && canonicalContinuationFingerprint(resumeContinuationFingerprint)
      ))
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
    && binding.acceptedPolicyRevision <= policyRevision;
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

export type SettlePublishedProtectedTaskRunAuthorizationInput = Readonly<{
  jobId: string;
  reference: ProtectedTaskDurableJobReference;
}>;

export type PublishedProtectedTaskRunAuthorizationProof = Readonly<{
  contentNamespaceId: string;
  requesterHumanId: string;
}>;

export type ProtectedTaskRunResultPublicationPhase = "mapped" | "unmapped";
export type ProtectedTaskRunResultPublicationTransaction =
  Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export type ExactProtectedTaskRunResultPublicationProof = Readonly<{
  phase: ProtectedTaskRunResultPublicationPhase;
  reference: ProtectedTaskDurableJobReference;
  task: Readonly<{ id: string; requestorId: string }>;
  run: Readonly<{
    id: string;
    outcome: ProtectedTaskRunTerminalOutcome;
    completedAt: Date;
  }>;
  job: Readonly<{
    id: string;
    status: "running" | "failed" | "completed";
    startedAt: Date;
    completedAt: Date | null;
  }>;
  binding: Readonly<{
    bindingId: string;
    deliveryMode: "none" | "wake" | "raw" | "raw_and_wake";
    resultAttachedAt: Date | null;
    completedAt: Date | null;
  }>;
  lifecycle: Readonly<{
    sequence: number;
    operationId: string;
    authorityFingerprint: Uint8Array;
    requesterHumanId: string;
    contentNamespaceId: string;
    cryptoObjectId: string;
    representation: "protected" | "dual";
    requiredNamespaceFingerprint: Uint8Array;
    attemptCount: number;
    leaseToken: string | null;
    cryptoCompletedAt: Date | null;
  }>;
}>;

function finiteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertPublishedProtectedTaskRunSettlementInput(
  input: SettlePublishedProtectedTaskRunAuthorizationInput,
): void {
  const reference = input.reference;
  if (
    !CANONICAL_UUID.test(input.jobId)
    || !isRecord(reference)
    || reference.kind !== "protected_task_run_v1"
    || !CANONICAL_UUID.test(reference.taskId)
    || !CANONICAL_UUID.test(reference.taskRunId)
    || !TASK_DEFINITION_OBJECT_ID.test(reference.inputObjectId)
    || !TASK_RUN_RESULT_OBJECT_ID.test(reference.resultObjectId)
    || reference.authorizationRequestId.length === 0
    || !Number.isSafeInteger(reference.policyRevision)
    || reference.policyRevision < 1
    || !Number.isSafeInteger(reference.executionSegment)
    || reference.executionSegment < 1
    || !exactProtectedTaskJobReference(reference, reference)
  ) {
    throw new TypeError("Published protected Task settlement is invalid");
  }
}

function copyOptionalDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

/**
 * Lock and prove one exact terminal run-result publication without mutating it.
 * Callers own the transaction and any policy fence acquired before this helper.
 */
export async function lockExactProtectedTaskRunResultPublicationInTx(
  tx: ProtectedTaskRunResultPublicationTransaction,
  input: SettlePublishedProtectedTaskRunAuthorizationInput,
  phase: ProtectedTaskRunResultPublicationPhase,
): Promise<ExactProtectedTaskRunResultPublicationProof | null> {
  assertPublishedProtectedTaskRunSettlementInput(input);
  if (phase !== "mapped" && phase !== "unmapped") {
    throw new TypeError("Protected Task publication phase is invalid");
  }
  const { reference } = input;
  const [task] = await tx.select({
    id: tasks.id,
    requestorId: tasks.requestorId,
  }).from(tasks).where(eq(tasks.id, reference.taskId))
    .limit(1).for("update");
  if (!task) return null;

  const [run] = await tx.select({
    id: taskRuns.id,
    taskId: taskRuns.taskId,
    jobId: taskRuns.jobId,
    status: taskRuns.status,
    completedAt: taskRuns.completedAt,
    resultRepresentation: taskRuns.resultRepresentation,
    resultContentNamespaceId: taskRuns.resultContentNamespaceId,
    resultRevision: taskRuns.resultRevision,
    resultCryptoObjectId: taskRuns.resultCryptoObjectId,
    resultCryptoAccessRevision: taskRuns.resultCryptoAccessRevision,
    resultCryptoRequiredNamespaceFingerprint:
      taskRuns.resultCryptoRequiredNamespaceFingerprint,
    resultCryptoMappingState: taskRuns.resultCryptoMappingState,
    resultTextIsNull: isNull(taskRuns.resultText).mapWith(Boolean),
    lastErrorIsNull: isNull(taskRuns.lastError).mapWith(Boolean),
  }).from(taskRuns).where(and(
    eq(taskRuns.id, reference.taskRunId),
    eq(taskRuns.taskId, reference.taskId),
  )).limit(1).for("update");
  if (!run) return null;

  const [job] = await tx.select({
    id: jobs.id,
    ownerId: jobs.ownerId,
    requestorId: jobs.requestorId,
    laneKey: jobs.laneKey,
    type: jobs.type,
    status: jobs.status,
    input: jobs.input,
    terminalReceipt: sql<unknown>`${jobs.metadata}->${PROTECTED_TASK_RUN_TERMINAL_RECEIPT_METADATA_KEY}`,
    resultIsNull: isNull(jobs.result).mapWith(Boolean),
    messageIsNull: isNull(jobs.message).mapWith(Boolean),
    startedAt: jobs.startedAt,
    completedAt: jobs.completedAt,
  }).from(jobs).where(eq(jobs.id, input.jobId))
    .limit(1).for("update");
  if (!job) return null;

  const [binding] = await tx.select({
    taskRunId: protectedTaskRunOutputBindings.taskRunId,
    bindingId: protectedTaskRunOutputBindings.bindingId,
    deliveryMode: protectedTaskRunOutputBindings.deliveryMode,
    resultOperationId: protectedTaskRunOutputBindings.resultOperationId,
    resultObjectId: protectedTaskRunOutputBindings.resultObjectId,
    acceptedPolicyRevision:
      protectedTaskRunOutputBindings.acceptedPolicyRevision,
    acceptedAt: protectedTaskRunOutputBindings.acceptedAt,
    resultTerminalAt: protectedTaskRunOutputBindings.resultTerminalAt,
    resultAttachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
    completedAt: protectedTaskRunOutputBindings.completedAt,
  }).from(protectedTaskRunOutputBindings).where(eq(
    protectedTaskRunOutputBindings.taskRunId,
    reference.taskRunId,
  )).limit(1).for("update");
  if (!binding) return null;

  const [revision] = await tx.select({
    sequence: taskRunResultCryptoRevisions.sequence,
    taskId: taskRunResultCryptoRevisions.taskId,
    taskRunId: taskRunResultCryptoRevisions.taskRunId,
    contentNamespaceId: taskRunResultCryptoRevisions.contentNamespaceId,
    resultRevision: taskRunResultCryptoRevisions.resultRevision,
    operationId: taskRunResultCryptoRevisions.operationId,
    requestDigest: taskRunResultCryptoRevisions.requestDigest,
    authorityFingerprint: taskRunResultCryptoRevisions.authorityFingerprint,
    requesterHumanId: taskRunResultCryptoRevisions.requesterHumanId,
    anchorNamespaceId: taskRunResultCryptoRevisions.anchorNamespaceId,
    cryptoObjectId: taskRunResultCryptoRevisions.cryptoObjectId,
    representation: taskRunResultCryptoRevisions.representation,
    payloadVersion: taskRunResultCryptoRevisions.payloadVersion,
    cryptoAccessRevision: taskRunResultCryptoRevisions.cryptoAccessRevision,
    requiredNamespaceFingerprint:
      taskRunResultCryptoRevisions.requiredNamespaceFingerprint,
    completion: taskRunResultCryptoRevisions.completion,
    disposition: taskRunResultCryptoRevisions.disposition,
    attemptCount: taskRunResultCryptoRevisions.attemptCount,
    nextAttemptAt: taskRunResultCryptoRevisions.nextAttemptAt,
    leaseToken: taskRunResultCryptoRevisions.leaseToken,
    leaseExpiresAt: taskRunResultCryptoRevisions.leaseExpiresAt,
    failureCode: taskRunResultCryptoRevisions.failureCode,
    cryptoCompletedAt: taskRunResultCryptoRevisions.cryptoCompletedAt,
  }).from(taskRunResultCryptoRevisions).where(and(
    eq(taskRunResultCryptoRevisions.taskId, reference.taskId),
    eq(taskRunResultCryptoRevisions.taskRunId, reference.taskRunId),
    eq(taskRunResultCryptoRevisions.resultRevision, 1),
  )).limit(1).for("update");
  if (!revision) return null;

  const [definition] = await tx.select({
    taskId: taskDefinitionCryptoRevisions.taskId,
    contentNamespaceId: taskDefinitionCryptoRevisions.contentNamespaceId,
    contentRevision: taskDefinitionCryptoRevisions.contentRevision,
    cryptoObjectId: taskDefinitionCryptoRevisions.cryptoObjectId,
    representation: taskDefinitionCryptoRevisions.representation,
    payloadVersion: taskDefinitionCryptoRevisions.payloadVersion,
    cryptoAccessRevision: taskDefinitionCryptoRevisions.cryptoAccessRevision,
    requiredNamespaceFingerprint:
      taskDefinitionCryptoRevisions.requiredNamespaceFingerprint,
    completion: taskDefinitionCryptoRevisions.completion,
    disposition: taskDefinitionCryptoRevisions.disposition,
    failureCode: taskDefinitionCryptoRevisions.failureCode,
  }).from(taskDefinitionCryptoRevisions).where(and(
    eq(taskDefinitionCryptoRevisions.taskId, reference.taskId),
    eq(taskDefinitionCryptoRevisions.cryptoObjectId, reference.inputObjectId),
  )).limit(1).for("share");
  if (!definition) return null;

  const runOutcome: ProtectedTaskRunTerminalOutcome | null =
    run.status === "completed" || run.status === "errored"
      ? run.status
      : null;
  const runCompletedAt = finiteDate(run.completedAt) ? run.completedAt : null;
  const jobStatus: ExactProtectedTaskRunResultPublicationProof["job"]["status"]
    | null = job.status === "running"
      || job.status === "failed"
      || job.status === "completed"
      ? job.status
      : null;
  const jobStartedAt = finiteDate(job.startedAt) ? job.startedAt : null;
  const jobDispositionIsExact = jobStatus !== null
    && jobStartedAt !== null && (
    jobStatus === "running"
      ? job.completedAt === null
      : finiteDate(job.completedAt)
        && job.completedAt.getTime() >= jobStartedAt.getTime()
  );
  const representation = revision.representation;
  const expectedReceipt: ProtectedTaskRunTerminalReceipt | null =
    runOutcome !== null
      && runCompletedAt !== null
      && revision.requestDigest instanceof Uint8Array
      && revision.requestDigest.length === 32
      ? Object.freeze({
          version: 1 as const,
          taskId: reference.taskId,
          taskRunId: reference.taskRunId,
          operationId: revision.operationId,
          requestDigest: terminalRequestDigestHex(revision.requestDigest),
          resultObjectId: reference.resultObjectId,
          resultRevision: 1 as const,
          resultRepresentation: representation,
          outcome: runOutcome,
          completedAt: runCompletedAt.toISOString(),
        })
      : null;
  const acceptedAt = binding.acceptedAt;
  const terminalAt = binding.resultTerminalAt;
  const attachedAt = binding.resultAttachedAt;
  const bindingCompletedAt = binding.completedAt;
  const leaseIsExact = revision.leaseToken === null
    ? revision.leaseExpiresAt === null
    : CANONICAL_UUID.test(revision.leaseToken)
      && finiteDate(revision.leaseExpiresAt);
  const lifecycleShapeIsExact =
    Number.isSafeInteger(revision.sequence)
    && revision.sequence > 0
    && Number.isSafeInteger(revision.attemptCount)
    && revision.attemptCount >= 0
    && (revision.nextAttemptAt === null || finiteDate(revision.nextAttemptAt))
    && leaseIsExact
    && revision.requestDigest instanceof Uint8Array
    && revision.requestDigest.length === 32
    && revision.authorityFingerprint instanceof Uint8Array
    && revision.authorityFingerprint.length === 32
    && revision.requiredNamespaceFingerprint instanceof Uint8Array
    && revision.requiredNamespaceFingerprint.length === 32;
  const commonProof =
    task.id === reference.taskId
    && task.requestorId.length > 0
    && run.id === reference.taskRunId
    && run.taskId === task.id
    && run.jobId === job.id
    && runOutcome !== null
    && runCompletedAt !== null
    && jobStatus !== null
    && jobStartedAt !== null
    && job.id === input.jobId
    && job.ownerId === task.requestorId
    && job.requestorId === task.requestorId
    && job.laneKey === `task:${task.id}`
    && job.type === "foreground"
    && job.resultIsNull
    && job.messageIsNull
    && exactProtectedTaskJobReference(job.input, reference)
    && jobDispositionIsExact
    && expectedReceipt !== null
    && exactTerminalReceipt(job.terminalReceipt, expectedReceipt)
    && (representation === "protected"
      ? run.resultTextIsNull && run.lastErrorIsNull
      : !run.resultTextIsNull || !run.lastErrorIsNull)
    && binding.taskRunId === run.id
    && binding.bindingId === `task-run-output:${run.id}`
    && binding.resultOperationId === revision.operationId
    && binding.resultObjectId === reference.resultObjectId
    && binding.acceptedPolicyRevision <= reference.policyRevision
    && finiteDate(acceptedAt)
    && finiteDate(terminalAt)
    && terminalAt.getTime() === runCompletedAt.getTime()
    && terminalAt.getTime() >= acceptedAt.getTime()
    && lifecycleShapeIsExact
    && revision.taskId === task.id
    && revision.taskRunId === run.id
    && CANONICAL_UUID.test(revision.contentNamespaceId)
    && revision.resultRevision === 1
    && revision.operationId === `task-run-result:${run.id}`
    && CANONICAL_UUID.test(revision.requesterHumanId)
    && revision.anchorNamespaceId === revision.contentNamespaceId
    && revision.cryptoObjectId === reference.resultObjectId
    && (representation === "protected" || representation === "dual")
    && revision.payloadVersion === 1
    && revision.cryptoAccessRevision === 0
    && revision.failureCode === null
    && definition.taskId === task.id
    && definition.contentNamespaceId === revision.contentNamespaceId
    && definition.contentRevision > 0
    && definition.cryptoObjectId === reference.inputObjectId
    && protectedTaskDefinitionSupportsPolicy(definition.representation,
      representation === "protected" ? "encrypted_only" : "shadow_encryption")
    && definition.payloadVersion === 1
    && definition.cryptoAccessRevision === 0
    && definition.requiredNamespaceFingerprint instanceof Uint8Array
    && definition.requiredNamespaceFingerprint.length === 32
    && sameBytes(
      revision.requiredNamespaceFingerprint,
      definition.requiredNamespaceFingerprint,
    )
    && definition.completion === "complete"
    && definition.disposition === "mapped"
    && definition.failureCode === null;
  if (
    !commonProof
    || runOutcome === null
    || runCompletedAt === null
    || jobStatus === null
    || jobStartedAt === null
  ) return null;

  const mappedProof =
    run.resultRepresentation === representation
    && run.resultContentNamespaceId === revision.contentNamespaceId
    && run.resultRevision === 1
    && run.resultCryptoObjectId === reference.resultObjectId
    && run.resultCryptoAccessRevision === revision.cryptoAccessRevision
    && run.resultCryptoRequiredNamespaceFingerprint instanceof Uint8Array
    && sameBytes(
      run.resultCryptoRequiredNamespaceFingerprint,
      revision.requiredNamespaceFingerprint,
    )
    && run.resultCryptoMappingState === "verified"
    && revision.completion === "complete"
    && revision.disposition === "mapped"
    && finiteDate(revision.cryptoCompletedAt)
    && (attachedAt === null
      || finiteDate(attachedAt)
        && attachedAt.getTime() === runCompletedAt.getTime())
    && (bindingCompletedAt === null
      || finiteDate(bindingCompletedAt)
        && attachedAt !== null
        && bindingCompletedAt.getTime() >= acceptedAt.getTime())
    && (binding.deliveryMode !== "none"
      || bindingCompletedAt === null
      || finiteDate(attachedAt)
        && finiteDate(bindingCompletedAt)
        && attachedAt.getTime() === bindingCompletedAt.getTime());
  const unmappedProof =
    run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped"
    && attachedAt === null
    && bindingCompletedAt === null
    && revision.disposition === "active"
    && (revision.completion === "pending"
      ? revision.cryptoCompletedAt === null
      : revision.completion === "complete"
        && finiteDate(revision.cryptoCompletedAt));
  if (phase === "mapped" ? !mappedProof : !unmappedProof) return null;

  return Object.freeze({
    phase,
    reference: Object.freeze({ ...reference }),
    task: Object.freeze({ id: task.id, requestorId: task.requestorId }),
    run: Object.freeze({
      id: run.id,
      outcome: runOutcome,
      completedAt: new Date(runCompletedAt.getTime()),
    }),
    job: Object.freeze({
      id: job.id,
      status: jobStatus,
      startedAt: new Date(jobStartedAt.getTime()),
      completedAt: copyOptionalDate(job.completedAt),
    }),
    binding: Object.freeze({
      bindingId: binding.bindingId,
      deliveryMode: binding.deliveryMode,
      resultAttachedAt: copyOptionalDate(attachedAt),
      completedAt: copyOptionalDate(bindingCompletedAt),
    }),
    lifecycle: Object.freeze({
      sequence: revision.sequence,
      operationId: revision.operationId,
      authorityFingerprint: revision.authorityFingerprint.slice(),
      requesterHumanId: revision.requesterHumanId,
      contentNamespaceId: revision.contentNamespaceId,
      cryptoObjectId: revision.cryptoObjectId,
      representation,
      requiredNamespaceFingerprint:
        revision.requiredNamespaceFingerprint.slice(),
      attemptCount: revision.attemptCount,
      leaseToken: revision.leaseToken,
      cryptoCompletedAt: copyOptionalDate(revision.cryptoCompletedAt),
    }),
  });
}

/**
 * Settle control-plane state only after an exact protected result is durably
 * mapped. The authorization callback owns its separate crypto transaction;
 * these product locks remain held so a false result cannot attach or complete
 * the Job. No current grant, device, or policy is required because this owner
 * never writes content.
 */
export async function settlePublishedProtectedTaskRunAuthorization(
  db: DirectDatabase,
  input: SettlePublishedProtectedTaskRunAuthorizationInput,
  completeAuthorization: (
    proof: PublishedProtectedTaskRunAuthorizationProof,
  ) => Promise<boolean>,
): Promise<boolean> {
  assertPublishedProtectedTaskRunSettlementInput(input);
  if (typeof completeAuthorization !== "function") {
    throw new TypeError("Published protected Task settlement is invalid");
  }
  return db.transaction(async (tx) => {
    const proof = await lockExactProtectedTaskRunResultPublicationInTx(
      tx, input, "mapped",
    );
    if (proof === null) return false;

    const authorized = await completeAuthorization(Object.freeze({
      contentNamespaceId: proof.lifecycle.contentNamespaceId,
      requesterHumanId: proof.lifecycle.requesterHumanId,
    }));
    if (!authorized) return false;

    if (
      proof.binding.resultAttachedAt === null
      || proof.binding.deliveryMode === "none"
        && proof.binding.completedAt === null
    ) {
      const [attached] = await tx.update(protectedTaskRunOutputBindings).set({
        ...(proof.binding.resultAttachedAt === null
          ? { resultAttachedAt: new Date(proof.run.completedAt.getTime()) }
          : {}),
        ...(proof.binding.deliveryMode === "none"
            && proof.binding.completedAt === null
          ? { completedAt: new Date(proof.run.completedAt.getTime()) }
          : {}),
      }).where(and(
        eq(protectedTaskRunOutputBindings.taskRunId, proof.run.id),
        eq(protectedTaskRunOutputBindings.bindingId, proof.binding.bindingId),
        eq(
          protectedTaskRunOutputBindings.resultOperationId,
          proof.lifecycle.operationId,
        ),
        eq(
          protectedTaskRunOutputBindings.resultObjectId,
          proof.reference.resultObjectId,
        ),
        lte(
          protectedTaskRunOutputBindings.acceptedPolicyRevision,
          proof.reference.policyRevision,
        ),
        eq(
          protectedTaskRunOutputBindings.resultTerminalAt,
          proof.run.completedAt,
        ),
        proof.binding.resultAttachedAt === null
          ? isNull(protectedTaskRunOutputBindings.resultAttachedAt)
          : eq(
              protectedTaskRunOutputBindings.resultAttachedAt,
              proof.binding.resultAttachedAt,
            ),
        proof.binding.deliveryMode === "none"
            && proof.binding.completedAt === null
          ? isNull(protectedTaskRunOutputBindings.completedAt)
          : undefined,
      )).returning({ taskRunId: protectedTaskRunOutputBindings.taskRunId });
      if (!attached) {
        throw new Error("Published protected Task settlement lost its binding");
      }
    }

    if (proof.job.status === "completed") return true;
    const [completedJob] = await tx.update(jobs).set({
      status: "completed",
      ...(proof.job.status === "running"
        ? { completedAt: new Date() }
        : {}),
    }).where(and(
      eq(jobs.id, proof.job.id),
      eq(jobs.input, proof.reference),
      eq(jobs.laneKey, `task:${proof.task.id}`),
      eq(jobs.type, "foreground"),
      eq(jobs.status, proof.job.status),
      isNotNull(jobs.startedAt),
      proof.job.status === "running"
        ? isNull(jobs.completedAt)
        : eq(jobs.completedAt, proof.job.completedAt!),
      isNull(jobs.result),
      isNull(jobs.message),
    )).returning({ id: jobs.id });
    if (!completedJob) {
      throw new Error("Published protected Task settlement lost its Job");
    }
    return true;
  });
}

async function terminalizeTaskRunResult(
  db: DirectDatabase,
  plan: TaskRunTerminalPlan,
): Promise<ProtectedTaskRunTerminalResult> {
  const { input, ordinaryResult } = plan;
  const receipt = terminalReceipt(input);
  return db.transaction(async (tx) => {
    const [policy] = await tx.select().from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"))
      .limit(1).for("share");

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
    const [requesterHuman] = resultRevision === undefined
      ? []
      : await tx.select({ id: actors.id }).from(actors).where(and(
        eq(actors.id, resultRevision.requesterHumanId),
        eq(actors.kind, "user"),
        eq(actors.ownerId, task.requestorId),
      )).limit(1).for("share");
    if (
      requesterHuman === undefined
      || !exactResultReservation(task, resultRevision, input)
    ) {
      return terminalRejected("conflict");
    }

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
    const taskIsExactTerminal = task.status === taskStatus
      || task.pauseRequestId != null && ["running", "awaiting", "paused", "pending"].includes(task.status);
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

    if (input.scheduleKind !== "cron" && task.pauseRequestId == null) {
      const [updatedTask] = await tx.update(tasks).set({
        status: input.outcome,
        updatedAt: new Date(input.completedAt.getTime()),
      }).where(and(
        eq(tasks.id, task.id),
        eq(tasks.status, "running"),
        eq(tasks.contentRepresentation, task.contentRepresentation),
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
 * Pause only the exact pending Task claim whose requestor no longer
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
      eq(tasks.contentRepresentation, "ordinary"),
      eq(taskRuns.resultRepresentation, "ordinary"),
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
      eq(tasks.contentRepresentation, "ordinary"),
      eq(taskRuns.resultRepresentation, "ordinary"),
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
      || task.contentRepresentation !== "ordinary"
      || (task.status !== "pending" && task.status !== "running")
    ) return { task, run: undefined, transitioned: false };

    const [run] = await tx.select().from(taskRuns)
      .where(and(
        eq(taskRuns.id, input.taskRunId),
        eq(taskRuns.taskId, input.taskId),
      ))
      .limit(1)
      .for("update");
    if (!run || run.id !== input.taskRunId || run.status !== "running"
      || run.resultRepresentation !== "ordinary") {
      return { task, run, transitioned: false };
    }
    let fundingBinding: TaskFundingBinding | null = null;
    if (run.fundingBinding !== null) {
      try {
        fundingBinding = parseTaskFundingBinding(run.fundingBinding);
      } catch {
        // The run still must be terminalized, but malformed funding facts must
        // never broaden which financial attempts this restart can close.
      }
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
      eq(taskRuns.resultRepresentation, "ordinary"),
    )).returning();
    const interruptedFundingPredicate = fundingBinding?.kind === "personal"
      ? and(
          eq(llmUsageEvents.fundingKind, "personal"),
          eq(llmUsageEvents.payerHumanId, task.requestorId),
        )
      : fundingBinding?.kind === "server"
        ? and(
            eq(llmUsageEvents.fundingKind, "server"),
            eq(llmUsageEvents.providerRoute, "surplus"),
          )
        : undefined;
    if (updatedRun && interruptedFundingPredicate) {
      // The restart owner proved this exact run can no longer publish. Preserve
      // known financial evidence while leaving unresolved Surplus charges in
      // the receipt-recovery queue. This only closes attempts attributed to the
      // exact run; it never sends or replays an inference request.
      await tx.update(llmUsageEvents).set({
        attemptOutcome: "interrupted",
        costState: sql`case
          when ${llmUsageEvents.providerRoute} = ${"surplus"}
            and ${llmUsageEvents.costState} = ${"actual"}
            then ${llmUsageEvents.costState}
          else ${"unknown"}
        end`,
        recoveryState: sql`case
          when ${llmUsageEvents.providerRoute} <> ${"surplus"} then null
          when ${llmUsageEvents.costState} = ${"actual"} then null
          else coalesce(${llmUsageEvents.recoveryState}, ${"pending"})
        end`,
        failureCode: sql`case
          when ${llmUsageEvents.providerRoute} = ${"surplus"}
            and ${llmUsageEvents.recoveryState} = ${"blocked_repair"}
            then coalesce(${llmUsageEvents.failureCode}, ${"execution_interrupted"})
          else ${"execution_interrupted"}
        end`,
        settledAt: sql`case
          when ${llmUsageEvents.providerRoute} = ${"surplus"}
            and ${llmUsageEvents.costState} = ${"actual"}
            then coalesce(${llmUsageEvents.settledAt}, ${completedAt.toISOString()}::timestamptz)
          else ${completedAt.toISOString()}::timestamptz
        end`,
        updatedAt: completedAt,
      }).where(and(eq(llmUsageEvents.taskId, input.taskId), interruptedFundingPredicate,
        eq(llmUsageEvents.attemptOutcome, "in_progress"),
        sql`${llmUsageEvents.metadata} ->> 'taskRunId' = ${input.taskRunId}`,
      )).returning({ id: llmUsageEvents.id });
    }
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
      eq(tasks.contentRepresentation, "ordinary"),
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
 * Authorization-pause an exact parked Task checkpoint. Both the
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
    .where(and(eq(tasks.id, id), excludesLocalExecutionRecapture()));
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
    .where(and(eq(tasks.id, id), status === "cancelled" ? undefined : excludesLocalExecutionRecapture()));
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
