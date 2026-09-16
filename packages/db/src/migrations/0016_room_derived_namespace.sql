-- M044 — Room-derived Namespace canonicalization. Single atomic migration
-- (one tx per file under drizzle-orm/postgres-js/migrator). Pre-flight
-- sanity first; then additive changes + backfill + retargeting + constraint
-- flip + drops in dependency order. Same discipline as M043's
-- 0013_rbac_canonical.sql.
--
-- Pivot (REL-NSP-RMS): Namespace belongs to a Room, 1:1. Every Room has
-- exactly one Namespace; every Namespace belongs to exactly one Room.
-- Access beyond "this Room only" follows the subset rule (REL-HUM-NSP):
-- a Human speaking in Room R can additionally read Namespace(R') for
-- every Room R' whose human participant set is a superset of R's humans.
--
-- What changes:
--   1. `rooms.namespace_id` becomes the canonical Namespace back-pointer
--      (NOT NULL, 1:1 with Room).
--   2. `rooms.human_actor_ids uuid[]` denormalizes the human-member set
--      for the subset-rule `@>` lookup. GIN-indexed.
--   3. `namespaces.owner_id` goes away — Namespace's "owner" is its Room.
--   4. `groups.namespace_id` goes away — Groups govern Tool access
--      (REL-GRP-TOL), not Namespace access (REL-GRP-NSP = "no direct").
--   5. Pre-canonical `scope='system'` Namespaces + the `agent_ownership`
--      group's shared Namespace stop existing. Memories previously keyed
--      against them are retargeted to the corresponding Room's Namespace.
--
-- What this migration assumes:
--   - Single-owner OSS deployment shape: exactly one Room per owner,
--     exactly one `scope='private'` Namespace per owner. The backfill
--     reuses the owner's private Namespace row in place as the Room's
--     Namespace (no new row, no `manage_memory.writableNamespaces[0]`
--     churn). A dev DB that has drifted past this shape must run a
--     bespoke backfill first — the pre-flight sanity aborts rather
--     than guessing.
--   - Tables added by PR #76 (`file_revisions`, D087 Phase 2A) and
--     (`session_notifications`, D090 Phase 1) do NOT hold `namespace_id`
--     columns and do NOT reference `namespaces`. The retarget UPDATE +
--     dead-namespace sweep below correctly do not walk them.

-- ---------------------------------------------------------------------------
-- Pre-flight sanity checks — loud-fail on drift
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  rooms_missing_private    bigint;
  owners_with_multi_private bigint;
  multi_room_owners        bigint;
  orphan_memories          bigint;
BEGIN
  -- Every room's owner must have exactly one scope='private' namespace
  -- row available to reuse as the Room's Namespace.
  SELECT count(*) INTO rooms_missing_private
    FROM rooms r
    WHERE NOT EXISTS (
      SELECT 1 FROM namespaces n
      WHERE n.owner_id = r.owner_id AND n.scope = 'private'
    );
  IF rooms_missing_private > 0 THEN
    RAISE EXCEPTION 'M044 aborted: % rooms reference an owner with no private namespace', rooms_missing_private;
  END IF;

  -- Owners may not have more than one private namespace (otherwise the
  -- reuse-in-place backfill would be ambiguous).
  SELECT count(*) INTO owners_with_multi_private
    FROM (
      SELECT owner_id FROM namespaces WHERE scope = 'private'
      GROUP BY owner_id HAVING count(*) > 1
    ) q;
  IF owners_with_multi_private > 0 THEN
    RAISE EXCEPTION 'M044 aborted: % users have multiple private namespaces', owners_with_multi_private;
  END IF;

  -- Today's single-owner OSS deployment has exactly one room per owner.
  -- A deployment with multiple rooms per owner needs a bespoke backfill
  -- strategy (pick which existing namespace each room inherits) — this
  -- migration assumes one room per owner.
  SELECT count(*) INTO multi_room_owners
    FROM (
      SELECT owner_id FROM rooms GROUP BY owner_id HAVING count(*) > 1
    ) q;
  IF multi_room_owners > 0 THEN
    RAISE EXCEPTION 'M044 aborted: % users have more than one room; multi-room backfill not yet implemented', multi_room_owners;
  END IF;

  -- Every non-NULL memory.namespace_id must resolve to a real namespace
  -- row — otherwise the retarget UPDATE + dead-namespace DELETE below
  -- would leave dangling pointers.
  SELECT count(*) INTO orphan_memories
    FROM memories m
    WHERE m.namespace_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM namespaces n WHERE n.id = m.namespace_id);
  IF orphan_memories > 0 THEN
    RAISE EXCEPTION 'M044 aborted: % memories point at non-existent namespace rows', orphan_memories;
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. rooms: add namespace_id (nullable for backfill) + human_actor_ids + GIN
-- ---------------------------------------------------------------------------

-- 1a. Add namespace_id nullable first; Drizzle's generated DDL tried to
--     add it NOT NULL in one step, which would fail on any pre-existing
--     room row. We split the add + set-not-null across the backfill.
ALTER TABLE "rooms" ADD COLUMN "namespace_id" uuid REFERENCES "namespaces"("id");--> statement-breakpoint

-- 1b. Backfill: point each Room at its owner's scope='private' namespace.
--     Pre-flight guarantees exactly one private NS per owner, so the
--     subquery returns a single row.
UPDATE rooms r
SET namespace_id = (
  SELECT id FROM namespaces WHERE owner_id = r.owner_id AND scope = 'private' LIMIT 1
);
--> statement-breakpoint

ALTER TABLE "rooms" ALTER COLUMN "namespace_id" SET NOT NULL;--> statement-breakpoint

-- 1c. Add human_actor_ids with default empty-array; backfill from
--     room_members JOIN actors WHERE kind='user'. Agents (kind='agent')
--     are NOT humans for subset-rule purposes (REL-HUM-NSP — access is
--     always a Human question).
ALTER TABLE "rooms" ADD COLUMN "human_actor_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint

UPDATE rooms r
SET human_actor_ids = COALESCE((
  SELECT array_agg(rm.actor_id ORDER BY rm.actor_id)
  FROM room_members rm
  JOIN actors a ON a.id = rm.actor_id
  WHERE rm.room_id = r.id AND a.kind = 'user'
), '{}'::uuid[]);
--> statement-breakpoint

-- 1d. GIN index for the subset-rule `@>` containment lookup in
--     findReadableNamespacesForSubset.
CREATE INDEX "idx_rooms_human_actor_ids_gin" ON "rooms" USING gin ("human_actor_ids");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Retarget pre-canonical memories onto the Room's Namespace
-- ---------------------------------------------------------------------------
--
-- Two classes of memory rows need moving before we drop the old anchors:
--   a. Memories in a `scope='system'` Namespace. The system scope
--      dissolves in the canonical model (REL-NSP-RMS) — no seeded
--      system NS post-M044.
--   b. Memories in the `agent_ownership` group's `shared`-scoped NS
--      (pre-M044 non-owner-member write lane). Groups don't own
--      Namespaces in the canonical model (REL-GRP-NSP), so these
--      memories migrate to the owner's Room NS.

-- 2a. system → the owner's Room NS.
UPDATE memories m
SET namespace_id = r.namespace_id
FROM namespaces n, rooms r
WHERE m.namespace_id = n.id
  AND n.scope = 'system'
  AND r.owner_id = n.owner_id;
--> statement-breakpoint

-- 2b. agent_ownership group's NS → the owner's Room NS.
UPDATE memories m
SET namespace_id = r.namespace_id
FROM groups g, rooms r
WHERE g.type = 'agent_ownership'
  AND m.namespace_id = g.namespace_id
  AND r.owner_id = g.owner_id;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Drop groups.namespace_id (REL-GRP-NSP: no direct relationship)
-- ---------------------------------------------------------------------------

ALTER TABLE "groups" DROP CONSTRAINT "groups_namespace_id_namespaces_id_fk";--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "namespace_id";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Sweep now-unreferenced pre-canonical namespaces
-- ---------------------------------------------------------------------------
--
-- After step 2 any `scope='system'` NS and any `agent_ownership`
-- group's NS has zero memory-row references. After step 3 no group
-- references them either. The rooms.namespace_id FK (step 1b) only
-- points at `scope='private'` rows. Anything unreferenced is dead
-- weight and safe to delete.

DELETE FROM namespaces n
WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.namespace_id = n.id)
  AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.namespace_id = n.id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Drop namespaces.owner_id (REL-AGT-NSP: Namespace belongs to its Room)
-- ---------------------------------------------------------------------------

ALTER TABLE "namespaces" DROP CONSTRAINT "namespaces_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "namespaces" DROP COLUMN "owner_id";
