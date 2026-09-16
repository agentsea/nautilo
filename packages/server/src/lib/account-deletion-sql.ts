import { sql, type SQL } from "@nautilo/db";

/** Build a parameterized PostgreSQL UUID array without scalar array coercion. */
function accountDeletionUuidArraySql(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::uuid[]`;
}

export function accountDeletionSharedRoomLocksSql(
  roomIds: readonly string[],
  targetUserId: string,
): SQL {
  return sql`
    SELECT rm.room_id
    FROM room_members rm
    JOIN actors a ON a.id = rm.actor_id
    WHERE rm.room_id = ANY(${accountDeletionUuidArraySql(roomIds)})
      AND a.owner_id IS NOT NULL
      AND a.owner_id <> ${targetUserId}
    FOR UPDATE OF rm, a
  `;
}

export function accountDeletionOwnedMediaDeleteSql(
  roomIds: readonly string[],
  targetUserId: string,
): SQL {
  return sql`
    DELETE FROM media_generations
    WHERE owner_id = ${targetUserId}
      AND (
        provider_queue_id IS NULL
        OR room_id = ANY(${accountDeletionUuidArraySql(roomIds)})
      )
  `;
}
