-- D111 P2 — Subthread substrate: parent_room_id, thread_root_message_id,
-- rooms.kind enum, session_messages denormalizations.

BEGIN;

-- 1. rooms.kind — backfill every existing row to 'private', then
-- enforce NOT NULL + CHECK.
ALTER TABLE rooms
  ADD COLUMN kind text;

UPDATE rooms SET kind = 'private' WHERE kind IS NULL;

ALTER TABLE rooms
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN kind SET DEFAULT 'private',
  ADD CONSTRAINT rooms_kind_check
    CHECK (kind IN ('private','group','multi_agent','subthread'));

-- 2. rooms.parent_room_id — self-FK, ON DELETE CASCADE.
ALTER TABLE rooms
  ADD COLUMN parent_room_id uuid
    REFERENCES rooms(id) ON DELETE CASCADE;

-- 3. rooms.thread_root_message_id — FK to session_messages.id (integer),
-- ON DELETE SET NULL (tombstone behavior).
ALTER TABLE rooms
  ADD COLUMN thread_root_message_id integer
    REFERENCES session_messages(id) ON DELETE SET NULL;

-- 4. CHECK: kind='subthread' iff parent + root are both set.
ALTER TABLE rooms
  ADD CONSTRAINT rooms_subthread_invariant
    CHECK (
      (kind = 'subthread') = (
        parent_room_id IS NOT NULL
        AND thread_root_message_id IS NOT NULL
      )
    );

-- 5. Indexes.
CREATE INDEX IF NOT EXISTS idx_rooms_parent
  ON rooms(parent_room_id)
  WHERE parent_room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rooms_kind
  ON rooms(kind);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_thread_root
  ON rooms(thread_root_message_id)
  WHERE thread_root_message_id IS NOT NULL;

-- 6. session_messages denormalizations.
ALTER TABLE session_messages
  ADD COLUMN subthread_room_id uuid
    REFERENCES rooms(id) ON DELETE SET NULL,
  ADD COLUMN reply_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_reply_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_session_messages_subthread
  ON session_messages(subthread_room_id)
  WHERE subthread_room_id IS NOT NULL;

COMMIT;
