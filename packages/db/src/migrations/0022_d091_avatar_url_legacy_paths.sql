-- D091 — rewrite stored avatar_url values from the legacy
-- /setup/images/... Fastify route to the canonical post-greenfield
-- /api/onboarding/images/... path.
--
-- Why this migration exists: D091's greenfield removal deleted the
-- /setup/ Fastify static mount (the legacy onboarding wizard's
-- index.html + image + audio routes). Profiles created against the
-- pre-D091 server still have absolute paths pointing at the
-- now-404 route. Without this migration, every workbench surface
-- that renders profile.avatarUrl (most visibly the right-side
-- context-panel.tsx) would show a broken image.
--
-- Greenfield principle: data should be canonical. A client-side
-- compatibility shim that rewrites the URL at read time would
-- still leave the legacy URL stored in the database — i.e. a
-- legacy pathway at the data layer. The migration moves the
-- canonical storage to match the canonical routes.
--
-- Idempotent across all targets:
--   - Local dev DB (pre-D091): updates rows that match.
--   - A database with no legacy avatar paths: 0 rows updated.
--   - CI fresh DB:                                 0 rows updated.
--   - Future production:                           0 rows updated.
--
-- avatar_url is the only URL-typed column in profiles. soulFile is
-- markdown content; voiceName / voiceId / defaultModel are slug
-- identifiers; nothing else stores a path. The sweep is one column.
--
-- Pre-flight sanity: count + log how many rows we're about to
-- migrate so the operator can verify post-apply that the count
-- matches their expectation (especially relevant for shared dev
-- DBs that might have multiple developer profiles).

DO $$
DECLARE
  affected bigint;
BEGIN
  SELECT count(*) INTO affected
    FROM profiles
    WHERE avatar_url LIKE '/setup/images/%';
  RAISE NOTICE 'D091 avatar_url migration: % row(s) to rewrite', affected;
END $$;
--> statement-breakpoint

UPDATE profiles
SET avatar_url = REPLACE(
  avatar_url,
  '/setup/images/',
  '/api/onboarding/images/'
)
WHERE avatar_url LIKE '/setup/images/%';
