import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const M275_HISTORY_READ_OBSERVATIONS_MARKER =
  "-- M275_HISTORY_READ_OBSERVATIONS";

const TABLE = "encryption_transition_history_read_admissions";
const FUNCTION = "protect_encryption_transition_history_read_admission";

function authoritySql(): string {
  return `${M275_HISTORY_READ_OBSERVATIONS_MARKER}
ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "${TABLE}"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${TABLE}"
  TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."${FUNCTION}"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'history-read admission time must be monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('consumed', 'expired') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal history-read admission is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state = 'planned' THEN
    IF (to_jsonb(NEW) - ARRAY['token_digest', 'updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['token_digest', 'updated_at'])
    THEN
      RAISE EXCEPTION 'planned history-read admission may rotate only its token'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state NOT IN ('consumed', 'expired')
    OR (to_jsonb(NEW) - ARRAY[
      'state', 'consumption_kind', 'acknowledgement_digest',
      'ordered_result_set_digest', 'verified_count',
      'client_crypto_unavailable_count',
      'client_custody_unavailable_count',
      'current_read_authority_unavailable_count',
      'retained_key_material_unavailable_count',
      'signer_evidence_unavailable_count',
      'live_shadow_lifecycle_unavailable_count',
      'integrity_failure_count', 'parity_mismatch_count',
      'client_observation_expired_count', 'terminal_at', 'updated_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'state', 'consumption_kind', 'acknowledgement_digest',
      'ordered_result_set_digest', 'verified_count',
      'client_crypto_unavailable_count',
      'client_custody_unavailable_count',
      'current_read_authority_unavailable_count',
      'retained_key_material_unavailable_count',
      'signer_evidence_unavailable_count',
      'live_shadow_lifecycle_unavailable_count',
      'integrity_failure_count', 'parity_mismatch_count',
      'client_observation_expired_count', 'terminal_at', 'updated_at'
    ])
  THEN
    RAISE EXCEPTION 'history-read admission identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."${FUNCTION}"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."${FUNCTION}"()
  TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "encryption_transition_history_read_admissions_monotonic"
BEFORE UPDATE ON "${TABLE}"
FOR EACH ROW EXECUTE FUNCTION "public"."${FUNCTION}"();`;
}

export function finalizeM275HistoryReadObservationsMigration(
  migration: string,
): string {
  const marker = migration.indexOf(M275_HISTORY_READ_OBSERVATIONS_MARKER);
  if (marker >= 0) return `${migration.slice(0, marker)}${authoritySql()}\n`;
  if (!migration.includes(`CREATE TABLE "${TABLE}"`)) return migration;
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}
`;
}

function run(): void {
  const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  const latest = journal.entries.at(-1);
  if (latest === undefined) throw new Error("Migration journal is empty");
  const migrationPath = resolve(migrationsDirectory, `${latest.tag}.sql`);
  const migration = readFileSync(migrationPath, "utf8");
  const finalized = finalizeM275HistoryReadObservationsMigration(migration);
  if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
}

if (import.meta.main) run();
