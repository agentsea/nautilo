import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { taskTerminalMessageCryptoStagingReceipts, cryptoObjects, nautiloCryptoRole,
  CRYPTO_STORAGE_TABLE_PRIVILEGES, LATTICE_STORAGE_TABLES,
} from "../../src/schema/crypto-storage";
import { finalizeTaskCancellationStagingMigration } from "../../scripts/finalize-task-cancellation-staging";

describe("terminal Task Message staging custody", () => {
  test("only the crypto role may read and append immutable content-free provenance", () => {
    const config = getTableConfig(taskTerminalMessageCryptoStagingReceipts);
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map(column => column.name)).toEqual([
      "request_id", "recipient_generation", "claim_id", "authorization_digest",
      "delivery_intent_hash", "raw_result_message_intent", "accepted_policy_revision", "publication_policy_revision",
      "authority_fingerprint", "crypto_object_id", "genesis_manifest_hash", "staged_at",
    ]);
    expect(config.policies.map(policy => ({ role: policy.to, operation: policy.for })))
      .toEqual([{ role: nautiloCryptoRole, operation: "select" }, { role: nautiloCryptoRole, operation: "insert" }]);
    expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.task_terminal_message_crypto_staging_receipts).toEqual(["SELECT", "INSERT"]);
    const table = "task_terminal_message_crypto_staging_receipts";
    const migration = finalizeTaskCancellationStagingMigration(`CREATE TABLE "${table}" ("request_id" text PRIMARY KEY);`);
    expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(migration).toContain(`GRANT SELECT, INSERT ON TABLE "${table}" TO "nautilo_crypto"`);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/);
    expect(finalizeTaskCancellationStagingMigration(migration)).toBe(migration);
  });
  test("anchors cleanup to the exact object and preserves original versus publication policy", () => {
    const config = getTableConfig(taskTerminalMessageCryptoStagingReceipts);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(cryptoObjects);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(config.uniqueConstraints.map(constraint => constraint.columns.map(column => column.name)))
      .toContainEqual(["crypto_object_id"]);
    const dialect = new PgDialect();
    const constraints = config.checks.map(check => dialect.sqlToQuery(check.value).sql).join("\n");
    expect(constraints).toContain("^message:v2:[0-9a-f]{64}$");
    expect(constraints).toContain('"publication_policy_revision" >= "task_terminal_message_crypto_staging_receipts"."accepted_policy_revision"');
    expect(LATTICE_STORAGE_TABLES.map(getTableName)).toContain("task_terminal_message_crypto_staging_receipts");
  });
});
