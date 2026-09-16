import {
  actors,
  agents,
  alias,
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  sql,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import type {
  RoomHistorySearchDb,
  TypedRoomHistorySearchDb,
} from "./history-search";
import type { RoomMemberView } from "./types";

type RoutingPacketDb = TypedRoomHistorySearchDb &
  Pick<DirectDatabase, "selectDistinctOn">;

/** D302 P6b — per-human presence/read from group-room recipient state. */
export interface RoutingPresence {
  /** Display name or @handle — never a raw id. */
  user: string;
  /** Milliseconds since last delivered/read activity for this recipient. */
  lastSeenMs: number;
  /** True when the latest tracked state row has a non-null read_at. */
  hasRead: boolean;
}

/** D302 P6b — recent user→assistant reply edge in the room. */
export interface RoutingReplyTarget {
  /** Human display name or @handle — never a raw id. */
  fromUser: string;
  /** Bot @handle or display name — never a raw id. */
  toBot: string;
}

/** D302 P6b — bounded recent message tempo for the room. */
export interface RoutingTempo {
  /** Count of user/assistant messages in the recent window. */
  msgsLastWindow: number;
  /** Milliseconds since the newest room message, or null when the room is empty. */
  lastMessageAgoMs: number | null;
}

/**
 * Stack-162 — privacy-safe, current-sender-scoped recent counterpart evidence.
 *
 * A "counterpart" is an assistant that recently interacted with THIS sender in
 * THIS room — either by sending a visible assistant message into one of the
 * sender's room sessions, or by reacting to one of the sender's room messages.
 * Display label only (no raw ids, no message content). This is SOFT Floor
 * Manager relationship evidence, never a deterministic wake trigger.
 */
export interface RoutingRecentCounterpart {
  /** Bot display name or `@handle` — never a raw id. */
  bot: string;
  /** Milliseconds since the latest interaction with this sender. */
  lastInteractionAgoMs: number;
  /** Kind of the latest interaction: a visible message, or a reaction. */
  interaction: "message" | "reaction";
  /**
   * Count of room messages (user/assistant, non-subagent) strictly AFTER the
   * interaction. High counts weaken continuity — the room has moved on since
   * the bot last interacted with this sender.
   */
  interveningMessages: number;
}

/** D302 P6b — bounded routing metadata injected into the Floor Manager packet. */
export interface RoutingPacket {
  presence: RoutingPresence[];
  replyTargets: RoutingReplyTarget[];
  tempo: RoutingTempo;
  /** Stack-162 — current-sender-scoped recent counterpart evidence (newest first). */
  recentCounterparts: RoutingRecentCounterpart[];
}

const DEFAULT_RECENT_WINDOW_MS = 5 * 60 * 1000;
const REPLY_TARGETS_LIMIT = 50;
/**
 * Stack-162 — counterpart evidence window. A counterpart that last interacted
 * with the sender more than this long ago is stale and excluded. 60 minutes is
 * the initial policy constant; tune here only (no schema change).
 */
const COUNTERPART_WINDOW_MS = 60 * 60 * 1000;
/** Stack-162 — bounded count of counterparts surfaced to the FM prompt. */
const COUNTERPART_LIMIT = 3;

function rowsFromExecute<T>(
  result:
    | readonly Record<string, unknown>[]
    | { rows: readonly Record<string, unknown>[] },
): T[] {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: readonly Record<string, unknown>[] }).rows;
  return rows as T[];
}

function displayLabel(
  displayName: string | null | undefined,
  handle: string | null | undefined,
): string | null {
  const name = displayName?.trim();
  if (name && name.length > 0) return name;
  const h = handle?.trim();
  if (h && h.length > 0) return `@${h.replace(/^@+/, "")}`;
  return null;
}

interface RawPresenceRow {
  recipient_id: string;
  read_at: string | Date | null;
  delivered_at: string | Date | null;
  message_ts: string | Date;
  user_handle: string | null;
  user_name: string | null;
}

interface RawReplyRow {
  user_handle: string | null;
  user_name: string | null;
  agent_handle: string | null;
  agent_display_name: string | null;
}

interface RawTempoRow {
  msgs_last_window: number | string;
  latest_ts: string | Date | null;
}

interface RawRecentCounterpartRow {
  agent_handle: string | null;
  agent_display_name: string | null;
  interaction_ts: string;
  interaction_kind: string;
  intervening_messages: number | string | null;
}

async function loadPresence(
  db: RoutingPacketDb,
  roomId: string,
  now: Date,
): Promise<RoutingPresence[]> {
  const userAuthor = alias(actors, "presence_user_author");
  const raw = await db
    .selectDistinctOn([sessionMessageRecipientState.recipientId], {
      recipient_id: sessionMessageRecipientState.recipientId,
      read_at: sessionMessageRecipientState.readAt,
      delivered_at: sessionMessageRecipientState.deliveredAt,
      message_ts: sessionMessages.createdAt,
      user_handle: users.handle,
      user_name: userAuthor.displayName,
    })
    .from(sessionMessageRecipientState)
    .innerJoin(
      sessionMessages,
      eq(sessionMessages.id, sessionMessageRecipientState.messageId),
    )
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .leftJoin(users, eq(users.id, sessionMessageRecipientState.recipientId))
    .leftJoin(
      userAuthor,
      and(
        eq(userAuthor.ownerId, sessionMessageRecipientState.recipientId),
        eq(userAuthor.kind, "user"),
      ),
    )
    .where(
      and(
        eq(sessions.roomId, roomId),
        sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
      ),
    )
    .orderBy(
      sessionMessageRecipientState.recipientId,
      desc(sessionMessages.createdAt),
      desc(sessionMessages.id),
    );

  const presence: RoutingPresence[] = [];
  for (const row of rowsFromExecute<RawPresenceRow>(raw)) {
    const label = displayLabel(row.user_name, row.user_handle);
    if (!label) continue;
    const activityTs = row.read_at ?? row.delivered_at ?? row.message_ts;
    const lastSeenMs = Math.max(0, now.getTime() - new Date(activityTs).getTime());
    presence.push({
      user: label,
      lastSeenMs,
      hasRead: row.read_at != null,
    });
  }
  return presence;
}

async function loadReplyTargets(
  db: RoutingPacketDb,
  roomId: string,
): Promise<RoutingReplyTarget[]> {
  const userMessage = alias(sessionMessages, "reply_user_message");
  const parentMessage = alias(sessionMessages, "reply_parent_message");
  const userSession = alias(sessions, "reply_user_session");
  const parentSession = alias(sessions, "reply_parent_session");
  const userAuthor = alias(actors, "reply_user_author");
  const agentAuthor = alias(actors, "reply_agent_author");
  const raw = await db
    .select({
      user_handle: users.handle,
      user_name: userAuthor.displayName,
      agent_handle: agents.handle,
      agent_display_name: agentAuthor.displayName,
    })
    .from(userMessage)
    .innerJoin(userSession, eq(userSession.id, userMessage.sessionId))
    .innerJoin(parentMessage, eq(parentMessage.id, userMessage.replyToMessageId))
    .innerJoin(parentSession, eq(parentSession.id, parentMessage.sessionId))
    .leftJoin(users, eq(users.id, userSession.ownerId))
    .leftJoin(
      userAuthor,
      and(eq(userAuthor.ownerId, userSession.ownerId), eq(userAuthor.kind, "user")),
    )
    .leftJoin(agents, eq(agents.id, parentSession.agentId))
    .leftJoin(
      agentAuthor,
      and(
        eq(agentAuthor.agentId, parentSession.agentId),
        eq(agentAuthor.kind, "agent"),
      ),
    )
    .where(
      and(
        eq(userSession.roomId, roomId),
        eq(parentSession.roomId, roomId),
        sql`${userSession.threadId} NOT LIKE 'subagent:%'`,
        sql`${parentSession.threadId} NOT LIKE 'subagent:%'`,
        eq(userMessage.role, "user"),
        eq(parentMessage.role, "assistant"),
        isNotNull(userMessage.replyToMessageId),
      ),
    )
    .orderBy(desc(userMessage.createdAt), desc(userMessage.id))
    .limit(REPLY_TARGETS_LIMIT);

  const targets: RoutingReplyTarget[] = [];
  for (const row of rowsFromExecute<RawReplyRow>(raw)) {
    const fromUser = displayLabel(row.user_name, row.user_handle);
    const toBot =
      displayLabel(row.agent_display_name, row.agent_handle) ??
      (row.agent_handle ? `@${row.agent_handle.replace(/^@+/, "")}` : null);
    if (!fromUser || !toBot) continue;
    targets.push({ fromUser, toBot });
  }
  return targets;
}

async function loadTempo(
  db: RoutingPacketDb,
  roomId: string,
  now: Date,
  recentWindowMs: number,
): Promise<RoutingTempo> {
  const windowStart = new Date(now.getTime() - recentWindowMs).toISOString();
  const raw = await db
    .select({
      msgs_last_window:
        sql<number>`COUNT(*) FILTER (WHERE ${sessionMessages.createdAt} >= ${windowStart}::timestamptz)::int`,
      latest_ts: max(sessionMessages.createdAt),
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(
      and(
        eq(sessions.roomId, roomId),
        sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
        inArray(sessionMessages.role, ["user", "assistant"]),
      ),
    );

  const row = rowsFromExecute<RawTempoRow>(raw)[0];
  const msgsLastWindow = Number(row?.msgs_last_window ?? 0);
  const latestTs = row?.latest_ts;
  const lastMessageAgoMs =
    latestTs == null ? null : Math.max(0, now.getTime() - new Date(latestTs).getTime());
  return { msgsLastWindow, lastMessageAgoMs };
}

/**
 * Stack-162 — load privacy-safe, current-sender-scoped recent counterpart
 * evidence for the Floor Manager.
 *
 * Two interaction sources, both scoped to THIS sender (`actors.id =
 * userActorId`, `kind = 'user'` → `owner_id`) in THIS room:
 *   1. `message` — visible assistant messages (`role = 'assistant'` with
 *      non-empty trimmed content) in the sender's room sessions, attributed to
 *      the speaking agent via `sessions.agent_id`. Empty tool-call/reaction
 *      scaffolding rows are not message interactions.
 *   2. `reaction` — agent-actor reactions on the sender's `role = 'user'`
 *      room messages, attributed to the reacting agent via the reactor
 *      actor's `agent_id` (`actors.kind = 'agent'`).
 *
 * Latest interaction per agent wins; exact timestamp ties choose `message`
 * before `reaction`. Final rows are newest first with `agent_id` as the stable
 * ordering tie-break. Bounded to the {@link COUNTERPART_WINDOW_MS} window and
 * {@link COUNTERPART_LIMIT} rows. For each counterpart we count room messages
 * strictly after the interaction so high-volume rooms weaken continuity.
 * Output is display labels only — no raw ids, no message content. A TS-side
 * age filter is applied as defense-in-depth on top of the SQL `windowStart`
 * filter.
 */
async function loadRecentCounterparts(
  db: RoomHistorySearchDb,
  roomId: string,
  userActorId: string,
  now: Date,
  windowMs: number,
): Promise<RoutingRecentCounterpart[]> {
  if (!userActorId) return [];
  const windowStart = new Date(now.getTime() - windowMs).toISOString();
  const raw = await db.execute(sql`
    /* routing-packet:recent-counterparts */
    WITH sender_user AS (
      SELECT a.owner_id AS user_id
      FROM actors a
      WHERE a.id = ${userActorId} AND a.kind = 'user'
      LIMIT 1
    ),
    sender_room_sessions AS (
      SELECT s.id AS session_id
      FROM sessions s, sender_user su
      WHERE s.room_id = ${roomId}
        AND s.owner_id = su.user_id
        AND s.thread_id NOT LIKE 'subagent:%'
    ),
    msg_interactions AS (
      SELECT
        s.agent_id AS agent_id,
        sm.created_at AS interaction_ts,
        'message'::text AS interaction_kind
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      INNER JOIN sender_room_sessions srs ON srs.session_id = s.id
      WHERE sm.role = 'assistant'
        AND COALESCE(sm.content, '') ~ '[^[:space:]]'
        AND s.agent_id IS NOT NULL
    ),
    reaction_interactions AS (
      SELECT
        ra.agent_id AS agent_id,
        mr.created_at AS interaction_ts,
        'reaction'::text AS interaction_kind
      FROM message_reactions mr
      INNER JOIN session_messages sm ON sm.id = mr.message_id
      INNER JOIN sessions s ON s.id = sm.session_id
      INNER JOIN sender_room_sessions srs ON srs.session_id = s.id
      INNER JOIN actors ra ON ra.id = mr.actor_id AND ra.kind = 'agent'
      WHERE sm.role = 'user'
        AND ra.agent_id IS NOT NULL
    ),
    all_interactions AS (
      SELECT agent_id, interaction_ts, interaction_kind FROM msg_interactions
      UNION ALL
      SELECT agent_id, interaction_ts, interaction_kind FROM reaction_interactions
    ),
    latest_per_agent AS (
      SELECT DISTINCT ON (agent_id)
        agent_id,
        interaction_ts,
        interaction_kind
      FROM all_interactions
      WHERE agent_id IS NOT NULL
      ORDER BY agent_id, interaction_ts DESC, interaction_kind ASC
    )
    SELECT
      ag.handle AS agent_handle,
      aa.display_name AS agent_display_name,
      lpa.interaction_ts AS interaction_ts,
      lpa.interaction_kind AS interaction_kind,
      (
        SELECT COUNT(*)::int
        FROM session_messages sm2
        INNER JOIN sessions s2 ON s2.id = sm2.session_id
        WHERE s2.room_id = ${roomId}
          AND s2.thread_id NOT LIKE 'subagent:%'
          AND sm2.role IN ('user', 'assistant')
          AND sm2.created_at > lpa.interaction_ts
      ) AS intervening_messages
    FROM latest_per_agent lpa
    INNER JOIN agents ag ON ag.id = lpa.agent_id
    INNER JOIN actors aa ON aa.agent_id = lpa.agent_id AND aa.kind = 'agent'
    WHERE lpa.interaction_ts >= ${windowStart}::timestamptz
    ORDER BY lpa.interaction_ts DESC, ag.id DESC
    LIMIT ${COUNTERPART_LIMIT}
  `);

  const counterparts: RoutingRecentCounterpart[] = [];
  for (const row of rowsFromExecute<RawRecentCounterpartRow>(raw)) {
    const bot =
      displayLabel(row.agent_display_name, row.agent_handle) ??
      (row.agent_handle ? `@${row.agent_handle.replace(/^@+/, "")}` : null);
    if (!bot) continue;
    const ts = new Date(row.interaction_ts).getTime();
    const lastInteractionAgoMs = Math.max(0, now.getTime() - ts);
    // Defense-in-depth: the SQL windowStart filter already excludes stale
    // rows, but never trust a derived timestamp alone.
    if (lastInteractionAgoMs > windowMs) continue;
    const interaction: RoutingRecentCounterpart["interaction"] =
      row.interaction_kind === "reaction" ? "reaction" : "message";
    counterparts.push({
      bot,
      lastInteractionAgoMs,
      interaction,
      interveningMessages: Number(row.intervening_messages ?? 0),
    });
  }
  return counterparts;
}

/**
 * D302 P6b — assemble bounded routing metadata for the Floor Manager packet.
 * Presence truth is `session_message_recipient_state`; tempo uses
 * `session_messages.created_at` counts (not D111 subthread denorms).
 */
export async function loadRoutingPacket(
  db: RoutingPacketDb,
  args: {
    roomId: string;
    userActorId: string;
    now: Date;
    members: RoomMemberView[];
    recentWindowMs?: number;
  },
): Promise<RoutingPacket> {
  void args.members;
  const recentWindowMs = args.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const [presence, replyTargets, tempo, recentCounterparts] = await Promise.all([
    loadPresence(db, args.roomId, args.now),
    loadReplyTargets(db, args.roomId),
    loadTempo(db, args.roomId, args.now, recentWindowMs),
    loadRecentCounterparts(
      db,
      args.roomId,
      args.userActorId,
      args.now,
      COUNTERPART_WINDOW_MS,
    ),
  ]);
  return { presence, replyTargets, tempo, recentCounterparts };
}

function formatDurationMs(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/**
 * Render routing-packet sections for the FM prompt. Display names and handles
 * only — never raw ids.
 */
export function formatRoutingPacketLines(packet: RoutingPacket): string[] {
  const lines: string[] = [];
  lines.push("Room relationship metadata:");

  if (packet.presence.length > 0) {
    const presenceParts = packet.presence.map((p) => {
      const readNote = p.hasRead ? "read" : "delivered/unread";
      return `${p.user} (last seen ${formatDurationMs(p.lastSeenMs)} ago, ${readNote})`;
    });
    lines.push(`Presence/read: ${presenceParts.join("; ")}`);
  } else {
    lines.push("Presence/read: (none tracked)");
  }

  if (packet.replyTargets.length > 0) {
    const replyParts = packet.replyTargets.map(
      (r) => `${r.fromUser} → ${r.toBot}`,
    );
    lines.push(`Recent reply graph: ${replyParts.join("; ")}`);
  } else {
    lines.push("Recent reply graph: (none)");
  }

  const tempoWindowMin = Math.round(DEFAULT_RECENT_WINDOW_MS / 60_000);
  const latestNote =
    packet.tempo.lastMessageAgoMs == null
      ? "no messages"
      : `latest ${formatDurationMs(packet.tempo.lastMessageAgoMs)} ago`;
  lines.push(
    `Room tempo: ${packet.tempo.msgsLastWindow} messages in recent ${tempoWindowMin}m window; ${latestNote}`,
  );

  const counterpartWindowMin = Math.round(COUNTERPART_WINDOW_MS / 60_000);
  if (packet.recentCounterparts.length > 0) {
    lines.push("Recent counterparts for this sender (newest first):");
    for (const c of packet.recentCounterparts) {
      const noun = c.interveningMessages === 1 ? "message" : "messages";
      lines.push(
        `- ${c.bot} — ${formatDurationMs(c.lastInteractionAgoMs)} ago, ${c.interaction}, ${c.interveningMessages} intervening room ${noun}`,
      );
    }
    lines.push(
      "This is SOFT relationship context for the continuation rubric below, never a wake trigger by itself; high intervening counts weaken continuity.",
    );
  } else {
    lines.push(
      `Recent counterparts for this sender: (none in the last ${counterpartWindowMin}m)`,
    );
  }

  return lines;
}
