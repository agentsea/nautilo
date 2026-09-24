import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const marker = "-- MODERATION_AUTHORITY";
const tables = ["group_moderation_scopes", "moderation_subjects", "moderation_actions", "moderation_restrictions", "server_admission"];

const moderationActionGuard = `CREATE OR REPLACE FUNCTION public.guard_moderation_action()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (to_jsonb(NEW) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at' - 'community_messages_deleted_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at' - 'community_messages_deleted_at')
    AND (NEW.reason IS NOT DISTINCT FROM OLD.reason OR NEW.reason IS NULL)
    AND (NEW.private_note IS NOT DISTINCT FROM OLD.private_note OR NEW.private_note IS NULL)
    AND (OLD.audit_recorded_at IS NULL OR NEW.audit_recorded_at IS NOT DISTINCT FROM OLD.audit_recorded_at)
    AND (OLD.community_messages_deleted_at IS NULL OR NEW.community_messages_deleted_at IS NOT DISTINCT FROM OLD.community_messages_deleted_at)
    AND (OLD.converged_at IS NULL OR NEW.converged_at IS NOT DISTINCT FROM OLD.converged_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Moderation action identity and outcome are immutable' USING ERRCODE = '23514';
END;
$$;`;

/** Drizzle generates schema; bootstrap backfill and role/trigger DDL live here. */
export function finalizeModerationMigration(source: string): string {
  if (!source.includes('CREATE TABLE "moderation_actions"') || source.includes(marker)) return source;
  const statements = [
    ...tables.flatMap((table) => [
      `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo";`,
      `REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "${table}" FROM "nautilo";`,
    ]),
    // Preserve existing enrollment, including unfinished browser bindings.
    `INSERT INTO "server_admission" ("user_id", "admitted")
SELECT u.id, NOT EXISTS (
  SELECT 1 FROM invite_redemptions r WHERE r.user_id = u.id AND r.completed_at IS NULL
) OR EXISTS (
  SELECT 1 FROM invite_redemptions r WHERE r.user_id = u.id AND r.completed_at IS NOT NULL
) FROM users u;`,
    moderationActionGuard,
    `CREATE TRIGGER moderation_action_immutable_row BEFORE UPDATE OR DELETE ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION public.guard_moderation_action();`,
    `CREATE TRIGGER moderation_action_immutable_table BEFORE TRUNCATE ON moderation_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_moderation_action();`,
    `REVOKE ALL ON FUNCTION public.guard_moderation_action() FROM PUBLIC, nautilo_agent, nautilo_crypto;`,
  ];
  return `${source}\n--> statement-breakpoint\n${marker}\n${statements.join("\n--> statement-breakpoint\n")}\n`;
}

/** Narrow crypto projection: no restriction records or private notes cross roles. */
export function finalizeModerationRecipientAccess(source: string): string {
  const accessMarker = "-- MODERATION_RECIPIENT_ACCESS";
  if (source.includes(accessMarker)) return source;
  return `${source}\n--> statement-breakpoint\n${accessMarker}
CREATE OR REPLACE FUNCTION public.moderation_access_allowed(subject_user_id uuid, source_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.server_admission admission
    WHERE admission.user_id = subject_user_id AND admission.admitted)
  AND NOT EXISTS (
    SELECT 1 FROM public.moderation_subjects subject
    JOIN public.moderation_restrictions restriction ON restriction.subject_id = subject.id
    WHERE subject.user_id = subject_user_id AND restriction.kind = 'access'
      AND restriction.lifted_at IS NULL AND restriction.starts_at <= statement_timestamp()
      AND (restriction.expires_at IS NULL OR restriction.expires_at > statement_timestamp())
      AND (restriction.room_id IS NULL OR restriction.room_id = source_room_id
        OR restriction.room_id = (SELECT parent_room_id FROM public.rooms WHERE id = source_room_id))
  );
$$;--> statement-breakpoint
ALTER FUNCTION public.moderation_access_allowed(uuid, uuid) OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.moderation_access_allowed(uuid, uuid) FROM PUBLIC, nautilo_agent;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.moderation_access_allowed(uuid, uuid) TO nautilo, nautilo_crypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.moderation_effective_humans(candidate_ids uuid[], source_room_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT ARRAY(SELECT actor.id FROM public.actors actor
    WHERE actor.id = ANY(candidate_ids) AND actor.kind = 'user'
      AND public.moderation_access_allowed(actor.owner_id, source_room_id)
    ORDER BY actor.id);
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.moderation_effective_humans(uuid[], uuid) FROM PUBLIC, nautilo_agent;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.moderation_effective_humans(uuid[], uuid) TO nautilo, nautilo_crypto;
`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const tag = journal.entries.at(-1)?.tag;
  if (!tag) throw new Error("Migration journal is empty");
  const path = resolve(root, `${tag}.sql`);
  const source = readFileSync(path, "utf8");
  let result = process.argv.includes("--recipient-access")
    ? finalizeModerationRecipientAccess(source) : finalizeModerationMigration(source);
  if (source.includes('CREATE TABLE "moderation_actions"')) {
    result = finalizeModerationRecipientAccess(result);
  }
  if (source.includes('CREATE TABLE "server_moderation_policy"') && !source.includes('-- MODERATION_POLICY_PRIVILEGES')) {
    result += `\n--> statement-breakpoint\n-- MODERATION_POLICY_PRIVILEGES
ALTER TABLE server_moderation_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE server_moderation_policy FROM PUBLIC, nautilo_agent, nautilo_crypto;
GRANT SELECT, INSERT, UPDATE ON TABLE server_moderation_policy TO nautilo;
INSERT INTO server_moderation_policy (singleton) VALUES (true) ON CONFLICT DO NOTHING;
`;
  }
  if (source.includes('CREATE POLICY "invite_redemptions_product"') && !source.includes('-- ENROLLMENT_REVIEW_PRIVILEGES')) {
    result += `\n--> statement-breakpoint\n-- ENROLLMENT_REVIEW_PRIVILEGES
ALTER TABLE invite_redemptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE invite_redemptions FROM PUBLIC, nautilo_agent, nautilo_crypto;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invite_redemptions TO nautilo;
`;
  }
  if (source.includes('ADD COLUMN "community_messages_deleted_at"') && !source.includes('-- MODERATION_MESSAGE_CLEANUP_GUARD')) {
    result += `\n--> statement-breakpoint\n-- MODERATION_MESSAGE_CLEANUP_GUARD\n${moderationActionGuard}\n`;
  }
  if (source.includes('ADD COLUMN "deleted_thread_root_message_id"') && !source.includes('-- MODERATION_THREAD_ANCHOR')) {
    result += `\n--> statement-breakpoint\n-- MODERATION_THREAD_ANCHOR\nALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_subthread_invariant;\n`;
  }
  if (result !== source) writeFileSync(path, result);
}
