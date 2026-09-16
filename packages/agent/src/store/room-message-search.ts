import { normalizedRoomLabelSql, sql, usersPublic, type SQL } from "@nautilo/db";
import { logicalMessageKey } from "@nautilo/types";
import {
  projectRoomHistorySelectedMessageCoordinate,
  type RoomHistorySelectedMessageCoordinate,
  type SessionMessage,
} from "./session-store";
import { sanitizeSerializedTranscriptToolCalls } from "./transcript-tool-arguments";
import { withAgentTrustContext, rowsFromExecute as rowsFromTrustExecute } from "./trust-agent-db";

const ROOM_MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
const ROOM_MESSAGE_SEARCH_MAX_LIMIT = 50;
const ROOM_MESSAGE_AROUND_DEFAULT_LIMIT = 100;
const ROOM_MESSAGE_AROUND_MAX_LIMIT = 100;
const ROOM_MESSAGE_SNIPPET_MAX = 280;

export interface RoomMessageCursor {
  createdAt: Date;
  messageId: number;
}

export interface RoomMessageSearchHit {
  messageId: number;
  createdAt: Date;
  role: string;
  snippet: string;
  toolName: string | null;
  sourceUserId: string;
  authorAgentId: string | null;
  authorActorId: string | null;
  authorDisplayName: string | null;
  authorHandle: string | null;
}

export interface RoomMessageSearchPage {
  hits: RoomMessageSearchHit[];
  asOf: RoomMessageCursor | null;
  nextOlderCursor: RoomMessageCursor | null;
  hasMoreOlder: boolean;
}

/**
 * Store-side form of the D470 Chats search response. Dates and numeric IDs
 * stay native here; the HTTP route owns wire serialization just as it does
 * for D430's Room-scoped reader.
 */
export interface ChatSearchConversationHit {
  room: {
    id: string;
    label: string;
    type: string;
    graphThreadId: string;
    createdAt: Date;
    memberCount: number;
    kind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
    parentRoomId: string | null;
    threadRootMessageId: number | null;
    roster: Array<{
      actorId: string;
      kind: "user" | "agent";
      displayName: string;
      handle: string | null;
      userId?: string;
      agentId?: string;
    }>;
  };
  matchedBy: "label" | "participant";
}

export interface ChatSearchMessageHit extends RoomMessageSearchHit {
  roomId: string;
  roomLabel: string;
  roomKind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
  parentRoomId?: string;
  parentRoomLabel?: string;
}

export interface ChatSearchPage {
  conversations: ChatSearchConversationHit[];
  conversationsTruncated: boolean;
  messages: ChatSearchMessageHit[];
  messageAsOf: RoomMessageCursor | null;
  nextOlderMessageCursor: RoomMessageCursor | null;
  hasMoreOlderMessages: boolean;
}

export interface RoomMessagesAroundPage {
  messages: SessionMessage[];
  target: RoomMessageCursor;
  /** The paired assistant invocation is best-effort; exact tool-call IDs are not persisted. */
  includedToolCallCompanion: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}

interface RawHumanRoomMessageRow extends Record<string, unknown> {
  message_id: number | string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_name: string | null;
  created_at: Date | string;
  edited_at: Date | string | null;
  edit_revision: number;
  reply_to_message_id: number | null;
  source_user_id: string;
  session_agent_id: string | null;
  fingerprint: string | null;
  reply_count: number;
  last_reply_at: Date | string | null;
  summary_revision: number;
  agent_actor_id: string | null;
  agent_display_name: string | null;
  agent_handle: string | null;
  user_actor_id: string | null;
  user_display_name: string | null;
  user_handle: string | null;
}

function clampRoomSearchLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(ROOM_MESSAGE_SEARCH_MAX_LIMIT, Math.trunc(limit ?? ROOM_MESSAGE_SEARCH_DEFAULT_LIMIT)));
}

function clampRoomAroundLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(ROOM_MESSAGE_AROUND_MAX_LIMIT, Math.trunc(limit ?? ROOM_MESSAGE_AROUND_DEFAULT_LIMIT)));
}

function humanRoomCursorSql(
  columnPrefix: "" | "d.",
  cursor: RoomMessageCursor,
  comparison: "before" | "atOrBefore",
) {
  const op = comparison === "before" ? "<" : "<=";
  const ts = cursor.createdAt.toISOString();
  return sql`AND (${sql.raw(`${columnPrefix}created_at`)} < ${ts}::timestamptz OR (${sql.raw(`${columnPrefix}created_at`)} = ${ts}::timestamptz AND ${sql.raw(`${columnPrefix}message_id`)} ${sql.raw(op)} ${cursor.messageId}))`;
}

/**
 * Shared Room transcript scope used by ordinary history, D430 search, and
 * around-message reads. The `dedupe_rank` reproduces ordinary history's
 * newest-first JS dedupe before applying pagination bounds, so continuation
 * facts describe visible rows rather than raw fan-out copies.
 *
 * A NULL `tool_name` remains visible: legacy rows cannot prove whether they
 * were historical `react` tool outputs. Only known `tool_name = 'react'` rows
 * are excluded.
 */
async function queryVisibleHumanRoomMessages(args: {
  ownerId: string;
  roomId: string;
  /** Indexed candidate predicate, joined only after global canonical dedupe. */
  candidatePredicate?: ReturnType<typeof sql>;
  /** Predicate over the deduped visible rows (`d`). */
  matchPredicate?: ReturnType<typeof sql>;
  boundaryPredicate?: ReturnType<typeof sql>;
  limit: number;
  order?: "newest" | "oldest";
}): Promise<RawHumanRoomMessageRow[]> {
  return withAgentTrustContext({ userId: args.ownerId }, async (tx) => {
    const matchPredicate = args.matchPredicate ?? sql``;
    const candidatePredicate = args.candidatePredicate ?? sql``;
    const boundaryPredicate = args.boundaryPredicate ?? sql``;
    const candidateCte = args.candidatePredicate
      ? sql`search_candidates AS (
          SELECT sm.id AS message_id
          FROM session_messages sm
          INNER JOIN sessions s ON s.id = sm.session_id
          INNER JOIN room_members rm ON rm.room_id = s.room_id
          INNER JOIN actors member_actor ON member_actor.id = rm.actor_id
          WHERE s.room_id = ${args.roomId}
            AND EXISTS (
              SELECT 1
              FROM room_members viewer_rm
              INNER JOIN actors viewer_actor ON viewer_actor.id = viewer_rm.actor_id
              WHERE viewer_rm.room_id = s.room_id
                AND viewer_actor.kind = 'user'
                AND viewer_actor.owner_id = ${args.ownerId}
            )
            AND member_actor.kind = 'user'
            AND member_actor.owner_id = s.owner_id
            AND s.thread_id NOT LIKE 'subagent:%'
            AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
            AND sm.tool_name IS DISTINCT FROM 'react'
            ${candidatePredicate}
        ),`
      : sql``;
    const candidateJoin = args.candidatePredicate
      ? sql`INNER JOIN search_candidates candidate ON candidate.message_id = d.message_id`
      : sql``;
    const order = args.order === "oldest" ? sql`ASC` : sql`DESC`;
    const result = await tx.execute<RawHumanRoomMessageRow>(sql`
      WITH ${candidateCte} scoped AS (
        SELECT
          sm.id AS message_id,
          sm.session_id,
          sm.role,
          sm.content,
          sm.content_search,
          sm.tool_calls,
          sm.tool_name,
          sm.created_at,
          sm.edited_at,
          sm.edit_revision,
          sm.reply_to_message_id,
          s.owner_id AS source_user_id,
          s.agent_id AS session_agent_id,
          sm.fingerprint,
          sm.reply_count,
          sm.last_reply_at,
          sm.summary_revision,
          aa.id AS agent_actor_id,
          aa.display_name AS agent_display_name,
          NULL::text AS agent_handle,
          ua.id AS user_actor_id,
          ua.display_name AS user_display_name,
          NULL::text AS user_handle,
          row_number() OVER (
            PARTITION BY CASE
              WHEN sm.role = 'user' AND sm.fingerprint IS NOT NULL THEN 'user:' || sm.fingerprint
              WHEN sm.role = 'system' THEN 'system:' || sm.content || chr(31) || COALESCE(sm.tool_calls, '') || chr(31) || sm.created_at::text
              ELSE 'message:' || sm.id::text
            END
            ORDER BY sm.created_at DESC, sm.id DESC
          ) AS dedupe_rank
        FROM session_messages sm
        INNER JOIN sessions s ON s.id = sm.session_id
        INNER JOIN room_members rm ON rm.room_id = s.room_id
        INNER JOIN actors member_actor ON member_actor.id = rm.actor_id
        LEFT JOIN actors aa ON aa.agent_id = s.agent_id AND aa.kind = 'agent'
        LEFT JOIN actors ua ON ua.owner_id = s.owner_id AND ua.kind = 'user'
        WHERE s.room_id = ${args.roomId}
          AND EXISTS (
            SELECT 1
            FROM room_members viewer_rm
            INNER JOIN actors viewer_actor ON viewer_actor.id = viewer_rm.actor_id
            WHERE viewer_rm.room_id = s.room_id
              AND viewer_actor.kind = 'user'
              AND viewer_actor.owner_id = ${args.ownerId}
          )
          AND member_actor.kind = 'user'
          AND member_actor.owner_id = s.owner_id
          AND s.thread_id NOT LIKE 'subagent:%'
          AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
          AND sm.tool_name IS DISTINCT FROM 'react'
      )
      SELECT d.* FROM scoped d
      ${candidateJoin}
      WHERE d.dedupe_rank = 1
        ${matchPredicate}
        ${boundaryPredicate}
      ORDER BY d.created_at ${order}, d.message_id ${order}
      LIMIT ${args.limit}
    `);
    return rowsFromTrustExecute(result);
  });
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function cursorOf(row: RawHumanRoomMessageRow): RoomMessageCursor {
  return { createdAt: dateOf(row.created_at), messageId: Number(row.message_id) };
}

function escapedSnippet(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  let out = "";
  for (const char of text) {
    const escaped = char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : char === "'" ? "&#39;" : char;
    if (out.length + escaped.length >= ROOM_MESSAGE_SNIPPET_MAX) return `${out}…`;
    out += escaped;
  }
  return out;
}

function toRoomSearchHit(row: RawHumanRoomMessageRow): RoomMessageSearchHit {
  const agentAuthored = row.role === "assistant" || row.role === "tool";
  return {
    messageId: Number(row.message_id),
    createdAt: dateOf(row.created_at),
    role: row.role,
    snippet: escapedSnippet(row.content),
    toolName: row.tool_name,
    sourceUserId: row.source_user_id,
    authorAgentId: row.session_agent_id,
    authorActorId: agentAuthored ? row.agent_actor_id : row.user_actor_id,
    authorDisplayName: agentAuthored ? row.agent_display_name : row.user_display_name,
    authorHandle: agentAuthored ? row.agent_handle : row.user_handle,
  };
}

function toSessionMessage(row: RawHumanRoomMessageRow): SessionMessage {
  const createdAt = dateOf(row.created_at);
  const lastReplyAt = row.last_reply_at ? dateOf(row.last_reply_at) : null;
  return {
    id: String(row.message_id),
    logicalMessageKey: logicalMessageKey({
      id: row.message_id,
      role: row.role,
      fingerprint: row.fingerprint,
    }),
    role: row.role,
    content: row.content,
    toolCalls: sanitizeSerializedTranscriptToolCalls(row.tool_calls),
    toolName: row.tool_name,
    createdAt,
    editedAt: row.edited_at ? dateOf(row.edited_at) : null,
    editRevision: row.edit_revision,
    replyToMessageId: row.reply_to_message_id,
    replyCount: row.reply_count,
    lastReplyAt,
    summaryRevision: row.summary_revision,
    sourceUserId: row.source_user_id,
    ...(row.role === "assistant" || row.role === "tool"
      ? row.session_agent_id ? { authorAgentId: row.session_agent_id } : {}
      : {}),
    fingerprint: row.fingerprint,
  };
}

/** D430 — cursor-paged search of the canonical Human-visible Room corpus. */
export async function searchRoomMessages(args: {
  ownerId: string;
  roomId: string;
  query: string;
  mode: RoomMessageSearchMode;
  ignoreCase?: boolean;
  limit?: number;
  cursor?: RoomMessageCursor | null;
  asOf?: RoomMessageCursor | null;
}): Promise<RoomMessageSearchPage | { validationError: RoomMessageSearchValidationError }> {
  const normalized = normalizeRoomMessageSearchQuery(args.query);
  if (!normalized.ok) return { validationError: normalized.error };

  const boundaries = [
    args.asOf ? humanRoomCursorSql("d.", args.asOf, "atOrBefore") : sql``,
    args.cursor ? humanRoomCursorSql("d.", args.cursor, "before") : sql``,
  ];
  const limit = clampRoomSearchLimit(args.limit);
  const rows = await queryVisibleHumanRoomMessages({
    ownerId: args.ownerId,
    roomId: args.roomId,
    candidatePredicate: sql`AND sm.content_search @@ ${roomMessageSearchTsquery(args.mode, normalized.query)}
      ${args.ignoreCase === false ? roomMessageCasePredicate(args.mode, normalized.query) : sql``}`,
    boundaryPredicate: sql`${boundaries[0]} ${boundaries[1]}`,
    limit: limit + 1,
  });
  const pageRows = rows.slice(0, limit);
  return {
    hits: pageRows.map(toRoomSearchHit),
    asOf: args.asOf ?? (pageRows[0] ? cursorOf(pageRows[0]) : null),
    nextOlderCursor: pageRows.length > 0 ? cursorOf(pageRows[pageRows.length - 1]!) : null,
    hasMoreOlder: rows.length > limit,
  };
}

type RawChatSearchRow = Record<string, unknown> & {
  conversations: unknown;
  messages: unknown;
  conversation_count: number | string;
};

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function chatSearchCursorOf(hit: ChatSearchMessageHit): RoomMessageCursor {
  return { createdAt: hit.createdAt, messageId: hit.messageId };
}

function parseChatSearchConversations(value: unknown): ChatSearchConversationHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChatSearchConversationHit[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const roomValue = item["room"];
    if (!roomValue || typeof roomValue !== "object") return [];
    const room = roomValue as Record<string, unknown>;
    const roster = Array.isArray(room["roster"])
      ? room["roster"].flatMap((member): ChatSearchConversationHit["room"]["roster"] => {
          if (!member || typeof member !== "object") return [];
          const value = member as Record<string, unknown>;
          const kind = value["kind"] === "agent" ? "agent" : value["kind"] === "user" ? "user" : null;
          const actorId = stringOf(value["actorId"]);
          const displayName = stringOf(value["displayName"]);
          if (!kind || !actorId || !displayName) return [];
          return [{
            actorId,
            kind,
            displayName,
            handle: nullableStringOf(value["handle"]),
            ...(kind === "user" && nullableStringOf(value["userId"]) ? { userId: nullableStringOf(value["userId"])! } : {}),
            ...(kind === "agent" && nullableStringOf(value["agentId"]) ? { agentId: nullableStringOf(value["agentId"])! } : {}),
          }];
        })
      : [];
    const kind = room["kind"];
    if (
      typeof kind !== "string"
      || !["private", "group", "multi_agent", "subthread", "open", "task", "access"].includes(kind)
    ) return [];
    const id = stringOf(room["id"]);
    const label = stringOf(room["label"]);
    const type = stringOf(room["type"]);
    const graphThreadId = stringOf(room["graphThreadId"]);
    const createdAt = new Date(stringOf(room["createdAt"]));
    if (!id || !label || !type || !graphThreadId || !Number.isFinite(createdAt.getTime())) return [];
    return [{
      room: {
        id,
        label,
        type,
        graphThreadId,
        createdAt,
        memberCount: numberOf(room["memberCount"]),
        kind: kind as ChatSearchConversationHit["room"]["kind"],
        parentRoomId: nullableStringOf(room["parentRoomId"]),
        threadRootMessageId: room["threadRootMessageId"] == null ? null : numberOf(room["threadRootMessageId"]),
        roster,
      },
      matchedBy: item["matchedBy"] === "label" ? "label" : "participant",
    }];
  });
}

function parseChatSearchMessages(value: unknown): ChatSearchMessageHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChatSearchMessageHit[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const roomKind = row["roomKind"];
    if (
      typeof roomKind !== "string"
      || !["private", "group", "multi_agent", "subthread", "open", "task", "access"].includes(roomKind)
    ) return [];
    const createdAt = new Date(stringOf(row["createdAt"]));
    const messageId = numberOf(row["messageId"]);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isSafeInteger(messageId) || messageId <= 0) return [];
    const roomId = stringOf(row["roomId"]);
    const roomLabel = stringOf(row["roomLabel"]);
    const role = stringOf(row["role"]);
    const snippet = stringOf(row["snippet"]);
    const sourceUserId = stringOf(row["sourceUserId"]);
    if (!roomId || !roomLabel || !role || !snippet || !sourceUserId) return [];
    return [{
      messageId,
      createdAt,
      role,
      snippet,
      toolName: nullableStringOf(row["toolName"]),
      sourceUserId,
      authorAgentId: nullableStringOf(row["authorAgentId"]),
      authorActorId: nullableStringOf(row["authorActorId"]),
      authorDisplayName: nullableStringOf(row["authorDisplayName"]),
      authorHandle: nullableStringOf(row["authorHandle"]),
      roomId,
      roomLabel,
      roomKind: roomKind as ChatSearchMessageHit["roomKind"],
      ...(nullableStringOf(row["parentRoomId"]) ? { parentRoomId: nullableStringOf(row["parentRoomId"])! } : {}),
      ...(nullableStringOf(row["parentRoomLabel"]) ? { parentRoomLabel: nullableStringOf(row["parentRoomLabel"])! } : {}),
    }];
  });
}

/**
 * D470 — one set-wise, exact-membership Chats query.
 *
 * `authorized_room_ids` is MATERIALIZED once from the authenticated Human
 * actor (and cross-checked to ownerId), then feeds both result branches. The
 * message branch intentionally mirrors D430's candidate-before-dedupe shape:
 * a newer nonmatching duplicate suppresses an older matching duplicate.
 */
export async function searchChats(args: {
  ownerId: string;
  viewerActorId: string;
  query: string;
  mode: RoomMessageSearchMode;
  archiveScope?: "active" | "archived" | "all";
  ignoreCase?: boolean;
  limit?: number;
  cursor?: RoomMessageCursor | null;
  asOf?: RoomMessageCursor | null;
}): Promise<ChatSearchPage | { validationError: RoomMessageSearchValidationError }> {
  const normalized = normalizeRoomMessageSearchQuery(args.query);
  if (!normalized.ok) return { validationError: normalized.error };
  if (!args.ownerId || !args.viewerActorId) {
    return { validationError: { code: "empty", message: "Authenticated viewer is required." } };
  }

  const limit = clampRoomSearchLimit(args.limit);
  const queryText = normalized.query.wholeText;
  const normalizedLabel = normalizedRoomLabelSql(sql`${queryText}`);
  const messageBoundaries = [
    args.asOf ? humanRoomCursorSql("d.", args.asOf, "atOrBefore") : sql``,
    args.cursor ? humanRoomCursorSql("d.", args.cursor, "before") : sql``,
  ];
  const tsquery = roomMessageSearchTsquery(args.mode, normalized.query);
  const casePredicate = args.ignoreCase === false
    ? roomMessageCasePredicate(args.mode, normalized.query)
    : sql``;
  const archivePredicate = args.archiveScope === "archived"
    ? sql`r.archived_at IS NOT NULL`
    : args.archiveScope === "all"
      ? sql`TRUE`
      : sql`r.archived_at IS NULL`;

  // `users_public` is the deliberately sanitized user identity projection
  // granted to nautilo_agent, so the complete read remains in D430's normal
  // RLS-protected agent trust context.
  const rows = await withAgentTrustContext({ userId: args.ownerId }, async (tx) => {
    const result = await tx.execute<RawChatSearchRow>(sql`
      WITH authorized_room_ids AS MATERIALIZED (
        SELECT viewer_member.room_id
        FROM room_members viewer_member
        INNER JOIN actors viewer_actor ON viewer_actor.id = viewer_member.actor_id
        WHERE viewer_member.actor_id = ${args.viewerActorId}
          AND viewer_actor.kind = 'user'
          AND viewer_actor.owner_id = ${args.ownerId}
      ),
      conversation_candidates AS (
        SELECT
          r.id,
          r.label,
          r.type,
          r.graph_thread_id,
          r.created_at,
          r.kind,
          r.parent_room_id,
          r.thread_root_message_id,
          r.normalized_label LIKE '%' || ${normalizedLabel} || '%' AS label_matches,
          count(roster_member.actor_id)::int AS member_count,
          COALESCE(jsonb_agg(
            jsonb_build_object(
              'actorId', roster_actor.id,
              'kind', roster_actor.kind,
              'displayName', roster_actor.display_name,
              'handle', CASE WHEN roster_actor.kind = 'agent' THEN roster_agent.handle ELSE roster_user.handle END,
              'userId', CASE WHEN roster_actor.kind = 'user' THEN roster_actor.owner_id ELSE NULL END,
              'agentId', CASE WHEN roster_actor.kind = 'agent' THEN roster_actor.agent_id ELSE NULL END
            ) ORDER BY roster_actor.id
          ) FILTER (WHERE roster_member.actor_id IS NOT NULL), '[]'::jsonb) AS roster
        FROM authorized_room_ids authorized
        INNER JOIN rooms r ON r.id = authorized.room_id
        LEFT JOIN room_members roster_member ON roster_member.room_id = r.id
        LEFT JOIN actors roster_actor ON roster_actor.id = roster_member.actor_id
        LEFT JOIN ${usersPublic} roster_user ON roster_user.id = roster_actor.owner_id
        LEFT JOIN agents roster_agent ON roster_agent.id = roster_actor.agent_id
        WHERE ${archivePredicate}
          AND r.kind NOT IN ('task', 'access', 'subthread')
        GROUP BY r.id, r.label, r.type, r.graph_thread_id, r.created_at, r.kind,
          r.parent_room_id, r.thread_root_message_id, r.normalized_label
        HAVING r.normalized_label LIKE '%' || ${normalizedLabel} || '%'
          OR bool_or(
            lower(roster_actor.display_name) LIKE '%' || lower(${queryText}) || '%'
            OR lower(CASE WHEN roster_actor.kind = 'agent' THEN roster_agent.handle ELSE roster_user.handle END)
              LIKE '%' || lower(${queryText}) || '%'
          )
        ORDER BY r.label ASC, r.id ASC
        LIMIT 21
      ),
      message_candidates AS MATERIALIZED (
        SELECT sm.id AS message_id
        FROM session_messages sm
        INNER JOIN sessions s ON s.id = sm.session_id
        INNER JOIN authorized_room_ids authorized ON authorized.room_id = s.room_id
        INNER JOIN rooms r ON r.id = s.room_id
        INNER JOIN room_members source_member ON source_member.room_id = s.room_id
        INNER JOIN actors source_actor ON source_actor.id = source_member.actor_id
        WHERE ${archivePredicate}
          AND r.kind NOT IN ('task', 'access')
          AND source_actor.kind = 'user'
          AND source_actor.owner_id = s.owner_id
          AND s.thread_id NOT LIKE 'subagent:%'
          AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
          AND sm.tool_name IS DISTINCT FROM 'react'
          AND sm.content_search @@ ${tsquery}
          ${casePredicate}
      ),
      scoped_messages AS (
        SELECT
          sm.id AS message_id,
          s.room_id,
          r.label AS room_label,
          r.kind AS room_kind,
          parent.id AS parent_room_id,
          parent.label AS parent_room_label,
          sm.role,
          sm.content,
          sm.tool_name,
          sm.created_at,
          s.owner_id AS source_user_id,
          s.agent_id AS session_agent_id,
          sm.fingerprint,
          agent_actor.id AS agent_actor_id,
          agent_actor.display_name AS agent_display_name,
          NULL::text AS agent_handle,
          user_actor.id AS user_actor_id,
          user_actor.display_name AS user_display_name,
          NULL::text AS user_handle,
          row_number() OVER (
            PARTITION BY r.id, CASE
              WHEN sm.role = 'user' AND sm.fingerprint IS NOT NULL THEN 'user:' || sm.fingerprint
              WHEN sm.role = 'system' THEN 'system:' || sm.content || chr(31) || COALESCE(sm.tool_calls, '') || chr(31) || sm.created_at::text
              ELSE 'message:' || sm.id::text
            END
            ORDER BY sm.created_at DESC, sm.id DESC
          ) AS dedupe_rank
        FROM session_messages sm
        INNER JOIN sessions s ON s.id = sm.session_id
        INNER JOIN authorized_room_ids authorized ON authorized.room_id = s.room_id
        INNER JOIN rooms r ON r.id = s.room_id
        INNER JOIN room_members source_member ON source_member.room_id = s.room_id
        INNER JOIN actors source_actor ON source_actor.id = source_member.actor_id
        LEFT JOIN actors agent_actor ON agent_actor.agent_id = s.agent_id AND agent_actor.kind = 'agent'
        LEFT JOIN actors user_actor ON user_actor.owner_id = s.owner_id AND user_actor.kind = 'user'
        LEFT JOIN authorized_room_ids parent_authorized ON parent_authorized.room_id = r.parent_room_id
        LEFT JOIN rooms parent ON parent.id = parent_authorized.room_id
          AND parent.archived_at IS NULL
          AND parent.kind NOT IN ('task', 'access')
        WHERE ${archivePredicate}
          AND r.kind NOT IN ('task', 'access')
          AND source_actor.kind = 'user'
          AND source_actor.owner_id = s.owner_id
          AND s.thread_id NOT LIKE 'subagent:%'
          AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task' AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
          AND sm.tool_name IS DISTINCT FROM 'react'
      ),
      message_probe AS (
        SELECT d.*
        FROM scoped_messages d
        INNER JOIN message_candidates candidate ON candidate.message_id = d.message_id
        WHERE d.dedupe_rank = 1
          ${messageBoundaries[0]}
          ${messageBoundaries[1]}
        ORDER BY d.created_at DESC, d.message_id DESC
        LIMIT ${limit + 1}
      )
      SELECT
        (SELECT count(*) FROM conversation_candidates) AS conversation_count,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'room', jsonb_build_object(
              'id', id,
              'label', label,
              'type', type,
              'graphThreadId', graph_thread_id,
              'createdAt', created_at,
              'memberCount', member_count,
              'kind', kind,
              'parentRoomId', parent_room_id,
              'threadRootMessageId', thread_root_message_id,
              'roster', roster
            ),
            'matchedBy', CASE WHEN label_matches THEN 'label' ELSE 'participant' END
          ) ORDER BY label ASC, id ASC)
          FROM (SELECT * FROM conversation_candidates ORDER BY label ASC, id ASC LIMIT 20) conversation_page
        ), '[]'::jsonb) AS conversations,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'messageId', message_id,
            'createdAt', created_at,
            'role', role,
            'snippet', content,
            'toolName', tool_name,
            'sourceUserId', source_user_id,
            'authorAgentId', session_agent_id,
            'authorActorId', CASE WHEN role IN ('assistant', 'tool') THEN agent_actor_id ELSE user_actor_id END,
            'authorDisplayName', CASE WHEN role IN ('assistant', 'tool') THEN agent_display_name ELSE user_display_name END,
            'authorHandle', CASE WHEN role IN ('assistant', 'tool') THEN agent_handle ELSE user_handle END,
            'roomId', room_id,
            'roomLabel', room_label,
            'roomKind', room_kind,
            'parentRoomId', parent_room_id,
            'parentRoomLabel', parent_room_label
          ) ORDER BY created_at DESC, message_id DESC)
          FROM message_probe
        ), '[]'::jsonb) AS messages
    `);
    return rowsFromTrustExecute(result);
  });

  const row = rows[0];
  const conversations = parseChatSearchConversations(row?.conversations).slice(0, 20);
  const messageProbe = parseChatSearchMessages(row?.messages);
  const messages = messageProbe.slice(0, limit).map((hit) => ({
    ...hit,
    snippet: escapedSnippet(hit.snippet),
  }));
  return {
    conversations,
    conversationsTruncated: numberOf(row?.conversation_count) > 20,
    messages,
    messageAsOf: args.asOf ?? (messages[0] ? chatSearchCursorOf(messages[0]) : null),
    nextOlderMessageCursor: messages.length > 0 ? chatSearchCursorOf(messages[messages.length - 1]!) : null,
    hasMoreOlderMessages: messageProbe.length > limit,
  };
}

/** D430 — bounded chronological Human transcript window around one exact row. */
export async function getRoomMessagesAround(args: {
  ownerId: string;
  roomId: string;
  messageId: number;
  limit?: number;
}): Promise<(RoomMessagesAroundPage & Readonly<{
  selectedCoordinates: readonly RoomHistorySelectedMessageCoordinate[];
}>) | null> {
  const targetRows = await queryVisibleHumanRoomMessages({
    ownerId: args.ownerId,
    roomId: args.roomId,
    matchPredicate: sql`AND d.message_id = ${args.messageId}`,
    limit: 1,
  });
  const target = targetRows[0];
  if (!target) return null;

  const limit = clampRoomAroundLimit(args.limit);
  const targetCursor = cursorOf(target);
  let companion: RawHumanRoomMessageRow | undefined;
  if (target.role === "tool") {
    const companionRows = await queryVisibleHumanRoomMessages({
      ownerId: args.ownerId,
      roomId: args.roomId,
      matchPredicate: sql`AND d.session_id = ${target.session_id}
        AND d.role = 'assistant'
        AND d.tool_calls IS NOT NULL
        AND btrim(d.tool_calls) <> ''
        AND (d.created_at < ${targetCursor.createdAt.toISOString()}::timestamptz OR (d.created_at = ${targetCursor.createdAt.toISOString()}::timestamptz AND d.message_id < ${targetCursor.messageId}))`,
      limit: 1,
    });
    companion = companionRows[0];
  }

  const companionReserve = companion ? 1 : 0;
  const surrounding = Math.max(0, limit - 1 - companionReserve);
  const olderLimit = Math.floor(surrounding / 2);
  const newerLimit = surrounding - olderLimit;
  const [olderRows, newerRows] = await Promise.all([
    queryVisibleHumanRoomMessages({
      ownerId: args.ownerId,
      roomId: args.roomId,
      boundaryPredicate: humanRoomCursorSql("d.", targetCursor, "before"),
      limit: olderLimit + 1,
    }),
    queryVisibleHumanRoomMessages({
      ownerId: args.ownerId,
      roomId: args.roomId,
      boundaryPredicate: sql`AND (d.created_at > ${targetCursor.createdAt.toISOString()}::timestamptz OR (d.created_at = ${targetCursor.createdAt.toISOString()}::timestamptz AND d.message_id > ${targetCursor.messageId}))`,
      limit: newerLimit + 1,
      order: "oldest",
    }),
  ]);
  const selected = new Map<number, RawHumanRoomMessageRow>();
  for (const row of olderRows.slice(0, olderLimit)) selected.set(Number(row.message_id), row);
  selected.set(Number(target.message_id), target);
  for (const row of newerRows.slice(0, newerLimit)) selected.set(Number(row.message_id), row);
  if (companion) selected.set(Number(companion.message_id), companion);
  const chronological = [...selected.values()]
    .sort((a, b) => dateOf(a.created_at).getTime() - dateOf(b.created_at).getTime() || Number(a.message_id) - Number(b.message_id))
    .slice(-limit);
  const first = chronological[0];
  const last = chronological[chronological.length - 1];
  const [olderProbe, newerProbe] = first && last
    ? await Promise.all([
        queryVisibleHumanRoomMessages({
          ownerId: args.ownerId,
          roomId: args.roomId,
          boundaryPredicate: humanRoomCursorSql("d.", cursorOf(first), "before"),
          limit: 1,
        }),
        queryVisibleHumanRoomMessages({
          ownerId: args.ownerId,
          roomId: args.roomId,
          boundaryPredicate: sql`AND (d.created_at > ${cursorOf(last).createdAt.toISOString()}::timestamptz OR (d.created_at = ${cursorOf(last).createdAt.toISOString()}::timestamptz AND d.message_id > ${cursorOf(last).messageId}))`,
          limit: 1,
        }),
      ])
    : [[], []];
  return {
    messages: chronological.map(toSessionMessage),
    selectedCoordinates: chronological.map((row) =>
      projectRoomHistorySelectedMessageCoordinate({
        id: Number(row.message_id),
        sessionId: String(row.session_id),
        editRevision: Number(row.edit_revision ?? 0),
        role: String(row.role),
        fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
      })
    ),
    target: targetCursor,
    includedToolCallCompanion: Boolean(companion && chronological.some((row) => Number(row.message_id) === Number(companion.message_id))),
    hasOlder: olderProbe.length > 0,
    hasNewer: newerProbe.length > 0,
  };
}


/** Search modes supported by the indexed `session_messages.content_search` corpus. */
export type RoomMessageSearchMode = "whole" | "prefix";

/** Input limits keep a request from creating an unbounded tsquery. */
export const ROOM_MESSAGE_SEARCH_MAX_QUERY_CHARS = 256;
export const ROOM_MESSAGE_SEARCH_MAX_TERMS = 16;
export const ROOM_MESSAGE_SEARCH_LIMIT_MAX = 50;

export type RoomMessageSearchValidationError =
  | { code: "empty"; message: string }
  | { code: "too_long"; message: string }
  | { code: "too_many_terms"; message: string };

export interface NormalizedRoomMessageSearchQuery {
  /** Lower-cased English-token candidates, in input order. */
  terms: readonly string[];
  /** Original-case lexical terms used only for the optional residual filter. */
  caseTerms: readonly string[];
  /** Trimmed original text, preserved for whole-token `plainto_tsquery` behavior. */
  wholeText: string;
  /** A safe single path fragment for indexed prefix matching, when present. */
  pathPrefix: string | null;
}

export type NormalizeRoomMessageSearchQueryResult =
  | { ok: true; query: NormalizedRoomMessageSearchQuery }
  | { ok: false; error: RoomMessageSearchValidationError };

/**
 * Turns untrusted text into bounded, operator-free English token candidates.
 *
 * PostgreSQL's English text-search configuration applies stemming when it
 * receives these terms. Prefix mode intentionally keeps the lexical form so
 * `launch` becomes `launch:*` rather than accepting arbitrary tsquery syntax.
 */
export function normalizeRoomMessageSearchQuery(
  raw: string,
): NormalizeRoomMessageSearchQueryResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "empty", message: "Enter a search term." } };
  }
  if (trimmed.length > ROOM_MESSAGE_SEARCH_MAX_QUERY_CHARS) {
    return {
      ok: false,
      error: {
        code: "too_long",
        message: `Search queries must be at most ${ROOM_MESSAGE_SEARCH_MAX_QUERY_CHARS} characters.`,
      },
    };
  }

  // Keep Unicode lexemes intact for PostgreSQL's Unicode-capable English FTS,
  // while retaining only letters and digits so punctuation and tsquery
  // operators can never become part of the query syntax.
  const caseTerms = trimmed.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = caseTerms.map((term) => term.toLocaleLowerCase());
  const normalizedText = trimmed.normalize("NFKC");
  const pathPrefix = normalizedText.includes("/") &&
    /^[\p{L}\p{N}._~/-]+$/u.test(normalizedText)
    ? normalizedText.toLocaleLowerCase()
    : null;

  if (terms.length === 0) {
    return {
      ok: false,
      error: { code: "empty", message: "Enter a search term containing letters or numbers." },
    };
  }
  if (terms.length > ROOM_MESSAGE_SEARCH_MAX_TERMS) {
    return {
      ok: false,
      error: {
        code: "too_many_terms",
        message: `Search queries may contain at most ${ROOM_MESSAGE_SEARCH_MAX_TERMS} terms.`,
      },
    };
  }

  return { ok: true, query: { terms, caseTerms, wholeText: trimmed, pathPrefix } };
}

function escapePostgresRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Indexed FTS remains the candidate gate; this is only a case-sensitive residual. */
export function roomMessageCasePredicate(
  mode: RoomMessageSearchMode,
  query: NormalizedRoomMessageSearchQuery,
): SQL {
  const predicates = query.caseTerms.map((term) => {
    const escaped = escapePostgresRegex(term);
    const pattern = mode === "whole"
      ? `(^|[^[:alnum:]_])${escaped}($|[^[:alnum:]_])`
      : `(^|[^[:alnum:]_])${escaped}`;
    return sql`sm.content ~ ${pattern}`;
  });
  return predicates.length > 0 ? sql`AND ${sql.join(predicates, sql` AND `)}` : sql``;
}

/**
 * Builds the right side of `content_search @@ ...` without interpolating
 * untrusted text into SQL syntax. Whole mode deliberately keeps the historic
 * `plainto_tsquery('english', ...)` behavior over the original trimmed text;
 * prefix mode passes one safe, explicitly ANDed tsquery string as a SQL
 * parameter.
 */
export function roomMessageSearchTsquery(
  mode: RoomMessageSearchMode,
  query: NormalizedRoomMessageSearchQuery,
): SQL {
  if (mode === "whole") {
    return sql`plainto_tsquery('english', ${query.wholeText})`;
  }

  // PostgreSQL's English parser keeps slash-delimited filesystem paths as one
  // lexeme (for example `/users/tester/...`). Preserve a safe path-shaped
  // query as that same indexed lexeme instead of splitting it into `users` and
  // `writer`, which cannot match the generated tsvector. A fragment without a
  // leading slash checks both relative and absolute forms.
  if (query.pathPrefix) {
    const candidates = query.pathPrefix.startsWith("/")
      ? [query.pathPrefix]
      : [query.pathPrefix, `/${query.pathPrefix}`];
    const pathTsquery = candidates.map((candidate) => `'${candidate}':*`).join(" | ");
    return sql`to_tsquery('english', ${pathTsquery})`;
  }

  // Tokens have already been restricted to Unicode letters and numbers; quote each one in
  // tsquery syntax as a second, explicit boundary before applying `:*`.
  const prefixTsquery = query.terms.map((term) => `'${term}':*`).join(" & ");
  return sql`to_tsquery('english', ${prefixTsquery})`;
}

/** Minimal structural database surface, allowing small unit-test fakes. */
export interface RoomMessageSearchDb {
  execute(
    query: SQL,
  ): Promise<
    | readonly Record<string, unknown>[]
    | { rows: readonly Record<string, unknown>[] }
  >;
}

export interface RoomMessageSearchReadArgs {
  roomId: string;
  query: string;
  mode: RoomMessageSearchMode;
  limit: number;
  /**
   * Caller-owned transcript/routing visibility clause, including its leading
   * `AND` when non-empty. This seam deliberately owns no visibility policy.
   */
  visibilityPredicate: SQL;
  /** Optional caller-owned joins for result attribution. */
  joins?: SQL;
  /** Optional caller-owned projection; defaults to a raw message-content row. */
  projection?: SQL;
}

export type RoomMessageSearchReadResult<TRow extends object> =
  | { ok: true; rows: TRow[]; query: NormalizedRoomMessageSearchQuery }
  | { ok: false; error: RoomMessageSearchValidationError };

function rowsFromExecute<TRow extends object>(
  result:
    | readonly Record<string, unknown>[]
    | { rows: readonly Record<string, unknown>[] },
): TRow[] {
  return ("rows" in result ? result.rows : result) as TRow[];
}

/**
 * Executes a bounded Room-scoped FTS read over `session_messages.content`'s
 * generated `content_search` vector. Callers supply visibility and any joins,
 * preventing Conductor-only routing rules from becoming transcript policy.
 */
export async function queryRoomMessageContentIndex<TRow extends object>(
  db: RoomMessageSearchDb,
  args: RoomMessageSearchReadArgs,
): Promise<RoomMessageSearchReadResult<TRow>> {
  const normalized = normalizeRoomMessageSearchQuery(args.query);
  if (!normalized.ok) return normalized;

  const limit = Math.max(1, Math.min(ROOM_MESSAGE_SEARCH_LIMIT_MAX, Math.trunc(args.limit)));
  const tsquery = roomMessageSearchTsquery(args.mode, normalized.query);
  const projection = args.projection ?? sql`
    sm.id AS message_id,
    sm.created_at AS ts,
    sm.role AS role,
    sm.content AS content
  `;
  const joins = args.joins ?? sql``;
  const raw = await db.execute(sql`
    SELECT ${projection}
    FROM session_messages sm
    INNER JOIN sessions s ON s.id = sm.session_id
    ${joins}
    WHERE s.room_id = ${args.roomId}
      AND sm.content_search @@ ${tsquery}
      ${args.visibilityPredicate}
    ORDER BY sm.created_at DESC, sm.id DESC
    LIMIT ${limit}
  `);

  return { ok: true, rows: rowsFromExecute<TRow>(raw), query: normalized.query };
}
