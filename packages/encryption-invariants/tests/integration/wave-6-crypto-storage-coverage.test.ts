import { describe, expect, test } from "bun:test";
import {
  LATTICE_STORAGE_TABLE_NAMES,
} from "@nautilo/db/schema";
import * as nautiloSchema from "@nautilo/db/schema";

import {
  REVIEWED_WAVE_6_COVERAGE_ENTRIES,
  REVIEWED_WAVE_6_DATABASE_WRITER_ENTRIES,
} from "../../baseline/reviewed-wave-6";
import {
  inventoryDrizzleSchema,
} from "../../src/node/schema-inventory";

const PROTECTED_COLUMNS = new Set([
  "public.agent_crypto_runtime_config_objects.wrapped_dek_bytes",
  "public.agent_crypto_runtime_domain_envelopes.envelope_bytes",
  "public.crypto_grants.grant_bytes",
  "public.crypto_objects.payload_bytes",
  "public.human_crypto_recovery_archives.archive_bytes",
  "public.namespace_crypto_bindings.ai_keyring_envelope_bytes",
  "public.namespace_crypto_bindings.human_keyring_envelope_bytes",
  "public.object_crypto_namespace_envelopes.envelope_bytes",
]);

const WAVE_7_ADDITIVE_COLUMNS = new Set([
  "public.crypto_domains.pause_operation_id",
  "public.crypto_domains.writes_paused",
  "public.namespace_crypto_heads.pause_operation_id",
  "public.namespace_crypto_heads.writes_paused",
]);

const WAVE_9_ADDITIVE_TABLES = new Set([
  "agent_crypto_runtime_signers",
]);

const WAVE_10_ADDITIVE_TABLES = new Set([
  "background_crypto_authorization_requests",
  "processor_crypto_signer_authorizations",
]);

const WAVE_11_ADDITIVE_TABLES = new Set([
  "background_crypto_authorization_domain_requirements",
  "background_crypto_authorization_namespace_requirements",
]);

describe("Wave 6 crypto-storage coverage declarations", () => {
  test("classifies every exact table and column observed from Drizzle", () => {
    const tableNames = new Set<string>(LATTICE_STORAGE_TABLE_NAMES);
    const inventory = inventoryDrizzleSchema(nautiloSchema);
    const observed = [
      ...inventory.objects
        .filter((item) =>
          item.kind === "table"
          && tableNames.has(item.name)
          && !WAVE_9_ADDITIVE_TABLES.has(item.name)
          && !WAVE_10_ADDITIVE_TABLES.has(item.name)
          && !WAVE_11_ADDITIVE_TABLES.has(item.name)
        )
        .map((item) => item.locator),
      ...inventory.columns
        .filter((item) =>
          item.kind === "table"
          && tableNames.has(item.objectName)
          && !WAVE_9_ADDITIVE_TABLES.has(item.objectName)
          && !WAVE_10_ADDITIVE_TABLES.has(item.objectName)
          && !WAVE_11_ADDITIVE_TABLES.has(item.objectName)
          && !WAVE_7_ADDITIVE_COLUMNS.has(item.locator)
        )
        .map((item) => item.locator),
    ].sort();
    const declared = REVIEWED_WAVE_6_COVERAGE_ENTRIES
      .map((entry) => entry.locator)
      .sort();

    expect(declared).toEqual(observed);
    expect(new Set(declared).size).toBe(declared.length);
  });

  test("marks opaque bytes and every containing table as protected", () => {
    const expectedProtected = new Set([
      ...PROTECTED_COLUMNS,
      ...[...PROTECTED_COLUMNS].map((locator) =>
        locator.split(".").slice(0, 2).join(".")
      ),
    ]);
    const protectedEntries = REVIEWED_WAVE_6_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    );

    expect(
      new Set(protectedEntries.map((entry) => entry.locator)),
    ).toEqual(expectedProtected);
    for (const entry of protectedEntries) {
      expect(entry.migrationState).toBe("ciphertext_only");
      expect(entry.bridgeRepository).toBe(
        "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts",
      );
    }
  });

  test("keeps every remaining field on an exact bounded metadata allowlist", () => {
    for (const entry of REVIEWED_WAVE_6_COVERAGE_ENTRIES) {
      if (entry.classification !== "bounded_metadata") continue;
      const column = entry.locator.split(".").at(-1)!;
      if (LATTICE_STORAGE_TABLE_NAMES.includes(
        column as (typeof LATTICE_STORAGE_TABLE_NAMES)[number],
      )) {
        expect(entry.metadataAllowlist.length).toBeGreaterThan(0);
      } else {
        expect(entry.metadataAllowlist).toEqual([column]);
      }
    }
  });

  test("classifies every adapter raw writer as protected implementation", () => {
    expect(REVIEWED_WAVE_6_DATABASE_WRITER_ENTRIES).toHaveLength(26);
    for (const entry of REVIEWED_WAVE_6_DATABASE_WRITER_ENTRIES) {
      expect(entry.locator).toStartWith(
        "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#",
      );
      expect(entry.classification).toBe("protected");
      expect(entry.migrationState).toBe("ciphertext_only");
      expect(entry.testEvidence).toContain(
        "packages/lattice-bridge/tests/integration/postgres-lattice-storage.integration.test.ts",
      );
    }
  });
});
