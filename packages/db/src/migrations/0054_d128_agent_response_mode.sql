-- D128 — per-membership agent response mode (active | mention_only | observe).

BEGIN;

ALTER TABLE room_members
  ADD COLUMN agent_response_mode text;

ALTER TABLE room_members
  ADD CONSTRAINT room_members_agent_response_mode_check
  CHECK (agent_response_mode IS NULL
      OR agent_response_mode IN ('active','mention_only','observe'));

-- Backfill: every existing agent membership defaults to 'active'
-- (preserves today's behavior; new mention-gating logic only kicks in
-- once per-row mode is set explicitly).
UPDATE room_members rm
SET    agent_response_mode = 'active'
FROM   actors a
WHERE  rm.actor_id = a.id
  AND  a.kind = 'agent';

COMMIT;
