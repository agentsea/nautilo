import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const marker = "-- CONTENT_ACCESS_OPERATIONS_AUTHORITY";
const immutabilityMarker = "-- CONTENT_ACCESS_OPERATIONS_IMMUTABILITY";

/** The application role has BYPASSRLS: terminal facts also need a trigger guard. */
export function finalizeContentAccessReceiptImmutability(migration: string): string {
  if (migration.includes(immutabilityMarker)) return migration;
  return `${migration}\n--> statement-breakpoint\n${immutabilityMarker}
CREATE OR REPLACE FUNCTION "public"."guard_content_access_receipt"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Content access receipts are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF (OLD.memory_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.memories WHERE id = OLD.memory_id
    )) OR (OLD.artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.artifacts WHERE id = OLD.artifact_id
    )) THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'requester_user_id' - 'requester_actor_id')
       IS NOT DISTINCT FROM (to_jsonb(OLD) - 'requester_user_id' - 'requester_actor_id')
      AND (NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
        OR NEW.requester_actor_id IS DISTINCT FROM OLD.requester_actor_id)
      AND (NEW.requester_user_id IS NOT DISTINCT FROM OLD.requester_user_id
        OR (OLD.requester_user_id IS NOT NULL AND NEW.requester_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = OLD.requester_user_id)))
      AND (NEW.requester_actor_id IS NOT DISTINCT FROM OLD.requester_actor_id
        OR (OLD.requester_actor_id IS NOT NULL AND NEW.requester_actor_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.actors WHERE id = OLD.requester_actor_id)))
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Content access receipts are immutable' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
GRANT TRIGGER ON TABLE "content_access_operations" TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "content_access_receipt_immutable_row"
BEFORE UPDATE OR DELETE ON "content_access_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_content_access_receipt"();--> statement-breakpoint
CREATE TRIGGER "content_access_receipt_immutable_table"
BEFORE TRUNCATE ON "content_access_operations"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_content_access_receipt"();--> statement-breakpoint
REVOKE TRIGGER ON TABLE "content_access_operations" FROM "nautilo";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_content_access_receipt"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";\n`;
}

/** Drizzle owns tables/policies; FORCE RLS and role privileges require SQL. */
export function finalizeContentAccessOperationsMigration(migration: string): string {
  if (!migration.includes('CREATE TABLE "content_access_operations"')
    || migration.includes(marker)) return migration;
  return `${migration}\n--> statement-breakpoint\n${marker}
ALTER TABLE "content_access_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "content_access_operations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "content_access_operations" FROM "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "content_access_operations" TO "nautilo";\n`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(root, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const result = process.argv.includes("--immutability")
    ? finalizeContentAccessReceiptImmutability(source)
    : finalizeContentAccessOperationsMigration(source);
  if (result !== source) writeFileSync(path, result);
}
