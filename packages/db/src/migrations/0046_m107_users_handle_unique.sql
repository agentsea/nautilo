-- M107 Phase 2c — partial unique index enforcing handle uniqueness
-- among LOCAL Humans (server IS NULL). Mirrors the M051 pattern used
-- for `users.external_id`. This finally implements the follow-up
-- migration the M042C schema comment punted on
-- (packages/db/src/schema/users.ts).
--
-- Predicate notes:
--   - `server IS NULL` → local Human. Foreign stubs (M047,
--     server IS NOT NULL) may carry duplicate handle strings against
--     their respective remote servers; the proper shape there is
--     `UNIQUE(handle, server)` and that's deferred to the Iteration-5
--     federation pass.
--   - `handle IS NOT NULL` → pre-onboarding / pre-M042C rows where
--     handle hasn't been backfilled yet do not participate in
--     uniqueness, so this migration won't fail on legacy NULL rows.
--
-- Drizzle-kit doesn't round-trip partial-index predicates as of the
-- pinned version, so this index lives outside the generated migration
-- pipeline (same pattern as `users_external_id_unique` in
-- 0021_m051_add_users_external_id.sql).
--
-- Upgrade ordering invariant: `bin/nautilo-dev migrate-to-username-identity --apply`
-- MUST run before this migration on an existing install. The migration
-- command's pre-flight collision scan catches duplicate handles and
-- requires the operator to reconcile them BEFORE `db:migrate` lands
-- this index. See playbook/logto-operations.md "Upgrade install" sequence.
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_unique_local"
  ON "users" ("handle")
  WHERE "server" IS NULL AND "handle" IS NOT NULL;
