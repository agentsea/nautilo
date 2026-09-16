-- M151 (Task Phase 7b) — allow a member AGENT to author a visible transcript
-- session even when the session owner (the requester) is NOT a human member of
-- the room.
--
-- ============================================================
-- IMPORTANT — the drizzle statement-breakpoint markers (see 0050) are
-- LOAD-BEARING. Every CREATE/ALTER/DROP must be followed by a breakpoint
-- marker on its own line, or drizzle migrate() silently records the hash
-- without executing the SQL. (Do NOT write the literal marker token inside
-- this comment — the migrator splits on it and would break this file.)
-- ============================================================
--
-- Context: `ask_peer` sends the REQUESTER's agent into a 1-human-1-agent DM
-- room with a PEER (room owner = peer; members = {requester's agent, peer}).
-- The run posts its question on the DM's bot thread so the peer SEES it as a
-- normal room message. That transcript session is written with
-- `app.current_user_id = <requester>` + `app.current_agent_id = <requester's
-- agent>`, but the requester is NOT a human member of the DM — so the existing
-- `sessions_path_c` human-membership predicate rejected the write.
--
-- Fix: add an agent-membership branch. A session whose `room_id` has the
-- current agent as a room member is authorable/readable by that agent context.
-- This is scoped to `sessions` ONLY (transcripts) — memories / artifacts /
-- credentials policies are untouched. The agent context GUC is set exclusively
-- by trusted server code (the run executor); RLS still catches application
-- bugs + prompt-injection-via-tool-args, not process compromise (see 0050).

-- 1. Agent-in-room predicate (mirrors app_caller_in_room, keyed on the agent).
--    SECURITY DEFINER for the same recursion-break reason as app_caller_in_room.
CREATE OR REPLACE FUNCTION app_agent_in_room(target_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_current_agent_id() IS NOT NULL
    AND target_room_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM room_members rm
      JOIN actors a ON a.id = rm.actor_id AND a.kind = 'agent'
      WHERE rm.room_id = target_room_id
        AND a.agent_id = app_current_agent_id()
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_agent_in_room(uuid) TO PUBLIC;
--> statement-breakpoint

-- 2. Re-create sessions_path_c with the added agent-membership branch.
DROP POLICY IF EXISTS sessions_path_c ON sessions;
--> statement-breakpoint
CREATE POLICY sessions_path_c ON sessions
  FOR ALL
  USING (
    app_current_user_id() IS NOT NULL
    AND (
      sessions.room_id IS NULL  -- legacy session rows without room_id
      OR EXISTS (
        SELECT 1 FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        JOIN actors a        ON a.id = rm.actor_id AND a.kind = 'user'
        WHERE r.id = sessions.room_id
          AND a.owner_id = app_current_user_id()
      )
      -- M151 — the current agent is a member of the session's room (the
      -- ask_peer DM, whose human member is the peer rather than the requester).
      OR app_agent_in_room(sessions.room_id)
    )
  );
