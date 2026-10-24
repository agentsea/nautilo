import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeBolterBridgeMigration } from "./finalize-bolter-bridge";
import { finalizeExternalAuthorshipMigration } from "./finalize-bolter-execution";
import { finalizeMagentTransportMigration } from "./finalize-magent-transport";

export const MAGENT_CONTROL_MARKER = "-- EXTERNAL_OPERATOR_CONTROL_STORAGE";

function body(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = source.indexOf("$$;", start);
  if (start < 0 || end < 0) throw new Error(`Missing control prerequisite: ${name}`);
  return source.slice(start, end + 3);
}
function replace(source: string, old: string, replacement: string): string {
  if (!source.includes(old)) throw new Error("Operator control guard prerequisite changed");
  return source.replaceAll(old, replacement);
}

/** Keep canonical conversation guards and add a separately typed operator representation. */
export function finalizeMagentControlMigration(source: string): string {
  if (source.includes(MAGENT_CONTROL_MARKER) || !source.includes('ADD COLUMN "control_input"')) return source;
  const initial = finalizeBolterBridgeMigration('CREATE TABLE "bolter_connections" (id uuid);');
  const qualified = finalizeExternalAuthorshipMigration('ALTER TABLE "session_messages" ADD COLUMN "external_authorship" boolean;');
  let inbox = body(qualified, "guard_bolter_inbox");
  inbox = replace(inbox, "NEW.state <> 'pending' OR NEW.session_message_id", "NEW.control_input IS NOT NULL OR NEW.state <> 'pending' OR NEW.session_message_id");
  inbox = replace(inbox, "ARRAY['session_message_id','turn_id','job_id','state','updated_at']", "ARRAY['session_message_id','control_input','turn_id','job_id','state','updated_at']");
  inbox = replace(inbox, "OR (OLD.turn_id IS NOT NULL", "OR (OLD.control_input IS NOT NULL AND OLD.control_input IS DISTINCT FROM NEW.control_input)\n      OR (OLD.state <> 'pending' AND OLD.control_input IS DISTINCT FROM NEW.control_input)\n      OR (OLD.turn_id IS NOT NULL");
  inbox = replace(inbox, "  IF NEW.session_message_id IS NOT NULL AND", `  IF NEW.control_input IS NOT NULL AND (b.provider <> 'magent' OR NEW.session_message_id IS NOT NULL
    OR NEW.control_input->>'kind' IS DISTINCT FROM 'operator_control_v1'
    OR NEW.control_input->'origin'->>'provider' IS DISTINCT FROM 'magent'
    OR NEW.control_input->'origin'->>'bindingId' IS DISTINCT FROM b.id::text
    OR NEW.control_input->'origin'->>'connectionId' IS DISTINCT FROM b.connection_id::text
    OR NEW.control_input->'origin'->>'origin' IS DISTINCT FROM b.origin
    OR NEW.control_input->'origin'->>'providerAgentId' IS DISTINCT FROM b.provider_agent_id
    OR NEW.control_input->'origin'->>'chatId' IS DISTINCT FROM b.chat_id
    OR coalesce(NEW.control_input->'origin'->>'threadRootId','') IS DISTINCT FROM b.thread_id
    OR NEW.control_input->'origin'->>'messageId' IS DISTINCT FROM NEW.provider_message_id
    OR NEW.control_input->'origin'->>'senderId' IS DISTINCT FROM NEW.external_sender_id
    OR NEW.control_input->'origin'->>'senderType' IS DISTINCT FROM 'anima') THEN
    RAISE EXCEPTION 'Operator control provenance mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.session_message_id IS NOT NULL AND`);
  inbox = replace(inbox, `OR NOT EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
          AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main' AND m.external_authorship)`,
    `OR NOT ((b.provider = 'magent' AND NEW.control_input IS NOT NULL AND NEW.session_message_id IS NULL)
          OR (b.provider = 'bolter' AND NEW.control_input IS NULL AND EXISTS (SELECT 1 FROM public.session_messages m WHERE m.id = NEW.session_message_id
            AND m.metadata->>'externalReceiptId' = NEW.id::text AND m.transcript_origin = 'main' AND m.external_authorship)))`);
  let outbox = body(initial, "guard_bolter_outbox");
  outbox = replace(outbox, "  IF NEW.state IN ('pending','publishing','published') AND NOT EXISTS", `  IF NEW.control_result IS NOT NULL AND (b.provider <> 'magent' OR NEW.session_message_id IS NOT NULL
    OR NEW.explicit_share_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i
      WHERE i.id = NEW.source_inbox_id AND i.binding_id = b.id AND i.user_id = NEW.user_id AND i.control_input IS NOT NULL)) THEN
    RAISE EXCEPTION 'Operator result provenance mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.control_result IS NULL AND NEW.state IN ('pending','publishing','published') AND NOT EXISTS`);
  let final = body(finalizeMagentTransportMigration('ALTER TABLE "bolter_connections" ADD COLUMN "transport_kind" text;'), "guard_bolter_final_reply");
  final = replace(final, "      OR NOT EXISTS (SELECT 1 FROM public.session_messages m\n        JOIN public.session_messages source", `      OR NOT ((b.provider = 'magent' AND i.control_input IS NOT NULL AND NEW.control_result IS NOT NULL
        AND NEW.session_message_id IS NULL AND i.session_message_id IS NULL)
        OR (NEW.control_result IS NULL AND i.control_input IS NULL AND EXISTS (SELECT 1 FROM public.session_messages m
        JOIN public.session_messages source`);
  final = replace(final, "'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)) THEN", "'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)))) THEN");
  return `${source}\n--> statement-breakpoint\n${MAGENT_CONTROL_MARKER}\n${inbox}\n--> statement-breakpoint\n${outbox}\n--> statement-breakpoint\n${final}\n`;
}

export const MAGENT_ARCHIVE_MARKER = "-- EXTERNAL_OPERATOR_LEGACY_ARCHIVE";
/** One-time source migration; complete row/provenance evidence remains outside transcript readers. */
export function finalizeMagentControlArchiveMigration(source: string): string {
  if (source.includes(MAGENT_ARCHIVE_MARKER) || !source.includes('CREATE TABLE "external_operator_control_archive"')) return source;
  return `${source}\n--> statement-breakpoint\n${MAGENT_ARCHIVE_MARKER}
REVOKE ALL ON TABLE public.external_operator_control_archive FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.external_operator_control_archive TO nautilo;--> statement-breakpoint
ALTER TABLE public.external_operator_control_archive FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Temporary owner-scoped migration authority; no runtime credential can invoke this migration.
GRANT SELECT, UPDATE ON TABLE public.bolter_inbox_receipts, public.bolter_outbox TO nautilo;--> statement-breakpoint
CREATE POLICY external_control_archive_inbox_migration ON public.bolter_inbox_receipts FOR ALL TO nautilo
  USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY external_control_archive_outbox_migration ON public.bolter_outbox FOR ALL TO nautilo
  USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.bolter_inbox_receipts DISABLE TRIGGER bolter_inbox_lifecycle;--> statement-breakpoint
ALTER TABLE public.bolter_outbox DISABLE TRIGGER bolter_outbox_lifecycle;--> statement-breakpoint
ALTER TABLE public.bolter_outbox DISABLE TRIGGER bolter_final_reply_authority;--> statement-breakpoint
-- JSON (not JSONB) preserves the exact serialized input bytes used by the connector's identity hash.
CREATE FUNCTION pg_temp.operator_control_digest(VARIADIC parts text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to('[' || string_agg(coalesce(to_json(value)::text, 'null'), ',' ORDER BY ordinal) || ']', 'UTF8')), 'hex')
  FROM unnest(parts) WITH ORDINALITY AS element(value, ordinal)
$$;--> statement-breakpoint
DO $archive$
DECLARE archive_owner_id uuid; item record; previous_owner text := current_setting('app.current_user_id', true);
BEGIN
  FOR archive_owner_id IN SELECT id FROM public.users LOOP
    PERFORM set_config('app.current_user_id', archive_owner_id::text, true);
    FOR item IN
      SELECT m.id AS input_id, m.session_id, m.content AS input_content, m.metadata->'externalOrigin' AS origin,
        b.id AS binding_id, i.id AS receipt_id, o.id AS outbox_id, f.id AS result_id, f.content AS result_content,
        jsonb_build_object('message',to_jsonb(m),'session',to_jsonb(s),'receipt',to_jsonb(i),
          'binding',to_jsonb(b),'connection',to_jsonb(c),'job',to_jsonb(j),'acceptance',to_jsonb(a)) AS input_evidence,
        jsonb_build_object('message',to_jsonb(f),'session',to_jsonb(s),'outbox',to_jsonb(o),
          'receipt',to_jsonb(i),'job',to_jsonb(j),'acceptance',to_jsonb(a)) AS result_evidence
      FROM public.bolter_inbox_receipts i
      JOIN public.bolter_room_bindings b ON b.id = i.binding_id AND b.user_id = i.user_id
      JOIN public.bolter_connections c ON c.id = b.connection_id AND c.user_id = i.user_id
      JOIN public.session_messages m ON m.id = i.session_message_id
      JOIN public.sessions s ON s.id = m.session_id AND s.owner_id = i.user_id
      JOIN public.jobs j ON j.id = i.job_id AND j.owner_id = i.user_id AND j.requestor_id = i.user_id
      JOIN public.work_acceptances a ON a.id::text = j.input->>'acceptanceId'
      LEFT JOIN public.bolter_outbox o ON o.source_inbox_id = i.id AND o.user_id = i.user_id AND o.binding_id = b.id
      LEFT JOIN public.session_messages f ON f.id = o.session_message_id
      CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(m.content, 'json') THEN m.content::json END AS envelope) parsed
      WHERE i.user_id = archive_owner_id AND b.provider = 'magent' AND c.provider = 'magent' AND c.transport_kind = 'operator-unix'
        AND i.control_input IS NULL AND s.room_id = b.room_id AND s.agent_id = b.agent_id
        AND s.thread_id = 'room:' || b.room_id::text || ':bot:' || b.agent_id::text
        AND m.role = 'user' AND m.external_authorship AND m.transcript_origin = 'main'
        AND m.human_turn_id = i.turn_id AND m.edit_revision = 0 AND m.crypto_object_id IS NULL
        AND m.tool_calls IS NULL AND m.tool_name IS NULL AND m.subthread_room_id IS NULL
        AND m.metadata->>'externalReceiptId' = i.id::text
        AND m.fingerprint = pg_temp.operator_control_digest('external-room-input-v1',i.id::text)
        AND m.metadata->'externalOrigin'->>'kind' = 'external_message'
        AND m.metadata->'externalOrigin'->>'version' = '1'
        AND m.metadata->'externalOrigin'->>'provider' = 'magent'
        AND m.metadata->'externalOrigin'->>'bindingId' = b.id::text
        AND m.metadata->'externalOrigin'->>'connectionId' = c.id::text
        AND m.metadata->'externalOrigin'->>'origin' = b.origin AND c.origin = b.origin
        AND m.metadata->'externalOrigin'->>'providerAgentId' = b.provider_agent_id AND c.provider_agent_id = b.provider_agent_id
        AND m.metadata->'externalOrigin'->>'chatId' = b.chat_id
        AND coalesce(m.metadata->'externalOrigin'->>'threadRootId','') = b.thread_id
        AND m.metadata->'externalOrigin'->>'messageId' = i.provider_message_id
        AND m.metadata->'externalOrigin'->>'senderId' = i.external_sender_id
        AND i.external_sender_id = 'magent-connector:' || b.provider_agent_id
        AND m.metadata->'externalOrigin'->>'senderType' = 'anima'
        AND i.fingerprint = pg_temp.operator_control_digest('magent',b.origin,b.provider_agent_id,b.chat_id,
          m.metadata->'externalOrigin'->>'threadRootId',i.provider_message_id,i.external_sender_id,'anima',
          m.metadata->'externalOrigin'->>'createdAt',m.content)
        AND jsonb_typeof(envelope::jsonb) = 'object'
        AND envelope::jsonb - ARRAY['request','outputSchema','input'] = '{}'::jsonb
        AND jsonb_typeof(envelope::jsonb->'request') = 'string'
        AND jsonb_typeof(envelope::jsonb->'input') = 'object'
        AND envelope::jsonb->'input'->>'roomId' = b.chat_id
        AND envelope::jsonb->'input'->>'agentId' = b.provider_agent_id
        AND jsonb_typeof(envelope::jsonb->'input'->'sessionId') = 'string'
        AND jsonb_typeof(envelope::jsonb->'input'->'resume') = 'boolean'
        AND jsonb_typeof(envelope::jsonb->'input'->'activity') = 'array'
        AND jsonb_typeof(envelope::jsonb->'input'->'sources') = 'array'
        AND envelope::jsonb->'outputSchema'->>'type' = 'object'
        AND envelope::jsonb->'outputSchema'->'additionalProperties' = 'false'::jsonb
        AND jsonb_typeof(envelope::jsonb->'outputSchema'->'properties') = 'object'
        AND CASE WHEN jsonb_typeof(envelope::jsonb->'outputSchema'->'required') = 'array'
          THEN jsonb_array_length(envelope::jsonb->'outputSchema'->'required') = 4
            AND envelope::jsonb->'outputSchema'->'required' @> '["action","body","messageIds","notifyAgentIds"]'::jsonb ELSE false END
        AND i.provider_message_id = encode(sha256(convert_to((envelope->'input')::text,'UTF8')),'hex')
        AND a.kind = 'foreground' AND (a.job_id IS NULL OR a.job_id = j.id)
        AND j.type = 'foreground' AND j.room_id = b.room_id AND j.lane_key = 'room:' || b.room_id::text
        AND j.input = jsonb_build_object('kind','external_room_turn_v1','receiptId',i.id::text,'bindingId',b.id::text,
          'bindingRevision',i.binding_revision,'connectionGeneration',i.connection_generation,'acceptanceId',a.id::text,
          'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',i.turn_id)
        AND (o.id IS NULL OR (o.control_result IS NULL AND o.explicit_share_id IS NULL
          AND o.binding_revision = i.binding_revision AND o.connection_generation = i.connection_generation
          AND f.session_id = s.id AND f.role = 'assistant' AND f.human_turn_id IS NULL
          AND f.reply_to_message_id = m.id AND f.transcript_origin = 'main' AND f.edit_revision = 0
          AND f.crypto_object_id IS NULL AND f.tool_calls IS NULL AND f.tool_name IS NULL AND f.subthread_room_id IS NULL
          AND f.content IS NOT NULL AND btrim(f.content) <> ''
          AND f.metadata->'externalFinalReply' = jsonb_build_object('kind','external_room_final_reply_v1',
            'receiptId',i.id::text,'jobId',j.id::text,'turnId',i.turn_id,'acceptanceId',a.id::text)
          AND f.fingerprint = pg_temp.operator_control_digest('external-room-final-v1',i.id::text,j.id::text,f.content)
          AND o.fingerprint = f.fingerprint))
    LOOP
      INSERT INTO public.external_operator_control_archive(message_id,user_id,receipt_id,binding_id,session_id,kind,evidence)
        VALUES (item.input_id,archive_owner_id,item.receipt_id,item.binding_id,item.session_id,'input',item.input_evidence);
      IF item.result_id IS NOT NULL THEN
        INSERT INTO public.external_operator_control_archive(message_id,user_id,receipt_id,binding_id,session_id,kind,evidence)
          VALUES (item.result_id,archive_owner_id,item.receipt_id,item.binding_id,item.session_id,'result',item.result_evidence);
        UPDATE public.bolter_outbox SET session_message_id = NULL, control_result = item.result_content WHERE id = item.outbox_id;
      END IF;
      UPDATE public.bolter_inbox_receipts SET session_message_id = NULL,
        control_input = jsonb_build_object('kind','operator_control_v1','content',item.input_content,'origin',item.origin)
        WHERE id = item.receipt_id;
      -- Preserve the canonical content-free anchor and its real child Room before the FK clears it.
      UPDATE public.rooms anchor SET deleted_thread_root_message_id = m.id,
        deleted_thread_reply_count = m.reply_count, deleted_thread_last_reply_at = m.last_reply_at,
        deleted_thread_summary_revision = m.summary_revision + 1
        FROM public.session_messages m
        WHERE m.id IN (item.input_id,item.result_id) AND anchor.thread_root_message_id = m.id;
      -- Canonical DELETE triggers advance source revisions; notification candidates cascade.
      DELETE FROM public.session_messages WHERE id IN (item.input_id,item.result_id);
      UPDATE public.sessions SET message_count = greatest(0,message_count - CASE WHEN item.result_id IS NULL THEN 1 ELSE 2 END)
        WHERE id = item.session_id;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.current_user_id',coalesce(previous_owner,''),true);
END $archive$;--> statement-breakpoint
DROP FUNCTION pg_temp.operator_control_digest(text[]);--> statement-breakpoint
ALTER TABLE public.bolter_inbox_receipts ENABLE TRIGGER bolter_inbox_lifecycle;--> statement-breakpoint
ALTER TABLE public.bolter_outbox ENABLE TRIGGER bolter_outbox_lifecycle;--> statement-breakpoint
ALTER TABLE public.bolter_outbox ENABLE TRIGGER bolter_final_reply_authority;--> statement-breakpoint
DROP POLICY external_control_archive_inbox_migration ON public.bolter_inbox_receipts;--> statement-breakpoint
DROP POLICY external_control_archive_outbox_migration ON public.bolter_outbox;--> statement-breakpoint
REVOKE SELECT, UPDATE ON TABLE public.bolter_inbox_receipts, public.bolter_outbox FROM nautilo;--> statement-breakpoint
GRANT SELECT(id,user_id,binding_id,session_message_id,job_id), UPDATE(id) ON TABLE public.bolter_inbox_receipts TO nautilo;--> statement-breakpoint
GRANT SELECT(user_id,binding_id,source_inbox_id,session_message_id,explicit_share_id), UPDATE(id) ON TABLE public.bolter_outbox TO nautilo;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE public.external_operator_control_archive FROM nautilo;\n`;
}

export const MAGENT_ARCHIVE_CASCADE_MARKER = "-- EXTERNAL_OPERATOR_ARCHIVE_OWNER_CASCADE";

/** FK cleanup runs as the archive owner, so DELETE needs an immutable guard. */
export function finalizeMagentControlArchiveCascadeMigration(source: string): string {
  if (source.includes(MAGENT_ARCHIVE_CASCADE_MARKER)) return source;
  return `${source}\n--> statement-breakpoint\n${MAGENT_ARCHIVE_CASCADE_MARKER}
CREATE OR REPLACE FUNCTION public.guard_external_operator_control_archive()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() >= 2 THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Operator control archive is immutable' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.external_operator_control_archive TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_control_archive_immutable_row
BEFORE UPDATE OR DELETE ON public.external_operator_control_archive
FOR EACH ROW EXECUTE FUNCTION public.guard_external_operator_control_archive();--> statement-breakpoint
CREATE TRIGGER external_control_archive_immutable_table
BEFORE TRUNCATE ON public.external_operator_control_archive
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_external_operator_control_archive();--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.external_operator_control_archive FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE public.external_operator_control_archive TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_operator_control_archive() FROM PUBLIC, nautilo_agent, nautilo_crypto;\n`;
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("Migration journal is empty");
  const path = resolve(directory, `${latest.tag}.sql`);
  const source = readFileSync(path, "utf8");
  const result = process.argv.includes("--owner-cascade")
    ? finalizeMagentControlArchiveCascadeMigration(source)
    : finalizeMagentControlArchiveMigration(finalizeMagentControlMigration(source));
  if (result !== source) writeFileSync(path, result);
}
