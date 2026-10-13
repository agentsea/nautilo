import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeBolterBridgeMigration } from "./finalize-bolter-bridge";

export const BOLTER_FACTORY_MARKER = "-- BOLTER_FACTORY_PRODUCT_AUTHORITY";
export const BOLTER_FK_MARKER = "Bolter owner deletion and FK maintenance";

/** Column privileges support PostgreSQL's owner-run FK checks, not state writes. */
export function finalizeBolterForeignKeyMigration(source: string): string {
  if (source.includes(BOLTER_FK_MARKER)) return source;
  return `${source}\n-- ${BOLTER_FK_MARKER}
GRANT SELECT(id,user_id,binding_id,session_message_id,job_id), UPDATE(id)
  ON TABLE public.bolter_inbox_receipts TO nautilo;--> statement-breakpoint
GRANT SELECT(user_id,binding_id,source_inbox_id,session_message_id), UPDATE(id)
  ON TABLE public.bolter_outbox TO nautilo;--> statement-breakpoint
GRANT UPDATE(id) ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
GRANT DELETE ON TABLE public.bolter_outbox, public.bolter_inbox_receipts,
  public.bolter_room_bindings, public.bolter_connections TO nautilo;--> statement-breakpoint
COMMENT ON TABLE public.bolter_connections IS '${BOLTER_FK_MARKER}';\n`;
}

/** Correct the factory without changing an already applied initial migration. */
export function finalizeBolterFactoryMigration(source: string): string {
  if (source.includes(BOLTER_FACTORY_MARKER) || !source.includes('"bolter_connections"')
    || !source.includes('"bolter_room_bindings"') || !(source.includes("ALTER POLICY") || source.includes("CREATE POLICY"))) return source;
  const original = finalizeBolterBridgeMigration('CREATE TABLE "bolter_connections" (id uuid);');
  const body = (name: string) => {
    const start = original.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
    const end = original.indexOf("$$;--> statement-breakpoint", start);
    if (start < 0 || end < 0) throw new Error("Bolter original guard source is unavailable");
    return original.slice(start, end + 3);
  };
  const ownerCheck = `BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;`;
  const connection = body("guard_bolter_connection").replace("BEGIN", ownerCheck);
  const binding = body("guard_bolter_binding")
    .replace("; minted_room boolean; minted_namespace boolean", "")
    .replace("BEGIN", ownerCheck)
    .replace(/ {4}SELECT xmin::text::numeric = mod\(pg_current_xact_id\(\)::text::numeric, 4294967296\)\n {6}INTO minted_room FROM public\.rooms WHERE id = NEW\.room_id;\n {4}SELECT xmin::text::numeric = mod\(pg_current_xact_id\(\)::text::numeric, 4294967296\)\n {6}INTO minted_namespace FROM public\.namespaces WHERE id = NEW\.namespace_id;\n/u, "")
    .replace(" OR NOT coalesce(minted_room, false) OR NOT coalesce(minted_namespace, false)", "");
  if (binding.includes("minted_room") || binding.includes("pg_current_xact_id")) throw new Error("Bolter transaction heuristic was not removed");
  return `${source}\n--> statement-breakpoint\n${BOLTER_FACTORY_MARKER}
-- The trusted product factory mints canonical Room membership. Its role has
-- BYPASSRLS; explicit owner query predicates and these GUC mutation guards
-- enforce its boundary. Agent table access remains owner-RLS restricted.
GRANT SELECT, UPDATE ON TABLE public.bolter_connections TO nautilo;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
${connection}--> statement-breakpoint
-- xmin is not mint provenance and fails for legitimate savepoint inserts.
-- The server-owned canonical creation callback establishes freshness.
${binding}\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const result = process.argv.includes("--fk-permissions")
    ? finalizeBolterForeignKeyMigration(source) : finalizeBolterFactoryMigration(source);
  if (result !== source) writeFileSync(path, result);
}
