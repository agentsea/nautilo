-- D168 P2 (Stack 11.5) — Path C RLS on agent-readable tables + credentials.
--
-- ============================================================
-- IMPORTANT — statement-breakpoint markers (see Drizzle docs) are LOAD-BEARING.
-- ============================================================
-- Drizzle migrate() parses migration files by splitting on the
-- statement-breakpoint marker. Without these markers, the
-- migrator emits an EMPTY statement list, silently records the
-- migration's hash in drizzle.__drizzle_migrations, and returns
-- success WITHOUT executing any of the SQL below. The DB-side
-- artifacts never get created. There is no observable runtime
-- failure mode for this — agent SELECTs just return all rows
-- (RLS never engaged). This was discovered the hard way during
-- D168 P2 development; see commit 90a1c6c4 + the
-- `rls-migration-applied.integration.test.ts` smoke test, which is
-- the tripwire for this whole bug class.
--
-- If you add a CREATE/ALTER/DROP/GRANT/REVOKE statement below,
-- you MUST follow it with a statement-breakpoint marker on its own
-- line. Don't trust your eyes — the smoke test will catch you, but
-- the migration runner won't.
-- ============================================================
--
-- Enables row-level security and adds the simpler-than-canonical
-- direct Room-membership policy on the 11 v1 scope tables. Path C
-- trades the canonical Namespace subset rule for engineering
-- simplicity; see ISSUE-D168 Phase 2 + the threat-model + the bog
-- sidecar for the design discussion.
--
-- Tables in scope:
--   - memories, artifacts (Room-membership + agentId content-scope)
--   - memory_namespaces, artifact_namespaces (junction; namespace
--     membership only — parent row carries agentId)
--   - memory_scopes, artifact_scopes (scope junctions; speaker +
--     parent_agent enforcement via agent_scopes)
--   - room_members (caller is a member of the same room)
--   - agent_scopes (speaker-owned via speaker_user_id +
--     parent_agent_id)
--   - credentials, recovery_codes (per-row user_id)
--   - sessions (Room-membership via sessions.room_id; conversational
--     transcript sessions, NOT auth tokens)
--
-- Two GUCs (set per-transaction by packages/db/src/connection/with-trust-context.ts):
--   - app.current_user_id  (required for any RLS-protected read)
--   - app.current_agent_id (optional; required only for namespace-
--                           scoped reads in multi-Agent Rooms)
--
-- The Postgres role `nautilo` (DB owner) bypasses RLS by default —
-- migrations, seeds, and auth-route code continue to work unchanged.
-- The `nautilo_agent` role from D129 P3 has RLS enforced.
--
-- GUC-bypass residual: anyone with the `nautilo_agent` role can
-- `SET LOCAL app.current_user_id = '<any uuid>'` and iterate. RLS
-- catches application bugs + prompt-injection-via-tool-args, NOT
-- process compromise. Process compromise = full exfil; D120 residual.
-- Layer-2 at-rest encryption is the
-- canonical perimeter for that vector.

-- ============================================================
-- 1. Helper functions for GUC access (NULL-safe)
-- ============================================================

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  -- Returns NULL when the GUC isn't set or is empty. Policy
  -- predicates that AND on `app_current_user_id() IS NOT NULL` will
  -- then refuse all rows when no caller context is established.
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_agent_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_agent_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Both helpers run with the calling role's privileges (no SECURITY
-- DEFINER). They only read GUCs — no table access — so they never
-- need elevated privileges. Path C deliberately does NOT introduce
-- a SECURITY DEFINER reachability function (the canonical subset
-- rule would require that).
GRANT EXECUTE ON FUNCTION app_current_user_id() TO PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_agent_id() TO PUBLIC;
--> statement-breakpoint

-- ============================================================
-- 2. Reusable predicate: is the caller a Human member of any Room
--    whose Namespace owns this namespace_id?
-- ============================================================
--
-- This is the Path C policy core. Used by memories / artifacts /
-- the four namespace+scope junctions / sessions. Encapsulated as a
-- SQL function so the policy expressions stay readable AND the
-- planner can inline it.
--
-- SECURITY DEFINER is REQUIRED to break recursion: this function
-- queries rooms / room_members / actors, all of which have their own
-- RLS policies. Without SECURITY DEFINER the function's internal
-- query would trigger those policies, which call this function, which
-- triggers them again → Postgres "infinite recursion detected".
-- SECURITY DEFINER makes the function run as the OWNER (the role that
-- created it — here, the postgres superuser via migration). Owner has
-- BYPASSRLS implicitly, so the function's internal queries skip
-- policy evaluation.
--
-- This is safe because the function ONLY reads the GUC + a fixed,
-- read-only join: it cannot be tricked into widening the trust context
-- (no parameter influences the user_id lookup). The SECURITY DEFINER
-- attribute does NOT allow the caller to escalate privileges beyond
-- this read; the function does not mutate, does not return raw rows,
-- only returns a boolean.
CREATE OR REPLACE FUNCTION app_can_read_namespace(target_namespace_id uuid)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_current_user_id() IS NOT NULL
    AND target_namespace_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN actors a        ON a.id = rm.actor_id AND a.kind = 'user'
      WHERE r.namespace_id = target_namespace_id
        AND a.owner_id = app_current_user_id()
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_can_read_namespace(uuid) TO PUBLIC;
--> statement-breakpoint

-- Same SECURITY DEFINER rationale: this function exists specifically
-- to be called from the room_members policy. Without SECURITY DEFINER,
-- the inner SELECT triggers the room_members policy recursively →
-- "infinite recursion detected in policy for relation room_members".
CREATE OR REPLACE FUNCTION app_caller_in_room(target_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_current_user_id() IS NOT NULL
    AND target_room_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM room_members rm
      JOIN actors a ON a.id = rm.actor_id AND a.kind = 'user'
      WHERE rm.room_id = target_room_id
        AND a.owner_id = app_current_user_id()
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_caller_in_room(uuid) TO PUBLIC;
--> statement-breakpoint

-- ============================================================
-- 3. Enable RLS + add policies on the 11 v1 scope tables
-- ============================================================

-- 3.1 memories — Room-membership + agentId content-scope
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c ON memories
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_namespaces mn
      WHERE mn.memory_id = memories.id
        AND app_can_read_namespace(mn.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );

-- 3.2 artifacts — analogous via artifact_namespaces
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c ON artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_path_c ON artifacts
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM artifact_namespaces an
      WHERE an.artifact_id = artifacts.id
        AND app_can_read_namespace(an.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR artifacts.agent_id = app_current_agent_id()
    )
  );

-- 3.3 memory_namespaces — junction; namespace-membership only
ALTER TABLE memory_namespaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS memory_namespaces_path_c ON memory_namespaces;
--> statement-breakpoint
CREATE POLICY memory_namespaces_path_c ON memory_namespaces
  FOR ALL
  USING (app_can_read_namespace(memory_namespaces.namespace_id));

-- 3.4 artifact_namespaces — junction
ALTER TABLE artifact_namespaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS artifact_namespaces_path_c ON artifact_namespaces;
--> statement-breakpoint
CREATE POLICY artifact_namespaces_path_c ON artifact_namespaces
  FOR ALL
  USING (app_can_read_namespace(artifact_namespaces.namespace_id));

-- 3.5 memory_scopes — scope-mode junction; gates via agent_scopes
ALTER TABLE memory_scopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS memory_scopes_path_c ON memory_scopes;
--> statement-breakpoint
CREATE POLICY memory_scopes_path_c ON memory_scopes
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM agent_scopes as_
      WHERE as_.id = memory_scopes.scope_id
        AND as_.speaker_user_id = app_current_user_id()
        AND (app_current_agent_id() IS NULL
             OR as_.parent_agent_id = app_current_agent_id())
    )
  );

-- 3.6 artifact_scopes — analogous to memory_scopes
ALTER TABLE artifact_scopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS artifact_scopes_path_c ON artifact_scopes;
--> statement-breakpoint
CREATE POLICY artifact_scopes_path_c ON artifact_scopes
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM agent_scopes as_
      WHERE as_.id = artifact_scopes.scope_id
        AND as_.speaker_user_id = app_current_user_id()
        AND (app_current_agent_id() IS NULL
             OR as_.parent_agent_id = app_current_agent_id())
    )
  );

-- 3.7 room_members — caller is themselves a member of the same room.
-- Uses app_caller_in_room() (SECURITY DEFINER) to avoid policy
-- recursion: the inline self-join would fire room_members' own policy
-- recursively. The helper bypasses RLS internally.
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS room_members_path_c ON room_members;
--> statement-breakpoint
CREATE POLICY room_members_path_c ON room_members
  FOR ALL
  USING (app_caller_in_room(room_members.room_id));

-- 3.8 agent_scopes — speaker-owned
ALTER TABLE agent_scopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS agent_scopes_path_c ON agent_scopes;
--> statement-breakpoint
CREATE POLICY agent_scopes_path_c ON agent_scopes
  FOR ALL
  USING (
    speaker_user_id = app_current_user_id()
    AND (app_current_agent_id() IS NULL
         OR parent_agent_id = app_current_agent_id())
  );

-- 3.9 credentials — per-row by user_id
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS credentials_self ON credentials;
--> statement-breakpoint
CREATE POLICY credentials_self ON credentials
  FOR ALL
  USING (user_id = app_current_user_id());

-- 3.10 recovery_codes — same shape as credentials
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS recovery_codes_self ON recovery_codes;
--> statement-breakpoint
CREATE POLICY recovery_codes_self ON recovery_codes
  FOR ALL
  USING (user_id = app_current_user_id());

-- 3.11 sessions — Room-membership via sessions.room_id (conversational
--      transcript sessions, NOT auth tokens — auth tokens live on
--      disk in ~/.nautilo/sessions.json, never in this DB)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS sessions_path_c ON sessions;
--> statement-breakpoint
CREATE POLICY sessions_path_c ON sessions
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND (
      sessions.room_id IS NULL  -- legacy session rows without room_id
                                -- attached; visible to authenticated caller
                                -- (auth route shape)
      OR EXISTS (
        SELECT 1 FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        JOIN actors a        ON a.id = rm.actor_id AND a.kind = 'user'
        WHERE r.id = sessions.room_id
          AND a.owner_id = app_current_user_id()
      )
    )
  );

-- ============================================================
-- 4. Force RLS — even for the table owner. Without this, the
--    `nautilo` role (owner) would see all rows; we want the policies
--    enforced uniformly. The owner can still SET ROLE to itself with
--    NOFORCE if a migration needs unrestricted access, OR the owner
--    can use `WITH (security_barrier)` views, OR an admin can run
--    `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` per table.
-- ============================================================
--
-- DEFERRED: we do NOT call ALTER TABLE ... FORCE ROW LEVEL SECURITY
-- in this migration. Reason: forcing RLS for the `nautilo` owner
-- would break server-side auth code that reads credentials WITHOUT
-- setting the trust-context GUC (the auth route resolves the user
-- by email FIRST, then looks up the credential). That refactor is
-- D168 P3 (credentials chokepoint) — once the chokepoint module
-- exists and uses `withTrustContext` internally, we can flip
-- FORCE on credentials + recovery_codes specifically.
--
-- For now: nautilo_agent gets RLS enforcement (it's not the owner);
-- nautilo (the owner) bypasses by default. The D129 P3 GRANT
-- exclusions already prevent nautilo_agent from referencing
-- credentials at all — RLS on credentials is belt-and-suspenders
-- for the case where the auth role ever needs row-level filtering.
