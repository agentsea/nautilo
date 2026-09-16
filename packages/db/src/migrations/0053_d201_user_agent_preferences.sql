-- D201 (Stack 26) — per-viewer presentation preferences on REL-AGT-HUM.
--
-- Canonical Agent Profile lives in `profiles` (GLOSSARY/AGT). This table
-- decorates the Human↔Agent edge with personal Subject-owned presentation
-- overrides (voice, avatar, display name) — it never forks or mutates Agent
-- identity (D140: "Agent is a slot, customize in place").
--
-- RLS: D168 Path C trust-context helper `app_current_user_id()` (migration
-- 0050). FORCE ROW LEVEL SECURITY per D168 P3 contract — even the table
-- owner is subject to per-row isolation. Only the subject Human
-- (user_id = app_current_user_id()) may read/write their row; Agent owner
-- role (REL-HUM-ROL) does NOT grant cross-row access to other users' prefs.
--
-- voice_id has no FK — voices are validated at API time against
-- @nautilo/voice, not first-class DB entities.
--
-- ============================================================
-- IMPORTANT: the statement-breakpoint markers below are LOAD-BEARING.
-- See migration #47 / #50 prologue for the Drizzle-migrator silent-no-op
-- story. Don't strip these markers.
-- ============================================================

CREATE TABLE user_agent_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  voice_id varchar(100),
  voice_name varchar(100),
  avatar_ref jsonb,
  display_name_override varchar(100),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);
--> statement-breakpoint

CREATE INDEX idx_user_agent_preferences_user_id ON user_agent_preferences(user_id);
--> statement-breakpoint

CREATE INDEX idx_user_agent_preferences_agent_id ON user_agent_preferences(agent_id);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_agent_preferences TO nautilo_agent;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE user_agent_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE user_agent_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY user_agent_preferences_select ON user_agent_preferences
  FOR SELECT
  USING (
    app_current_user_id() IS NOT NULL
    AND user_id = app_current_user_id()
  );
--> statement-breakpoint

CREATE POLICY user_agent_preferences_insert ON user_agent_preferences
  FOR INSERT
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND user_id = app_current_user_id()
  );
--> statement-breakpoint

CREATE POLICY user_agent_preferences_update ON user_agent_preferences
  FOR UPDATE
  USING (
    app_current_user_id() IS NOT NULL
    AND user_id = app_current_user_id()
  )
  WITH CHECK (
    app_current_user_id() IS NOT NULL
    AND user_id = app_current_user_id()
  );
--> statement-breakpoint

CREATE POLICY user_agent_preferences_delete ON user_agent_preferences
  FOR DELETE
  USING (
    app_current_user_id() IS NOT NULL
    AND user_id = app_current_user_id()
  );
