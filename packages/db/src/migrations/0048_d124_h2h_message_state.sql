-- D124 P5 — H2H message state: delivered/read timestamps,
-- quote-reply linkage, recipient junction for groups, last-seen
-- presence on users.

BEGIN;

-- 1. session_messages scalars (1:1 path).
ALTER TABLE session_messages
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_to_message_id integer
    REFERENCES session_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_messages_reply_to
  ON session_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- 2. Per-recipient junction (group path).
CREATE TABLE IF NOT EXISTS session_message_recipient_state (
  message_id    integer NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
  recipient_id  uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at  timestamptz,
  read_at       timestamptz,
  PRIMARY KEY (message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_smrs_recipient
  ON session_message_recipient_state(recipient_id);

-- 3. users.last_seen_at — polling-derived presence.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMIT;
