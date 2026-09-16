import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { finalizeM304HumanDeviceMembershipMigration } from "../../scripts/finalize-m304-human-device-membership.ts";

const migration = readFileSync(
  resolve(
    import.meta.dir,
    "../../src/migrations/0222_vengeful_gorgon.sql",
  ),
  "utf8",
);

describe("M304 generated Human-device membership migration", () => {
  test("adds one head, ordered commits, target Welcome, and acknowledgements", () => {
    for (const table of [
      "human_crypto_device_group_heads",
      "human_crypto_device_group_commits",
      "human_crypto_device_group_welcomes",
      "human_crypto_device_group_acknowledgements",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain(
      'UNIQUE("server_instance_id","human_id","lineage_generation")',
    );
    expect(migration).toContain(
      'PRIMARY KEY("human_id","lineage_generation","sequence")',
    );
  });

  test("binds existing device rows to exact current membership coordinates", () => {
    for (const column of [
      "membership_state",
      "membership_server_instance_id",
      "membership_lineage_generation",
      "membership_epoch",
      "membership_security_revision",
      "membership_leaf_index",
      "membership_head_digest",
      "membership_acknowledged_sequence",
    ]) expect(migration).toContain(`ADD COLUMN "${column}"`);
    expect(migration).toContain(
      'ADD CONSTRAINT "human_crypto_devices_membership_coherent"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "uq_nautilo_instance_identity_server_instance"',
    );
    expect(migration).toContain(
      'GRANT SELECT ("id", "server_instance_id") ON TABLE "nautilo_instance_identity"',
    );
  });

  test("creates referenced uniqueness before Human-device group foreign keys", () => {
    const firstGroupForeignKey = migration.indexOf(
      'ADD CONSTRAINT "human_crypto_device_group_acknowledgements_custody_fk"',
    );
    expect(firstGroupForeignKey).toBeGreaterThan(0);
    for (const prerequisite of [
      'ADD CONSTRAINT "uq_nautilo_instance_identity_server_instance"',
      'ADD CONSTRAINT "uq_human_crypto_devices_identity_generation"',
    ]) {
      const position = migration.indexOf(prerequisite);
      expect(position).toBeGreaterThan(0);
      expect(position).toBeLessThan(firstGroupForeignKey);
    }
  });

  test("keeps generated prerequisite ordering idempotent", () => {
    expect(finalizeM304HumanDeviceMembershipMigration(migration)).toBe(
      migration,
    );
  });

  test("is additive to product data and stores no private or content key", () => {
    expect(migration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* RENAME)/m,
    );
    for (const forbidden of [
      "provider_state",
      "exporter_secret",
      "domain_key",
      "namespace_key",
      "private_key",
      "message_content",
    ]) expect(migration).not.toContain(`"${forbidden}"`);
  });

  test("grants only the crypto role and keeps Welcome separate from commits", () => {
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).not.toMatch(
      /CREATE POLICY [^;]+ ON "human_crypto_device_group_[^"]+"[^;]+TO (?:PUBLIC|"nautilo_agent")/,
    );
    const commitTable = migration.slice(
      migration.indexOf('CREATE TABLE "human_crypto_device_group_commits"'),
      migration.indexOf('ALTER TABLE "human_crypto_device_group_commits" ENABLE'),
    );
    expect(commitTable).toContain('"welcome_digest" "bytea"');
    expect(commitTable).not.toContain('"welcome_bytes"');
  });
});
