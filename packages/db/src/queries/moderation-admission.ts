import { sql, type SQL } from "drizzle-orm";

/**
 * Effective access subtracts sanctions from existing authority. This predicate
 * grants nothing: callers must still check ordinary membership and encryption.
 * Subthreads inherit bans from their parent as well as their own exact scope.
 */
export function moderationAccessAllowedSql(userId: SQL, roomId?: SQL): SQL<boolean> {
  return sql<boolean>`public.moderation_access_allowed(${userId}, ${roomId ?? sql`NULL::uuid`})`;
}

/** Enrollment may check bans before it publishes admission. Never grants access.
 * Statement time matters after lock waits: transaction start can predate a ban. */
export function moderationBanAbsentSql(userId: SQL, roomId?: SQL): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (
      SELECT 1 FROM moderation_subjects ms
      JOIN moderation_restrictions mr ON mr.subject_id = ms.id
      WHERE ms.user_id = ${userId} AND mr.kind = 'access'
        AND mr.lifted_at IS NULL AND mr.starts_at <= statement_timestamp()
        AND (mr.expires_at IS NULL OR mr.expires_at > statement_timestamp())
        AND (${roomId === undefined ? sql`mr.room_id IS NULL` : sql`mr.room_id IS NULL OR mr.room_id = ${roomId}
          OR mr.room_id = (SELECT ma_room.parent_room_id FROM rooms ma_room WHERE ma_room.id = ${roomId})`})
    )`;
}

/** A projection of supplied canonical IDs, never an alternative membership owner. */
export function moderationEffectiveHumanActorIdsSql(candidateIds: SQL, roomId: SQL): SQL<string[]> {
  return sql<string[]>`public.moderation_effective_humans(${candidateIds}, ${roomId})`;
}
