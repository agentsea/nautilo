import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeBolterBridgeMigration } from "./finalize-bolter-bridge";
import { finalizeBolterFactoryMigration } from "./finalize-bolter-factory";

export const BOLTER_EXECUTION_MARKER = "-- BOLTER_ATOMIC_EXTERNAL_EXECUTION";

/** Preserve Drizzle's schema diff and append its required authority constraints. */
export function finalizeBolterExecutionMigration(source: string, options: { historicalAlias?: boolean; historicalAssistantTurn?: boolean } = {}): string {
  if (source.includes(BOLTER_EXECUTION_MARKER) || !source.includes('ADD COLUMN "model_sponsorship_accepted_at"')) return source;
  const initial = finalizeBolterBridgeMigration('CREATE TABLE "bolter_connections" (id uuid);');
  const factory = finalizeBolterFactoryMigration('ALTER POLICY "bolter_connections_owner" ON "bolter_connections"; ALTER POLICY "bolter_bindings_owner" ON "bolter_room_bindings";');
  const body = (text: string, name: string) => {
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = text.indexOf("$$;", start);
    if (start < 0 || end < 0) throw new Error("Bolter prerequisite guard is unavailable");
    return text.slice(start, end + 3);
  };
  const binding = body(factory, "guard_bolter_binding")
    .replaceAll("ARRAY['state','revision','updated_at']", "ARRAY['state','revision','updated_at','model_sponsorship_accepted_at']")
    .replace("OR OLD.state = 'revoked'", `OR (OLD.model_sponsorship_accepted_at IS NOT NULL AND OLD.model_sponsorship_accepted_at IS DISTINCT FROM NEW.model_sponsorship_accepted_at)
      OR (OLD.model_sponsorship_accepted_at IS DISTINCT FROM NEW.model_sponsorship_accepted_at AND (OLD.state <> 'active' OR NEW.state <> 'active'))
      OR OLD.state = 'revoked'`);
  const current = body(initial, "bolter_assert_current_binding")
    .replace("OR b.state <> 'active'", "OR b.state <> 'active' OR b.model_sponsorship_accepted_at IS NULL");
  if (!binding.includes("OLD.model_sponsorship_accepted_at") || !current.includes("b.model_sponsorship_accepted_at IS NULL")) throw new Error("Bolter sponsorship guard could not be derived");
  const inboxSource = options.historicalAlias ? body(initial, "guard_bolter_inbox") : body(initial, "guard_bolter_inbox")
    .replace("SELECT 1 FROM public.jobs j WHERE j.id = NEW.job_id\n    AND j.owner_id = NEW.user_id AND j.requestor_id = NEW.user_id AND j.room_id = b.room_id",
      "SELECT 1 FROM public.jobs canonical_job WHERE canonical_job.id = NEW.job_id\n    AND canonical_job.owner_id = NEW.user_id AND canonical_job.requestor_id = NEW.user_id AND canonical_job.room_id = b.room_id");
  const inbox = inboxSource
    .replace("DECLARE b public.bolter_room_bindings%ROWTYPE;", "DECLARE b public.bolter_room_bindings%ROWTYPE; j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;")
    .replace("  RETURN NEW;", `  IF NEW.state = 'accepted' THEN
    IF NEW.job_id IS NULL THEN RAISE EXCEPTION 'Bolter acceptance requires atomic durable work' USING ERRCODE = '23514'; END IF;
    IF OLD.state <> 'accepted' OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
      SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id AND owner_id = NEW.user_id AND requestor_id = NEW.user_id;
      SELECT * INTO a FROM public.work_acceptances WHERE id::text = j.input->>'acceptanceId' FOR UPDATE;
      IF j.id IS NULL OR a.id IS NULL OR j.type <> 'foreground' OR j.room_id IS DISTINCT FROM b.room_id
        OR j.lane_key IS DISTINCT FROM 'room:' || b.room_id::text OR j.status <> 'queued'
        OR j.started_at IS NOT NULL OR j.completed_at IS NOT NULL OR j.result IS NOT NULL OR j.message IS NOT NULL
        OR a.kind <> 'foreground' OR a.status <> 'accepted' OR a.job_id IS NOT NULL
        OR a.dispatched_at IS NOT NULL OR a.cancelled_at IS NOT NULL
        OR j.input IS DISTINCT FROM jsonb_build_object('kind','external_room_turn_v1',
          'receiptId',NEW.id::text,'bindingId',b.id::text,'bindingRevision',NEW.binding_revision,
          'connectionGeneration',NEW.connection_generation,'acceptanceId',a.id::text,
          'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',NEW.turn_id)
        OR NOT EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
          AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main')
        OR EXISTS (SELECT 1 FROM public.jobs other WHERE other.id <> j.id
          AND other.input->>'kind' = 'external_room_turn_v1' AND other.input->>'acceptanceId' = a.id::text) THEN
        RAISE EXCEPTION 'Bolter acceptance canonical work mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;`);
  const assistantTurn = options.historicalAssistantTurn ? "m.human_turn_id = i.turn_id" : "m.human_turn_id IS NULL";
  return `${source}\n--> statement-breakpoint\n${BOLTER_EXECUTION_MARKER}
-- NULL sponsorship is deliberately not grandfathered. Canonical content stays
-- in session_messages; durable work carries only exact immutable coordinates.
${binding}--> statement-breakpoint
${current}--> statement-breakpoint
${inbox}--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE b public.bolter_room_bindings%ROWTYPE; i public.bolter_inbox_receipts%ROWTYPE;
  j public.jobs%ROWTYPE; a public.work_acceptances%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IN ('pending','publishing','published') THEN
    IF NEW.source_inbox_id IS NULL OR NEW.explicit_share_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bolter explicit sharing authority is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO b FROM public.bolter_room_bindings WHERE id = NEW.binding_id AND user_id = NEW.user_id;
    SELECT * INTO i FROM public.bolter_inbox_receipts WHERE id = NEW.source_inbox_id AND binding_id = b.id AND user_id = NEW.user_id;
    SELECT * INTO j FROM public.jobs WHERE id = i.job_id AND owner_id = NEW.user_id AND requestor_id = NEW.user_id;
    SELECT * INTO a FROM public.work_acceptances WHERE id::text = j.input->>'acceptanceId';
    IF b.id IS NULL OR i.id IS NULL OR j.id IS NULL OR a.id IS NULL
      OR b.model_sponsorship_accepted_at IS NULL OR i.state <> 'accepted'
      OR i.binding_revision <> NEW.binding_revision OR i.connection_generation <> NEW.connection_generation
      OR j.type <> 'foreground' OR j.room_id IS DISTINCT FROM b.room_id OR j.lane_key IS DISTINCT FROM 'room:' || b.room_id::text
      OR j.status <> 'completed' OR j.started_at IS NULL OR j.completed_at IS NULL
      OR a.kind <> 'foreground' OR a.status <> 'dispatched' OR a.job_id IS DISTINCT FROM j.id
      OR a.dispatched_at IS NULL OR a.cancelled_at IS NOT NULL
      OR j.input IS DISTINCT FROM jsonb_build_object('kind','external_room_turn_v1',
        'receiptId',i.id::text,'bindingId',b.id::text,'bindingRevision',i.binding_revision,
        'connectionGeneration',i.connection_generation,'acceptanceId',a.id::text,
        'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',i.turn_id)
      OR NOT EXISTS (SELECT 1 FROM public.session_messages m
        JOIN public.session_messages source ON source.id = i.session_message_id
        JOIN public.sessions s ON s.id = m.session_id
        WHERE m.id = NEW.session_message_id AND m.session_id = source.session_id
          AND s.owner_id = NEW.user_id AND s.room_id = b.room_id AND s.agent_id = b.agent_id
          AND source.role = 'user' AND source.human_turn_id = i.turn_id
          AND source.metadata->>'externalReceiptId' = i.id::text
          AND m.role = 'assistant' AND m.transcript_origin = 'main' AND m.content IS NOT NULL
          AND btrim(m.content) <> '' AND ${assistantTurn}
          AND m.tool_calls IS NULL AND m.tool_name IS NULL
          AND m.reply_to_message_id = i.session_message_id AND m.fingerprint = NEW.fingerprint
          AND m.metadata->'externalFinalReply' = jsonb_build_object('kind','bolter_final_reply_v1',
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)) THEN
      RAISE EXCEPTION 'Bolter final reply causality mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_bolter_final_reply() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER bolter_final_reply_authority BEFORE INSERT OR UPDATE ON public.bolter_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_bolter_final_reply();\n`;
}


export const BOLTER_EXECUTION_CORRECTION_MARKER = "-- BOLTER_EXECUTION_GUARD_QUALIFIED_ALIAS";
/** Correct the applied guard without changing its original migration bytes. */
export function finalizeBolterExecutionGuardCorrection(source: string): string {
  if (source.includes(BOLTER_EXECUTION_CORRECTION_MARKER)) return source;
  const qualified = finalizeBolterExecutionMigration('ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;');
  const start = qualified.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_inbox()");
  const end = qualified.indexOf("$$;", start);
  if (start < 0 || end < 0 || !qualified.includes("canonical_job.id")) throw new Error("Bolter corrected inbox guard is unavailable");
  return `${source}\n--> statement-breakpoint\n${BOLTER_EXECUTION_CORRECTION_MARKER}\n${qualified.slice(start, end + 3)}\n`;
}


export const BOLTER_ASSISTANT_TURN_MARKER = "-- BOLTER_ASSISTANT_CANONICAL_TURN_COMPATIBILITY";
export function finalizeBolterAssistantTurnCorrection(source: string): string {
  if (source.includes(BOLTER_ASSISTANT_TURN_MARKER)) return source;
  const qualified = finalizeBolterExecutionMigration('ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;');
  const start = qualified.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_final_reply()");
  const end = qualified.indexOf("$$;", start);
  if (start < 0 || end < 0 || !qualified.includes("m.human_turn_id IS NULL")) throw new Error("Bolter canonical assistant guard is unavailable");
  return `${source}\n--> statement-breakpoint\n${BOLTER_ASSISTANT_TURN_MARKER}\n${qualified.slice(start, end + 3)}\n`;
}


export const EXTERNAL_AUTHORSHIP_MARKER = "-- EXTERNAL_AUTHORSHIP_RESTRICTIVE_PROVENANCE";
/** Restriction survives receipt/account cleanup and encryption representation changes. */
export function finalizeExternalAuthorshipMigration(source: string): string {
  if (source.includes(EXTERNAL_AUTHORSHIP_MARKER) || !source.includes('ADD COLUMN "external_authorship"')) return source;
  const qualified = finalizeBolterExecutionMigration('ALTER TABLE "bolter_room_bindings" ADD COLUMN "model_sponsorship_accepted_at" timestamp with time zone;');
  const start = qualified.indexOf("CREATE OR REPLACE FUNCTION public.guard_bolter_inbox()");
  const end = qualified.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error("Bolter inbox prerequisite is unavailable");
  const inbox = qualified.slice(start, end + 3)
    .replace("AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main'", "AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main' AND m.external_authorship");
  if (!inbox.includes("AND m.external_authorship")) throw new Error("Bolter restrictive provenance condition is unavailable");
  return `${source}\n--> statement-breakpoint\n${EXTERNAL_AUTHORSHIP_MARKER}
-- Metadata assertions confer no authorship authority; they can only demand
-- distrust. Existing canonical receipt joins supply the same restriction.
UPDATE public.session_messages m SET external_authorship = true
WHERE m.role = 'user' AND (coalesce(m.metadata ? 'externalOrigin', false)
  OR coalesce(m.metadata ? 'externalReceiptId', false)
  OR EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i WHERE i.session_message_id = m.id));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_authorship()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.external_authorship AND NOT NEW.external_authorship THEN
    RAISE EXCEPTION 'External authorship restriction is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.role = 'user' AND (coalesce(NEW.metadata ? 'externalOrigin', false)
    OR coalesce(NEW.metadata ? 'externalReceiptId', false)) THEN NEW.external_authorship := true; END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_authorship() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER session_message_external_authorship BEFORE INSERT OR UPDATE ON public.session_messages
FOR EACH ROW EXECUTE FUNCTION public.guard_external_authorship();--> statement-breakpoint
${inbox}\n`;
}

export const EXTERNAL_ROOM_EXECUTION_MARKER = "-- EXTERNAL_ROOM_EXECUTOR_QUIESCENCE_CLAIM";
/** Drizzle owns the table/policy diff; this adds narrow runtime admission. */
export function finalizeExternalRoomExecutionMigration(source: string): string {
  if (source.includes(EXTERNAL_ROOM_EXECUTION_MARKER) || !source.includes('CREATE TABLE "external_room_execution_claims"')) return source;
  return `${source}\n--> statement-breakpoint\n${EXTERNAL_ROOM_EXECUTION_MARKER}
-- No Job/Human FK, expiry, terminal-status cleanup, or claim-token projection.
-- Only exact executor finally-release or Room deletion removes a claim.
ALTER TABLE public.external_room_execution_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.external_room_execution_claims FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.external_room_execution_claims TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.external_room_job_start_allowed(p_owner uuid, p_room uuid, p_job uuid, p_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room AND
    (NOT r.external_context OR (r.archived_at IS NULL
      AND p_owner = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (SELECT 1 FROM public.external_room_execution_claims c
        WHERE c.room_id = p_room AND c.job_id = p_job AND c.owner_user_id = p_owner AND c.token = p_token)
      AND EXISTS (SELECT 1 FROM public.jobs canonical_job WHERE canonical_job.id = p_job
        AND canonical_job.owner_id = p_owner AND canonical_job.room_id = p_room
        AND canonical_job.type = 'foreground' AND canonical_job.status = 'queued'
        AND canonical_job.started_at IS NULL AND canonical_job.completed_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.room_members member JOIN public.actors actor ON actor.id = member.actor_id
        WHERE member.room_id = p_room AND actor.kind = 'user' AND actor.owner_id = p_owner))));
$$;--> statement-breakpoint
ALTER FUNCTION public.external_room_job_start_allowed(uuid,uuid,uuid,uuid) OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.external_room_job_start_allowed(uuid,uuid,uuid,uuid) FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_room_job_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.type = 'foreground' AND NEW.status = 'running' AND NEW.room_id IS NOT NULL
    AND NOT public.external_room_job_start_allowed(NEW.owner_id, NEW.room_id, NEW.id,
      nullif(current_setting('app.external_room_execution_token', true), '')::uuid) THEN
    RAISE EXCEPTION 'External Room execution claim is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
ALTER FUNCTION public.guard_external_room_job_start() OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_room_job_start() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER external_room_job_start BEFORE INSERT OR UPDATE OF status, room_id, type, owner_id ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_external_room_job_start();\n`;
}

export const EXTERNAL_ROOM_NAMESPACE_CLAIM_MARKER = "-- EXTERNAL_ROOM_NAMESPACE_EXECUTION_BOUNDARY";
/** Match canonical Namespace inheritance without changing the applied guard. */
export function finalizeExternalRoomNamespaceClaimCorrection(source: string): string {
  if (source.includes(EXTERNAL_ROOM_NAMESPACE_CLAIM_MARKER)) return source;
  const prior = finalizeExternalRoomExecutionMigration('CREATE TABLE "external_room_execution_claims" (room_id uuid);');
  const start = prior.indexOf("CREATE OR REPLACE FUNCTION public.external_room_job_start_allowed(");
  const end = prior.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error("External Room admission prerequisite is unavailable");
  const helper = prior.slice(start, end + 3)
    .replace("NOT r.external_context", "NOT EXISTS (SELECT 1 FROM public.rooms boundary WHERE boundary.namespace_id = r.namespace_id AND boundary.external_context)")
    .replace("r.archived_at IS NULL", "r.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.rooms ancestor WHERE ancestor.namespace_id = r.namespace_id AND ancestor.kind <> 'subthread' AND ancestor.archived_at IS NOT NULL) AND public.moderation_access_allowed(p_owner, p_room)")
    .replace("JOIN public.actors actor ON actor.id = member.actor_id", "JOIN public.actors actor ON actor.id = member.actor_id JOIN public.users subject ON subject.id = actor.owner_id")
    .replace("actor.owner_id = p_owner", "actor.owner_id = p_owner AND subject.disabled_at IS NULL");
  return `${source}\n--> statement-breakpoint\n${EXTERNAL_ROOM_NAMESPACE_CLAIM_MARKER}\n${helper}\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const boundary = source.indexOf(`\n--> statement-breakpoint\n${BOLTER_EXECUTION_MARKER}`);
  const generated = process.argv.includes("--refresh") && boundary >= 0 ? source.slice(0, boundary) : source;
  const result = process.argv.includes("--namespace-claim-correction") ? finalizeExternalRoomNamespaceClaimCorrection(generated)
    : process.argv.includes("--compile-correction") ? finalizeBolterExecutionGuardCorrection(generated)
    : process.argv.includes("--assistant-turn-correction") ? finalizeBolterAssistantTurnCorrection(generated)
    : finalizeExternalRoomExecutionMigration(finalizeExternalAuthorshipMigration(finalizeBolterExecutionMigration(generated)));
  if (result !== source) writeFileSync(path, result);
}
