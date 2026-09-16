import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
} from "../../src/schema/crypto-storage.ts";

const M232_CRYPTO_DELIVERY_TABLE_NAMES = [
  "human_crypto_custodies",
  "human_crypto_devices",
  "human_crypto_device_challenges",
  "human_crypto_recovery_keys",
  "human_crypto_device_key_packages",
  "crypto_domain_devices",
  "crypto_delivery_operations",
  "crypto_human_membership_transitions",
  "crypto_device_epoch_operations",
  "crypto_domain_transition_steps",
  "crypto_domain_transition_namespaces",
  "crypto_delivery_messages",
  "crypto_delivery_acknowledgements",
  "crypto_operation_outbox",
] as const;

const migration = readFileSync(
  resolve(
    import.meta.dir,
    "../../src/migrations/0126_conscious_ricochet.sql",
  ),
  "utf8",
);
const activationGateMigration = migration;
const inventoryHeadMigration = migration;
const deliveryProtocolMigration = migration;
const retentionAuthorityMigration = migration;
const membershipCandidateMigration = migration;
const deferredMembershipMigration = migration;
const roomRoleMigration = migration;

describe("Wave 7 crypto delivery migration", () => {
  test("is generated additively with the exact 14-table inventory", () => {
    const createdTables = [...migration.matchAll(
      /^CREATE TABLE "([a-z_]+)"/gm,
    )].map((match) => match[1]);
    expect(createdTables.sort()).toEqual(
      [...M232_CRYPTO_DELIVERY_TABLE_NAMES].sort(),
    );
    expect(migration).toContain(
      'ALTER TABLE "crypto_domains" ADD COLUMN "writes_paused"',
    );
    expect(migration).toContain(
      'ALTER TABLE "namespace_crypto_heads" ADD COLUMN "writes_paused"',
    );
    expect(migration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* RENAME)/m,
    );

    const allowedAlterTargets = new Set([
      ...M232_CRYPTO_DELIVERY_TABLE_NAMES,
      "crypto_domains",
      "namespace_crypto_heads",
    ]);
    for (const match of migration.matchAll(
      /^ALTER TABLE "([a-z_]+)"/gm,
    )) {
      expect(allowedAlterTargets.has(match[1]!), match[1]).toBe(true);
    }
  });

  test("forces RLS and grants only the canonical dedicated-role privileges", () => {
    expect(migration).toContain("-- M232_CRYPTO_DELIVERY_AUTHORITY");
    expect(
      migration.match(/ FORCE ROW LEVEL SECURITY/g),
    ).toHaveLength(M232_CRYPTO_DELIVERY_TABLE_NAMES.length);
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );

    for (const table of M232_CRYPTO_DELIVERY_TABLE_NAMES) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).not.toMatch(
        new RegExp(
          `CREATE POLICY [^;]+ ON "${table}"[^;]+TO (?:PUBLIC|"nautilo_agent")`,
        ),
      );
    }

    const cumulativeAuthority = `${migration}\n${retentionAuthorityMigration}`;
    const actualPrivileges = Object.fromEntries(
      [...cumulativeAuthority.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE([\s\S]*?)TO "nautilo_crypto";/g,
      )].flatMap((match) => {
        const privileges = match[1]!.split(", ");
        return [...match[2]!.matchAll(/"([a-z_]+)"/g)].map(
          (tableMatch) => [tableMatch[1]!, privileges] as const,
        );
      }),
    );
    const expectedPrivileges = Object.fromEntries(
      M232_CRYPTO_DELIVERY_TABLE_NAMES.map((table) => [
        table,
        Array.from(CRYPTO_STORAGE_TABLE_PRIVILEGES[table]),
      ]),
    );
    expect(actualPrivileges).toEqual(expectedPrivileges);
    expect(retentionAuthorityMigration).toContain(
      "-- M232_CRYPTO_DELIVERY_AUTHORITY",
    );
    expect(retentionAuthorityMigration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE',
    );
    expect(migration).toContain("-- M232_CRYPTO_IDENTITY_READ_AUTHORITY");
    expect(migration).toContain(
      'GRANT SELECT ("id") ON TABLE "users" TO "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT ("id", "owner_id", "kind") ON TABLE "actors" TO "nautilo_crypto"',
    );
    expect(migration).not.toMatch(
      /GRANT SELECT ON TABLE "(?:users|actors)" TO "nautilo_crypto"/,
    );
  });

  test("keeps generated authority finalization in the repository command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const generateSteps = packageJson.scripts["db:generate"]?.split(" && ");
    expect(generateSteps?.slice(0, 2)).toEqual([
      "NAUTILO_DRIZZLE_OFFLINE=1 drizzle-kit generate",
      "bun scripts/finalize-crypto-delivery-migration.ts",
    ]);
  });

  test("adds restart-safe activation gates and database concurrency barriers", () => {
    for (const column of [
      "expected_inventory_revision",
      "expected_inventory_count",
      "expected_inventory_digest",
      "authorization_artifact_hash",
      "recovery_readiness_digest",
    ]) {
      expect(activationGateMigration).toContain(
        `"${column}"`,
      );
    }
    for (const index of [
      "uq_crypto_delivery_operations_live_device_roster",
      "uq_crypto_domain_transition_steps_live_domain",
      "uq_crypto_domain_transition_namespaces_live_namespace",
    ]) {
      expect(activationGateMigration).toContain(
        `CREATE UNIQUE INDEX "${index}"`,
      );
    }
    expect(activationGateMigration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* RENAME)/m,
    );
  });

  test("adds a durable current Human inventory commitment", () => {
    for (const column of [
      "current_inventory_revision",
      "current_inventory_count",
      "current_inventory_digest",
    ]) {
      expect(inventoryHeadMigration).toContain(`"${column}"`);
    }
    expect(inventoryHeadMigration).toContain(
      "human_crypto_custodies_inventory_coherent",
    );
    expect(inventoryHeadMigration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* RENAME)/m,
    );
  });

  test("binds recovery verification and join requests to exact delivery state", () => {
    expect(deliveryProtocolMigration).toContain(
      '"expected_response_digest" "bytea"',
    );
    expect(deliveryProtocolMigration).toContain(
      '"domain_id" text NOT NULL',
    );
    expect(deliveryProtocolMigration).toContain(
      '"expected_provider_head_hash" "bytea"',
    );
    expect(deliveryProtocolMigration).toContain(
      "human_crypto_device_key_packages_domain_fk",
    );
    expect(deliveryProtocolMigration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* RENAME)/m,
    );
  });

  test("stages one exact Human membership rebind before canonical activation", () => {
    for (const column of [
      "committer_device_id",
      "target_domain_epoch",
      "candidate_binding_hash",
      "candidate_digest",
      "candidate_signed_binding_bytes",
      "candidate_human_keyring_envelope_bytes",
      "candidate_ai_keyring_envelope_bytes",
      "candidate_submitted_at",
      "activated_at",
      "released_at",
    ]) {
      expect(membershipCandidateMigration).toContain(`"${column}"`);
    }
    expect(membershipCandidateMigration).toContain(
      "uq_crypto_human_membership_transitions_live_namespace",
    );
    expect(membershipCandidateMigration).toContain(
      "crypto_human_membership_transitions_candidate_coherent",
    );
    expect(membershipCandidateMigration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* (?:DROP COLUMN|RENAME))/m,
    );
  });

  test("defers invited-Human coordinates without weakening resolved candidates", () => {
    expect(deferredMembershipMigration).toContain(
      '"target_domain_id" text',
    );
    for (const column of [
      "admitted_bootstrap_device_id",
      "admitted_target_domain_id",
      "bootstrap_authority_id",
    ]) {
      expect(deferredMembershipMigration).toContain(`"${column}"`);
    }
    expect(deferredMembershipMigration).toContain(
      "crypto_human_membership_transitions_resolution_coherent",
    );
    expect(deferredMembershipMigration).toContain(
      "human_crypto_device_challenges_bootstrap_authority",
    );
    expect(deferredMembershipMigration).toContain(
      '"target_domain_id" is not null',
    );
    expect(deferredMembershipMigration).not.toMatch(
      /^(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* (?:DROP COLUMN|RENAME))/m,
    );
  });

  test("persists the exact target Room role without rewriting existing rows", () => {
    expect(roomRoleMigration).toContain(
      '"target_room_role" text',
    );
    expect(roomRoleMigration).toContain(
      "crypto_human_membership_transitions_target_room_role",
    );
    expect(roomRoleMigration).toContain(
      `"target_room_role" in ('admin', 'member')`,
    );
    expect(roomRoleMigration).not.toMatch(
      /^(?:DROP|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE .* (?:DROP COLUMN|RENAME))/m,
    );
  });
});
