import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
  cryptoObjects, nautiloCryptoRole, taskHistoricalContentCryptoStagingReceipts,
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
} from "../../src/schema/crypto-storage";
import { finalizeTaskCancellationStagingMigration } from
  "../../scripts/finalize-task-cancellation-staging";

test("historical staging retains bounded public signatures with crypto-only append access", () => {
  const table = taskHistoricalContentCryptoStagingReceipts;
  const config = getTableConfig(table);
  expect(config.columns.map(column => column.name)).toEqual([
    "crypto_object_id", "operation_id", "signed_publication_request_bytes",
    "signed_request_digest", "authority_fingerprint", "genesis_manifest_hash", "staged_at",
  ]);
  expect(config.enableRLS).toBe(true);
  expect(config.columns.every(column => !column.hasDefault)).toBe(true);
  expect(config.policies.map(policy => ({ role: policy.to, operation: policy.for })))
    .toEqual([{ role: nautiloCryptoRole, operation: "select" },
      { role: nautiloCryptoRole, operation: "insert" }]);
  expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.task_historical_content_crypto_staging_receipts)
    .toEqual(["SELECT", "INSERT"]);
  const checks = config.checks.map(value => new PgDialect().sqlToQuery(value.value).sql)
    .join("\n").replaceAll(/\s+/gu, " ");
  expect(checks).toContain("^task-historical:v1:[0-9a-f]{64}$");
  expect(checks).toContain("between 1 and 1048576");
  expect(checks.match(/= 32/g)).toHaveLength(3);
  expect(config.foreignKeys).toHaveLength(1);
  expect(config.foreignKeys[0]!.reference().foreignTable).toBe(cryptoObjects);
  expect(config.foreignKeys[0]!.onDelete).toBe("cascade");
  const name = "task_historical_content_crypto_staging_receipts";
  const migration = finalizeTaskCancellationStagingMigration(`CREATE TABLE "${name}" ("crypto_object_id" text PRIMARY KEY);`);
  expect(migration).toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`);
  expect(migration).toContain(`GRANT SELECT, INSERT ON TABLE "${name}" TO "nautilo_crypto"`);
  expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/);
  expect(finalizeTaskCancellationStagingMigration(migration)).toBe(migration);
});
