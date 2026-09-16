-- 0062_m128_groups_server_wide.sql
-- M128 — collapse per-Agent groups into server-wide canonical Groups.
--
-- IRREVERSIBLE in the sense that the (group, agent) discriminator is gone.
-- Memberships are preserved (collapsed); group_members rows are not lost.
--
-- Hand-edited from a drizzle-kit-generated baseline that only emitted the
-- column drops. The pre-drop INSERTs / UPDATEs / DELETEs collapse data
-- per ISSUE-M128 §2.4 / §3.2 / Phase 2 and permission-model.md §4.
-- Mapping (signed off 2026-05-28, permission-model.md §7 item 8):
--   agent_ownership → owners
--   agent_household → members
--   agent_teammate  → members
--   agent_guest     → guests
--
-- Phase 3 (role_capabilities reseed) runs in seedTrustPersonal at server
-- boot — kept out of this migration so the catalogue source of truth
-- stays in the seed code rather than split across SQL.
--
-- B1 FIX (2026-05-28, ISSUE-M128 §9.2 / §9.3 P0.1): the canonical-Groups
-- INSERT below used to be guarded by `AND EXISTS (SELECT 1 FROM roles
-- WHERE slug = canonical.role_slug)`. On a populated pre-M128 DB only
-- the legacy roles (`owner`/`household`/`teammate`/`guest`/`stranger`)
-- exist, so the four NEW M128 ladder roles (`admin`/`superuser`/
-- `member`/`contributor`) were absent → the `members` Group was never
-- created → step 2's `agent_household`/`agent_teammate` collapse JOIN
-- found no target → step 4 deleted the source rows → every household
-- + teammate membership was silently dropped. Fixed by inserting the
-- 6 ladder roles below as the FIRST statement and dropping the guard.
-- Capabilities + role_capabilities are still seeded by seedTrustPersonal
-- at boot (the SQL only needs roles to satisfy the groups.role_id FK).

-- 0. Seed the 6 M128 ladder roles up-front so the canonical-Groups
--    INSERT below can resolve every role_id. Idempotent via slug UNIQUE.
--    `seedTrustPersonal` later UPSERTs labels + wires role_capabilities;
--    here we only need the rows to exist.
INSERT INTO "roles" (id, slug, label, is_system) VALUES
  (gen_random_uuid(), 'owner',       'Owner',       true),
  (gen_random_uuid(), 'admin',       'Admin',       true),
  (gen_random_uuid(), 'superuser',   'Superuser',   true),
  (gen_random_uuid(), 'member',      'Member',      true),
  (gen_random_uuid(), 'contributor', 'Contributor', true),
  (gen_random_uuid(), 'guest',       'Guest',       true)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- 1. Ensure the six canonical server-wide Groups exist (idempotent).
--    NOTE: groups.type does not yet have UNIQUE constraint at this point
--    (it is added at step 5 below), so ON CONFLICT (type) is not yet
--    available. We probe by SELECT-then-INSERT per slug instead and
--    pre-dedupe any pre-existing NULL-agent rows below.
DELETE FROM "groups" g1
  USING "groups" g2
  WHERE g1.agent_id IS NULL AND g2.agent_id IS NULL
    AND g1.type = g2.type AND g1.id > g2.id;
--> statement-breakpoint
INSERT INTO "groups" (id, owner_id, type, label, trust_preset, role_id, agent_id, created_at)
SELECT
  gen_random_uuid(),
  COALESCE(
    (SELECT id FROM "users" WHERE server_role = 'admin' ORDER BY created_at LIMIT 1),
    (SELECT id FROM "users" ORDER BY created_at LIMIT 1)
  ),
  canonical.type,
  canonical.label,
  'personal',
  (SELECT id FROM "roles" WHERE slug = canonical.role_slug),
  NULL,
  NOW()
FROM (VALUES
  ('owners',       'Owners',       'owner'),
  ('admins',       'Admins',       'admin'),
  ('superusers',   'Superusers',   'superuser'),
  ('members',      'Members',      'member'),
  ('contributors', 'Contributors', 'contributor'),
  ('guests',       'Guests',       'guest')
) AS canonical(type, label, role_slug)
WHERE NOT EXISTS (
    SELECT 1 FROM "groups" g
    WHERE g.type = canonical.type AND g.agent_id IS NULL
  )
  -- Roles are guaranteed present (step 0 above seeded them). The old
  -- `AND EXISTS (SELECT 1 FROM "roles" ...)` guard was the source of
  -- the B1 silent-data-loss bug (see header comment) and is removed.
  --
  -- Skip if there are no users yet (fresh DB pre-bootstrap). owner_id
  -- is NOT NULL FK; seedTrustPersonal will create the Group once the
  -- bootstrap user exists.
  AND EXISTS (SELECT 1 FROM "users");
--> statement-breakpoint

-- 2. Collapse memberships from agent_* groups into server-wide groups.
--    Distinct (group_id, user_id) pairs survive via PK conflict on group_members.
--    Pre-clean any orphan agent_* memberships whose target server-wide
--    Group does not yet exist (would yield NULL group_id and FK fail);
--    in practice this only applies on a fresh-DB run before bootstrap.
INSERT INTO "group_members" (group_id, user_id, granted_at, granted_by)
SELECT
  target.id AS group_id,
  m.user_id,
  m.granted_at,
  m.granted_by
FROM "group_members" m
JOIN "groups" old ON old.id = m.group_id
JOIN "groups" target
  ON target.agent_id IS NULL
 AND target.type = CASE old.type
       WHEN 'agent_ownership' THEN 'owners'
       WHEN 'agent_household' THEN 'members'
       WHEN 'agent_teammate'  THEN 'members'
       WHEN 'agent_guest'     THEN 'guests'
     END
WHERE old.agent_id IS NOT NULL
  AND old.type IN ('agent_ownership', 'agent_household', 'agent_teammate', 'agent_guest')
ON CONFLICT (group_id, user_id) DO NOTHING;
--> statement-breakpoint

-- 2.5. B11 FIX (2026-05-28, caught by TP1 populated-DB test): widen
--      `invites_kind_chk` to accept the canonical post-M128 `kind='group'`
--      value, otherwise step 3's UPDATE violates the CHECK and the
--      whole migration aborts. Also drop `invites_agent_kind_chk` —
--      it references `target_agent_id` which step 5 drops, and once
--      the column is gone the constraint is no longer satisfiable for
--      any new row. `invites_group_kind_chk` and `invites_room_kind_chk`
--      and `invites_claim_creator_chk` remain in force.
--
--      Soft-deprecation: 'agent' stays in the kind enum for one
--      release per ISSUE-M128 §10 D1 / §11 P5. The P5 follow-up PR
--      drops it from the CHECK alongside the route-layer remap.
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_kind_chk";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_chk"
  CHECK ("kind" IN ('claim', 'server', 'agent', 'group', 'room'));
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_agent_kind_chk";
--> statement-breakpoint

-- 3. Repoint in-flight invites BEFORE deleting agent_* groups.
--    B12 FIX (2026-05-28, caught by TP1): the invite's *role-specific*
--    per-Agent group is encoded in `invites.target_group_id`, NOT in
--    `target_agent_id`. The `invites_group_kind_chk` CHECK already
--    requires non-NULL `target_group_id` for kind='agent' rows, so it
--    is guaranteed present. The previous JOIN keyed on
--    `old.agent_id = i.target_agent_id` returned ALL 4 per-Agent group
--    rows for that agent (ownership / household / teammate / guest)
--    and `LIMIT 1` arbitrarily picked one — yielding the wrong
--    canonical Group for household / teammate / guest invites. Fix:
--    JOIN on the invite's OLD `target_group_id` so we recover the
--    exact role + agent in one row.
UPDATE "invites" SET
  kind = 'group',
  target_group_id = sub.new_group_id
FROM (
  SELECT
    i.id AS invite_id,
    (
      SELECT target.id
      FROM "groups" old
      JOIN "groups" target
        ON target.agent_id IS NULL
       AND target.type = CASE old.type
             WHEN 'agent_ownership' THEN 'owners'
             WHEN 'agent_household' THEN 'members'
             WHEN 'agent_teammate'  THEN 'members'
             WHEN 'agent_guest'     THEN 'guests'
             ELSE 'members'
           END
      WHERE old.id = i.target_group_id
      LIMIT 1
    ) AS new_group_id
  FROM "invites" i
  WHERE i.kind = 'agent' AND i.target_group_id IS NOT NULL
) AS sub
WHERE "invites".id = sub.invite_id
  AND sub.new_group_id IS NOT NULL;
--> statement-breakpoint

-- Any kind='agent' invites that could not be repointed (e.g. their
-- target_agent_id refers to an Agent with no agent_* groups left, which
-- should not happen pre-M128 but is defensive) become kind='group' with
-- target_group_id pointing at the canonical `members` Group.
UPDATE "invites" SET
  kind = 'group',
  target_group_id = COALESCE(
    target_group_id,
    (SELECT id FROM "groups" WHERE type = 'members' AND agent_id IS NULL LIMIT 1)
  )
WHERE kind = 'agent';
--> statement-breakpoint

-- 4. Delete agent_* groups (cascades orphaned per-agent group_members).
DELETE FROM "groups" WHERE agent_id IS NOT NULL;
--> statement-breakpoint

-- 5. Drop the agent_id column + its FK + indexes; add UNIQUE(type).
ALTER TABLE "groups" DROP CONSTRAINT "groups_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_target_agent_id_agents_id_fk";--> statement-breakpoint
DROP INDEX "idx_groups_agent";--> statement-breakpoint
DROP INDEX "uq_groups_agent_id_type";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_groups_type" ON "groups" USING btree ("type");--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "target_agent_id";
