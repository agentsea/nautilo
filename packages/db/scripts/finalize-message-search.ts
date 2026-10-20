import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const marker = "-- SESSION_MESSAGE_SEARCH_OVERFLOW";

/** Preserve existing vectors when replacing generated derivation with a safe trigger. */
export function finalizeMessageSearchMigration(migration: string): string {
  if (!migration.includes('ALTER TABLE "session_messages" ALTER COLUMN "content_search" DROP EXPRESSION')
    || migration.includes(marker)) return migration;
  return `${migration}\n--> statement-breakpoint\n${marker}
CREATE FUNCTION public.refresh_session_message_search()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.content, NEW.content_search) IS NOT DISTINCT FROM ROW(OLD.content, OLD.content_search) THEN
      RETURN NEW;
    END IF;
  END IF;
  BEGIN
    NEW.content_search := to_tsvector('pg_catalog.english'::regconfig, NEW.content);
  EXCEPTION WHEN SQLSTATE '54000' THEN
    -- Do not hide other program-limit failures or abort the enclosing save.
    IF SQLERRM NOT LIKE 'string is too long for tsvector (% bytes, max % bytes)' THEN
      RAISE;
    END IF;
    NEW.content_search := NULL;
  END;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_message_content_search
BEFORE INSERT OR UPDATE ON public.session_messages
FOR EACH ROW EXECUTE FUNCTION public.refresh_session_message_search();\n`;
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
  const result = finalizeMessageSearchMigration(source);
  if (result !== source) writeFileSync(path, result);
}
