-- M033 Phase 6 / D168 P2.6 follow-up — add a scope-aware branch to the
-- memories SELECT/UPDATE/DELETE policies so scope-mode memories
-- (`saveScopeMemory` etc.) are visible under the narrow `nautilo_agent`
-- role.
--
-- Scope-mode memories attach via `memory_scopes` ONLY; they have no
-- `memory_namespaces` row by design (a scope is the namespace
-- abstraction for subagent-private memory). The 0052 policies only
-- check `memory_namespaces`, so scope memories were structurally
-- invisible to the agent role. The new branch authorises read/edit when
-- the caller owns the parent scope (speaker_user_id + parent_agent_id
-- match the GUCs).
--
-- Originally bundled in 0056, but Drizzle journals migrations by tag —
-- once 0056 had been applied to a cluster as artifacts-only, expanding
-- the file would not re-run it. Splitting Part 2 into its own migration
-- keeps the journal clean and makes the rollout independent.
--
-- INSERT policy from 0052 already only requires `app_current_user_id()`
-- + agent_id match, which is correct for scope-memory creates — we do
-- NOT need to widen it.
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_select ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c_select ON memories
  FOR SELECT
  USING (
    app_current_user_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM memory_namespaces mn
        WHERE mn.memory_id = memories.id
          AND app_can_read_namespace(mn.namespace_id)
      )
      OR EXISTS (
        SELECT 1 FROM memory_scopes ms
        INNER JOIN agent_scopes ags ON ags.id = ms.scope_id
        WHERE ms.memory_id = memories.id
          AND ags.speaker_user_id = app_current_user_id()
          AND ags.parent_agent_id = app_current_agent_id()
      )
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_update ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c_update ON memories
  FOR UPDATE
  USING (
    app_current_user_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM memory_namespaces mn
        WHERE mn.memory_id = memories.id
          AND app_can_read_namespace(mn.namespace_id)
      )
      OR EXISTS (
        SELECT 1 FROM memory_scopes ms
        INNER JOIN agent_scopes ags ON ags.id = ms.scope_id
        WHERE ms.memory_id = memories.id
          AND ags.speaker_user_id = app_current_user_id()
          AND ags.parent_agent_id = app_current_agent_id()
      )
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  )
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM memory_namespaces mn
        WHERE mn.memory_id = memories.id
          AND app_can_read_namespace(mn.namespace_id)
      )
      OR EXISTS (
        SELECT 1 FROM memory_scopes ms
        INNER JOIN agent_scopes ags ON ags.id = ms.scope_id
        WHERE ms.memory_id = memories.id
          AND ags.speaker_user_id = app_current_user_id()
          AND ags.parent_agent_id = app_current_agent_id()
      )
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_delete ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c_delete ON memories
  FOR DELETE
  USING (
    app_current_user_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM memory_namespaces mn
        WHERE mn.memory_id = memories.id
          AND app_can_read_namespace(mn.namespace_id)
      )
      OR EXISTS (
        SELECT 1 FROM memory_scopes ms
        INNER JOIN agent_scopes ags ON ags.id = ms.scope_id
        WHERE ms.memory_id = memories.id
          AND ags.speaker_user_id = app_current_user_id()
          AND ags.parent_agent_id = app_current_agent_id()
      )
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
