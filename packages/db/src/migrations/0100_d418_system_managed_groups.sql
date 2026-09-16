-- 0100_d418_system_managed_groups.sql
-- D418 Wave 2 / Stack 193 — system-managed Group discriminator.
--
-- Canonical ladder Groups (owners/admins/superusers/members/contributors/
-- guests) and the reserved `workstation_users` preset are
-- platform/system-managed authorization objects independent of any Human
-- account lifecycle — exactly like the ladder Roles, which already use
-- `roles.is_system`. They must NOT be cascade-deleted when a Human
-- (including the bootstrap owner) is hard-deleted.
--
-- Pre-D418 the `groups.owner_id` column was NOT NULL with
-- `ON DELETE CASCADE`, so deleting the bootstrap owner would silently
-- destroy every canonical Group and every membership. This migration
-- lands the approved fix (workstation-users-delegation-flow.md §
-- "Ownership architecture"): an explicit `groups.is_system` discriminator
-- aligned with `roles.is_system`, a nullable Human `owner_id`, and a
-- CHECK invariant that a system-managed Group has no Human owner while a
-- user-managed Group requires one. No fake system User / service
-- principal is invented. The schema/migration is reusable by both
-- Workstation Users and the canonical ladder Groups (not a D418-only
-- one-off).
--
-- Statement order is sequenced to stay safe around the NOT NULL / FK /
-- CHECK constraints on a POPULATED DB:
--   1. ADD COLUMN is_system (NOT NULL DEFAULT false) — existing rows
--      get `false`; the pre-existing NOT NULL owner_id stays intact.
--   2. DROP NOT NULL on owner_id — only now can it be set NULL.
--   3. UPDATE canonical ladder + workstation_users Groups to
--      is_system=true, owner_id=NULL.
--   4. ADD CHECK groups_system_owner_check — at this point every row is
--      in a valid state (system ⇒ NULL owner; user-managed ⇒ non-NULL
--      owner, which was the pre-existing invariant under NOT NULL).
--   5. UPDATE the reserved `workstation-user` Role to is_system=true
--      (matches the ladder Roles seeded with is_system=true).
--
-- This is intentionally a one-shot Drizzle migration tracked by journal idx.
-- In particular, ADD COLUMN is not re-runnable. The defensive CHECK drop
-- only makes constraint replacement deterministic within that one execution;
-- it does not make the migration body idempotent.

ALTER TABLE "groups" ADD COLUMN "is_system" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "groups"
SET "is_system" = true,
    "owner_id" = NULL
WHERE "type" IN ('owners', 'admins', 'superusers', 'members', 'contributors', 'guests', 'workstation_users');--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_system_owner_check";--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_system_owner_check" CHECK (
  ("is_system" = true AND "owner_id" IS NULL)
  OR
  ("is_system" = false AND "owner_id" IS NOT NULL)
);--> statement-breakpoint
UPDATE "roles" SET "is_system" = true WHERE "slug" = 'workstation-user';
