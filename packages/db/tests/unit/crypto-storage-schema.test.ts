import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  CRYPTO_STORAGE_BYTE_LIMITS,
  CRYPTO_STORAGE_COLLECTION_LIMITS,
  CRYPTO_STORAGE_TABLE_PRIVILEGES,
  LATTICE_STORAGE_TABLES,
  nautiloCryptoRole,
} from "../../src/schema/crypto-storage";

const WAVE_6_TABLE_NAMES = [
  "crypto_domains",
  "crypto_domain_provider_heads",
  "namespace_crypto_bindings",
  "namespace_crypto_heads",
  "crypto_objects",
  "object_crypto_access_manifests",
  "object_crypto_namespace_envelopes",
  "object_crypto_access_heads",
  "agent_crypto_runtime_states",
  "agent_crypto_runtime_config_objects",
  "agent_crypto_runtime_domain_envelopes",
  "agent_crypto_runtime_challenges",
  "agent_crypto_runtime_signers",
  "crypto_grants",
  "human_crypto_recovery_archives",
] as const;
const EXPECTED_TABLE_NAMES = [
  ...WAVE_6_TABLE_NAMES,
  "background_crypto_authorization_requests",
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
  "processor_crypto_signer_authorizations",
] as const;

const migration = readFileSync(
  resolve(
    import.meta.dir,
    "../../src/migrations/0125_purple_cerise.sql",
  ),
  "utf8",
);
const m315Migration = readFileSync(
  resolve(
    import.meta.dir,
    "../../src/migrations/0231_majestic_texas_twister.sql",
  ),
  "utf8",
);

describe("Wave 6 crypto storage schema", () => {
  test("M315 widens only generated constraints for the 16K Agent-grant envelope", () => {
    expect(m315Migration).toContain(
      'octet_length("crypto_grants"."grant_bytes") between 1\n      and 16777216',
    );
    expect(m315Migration).toContain(
      '"agent_crypto_runtime_domain_envelopes"."ordinal" between 0\n      and 16383',
    );
    expect(m315Migration).toContain(
      '"agent_crypto_runtime_challenges"."ordinal" between 0\n      and 16383',
    );
    expect(m315Migration).toContain("and 16912384");
    expect(m315Migration).toContain("and 8388608");
    expect(m315Migration).toContain("and 18874368");
    expect(m315Migration).not.toMatch(
      /\b(?:CREATE|DROP)\s+(?:TABLE|COLUMN)|\bALTER\s+COLUMN\b|\bUPDATE\b/iu,
    );
  });

  test("freezes the exact durable record map including signer history", () => {
    expect(LATTICE_STORAGE_TABLES.map(getTableName)).toEqual([
      ...EXPECTED_TABLE_NAMES,
    ]);
  });

  test("uses the existing dedicated role and enables explicit role-scoped RLS", () => {
    expect(nautiloCryptoRole.name).toBe("nautilo_crypto");
    expect(
      (nautiloCryptoRole as unknown as { _existing: boolean })._existing,
    ).toBe(true);

    for (const table of LATTICE_STORAGE_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS, config.name).toBe(true);
      expect(config.policies.length, config.name).toBeGreaterThan(0);
      for (const policy of config.policies) {
        expect(policy.to, `${config.name}.${policy.name}`).toBe(
          nautiloCryptoRole,
        );
      }
    }
  });

  test("uses only internal crypto foreign keys and no generated state", () => {
    const cryptoTableNames = new Set<string>(EXPECTED_TABLE_NAMES);
    for (const table of LATTICE_STORAGE_TABLES) {
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        expect(
          cryptoTableNames.has(
            getTableName(foreignKey.reference().foreignTable),
          ),
          `${config.name}.${foreignKey.getName()}`,
        ).toBe(true);
      }
      for (const column of config.columns) {
        const isWave7PauseDefault =
          (config.name === "crypto_domains" ||
            config.name === "namespace_crypto_heads") &&
          column.name === "writes_paused";
        // Existing retained certificates predate the explicit generation tag.
        const isHistoricalProcessorFormatDefault =
          config.name === "processor_crypto_signer_authorizations"
          && column.name === "format_version";
        if (isHistoricalProcessorFormatDefault) expect(column.default).toBe(1);
        expect(
          column.hasDefault && !isWave7PauseDefault && !isHistoricalProcessorFormatDefault,
          `${config.name}.${column.name}`,
        ).toBe(false);
        const isWave10LifecycleTimestamp =
          config.name === "background_crypto_authorization_requests"
          || config.name === "processor_crypto_signer_authorizations";
        if (!isWave10LifecycleTimestamp) {
          expect(column.name, config.name).not.toMatch(
            /created_at|updated_at/,
          );
        }
      }
    }
  });

  test("persists exact indexed metadata needed for durable validation", () => {
    const columnsByTable = Object.fromEntries(
      LATTICE_STORAGE_TABLES.map((table) => {
        const config = getTableConfig(table);
        return [
          config.name,
          config.columns.map((column) => column.name),
        ];
      }),
    );

    expect(columnsByTable["crypto_domain_provider_heads"]).toContain(
      "roster_bytes",
    );
    expect(columnsByTable["crypto_objects"]).toContain("payload_hash");
    expect(columnsByTable["object_crypto_access_manifests"]).toEqual([
      "object_id",
      "access_revision",
      "manifest_hash",
      "previous_manifest_hash",
      "payload_hash",
      "manifest_bytes",
    ]);
    expect(columnsByTable["human_crypto_recovery_archives"]).toContain(
      "archive_hash",
    );
    expect(columnsByTable["agent_crypto_runtime_signers"]).toEqual([
      "agent_id",
      "runtime_generation",
      "authorization_revision",
      "transition_kind",
      "operation_id",
      "signer_key_id",
      "signer_public_key",
      "publication_bytes",
    ]);
  });

  test("freezes storage bounds independently of crypto package imports", () => {
    expect(CRYPTO_STORAGE_BYTE_LIMITS).toEqual({
      id: 128,
      roster: 1_048_616,
      namespaceBinding: 1_048_616,
      namespaceKeyring: 262_144,
      encryptedObject: 1_048_616,
      objectAccessManifest: 1_048_616,
      objectAccessEnvelope: 1_048_576,
      agentRuntimeDomainEnvelope: 1_048_576,
      agentRuntimeSignerPublication: 1_024,
      signingPublicKey: 32,
      wrappedDekMinimum: 40,
      wrappedDekMaximum: 4_096,
      grant: 16_777_216,
      recoveryArchive: 67_108_864,
      hash: 32,
    });
    expect(CRYPTO_STORAGE_COLLECTION_LIMITS).toEqual({
      objectAccessEnvelopes: 256,
      agentRuntimeConfigObjects: 256,
      agentRuntimeDomainEnvelopes: 16_384,
      agentRuntimeChallenges: 16_384,
      maximumOrdinal: 255,
      agentGrantMaximumOrdinal: 16_383,
      maximumSafeCounter: Number.MAX_SAFE_INTEGER,
    });
  });

  test("generated migration has literal checks and reviewed manual RLS SQL", () => {
    expect(migration).not.toMatch(/\$\d+/);
    expect(
      migration.match(/ ENABLE ROW LEVEL SECURITY/g),
    ).toHaveLength(WAVE_6_TABLE_NAMES.length - 1);
    expect(
      migration.match(/ FORCE ROW LEVEL SECURITY/g),
    ).toHaveLength(WAVE_6_TABLE_NAMES.length - 1);
    expect(migration).toContain(
      "CREATE FUNCTION \"public\".\"crypto_participants_are_canonical\"",
    );
    expect(migration.indexOf("crypto_participants_are_canonical")).toBeLessThan(
      migration.indexOf('CREATE TABLE "crypto_domains"'),
    );
    expect(migration).toContain(
      "Crypto Domain identity and exact participants are immutable",
    );
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    for (const policy of migration.matchAll(/CREATE POLICY ([^;]+)/g)) {
      expect(policy[1]).toContain('TO "nautilo_crypto"');
      expect(policy[1]).not.toContain('"nautilo_agent"');
      expect(policy[1]).not.toContain("TO PUBLIC");
    }
  });

  test("declares composite uniqueness before self-referential foreign keys", () => {
    for (const constraint of [
      "uq_namespace_crypto_bindings_hash",
      "uq_namespace_crypto_bindings_head",
      "uq_object_crypto_access_manifests_hash",
      "uq_object_crypto_access_manifests_head",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}" UNIQUE`);
      expect(migration).not.toContain(`CREATE UNIQUE INDEX "${constraint}"`);
    }
    expect(
      migration.indexOf('CONSTRAINT "uq_namespace_crypto_bindings_hash" UNIQUE'),
    ).toBeLessThan(
      migration.indexOf(
        'ADD CONSTRAINT "namespace_crypto_bindings_previous_fk"',
      ),
    );
    expect(
      migration.indexOf(
        'CONSTRAINT "uq_object_crypto_access_manifests_hash" UNIQUE',
      ),
    ).toBeLessThan(
      migration.indexOf(
        'ADD CONSTRAINT "object_crypto_access_manifests_previous_fk"',
      ),
    );
  });

  test("migration privileges preserve immutable history", () => {
    const appendOnlyGrant = migration.match(
      /GRANT SELECT, INSERT ON TABLE([\s\S]*?)TO "nautilo_crypto"/,
    )?.[1];
    expect(appendOnlyGrant).toContain('"namespace_crypto_bindings"');
    expect(appendOnlyGrant).toContain('"crypto_objects"');
    expect(appendOnlyGrant).toContain(
      '"object_crypto_access_manifests"',
    );
    expect(appendOnlyGrant).toContain(
      '"object_crypto_namespace_envelopes"',
    );
    expect(appendOnlyGrant).not.toContain("UPDATE");
    expect(appendOnlyGrant).not.toContain("DELETE");

    const actualPrivileges = Object.fromEntries(
      [...migration.matchAll(
        /GRANT ([A-Z, ]+) ON TABLE([\s\S]*?)TO "nautilo_crypto";/g,
      )].flatMap((match) => {
        const privileges = match[1]!.split(", ");
        return [...match[2]!.matchAll(/"([a-z_]+)"/g)].map(
          (tableMatch) => [tableMatch[1]!, privileges] as const,
        );
      }),
    );
    const expectedPrivileges: Record<string, string[]> = {};
    for (const table of WAVE_6_TABLE_NAMES.filter(
      (name) => name !== "agent_crypto_runtime_signers",
    )) {
      const privileges = CRYPTO_STORAGE_TABLE_PRIVILEGES[table];
      expectedPrivileges[table] = Array.from(privileges);
    }
    expect(actualPrivileges).toEqual(expectedPrivileges);
  });
});
