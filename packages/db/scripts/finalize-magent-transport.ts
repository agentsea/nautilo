import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeBolterReviewedShareMigration } from "./finalize-bolter-reviewed-share";

export const MAGENT_TRANSPORT_MARKER = "-- EXTERNAL_OPERATOR_TRANSPORT_IDENTITY";
/** Extend the existing qualified final-reply guard without replacing its causality checks. */
export function finalizeMagentTransportMigration(source: string): string {
  if (source.includes(MAGENT_TRANSPORT_MARKER) || !source.includes('ADD COLUMN "transport_kind"')) return source;
  const qualified = finalizeBolterReviewedShareMigration('CREATE TABLE "bolter_explicit_shares" ("id" uuid);');
  const start = qualified.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()");
  const end = qualified.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error("Canonical reply guard unavailable");
  const guard = qualified.slice(start, end + 3).replace("jsonb_build_object('kind','bolter_final_reply_v1',",
    "jsonb_build_object('kind',CASE WHEN b.provider = 'bolter' THEN 'bolter_final_reply_v1' ELSE 'external_room_final_reply_v1' END,");
  if (!guard.includes("CASE WHEN b.provider")) throw new Error("Canonical provider guard unavailable");
  return `${source}\n--> statement-breakpoint\n${MAGENT_TRANSPORT_MARKER}
CREATE OR REPLACE FUNCTION public.guard_external_binding_provider()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bolter_connections c WHERE c.id = NEW.connection_id
    AND c.user_id = NEW.user_id AND c.provider = NEW.provider) THEN
    RAISE EXCEPTION 'External provider identity mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_binding_provider() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_binding_provider BEFORE INSERT OR UPDATE ON public.bolter_room_bindings
FOR EACH ROW EXECUTE FUNCTION public.guard_external_binding_provider();--> statement-breakpoint
REVOKE TRIGGER ON TABLE public.bolter_room_bindings FROM nautilo;--> statement-breakpoint
${guard}\n`;
}

export const MAGENT_SESSION_MARKER = "-- EXTERNAL_OPERATOR_SESSION_FENCE";
export function finalizeMagentSessionsMigration(source: string): string {
  if (source.includes(MAGENT_SESSION_MARKER) || !source.includes('CREATE TABLE "external_operator_sessions"')) return source;
  const fk = 'ALTER TABLE "external_operator_sessions" ADD CONSTRAINT "external_operator_sessions_binding_owner"';
  const prefix = source.replace(fk, `GRANT REFERENCES(user_id,id) ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint\n${fk}`);
  if (prefix === source) throw new Error("Operator session owner FK unavailable");
  return `${prefix}\n--> statement-breakpoint\n${MAGENT_SESSION_MARKER}
REVOKE REFERENCES(user_id,id) ON TABLE public.bolter_room_bindings FROM nautilo;--> statement-breakpoint
ALTER TABLE public.external_operator_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.external_operator_sessions FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.external_operator_sessions TO nautilo_agent;--> statement-breakpoint
GRANT SELECT(user_id,binding_id), UPDATE(binding_id), DELETE ON TABLE public.external_operator_sessions TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_operator_session()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.bolter_room_bindings b WHERE b.id = NEW.binding_id
      AND b.user_id = NEW.user_id AND b.provider = 'magent' AND b.state = 'active') THEN
    RAISE EXCEPTION 'External operator context is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_operator_session() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.external_operator_sessions TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_operator_session_immutable BEFORE INSERT OR UPDATE ON public.external_operator_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_external_operator_session();--> statement-breakpoint
REVOKE TRIGGER ON TABLE public.external_operator_sessions FROM nautilo;\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const schema = source.includes(MAGENT_TRANSPORT_MARKER)
    ? source.slice(0, source.indexOf(MAGENT_TRANSPORT_MARKER)).replace(/\n--> statement-breakpoint\n$/u, "") : source;
  const result = finalizeMagentSessionsMigration(finalizeMagentTransportMigration(schema));
  if (result !== source) writeFileSync(path, result);
}
