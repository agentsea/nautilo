import {
  listReactionsForMessageIds,
  normalizeRoomMessageSearchQuery,
  queryRoomMessageContentIndex,
  type RoomMessageSearchDb,
} from "@nautilo/agent";
import {
  actors,
  agents,
  alias,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  notExists,
  or,
  RECENT_CONVERSATION_LIMIT_DEFAULT,
  RECENT_CONVERSATION_LIMIT_MAX,
  roomSilenceState,
  sessionMessages,
  sessions,
  sql,
  users,
  type DirectDatabase,
  type SQL,
} from "@nautilo/db";
import { normalizeSearchQuery } from "./search-query";

/**
 * M135 Phase 7 — room-scoped full-text history search used as Conductor
 * EVIDENCE (not as an answer). Two consumers:
 *   1. the deterministic history-owner route (D-B) in `routeRoomMessage`, and
 *   2. the Floor Manager's bounded `request_search` refinement (P5).
 *
 * Reuses the existing `session_messages.content_search` GIN index (no schema
 * change). Unlike `searchSessions` (per-owner/persona, LLM-summarized), this
 * is scoped by `roomId` across EVERY member session of the room and returns
 * RAW snippets — no LLM call.
 *
 * Hardening contract: `authorActorId` is server-internal and MUST NEVER be
 * passed to the Floor Manager LLM. The Conductor maps handles → actor ids
 * itself; the LLM works in display names + `@handle` + ISO-8601 UTC only.
 */
export interface RoomHistoryHit {
  messageId: number;
  ts: Date;
  /** Durable transcript role; present on production transcript reads. */
  role?: "user" | "assistant" | "tool" | "system";
  authorDisplayName: string;
  /** `@`-handle of the author (human or bot), WITHOUT the leading `@`. */
  handle: string;
  /** Server-internal actor id. NEVER passed to the LLM. */
  authorActorId: string;
  snippet: string;
  /** M121 — count-only reaction snapshot for woken-bot transcript lines. */
  reactions?: { emoji: string; count: number }[];
}

/**
 * Minimal DB surface this module needs. In production the caller passes
 * `createDirectDb(1)` (BYPASSRLS superuser — no trust-context wrapping
 * required). Typed structurally so unit tests can inject a fake.
 */
export type RoomHistorySearchDb = RoomMessageSearchDb;
export type TypedRoomHistorySearchDb = RoomMessageSearchDb &
  Pick<DirectDatabase, "select">;

interface RawHistoryRow {
  message_id: number | string;
  ts: string | Date;
  role: string;
  content: string;
  agent_handle: string | null;
  agent_display_name: string | null;
  agent_actor_id: string | null;
  user_handle: string | null;
  user_name: string | null;
  user_actor_id: string | null;
}

const SNIPPET_MAX = 280;
const agentAuthor = alias(actors, "agent_author");
const userAuthor = alias(actors, "user_author");

function selectHistoryRows(db: Pick<DirectDatabase, "select">) {
  return db
    .select({
      message_id: sql<number>`${sessionMessages.id}`.as("message_id"),
      ts: sql<Date>`${sessionMessages.createdAt}`.as("ts"),
      role: sql<string>`${sessionMessages.role}`.as("role"),
      content: sql<string>`${sessionMessages.content}`.as("content"),
      agent_handle: sql<string | null>`${agents.handle}`.as("agent_handle"),
      agent_display_name: sql<string | null>`${agentAuthor.displayName}`.as(
        "agent_display_name",
      ),
      agent_actor_id: sql<string | null>`${agentAuthor.id}`.as("agent_actor_id"),
      user_handle: sql<string | null>`${users.handle}`.as("user_handle"),
      user_name: sql<string | null>`${userAuthor.displayName}`.as("user_name"),
      user_actor_id: sql<string | null>`${userAuthor.id}`.as("user_actor_id"),
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .leftJoin(agents, eq(agents.id, sessions.agentId))
    .leftJoin(
      agentAuthor,
      and(eq(agentAuthor.agentId, sessions.agentId), eq(agentAuthor.kind, "agent")),
    )
    .leftJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(
      userAuthor,
      and(eq(userAuthor.ownerId, sessions.ownerId), eq(userAuthor.kind, "user")),
    );
}

function typedDeafWindowExclusion(
  db: Pick<DirectDatabase, "select">,
  roomId: string,
  botActorId?: string,
): SQL {
  return notExists(
    db
      .select({ one: sql<number>`1` })
      .from(roomSilenceState)
      .where(
        and(
          eq(roomSilenceState.roomId, roomId),
          eq(roomSilenceState.kind, "deaf"),
          botActorId
            ? or(
                isNull(roomSilenceState.botActorId),
                eq(roomSilenceState.botActorId, botActorId),
              )
            : isNull(roomSilenceState.botActorId),
          sql`${sessionMessages.createdAt} >= ${roomSilenceState.startedAt}`,
          sql`${sessionMessages.createdAt} <= ${roomSilenceState.expiresAt}`,
        ),
      ),
  );
}

function rowsFromExecute<T>(
  result:
    | readonly Record<string, unknown>[]
    | { rows: readonly Record<string, unknown>[] },
): T[] {
  return ("rows" in result ? result.rows : result) as T[];
}

function snippetOf(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > SNIPPET_MAX
    ? `${trimmed.slice(0, SNIPPET_MAX - 1)}…`
    : trimmed;
}

/**
 * M138/M168 — Subthread context-window bounds. Moved here from
 * `server/messaging/dispatch.ts` (M168) so BOTH the (still-used) legacy
 * `buildSubthreadContextBlock` and the new transcript reader
 * (`defaultBuildTranscriptContextDeps`) import ONE copy. The parent window is
 * the ≤10 messages up to and including the anchor; the Subthread window is the
 * whole thread when small (≤40) else first-5 + last-50. The window IS the bound
 * (the assembled block's `maxLines` equals its message count); these are the
 * policy, NOT a recency budget.
 */
export const SUBTHREAD_PARENT_WINDOW = 10;
export const SUBTHREAD_SMALL_THRESHOLD = 40;
export const SUBTHREAD_HEAD = 5;
export const SUBTHREAD_TAIL = 50;

/**
 * M135 P6 — attach the count-only reaction snapshot to each hit (woken-bot
 * transcript path). Mutates + returns `hits`. No-op when there are no hits or
 * no trust-context `userId`. Shared by `roomMessagesSince` + `allRoomMessages`.
 */
async function enrichWithReactions(
  hits: RoomHistoryHit[],
  userId: string | undefined,
  agentId: string | null | undefined,
): Promise<RoomHistoryHit[]> {
  if (hits.length > 0 && userId) {
    const reactionsByMessage = await listReactionsForMessageIds({
      messageIds: hits.map((h) => h.messageId),
      ctx: { userId, agentId: agentId ?? null },
    });
    for (const hit of hits) {
      const aggs = reactionsByMessage.get(hit.messageId);
      if (aggs && aggs.length > 0) {
        hit.reactions = aggs.map((a) => ({ emoji: a.emoji, count: a.count }));
      }
    }
  }
  return hits;
}

/**
 * D279 Phase 3 — exclude messages authored during a deaf window so bots never
 * ingest them, even on a later wake. When `botActorId` is set, room-wide deaf
 * windows AND that bot's per-bot deaf windows apply. When omitted (Conductor
 * evidence search), only room-wide deaf windows are excluded.
 */
export function deafWindowExclusionSql(
  roomId: string,
  botActorId?: string,
): SQL {
  if (botActorId) {
    return sql`AND NOT EXISTS (
      SELECT 1 FROM room_silence_state rss
      WHERE rss.room_id = ${roomId}
        AND rss.kind = 'deaf'
        AND (rss.bot_actor_id IS NULL OR rss.bot_actor_id = ${botActorId})
        AND sm.created_at >= rss.started_at
        AND sm.created_at <= rss.expires_at
    )`;
  }
  return sql`AND NOT EXISTS (
    SELECT 1 FROM room_silence_state rss
    WHERE rss.room_id = ${roomId}
      AND rss.kind = 'deaf'
      AND rss.bot_actor_id IS NULL
      AND sm.created_at >= rss.started_at
      AND sm.created_at <= rss.expires_at
  )`;
}

export async function searchRoomHistory(
  db: RoomHistorySearchDb,
  args: {
    roomId: string;
    query: string;
    limit: number;
    /** When set, per-bot deaf windows are excluded in addition to room-wide. */
    botActorId?: string;
  },
): Promise<RoomHistoryHit[]> {
  // Validate before building a query. The historical public API continues to
  // express invalid input as an empty evidence set rather than a new error.
  if (!normalizeRoomMessageSearchQuery(args.query).ok) return [];
  const deafFilter = deafWindowExclusionSql(args.roomId, args.botActorId);

  // Room-scoped FTS across ALL member sessions (rooms fan out into
  // per-(room, member) sessions — scope by `sessions.room_id`, NOT owner).
  // LEFT JOIN both author shapes; pick by `role` in TS. Assistant AND tool
  // rows in an agent-backed session are agent-authored routing evidence: a tool
  // result is part of the bot turn that requested it, even though its row role
  // is not literally "assistant". Subagent transcript sessions are excluded
  // (mirrors `getRoomMessagesAcrossMemberSessions`).
  const result = await queryRoomMessageContentIndex<RawHistoryRow>(db, {
    roomId: args.roomId,
    query: args.query,
    mode: "whole",
    limit: args.limit,
    joins: sql`
      LEFT JOIN agents ag ON ag.id = s.agent_id
      LEFT JOIN actors aa ON aa.agent_id = s.agent_id AND aa.kind = 'agent'
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN actors ua ON ua.owner_id = s.owner_id AND ua.kind = 'user'
    `,
    projection: sql`
      sm.id              AS message_id,
      sm.created_at      AS ts,
      sm.role            AS role,
      sm.content         AS content,
      ag.handle          AS agent_handle,
      aa.display_name    AS agent_display_name,
      aa.id              AS agent_actor_id,
      u.handle           AS user_handle,
      ua.display_name    AS user_name,
      ua.id              AS user_actor_id
    `,
    visibilityPredicate: sql`
      AND s.thread_id NOT LIKE 'subagent:%'
      AND (sm.metadata->>'nautilo_browser_decision_observation') IS DISTINCT FROM 'true'
      AND NOT (
        sm.tool_name IN ('browser_snapshot', 'browser_screenshot')
        AND COALESCE(sm.metadata->'nautilo_tool_result'->>'toolCallId', '') LIKE 'browser-choice:%'
        AND sm.metadata->'nautilo_tool_result'->>'toolStatus' = 'success'
      )
      ${deafFilter}
    `,
  });

  return result.ok ? mapHistoryRows(result.rows) : [];
}

export async function searchRoomHistoryRelaxed(
  db: RoomHistorySearchDb,
  args: {
    roomId: string;
    query: string;
    limit: number;
    /** When set, per-bot deaf windows are excluded in addition to room-wide. */
    botActorId?: string;
  },
): Promise<RoomHistoryHit[]> {
  if (!normalizeRoomMessageSearchQuery(args.query).ok) return [];
  const normalized = normalizeSearchQuery(args.query);
  const ladder =
    normalized.ladder.length > 0 ? normalized.ladder : [args.query.trim()].filter(Boolean);

  for (const query of ladder) {
    const hits = await searchRoomHistory(db, { ...args, query });
    if (hits.length > 0) return hits;
  }
  return [];
}

function mapHistoryRows(
  rows: RawHistoryRow[],
  contentProjection: "snippet" | "full" = "snippet",
): RoomHistoryHit[] {
  const hits: RoomHistoryHit[] = [];
  for (const row of rows) {
    const isAgentAuthoredEvidence = row.role === "assistant" || row.role === "tool";
    const handle = isAgentAuthoredEvidence ? row.agent_handle : row.user_handle;
    const display = isAgentAuthoredEvidence ? row.agent_display_name : row.user_name;
    const actorId = isAgentAuthoredEvidence ? row.agent_actor_id : row.user_actor_id;
    // Rows whose author cannot be resolved (orphaned/legacy) are evidence
    // with no owner — skip rather than emit an ID-less hit.
    if (!actorId || !handle) continue;
    hits.push({
      messageId: Number(row.message_id),
      ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
      ...(row.role === "user" || row.role === "assistant" || row.role === "tool"
        ? { role: row.role }
        : {}),
      authorDisplayName: display ?? handle,
      handle,
      authorActorId: actorId,
      snippet: contentProjection === "full" ? row.content : snippetOf(row.content),
    });
  }
  return hits;
}

/**
 * M135 P6 — room messages across ALL member sessions, oldest-first, each
 * resolved to its author (display name + `@handle` + ts). Powers the composite
 * labelled-transcript block fed to a woken bot.
 *
 * `since` anchors the window: when set, ONLY messages strictly after that
 * instant are returned (the "diff since the bot last spoke" — see
 * `lastBotMessageTs`). When null, the most recent `limit` messages are
 * returned (cold start / no prior bot turn). On overflow the NEWEST `limit`
 * are kept; the caller's assembler elides oldest-first beyond its line budget.
 */
export async function roomMessagesSince(
  db: TypedRoomHistorySearchDb,
  args: {
    roomId: string;
    since: Date | null;
    limit: number;
    /** Trust context for M121 reaction snapshot (woken-bot path). */
    userId?: string;
    agentId?: string | null;
    /** D279 — bot actor for deaf-window ingestion filter. */
    botActorId?: string;
  },
): Promise<RoomHistoryHit[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(args.limit)));
  const raw = await selectHistoryRows(db)
      .where(
        and(
          eq(sessions.roomId, args.roomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          inArray(sessionMessages.role, ["user", "assistant"]),
          args.since
            ? sql`${sessionMessages.createdAt} > ${args.since.toISOString()}::timestamptz`
            : undefined,
          typedDeafWindowExclusion(db, args.roomId, args.botActorId),
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(limit);
  // Newest-first from SQL; reverse to oldest-first for transcript rendering.
  const hits = mapHistoryRows(rowsFromExecute<RawHistoryRow>(raw));
  const oldestFirst = hits.reverse();
  return enrichWithReactions(oldestFirst, args.userId, args.agentId);
}

/**
 * M168 R4 — the FULL labelled room transcript across ALL member sessions,
 * oldest→newest, with NO `since` window and NO 500 clamp (unlike
 * `roomMessagesSince`). Includes `user`/`assistant`/`tool` rows so the rebuilt
 * conversation history covers a bot's own prior tool activity as narration
 * (R9 coverage). A high `CAP` (5000) bounds pathological rooms without
 * windowing normal ones; true-unbounded history + recency/summarization is the
 * later I-ladder #9 caching concern. Applies the same deaf-window filter as
 * `roomMessagesSince` and an optional `excludeMessageId` filter (R5 — drop the
 * already-persisted triggering human row from the rebuilt history).
 */
export async function allRoomMessages(
  db: TypedRoomHistorySearchDb,
  args: {
    roomId: string;
    userId?: string;
    agentId?: string | null;
    botActorId?: string;
    excludeMessageId?: number;
  },
): Promise<RoomHistoryHit[]> {
  const CAP = 5000;
  const raw = await selectHistoryRows(db)
      .where(
        and(
          eq(sessions.roomId, args.roomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          inArray(sessionMessages.role, ["user", "assistant", "tool"]),
          sql`(${sessionMessages.metadata}->>'nautilo_browser_decision_observation') IS DISTINCT FROM 'true'`,
          sql`NOT (${sessionMessages.toolName} IN ('browser_snapshot', 'browser_screenshot') AND COALESCE(${sessionMessages.metadata}->'nautilo_tool_result'->>'toolCallId', '') LIKE 'browser-choice:%' AND ${sessionMessages.metadata}->'nautilo_tool_result'->>'toolStatus' = 'success')`,
          args.excludeMessageId != null
            ? sql`${sessionMessages.id} <> ${args.excludeMessageId}`
            : undefined,
          typedDeafWindowExclusion(db, args.roomId, args.botActorId),
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(CAP);
  // Newest-first from SQL; reverse to oldest-first for transcript rendering.
  const oldestFirst = mapHistoryRows(rowsFromExecute<RawHistoryRow>(raw), "full").reverse();
  return enrichWithReactions(oldestFirst, args.userId, args.agentId);
}

/**
 * M219 — bounded fresh-turn Room history.
 *
 * Selects the configured newest conversational boundaries after collapsing only
 * non-null user fingerprints, then retains every assistant/tool evidence row
 * from the earliest surviving boundary through the exclusive current-turn
 * bound. The SQL may rank newest-first, but callers always receive
 * `(created_at, id)` oldest-first.
 */
export async function recentBoundedRoomMessages(
  db: RoomHistorySearchDb,
  args: {
    roomId: string;
    userId?: string;
    agentId?: string | null;
    botActorId?: string;
    excludeMessageId?: number;
    conversationalLimit?: number;
  },
): Promise<RoomHistoryHit[]> {
  const conversationalLimit = Math.max(
    1,
    Math.min(
      args.conversationalLimit ?? RECENT_CONVERSATION_LIMIT_DEFAULT,
      RECENT_CONVERSATION_LIMIT_MAX,
    ),
  );
  const deafFilter = deafWindowExclusionSql(args.roomId, args.botActorId);
  const exclusiveBound =
    args.excludeMessageId != null
      ? sql`AND sm.id < ${args.excludeMessageId}`
      : sql``;
  const triggeringFingerprintFilter =
    args.excludeMessageId != null
      ? sql`AND (
          sm.role <> 'user'
          OR sm.fingerprint IS NULL
          OR sm.fingerprint IS DISTINCT FROM (
            SELECT trigger_sm.fingerprint
            FROM session_messages trigger_sm
            INNER JOIN sessions trigger_s ON trigger_s.id = trigger_sm.session_id
            WHERE trigger_sm.id = ${args.excludeMessageId}
              AND trigger_s.room_id = ${args.roomId}
            LIMIT 1
          )
        )`
      : sql``;
  const raw = await db.execute(sql`
    WITH eligible AS (
      SELECT
        sm.id AS message_id,
        sm.created_at AS ts,
        sm.role,
        sm.content,
        sm.fingerprint,
        ag.handle AS agent_handle,
        aa.display_name AS agent_display_name,
        aa.id AS agent_actor_id,
        u.handle AS user_handle,
        ua.display_name AS user_name,
        ua.id AS user_actor_id,
        CASE
          WHEN sm.role = 'user' AND sm.fingerprint IS NOT NULL
          THEN row_number() OVER (
            PARTITION BY sm.fingerprint
            ORDER BY sm.created_at ASC, sm.id ASC
          )
          ELSE 1
        END AS fingerprint_ordinal
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      LEFT JOIN agents ag ON ag.id = s.agent_id
      LEFT JOIN actors aa ON aa.agent_id = s.agent_id AND aa.kind = 'agent'
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN actors ua ON ua.owner_id = s.owner_id AND ua.kind = 'user'
      WHERE s.room_id = ${args.roomId}
        AND s.thread_id NOT LIKE 'subagent:%'
        AND sm.transcript_origin = 'main'
        AND sm.role IN ('user', 'assistant', 'tool')
        AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
        AND (sm.metadata->>'nautilo_browser_decision_observation') IS DISTINCT FROM 'true'
        AND NOT (
          sm.tool_name IN ('browser_snapshot', 'browser_screenshot')
          AND COALESCE(sm.metadata->'nautilo_tool_result'->>'toolCallId', '') LIKE 'browser-choice:%'
          AND sm.metadata->'nautilo_tool_result'->>'toolStatus' = 'success'
        )
        ${exclusiveBound}
        ${triggeringFingerprintFilter}
        ${deafFilter}
    ),
    conversational AS (
      SELECT message_id, ts
      FROM eligible
      WHERE
        (role = 'user' AND fingerprint_ordinal = 1)
        OR (role = 'assistant' AND btrim(content) <> '')
      ORDER BY ts DESC, message_id DESC
      LIMIT ${conversationalLimit}
    ),
    earliest AS (
      SELECT ts, message_id
      FROM conversational
      ORDER BY ts ASC, message_id ASC
      LIMIT 1
    )
    SELECT
      e.message_id,
      e.ts,
      e.role,
      e.content,
      e.agent_handle,
      e.agent_display_name,
      e.agent_actor_id,
      e.user_handle,
      e.user_name,
      e.user_actor_id
    FROM eligible e
    CROSS JOIN earliest first
    WHERE
      (e.ts > first.ts OR (e.ts = first.ts AND e.message_id >= first.message_id))
      AND NOT (e.role = 'user' AND e.fingerprint IS NOT NULL AND e.fingerprint_ordinal > 1)
    ORDER BY e.ts ASC, e.message_id ASC
  `);
  const hits = mapHistoryRows(rowsFromExecute<RawHistoryRow>(raw), "full");
  return enrichWithReactions(hits, args.userId, args.agentId);
}

/**
 * M135 P6 — the most recent messages across ALL member sessions of the room
 * (cold-start convenience = `roomMessagesSince(since: null)`).
 */
export async function recentRoomMessages(
  db: TypedRoomHistorySearchDb,
  args: {
    roomId: string;
    limit: number;
    userId?: string;
    agentId?: string | null;
    botActorId?: string;
  },
): Promise<RoomHistoryHit[]> {
  return roomMessagesSince(db, {
    roomId: args.roomId,
    since: null,
    limit: args.limit,
    ...(args.userId ? { userId: args.userId } : {}),
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    ...(args.botActorId ? { botActorId: args.botActorId } : {}),
  });
}

/**
 * M135 P6 — the timestamp of the bot's OWN most recent message in the room
 * (its last assistant turn across every member session), or null if the bot
 * has never spoken here. Anchors the "diff since I last spoke" context window
 * so an already-active bot, returning to a room where several humans talked in
 * parallel, sees every intervening message — not just a fixed recent slice.
 */
export async function lastBotMessageTs(
  db: TypedRoomHistorySearchDb,
  args: { roomId: string; agentId: string },
): Promise<Date | null> {
  const raw = await db
      .select({ ts: max(sessionMessages.createdAt).as("ts") })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessions.roomId, args.roomId),
          eq(sessions.agentId, args.agentId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          eq(sessionMessages.role, "assistant"),
        ),
      );
  const rows = rowsFromExecute<{ ts: string | Date | null }>(raw);
  const value = rows[0]?.ts;
  return value == null ? null : value instanceof Date ? value : new Date(value);
}

function subthreadRowsQuery(
  db: Pick<DirectDatabase, "select">,
  roomId: string,
  dir: "ASC" | "DESC",
  limit: number,
) {
  const order =
    dir === "ASC"
      ? [asc(sessionMessages.createdAt), asc(sessionMessages.id)]
      : [desc(sessionMessages.createdAt), desc(sessionMessages.id)];
  return selectHistoryRows(db)
    .where(
      and(
        eq(sessions.roomId, roomId),
        sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
        inArray(sessionMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(...order)
    .limit(limit);
}

/**
 * M138 — parent-room messages up to AND INCLUDING the anchor message,
 * oldest→newest (≤ `limit` rows; the anchor is the LAST element). A Subthread
 * is rooted at the anchor, so the anchor line is part of the seed context.
 * Returns `[]` if the anchor row is missing/deleted (graceful fallback — no
 * throw). Uses `(created_at, id)` tuple ordering so same-timestamp rows are
 * deterministic. Spec term is **Subthread** (never LangGraph "thread").
 */
export async function parentMessagesUpToAnchor(
  db: TypedRoomHistorySearchDb,
  args: {
    parentRoomId: string;
    /** `rooms.threadRootMessageId` — the anchor `session_messages.id`. */
    anchorMessageId: number;
    /** 10 (anchor + up to 9 preceding parent messages). */
    limit: number;
  },
): Promise<RoomHistoryHit[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(args.limit)));
  // Resolve the anchor's (created_at, id) within the parent room. A
  // missing/deleted anchor yields an empty parent window (graceful fallback).
  const anchorRaw = await db
      .select({
        ts: sql<Date>`${sessionMessages.createdAt}`.as("ts"),
        id: sql<number>`${sessionMessages.id}`.as("id"),
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessionMessages.id, args.anchorMessageId),
          eq(sessions.roomId, args.parentRoomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
        ),
      )
      .limit(1);
  const anchor = rowsFromExecute<{ ts: string | Date; id: number | string }>(anchorRaw)[0];
  if (!anchor) return [];
  const anchorTs = (
    anchor.ts instanceof Date ? anchor.ts : new Date(anchor.ts)
  ).toISOString();
  const anchorId = Number(anchor.id);
  const raw = await selectHistoryRows(db)
      .where(
        and(
          eq(sessions.roomId, args.parentRoomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          inArray(sessionMessages.role, ["user", "assistant"]),
          sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) <= (${anchorTs}::timestamptz, ${anchorId})`,
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(limit);
  // Newest-first from SQL; reverse to oldest-first (anchor ends the window).
  return mapHistoryRows(rowsFromExecute<RawHistoryRow>(raw), "full").reverse();
}

/**
 * M138 — Subthread messages for the windowing policy, oldest→newest. If the
 * thread is small (≤ `smallThreshold`) returns ALL messages; if long, returns
 * the first `headCount` ("initial") ++ last `tailCount` ("tail"), de-duplicated
 * on overlap, ordered oldest→newest. Returns `[]` for an empty Subthread.
 */
export async function subthreadContextWindow(
  db: TypedRoomHistorySearchDb,
  args: {
    subthreadRoomId: string;
    /** 40 — at or below this, the whole Subthread is included. */
    smallThreshold: number;
    /** 5 — oldest messages kept when the thread is long. */
    headCount: number;
    /** 50 — newest messages kept when the thread is long. */
    tailCount: number;
  },
): Promise<RoomHistoryHit[]> {
  const smallThreshold = Math.max(1, Math.trunc(args.smallThreshold));
  const headCount = Math.max(0, Math.trunc(args.headCount));
  const tailCount = Math.max(1, Math.trunc(args.tailCount));

  const countRaw = await db
      .select({ n: count().as("n") })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessions.roomId, args.subthreadRoomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          inArray(sessionMessages.role, ["user", "assistant"]),
        ),
      );
  const total = Number(rowsFromExecute<{ n: number | string }>(countRaw)[0]?.n ?? 0);
  if (total === 0) return [];

  if (total <= smallThreshold) {
    const raw = await subthreadRowsQuery(db, args.subthreadRoomId, "ASC", total);
    return mapHistoryRows(rowsFromExecute<RawHistoryRow>(raw));
  }

  // Long thread: first `headCount` (oldest) ++ last `tailCount` (newest).
  const headRaw = await subthreadRowsQuery(
    db,
    args.subthreadRoomId,
    "ASC",
    headCount,
  );
  const tailRaw = await subthreadRowsQuery(
    db,
    args.subthreadRoomId,
    "DESC",
    tailCount,
  );
  const head = mapHistoryRows(rowsFromExecute<RawHistoryRow>(headRaw));
  // Tail comes back newest-first; reverse to oldest-first before merging.
  const tail = mapHistoryRows(rowsFromExecute<RawHistoryRow>(tailRaw)).reverse();
  const seen = new Set<number>();
  const merged: RoomHistoryHit[] = [];
  for (const hit of [...head, ...tail]) {
    if (seen.has(hit.messageId)) continue;
    seen.add(hit.messageId);
    merged.push(hit);
  }
  merged.sort(
    (a, b) => a.ts.getTime() - b.ts.getTime() || a.messageId - b.messageId,
  );
  return merged;
}

/**
 * M135 P7 — id of the newest message across all member sessions of the room
 * (the turn immediately preceding a fresh inbound send). Drives
 * `messageNeedsHistory`'s "reply to old vs preceding turn" distinction.
 * Returns null for an empty room.
 */
export async function latestRoomMessageId(
  db: TypedRoomHistorySearchDb,
  roomId: string,
): Promise<number | null> {
  const raw = await db
      .select({ message_id: max(sessionMessages.id).as("message_id") })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
      .where(
        and(
          eq(sessions.roomId, roomId),
          sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
        ),
      );
  const rows = rowsFromExecute<{ message_id: number | string | null }>(raw);
  const value = rows[0]?.message_id;
  return value == null ? null : Number(value);
}
