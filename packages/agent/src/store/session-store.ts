import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import {
  agentDb as db,
  admitMemoryReviewSourceInTx,
  type MemoryReviewAdmission,
  actors,
  roomMembers,
  sessionMessages,
  sessions,
  getAttachmentsForTurns,
  eq,
  and,
  sql,
  asc,
  desc,
  inArray,
} from "@nautilo/db";
import {
  logicalMessageKey,
  type AdvancedVideoWorkcardContinuation,
  type MessageAttachmentRef,
} from "@nautilo/types";
import {
  appendCanonicalTranscriptRowsInTx,
  isCountedReplyRow as isCanonicalCountedReplyRow,
  type AppendNotificationContext,
} from "@nautilo/trust";
import { withAgentTrustContext, withSerializableAgentTrustContext, type TrustAgentTx } from "./trust-agent-db";
import { createUniversalModel } from "../providers/universal";
import { runWithUsageContext } from "../usage/usage-context";
import { fromRuntimeConfig } from "@nautilo/config";
import { resolveModelRole } from "../config/model-role-resolution";
import { computeMessageFingerprint } from "./fingerprint";
import { readTranscriptToolPresentation, withTranscriptToolPresentation, type TranscriptToolPresentation } from "./transcript-tool-result";
import { transcriptToolNameForRow } from "./transcript-tool-name";
import {
  redactTranscriptToolArgs,
  sanitizeSerializedTranscriptToolCalls,
  serializeTranscriptToolCalls,
} from "./transcript-tool-arguments";
import { durableComputerResultText } from "../tools/computer/model-result-projector";

/**
 * M084 — scope subagents use dedicated LangGraph `thread_id` values
 * (`subagent:<parentThreadId>:…`). Those sessions share `room_id` with the
 * parent; transcript APIs must ignore them so the main chat does not swap
 * to the subagent internal thread.
 */
export const SUBAGENT_GRAPH_THREAD_PREFIX = "subagent:" as const;

function withSessionTrustContext<T>(
  ownerId: string,
  agentId: string | undefined,
  fn: (tx: TrustAgentTx) => Promise<T>,
): Promise<T> {
  return withAgentTrustContext({ userId: ownerId, agentId }, fn);
}

export function isSubagentGraphThreadId(threadId: string): boolean {
  return threadId.startsWith(SUBAGENT_GRAPH_THREAD_PREFIX);
}

function excludeSubagentTranscriptSessions(): ReturnType<typeof sql> {
  return sql`${sessions.threadId} NOT LIKE ${SUBAGENT_GRAPH_THREAD_PREFIX + "%"}`;
}

/** Backward-compatible agent export; canonical implementation lives in trust. */
export function isCountedReplyRow(row: {
  role: string;
  content: string;
  originatedBy?: string | null | undefined;
}): boolean {
  return isCanonicalCountedReplyRow(row);
}

export interface EnsureSessionOptions {
  threadId: string;
  ownerId: string;
  personaId: string;
  /**
   * M042B (addresses inherited M042A gap): populate agent_id on new
   * session rows so the seed backfill doesn't have to run every boot.
   * Optional — omit / empty stores NULL and seedDefaultAgent backfills.
   */
  agentId?: string;
  /**
   * M042B: populate room_id on new session rows. Optional for the same
   * reason as agentId. Empty / undefined stores NULL; seedDefaultRoom
   * backfills on next boot.
   */
  roomId?: string;
  title?: string;
}

function isPostgresUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  const seen = new Set<unknown>();
  for (let i = 0; i < 10 && cur !== undefined && cur !== null && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur === "object" && "code" in cur) {
      const c = (cur as { code: unknown }).code;
      if (c === "23505" || c === 23505) return true;
    }
    let msg = "";
    if (cur instanceof Error) {
      msg = cur.message;
    } else if (
      typeof cur === "object" &&
      cur !== null &&
      "message" in cur &&
      typeof (cur as { message: unknown }).message === "string"
    ) {
      msg = (cur as { message: string }).message;
    }
    if (
      /duplicate key|unique constraint|uq_sessions_owner_thread/i.test(msg)
    ) {
      return true;
    }
    cur =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

async function ensureSessionInTx(tx: TrustAgentTx, opts: EnsureSessionOptions): Promise<string> {
  const existing = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.threadId, opts.threadId), eq(sessions.ownerId, opts.ownerId)))
    .limit(1);

  const row = existing[0];
  if (row) return row.id;

  // Concurrent first-write race: two transactions can both pass the
  // SELECT above and then both attempt the INSERT. `ON CONFLICT DO
  // NOTHING` is deliberate here — a bare INSERT that hits the
  // `uq_sessions_owner_thread` unique violation would ABORT the
  // surrounding transaction (Postgres `25P02 in_failed_sql_transaction`),
  // poisoning every subsequent statement in it (including the recovery
  // re-SELECT). The loser of the race therefore used to surface a
  // spurious failure even though the row was correctly deduped to one.
  // With DO NOTHING the conflict is silent (no error, tx stays alive):
  // the loser simply gets an empty `returning` and re-resolves the
  // winner's row below.
  try {
    const inserted = await tx
      .insert(sessions)
      .values({
        threadId: opts.threadId,
        ownerId: opts.ownerId,
        personaId: opts.personaId,
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        ...(opts.roomId ? { roomId: opts.roomId } : {}),
        title: opts.title ?? defaultTitleFromThread(opts.threadId),
      })
      .onConflictDoNothing({ target: [sessions.ownerId, sessions.threadId] })
      .returning({ id: sessions.id });

    const created = inserted[0];
    if (created) return created.id;
  } catch (e) {
    // Defensive: any unique violation that slips past DO NOTHING (e.g. a
    // future second constraint) still falls through to the re-SELECT;
    // anything else is a real error and propagates.
    if (!isPostgresUniqueViolation(e)) {
      throw e;
    }
  }

  // Either the INSERT conflicted (DO NOTHING → empty returning) or a
  // defensive unique violation was swallowed: re-resolve the row the
  // concurrent winner created. The tx was never aborted, so this SELECT
  // succeeds.
  const again = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.threadId, opts.threadId), eq(sessions.ownerId, opts.ownerId)))
    .limit(1);
  const found = again[0];
  if (!found) throw new Error("Failed to create or resolve session after conflict");
  return found.id;
}

export async function ensureSession(opts: EnsureSessionOptions): Promise<string> {
  return withSessionTrustContext(opts.ownerId, opts.agentId, (tx) =>
    ensureSessionInTx(tx, opts),
  );
}

/** Reserve already committed Human references before graph execution, even for a zero-output turn. */
export async function reserveMemoryReviewSources(threadId: string, ownerId: string, options: {
  agentId: string; roomId: string; humanTurnId: string; memoryReview: MemoryReviewAdmission;
}): Promise<void> {
  await withSessionTrustContext(ownerId, options.agentId, async (tx) => {
    const sessionId = await ensureSessionInTx(tx, { threadId, ownerId, personaId: "owner", agentId: options.agentId, roomId: options.roomId });
    await admitMemoryReviewSourceInTx(tx, { ...options.memoryReview, sessionId, threadId,
      agentId: options.agentId, roomId: options.roomId, turnId: options.humanTurnId });
  });
}

export interface AppendTranscriptOptions {
  memoryReview?: MemoryReviewAdmission;
  agentId?: string;
  roomId?: string;
  /** M070 — human rows only; keeps identical text across turns distinct in DB. */
  humanTurnId?: string;
  /**
   * M233 — bounded, server-authored notification provenance. Directed facts
   * and Subthread participation are written in this append transaction.
   */
  notificationContext?: AppendNotificationContext;
  /** M084 — default `main`; `subagent` for hidden nested runs */
  transcriptOrigin?: "main" | "subagent";
  parentThreadId?: string;
  scopeId?: string;
  /**
   * M143 — per-row `session_messages.metadata` (jsonb). Used by the Task
   * report-back wake to tag the synthetic input row with
   * `{ originatedBy: "task", taskId, taskRunId }` so the read-side filters
   * hide it from chat render / unread / reactions. Applied to every row in
   * THIS call, so callers must pass it only on a single-message persist
   * (the synthetic human input row), never on a mixed assistant/tool batch.
   */
  metadata?: Record<string, unknown>;
  /** Hidden supervision audit for tool-call/result rows, never a tool-free answer. */
  internalToolMetadata?: Record<string, unknown>;
  /**
   * D426 — when set, this append is writing Subthread CHILD reply rows
   * into the Subthread Room `subthreadRoomId`. Every persisted row is
   * stamped `session_messages.subthread_room_id = subthreadRoomId`
   * (child linkage), and — if at least one COUNTED reply row (see
   * {@link isCountedReplyRow}) was newly inserted — the root anchor
   * message's `reply_count` / `last_reply_at` / `summary_revision` is
   * authoritatively recomputed in the SAME transaction. Replay of an
   * already-persisted reply (fingerprint dedup) inserts nothing and
   * does NOT bump the revision. The caller MUST supply the Subthread
   * Room's own `threadId` / `roomId` (= `subthreadRoomId`) for the
   * session, not the parent's.
   */
  subthreadRoomId?: string;
}

export interface AppendTranscriptResult {
  /** Indices into `messagesToAppend` whose row INSERT threw a real
   *  postgres error (NOT just an ON CONFLICT dedup; that's silent). */
  failedIndices: number[];
  /** Number of NEW rows actually written to session_messages. */
  insertedCount: number;
  insertedRows: Array<{
    createdAt?: string;
    id: string;
    role: string;
    content: string | null;
    fingerprint: string | null;
    replyToMessageId: number | null;
  }>;
  /**
   * D426 — present only when this append wrote Subthread child rows
   * (`options.subthreadRoomId`) AND at least one COUNTED reply row was
   * newly inserted, so the root anchor summary was recomputed. Carries
   * the post-update `reply_count` / `last_reply_at` / `summary_revision`
   * so the Phase 2 responder / drawer route can publish a single
   * authoritative delta. Absent on replay (dedup) and on non-counted
   * (tool/system/task) batches.
   */
  rootSummary?: {
    parentRoomId: string;
    anchorMessageId: number;
    replyCount: number;
    lastReplyAt: Date | null;
    revision: number;
  } | undefined;
}

/** Match live quiet-supervision presentation while retaining the exact tool audit. */
export function transcriptMetadataForMessage(message: BaseMessage, options: AppendTranscriptOptions): Record<string, unknown> | null {
  const metadata = options.internalToolMetadata && (
    message instanceof ToolMessage || (AIMessage.isInstance(message) && message.tool_calls?.length)
  ) ? options.internalToolMetadata : options.metadata ?? null;
  return withTranscriptToolPresentation(message, metadata);
}

export async function appendTranscriptMessages(
  threadId: string,
  ownerId: string,
  personaId: string,
  messagesToAppend: BaseMessage[],
  options: AppendTranscriptOptions = {},
): Promise<AppendTranscriptResult> {
  if (messagesToAppend.length === 0) {
    return { failedIndices: [], insertedCount: 0, insertedRows: [] };
  }

  const rows = messagesToAppend.map((message) => {
    // Idempotency is defined by the exact execution message. Redact only the
    // serialized transcript sidecar after computing the raw fingerprint; the
    // LangGraph message/checkpoint remains untouched.
    const fingerprint = computeMessageFingerprint(
      message,
      options.humanTurnId ? { humanTurnId: options.humanTurnId } : {},
    );
    return {
      role: getRole(message),
      content: visibleTranscriptContent(message),
      toolCalls: AIMessage.isInstance(message) && message.tool_calls?.length
        ? serializeTranscriptToolCalls(message.tool_calls)
        : null,
      toolName: transcriptToolNameForRow(message),
      fingerprint,
      humanTurnId:
        getRole(message) === "user" ? options.humanTurnId ?? null : null,
      transcriptOrigin: options.transcriptOrigin ?? "main",
      parentThreadId: options.parentThreadId ?? null,
      scopeId: options.scopeId ?? null,
      metadata: transcriptMetadataForMessage(message, options),
      /**
       * D426 — Subthread child linkage. NULL for top-level Room messages;
       * set to the Subthread Room id for every child reply row so the
       * root summary aggregate can fan on `subthread_room_id`.
       */
      subthreadRoomId: options.subthreadRoomId ?? null,
      /**
       * D359 — quote-reply FK. The reply pointer rides on the human
       * HumanMessage as `additional_kwargs.nautilo_reply_to_message_id`
       * (set in `buildForegroundUserHumanMessage`). Assistant/tool/system
       * rows must never carry it, so the extraction guards on the `user`
       * role and on integer shape; anything else collapses to null.
       */
      replyToMessageId: extractReplyToMessageId(message),
    };
  });

  return withSessionTrustContext(ownerId, options.agentId, (tx) =>
    appendCanonicalTranscriptRowsInTx(tx, {
      session: {
        threadId,
        ownerId,
        personaId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.roomId ? { roomId: options.roomId } : {}),
        title: deriveTitle(messagesToAppend),
      },
      rows,
      ...(options.notificationContext
        ? { notificationContext: options.notificationContext }
        : {}),
    }, options.memoryReview && options.agentId && options.roomId && options.humanTurnId ? {
      afterMessageIdAllocated: async ({ tx, sessionId, messageId, row }) => {
        await admitMemoryReviewSourceInTx(tx, {
          ...options.memoryReview!, sessionId, messageId, role: row.role,
          threadId, agentId: options.agentId!, roomId: options.roomId!, turnId: options.humanTurnId!,
        });
      },
    } : {}),
  );
}

export interface SessionMessage {
  id: string;
  logicalMessageKey?: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolName: string | null;
  createdAt: Date;
  editedAt?: Date | null;
  editRevision?: number;
  /** D124 — quote-reply FK when set. */
  replyToMessageId?: number | null;
  /**
   * D426 — denormalized root reply summary, surfaced on root (anchor)
   * rows in parent room history. Absent on child / non-anchor rows
   * (callers leave it unset). `summaryRevision` is monotonic per root.
   */
  replyCount?: number;
  lastReplyAt?: Date | null;
  summaryRevision?: number;
  /** D124 — `sessions.owner_id` for room-scoped cross-session fan-in. */
  sourceUserId?: string;
  /** D300 — `sessions.agent_id` for assistant/tool rows in multi-agent rooms. */
  authorAgentId?: string;
  /** External harness that authored this Task result; `authorAgentId` is its delegator. */
  authorHarnessId?: string;
  /** D391 — retained attachments linked to this human turn (by M134
   *  `fingerprint` as `turn_id`). Present only on user rows that have
   *  retained attachments; absent otherwise. */
  attachments?: MessageAttachmentRef[] | undefined;
  /** D391 — the M134 fingerprint used to join attachments. Carried
   *  internally for the read-side reconcile; not serialized by the route
   *  (the route maps `attachments`, not this field). */
  fingerprint?: string | null | undefined;
  /** Closed, server-authored neutral presentation for a workcard continuation. */
  workcardContinuation?: AdvancedVideoWorkcardContinuation | undefined;
}

/**
 * M275 — exact durable coordinates for rows that survived the canonical
 * cross-member Room ordering and de-duplication pass. These coordinates are
 * server-internal sidecar input; they are deliberately kept out of the
 * ordinary {@link SessionMessage} projection returned to existing clients.
 */
export interface RoomHistorySelectedMessageCoordinate {
  readonly sessionId: string;
  readonly messageId: number;
  readonly editRevision: number;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly logicalMessageKey: string;
}

export function projectRoomHistorySelectedMessageCoordinate(row: Readonly<{
  id: number;
  sessionId: string;
  editRevision: number;
  role: string;
  fingerprint: string | null;
}>): RoomHistorySelectedMessageCoordinate {
  if (!["user", "assistant", "tool", "system"].includes(row.role)) {
    throw new TypeError("Room history selected role is unsupported");
  }
  return Object.freeze({
    sessionId: row.sessionId,
    messageId: row.id,
    editRevision: row.editRevision,
    role: row.role as RoomHistorySelectedMessageCoordinate["role"],
    logicalMessageKey: logicalMessageKey(row),
  });
}

function projectAdvancedVideoWorkcardContinuation(
  metadata: unknown,
): AdvancedVideoWorkcardContinuation | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (record["originatedBy"] !== "advanced_video_workcard") return undefined;
  const referenceCount = record["referenceCount"];
  if (typeof referenceCount !== "number" || !Number.isInteger(referenceCount) || referenceCount < 1 || referenceCount > 30) {
    return undefined;
  }
  return { kind: "advanced_video", referenceCount };
}

function projectAuthorHarnessAttribution(
  metadata: unknown,
): Readonly<{ authorHarnessId: string }> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (record["originatedBy"] !== "harness_task_result") return undefined;
  const harnessId = record["authorHarnessId"];
  return typeof harnessId === "string" && harnessId.length > 0 && harnessId.length <= 64
    ? { authorHarnessId: harnessId }
    : undefined;
}

export interface SessionInfo {
  sessionId: string;
  threadId: string;
  title: string | null;
  messageCount: number;
  startedAt: Date;
}

export async function getLatestSession(ownerId: string, threadId?: string): Promise<SessionInfo | null> {
  return withSessionTrustContext(ownerId, undefined, async (tx) => {
    const conditions = [eq(sessions.ownerId, ownerId), excludeSubagentTranscriptSessions()];
    if (threadId) {
      conditions.push(eq(sessions.threadId, threadId));
    }
    const rows = await tx
      .select({
        id: sessions.id,
        threadId: sessions.threadId,
        title: sessions.title,
        messageCount: sessions.messageCount,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(and(...conditions))
      // Raw SQL fragment: Drizzle has no native COALESCE in orderBy
      .orderBy(sql`COALESCE(${sessions.endedAt}, ${sessions.startedAt}) DESC`)
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.id,
      threadId: row.threadId,
      title: row.title,
      messageCount: row.messageCount,
      startedAt: row.startedAt,
    };
  });
}

/**
 * M146 (R7) — fetch the latest session for a SUBAGENT thread by exact
 * `threadId`. Unlike {@link getLatestSession}, this deliberately does NOT apply
 * the subagent-transcript exclusion: orphan task runs live on `subagent:`-
 * prefixed threads, and the `task` `read` / `GET /api/tasks/:id` surfaces want
 * exactly that transcript ("what did the helper actually do?"). Returns null
 * when the thread isn't a subagent thread (defensive) or no session exists yet.
 */
export async function getLatestSubagentSession(
  ownerId: string,
  threadId: string,
): Promise<SessionInfo | null> {
  if (!isSubagentGraphThreadId(threadId)) return null;
  return withSessionTrustContext(ownerId, undefined, async (tx) => {
    const rows = await tx
      .select({
        id: sessions.id,
        threadId: sessions.threadId,
        title: sessions.title,
        messageCount: sessions.messageCount,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), eq(sessions.threadId, threadId)))
      .orderBy(sql`COALESCE(${sessions.endedAt}, ${sessions.startedAt}) DESC`)
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.id,
      threadId: row.threadId,
      title: row.title,
      messageCount: row.messageCount,
      startedAt: row.startedAt,
    };
  });
}

/**
 * M163 — roles that are the run's OWN authored output. Excludes `system`
 * (internal prompt) and `user` (the synthetic brief AND any peer reply that
 * landed on the thread, e.g. ask_peer await/resume).
 */
const AGENT_AUTHORED_ROLES = ["assistant", "tool"] as const;

/** M163 — one parsed tool call the agent emitted on an `assistant` turn. */
export interface RunAgentTranscriptToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string | null;
}

export interface RunAgentTranscriptMessage extends TranscriptToolPresentation {
  /** Always "assistant" | "tool". */
  role: string;
  content: string;
  toolName: string | null;
  /**
   * M163 — parsed `session_messages.tool_calls`. Non-null only on `assistant`
   * rows that emitted tool calls; `null` on `tool` rows and on tool-call-free
   * assistant rows. The agent's own inputs — safe to surface.
   */
  toolCalls: RunAgentTranscriptToolCall[] | null;
  createdAt: Date;
}

export interface GetRunAgentTranscriptOptions {
  /** HTTP card metadata only; model-operated Task read keeps its existing exact JSON. */
  includeToolPresentation?: boolean;
  /** Task owner — sets the RLS trust context AND scopes the session lookup. */
  ownerId: string;
  /** `task_runs.graph_thread_id` — the thread the run executed on. */
  graphThreadId: string;
  /** `tasks.agent_id` — attributes rows in shared / multi-agent bot threads. */
  agentId: string;
  /** Run window lower bound; null ⇒ unbounded below. */
  startedAt: Date | null;
  /** Run window upper bound; null (still running) ⇒ unbounded above. */
  completedAt: Date | null;
}

/**
 * M163 — defensively parse `session_messages.tool_calls` (a JSON string of
 * LangChain `tool_calls`) into structured args. Malformed / null JSON yields
 * `null` (never throws, never poisons the row).
 */
export function parseTranscriptToolCalls(
  raw: string | null,
): RunAgentTranscriptToolCall[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const calls = parsed
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        name: typeof c["name"] === "string" ? c["name"] : "tool",
        args:
          c["args"] && typeof c["args"] === "object"
            ? redactTranscriptToolArgs(c["args"] as Record<string, unknown>)
            : {},
        id: typeof c["id"] === "string" ? c["id"] : null,
      }));
    return calls.length > 0 ? calls : null;
  } catch {
    return null;
  }
}

/**
 * M163 — single source of truth for "the agent-authored transcript of a Task
 * run". Returns ONLY `assistant` + `tool` rows (never `user`/`system`), scoped
 * to one run by exact `thread_id`, owner, agent, and the run time window, under
 * the task owner's RLS trust context. Consumed by both the `task` tool `read`
 * command and `GET /api/tasks/:id`.
 *
 * Notes:
 * - Runs under `withSessionTrustContext(ownerId, agentId, ...)`.
 * - Does NOT apply the subagent-transcript exclusion: orphan runs live on
 *   `subagent:`-prefixed threads and we WANT them; we key by exact thread_id.
 * - The `sessions.owner_id = ownerId` filter is what makes a peer-owned DM
 *   session return `[]` under the requester's context (R4).
 * - INVARIANT: `tasks.agent_id` (passed as `opts.agentId`) MUST equal the
 *   `sessions.agent_id` the run's batch is persisted under. Today
 *   `persistSubagentBatch` writes the session with the task's agent id, so this
 *   holds. If a future delegation runs a task under a different agent identity
 *   than `tasks.agent_id`, this filter would silently return `[]`.
 */
export interface RunTranscriptBoundary { createdAt: string; id: number }
export interface RunAgentTranscriptSnapshot {
  end: RunTranscriptBoundary | null;
  messages: Array<RunAgentTranscriptMessage & { id: number }>;
}

/** Freeze the last visible row before batching. This is a SQL allocation batch,
 * not a transcript ceiling: every row through that boundary remains reachable. */
export async function getRunAgentTranscriptSnapshot(
  opts: GetRunAgentTranscriptOptions,
  requestedEnd?: RunTranscriptBoundary | null,
): Promise<RunAgentTranscriptSnapshot> {
  return withSerializableAgentTrustContext({ userId: opts.ownerId, agentId: opts.agentId }, async (tx) => {
    const conditions = [
      eq(sessions.threadId, opts.graphThreadId), eq(sessions.ownerId, opts.ownerId),
      eq(sessions.agentId, opts.agentId),
      inArray(sessionMessages.role, AGENT_AUTHORED_ROLES as unknown as string[]),
    ];
    if (opts.startedAt) conditions.push(sql`${sessionMessages.createdAt} >= ${opts.startedAt.toISOString()}::timestamptz`);
    if (opts.completedAt) conditions.push(sql`${sessionMessages.createdAt} <= ${opts.completedAt.toISOString()}::timestamptz`);
    let end = requestedEnd;
    if (end === undefined) {
      const [last] = await tx.select({ createdAt: sql<string>`${sessionMessages.createdAt}::text`, id: sessionMessages.id })
        .from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(and(...conditions)).orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id)).limit(1);
      end = last ?? null;
    }
    if (end == null) return { end: null, messages: [] };
    conditions.push(sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) <= (${end.createdAt}::timestamptz, ${end.id}::bigint)`);
    const messages: RunAgentTranscriptSnapshot["messages"] = [];
    let after: RunTranscriptBoundary | undefined;
    // Retain the existing SQL batch size, replacing its former silent ceiling
    // with keyset continuation. No application-visible row maximum exists.
    const batchRows = 500;
    while (true) {
      const rows = await tx.select({ id: sessionMessages.id, role: sessionMessages.role,
        content: sessionMessages.content, toolName: sessionMessages.toolName, toolCalls: sessionMessages.toolCalls, metadata: sessionMessages.metadata,
        createdAt: sessionMessages.createdAt, positionTime: sql<string>`${sessionMessages.createdAt}::text`,
      }).from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(and(...conditions, ...(after ? [sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) > (${after.createdAt}::timestamptz, ${after.id}::bigint)`] : [])))
        .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id)).limit(batchRows);
      for (const row of rows) {
        if (row.content === null) throw new Error("Task transcript ordinary content is unavailable");
        messages.push({ id: row.id, role: row.role, content: row.content, toolName: row.toolName ?? null,
          ...(opts.includeToolPresentation && row.role === "tool" ? readTranscriptToolPresentation(row.metadata) : {}),
          toolCalls: row.role === "tool" ? null : parseTranscriptToolCalls(row.toolCalls), createdAt: row.createdAt });
      }
      if (rows.length < batchRows) break;
      const last = rows.at(-1)!;
      after = { createdAt: last.positionTime, id: last.id };
    }
    return { end, messages };
  });
}

/** Existing HTTP callers deliberately receive the full ordinary transcript. */
export async function getRunAgentTranscript(opts: GetRunAgentTranscriptOptions): Promise<RunAgentTranscriptMessage[]> {
  const snapshot = await getRunAgentTranscriptSnapshot(opts);
  return snapshot.messages.map(({ id: _id, ...message }) => message);
}

export async function getLatestSessionForRoom(
  ownerId: string,
  roomId: string,
): Promise<SessionInfo | null> {
  return withSessionTrustContext(ownerId, undefined, async (tx) => {
    const rows = await tx
      .select({
        id: sessions.id,
        threadId: sessions.threadId,
        title: sessions.title,
        messageCount: sessions.messageCount,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, ownerId),
          eq(sessions.roomId, roomId),
          excludeSubagentTranscriptSessions(),
        ),
      )
      // Room-scoped history must include legacy thread_id shapes that were
      // backfilled to the Room after M042B, not just the Room's graphThreadId.
      .orderBy(sql`COALESCE(${sessions.endedAt}, ${sessions.startedAt}) DESC`)
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.id,
      threadId: row.threadId,
      title: row.title,
      messageCount: row.messageCount,
      startedAt: row.startedAt,
    };
  });
}

/**
 * M259 — latest ordinary session authored by any current Human member of a
 * Room. The caller's user id establishes the RLS trust context only; the
 * route must verify the caller's exact Room membership first.
 */
export async function getLatestSessionForRoomAcrossMembers(
  viewerUserId: string,
  roomId: string,
): Promise<SessionInfo | null> {
  return withSessionTrustContext(viewerUserId, undefined, async (tx) => {
    const [row] = await tx
      .select({
        id: sessions.id,
        threadId: sessions.threadId,
        title: sessions.title,
        messageCount: sessions.messageCount,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .innerJoin(roomMembers, eq(roomMembers.roomId, sessions.roomId))
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(
        and(
          eq(sessions.roomId, roomId),
          eq(actors.kind, "user"),
          eq(actors.ownerId, sessions.ownerId),
          excludeSubagentTranscriptSessions(),
        ),
      )
      .orderBy(sql`COALESCE(${sessions.endedAt}, ${sessions.startedAt}) DESC`)
      .limit(1);
    return row
      ? {
        sessionId: row.id,
        threadId: row.threadId,
        title: row.title,
        messageCount: row.messageCount,
        startedAt: row.startedAt,
      }
      : null;
  });
}

/**
 * D391 — fetch retained attachments for a set of human-turn fingerprints and
 * group them into `{ fingerprint -> MessageAttachmentRef[] }`. Used by the
 * history reads to attach `attachments[]` per deduped message. The dedup
 * keeps one message per fingerprint, so each attachment list surfaces once.
 */
async function fetchAttachmentRefsByFingerprint(
  fingerprints: readonly (string | null | undefined)[],
): Promise<Map<string, MessageAttachmentRef[]>> {
  const map = new Map<string, MessageAttachmentRef[]>();
  const ids = fingerprints.filter((f): f is string => typeof f === "string" && f.length > 0);
  if (ids.length === 0) return map;
  const rows = await getAttachmentsForTurns(ids);
  for (const row of rows) {
    if (!row.turnId) continue;
    const list = map.get(row.turnId);
    const ref: MessageAttachmentRef = {
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
    if (list) list.push(ref);
    else map.set(row.turnId, [ref]);
  }
  return map;
}

export async function getSessionMessages(
  sessionId: string,
  limit = 100,
  offset = 0,
): Promise<SessionMessage[]> {
  const rows = await db
    .select({
      id: sessionMessages.id,
      role: sessionMessages.role,
      content: sessionMessages.content,
      toolCalls: sessionMessages.toolCalls,
      toolName: sessionMessages.toolName,
      createdAt: sessionMessages.createdAt,
      editedAt: sessionMessages.editedAt,
      editRevision: sessionMessages.editRevision,
      fingerprint: sessionMessages.fingerprint,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id))
    .limit(limit)
    .offset(offset);

  const attachmentsByFp = await fetchAttachmentRefsByFingerprint(rows.map((r) => r.fingerprint));
  return rows.map((r) => ({
    id: String(r.id),
    logicalMessageKey: logicalMessageKey(r),
    role: r.role,
    content: r.content,
    toolCalls: sanitizeSerializedTranscriptToolCalls(r.toolCalls),
    toolName: r.toolName ?? null,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    editRevision: r.editRevision,
    fingerprint: r.fingerprint,
    ...(attachmentsByFp.get(r.fingerprint ?? "") ? { attachments: attachmentsByFp.get(r.fingerprint!) } : {}),
  }));
}

export async function getLatestSessionMessages(
  sessionId: string,
  limit = 100,
): Promise<SessionMessage[]> {
  const rows = await db
    .select({
      id: sessionMessages.id,
      role: sessionMessages.role,
      content: sessionMessages.content,
      toolCalls: sessionMessages.toolCalls,
      toolName: sessionMessages.toolName,
      createdAt: sessionMessages.createdAt,
      editedAt: sessionMessages.editedAt,
      editRevision: sessionMessages.editRevision,
      fingerprint: sessionMessages.fingerprint,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
    .limit(limit);

  const attachmentsByFp = await fetchAttachmentRefsByFingerprint(rows.map((r) => r.fingerprint));
  return [...rows].reverse().map((r) => ({
    id: String(r.id),
    logicalMessageKey: logicalMessageKey(r),
    role: r.role,
    content: r.content,
    toolCalls: sanitizeSerializedTranscriptToolCalls(r.toolCalls),
    toolName: r.toolName ?? null,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    editRevision: r.editRevision,
    fingerprint: r.fingerprint,
    ...(attachmentsByFp.get(r.fingerprint ?? "") ? { attachments: attachmentsByFp.get(r.fingerprint!) } : {}),
  }));
}

export async function getRoomMessagesBeforeCursor(args: {
  ownerId: string;
  roomId: string;
  beforeCreatedAt: Date;
  beforeId: number;
  limit?: number;
}): Promise<{ messages: SessionMessage[]; hasMoreBefore: boolean }> {
  const limit = Math.max(1, args.limit ?? 100);
  const beforeCreatedAtIso = args.beforeCreatedAt.toISOString();
  return withSessionTrustContext(args.ownerId, undefined, async (tx) => {
    const rows = await tx
      .select({
        id: sessionMessages.id,
        role: sessionMessages.role,
        content: sessionMessages.content,
        toolCalls: sessionMessages.toolCalls,
        toolName: sessionMessages.toolName,
        createdAt: sessionMessages.createdAt,
        editedAt: sessionMessages.editedAt,
        editRevision: sessionMessages.editRevision,
        metadata: sessionMessages.metadata,
        fingerprint: sessionMessages.fingerprint,
        sessionAgentId: sessions.agentId,
        replyCount: sessionMessages.replyCount,
        lastReplyAt: sessionMessages.lastReplyAt,
        summaryRevision: sessionMessages.summaryRevision,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessions.ownerId, args.ownerId),
          eq(sessions.roomId, args.roomId),
          excludeSubagentTranscriptSessions(),
          sql`(${sessionMessages.createdAt} < ${beforeCreatedAtIso}::timestamptz OR (${sessionMessages.createdAt} = ${beforeCreatedAtIso}::timestamptz AND ${sessionMessages.id} < ${args.beforeId}))`,
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    return {
      hasMoreBefore: rows.length > limit,
      messages: [...pageRows].reverse().map((r) => ({
        id: String(r.id),
        logicalMessageKey: logicalMessageKey(r),
        role: r.role,
        content: r.content,
        toolCalls: sanitizeSerializedTranscriptToolCalls(r.toolCalls),
        toolName: r.toolName ?? null,
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        editRevision: r.editRevision,
        replyCount: r.replyCount,
        lastReplyAt: r.lastReplyAt,
        summaryRevision: r.summaryRevision,
        ...(r.role === "assistant" || r.role === "tool"
          ? r.sessionAgentId
            ? { authorAgentId: r.sessionAgentId }
            : {}
          : {}),
        ...(projectAuthorHarnessAttribution(r.metadata) ?? {}),
        ...(projectAdvancedVideoWorkcardContinuation(r.metadata)
          ? { workcardContinuation: projectAdvancedVideoWorkcardContinuation(r.metadata) }
          : {}),
      })),
    };
  });
}

/**
 * D124 — `GET /api/rooms/:id/messages` cursor page across all member sessions.
 *
 * Returns messages from every `sessions` row with `room_id = :roomId` whose
 * `owner_id` matches a human `room_members` actor for that room. Subagent
 * transcript sessions stay excluded via {@link excludeSubagentTranscriptSessions}.
 *
 * **Access:** the route must still verify the *viewer* is a member of the
 * room (e.g. {@link getRoomGraphThreadForOwnerSession} or a direct
 * `room_members` check) — this query does not filter by viewer.
 */
export async function getRoomMessagesAcrossMemberSessionsWithSelection(args: {
  /** Viewer user id. Used only to set Path C RLS trust context; route must verify room membership first. */
  ownerId: string;
  roomId: string;
  beforeCreatedAt: Date;
  beforeId: number;
  limit?: number;
  /** Full-mode structural projection: body-bearing ordinary columns are not selected. */
  contentRepresentation?: "ordinary" | "structural";
}): Promise<{
  messages: SessionMessage[];
  hasMoreBefore: boolean;
  selectedCoordinates: readonly RoomHistorySelectedMessageCoordinate[];
}> {
  const limit = Math.max(1, args.limit ?? 100);
  const beforeCreatedAtIso = args.beforeCreatedAt.toISOString();
  const rows = await withSessionTrustContext(args.ownerId, undefined, async (tx) =>
    tx
      .select({
        id: sessionMessages.id,
        sessionId: sessionMessages.sessionId,
        role: sessionMessages.role,
        ...(args.contentRepresentation === "structural" ? {} : {
          content: sessionMessages.content,
          toolCalls: sessionMessages.toolCalls,
          toolName: sessionMessages.toolName,
          metadata: sessionMessages.metadata,
        }),
        createdAt: sessionMessages.createdAt,
        replyToMessageId: sessionMessages.replyToMessageId,
        sourceUserId: sessions.ownerId,
        sessionAgentId: sessions.agentId,
        fingerprint: sessionMessages.fingerprint,
        replyCount: sessionMessages.replyCount,
        lastReplyAt: sessionMessages.lastReplyAt,
        summaryRevision: sessionMessages.summaryRevision,
        editedAt: sessionMessages.editedAt,
        editRevision: sessionMessages.editRevision,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .innerJoin(roomMembers, eq(roomMembers.roomId, sessions.roomId))
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(
        and(
          eq(sessions.roomId, args.roomId),
          eq(actors.kind, "user"),
          eq(actors.ownerId, sessions.ownerId),
          excludeSubagentTranscriptSessions(),
          // M143 — hide the Task report-back synthetic input row. NULL-safe:
          // `metadata` is NULL on every pre-existing row, and a bare `<> 'task'`
          // evaluates to NULL (not-true) → it would silently drop the entire
          // normal transcript. `IS DISTINCT FROM` treats NULL as "not task".
          sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
          // D430 — hide known react tool rows. Legacy NULL tool names remain
          // visible because the schema cannot distinguish their historical tool.
          sql`${sessionMessages.toolName} IS DISTINCT FROM 'react'`,
          sql`(${sessionMessages.createdAt} < ${beforeCreatedAtIso}::timestamptz OR (${sessionMessages.createdAt} = ${beforeCreatedAtIso}::timestamptz AND ${sessionMessages.id} < ${args.beforeId}))`,
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(limit + 1),
  );

  // M134 — read-side de-duplication. When the Room Conductor wakes N>1 bots
  // for one inbound user message, each bot's job persists the human message
  // into its own per-bot session (M070 dedup is per-session), so the
  // cross-session room transcript would otherwise show it N times. Every
  // woken bot shares one `turnId`, making the human-message `fingerprint`
  // identical across those sessions, so we collapse user-role rows that share
  // a non-null fingerprint (keep the first seen). Genuinely distinct user
  // sends carry distinct `humanTurnId`s ⇒ distinct fingerprints ⇒ never
  // collapsed. D124/D190 system rows are also fanned out one-per-human session
  // for visibility; collapse identical rows from that fan-out by
  // content+sidecar+createdAt so one audit line renders once per room event.
  const seenUserFingerprints = new Set<string>();
  const seenSystemKeys = new Set<string>();
  const deduped = rows.filter((r) => {
    if (r.role === "user" && r.fingerprint) {
      if (seenUserFingerprints.has(r.fingerprint)) return false;
      seenUserFingerprints.add(r.fingerprint);
      return true;
    }
    if (r.role === "system") {
      const key = [
        r.content == null ? `absent:${r.id}` : `ordinary:${r.content}`,
        r.toolCalls ?? "",
        r.createdAt.toISOString(),
      ].join("\u001f");
      if (seenSystemKeys.has(key)) return false;
      seenSystemKeys.add(key);
      return true;
    }
    return true;
  });

  const pageRows = deduped.slice(0, limit);
  // D391 — reconcile attachments at the dedup. Each surviving user row
  // carries a non-null `fingerprint`; retained attachments are stamped with
  // that same fingerprint as `turn_id`, so fetching by the page's
  // fingerprints yields exactly one attachment list per deduped human turn
  // (regardless of which per-bot copy survived the collapse). Assistant /
  // tool rows have no fingerprint and get no attachments.
  const attachmentsByFp = args.contentRepresentation === "structural"
    ? new Map<string, MessageAttachmentRef[]>()
    : await fetchAttachmentRefsByFingerprint(pageRows.map((r) => r.fingerprint));
  return {
    hasMoreBefore: deduped.length > limit,
    selectedCoordinates: Object.freeze(
      [...pageRows].reverse().map(projectRoomHistorySelectedMessageCoordinate),
    ),
    messages: [...pageRows].reverse().map((r) => ({
      id: String(r.id),
      logicalMessageKey: logicalMessageKey(r),
      role: r.role,
      content: args.contentRepresentation === "structural" ? null : (r.content ?? null),
      toolCalls: args.contentRepresentation === "structural"
        ? null
        : sanitizeSerializedTranscriptToolCalls(r.toolCalls ?? null),
      toolName: args.contentRepresentation === "structural" ? null : (r.toolName ?? null),
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      editRevision: r.editRevision,
      replyToMessageId: r.replyToMessageId ?? null,
      replyCount: r.replyCount,
      lastReplyAt: r.lastReplyAt,
      summaryRevision: r.summaryRevision,
      sourceUserId: r.sourceUserId,
      ...(r.role === "assistant" || r.role === "tool"
        ? r.sessionAgentId
          ? { authorAgentId: r.sessionAgentId }
          : {}
        : {}),
      ...(args.contentRepresentation === "structural"
        ? {}
        : (projectAuthorHarnessAttribution(r.metadata) ?? {})),
      ...(attachmentsByFp.get(r.fingerprint ?? "")
        ? { attachments: attachmentsByFp.get(r.fingerprint!) }
        : {}),
      ...(args.contentRepresentation !== "structural" && projectAdvancedVideoWorkcardContinuation(r.metadata)
        ? { workcardContinuation: projectAdvancedVideoWorkcardContinuation(r.metadata) }
        : {}),
    })),
  };
}

/**
 * Public ordinary Room history. M275's protected sidecar composes from
 * {@link getRoomMessagesAcrossMemberSessionsWithSelection}; this wrapper
 * preserves the byte-compatible response shape for every existing caller.
 */
export async function getRoomMessagesAcrossMemberSessions(args: {
  ownerId: string;
  roomId: string;
  beforeCreatedAt: Date;
  beforeId: number;
  limit?: number;
}): Promise<{ messages: SessionMessage[]; hasMoreBefore: boolean }> {
  const page = await getRoomMessagesAcrossMemberSessionsWithSelection(args);
  return {
    messages: page.messages,
    hasMoreBefore: page.hasMoreBefore,
  };
}

/**
 * M087 — timestamp (ISO-8601 UTC) of the most-recent `role = 'user'`
 * message in the given room, across the owner's sessions for that room, or
 * `null` when the room has no prior user message (brand-new room) or on any
 * lookup failure. Called at chat ingress BEFORE the new turn's user message
 * is persisted, so the result is genuinely the *previous* message. Subagent
 * transcript sessions are excluded. Read by `pre-model`'s `## Current time`
 * block to render the "Last user message in this room: …" line.
 *
 * `ownerId` is used only to set the RLS trust context; the room scope is the
 * content axis.
 */
export async function findLatestUserMessageAt(args: {
  ownerId: string;
  roomId: string;
}): Promise<string | null> {
  if (!args.roomId) return null;
  const rows = await withSessionTrustContext(args.ownerId, undefined, async (tx) =>
    tx
      .select({ createdAt: sessionMessages.createdAt })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessions.roomId, args.roomId),
          eq(sessionMessages.role, "user"),
          excludeSubagentTranscriptSessions(),
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(1),
  );
  const first = rows[0];
  if (!first?.createdAt) return null;
  const d = first.createdAt instanceof Date ? first.createdAt : new Date(first.createdAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface SessionSearchResult {
  sessionId: string;
  title: string | null;
  startedAt: Date;
  snippets: string[];
  summary: string;
}

export async function searchSessions(opts: {
  ownerId: string;
  personaId: string;
  query: string;
  limit?: number;
  excludeThreadId?: string;
}): Promise<SessionSearchResult[]> {
  const { ownerId, personaId, query, limit = 5, excludeThreadId } = opts;

  const grouped = await withSessionTrustContext(ownerId, undefined, async (tx) => {
    // Raw SQL: Drizzle has no native full-text search support — needs
    // @@ operator and plainto_tsquery() for tsvector matching
    const rows = await tx.execute<{
      session_id: string;
      title: string | null;
      started_at: string;
      content: string;
    }>(sql`
      SELECT
        s.id as session_id,
        s.title,
        s.started_at,
        sm.content
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      WHERE s.owner_id = ${ownerId}
        AND s.persona_id = ${personaId}
        AND s.thread_id NOT LIKE 'subagent:%'
        AND (${excludeThreadId ?? ""} = '' OR s.thread_id <> ${excludeThreadId ?? ""})
        AND sm.content_search @@ plainto_tsquery('english', ${query})
      ORDER BY s.started_at DESC, sm.created_at DESC
      LIMIT ${limit * 8}
    `);

    const map = new Map<string, { title: string | null; startedAt: Date; snippets: string[] }>();
    for (const row of rows) {
      if (!map.has(row.session_id)) {
        map.set(row.session_id, {
          title: row.title,
          startedAt: new Date(row.started_at),
          snippets: [],
        });
      }
      const entry = map.get(row.session_id)!;
      if (entry.snippets.length < 4) {
        entry.snippets.push(row.content);
      }
    }
    return map;
  });

  const selected = Array.from(grouped.entries()).slice(0, limit);
  if (selected.length === 0) return [];

  const config = fromRuntimeConfig();
  const modelId = resolveModelRole("sessionSearch", {
    ...(config.nautilo_session_search_model
      ? { configuredId: config.nautilo_session_search_model }
      : {}),
  });
  const model = await createUniversalModel(modelId);

  const summaries = await Promise.all(
    selected.map(async ([sessionId, data]) => {
      const prompt = [
        `Summarize the following conversation excerpts in 2-3 sentences.`,
        `Focus only on what is relevant to this query: "${query}"`,
        "",
        ...data.snippets.map((snippet, i) => `Excerpt ${i + 1}: ${snippet}`),
      ].join("\n");

      const response = await runWithUsageContext(
        { callType: "session_search" },
        () => model.invoke([new HumanMessage(prompt)]),
      );
      const summary = visibleTranscriptContent(response as BaseMessage);

      return {
        sessionId,
        title: data.title,
        startedAt: data.startedAt,
        snippets: data.snippets,
        summary,
      };
    }),
  );

  return summaries;
}

function getRole(message: BaseMessage): string {
  if (message instanceof HumanMessage) return "user";
  if (message instanceof ToolMessage) return "tool";
  if (message instanceof SystemMessage) return "system";
  if (AIMessage.isInstance(message)) return "assistant";
  return "unknown";
}

/**
 * D359 — pull the quote-reply FK off the human HumanMessage's
 * `additional_kwargs.nautilo_reply_to_message_id` (set by
 * `buildForegroundUserHumanMessage`). Returns `null` for non-human
 * rows and for any kwarg shape that isn't a safe integer, so
 * assistant/tool/system rows can never accidentally carry a reply
 * pointer. Negative ids are rejected (DB row ids are non-negative
 * sequences); `null`/`undefined` kwargs collapse to `null`.
 */
export function extractReplyToMessageId(message: BaseMessage): number | null {
  if (!HumanMessage.isInstance(message)) return null;
  const raw = (message.additional_kwargs ?? {})["nautilo_reply_to_message_id"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

function isReasoningContentBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const t = (block as Record<string, unknown>)["type"];
  return t === "reasoning" || t === "redacted_thinking" || t === "thinking";
}

/** Strip reasoning blocks before transcript persistence (not LangGraph checkpoint). */
export function sanitizeMessageForTranscript(message: BaseMessage): BaseMessage {
  if (!AIMessage.isInstance(message)) return message;
  if (typeof message.content === "string") return message;
  if (!Array.isArray(message.content)) return message;
  const filtered = message.content.filter((block) => !isReasoningContentBlock(block));
  if (filtered.length === message.content.length) return message;
  const content = filtered.length > 0 ? filtered : "";
  const sanitized = new AIMessage({ content });
  if (message.tool_calls?.length) {
    sanitized.tool_calls = message.tool_calls;
  }
  return sanitized;
}

/**
 * Returns the human-readable transcript projection of a LangChain message.
 *
 * Images are delivered to a vision-capable model as structured `image_url`
 * parts and retained separately through the attachment relation. They are not
 * text authored by the Human, so a synthetic `[image]` marker must never be
 * persisted into (or subsequently rendered from) the visible transcript.
 * Actual text blocks are copied verbatim, including a Human who deliberately
 * typed the literal string `[image]`.
 */
export function visibleTranscriptContent(message: BaseMessage): string {
  if (message instanceof ToolMessage) {
    const durableComputerResult = durableComputerResultText(message);
    if (durableComputerResult !== null) return durableComputerResult;
  }
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const rec = block as Record<string, unknown>;
          if (isReasoningContentBlock(block)) return "";
          if ("text" in rec) return String(rec["text"]);
          const t = rec["type"];
          if (t === "image_url" || t === "image") return "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function deriveTitle(messagesToAppend: BaseMessage[]): string {
  const firstHuman = messagesToAppend.find((message) => message instanceof HumanMessage);
  if (!firstHuman) return "New session";
  const content = visibleTranscriptContent(firstHuman).trim();
  return content.length > 50 ? `${content.slice(0, 47)}...` : content || "New session";
}

function defaultTitleFromThread(threadId: string): string {
  return `Session ${threadId.slice(0, 8)}`;
}
