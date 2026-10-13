import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const BOLTER_BRIDGE_MARKER = "-- BOLTER_BRIDGE_AUTHORITY_AND_LIFECYCLE";
export const BOLTER_BRIDGE_TABLES = ["bolter_connections", "bolter_room_bindings", "bolter_inbox_receipts", "bolter_outbox"] as const;

/**
 * Drizzle owns tables/FKs/policies; forced RLS and lifecycle triggers need finalization.
 * xmin only proves insertion OR update in the current transaction. Freshness is
 * established by the sole query API's canonical Room/namespace creation factory;
 * SQL adds empty-context and transaction checks, not an independent mint receipt.
 */
export function finalizeBolterBridgeMigration(source: string): string {
  if (source.includes(BOLTER_BRIDGE_MARKER) || !source.includes('CREATE TABLE "bolter_connections"')) return source;
  const grants = BOLTER_BRIDGE_TABLES.map(table => `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "nautilo_agent";`).join("\n--> statement-breakpoint\n");
  return `${source}\n--> statement-breakpoint\n${BOLTER_BRIDGE_MARKER}\n${grants}
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.bolter_room_admission(p_user uuid, p_room uuid, p_namespace uuid, p_agent uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid = p_user AND EXISTS (
    SELECT 1 FROM public.rooms r JOIN public.users u ON u.id = p_user
    WHERE r.id = p_room AND r.namespace_id = p_namespace AND r.owner_id = p_user
      AND r.external_context AND r.kind = 'private' AND r.archived_at IS NULL AND u.disabled_at IS NULL
      AND public.moderation_access_allowed(u.id, r.id)
      AND EXISTS (SELECT 1 FROM public.room_members m JOIN public.actors a ON a.id = m.actor_id
        WHERE m.room_id = r.id AND a.kind = 'user' AND a.owner_id = p_user)
      AND EXISTS (SELECT 1 FROM public.room_members m JOIN public.actors a ON a.id = m.actor_id
        WHERE m.room_id = r.id AND a.kind = 'agent' AND a.agent_id = p_agent)
  );
$$;--> statement-breakpoint
ALTER FUNCTION public.bolter_room_admission(uuid,uuid,uuid,uuid) OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bolter_room_admission(uuid,uuid,uuid,uuid) FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bolter_room_admission(uuid,uuid,uuid,uuid) TO nautilo_agent;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.bolter_assert_current_binding(p_user uuid, p_binding uuid, p_revision integer, p_generation integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; c public.bolter_connections%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = p_binding AND user_id = p_user;
  SELECT * INTO c FROM public.bolter_connections WHERE id = b.connection_id AND user_id = p_user FOR UPDATE;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = p_binding AND user_id = p_user FOR UPDATE;
  IF c.id IS NULL OR b.id IS NULL OR NOT c.enabled OR c.revoked_at IS NOT NULL
    OR c.generation <> p_generation OR b.revision <> p_revision OR b.state <> 'active'
    OR NOT coalesce(public.bolter_room_admission(p_user, b.room_id, b.namespace_id, b.agent_id), false)
    THEN RAISE EXCEPTION 'Bolter binding authority unavailable' USING ERRCODE = '23514'; END IF;
END; $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_room_context()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.external_context IS DISTINCT FROM NEW.external_context THEN
    RAISE EXCEPTION 'External Room context is immutable from creation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER bolter_room_context_immutable BEFORE UPDATE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_room_context();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_connection()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation <> 1 OR NEW.revision <> 0 OR NOT NEW.enabled OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial Bolter connection' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(OLD) - ARRAY['desktop_session_id','pairing_generation_ref','generation','revision','enabled','revoked_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['desktop_session_id','pairing_generation_ref','generation','revision','enabled','revoked_at','updated_at'])
      OR OLD.revoked_at IS NOT NULL OR NEW.generation <> OLD.generation + 1 OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Bolter connection identity or generation is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER bolter_connection_lifecycle BEFORE INSERT OR UPDATE ON public.bolter_connections
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_connection();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE c public.bolter_connections%ROWTYPE; r public.rooms%ROWTYPE; minted_room boolean; minted_namespace boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','revision','updated_at'])
      OR OLD.state = 'revoked' OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Bolter binding routing coordinates are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.revision <> 0 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'Invalid initial Bolter binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO c FROM public.bolter_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM public.rooms WHERE id = NEW.room_id AND namespace_id = NEW.namespace_id FOR UPDATE;
    SELECT xmin::text::numeric = mod(pg_current_xact_id()::text::numeric, 4294967296)
      INTO minted_room FROM public.rooms WHERE id = NEW.room_id;
    SELECT xmin::text::numeric = mod(pg_current_xact_id()::text::numeric, 4294967296)
      INTO minted_namespace FROM public.namespaces WHERE id = NEW.namespace_id;
    IF r.id IS NULL OR r.owner_id <> NEW.user_id OR NOT r.external_context OR r.kind <> 'private'
      OR r.archived_at IS NOT NULL OR NOT coalesce(minted_room, false) OR NOT coalesce(minted_namespace, false)
      OR EXISTS (SELECT 1 FROM public.sessions s JOIN public.session_messages m ON m.session_id = s.id WHERE s.room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_events WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_event_rollups WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_batches WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_state WHERE room_id = r.id AND last_processed_message_id <> 0) THEN
      RAISE EXCEPTION 'Bolter binding requires a factory-created empty external Room and namespace' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF c.id IS NULL OR NOT c.enabled OR c.revoked_at IS NOT NULL OR c.origin <> NEW.origin OR c.provider_agent_id <> NEW.provider_agent_id
      OR NOT coalesce(public.bolter_room_admission(NEW.user_id, NEW.room_id, NEW.namespace_id, NEW.agent_id), false) THEN
      RAISE EXCEPTION 'Bolter sponsor or Genie membership unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER bolter_binding_lifecycle BEFORE INSERT OR UPDATE ON public.bolter_room_bindings
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_binding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_inbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.session_message_id IS NOT NULL OR NEW.turn_id IS NOT NULL OR NEW.job_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bolter receipt requires canonical acceptance' USING ERRCODE = '23514';
    END IF;
    PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
  ELSE
    IF (to_jsonb(OLD) - ARRAY['session_message_id','turn_id','job_id','state','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['session_message_id','turn_id','job_id','state','updated_at'])
      OR (OLD.session_message_id IS NOT NULL AND OLD.session_message_id IS DISTINCT FROM NEW.session_message_id)
      OR (OLD.turn_id IS NOT NULL AND OLD.turn_id IS DISTINCT FROM NEW.turn_id)
      OR (OLD.job_id IS NOT NULL AND OLD.job_id IS DISTINCT FROM NEW.job_id)
      OR (OLD.state IN ('quarantined','cancelled') AND NEW.state NOT IN (OLD.state,'quarantined'))
      OR (OLD.state = 'accepted' AND NEW.state = 'pending') THEN
      RAISE EXCEPTION 'Bolter receipt identity or lifecycle is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'accepted' THEN
      PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
    END IF;
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
  IF NEW.session_message_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.session_message_id IS DISTINCT FROM NEW.session_message_id OR OLD.turn_id IS DISTINCT FROM NEW.turn_id) AND NOT EXISTS (
    SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.session_message_id AND s.owner_id = NEW.user_id AND s.room_id = b.room_id
      AND s.agent_id = b.agent_id AND m.role = 'user' AND m.human_turn_id = NEW.turn_id
  ) THEN RAISE EXCEPTION 'Bolter receipt canonical message mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW.job_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.job_id IS DISTINCT FROM NEW.job_id) AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = NEW.job_id
    AND j.owner_id = NEW.user_id AND j.requestor_id = NEW.user_id AND j.room_id = b.room_id) THEN
    RAISE EXCEPTION 'Bolter receipt job ownership mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER bolter_inbox_lifecycle BEFORE INSERT OR UPDATE ON public.bolter_inbox_receipts
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_inbox();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_outbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.claim_token IS NOT NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial Bolter publication' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(OLD) - ARRAY['state','claim_token','provider_message_id','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['state','claim_token','provider_message_id','updated_at'])
      OR (OLD.claim_token IS NOT NULL AND OLD.claim_token IS DISTINCT FROM NEW.claim_token)
      OR NOT ((OLD.state = 'pending' AND NEW.state IN ('publishing','cancelled'))
        OR (OLD.state = 'publishing' AND NEW.state IN ('published','uncertain','cancelled'))) THEN
      RAISE EXCEPTION 'Bolter publication is terminal or immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('pending','publishing','published') THEN
    PERFORM public.bolter_assert_current_binding(NEW.user_id, NEW.binding_id, NEW.binding_revision, NEW.connection_generation);
    IF NEW.source_inbox_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i
      WHERE i.id = NEW.source_inbox_id AND i.user_id = NEW.user_id AND i.binding_id = NEW.binding_id
        AND i.state = 'accepted' AND i.binding_revision = NEW.binding_revision AND i.connection_generation = NEW.connection_generation) THEN
      RAISE EXCEPTION 'Bolter reply receipt unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
  IF NEW.state IN ('pending','publishing','published') AND NOT EXISTS (SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id = m.session_id
    WHERE m.id = NEW.session_message_id AND s.owner_id = NEW.user_id AND s.room_id = b.room_id AND s.agent_id = b.agent_id
      AND (NEW.explicit_share_id IS NOT NULL OR m.role = 'assistant')) THEN
    RAISE EXCEPTION 'Bolter publication canonical message mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER bolter_outbox_lifecycle BEFORE INSERT OR UPDATE ON public.bolter_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_outbox();--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bolter_assert_current_binding(uuid,uuid,integer,integer) FROM PUBLIC, nautilo, nautilo_crypto;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bolter_assert_current_binding(uuid,uuid,integer,integer) TO nautilo_agent;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_bolter_room_context(), public.guard_bolter_connection(), public.guard_bolter_binding(), public.guard_bolter_inbox(), public.guard_bolter_outbox()
FROM PUBLIC, nautilo_agent, nautilo_crypto;\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  // Only refresh our appended finalization; retain Drizzle's generated prefix verbatim.
  const boundary = source.indexOf(`\n--> statement-breakpoint\n${BOLTER_BRIDGE_MARKER}`);
  const generated = process.argv.includes("--refresh") && boundary >= 0 ? source.slice(0, boundary) : source;
  const result = finalizeBolterBridgeMigration(generated);
  if (result !== source) writeFileSync(path, result);
}
