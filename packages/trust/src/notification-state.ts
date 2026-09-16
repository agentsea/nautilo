import {
  getSharedDirectDb,
  humanBlocks,
  pushMessageCandidates,
  sql,
  type DirectDatabase,
  type SQL,
} from "@nautilo/db";
import type {
  ImportantMessageArrivedEvent,
  NotificationLevel,
  NotificationStateResponse,
} from "@nautilo/types";

export const MAX_NOTIFICATION_STATE_DETAILS = 10_000;

type NotificationCountRow = {
  user_id: string;
  room_id: string | null;
  top_level_room_id: string | null;
  parent_room_id: string | null;
  thread_root_message_id: number | null;
  reply_count: number | null;
  default_level: NotificationLevel;
  override_level: NotificationLevel | null;
  effective_level: NotificationLevel;
  own_unread_count: number;
  own_important_unread_count: number;
};

export type ChangedNotificationState = {
  userId: string;
  roomId: string;
  topLevelRoomId: string;
  roomOwnUnreadCount: number;
  roomOwnImportantUnreadCount: number;
  topLevelUnreadCount: number;
  topLevelImportantUnreadCount: number;
};

export function sanitizeNotificationLabel(
  value: string | null | undefined,
  fallback: string,
): string {
  const controlFree = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? " "
      : character;
  }).join("");
  const sanitized = controlFree
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return sanitized.length > 0 ? sanitized : fallback;
}

export class NotificationStateTooLargeError extends Error {
  readonly code = "notification_state_too_large";

  constructor(readonly detailCount: number) {
    super(`Notification state contains ${detailCount} detail rows`);
    this.name = "NotificationStateTooLargeError";
  }
}

function uuidArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * M236 — the one SQL classification spine used by both full snapshots and
 * changed-family recomputation. The optional family restriction changes only
 * scope; every eligibility/read/preference/directed predicate remains shared.
 */
async function queryNotificationCountRows(
  database: DirectDatabase,
  viewerUserIds: string[],
  changedRoomId?: string,
): Promise<NotificationCountRow[]> {
  if (viewerUserIds.length === 0) return [];

  const familyRestriction = changedRoomId
    ? sql`
        AND top.id = (
          SELECT COALESCE(changed.parent_room_id, changed.id)
          FROM rooms changed
          WHERE changed.id = ${changedRoomId}
        )`
    : sql``;

  const result = await database.execute(sql`
    WITH viewers AS (
      SELECT unnest(${uuidArray(viewerUserIds)}) AS user_id
    ),
    authorized_top_rooms AS (
      SELECT DISTINCT
        v.user_id,
        top.id AS top_level_room_id,
        top.id AS room_id,
        NULL::uuid AS parent_room_id,
        NULL::int AS thread_root_message_id
      FROM viewers v
      JOIN actors viewer_actor
        ON viewer_actor.owner_id = v.user_id
       AND viewer_actor.kind = 'user'
      JOIN room_members viewer_membership
        ON viewer_membership.actor_id = viewer_actor.id
      JOIN rooms top
        ON top.id = viewer_membership.room_id
       AND top.parent_room_id IS NULL
       AND top.archived_at IS NULL
       AND top.kind NOT IN ('task', 'access', 'subthread')
      WHERE TRUE ${familyRestriction}
    ),
    eligible_rooms AS (
      SELECT
        atr.user_id,
        atr.top_level_room_id,
        atr.room_id,
        atr.parent_room_id,
        atr.thread_root_message_id,
        NULL::int AS reply_count
      FROM authorized_top_rooms atr
      UNION ALL
      SELECT
        atr.user_id,
        atr.top_level_room_id,
        child.id AS room_id,
        child.parent_room_id,
        child.thread_root_message_id,
        root.reply_count
      FROM authorized_top_rooms atr
      JOIN rooms child
        ON child.parent_room_id = atr.top_level_room_id
       AND child.kind = 'subthread'
       AND child.archived_at IS NULL
      JOIN subthread_notification_participants participant
        ON participant.subthread_room_id = child.id
       AND participant.user_id = atr.user_id
      LEFT JOIN session_messages root
        ON root.id = child.thread_root_message_id
    ),
    room_shape AS (
      SELECT
        er.room_id,
        COUNT(DISTINCT rm.actor_id)::int AS member_count,
        COUNT(DISTINCT member_actor.owner_id) FILTER (
          WHERE member_actor.kind = 'user'
        )::int AS human_count
      FROM eligible_rooms er
      JOIN room_members rm ON rm.room_id = er.room_id
      JOIN actors member_actor
        ON member_actor.id = rm.actor_id
      GROUP BY er.room_id
    ),
    classified_messages AS (
      SELECT
        er.user_id,
        er.room_id,
        er.top_level_room_id,
        sm.id AS message_id,
        COALESCE(
          room_pref.level,
          user_pref.default_level,
          'direct'
        ) AS effective_level,
        EXISTS (
          SELECT 1
          FROM session_message_directed_recipients directed
          WHERE directed.message_id = sm.id
            AND directed.recipient_id = er.user_id
        ) AS directed
      FROM eligible_rooms er
      JOIN room_shape rs ON rs.room_id = er.room_id
      JOIN sessions s ON s.room_id = er.room_id
      JOIN session_messages sm ON sm.session_id = s.id
      LEFT JOIN user_notification_settings user_pref
        ON user_pref.user_id = er.user_id
      LEFT JOIN room_notification_settings room_pref
        ON room_pref.user_id = er.user_id
       AND room_pref.room_id = er.top_level_room_id
      LEFT JOIN subthread_notification_participants participant
        ON participant.subthread_room_id = er.room_id
       AND participant.user_id = er.user_id
      WHERE sm.transcript_origin IN ('main', 'subagent')
        AND sm.metadata->>'originatedBy' IS DISTINCT FROM 'task' AND sm.metadata->>'originatedBy' IS DISTINCT FROM 'connected_web_operation'
        AND sm.role IN ('user', 'assistant')
        AND (sm.role <> 'assistant' OR btrim(sm.content) <> '')
        AND NOT (sm.role = 'user' AND s.owner_id = er.user_id)
        AND NOT (
          sm.role = 'user'
          AND rs.member_count = 2
          AND rs.human_count = 2
          AND EXISTS (
            SELECT 1
            FROM ${humanBlocks} hb
            WHERE (
              hb.blocker_user_id = s.owner_id
              AND hb.blocked_user_id = er.user_id
            ) OR (
              hb.blocker_user_id = er.user_id
              AND hb.blocked_user_id = s.owner_id
            )
          )
        )
        AND (
          er.parent_room_id IS NULL
          OR (
            participant.from_message_id IS NOT NULL
            AND sm.id >= participant.from_message_id
          )
        )
        AND (
          (
            rs.human_count < 2
            AND sm.read_at IS NULL
          )
          OR (
            rs.human_count >= 2
            AND NOT EXISTS (
              SELECT 1
              FROM session_message_recipient_state recipient_state
              WHERE recipient_state.message_id = sm.id
                AND recipient_state.recipient_id = er.user_id
                AND recipient_state.read_at IS NOT NULL
            )
          )
        )
    ),
    own_counts AS (
      SELECT
        cm.user_id,
        cm.room_id,
        COUNT(*)::int AS own_unread_count,
        COUNT(*) FILTER (
          WHERE cm.effective_level = 'all'
             OR (cm.effective_level = 'direct' AND cm.directed)
        )::int AS own_important_unread_count
      FROM classified_messages cm
      GROUP BY cm.user_id, cm.room_id
    )
    SELECT
      v.user_id,
      er.room_id,
      er.top_level_room_id,
      er.parent_room_id,
      er.thread_root_message_id,
      er.reply_count,
      COALESCE(user_pref.default_level, 'direct') AS default_level,
      room_pref.level AS override_level,
      COALESCE(
        room_pref.level,
        user_pref.default_level,
        'direct'
      ) AS effective_level,
      COALESCE(oc.own_unread_count, 0)::int AS own_unread_count,
      COALESCE(oc.own_important_unread_count, 0)::int
        AS own_important_unread_count
    FROM viewers v
    LEFT JOIN eligible_rooms er ON er.user_id = v.user_id
    LEFT JOIN user_notification_settings user_pref
      ON user_pref.user_id = v.user_id
    LEFT JOIN room_notification_settings room_pref
      ON room_pref.user_id = v.user_id
     AND room_pref.room_id = er.top_level_room_id
    LEFT JOIN own_counts oc
      ON oc.user_id = v.user_id
     AND oc.room_id = er.room_id
    ORDER BY v.user_id, er.top_level_room_id, er.parent_room_id NULLS FIRST,
      er.room_id
  `);

  return (result as unknown as NotificationCountRow[]).map((row) => ({
    ...row,
    thread_root_message_id:
      row.thread_root_message_id === null
        ? null
        : Number(row.thread_root_message_id),
    reply_count: row.reply_count === null ? null : Number(row.reply_count),
    own_unread_count: Number(row.own_unread_count),
    own_important_unread_count: Number(row.own_important_unread_count),
  }));
}

function foldTopLevelCounts(rows: NotificationCountRow[]): Map<
  string,
  { unreadCount: number; importantUnreadCount: number }
> {
  const totals = new Map<
    string,
    { unreadCount: number; importantUnreadCount: number }
  >();
  for (const row of rows) {
    if (row.top_level_room_id === null) continue;
    const current = totals.get(row.top_level_room_id) ?? {
      unreadCount: 0,
      importantUnreadCount: 0,
    };
    current.unreadCount += row.own_unread_count;
    current.importantUnreadCount += row.own_important_unread_count;
    totals.set(row.top_level_room_id, current);
  }
  return totals;
}

export async function getNotificationState(
  viewerUserId: string,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<NotificationStateResponse> {
  const rows = await queryNotificationCountRows(database, [viewerUserId]);
  const detailRows = rows.filter((row) => row.room_id !== null);
  if (detailRows.length > MAX_NOTIFICATION_STATE_DETAILS) {
    throw new NotificationStateTooLargeError(detailRows.length);
  }

  const topLevelCounts = foldTopLevelCounts(detailRows);
  const topLevelRows = detailRows.filter((row) => row.parent_room_id === null);
  const childRows = detailRows.filter((row) => row.parent_room_id !== null);
  const roomOverrides = topLevelRows
    .filter((row) => row.override_level !== null)
    .map((row) => ({
      roomId: row.room_id as string,
      level: row.override_level as NotificationLevel,
    }));

  const rooms = topLevelRows.map((row) => {
    const aggregate = topLevelCounts.get(row.room_id as string) ?? {
      unreadCount: 0,
      importantUnreadCount: 0,
    };
    return {
      roomId: row.room_id as string,
      ownUnreadCount: row.own_unread_count,
      ownImportantUnreadCount: row.own_important_unread_count,
      subthreadUnreadCount: aggregate.unreadCount - row.own_unread_count,
      subthreadImportantUnreadCount:
        aggregate.importantUnreadCount - row.own_important_unread_count,
      unreadCount: aggregate.unreadCount,
      importantUnreadCount: aggregate.importantUnreadCount,
    };
  });
  const totals = rooms.reduce(
    (current, room) => ({
      unreadCount: current.unreadCount + room.unreadCount,
      importantUnreadCount:
        current.importantUnreadCount + room.importantUnreadCount,
    }),
    { unreadCount: 0, importantUnreadCount: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    preferences: {
      defaultLevel: rows[0]?.default_level ?? "direct",
      roomOverrides,
    },
    totals,
    rooms,
    subthreads: childRows.map((row) => ({
      roomId: row.room_id as string,
      parentRoomId: row.parent_room_id as string,
      anchorMessageId: row.thread_root_message_id as number,
      replyCount: row.reply_count ?? 0,
      unreadCount: row.own_unread_count,
      importantUnreadCount: row.own_important_unread_count,
    })),
  };
}

/**
 * Lightweight absolute unread total for a background badge. Unlike the REST
 * snapshot, this projection has no detail-row response limit and returns no
 * Room labels or message content.
 */
export async function getNotificationUnreadCount(
  viewerUserId: string,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<number> {
  const rows = await queryNotificationCountRows(database, [viewerUserId]);
  const unreadCount = rows.reduce(
    (total, row) => total + (row.room_id === null ? 0 : row.own_unread_count),
    0,
  );
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new Error("notification unread total is outside the supported range");
  }
  return unreadCount;
}

export async function getChangedNotificationState(
  roomId: string,
  recipientUserIds: string[],
  database: DirectDatabase = getSharedDirectDb(),
): Promise<ChangedNotificationState[]> {
  const rows = await queryNotificationCountRows(
    database,
    recipientUserIds,
    roomId,
  );
  const byViewer = new Map<string, NotificationCountRow[]>();
  for (const row of rows) {
    const viewerRows = byViewer.get(row.user_id) ?? [];
    viewerRows.push(row);
    byViewer.set(row.user_id, viewerRows);
  }

  const changed: ChangedNotificationState[] = [];
  for (const [userId, viewerRows] of byViewer) {
    const room = viewerRows.find((row) => row.room_id === roomId);
    if (!room) continue;
    const aggregate = foldTopLevelCounts(viewerRows).get(
      room.top_level_room_id as string,
    );
    if (!aggregate) continue;
    changed.push({
      userId,
      roomId,
      topLevelRoomId: room.top_level_room_id as string,
      roomOwnUnreadCount: room.own_unread_count,
      roomOwnImportantUnreadCount: room.own_important_unread_count,
      topLevelUnreadCount: aggregate.unreadCount,
      topLevelImportantUnreadCount: aggregate.importantUnreadCount,
    });
  }
  return changed;
}

type ImportantArrivalRow = {
  user_id: string;
  message_id: number;
  room_id: string;
  top_level_room_id: string;
  sender_actor_id: string;
  sender_display_name: string;
  room_label: string;
  parent_room_label: string | null;
  occurred_at: Date | string;
};

/**
 * M236/D468 — classify one committed notification-eligible message. The
 * canonical append transaction has already admitted its content-free candidate;
 * this query reads that structural admission marker plus recipient,
 * membership, preference, and read facts. It never opens message body,
 * free-form metadata, or protected lifecycle material.
 */
export async function getImportantMessageArrivals(
  messageId: number,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<ImportantMessageArrivedEvent[]> {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return [];
  const result = await database.execute(sql`
    WITH message_facts AS (
      SELECT
        sm.id AS message_id,
        sm.role,
        sm.read_at,
        sm.created_at,
        s.owner_id AS session_owner_id,
        s.agent_id,
        r.id AS room_id,
        r.parent_room_id,
        COALESCE(r.parent_room_id, r.id) AS top_level_room_id,
        r.label AS room_label,
        parent.label AS parent_room_label
      FROM session_messages sm
      JOIN ${pushMessageCandidates} admitted_candidate
        ON admitted_candidate.message_id = sm.id
      JOIN sessions s ON s.id = sm.session_id
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN rooms parent ON parent.id = r.parent_room_id
      WHERE sm.id = ${messageId}
        AND r.archived_at IS NULL
        AND r.kind NOT IN ('task', 'access')
    ),
    room_shape AS (
      SELECT
        COUNT(DISTINCT rm.actor_id)::int AS member_count,
        COUNT(DISTINCT member_actor.owner_id) FILTER (
          WHERE member_actor.kind = 'user'
        )::int AS human_count
      FROM message_facts mf
      JOIN room_members rm ON rm.room_id = mf.room_id
      JOIN actors member_actor
        ON member_actor.id = rm.actor_id
    ),
    candidates AS (
      SELECT DISTINCT
        viewer.owner_id AS user_id,
        mf.*,
        COALESCE(
          room_pref.level,
          user_pref.default_level,
          'direct'
        ) AS effective_level,
        sender.id AS sender_actor_id,
        sender.display_name AS sender_display_name
      FROM message_facts mf
      JOIN room_members top_membership
        ON top_membership.room_id = mf.top_level_room_id
      JOIN actors viewer
        ON viewer.id = top_membership.actor_id
       AND viewer.kind = 'user'
      LEFT JOIN user_notification_settings user_pref
        ON user_pref.user_id = viewer.owner_id
      LEFT JOIN room_notification_settings room_pref
        ON room_pref.user_id = viewer.owner_id
       AND room_pref.room_id = mf.top_level_room_id
      JOIN LATERAL (
        SELECT actor.id, actor.display_name
        FROM actors actor
        WHERE (
          mf.role = 'user'
          AND actor.kind = 'user'
          AND actor.owner_id = mf.session_owner_id
        ) OR (
          mf.role = 'assistant'
          AND actor.kind = 'agent'
          AND actor.agent_id = mf.agent_id
        )
        ORDER BY actor.id
        LIMIT 1
      ) sender ON TRUE
      WHERE NOT (mf.role = 'user' AND mf.session_owner_id = viewer.owner_id)
        AND NOT (
          mf.role = 'user'
          AND (SELECT member_count FROM room_shape) = 2
          AND (SELECT human_count FROM room_shape) = 2
          AND EXISTS (
            SELECT 1
            FROM ${humanBlocks} hb
            WHERE (
              hb.blocker_user_id = mf.session_owner_id
              AND hb.blocked_user_id = viewer.owner_id
            ) OR (
              hb.blocker_user_id = viewer.owner_id
              AND hb.blocked_user_id = mf.session_owner_id
            )
          )
        )
        AND (
          mf.parent_room_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM subthread_notification_participants participant
            WHERE participant.subthread_room_id = mf.room_id
              AND participant.user_id = viewer.owner_id
              AND mf.message_id >= participant.from_message_id
          )
        )
        AND (
          (
            (SELECT human_count FROM room_shape) < 2
            AND mf.read_at IS NULL
          )
          OR (
            (SELECT human_count FROM room_shape) >= 2
            AND NOT EXISTS (
              SELECT 1
              FROM session_message_recipient_state recipient_state
              WHERE recipient_state.message_id = mf.message_id
                AND recipient_state.recipient_id = viewer.owner_id
                AND recipient_state.read_at IS NOT NULL
            )
          )
        )
        AND (
          COALESCE(
            room_pref.level,
            user_pref.default_level,
            'direct'
          ) = 'all'
          OR (
            COALESCE(
              room_pref.level,
              user_pref.default_level,
              'direct'
            ) = 'direct'
            AND EXISTS (
              SELECT 1
              FROM session_message_directed_recipients directed
              WHERE directed.message_id = mf.message_id
                AND directed.recipient_id = viewer.owner_id
            )
          )
        )
    )
    SELECT
      user_id,
      message_id,
      room_id,
      top_level_room_id,
      sender_actor_id,
      sender_display_name,
      room_label,
      parent_room_label,
      created_at AS occurred_at
    FROM candidates
    ORDER BY user_id
  `);

  return (result as unknown as ImportantArrivalRow[]).map((row) => ({
    type: "notification.message.important",
    userId: row.user_id,
    messageId: String(row.message_id),
    roomId: row.room_id,
    topLevelRoomId: row.top_level_room_id,
    senderActorId: row.sender_actor_id,
    senderDisplayName: sanitizeNotificationLabel(
      row.sender_display_name,
      "Someone",
    ),
    roomLabel: sanitizeNotificationLabel(row.room_label, "A conversation"),
    ...(row.parent_room_label !== null
      ? {
          parentRoomLabel: sanitizeNotificationLabel(
            row.parent_room_label,
            "A conversation",
          ),
        }
      : {}),
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
  }));
}

/**
 * M236 legacy compatibility projection. Room-list clients need exact own-Room
 * unread values from the same classifier, but the REST snapshot's 10,000-row
 * result-size policy must not make the pre-existing Room list fail.
 */
export async function getLegacyOwnRoomUnreadCounts(
  viewerUserId: string,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<Map<string, number>> {
  const rows = await queryNotificationCountRows(database, [viewerUserId]);
  return new Map(
    rows.flatMap((row) =>
      row.room_id === null
        ? []
        : ([[row.room_id, row.own_unread_count]] as const),
    ),
  );
}
