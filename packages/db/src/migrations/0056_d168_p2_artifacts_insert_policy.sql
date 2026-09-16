-- M033 Phase 2C / D168 P2.6 follow-up — split artifacts Path C policy so
-- INSERT matches write lifecycle. Mirrors `0052_d168_p2_memories_insert_policy`.
--
-- `applyWorkspaceArtifactRowChange({mode: "create", ...})` (called from
-- `apply-patch.ts` and `generate-image.ts`) creates the base `artifacts`
-- row before it can attach `artifact_namespaces`. The original FOR ALL
-- policy required the junction to already exist, so RLS rejected
-- legitimate artifact writes once the runtime moved to the narrow
-- `nautilo_agent` role under M033 Phase 2C.
--
-- Keep namespace-gated visibility for existing rows; allow the initial
-- INSERT under an authenticated trust context with matching agent_id.
--
-- `artifacts.agent_id` is NOT NULL (vs `memories.agent_id` nullable for
-- legacy seeds), so the agent guard is the 2-way form from 0050 — no
-- `agent_id IS NULL` branch.
--
-- Companion fix in agent code: `applyWorkspaceArtifactRowChange` now
-- generates `crypto.randomUUID()` client-side and passes it to
-- `insertArtifact` so the INSERT skips RETURNING. PostgreSQL evaluates
-- the SELECT-policy USING clause on `INSERT ... RETURNING`, which would
-- still require the namespace junction (race condition: junction row
-- only inserted in the next statement). Mirrors `memory-store.saveMemory`.
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c ON artifacts;
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c_select ON artifacts;
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c_update ON artifacts;
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c_delete ON artifacts;
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_path_c_insert ON artifacts;
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
    AND (
      app_current_agent_id() IS NULL
      OR artifacts.agent_id = app_current_agent_id()
    )
  );
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
    AND (
      app_current_agent_id() IS NULL
      OR artifacts.agent_id = app_current_agent_id()
    )
  )
  WITH CHECK (
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
    AND (
      app_current_agent_id() IS NULL
      OR artifacts.agent_id = app_current_agent_id()
    )
  );
--> statement-breakpoint
CREATE POLICY artifacts_path_c_insert ON artifacts
  FOR INSERT
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND (
      app_current_agent_id() IS NULL
      OR artifacts.agent_id = app_current_agent_id()
    )
  );
