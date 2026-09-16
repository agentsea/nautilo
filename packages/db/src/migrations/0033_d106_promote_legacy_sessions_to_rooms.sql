DO $$
DECLARE
  rec record;
  promoted_room_id uuid;
  promoted_namespace_id uuid;
  promoted_label text;
BEGIN
  /*
   * D106 — promote legacy per-thread sessions into first-class private Rooms.
   *
   * Earlier Room backfills attached every historical owner session to the
   * default owner/agent Room, even when the session carried a distinct
   * thread_id such as `guest:*`, `tui:*`, or `room:<old-id>`. D106 makes Room
   * the top-level chat object, so each distinct legacy thread needs its own
   * Room row instead of remaining hidden under the default Room.
   *
   * We intentionally promote by distinct (owner, source room, thread_id), not
   * by individual session row. If a future database has multiple session spans
   * for the same thread, they stay together in one Room.
   */
  FOR rec IN
    SELECT
      s.owner_id,
      s.room_id AS source_room_id,
      s.thread_id,
      r.type AS source_room_type,
      r.created_by AS source_created_by,
      r.human_actor_ids AS source_human_actor_ids,
      MIN(s.started_at) AS first_started_at,
      (
        SELECT NULLIF(LEFT(TRIM(s2.title), 80), '')
        FROM sessions s2
        WHERE s2.owner_id = s.owner_id
          AND s2.room_id = s.room_id
          AND s2.thread_id = s.thread_id
          AND NULLIF(TRIM(s2.title), '') IS NOT NULL
        ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC, s2.id
        LIMIT 1
      ) AS title_label
    FROM sessions s
    INNER JOIN rooms r ON r.id = s.room_id
    WHERE s.room_id IS NOT NULL
      AND r.type = 'private'
      AND s.thread_id <> r.graph_thread_id
    GROUP BY
      s.owner_id,
      s.room_id,
      s.thread_id,
      r.type,
      r.created_by,
      r.human_actor_ids
    ORDER BY MIN(s.started_at), s.thread_id
  LOOP
    promoted_label := COALESCE(rec.title_label, LEFT(rec.thread_id, 80), 'Recovered chat');

    SELECT id INTO promoted_room_id
    FROM rooms
    WHERE owner_id = rec.owner_id
      AND graph_thread_id = rec.thread_id
    ORDER BY created_at ASC, id ASC
    LIMIT 1;

    IF promoted_room_id IS NULL THEN
      promoted_namespace_id := gen_random_uuid();
      promoted_room_id := gen_random_uuid();

      INSERT INTO namespaces (id, scope, label, created_at)
      VALUES (
        promoted_namespace_id,
        'private',
        promoted_label,
        COALESCE(rec.first_started_at, NOW())
      );

      INSERT INTO rooms (
        id,
        owner_id,
        type,
        label,
        graph_thread_id,
        namespace_id,
        human_actor_ids,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        promoted_room_id,
        rec.owner_id,
        'private',
        promoted_label,
        rec.thread_id,
        promoted_namespace_id,
        rec.source_human_actor_ids,
        rec.source_created_by,
        COALESCE(rec.first_started_at, NOW()),
        NOW()
      );

      INSERT INTO room_members (room_id, actor_id, room_role, joined_at)
      SELECT
        promoted_room_id,
        rm.actor_id,
        rm.room_role,
        rm.joined_at
      FROM room_members rm
      WHERE rm.room_id = rec.source_room_id
      ON CONFLICT (room_id, actor_id) DO NOTHING;
    END IF;

    UPDATE sessions
    SET room_id = promoted_room_id
    WHERE owner_id = rec.owner_id
      AND room_id = rec.source_room_id
      AND thread_id = rec.thread_id;

    UPDATE jobs
    SET room_id = promoted_room_id
    WHERE owner_id = rec.owner_id
      AND lane_key = rec.thread_id
      AND (room_id = rec.source_room_id OR room_id IS NULL);
  END LOOP;
END $$;
--> statement-breakpoint
WITH latest_room_titles AS (
  SELECT DISTINCT ON (s.room_id)
    s.room_id,
    NULLIF(LEFT(TRIM(s.title), 80), '') AS label
  FROM sessions s
  INNER JOIN rooms r ON r.id = s.room_id
  WHERE r.type = 'private'
    AND s.thread_id = r.graph_thread_id
    AND NULLIF(TRIM(s.title), '') IS NOT NULL
  ORDER BY s.room_id, COALESCE(s.ended_at, s.started_at) DESC, s.id
)
UPDATE rooms r
SET
  label = latest_room_titles.label,
  updated_at = NOW()
FROM latest_room_titles
WHERE r.id = latest_room_titles.room_id
  AND r.type = 'private'
  AND r.label LIKE 'Owner · %';
