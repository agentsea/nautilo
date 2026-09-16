import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationsDirectory = resolve(import.meta.dir, "../../src/migrations");
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .map((name) => ({
    name,
    sql: readFileSync(resolve(migrationsDirectory, name), "utf8"),
  }));

const creationMigration = migrations.find(({ sql }) =>
  sql.includes('CREATE TABLE "reflection_records"'),
)?.sql;
const hardeningMigration = migrations.find(({ sql }) =>
  sql.includes('ADD COLUMN "crypto_retired_at"'),
)?.sql;

if (creationMigration === undefined || hardeningMigration === undefined) {
  throw new Error("M257 Reflection Record migrations are missing");
}

const completeMigration = `${creationMigration}\n${hardeningMigration}`;

const TABLES = [
  "reflection_records",
  "reflection_record_dependencies",
  "reflection_record_successors",
  "reflection_record_payload_representations",
  "reflection_record_payload_representation_heads",
  "reflection_record_publications",
] as const;

describe("M257 generated Reflection Record migration", () => {
  test("is additive and creates the exact dormant table family", () => {
    for (const table of TABLES) {
      expect(creationMigration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(completeMigration).not.toMatch(/ALTER TABLE "(memories|room_events|session_messages|artifacts|tasks|namespaces)"/u);
    expect(completeMigration).not.toMatch(/INSERT INTO "?(memories|room_events|session_messages|artifacts|tasks|namespaces)/u);
  });

  test("forces product-only RLS and denies Agent, crypto, and PUBLIC", () => {
    for (const table of TABLES) {
      expect(creationMigration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(creationMigration).toContain(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`);
      expect(creationMigration).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo"`);
    }
    for (const policy of creationMigration.matchAll(/CREATE POLICY ([^;]+)/gu)) {
      if (policy[1]?.includes("reflection_record")) {
        expect(policy[1]).toContain('TO "nautilo"');
        expect(policy[1]).not.toContain("nautilo_agent");
        expect(policy[1]).not.toContain("nautilo_crypto");
      }
    }
  });

  test("pins immutable graph/history and monotonic lifecycle constraints", () => {
    expect(creationMigration).toContain("reflection_records_mutation_guard");
    expect(creationMigration).toContain("reflection_record_dependencies_immutable");
    expect(creationMigration).toContain("reflection_record_successors_immutable");
    expect(creationMigration).toContain("reflection_record_payload_representations_mutation_guard");
    expect(creationMigration).toContain("reflection_record_payload_heads_mutation_guard");
    expect(creationMigration).toContain("reflection_record_publications_mutation_guard");
    expect(creationMigration).toContain("Invalid Reflection Record lifecycle transition");
    expect(hardeningMigration).toContain("Invalid Reflection Record publication transition");
    expect(hardeningMigration).toContain("Invalid Reflection Record publication attempt transition");
    expect(hardeningMigration).toContain("Reflection Record publication crypto identity is immutable");
    expect(hardeningMigration).toContain("Invalid Reflection Record publication timestamp transition");
  });

  test("keeps receipts content-free and representation generations exclusive", () => {
    expect(completeMigration).toContain("request_commitment");
    expect(completeMigration).not.toMatch(/"(content_hash|statement|source_ref|anchor_ref|prompt|model_output)"/u);
    expect(creationMigration).toContain("reflection_record_payload_shape");
    expect(creationMigration).toContain("plaintext_payload_bytes");
    expect(creationMigration).toContain("crypto_object_id");
    expect(creationMigration).toContain("reflection_record_payload_heads_representation_fk");
    expect(hardeningMigration).toContain('ADD COLUMN "crypto_retired_at"');
  });
});
