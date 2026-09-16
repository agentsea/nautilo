-- M246 Wave 1: materialize the two action-admission Capabilities before any
-- production entrance enforces them. Existing rows win so an operator's
-- already-materialized catalogue metadata is never replaced during upgrade.
INSERT INTO "capabilities" ("slug", "description", "category")
VALUES
  (
    'invoke_agents',
    'Start or resume Agent execution through chat, Jobs, Tasks, and schedules.',
    'agents'
  ),
  (
    'write_artifacts',
    'Create or mutate Workspace Artifacts, documents, and mini-app state.',
    'artifacts'
  )
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- Preserve pre-M246 behavior on populated installs. The recurring seed owns
-- the five non-Guest canonical bundles; this one-time migration additionally
-- grants both Capabilities to every custom Role that already exists. A custom
-- Role created after upgrade receives only its explicitly selected bundle.
INSERT INTO "role_capabilities" ("role_id", "capability_id")
SELECT "roles"."id", "capabilities"."id"
FROM "roles"
CROSS JOIN "capabilities"
WHERE "capabilities"."slug" IN ('invoke_agents', 'write_artifacts')
  AND "roles"."slug" <> 'guest'
  AND (
    "roles"."is_system" = false
    OR "roles"."slug" IN (
      'owner',
      'admin',
      'superuser',
      'member',
      'contributor'
    )
  )
ON CONFLICT ("role_id", "capability_id") DO NOTHING;
