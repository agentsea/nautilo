-- M124 P1 — public rooms: widen rooms.kind CHECK to admit 'open'.
--
-- 'open' = a discoverable, self-joinable public room. Single-tenant:
-- kind='open' ⇔ listed in this Server's directory + self-joinable by any
-- authenticated user. No new columns, no backfill — existing rows keep
-- their current kind ('private' / 'group' / 'multi_agent' / 'subthread').
--
-- Why hand-written: `rooms.kind` is a plain `text` column whose allowed
-- values are enforced by the hand-maintained `rooms_kind_check` CHECK
-- (added in 0047). Drizzle's `text({enum})` is TS-only and emits no SQL
-- for it, so `drizzle-kit generate` produces no diff when the enum list
-- changes. We drop + re-add the CHECK with 'open' appended.
--
-- The sibling `rooms_subthread_invariant` CHECK is untouched: it only
-- constrains the 'subthread' shape, and an 'open' room (kind != 'subthread'
-- with NULL parent_room_id + thread_root_message_id) trivially satisfies it.
--

BEGIN;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_kind_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_kind_check
    CHECK (kind IN ('private','group','multi_agent','subthread','open'));

COMMIT;
