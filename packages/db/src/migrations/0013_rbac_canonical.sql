-- M043 — RBAC canonicalization. Single atomic migration (one tx per file
-- under drizzle-orm/postgres-js/migrator). Pre-flight sanity first; then
-- additive changes + backfill + constraint flip + drops in dependency order.

-- ---------------------------------------------------------------------------
-- Pre-flight cleanup — obsolete "agent" channel rows
-- ---------------------------------------------------------------------------
--
-- Pre-M043 `seedDefaultAgent` seeded a channel_identities row on a
-- pseudo `channel='agent'` that FKed to the agent-kind actor. Per
-- REL-CHN-HUM, Channels are Human transport only; agent-addressability
-- goes through `agents.handle` directly. The seed no longer writes
-- this row, and the canonical FK (`user_id → users.id`) makes it
-- structurally impossible. Delete any leftover rows before the sanity
-- checks run — if we left them, the `kind='user'` sanity check below
-- would abort the migration.

DELETE FROM channel_identities WHERE channel = 'agent';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Pre-flight sanity checks — loud-fail on drift
-- ---------------------------------------------------------------------------
--
-- Every Subject table FKs to `actors.id` today with a runtime
-- `kind='user'` expectation. If any row violates that expectation, the
-- `actors.owner_id` backfill below would silently coerce an agent-actor
-- into a user reference — corrupting the data. Refuse to migrate.
-- Additionally, every `groups` row must have an unambiguous Role across
-- its members; the `groups.role_id` backfill uses DISTINCT and fails
-- automatically if >1 distinct role exists per group, but we also pre-
-- check here to emit a cleaner error message when it happens.

DO $$
DECLARE
  bad_gm          bigint;
  bad_chn         bigint;
  bad_cred        bigint;
  bad_rc          bigint;
  bad_sa_cb       bigint;
  bad_sa_ap       bigint;
  bad_ac_req      bigint;
  bad_ac_res      bigint;
  mixed_groups    bigint;
BEGIN
  SELECT count(*) INTO bad_gm
    FROM group_members gm
    JOIN actors a ON a.id = gm.actor_id
    WHERE a.kind <> 'user';
  IF bad_gm > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % group_members rows reference non-user actors', bad_gm;
  END IF;

  SELECT count(*) INTO bad_chn
    FROM channel_identities ci
    JOIN actors a ON a.id = ci.actor_id
    WHERE a.kind <> 'user';
  IF bad_chn > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % channel_identities rows reference non-user actors', bad_chn;
  END IF;

  SELECT count(*) INTO bad_cred
    FROM credentials c
    JOIN actors a ON a.id = c.actor_id
    WHERE a.kind <> 'user';
  IF bad_cred > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % credentials rows reference non-user actors', bad_cred;
  END IF;

  SELECT count(*) INTO bad_rc
    FROM recovery_codes r
    JOIN actors a ON a.id = r.actor_id
    WHERE a.kind <> 'user';
  IF bad_rc > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % recovery_codes rows reference non-user actors', bad_rc;
  END IF;

  SELECT count(*) INTO bad_sa_cb
    FROM standing_approvals sa
    JOIN actors a ON a.id = sa.created_by
    WHERE a.kind <> 'user';
  IF bad_sa_cb > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % standing_approvals.created_by rows reference non-user actors', bad_sa_cb;
  END IF;

  SELECT count(*) INTO bad_sa_ap
    FROM standing_approvals sa
    JOIN actors a ON a.id = sa.actor_pattern
    WHERE sa.actor_pattern IS NOT NULL AND a.kind <> 'user';
  IF bad_sa_ap > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % standing_approvals.actor_pattern rows reference non-user actors', bad_sa_ap;
  END IF;

  SELECT count(*) INTO bad_ac_req
    FROM approval_challenges ac
    JOIN actors a ON a.id = ac.requested_by
    WHERE a.kind <> 'user';
  IF bad_ac_req > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % approval_challenges.requested_by rows reference non-user actors', bad_ac_req;
  END IF;

  SELECT count(*) INTO bad_ac_res
    FROM approval_challenges ac
    JOIN actors a ON a.id = ac.resolved_by
    WHERE ac.resolved_by IS NOT NULL AND a.kind <> 'user';
  IF bad_ac_res > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % approval_challenges.resolved_by rows reference non-user actors', bad_ac_res;
  END IF;

  SELECT count(*) INTO mixed_groups
    FROM (
      SELECT group_id FROM group_members
      GROUP BY group_id
      HAVING count(DISTINCT role_id) > 1
    ) q;
  IF mixed_groups > 0 THEN
    RAISE EXCEPTION 'M043 aborted: % groups have members with mixed roles; canonical model requires per-group uniformity', mixed_groups;
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Collapse `roles` to one global row per slug
-- ---------------------------------------------------------------------------
--
-- Strategy: for each slug, pick a canonical row_id (preferring the
-- `agent_ownership` row which — post-seeds — always has the widest
-- capability bundle for that slug). Update every referring FK
-- (`groups.role_id` not yet added; `group_members.role_id` still
-- present; `standing_approvals.group_id → groups.role_id` is indirect
-- and safe) to point at the canonical row. Delete duplicates. Finally
-- drop `group_type` and add `UNIQUE (slug)`.

-- 1a. Create a canonical-slug mapping CTE inline in UPDATE statements
--     below. We use the explicit "prefer agent_ownership, else any"
--     rule so the result is deterministic.

-- 1b. Rewrite group_members.role_id to canonical per-slug row.
UPDATE group_members gm
SET role_id = canonical.id
FROM (
  SELECT DISTINCT ON (r.slug)
    r.slug,
    r.id
  FROM roles r
  ORDER BY r.slug,
    CASE WHEN r.group_type = 'agent_ownership' THEN 0 ELSE 1 END,
    r.id
) canonical
JOIN roles old_r ON old_r.slug = canonical.slug
WHERE gm.role_id = old_r.id
  AND gm.role_id <> canonical.id;
--> statement-breakpoint

-- 1c. Delete non-canonical role rows. `role_capabilities` has
--     ON DELETE CASCADE so its rows for the duplicates disappear with
--     them. No other table FKs `roles` at this point.
DELETE FROM roles
WHERE id NOT IN (
  SELECT DISTINCT ON (slug) id
  FROM roles
  ORDER BY slug,
    CASE WHEN group_type = 'agent_ownership' THEN 0 ELSE 1 END,
    id
);
--> statement-breakpoint

-- 1d. Drop the (now redundant) `group_type` index + column.
DROP INDEX IF EXISTS "idx_roles_group_type_slug";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "group_type";--> statement-breakpoint

-- 1e. Add UNIQUE (slug). Safe now that duplicates are gone.
ALTER TABLE "roles" ADD CONSTRAINT "roles_slug_unique" UNIQUE ("slug");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Move Role onto the Group row
-- ---------------------------------------------------------------------------

-- 2a. Add nullable column first, then backfill from the single role
--     shared by the group's members, then set NOT NULL.
ALTER TABLE "groups" ADD COLUMN "role_id" uuid REFERENCES "roles"("id");--> statement-breakpoint

-- 2b. Backfill. Pre-flight already asserted one DISTINCT role_id per
--     group, so the scalar subquery can't raise here — it was gated.
UPDATE "groups" g
SET role_id = (
  SELECT DISTINCT gm.role_id FROM group_members gm WHERE gm.group_id = g.id
)
WHERE EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id);
--> statement-breakpoint

-- 2c. If any group had ZERO members, it won't have been updated. For
--     safety (dev DBs where a group was created but seed crashed), we
--     delete such rows — they are unreachable under the canonical model.
DELETE FROM "groups" WHERE role_id IS NULL;--> statement-breakpoint

ALTER TABLE "groups" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. group_members: drop actor_id + role_id, add user_id, rebuild PK
-- ---------------------------------------------------------------------------

-- 3a. Add nullable user_id with FK, backfill via actors.owner_id.
ALTER TABLE "group_members" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint

UPDATE "group_members" gm
SET user_id = a.owner_id
FROM actors a
WHERE a.id = gm.actor_id;
--> statement-breakpoint

ALTER TABLE "group_members" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

-- 3b. Drop the composite PK on (group_id, actor_id).
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_group_id_actor_id_pk";--> statement-breakpoint

-- 3c. Drop FK + column actor_id.
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "group_members" DROP COLUMN "actor_id";--> statement-breakpoint

-- 3d. Drop FK + column role_id (Role now lives on groups).
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "group_members" DROP COLUMN "role_id";--> statement-breakpoint

-- 3e. New composite PK on (group_id, user_id).
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY ("group_id", "user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Sibling sweep: channel_identities.actor_id → user_id
-- ---------------------------------------------------------------------------

ALTER TABLE "channel_identities" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint

UPDATE "channel_identities" ci
SET user_id = a.owner_id
FROM actors a
WHERE a.id = ci.actor_id;
--> statement-breakpoint

ALTER TABLE "channel_identities" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "idx_channel_identities_actor";--> statement-breakpoint
ALTER TABLE "channel_identities" DROP CONSTRAINT "channel_identities_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "channel_identities" DROP COLUMN "actor_id";--> statement-breakpoint
CREATE INDEX "idx_channel_identities_user" ON "channel_identities" USING btree ("user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Sibling sweep: credentials.actor_id → user_id
-- ---------------------------------------------------------------------------

ALTER TABLE "credentials" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint

UPDATE "credentials" c
SET user_id = a.owner_id
FROM actors a
WHERE a.id = c.actor_id;
--> statement-breakpoint

ALTER TABLE "credentials" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "idx_credentials_actor_type";--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "credentials" DROP COLUMN "actor_id";--> statement-breakpoint
CREATE INDEX "idx_credentials_user_type" ON "credentials" USING btree ("user_id","type");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Sibling sweep: recovery_codes.actor_id → user_id
-- ---------------------------------------------------------------------------

ALTER TABLE "recovery_codes" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint

UPDATE "recovery_codes" r
SET user_id = a.owner_id
FROM actors a
WHERE a.id = r.actor_id;
--> statement-breakpoint

ALTER TABLE "recovery_codes" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "idx_recovery_codes_actor_used";--> statement-breakpoint
ALTER TABLE "recovery_codes" DROP CONSTRAINT "recovery_codes_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "recovery_codes" DROP COLUMN "actor_id";--> statement-breakpoint
CREATE INDEX "idx_recovery_codes_user_used" ON "recovery_codes" USING btree ("user_id","used");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. standing_approvals: created_by + actor_pattern → users.id
-- ---------------------------------------------------------------------------
--
-- Column names preserved; only the FK target flips. We do the swap in
-- two steps per column (rewrite values to actors.owner_id, then rebind
-- the FK) so the transition is explicit and re-reads obvious.

-- 7a. Rewrite created_by from actors.id to the actor's owner users.id.
UPDATE "standing_approvals" sa
SET created_by = a.owner_id
FROM actors a
WHERE a.id = sa.created_by;
--> statement-breakpoint

ALTER TABLE "standing_approvals" DROP CONSTRAINT "standing_approvals_created_by_actors_id_fk";--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 7b. Rewrite actor_pattern from actors.id to users.id (nullable).
UPDATE "standing_approvals" sa
SET actor_pattern = a.owner_id
FROM actors a
WHERE sa.actor_pattern IS NOT NULL
  AND a.id = sa.actor_pattern;
--> statement-breakpoint

ALTER TABLE "standing_approvals" DROP CONSTRAINT "standing_approvals_actor_pattern_actors_id_fk";--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_actor_pattern_users_id_fk" FOREIGN KEY ("actor_pattern") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. approval_challenges: requested_by + resolved_by → users.id
-- ---------------------------------------------------------------------------

UPDATE "approval_challenges" ac
SET requested_by = a.owner_id
FROM actors a
WHERE a.id = ac.requested_by;
--> statement-breakpoint

ALTER TABLE "approval_challenges" DROP CONSTRAINT "approval_challenges_requested_by_actors_id_fk";--> statement-breakpoint
ALTER TABLE "approval_challenges" ADD CONSTRAINT "approval_challenges_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

UPDATE "approval_challenges" ac
SET resolved_by = a.owner_id
FROM actors a
WHERE ac.resolved_by IS NOT NULL
  AND a.id = ac.resolved_by;
--> statement-breakpoint

ALTER TABLE "approval_challenges" DROP CONSTRAINT "approval_challenges_resolved_by_actors_id_fk";--> statement-breakpoint
ALTER TABLE "approval_challenges" ADD CONSTRAINT "approval_challenges_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 8b. Rewrite in-flight eligible_approvers JSON arrays from actors.id to
--     users.id. Only `pending` rows matter (expired rows will never be
--     resolved); we still update all for hygiene. `jsonb_array_elements_text`
--     explodes the array, we JOIN to actors, and re-aggregate.
UPDATE "approval_challenges" ac
SET eligible_approvers = COALESCE(
  (
    SELECT jsonb_agg(a.owner_id)
    FROM jsonb_array_elements_text(ac.eligible_approvers) elem
    JOIN actors a ON a.id = elem::uuid
  ),
  '[]'::jsonb
)
WHERE jsonb_array_length(ac.eligible_approvers) > 0;
--> statement-breakpoint
