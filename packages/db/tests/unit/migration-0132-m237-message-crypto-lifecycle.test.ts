import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  CRYPTO_DELIVERY_TABLE_NAMES,
  LATTICE_STORAGE_TABLE_NAMES,
  conversationHumanPeerShadowOperations,
  conversationSharedAgentShadowExecutions,
  conversationSharedAgentShadowOperations,
  conversationShadowTurnOperations,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessageOrdinaryRepairs,
  sessions,
} from "../../src/schema/index.ts";
import {
  M237_LIFECYCLE_AUTHORITY_MARKER,
  M318_ORDINARY_REPAIR_AUTHORITY_MARKER,
  finalizeM237LifecycleMigration,
} from "../../scripts/finalize-m237-message-crypto-lifecycle.ts";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; tag: string }[];
};
const migrationEntry = journal.entries.find((entry) => entry.idx === 132);
const migration = migrationEntry === undefined
  ? ""
  : readFileSync(
    resolve(migrations, `${migrationEntry.tag}.sql`),
    "utf8",
  );
const ordinaryRepairMigrationEntry = journal.entries.find((entry) =>
  entry.tag === "0247_wise_firestar"
);
const ordinaryRepairMigration = ordinaryRepairMigrationEntry === undefined
  ? ""
  : readFileSync(
    resolve(migrations, `${ordinaryRepairMigrationEntry.tag}.sql`),
    "utf8",
  );

describe("M237 message crypto lifecycle schema", () => {
  test("is a content-free product ledger with bounded typed state", () => {
    const config = getTableConfig(sessionMessageCryptoRevisions);
    const names = config.columns.map((column) => column.name);

    expect(names).toEqual([
      "sequence",
      "session_id",
      "message_id",
      "edit_revision",
      "room_id",
      "namespace_id_at_allocation",
      "crypto_object_id",
      "object_id_scheme",
      "representation_mode",
      "publication_policy_revision",
      "shadow_operation_id",
      "human_peer_shadow_operation_id",
      "shared_agent_shadow_operation_id",
      "shared_agent_shadow_execution_id",
      "shadow_transcript_ordinal",
      "shadow_reserved_created_at",
      "shadow_stream_id",
      "shadow_stream_start_digest",
      "shadow_stream_terminal_digest",
      "shadow_streamed_text_digest",
      "shadow_durable_event_digest",
      "payload_version",
      "key_class",
      "author_role",
      "subthread_reply_classification",
      "append_idempotency_key",
      "allocation_request_digest",
      "repair_identity_digest",
      "repair_source_revision",
      "repair_source_digest",
      "repair_publisher_kind",
      "repair_publisher_id",
      "repair_publisher_human_id",
      "repair_attestation_digest",
      "completion",
      "disposition",
      "parity_status",
      "attempt_count",
      "next_attempt_at",
      "lease_token",
      "lease_expires_at",
      "failure_code",
      "terminal_operation_id",
      "terminal_operation_group_id",
      "terminal_operation_type",
      "terminal_expected_revision",
      "terminal_request_digest",
      "quarantine_lease_token",
      "delete_was_unread",
      "delete_orphaned_turn_id",
      "delete_root_parent_room_id",
      "delete_root_anchor_message_id",
      "delete_root_reply_count",
      "delete_root_last_reply_at",
      "delete_root_summary_revision",
      "crypto_completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(
      names.filter((name) =>
        /(?:content|ciphertext|payload_bytes|envelope|wrapped|free_form_error)/.test(
          name,
        )
      ),
    ).toEqual([]);
    expect(
      config.columns.find((column) =>
        column.name === "allocation_request_digest"
      )?.notNull,
    ).toBe(true);

    const checks = config.checks.map((item) => item.name);
    for (const expected of [
      "session_message_crypto_revisions_revision_nonnegative",
      "session_message_crypto_revisions_payload_version",
      "session_message_crypto_revisions_key_class",
      "session_message_crypto_revisions_author_role",
      "session_message_crypto_revisions_subthread_reply_classification",
      "session_message_crypto_revisions_append_receipt_coherent",
      "session_message_crypto_revisions_allocation_digest_size",
      "session_message_crypto_revisions_completion",
      "session_message_crypto_revisions_disposition",
      "session_message_crypto_revisions_parity_status",
      "session_message_crypto_revisions_parity_author_coherent",
      "session_message_crypto_revisions_attempt_bound",
      "session_message_crypto_revisions_retry_coherent",
      "session_message_crypto_revisions_lease_coherent",
      "session_message_crypto_revisions_terminal_operation_coherent",
      "session_message_crypto_revisions_terminal_digest_size",
      "session_message_crypto_revisions_quarantine_receipt_coherent",
      "session_message_crypto_revisions_delete_effects_coherent",
      "session_message_crypto_revisions_delete_root_summary_coherent",
      "session_message_crypto_revisions_delete_root_time_coherent",
      "session_message_crypto_revisions_delete_root_anchor_positive",
      "session_message_crypto_revisions_delete_root_reply_count_nonnegative",
      "session_message_crypto_revisions_delete_root_revision_nonnegative",
      "session_message_crypto_revisions_delete_orphaned_turn_id_portable",
      "session_message_crypto_revisions_object_id_portable",
      "session_message_crypto_revisions_append_idempotency_portable",
      "session_message_crypto_revisions_operation_id_portable",
      "session_message_crypto_revisions_operation_group_id_portable",
      "session_message_crypto_revisions_failure_code",
      "session_message_crypto_revisions_failure_coherent",
      "session_message_crypto_revisions_retry_exhausted_coherent",
      "session_message_crypto_revisions_attempt_exhaustion_terminal",
      "session_message_crypto_revisions_time_order",
    ]) {
      expect(checks).toContain(expected);
    }
  });

  test("keeps reverse-repair evidence append-only and exact-revision bound", () => {
    const config = getTableConfig(sessionMessageOrdinaryRepairs);
    expect(config.columns.map((column) => column.name)).toEqual([
      "session_id", "message_id", "edit_revision", "crypto_object_id",
      "expected_key_class", "authority_actor_id", "repair_identity_digest",
      "attestation_digest", "publisher_kind", "publisher_id",
      "policy_revision", "created_at",
    ]);
    const reference = config.foreignKeys[0]?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "session_id", "message_id", "edit_revision", "crypto_object_id",
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      "session_id", "message_id", "edit_revision", "crypto_object_id",
    ]);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "session_message_ordinary_repairs_product_all",
      "session_message_ordinary_repairs_agent_select",
      "session_message_ordinary_repairs_agent_insert",
    ]);
    const policySql = inspect(config.policies.at(-1)?.withCheck?.queryChunks);
    for (const fact of [
      "authenticated_runtime", "expected_key_class", "completion", "mapped",
      "app_current_agent_id", "app_agent_in_room",
    ]) expect(policySql).toContain(fact);
  });

  test("binds the immutable physical Session, Room, and allocation Namespace without blocking pending creation", () => {
    const config = getTableConfig(sessionMessageCryptoRevisions);
    const references = config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        from: reference.columns.map((column) => column.name),
        table: getTableName(reference.foreignTable),
        to: reference.foreignColumns.map((column) => column.name),
        onDelete: foreignKey.onDelete,
      };
    });

    expect(references).toEqual([
      {
        from: ["session_id"],
        table: getTableName(sessions),
        to: ["id"],
        onDelete: "cascade",
      },
      {
        from: ["room_id", "namespace_id_at_allocation"],
        table: getTableName(rooms),
        to: ["id", "namespace_id"],
        onDelete: "cascade",
      },
      {
        from: ["shadow_operation_id"],
        table: getTableName(conversationShadowTurnOperations),
        to: ["operation_id"],
        onDelete: "cascade",
      },
      {
        from: ["human_peer_shadow_operation_id"],
        table: getTableName(conversationHumanPeerShadowOperations),
        to: ["operation_id"],
        onDelete: "cascade",
      },
      {
        from: ["shared_agent_shadow_operation_id"],
        table: getTableName(conversationSharedAgentShadowOperations),
        to: ["operation_id"],
        onDelete: "cascade",
      },
      {
        from: ["shared_agent_shadow_execution_id"],
        table: getTableName(conversationSharedAgentShadowExecutions),
        to: ["execution_id"],
        onDelete: "cascade",
      },
    ]);
    expect(references.map((reference) => reference.table)).not.toContain(
      "session_messages",
    );
    expect(references.map((reference) => reference.table)).not.toContain(
      "crypto_objects",
    );

    const uniqueColumns = config.uniqueConstraints.map((constraint) =>
      constraint.columns.map((column) => column.name).join(",")
    );
    expect(uniqueColumns).toContain("session_id,message_id,edit_revision");
    expect(uniqueColumns).toContain("crypto_object_id");
    const terminalOperationIndex = config.indexes.find((index) =>
      index.config.name
        === "uq_session_message_crypto_revisions_terminal_operation"
    );
    expect(terminalOperationIndex?.config.unique).toBe(true);
    expect(
      terminalOperationIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined
      ),
    ).toEqual(["terminal_operation_id"]);
    expect(
      config.indexes.find((index) =>
        index.config.name
          === "uq_session_message_crypto_revisions_append_idempotency"
      )?.config.unique,
    ).toBe(true);
    expect(
      config.indexes.find((index) =>
        index.config.name === "idx_session_message_crypto_revisions_due"
      ),
    ).toBeDefined();
    expect(migration).toContain(
      'CREATE INDEX "idx_session_message_crypto_revisions_due" ON "session_message_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "session_message_crypto_revisions"."disposition" = \'active\'',
    );
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "session_message_crypto_revisions_product_all",
      "session_message_crypto_revisions_agent_select",
      "session_message_crypto_revisions_agent_insert",
      "session_message_crypto_revisions_agent_update",
    ]);
    expect(
      [...LATTICE_STORAGE_TABLE_NAMES, ...CRYPTO_DELIVERY_TABLE_NAMES].some(
        (name) => String(name) === "session_message_crypto_revisions",
      ),
    ).toBe(false);
  });

  test("generates 0132 with immutable Room Namespace and exact role authority", () => {
    expect(migrationEntry?.idx).toBe(132);
    expect(migration).toContain(
      'CREATE TABLE "session_message_crypto_revisions"',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'CONSTRAINT "uq_rooms_id_namespace_id" UNIQUE("id","namespace_id")',
    );
    expect(
      migration.indexOf(
        'ALTER TABLE "rooms" ADD CONSTRAINT "uq_rooms_id_namespace_id"',
      ),
    ).toBeLessThan(
      migration.indexOf(
        'ADD CONSTRAINT "session_message_crypto_revisions_room_namespace_fk"',
      ),
    );
    expect(migration).toContain(M237_LIFECYCLE_AUTHORITY_MARKER);
    expect(migration).toContain(
      'CREATE TRIGGER "rooms_namespace_id_immutable"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OF "namespace_id" ON "rooms"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "session_message_crypto_revisions_identity_immutable"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "session_message_crypto_revisions_session_room_valid"',
    );
    expect(migration).toContain(
      'FROM "public"."sessions" AS session_row',
    );
    expect(migration).toContain("FOR SHARE;");
    expect(migration).toContain(
      'BEFORE UPDATE ON "session_message_crypto_revisions"',
    );
    expect(migration).toContain(
      "OLD.disposition IN ('superseded', 'hard_delete')",
    );
    expect(migration).toContain("NEW IS DISTINCT FROM OLD");
    for (const identityColumn of [
      "session_id",
      "message_id",
      "edit_revision",
      "room_id",
      "namespace_id_at_allocation",
      "crypto_object_id",
      "payload_version",
      "key_class",
      "author_role",
      "append_idempotency_key",
      "allocation_request_digest",
      "created_at",
    ]) {
      expect(migration).toContain(`NEW.${identityColumn}`);
      expect(migration).toContain(`OLD.${identityColumn}`);
    }
    expect(migration).toContain(
      'ALTER TABLE "session_message_crypto_revisions" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    const updateGrant = migration.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(updateGrant?.[1]?.match(/"[^"]+"/g)).toEqual([
      '"completion"',
      '"disposition"',
      '"parity_status"',
      '"attempt_count"',
      '"next_attempt_at"',
      '"lease_token"',
      '"lease_expires_at"',
      '"failure_code"',
      '"terminal_operation_id"',
      '"terminal_operation_type"',
      '"terminal_expected_revision"',
      '"terminal_request_digest"',
      '"crypto_completed_at"',
      '"updated_at"',
    ]);
    expect(migration).not.toMatch(
      /GRANT (?:ALL|UPDATE) ON TABLE "session_message_crypto_revisions"\s+TO "nautilo_agent"/,
    );
    expect(migration).toMatch(
      /GRANT USAGE ON SEQUENCE "session_message_crypto_revisions_sequence_seq"\s+TO "nautilo_agent"/,
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE "session_message_crypto_revisions"\s+FROM PUBLIC, "nautilo_agent", "nautilo_crypto"/,
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON SEQUENCE "session_message_crypto_revisions_sequence_seq"\s+FROM PUBLIC, "nautilo_agent", "nautilo_crypto"/,
    );
    expect(migration).not.toMatch(
      /GRANT DELETE ON TABLE "session_message_crypto_revisions" TO "nautilo_agent"/,
    );
    expect(migration).not.toMatch(
      /GRANT [^;]*"session_message_crypto_revisions"[^;]*"nautilo_crypto"/,
    );
    expect(migration).not.toContain(
      "session_message_crypto_revisions_agent_all",
    );
    expect(migration).toContain(
      "session_message_crypto_revisions_agent_select",
    );
    expect(migration).toContain(
      "session_message_crypto_revisions_agent_insert",
    );
    expect(migration).toContain(
      "session_message_crypto_revisions_agent_update",
    );
    expect(migration).toContain(
      '"actors"."owner_id" = app_current_user_id()',
    );
    expect(migration).toMatch(
      /app_current_user_id\(\) is not null\s+and exists \(\s+select 1\s+from "sessions"\s+where "sessions"\."id" = "session_message_crypto_revisions"\."session_id"\s+and "sessions"\."room_id" = "session_message_crypto_revisions"\."room_id"\s+\)\s+and \(/,
    );
    expect(migration).toContain(
      'or app_agent_in_room("session_message_crypto_revisions"."room_id")',
    );
    expect(migration).not.toContain(
      "session_message_crypto_revisions_agent_delete",
    );
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\s+/im,
    );
    expect(migration).toMatch(
      /CONSTRAINT "session_message_crypto_revisions_parity_author_coherent" CHECK \("session_message_crypto_revisions"\."parity_status" = 'pending'\s+or \(\s+"session_message_crypto_revisions"\."completion" = 'complete'/,
    );
    expect(migration).toMatch(
      /CONSTRAINT "session_message_crypto_revisions_attempt_exhaustion_terminal" CHECK \("session_message_crypto_revisions"\."attempt_count" < 8\s+or \(\s+"session_message_crypto_revisions"\."disposition" = 'quarantined'\s+and "session_message_crypto_revisions"\."failure_code" = 'retry_exhausted'/,
    );
  });

  test("finalizer is deterministic and appends its authority exactly once", () => {
    const generated = [
      'CREATE TABLE "session_message_crypto_revisions" ("sequence" serial PRIMARY KEY NOT NULL);',
      "",
    ].join("\n");
    const once = finalizeM237LifecycleMigration(generated);
    const twice = finalizeM237LifecycleMigration(once);

    expect(twice).toBe(once);
    expect(once.match(new RegExp(M237_LIFECYCLE_AUTHORITY_MARKER, "g")))
      .toHaveLength(1);
  });

  test("finalizer closes the append-only ordinary repair table to Agent mutation", () => {
    const source = 'CREATE TABLE "session_message_ordinary_repairs" ();\n';
    const once = finalizeM237LifecycleMigration(source);
    const twice = finalizeM237LifecycleMigration(once);
    expect(twice).toBe(once);
    expect(once.split(M318_ORDINARY_REPAIR_AUTHORITY_MARKER)).toHaveLength(2);
    expect(once).toContain(
      'GRANT SELECT, INSERT ON TABLE "session_message_ordinary_repairs"',
    );
    expect(once).not.toContain(
      'GRANT UPDATE ON TABLE "session_message_ordinary_repairs"',
    );
    expect(once).not.toContain(
      'GRANT DELETE ON TABLE "session_message_ordinary_repairs"',
    );
  });

  test("0247 creates its referenced key before the exact repair FK", () => {
    const referencedKey = ordinaryRepairMigration.indexOf(
      'ADD CONSTRAINT "uq_session_message_crypto_revisions_coordinate_object"',
    );
    const receiptForeignKey = ordinaryRepairMigration.indexOf(
      'ADD CONSTRAINT "session_message_ordinary_repairs_revision_object_fk"',
    );
    expect(referencedKey).toBeGreaterThan(-1);
    expect(receiptForeignKey).toBeGreaterThan(referencedKey);
    expect(ordinaryRepairMigration).toContain(
      'FOREIGN KEY ("session_id","message_id","edit_revision","crypto_object_id")',
    );
    expect(ordinaryRepairMigration).toContain(
      'REFERENCES "public"."session_message_crypto_revisions"("session_id","message_id","edit_revision","crypto_object_id")',
    );
  });

  test("0247 grants Agent append/read evidence only under existing authority", () => {
    expect(ordinaryRepairMigration).toContain(
      'ALTER TABLE "session_message_ordinary_repairs" FORCE ROW LEVEL SECURITY',
    );
    expect(ordinaryRepairMigration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE "session_message_ordinary_repairs"\s+FROM PUBLIC, "nautilo_agent", "nautilo_crypto"/,
    );
    expect(ordinaryRepairMigration).toMatch(
      /GRANT SELECT, INSERT ON TABLE "session_message_ordinary_repairs"\s+TO "nautilo_agent"/,
    );
    expect(ordinaryRepairMigration).not.toMatch(
      /GRANT (?:UPDATE|DELETE|ALL)[^;]*"session_message_ordinary_repairs"[^;]*"nautilo_agent"/,
    );
    for (const authorityFact of [
      '"publisher_kind" = \'authenticated_runtime\'',
      '"expected_key_class" = \'ai\'',
      '"authority_actor_id" = app_current_agent_id()',
      "lifecycle.completion = 'complete'",
      "lifecycle.disposition = 'mapped'",
      "app_agent_in_room(lifecycle.room_id)",
    ]) expect(ordinaryRepairMigration).toContain(authorityFact);
    expect(ordinaryRepairMigration).not.toMatch(
      /GRANT UPDATE[^;]*"session_message_crypto_revisions"/,
    );
    expect(ordinaryRepairMigration).not.toContain(
      "session_message_crypto_revisions_agent_update",
    );
  });
});
