import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
  LATTICE_STORAGE_TABLE_NAMES,
  LATTICE_STORAGE_TABLES,
  cryptoObjects,
  nautiloCryptoRole,
  taskCancellationCryptoStagingReceipts,
} from "../../src/schema/crypto-storage";

function normalizedCheckSql(name: string): string {
  const constraint = getTableConfig(taskCancellationCryptoStagingReceipts)
    .checks.find((candidate) => candidate.name === name);
  expect(constraint, name).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("Task cancellation crypto staging receipt schema", () => {
  test("stores one content-free receipt with exact bounded fields", () => {
    const config = getTableConfig(taskCancellationCryptoStagingReceipts);
    expect(config.columns.map((column) => column.name)).toEqual([
      "request_id",
      "recipient_generation",
      "claim_id",
      "authorization_digest",
      "stopped_intent_hash",
      "policy_revision",
      "authority_fingerprint",
      "crypto_object_id",
      "genesis_manifest_hash",
      "staged_at",
    ]);
    expect(config.columns.find((column) => column.name === "request_id")?.primary)
      .toBe(true);
    expect(config.uniqueConstraints.map((constraint) => constraint.name))
      .toContain("uq_task_cancel_staging_object");
    expect(config.columns.every((column) => !column.hasDefault)).toBe(true);

    for (const name of [
      "task_cancel_staging_authorization_digest_size",
      "task_cancel_staging_stopped_intent_hash_size",
      "task_cancel_staging_authority_fingerprint_size",
      "task_cancel_staging_genesis_manifest_hash_size",
    ]) {
      expect(normalizedCheckSql(name)).toContain("octet_length");
      expect(normalizedCheckSql(name)).toContain("= 32");
    }
    expect(normalizedCheckSql("task_cancel_staging_generation_safe"))
      .toContain("between 0 and 9007199254740991");
    expect(normalizedCheckSql("task_cancel_staging_policy_revision_positive"))
      .toContain(">= 1");
    expect(normalizedCheckSql("task_cancel_staging_object_shape"))
      .toContain("^task-run-result:v1:[0-9a-f]{64}$");
  });

  test("ties receipt cleanup only to the exact encrypted object", () => {
    const config = getTableConfig(taskCancellationCryptoStagingReceipts);
    expect(config.foreignKeys).toHaveLength(1);
    const foreignKey = config.foreignKeys[0]!;
    expect(foreignKey.getName()).toBe("task_cancel_staging_object_fk");
    expect(getTableName(foreignKey.reference().foreignTable)).toBe(
      getTableName(cryptoObjects),
    );
    expect(foreignKey.onDelete).toBe("cascade");
    expect(foreignKey.reference().columns.map((column) => column.name)).toEqual([
      "crypto_object_id",
    ]);
    expect(foreignKey.reference().foreignColumns.map((column) => column.name))
      .toEqual(["object_id"]);
  });

  test("is append-only and reachable only through the crypto role", () => {
    const config = getTableConfig(taskCancellationCryptoStagingReceipts);
    expect(config.enableRLS).toBe(true);
    expect(config.policies.map((policy) => ({
      name: policy.name,
      operation: policy.for,
      role: policy.to,
    }))).toEqual([
      {
        name: "task_cancel_staging_crypto_sel",
        operation: "select",
        role: nautiloCryptoRole,
      },
      {
        name: "task_cancel_staging_crypto_ins",
        operation: "insert",
        role: nautiloCryptoRole,
      },
    ]);
    expect(
      CRYPTO_STORAGE_TABLE_PRIVILEGES
        .task_cancellation_crypto_staging_receipts,
    ).toEqual(["SELECT", "INSERT"]);
  });

  test("participates in the crypto registry but not the generic adapter", () => {
    expect(LATTICE_STORAGE_ADAPTER_TABLE_NAMES).not.toContain(
      "task_cancellation_crypto_staging_receipts",
    );
    expect(LATTICE_STORAGE_TABLE_NAMES).toContain(
      "task_cancellation_crypto_staging_receipts",
    );
    expect(LATTICE_STORAGE_TABLES.map(getTableName)).toContain(
      "task_cancellation_crypto_staging_receipts",
    );
  });
});
