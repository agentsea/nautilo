-- =============================================================================
-- 0063_m128_unify_server_invites.sql
-- =============================================================================
-- M128 follow-up — unify "join the server" invites under a single kind.
--
-- WHY:
--   Pre-0063 the post-M128 kind enum was {claim, server, group, room, agent}.
--   `agent` was retired by 0062 (soft-deprecated at the check); `group` and
--   `room` were *both* "join the server, get added to a Group, optionally
--   a Room" — same redeem effects, different code paths, easy to forget one.
--   `kind='server'` was the historical Logto sign-up token but had no group
--   attribution, which left every server-invite redeemer at `guest` post-M128
--   (the bug that left a populated-instance test user in the Guest bucket).
--
--   Post-0063 the canonical kind set is **{claim, server}** only.
--     * `claim`  — bootstrap-owner one-shot; created_by IS NULL.
--     * `server` — every other invite. Always carries `target_group_id`
--                  (the Group the invitee joins). Optionally carries
--                  `target_room_id` (the Room the invitee also joins).
--
-- WHAT THIS MIGRATION DOES:
--   1. Repoints in-flight `kind='group'` rows to `kind='server'` (no-op on
--      target_group_id; they already carry it).
--   2. Repoints in-flight `kind='room'` rows to `kind='server'`
--      (target_group_id was set by 0062; target_room_id is preserved).
--   3. Tightens `invites_kind_chk` to `{claim, server}` only.
--   4. Tightens `invites_group_kind_chk` to require non-NULL
--      `target_group_id` whenever `kind='server'` (was `kind != 'claim'
--      AND kind != 'server'`, which let `kind='server'` slip through with
--      NULL target_group_id — the test001 bug, in CHECK form).
--   5. Drops `invites_room_kind_chk` (room is no longer a kind; the
--      column stays as an optional pointer that any `kind='server'` invite
--      may carry).
--
-- NOT IN SCOPE:
--   - User backfill for already-redeemed test001-style rows. Operators
--     can repair with `bin/nautilo-dev repair-orphan-server-invitees`
--     (added in this PR) or by manual `INSERT INTO group_members` against
--     the desired canonical Group.
-- =============================================================================

-- 1+2. Repoint in-flight invites. ON CONFLICT not needed — kind is the
--      only column we change, and (token_hash) uniqueness already holds.
UPDATE "invites"
SET "kind" = 'server'
WHERE "kind" IN ('group', 'room');
--> statement-breakpoint

-- 2.5. Backfill orphan `kind='server'` rows that pre-dated migration 0063.
--      Pre-0063 the mint route happily accepted `kind='server'` with no
--      `target_group_id` (the legacy "open registration token" shape).
--      Redeem then never inserted into `group_members` and the user landed
--      as `guest` (the test001 bug). Step 4 below makes `target_group_id`
--      required for every `kind='server'` invite — so we must first point
--      these orphan rows somewhere. The safest default is the canonical
--      `guests` Group: it matches the effective post-redeem behavior, so
--      revoking + re-redeeming would land the user in the same place. If
--      operators want to elevate an orphan user, the new `bin/nautilo-dev
--      repair-orphan-server-invitees` command (or a manual
--      `INSERT INTO group_members`) lifts them.
UPDATE "invites"
SET "target_group_id" = (SELECT id FROM "groups" WHERE "type" = 'guests' LIMIT 1)
WHERE "kind" = 'server' AND "target_group_id" IS NULL;
--> statement-breakpoint

-- 3. Tighten kind enum.
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_kind_chk";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_chk"
  CHECK ("kind" IN ('claim', 'server'));
--> statement-breakpoint

-- 4. Require target_group_id for every kind='server' invite.
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_group_kind_chk";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_group_kind_chk"
  CHECK ("kind" = 'claim' OR "target_group_id" IS NOT NULL);
--> statement-breakpoint

-- 5. Drop the room-specific check (room is no longer a kind).
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_room_kind_chk";
--> statement-breakpoint

-- invites_claim_creator_chk + uq_invites_claim_unredeemed unchanged.
