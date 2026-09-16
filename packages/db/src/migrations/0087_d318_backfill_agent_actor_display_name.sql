-- D318 / M156 backfill — repair stale agent-actor display-name cache.
--
-- M156 made `profiles.name` the single source of truth for an agent's name and
-- added `renameAgentProfileIdentity` to sync the agent-kind `actors.display_name`
-- cache on every rename. But M156 shipped no backfill, so agents renamed BEFORE
-- M156 (e.g. a profile renamed to "Alepo" while the actor row still said "Genie")
-- were left permanently out of sync. This repairs them in every environment.
--
-- Direction is intentional: the canonical customized name in `profiles.name`
-- wins; the actor cache is corrected to match it. Agents never renamed keep
-- their seed default ("Genie") because that is also their `profiles.name`.
-- Idempotent (the `<>` guard makes re-runs no-ops) and scoped to agent actors.

UPDATE "actors" AS a
SET "display_name" = p."name",
    "updated_at" = now()
FROM "profiles" AS p
WHERE a."agent_id" = p."agent_id"
  AND a."kind" = 'agent'
  AND a."display_name" <> p."name";
