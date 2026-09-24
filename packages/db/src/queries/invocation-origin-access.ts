import { sql, type SQL } from "drizzle-orm";

/** Subtract source-Room access using durable Task ancestry, never a payload echo.
 * Intermediate delivery Rooms may contain only Agents. The root calling Room
 * is the Human's source; all calling Rooms still inherit current bans.
 */
export function taskInvocationOriginAllowedSql(humanId: SQL, taskId: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (
    WITH RECURSIVE lineage AS (
      SELECT t.id, t.parent_task_id, t.calling_room_id, t.requestor_id,
        ARRAY[t.id] AS path, false AS cycle
      FROM tasks t WHERE t.id = ${taskId}
      UNION ALL
      SELECT p.id, p.parent_task_id, p.calling_room_id, p.requestor_id,
        l.path || p.id, p.id = ANY(l.path)
      FROM lineage l JOIN tasks p ON p.id = l.parent_task_id
      WHERE NOT l.cycle
    )
    SELECT 1 WHERE EXISTS (SELECT 1 FROM lineage WHERE parent_task_id IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM lineage l WHERE l.cycle OR l.requestor_id <> ${humanId}
          OR NOT public.moderation_access_allowed(${humanId}, l.calling_room_id)
          OR (l.parent_task_id IS NULL AND l.calling_room_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM room_members member JOIN actors actor ON actor.id = member.actor_id
            WHERE member.room_id = l.calling_room_id AND actor.kind = 'user' AND actor.owner_id = ${humanId}
          ))
      )
  )`;
}
