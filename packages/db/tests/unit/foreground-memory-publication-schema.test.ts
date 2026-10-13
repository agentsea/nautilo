import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { foregroundMemoryCryptoPublicationReceipts } from
  "../../src/schema/crypto-storage";
import { cryptoObjects, nautiloCryptoRole, CRYPTO_STORAGE_TABLE_PRIVILEGES } from
  "../../src/schema/crypto-storage";

test("fresh Memory publication retains only exact immutable ciphertext commitments", () => {
  const config = getTableConfig(foregroundMemoryCryptoPublicationReceipts);
  expect(config.columns.map(column => column.name)).toEqual([
    "operation_id", "crypto_object_id", "memory_id", "content_revision", "agent_id",
    "reservation_digest", "required_namespace_fingerprint", "genesis_manifest_hash", "staged_at",
  ]);
  expect(config.enableRLS).toBe(true);
  expect(config.policies.map(policy => ({ role: policy.to, operation: policy.for })))
    .toEqual([{ role: nautiloCryptoRole, operation: "select" },
      { role: nautiloCryptoRole, operation: "insert" }]);
  expect(CRYPTO_STORAGE_TABLE_PRIVILEGES.foreground_memory_crypto_publication_receipts)
    .toEqual(["SELECT", "INSERT"]);
  expect(config.foreignKeys).toHaveLength(1);
  expect(config.foreignKeys[0]!.reference().foreignTable).toBe(cryptoObjects);
  expect(config.foreignKeys[0]!.onDelete).toBe("cascade");
  const checks = config.checks.map(check => new PgDialect().sqlToQuery(check.value).sql).join("\n");
  expect(checks).toContain("^memory:v1:[0-9a-f]{64}$");
  expect(checks.match(/= 32/g)).toHaveLength(3);
});
