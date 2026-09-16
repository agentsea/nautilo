-- D168 P2.6 — split memories Path C policy so INSERT matches write lifecycle.
--
-- `memory-store.saveMemory()` creates the base `memories` row before it can
-- attach `memory_namespaces`. The original FOR ALL policy required the
-- junction to already exist, so RLS rejected legitimate memory writes. Keep
-- namespace-gated visibility for existing rows, but allow the initial INSERT
-- under an authenticated trust context.
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c ON memories;
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_select ON memories;
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_update ON memories;
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_delete ON memories;
--> statement-breakpoint
DROP POLICY IF EXISTS memories_path_c_insert ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c_select ON memories
  FOR SELECT
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_namespaces mn
      WHERE mn.memory_id = memories.id
        AND app_can_read_namespace(mn.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
CREATE POLICY memories_path_c_update ON memories
  FOR UPDATE
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_namespaces mn
      WHERE mn.memory_id = memories.id
        AND app_can_read_namespace(mn.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  )
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_namespaces mn
      WHERE mn.memory_id = memories.id
        AND app_can_read_namespace(mn.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
CREATE POLICY memories_path_c_delete ON memories
  FOR DELETE
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM memory_namespaces mn
      WHERE mn.memory_id = memories.id
        AND app_can_read_namespace(mn.namespace_id)
    )
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
CREATE POLICY memories_path_c_insert ON memories
  FOR INSERT
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND (
      app_current_agent_id() IS NULL
      OR memories.agent_id IS NULL
      OR memories.agent_id = app_current_agent_id()
    )
  );
