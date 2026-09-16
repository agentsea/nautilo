-- D261 Phase 1 (contract slice): add the per-language voice map and backfill
-- the primary from the legacy single-voice columns. The legacy `voice_id` /
-- `voice_name` columns are intentionally NOT dropped here — that happens in the
-- coordinated consumer-cutover migration once all callers read `voices`.
ALTER TABLE "profiles" ADD COLUMN "voices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "profiles"
SET "voices" = jsonb_build_object(
  'default', jsonb_build_object('voiceId', "voice_id", 'voiceName', COALESCE("voice_name", ''))
)
WHERE "voice_id" IS NOT NULL AND ("voices" = '{}'::jsonb OR "voices" IS NULL);