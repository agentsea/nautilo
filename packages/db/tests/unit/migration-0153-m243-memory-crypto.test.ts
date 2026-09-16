import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { M243_MEMORY_CRYPTO_LIFECYCLE_MARKER } from "../../scripts/finalize-m243-memory-crypto-lifecycle";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0153_rare_piledriver";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; when: number; tag: string }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0153_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    columns: Record<string, unknown>;
    foreignKeys: Record<string, {
      tableTo: string;
      columnsFrom: readonly string[];
      columnsTo: readonly string[];
      onDelete: string;
    }>;
    uniqueConstraints: Record<string, { columns: readonly string[] }>;
    policies: Record<string, unknown>;
    checkConstraints: Record<string, { value: string }>;
    isRLSEnabled: boolean;
  }>;
};

const RECEIPT_TABLE = "memory_crypto_revisions";
const OPERATION_TABLE = "memory_crypto_operations";

describe("M243 generated Memory crypto migration", () => {
  test("records one current monotonic additive migration", () => {
    const entry = journal.entries.find((item) => item.idx === 153);
    const previous = journal.entries.find((item) => item.idx === 152);

    expect(entry).toMatchObject({ idx: 153, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE) TABLE\b/i);
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  test("adds only the bounded Memory mapping, provenance, and origin fields", () => {
    for (const column of [
      "crypto_object_id",
      "content_revision",
      "crypto_access_revision",
      "crypto_required_namespace_fingerprint",
      "embedding_revision",
      "embedding_provider",
      "embedding_model",
      "embedding_dimensions",
      "embedding_contract_version",
      "scope_origin_namespace_id",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "memories" ADD COLUMN "${column}"`,
      );
    }
    expect(migration).toContain(
      'FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("scope_origin_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "memory_scopes_origin_check" CHECK ("memory_scopes"."origin" in (\'seed\', \'scope\'))',
    );
    expect(migration).not.toMatch(
      /ALTER TABLE "memories" ALTER COLUMN "(?:content|type|embedding)"/,
    );
  });

  test("creates one content-free bounded lifecycle receipt", () => {
    const table = snapshot.tables[`public.${RECEIPT_TABLE}`]!;
    expect(table).toBeDefined();
    expect(table.isRLSEnabled).toBe(true);
    expect(Object.keys(table.columns)).toEqual([
      "sequence",
      "memory_id",
      "content_revision",
      "anchor_namespace_id",
      "crypto_object_id",
      "payload_version",
      "allocation_request_digest",
      "required_namespace_fingerprint",
      "completion",
      "disposition",
      "attempt_count",
      "next_attempt_at",
      "lease_token",
      "lease_expires_at",
      "failure_code",
      "crypto_completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(table.uniqueConstraints).toMatchObject({
      uq_memory_crypto_revisions_coordinate: {
        columns: ["memory_id", "content_revision"],
      },
      uq_memory_crypto_revisions_object: {
        columns: ["crypto_object_id"],
      },
    });
    const checkNames = Object.keys(table.checkConstraints);
    for (const checkName of [
      "memory_crypto_revisions_revision_positive",
      "memory_crypto_revisions_payload_version",
      "memory_crypto_revisions_attempt_bound",
      "memory_crypto_revisions_completion_coherent",
    ]) {
      expect(checkNames).toContain(checkName);
    }
    expect(table.foreignKeys).toEqual({});

    for (const forbidden of [
      "content",
      "type",
      "embedding",
      "vector",
      "plaintext",
      "ciphertext",
      "raw_key",
      "wrapped_key",
    ]) {
      expect(Object.keys(table.columns)).not.toContain(forbidden);
    }
  });

  test("retains every repeated update, access change, and delete identity", () => {
    const table = snapshot.tables[`public.${OPERATION_TABLE}`]!;
    expect(table).toBeDefined();
    expect(table.isRLSEnabled).toBe(true);
    expect(Object.keys(table.columns)).toEqual([
      "sequence",
      "operation_id",
      "memory_id",
      "anchor_namespace_id",
      "operation_type",
      "expected_content_revision",
      "result_content_revision",
      "expected_access_revision",
      "result_access_revision",
      "request_digest",
      "target_required_namespace_fingerprint",
      "completion",
      "disposition",
      "attempt_count",
      "next_attempt_at",
      "lease_token",
      "lease_expires_at",
      "failure_code",
      "crypto_completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(table.uniqueConstraints).toMatchObject({
      uq_memory_crypto_operations_id: { columns: ["operation_id"] },
    });
    expect(Object.keys(table.checkConstraints)).toContain(
      "memory_crypto_operations_shape",
    );
    expect(table.foreignKeys).toEqual({});
    expect(migration).toContain(
      'CREATE FUNCTION "public"."reject_memory_crypto_operation_identity_update"()',
    );
    expect(migration).not.toMatch(
      /GRANT [^;]*DELETE[^;]*ON TABLE "memory_crypto_operations"/,
    );
  });

  test("forces member-scoped product authority and denies the crypto role", () => {
    const table = snapshot.tables[`public.${RECEIPT_TABLE}`]!;
    expect(Object.keys(table.policies)).toEqual([
      "memory_crypto_revisions_product_all",
      "memory_crypto_revisions_agent_select",
      "memory_crypto_revisions_agent_insert",
      "memory_crypto_revisions_agent_update",
    ]);
    expect(migration).toContain(M243_MEMORY_CRYPTO_LIFECYCLE_MARKER);
    expect(migration).toContain(
      `ALTER TABLE "${RECEIPT_TABLE}" FORCE ROW LEVEL SECURITY`,
    );
    expect(migration).toContain(
      `ALTER TABLE "${OPERATION_TABLE}" FORCE ROW LEVEL SECURITY`,
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE "memory_crypto_revisions", "memory_crypto_operations"[\s\S]+FROM PUBLIC, "nautilo_agent", "nautilo_crypto"/,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE "memory_crypto_revisions", "memory_crypto_operations"[\s\S]+TO "nautilo_agent"/,
    );
    expect(migration).not.toMatch(
      /GRANT [^;]+ON TABLE "memory_crypto_revisions"[^;]+TO "nautilo_crypto"/,
    );
    expect(migration).not.toMatch(
      /GRANT [^;]*DELETE[^;]*ON TABLE "memory_crypto_revisions"/,
    );
  });

  test("keeps generated deployment dormant and content-neutral", () => {
    for (const forbidden of [
      "background_crypto_authorization_requests",
      "crypto_device_envelopes",
      "crypto_object_access_manifests",
      "INSERT INTO \"crypto_objects\"",
      "Wave0Activation",
      "activation_stage",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
  });
});
