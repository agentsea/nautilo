-- M075 — per-room LangGraph thread ids; stop sharing `app:default` across users.
-- Rewrites `langchain.*` checkpoint rows when present (guarded). See ISSUE-M075.

BEGIN;

DO $$
DECLARE
  legacy_room uuid;
BEGIN
  SELECT id INTO legacy_room
  FROM rooms
  WHERE graph_thread_id = 'app:default'
  ORDER BY id ASC
  LIMIT 1;

  IF legacy_room IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('langchain.checkpoints') IS NOT NULL THEN
    UPDATE langchain.checkpoints
    SET thread_id = 'room:' || legacy_room::text
    WHERE thread_id = 'app:default';
  END IF;

  IF to_regclass('langchain.checkpoint_blobs') IS NOT NULL THEN
    UPDATE langchain.checkpoint_blobs
    SET thread_id = 'room:' || legacy_room::text
    WHERE thread_id = 'app:default';
  END IF;

  IF to_regclass('langchain.checkpoint_writes') IS NOT NULL THEN
    UPDATE langchain.checkpoint_writes
    SET thread_id = 'room:' || legacy_room::text
    WHERE thread_id = 'app:default';
  END IF;
END $$;

UPDATE rooms
   SET graph_thread_id = 'room:' || id::text
 WHERE graph_thread_id = 'app:default';

UPDATE sessions s
   SET thread_id = 'room:' || s.room_id::text
 WHERE s.thread_id = 'app:default' AND s.room_id IS NOT NULL;

UPDATE jobs j
   SET lane_key = 'room:' || j.room_id::text
 WHERE j.lane_key = 'app:default' AND j.room_id IS NOT NULL;

-- Multiple sessions could share `app:default` for the same room; after the
-- UPDATE above they collide on (owner_id, thread_id). Collapse to one row
-- per pair so `uq_sessions_owner_thread` can be created on dirty dev/CI DBs.
-- @m075-dedupe-sessions-block-start

-- Clear fingerprints on rows that will move onto the canonical session row,
-- so the partial unique index on (session_id, fingerprint) is not violated
-- during the UPDATE below (two source rows could share the same fingerprint).
UPDATE session_messages sm
SET fingerprint = NULL
FROM sessions s,
(
  SELECT s2.id AS session_row_id,
         MIN(s2.id::text) OVER (PARTITION BY s2.owner_id, s2.thread_id)::uuid AS keep_id
  FROM sessions s2
) AS sq
WHERE sm.session_id = s.id
  AND s.id = sq.session_row_id
  AND sq.session_row_id <> sq.keep_id
  AND sm.fingerprint IS NOT NULL;

UPDATE session_messages sm
SET session_id = sq.keep_id
FROM (
  SELECT s.id AS session_row_id,
         MIN(s.id::text) OVER (PARTITION BY s.owner_id, s.thread_id)::uuid AS keep_id
  FROM sessions s
) AS sq
WHERE sm.session_id = sq.session_row_id
  AND sq.session_row_id <> sq.keep_id;

DELETE FROM session_messages d
USING session_messages k
WHERE d.session_id = k.session_id
  AND d.fingerprint IS NOT NULL
  AND d.fingerprint = k.fingerprint
  AND d.id > k.id;

DELETE FROM sessions s
USING (
  SELECT id,
         MIN(id::text) OVER (PARTITION BY owner_id, thread_id)::uuid AS keep_id
  FROM sessions
) AS sq
WHERE s.id = sq.id
  AND s.id <> sq.keep_id;

-- @m075-dedupe-sessions-block-end

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_owner_thread ON sessions (owner_id, thread_id);

COMMIT;
