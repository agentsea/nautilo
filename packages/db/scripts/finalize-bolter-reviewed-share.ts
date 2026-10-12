import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeBolterExecutionMigration } from "./finalize-bolter-execution";

export const BOLTER_REVIEWED_SHARE_MARKER = "-- BOLTER_REVIEWED_HUMAN_SHARE";
export function finalizeBolterReviewedShareMigration(source: string): string {
  if (source.includes(BOLTER_REVIEWED_SHARE_MARKER) || !source.includes('CREATE TABLE "bolter_explicit_shares"')) return source;
  const existing = finalizeBolterExecutionMigration('ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;');
  const start = existing.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()");
  const end = existing.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error("Canonical reply guard unavailable");
  const grantCheck = `
    IF NEW.explicit_share_id IS NOT NULL THEN
      IF NEW.source_inbox_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM public.bolter_explicit_shares g
        JOIN public.bolter_room_bindings share_binding ON share_binding.id = g.binding_id AND share_binding.user_id = g.user_id
        JOIN public.session_messages m ON m.id = g.session_message_id
        JOIN public.sessions s ON s.id = m.session_id
        WHERE g.id = NEW.explicit_share_id AND g.user_id = NEW.user_id AND g.binding_id = NEW.binding_id
          AND g.binding_revision = NEW.binding_revision AND g.connection_generation = NEW.connection_generation
          AND g.session_message_id = NEW.session_message_id AND g.fingerprint = NEW.fingerprint
          AND s.owner_id = g.user_id AND s.room_id = share_binding.room_id AND s.agent_id = share_binding.agent_id
          AND m.role = 'user' AND NOT m.external_authorship AND m.transcript_origin = 'main'
          AND m.content IS NOT NULL AND btrim(m.content) <> '' AND m.tool_calls IS NULL AND m.tool_name IS NULL
          AND m.fingerprint = g.fingerprint AND m.human_turn_id IS NOT NULL
          AND NOT (coalesce(m.metadata, '{}'::jsonb) ?| ARRAY['externalOrigin','externalReceiptId'])
          AND m.metadata->'bolterReviewedShare' = jsonb_build_object('shareId',g.id::text,'requestId',g.request_id::text)
      ) THEN RAISE EXCEPTION 'Bolter reviewed share mismatch' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END IF;`;
  const guard = existing.slice(start, end + 3).replace("    IF NEW.source_inbox_id IS NULL OR NEW.explicit_share_id IS NOT NULL THEN", `${grantCheck}\n    IF NEW.source_inbox_id IS NULL THEN`);
  return `${source}\n--> statement-breakpoint\n${BOLTER_REVIEWED_SHARE_MARKER}
ALTER TABLE public.bolter_explicit_shares FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.bolter_explicit_shares FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.bolter_explicit_shares TO nautilo_agent;--> statement-breakpoint
GRANT SELECT(id,user_id,binding_id,session_message_id), UPDATE(id), DELETE ON TABLE public.bolter_explicit_shares TO nautilo;--> statement-breakpoint
GRANT SELECT(explicit_share_id) ON TABLE public.bolter_outbox TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_reviewed_share()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Bolter reviewed share is immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM public.bolter_assert_current_binding(NEW.user_id,NEW.binding_id,NEW.binding_revision,NEW.connection_generation);
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_bolter_reviewed_share() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER bolter_reviewed_share_authority BEFORE INSERT OR UPDATE ON public.bolter_explicit_shares
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_reviewed_share();--> statement-breakpoint
${guard}\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const qualified = finalizeBolterReviewedShareMigration('CREATE TABLE "bolter_explicit_shares" ("id" uuid);');
  const correction = process.argv.includes("--guard-correction");
  const start = qualified.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()");
  const result = correction && !source.includes("CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()")
    ? `${source}\n--> statement-breakpoint\n${qualified.slice(start)}` : correction ? source : finalizeBolterReviewedShareMigration(source);
  if (result !== source) writeFileSync(path, result);
}
