import { expect, test } from "bun:test";
import { finalizeMagentControlMigration, finalizeMagentControlArchiveMigration } from "../../scripts/finalize-magent-control";
import { getTableConfig } from "drizzle-orm/pg-core";
import { bolterInboxReceipts, bolterOutbox, externalOperatorControlArchive } from "../../src/schema/bolter-bridge";

const schema = 'ALTER TABLE "bolter_inbox_receipts" ADD COLUMN "control_input" jsonb;';
test("control storage preserves authority checks and accepts no canonical control message", () => {
  const sql = finalizeMagentControlMigration(schema);
  expect(sql).toContain(schema);
  for (const guard of ["guard_bolter_inbox", "guard_bolter_outbox", "guard_bolter_final_reply"]) expect(sql).toContain(`FUNCTION public.${guard}()`);
  for (const condition of ["NEW.control_input IS NOT NULL OR NEW.state <> 'pending'",
    "OLD.control_input IS NOT NULL AND OLD.control_input IS DISTINCT FROM NEW.control_input",
    "b.provider = 'magent' AND NEW.control_input IS NOT NULL AND NEW.session_message_id IS NULL",
    "NEW.control_input->'origin'->>'bindingId' IS DISTINCT FROM b.id::text",
    "NEW.control_input->'origin'->>'connectionId' IS DISTINCT FROM b.connection_id::text",
    "a.status <> 'dispatched'", "j.status <> 'completed'", "j.input IS DISTINCT FROM jsonb_build_object",
    "NEW.session_message_id IS NULL AND i.session_message_id IS NULL",
    "m.metadata->'bolterReviewedShare'", "OLD.claim_token IS NOT NULL",
    "i.binding_revision <> NEW.binding_revision OR i.connection_generation <> NEW.connection_generation",
  ]) expect(sql).toContain(condition);
  expect(finalizeMagentControlMigration(sql)).toBe(sql);
});

test("operator input and result remain owner-scoped with exclusive content representations", () => {
  expect(bolterOutbox.sessionMessageId.notNull).toBe(false);
  expect(getTableConfig(bolterInboxReceipts).checks.map(c => c.name)).toContain("external_inbox_control");
  expect(getTableConfig(bolterOutbox).checks.map(c => c.name)).toContain("external_outbox_content");
  expect(getTableConfig(bolterInboxReceipts).enableRLS).toBe(true);
  expect(getTableConfig(bolterOutbox).enableRLS).toBe(true);
});


test("legacy archive selects exact provenance, retains audit and restores migration-only authority", () => {
  const source = 'CREATE TABLE "external_operator_control_archive" ("message_id" integer);';
  const migration = finalizeMagentControlArchiveMigration(source);
  expect(finalizeMagentControlArchiveMigration(migration)).toBe(migration);
  for (const condition of ["m.fingerprint = pg_temp.operator_control_digest('external-room-input-v1'",
    "i.fingerprint = pg_temp.operator_control_digest", "i.user_id = archive_owner_id",
    "i.external_sender_id = 'magent-connector:' || b.provider_agent_id",
    "sha256(convert_to((envelope->'input')::text,'UTF8'))", "m.edit_revision = 0", "f.edit_revision = 0",
    "j.input = jsonb_build_object", "o.fingerprint = f.fingerprint",
    "INSERT INTO public.external_operator_control_archive", "'message',to_jsonb(m)", "'message',to_jsonb(f)",
    "DELETE FROM public.session_messages WHERE id IN (item.input_id,item.result_id)",
    "ENABLE TRIGGER bolter_inbox_lifecycle", "ENABLE TRIGGER bolter_outbox_lifecycle", "ENABLE TRIGGER bolter_final_reply_authority",
    "DROP POLICY external_control_archive_inbox_migration", "DROP POLICY external_control_archive_outbox_migration",
    "REVOKE SELECT, UPDATE ON TABLE public.bolter_inbox_receipts, public.bolter_outbox FROM nautilo",
  ]) expect(migration).toContain(condition);
  expect(migration).not.toContain("NOT EXISTS (SELECT 1 FROM public.rooms anchor");
  expect(migration).toContain("deleted_thread_root_message_id = m.id");
  expect(migration).toContain("deleted_thread_reply_count = m.reply_count");
  expect(migration).toContain("deleted_thread_last_reply_at = m.last_reply_at");
  expect(migration).toContain("deleted_thread_summary_revision = m.summary_revision + 1");
  expect(migration.indexOf("UPDATE public.rooms anchor")).toBeLessThan(migration.indexOf("DELETE FROM public.session_messages"));
  expect(migration).not.toContain("DISABLE ROW LEVEL SECURITY");
  expect(migration).not.toContain("SET state =");
  expect(getTableConfig(externalOperatorControlArchive).enableRLS).toBe(true);
});
