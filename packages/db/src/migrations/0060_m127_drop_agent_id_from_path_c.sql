-- M127 — Namespace is the only content-scope axis for memories + artifacts.
--
-- Drops the `app_current_agent_id()` trailer from every Path C policy on
-- `memories` and `artifacts`. Before M127, the policy AND'd an agent-narrowing
-- clause (`app_current_agent_id() IS NULL OR <table>.agent_id = ...`) so two
-- Agents in the same Room could not see each other's content even when they
-- co-host the same Namespace. After M127, Namespace membership is the only
-- DB-enforced boundary — sharing-via-Namespace becomes the only sharing
-- primitive.
--
-- Companion migration: 0060_m127_drop_agent_id_from_memories_and_artifacts.sql
-- drops `memories.agent_id` + `artifacts.agent_id` columns. This file MUST
-- be applied after 0060 (the policies below cannot reference dropped
-- columns).
--
-- Memories: preserves the scope-mode branch from 0057 (memory_scopes +
-- agent_scopes EXISTS subquery). Scope isolation continues to be enforced
-- via that branch — only the outer agent_id trailer is removed.
--
-- Artifacts: preserves the namespace EXISTS predicate; no scope branch on
-- the artifacts policies historically.
--
--
-- ============================================================
-- IMPORTANT — statement-breakpoint markers are LOAD-BEARING.
-- See header of 0050_d168_p2_rls_path_c.sql for the full rationale.
-- ============================================================
--> statement-breakpoint

-- ============================================================
-- memories — namespace + scope; no agent trailer
-- ============================================================
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
  );
--> statement-breakpoint

DROP POLICY IF EXISTS memories_path_c_insert ON memories;
--> statement-breakpoint
CREATE POLICY memories_path_c_insert ON memories
  FOR INSERT
  WITH CHECK (
    app_current_user_id() IS NOT NULL
  );
--> statement-breakpoint

-- ============================================================
-- artifacts — namespace only; no agent trailer
-- ============================================================
DROP POLICY IF EXISTS artifacts_path_c_select ON artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_path_c_select ON artifacts
  FOR SELECT
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM artifact_namespaces an
      WHERE an.artifact_id = artifacts.id
        AND app_can_read_namespace(an.namespace_id)
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS artifacts_path_c_update ON artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_path_c_update ON artifacts
  FOR UPDATE
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM artifact_namespaces an
      WHERE an.artifact_id = artifacts.id
        AND app_can_read_namespace(an.namespace_id)
    )
  )
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM artifact_namespaces an
      WHERE an.artifact_id = artifacts.id
        AND app_can_read_namespace(an.namespace_id)
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS artifacts_path_c_delete ON artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_path_c_delete ON artifacts
  FOR DELETE
  USING (
    app_current_user_id() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM artifact_namespaces an
      WHERE an.artifact_id = artifacts.id
        AND app_can_read_namespace(an.namespace_id)
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS artifacts_path_c_insert ON artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_path_c_insert ON artifacts
  FOR INSERT
  WITH CHECK (
    app_current_user_id() IS NOT NULL
  );
