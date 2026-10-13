import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MEDIA_FUNDING_BINDING_IMMUTABILITY_MARKER =
  "-- MEDIA_GENERATION_FUNDING_BINDING_IMMUTABILITY";
const CUSTOM_MIGRATION_PLACEHOLDER =
  "-- Custom SQL migration file, put your code below! --";

/** Install the SQL-only immutable receipt binding that Drizzle cannot model. */
export function finalizeMediaFundingBindingMigration(migration: string): string {
  if (migration.includes(MEDIA_FUNDING_BINDING_IMMUTABILITY_MARKER)) {
    return migration;
  }
  if (migration.trim() !== CUSTOM_MIGRATION_PLACEHOLDER) {
    throw new Error(
      "Media funding binding finalizer requires the fresh Drizzle-generated custom migration",
    );
  }
  return `${MEDIA_FUNDING_BINDING_IMMUTABILITY_MARKER}
CREATE OR REPLACE FUNCTION "public"."guard_media_generation_funding_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.funding_binding IS DISTINCT FROM OLD.funding_binding THEN
    RAISE EXCEPTION 'Media generation funding binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "media_generation_funding_binding_immutable"
BEFORE UPDATE OF "funding_binding" ON "media_generations"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_media_generation_funding_binding"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_media_generation_funding_binding"()
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(directory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest?.tag.endsWith("_media_generation_funding_binding_immutability")) {
    throw new Error("Latest migration is not the media funding binding custom migration");
  }
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const finalized = finalizeMediaFundingBindingMigration(source);
  if (finalized !== source) writeFileSync(path, finalized);
}
