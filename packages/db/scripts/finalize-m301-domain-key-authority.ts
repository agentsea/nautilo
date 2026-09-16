import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
  DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES,
} from "../src/schema/domain-key-authority.ts";

export const M301_DOMAIN_KEY_AUTHORITY_MARKER =
  "-- M301_DOMAIN_KEY_AUTHORITY";

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function authoritySql(): string {
  const tables = DOMAIN_KEY_AUTHORITY_TABLE_NAMES.map(quote);
  const grants = DOMAIN_KEY_AUTHORITY_TABLE_NAMES.map((table) =>
    `GRANT ${DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES[table].join(", ")} ON TABLE ${quote(table)} TO "nautilo_crypto";`
  ).join("\n");

  return `${M301_DOMAIN_KEY_AUTHORITY_MARKER}
${tables.map((table) => `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`).join("\n")}

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'state', 'failure_code', 'updated_at', 'activated_at', 'terminal_at'
      ])
  THEN
    RAISE EXCEPTION 'Domain key operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'reserved' AND NEW.state IN ('active', 'stale', 'expired', 'failed'))
  ) OR NEW.updated_at < OLD.updated_at
    OR (OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code)
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'Domain key operation lifecycle is not monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_lifecycle"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_lifecycle"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_publications_protected"
BEFORE UPDATE ON "domain_key_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_lifecycle"();
CREATE TRIGGER "namespace_domain_key_bindings_protected"
BEFORE UPDATE ON "namespace_domain_key_bindings"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_lifecycle"();

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_request"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'fulfillment_authorization_digest',
        'fulfillment_envelope_digest', 'failure_code', 'updated_at',
        'fulfilled_at', 'terminal_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'state', 'fulfillment_authorization_digest',
        'fulfillment_envelope_digest', 'failure_code', 'updated_at',
        'fulfilled_at', 'terminal_at'
      ])
  THEN
    RAISE EXCEPTION 'Domain key access request identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('fulfilled', 'stale', 'expired', 'unrecoverable'))
  ) OR NEW.updated_at < OLD.updated_at
    OR (OLD.state <> 'pending' AND NEW IS DISTINCT FROM OLD)
    OR (NEW.state = 'fulfilled' AND (
      NEW.fulfillment_authorization_digest IS NULL
      OR NEW.fulfillment_envelope_digest IS NULL
      OR NEW.fulfilled_at IS NULL
      OR NEW.terminal_at IS NULL
    ))
  THEN
    RAISE EXCEPTION 'Domain key access request winner is not monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_request"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_request"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_requests_protected"
BEFORE UPDATE ON "domain_key_recipient_requests"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_request"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."crypto_domains" AS domain_row
   WHERE domain_row.id = NEW.domain_id
     AND domain_row.participant_digest = NEW.participant_digest
     AND cardinality(domain_row.participants) = NEW.participant_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key head disagrees with canonical Domain participants'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM "public"."domain_key_publication_operations" AS operation_row
   WHERE operation_row.operation_id = NEW.publication_operation_id
     AND operation_row.state = 'active'
     AND operation_row.domain_id = NEW.domain_id
     AND operation_row.key_class = NEW.key_class
     AND operation_row.participant_digest = NEW.participant_digest
     AND operation_row.participant_count = NEW.participant_count
     AND operation_row.domain_key_generation = NEW.domain_key_generation
     AND operation_row.authorization_revision = NEW.authorization_revision
     AND operation_row.head_digest = NEW.head_digest
     AND operation_row.head_bytes = NEW.head_bytes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key head lacks exact active publication evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_heads_authorized"
AFTER INSERT OR UPDATE ON "domain_key_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."protect_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.domain_id IS DISTINCT FROM OLD.domain_id
    OR NEW.key_class IS DISTINCT FROM OLD.key_class
    OR NEW.domain_key_generation <> OLD.domain_key_generation + 1
    OR NEW.previous_head_digest IS DISTINCT FROM OLD.head_digest
    OR NEW.authorization_revision <= OLD.authorization_revision
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Domain key head must advance from its exact predecessor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "domain_key_heads_monotonic"
BEFORE UPDATE ON "domain_key_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_request"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."domain_key_heads" AS head_row
   WHERE head_row.domain_id = NEW.domain_id
     AND head_row.key_class = NEW.key_class
     AND head_row.domain_key_generation = NEW.domain_key_generation
     AND head_row.authorization_revision = NEW.authorization_revision
     AND head_row.head_digest = NEW.head_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key request targets stale or mismatched authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'fulfilled' THEN
    PERFORM 1 FROM "public"."domain_key_recipient_envelopes" AS envelope_row
     WHERE envelope_row.source_request_id = NEW.request_id
       AND envelope_row.domain_id = NEW.domain_id
       AND envelope_row.key_class = NEW.key_class
       AND envelope_row.domain_key_generation = NEW.domain_key_generation
       AND envelope_row.authorization_revision = NEW.authorization_revision
       AND envelope_row.recipient_human_id = NEW.recipient_human_id
       AND envelope_row.recipient_kind = NEW.recipient_kind
       AND envelope_row.recipient_key_id = NEW.recipient_key_id
       AND envelope_row.recipient_key_generation = NEW.recipient_key_generation
       AND envelope_row.recipient_public_key_digest = NEW.recipient_public_key_digest
       AND envelope_row.authorization_digest = NEW.fulfillment_authorization_digest
       AND envelope_row.envelope_digest = NEW.fulfillment_envelope_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fulfilled Domain key request lacks its exact envelope'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_request"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_request"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_requests_authorized"
AFTER INSERT OR UPDATE ON "domain_key_recipient_requests"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_request"();

CREATE OR REPLACE FUNCTION "public"."validate_domain_key_envelope"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."domain_key_heads" AS head_row
   WHERE head_row.domain_id = NEW.domain_id
     AND head_row.key_class = NEW.key_class
     AND head_row.domain_key_generation = NEW.domain_key_generation
     AND head_row.authorization_revision = NEW.authorization_revision
     AND head_row.head_digest = NEW.head_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain key envelope targets stale or mismatched authority'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_request_id IS NOT NULL THEN
    PERFORM 1 FROM "public"."domain_key_recipient_requests" AS request_row
     WHERE request_row.request_id = NEW.source_request_id
       AND request_row.domain_id = NEW.domain_id
       AND request_row.key_class = NEW.key_class
       AND request_row.recipient_human_id = NEW.recipient_human_id
       AND request_row.recipient_kind = NEW.recipient_kind
       AND request_row.recipient_key_id = NEW.recipient_key_id
       AND request_row.recipient_key_generation = NEW.recipient_key_generation
       AND request_row.recipient_public_key_digest = NEW.recipient_public_key_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Domain key envelope disagrees with its exact request'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_domain_key_envelope"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_domain_key_envelope"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "domain_key_envelopes_authorized"
AFTER INSERT ON "domain_key_recipient_envelopes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_domain_key_envelope"();

CREATE OR REPLACE FUNCTION "public"."protect_namespace_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.key_class IS DISTINCT FROM OLD.key_class
    OR NEW.bundle_revision <> OLD.bundle_revision + 1
    OR NEW.activated_at < OLD.activated_at
  THEN
    RAISE EXCEPTION 'Namespace Domain-key head must advance one bundle revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."protect_namespace_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."protect_namespace_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE TRIGGER "namespace_domain_key_heads_monotonic"
BEFORE UPDATE ON "namespace_domain_key_heads"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_namespace_domain_key_head"();

CREATE OR REPLACE FUNCTION "public"."validate_namespace_domain_key_head"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1 FROM "public"."namespace_domain_key_bindings" AS binding_row
   WHERE binding_row.operation_id = NEW.binding_operation_id
     AND binding_row.state = 'active'
     AND binding_row.namespace_id = NEW.namespace_id
     AND binding_row.key_class = NEW.key_class
     AND binding_row.domain_id = NEW.domain_id
     AND binding_row.domain_key_generation = NEW.domain_key_generation
     AND binding_row.domain_authorization_revision = NEW.domain_authorization_revision
     AND binding_row.domain_head_digest = NEW.domain_head_digest
     AND binding_row.namespace_access_revision = NEW.namespace_access_revision
     AND binding_row.namespace_current_generation = NEW.namespace_current_generation
     AND binding_row.bundle_revision = NEW.bundle_revision
     AND binding_row.retained_generation_count = NEW.retained_generation_count
     AND binding_row.retained_authority_set_digest = NEW.retained_authority_set_digest
     AND binding_row.binding_digest = NEW.binding_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Namespace Domain-key head lacks exact active binding evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "public"."validate_namespace_domain_key_head"()
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
GRANT EXECUTE ON FUNCTION "public"."validate_namespace_domain_key_head"()
  TO "nautilo_crypto", "nautilo";
CREATE CONSTRAINT TRIGGER "namespace_domain_key_heads_authorized"
AFTER INSERT OR UPDATE ON "namespace_domain_key_heads"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."validate_namespace_domain_key_head"();

REVOKE ALL PRIVILEGES ON TABLE
  ${tables.join(",\n  ")}
FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";
${grants}`;
}

export function finalizeM301DomainKeyAuthorityMigration(migration: string): string {
  const marker = migration.indexOf(M301_DOMAIN_KEY_AUTHORITY_MARKER);
  if (marker >= 0) return `${migration.slice(0, marker)}${authoritySql()}\n`;
  const created = DOMAIN_KEY_AUTHORITY_TABLE_NAMES.filter((table) =>
    migration.includes(`CREATE TABLE "${table}"`)
  );
  if (created.length === 0) return migration;
  if (created.length !== DOMAIN_KEY_AUTHORITY_TABLE_NAMES.length) {
    throw new Error(
      `M301 Domain-key authority generation is incomplete: found ${created.length}/${DOMAIN_KEY_AUTHORITY_TABLE_NAMES.length} tables`,
    );
  }
  return `${migration}${migration.endsWith("\n") ? "" : "\n"}--> statement-breakpoint
${authoritySql()}
`;
}

function run(): void {
  const migrationsDirectory = resolve(import.meta.dir, "../src/migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as { entries: readonly { tag: string }[] };
  if (journal.entries.length === 0) throw new Error("Migration journal is empty");
  for (const entry of journal.entries) {
    const migrationPath = resolve(migrationsDirectory, `${entry.tag}.sql`);
    const migration = readFileSync(migrationPath, "utf8");
    const finalized = finalizeM301DomainKeyAuthorityMigration(migration);
    if (finalized !== migration) writeFileSync(migrationPath, finalized, "utf8");
  }
}

if (import.meta.main) run();
