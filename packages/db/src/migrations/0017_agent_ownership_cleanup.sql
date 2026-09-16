-- M045 — Agent-ownership cleanup. Single atomic migration (one tx per file
-- under drizzle-orm/postgres-js/migrator). Pre-flight sanity first; then
-- FK drop + index drop + column drop + UNIQUE(handle) add in dependency
-- order. Same H-022 discipline as M043's 0013_rbac_canonical.sql and
-- M044's 0016_room_derived_namespace.sql.
--
-- Pivot (REL-AGT-HUM, REL-ACT-AGT):
--   - Ownership is M:N via the `agent_ownership` Group (one `owner`-role
--     membership per owner user). `agents.owner_id` was a one-owner
--     legacy column — dropped here.
--   - `agents.handle` gains `UNIQUE` so `seedDefaultAgent` has a
--     deterministic idempotency key post-drop and federated-id routing
--     (`@handle@server`) has per-server handle uniqueness by construction.
--
-- What changes:
--   1. Drop FK `agents_owner_id_users_id_fk` + column `agents.owner_id`.
--   2. Drop index `idx_agents_owner_handle` (keyed on the dropped column).
--   3. Add `UNIQUE(agents.handle)` constraint.
--
-- Cascade-chain semantic change: pre-M045 `DELETE FROM users WHERE id=$1`
-- cascaded to `agents` (then to `actors.agent_id`). Post-M045 the first
-- hop is gone. Production has no user-delete path; integration tests
-- that relied on the cascade now prepend an explicit `DELETE FROM agents`
-- step. See M045 plan Phase 5c for the inventory.

-- ---------------------------------------------------------------------------
-- Pre-flight sanity checks — loud-fail on drift
-- ---------------------------------------------------------------------------
--
-- If we drop owner_id without the canonical ownership path in place, an
-- agent becomes unreachable for approval routing (no one to route
-- `prove_it` to). Three gates:
--   1. Every agent has an `agent_ownership` group (seedAgentOwnershipGroup
--      populated it on boot).
--   2. Every ownership group carries ≥1 `owner`-role member (routeApproval
--      needs approvers post-cutover).
--   3. No duplicate `agents.handle` values — UNIQUE would fail otherwise.

DO $$
DECLARE
  agents_without_ownership_group bigint;
  agents_without_owner_member    bigint;
  duplicate_handles              bigint;
BEGIN
  SELECT count(*) INTO agents_without_ownership_group
    FROM agents a
    WHERE NOT EXISTS (
      SELECT 1 FROM groups g
      WHERE g.type = 'agent_ownership' AND g.agent_id = a.id
    );
  IF agents_without_ownership_group > 0 THEN
    RAISE EXCEPTION 'M045 aborted: % agents have no agent_ownership group — seedAgentOwnershipGroup did not run?', agents_without_ownership_group;
  END IF;

  SELECT count(*) INTO agents_without_owner_member
    FROM agents a
    WHERE NOT EXISTS (
      SELECT 1
      FROM groups g
      JOIN roles r ON r.id = g.role_id
      JOIN group_members gm ON gm.group_id = g.id
      WHERE g.type = 'agent_ownership'
        AND g.agent_id = a.id
        AND r.slug = 'owner'
    );
  IF agents_without_owner_member > 0 THEN
    RAISE EXCEPTION 'M045 aborted: % agents have an ownership group with no owner-role members', agents_without_owner_member;
  END IF;

  SELECT count(*) INTO duplicate_handles
    FROM (
      SELECT handle FROM agents GROUP BY handle HAVING count(*) > 1
    ) q;
  IF duplicate_handles > 0 THEN
    RAISE EXCEPTION 'M045 aborted: % agents.handle values are duplicated; resolve before adding UNIQUE(handle)', duplicate_handles;
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Drop FK + index + column for the legacy one-owner path
-- ---------------------------------------------------------------------------
--
-- IF EXISTS on the FK + INDEX makes the migration safe to re-run on dev
-- DBs that may have manually dropped pieces during M045 experimentation.
-- The DROP COLUMN is unconditional — a missing column would have failed
-- the schema build ahead of this migration anyway.

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_owner_id_users_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_agents_owner_handle";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "owner_id";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Add UNIQUE(handle) — new idempotency key + federated-id uniqueness
-- ---------------------------------------------------------------------------

ALTER TABLE "agents" ADD CONSTRAINT "agents_handle_unique" UNIQUE("handle");
