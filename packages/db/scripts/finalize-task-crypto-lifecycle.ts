import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TASK_CRYPTO_LIFECYCLE_MARKER = "-- TASK_CRYPTO_LIFECYCLE_AUTHORITY";
const DEFINITION_TABLE = "task_definition_crypto_revisions";
const RESULT_TABLE = "task_run_result_crypto_revisions";

function identityGuard(table: string, functionName: string, columns: readonly string[], replace = false): string {
  const next = columns.map((column) => `NEW.${column}`).join(",\n    ");
  const old = columns.map((column) => `OLD.${column}`).join(",\n    ");
  return `CREATE ${replace ? "OR REPLACE " : ""}FUNCTION "public"."${functionName}"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(\n    ${next}\n  ) IS DISTINCT FROM ROW(\n    ${old}\n  ) THEN
    RAISE EXCEPTION 'protected Task crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."${functionName}"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."${functionName}"() TO "nautilo";--> statement-breakpoint
${replace ? "" : `CREATE TRIGGER "${table}_identity_immutable" BEFORE UPDATE ON "${table}" FOR EACH ROW
EXECUTE FUNCTION "public"."${functionName}"();`}`;
}

function renderFinalizer(): string {
  const shared = ["content_namespace_id", "operation_id", "request_digest", "authority_fingerprint", "requester_human_id", "anchor_namespace_id", "crypto_object_id", "representation", "payload_version", "crypto_access_revision", "required_namespace_fingerprint", "created_at"];
  return `${TASK_CRYPTO_LIFECYCLE_MARKER}
${identityGuard(DEFINITION_TABLE, "reject_task_definition_crypto_revision_identity_update", ["sequence", "task_id", "content_revision", ...shared, "operational_metadata"])}--> statement-breakpoint
${identityGuard(RESULT_TABLE, "reject_task_run_result_crypto_revision_identity_update", ["sequence", "task_id", "task_run_id", "result_revision", ...shared])}--> statement-breakpoint
CREATE FUNCTION "public"."guard_task_content_namespace_stability"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.content_namespace_id IS NOT NULL AND NEW.content_namespace_id IS DISTINCT FROM OLD.content_namespace_id THEN
    RAISE EXCEPTION 'Task content Namespace is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_content_namespace_stability"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "tasks_content_namespace_stable" BEFORE UPDATE ON "tasks" FOR EACH ROW
EXECUTE FUNCTION "public"."guard_task_content_namespace_stability"();--> statement-breakpoint
CREATE FUNCTION "public"."guard_task_run_result_namespace_stability"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.result_content_namespace_id IS NOT NULL AND NEW.result_content_namespace_id IS DISTINCT FROM OLD.result_content_namespace_id THEN
    RAISE EXCEPTION 'TaskRun result content Namespace is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_run_result_namespace_stability"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "task_runs_result_content_namespace_stable" BEFORE UPDATE ON "task_runs" FOR EACH ROW
EXECUTE FUNCTION "public"."guard_task_run_result_namespace_stability"();--> statement-breakpoint
ALTER TABLE "${DEFINITION_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "${RESULT_TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${DEFINITION_TABLE}", "${RESULT_TABLE}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${DEFINITION_TABLE}", "${RESULT_TABLE}" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("completion", "disposition", "attempt_count", "next_attempt_at", "lease_token", "lease_expires_at", "failure_code", "crypto_completed_at", "updated_at") ON TABLE "${DEFINITION_TABLE}" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("completion", "disposition", "attempt_count", "next_attempt_at", "lease_token", "lease_expires_at", "failure_code", "crypto_completed_at", "updated_at") ON TABLE "${RESULT_TABLE}" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "task_definition_crypto_revisions_sequence_seq", "task_run_result_crypto_revisions_sequence_seq" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "task_definition_crypto_revisions_sequence_seq", "task_run_result_crypto_revisions_sequence_seq" TO "nautilo";`;
}

export function finalizeTaskCryptoLifecycleMigration(migration: string): string {
  const wakeTable = "protected_task_wake_continuation_receipts";
  if (migration.includes(`CREATE TABLE "${wakeTable}"`)
    && !migration.includes("-- TASK_WAKE_CONTINUATION_AUTHORITY")) {
    migration += `\n--> statement-breakpoint\n-- TASK_WAKE_CONTINUATION_AUTHORITY
ALTER TABLE "${wakeTable}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${wakeTable}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "${wakeTable}" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."reject_task_wake_continuation_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Protected Task wake continuation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_wake_continuation_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "task_wake_continuation_immutable" BEFORE UPDATE ON "${wakeTable}" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_wake_continuation_update"();\n`;
  }
  const definition = migration.includes(`CREATE TABLE "${DEFINITION_TABLE}"`);
  const result = migration.includes(`CREATE TABLE "${RESULT_TABLE}"`);
  if (!definition && !result) {
    const historicalDefinition = migration.includes(`ALTER TABLE "${DEFINITION_TABLE}" ADD COLUMN "historical_repair"`);
    const historicalResult = migration.includes(`ALTER TABLE "${RESULT_TABLE}" ADD COLUMN "historical_repair"`);
    if (historicalDefinition !== historicalResult) throw new Error("Task historical repair provenance generation is incomplete");
    const scanTables = ["task_content_backfill_scans", "task_content_backfill_failures"];
    const scans = scanTables.map((table) => migration.includes(`CREATE TABLE "${table}"`));
    if (scans[0] !== scans[1]) throw new Error("Task historical repair scan generation is incomplete");
    if ((!historicalDefinition && !scans[0]) || migration.includes("-- TASK_HISTORICAL_REPAIR_AUTHORITY")) return migration;
    const shared = ["content_namespace_id", "operation_id", "request_digest", "authority_fingerprint", "requester_human_id", "anchor_namespace_id", "crypto_object_id", "representation", "payload_version", "crypto_access_revision", "required_namespace_fingerprint", "created_at", "historical_repair"];
    const provenance = historicalDefinition ? [
      identityGuard(DEFINITION_TABLE, "reject_task_definition_crypto_revision_identity_update", ["sequence", "task_id", "content_revision", ...shared, "operational_metadata"], true),
      identityGuard(RESULT_TABLE, "reject_task_run_result_crypto_revision_identity_update", ["sequence", "task_id", "task_run_id", "result_revision", ...shared], true),
    ] : [];
    const scanAuthority = scans[0] ? scanTables.map((table) => `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo";`) : [];
    return `${migration}\n--> statement-breakpoint\n-- TASK_HISTORICAL_REPAIR_AUTHORITY\n${[...provenance, ...scanAuthority].join("\n--> statement-breakpoint\n")}\n`;
  }
  if (!definition || !result) throw new Error("Protected Task lifecycle generation is incomplete");
  if (migration.includes(TASK_CRYPTO_LIFECYCLE_MARKER)) return migration;
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint\n${renderFinalizer()}\n`;
}

function run(): void {
  const migrationsDir = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const path = resolve(migrationsDir, `${latest.tag}.sql`);
  const original = readFileSync(path, "utf8");
  const finalized = finalizeTaskCryptoLifecycleMigration(original);
  if (finalized !== original) writeFileSync(path, finalized, "utf8");
}

if (import.meta.main) run();
