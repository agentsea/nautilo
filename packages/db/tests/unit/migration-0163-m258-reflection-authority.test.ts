import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const migrationsDirectory = resolve(import.meta.dir, "../../src/migrations");
const migrationName = readdirSync(migrationsDirectory)
  .filter((name) => /^0163_.+\.sql$/u.test(name))
  .find((name) =>
    readFileSync(resolve(migrationsDirectory, name), "utf8").includes(
      'CREATE TABLE "reflection_record_authority_projections"',
    )
  );
if (migrationName === undefined) throw new Error("M258 authority migration is missing");
const migration = readFileSync(resolve(migrationsDirectory, migrationName), "utf8");

const TABLES = [
  "reflection_record_authority_closure",
  "reflection_record_authority_projections",
  "reflection_record_authority_alternatives",
  "reflection_record_authority_changes",
  "reflection_record_authority_reconciliations",
  "reflection_record_authority_blocks",
] as const;

describe("M258 generated Reflection authority migration", () => {
  test("keeps its security finalizer in the canonical generate-only command", () => {
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m258-reflection-authority.ts",
    );
  });

  test("is additive and creates the exact dormant authority table family", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migration).not.toMatch(/ALTER TABLE "(memories|room_events|session_messages|artifacts|tasks|namespaces)"/u);
    expect(migration).not.toMatch(/INSERT INTO "?(memories|room_events|session_messages|artifacts|tasks|namespaces)/u);
  });

  test("forces product-only RLS and permanently denies Agent, crypto, and PUBLIC", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(
        `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`,
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo"`,
      );
    }
  });

  test("pins immutable facts and monotonic operational transitions", () => {
    expect(migration).toContain("reflection_record_authority_closure_immutable");
    expect(migration).toContain("reflection_record_authority_alternatives_immutable");
    expect(migration).toContain("reflection_record_authority_changes_immutable");
    expect(migration).toContain("reflection_record_authority_blocks_mutation_guard");
    expect(migration).toContain("reflection_record_authority_projections_mutation_guard");
    expect(migration).toContain("reflection_record_authority_reconciliations_mutation_guard");
    expect(migration).toContain("Retired Reflection authority projection cannot become current");
    expect(migration).toContain("Invalid Reflection authority reconciliation attempt transition");
  });

  test("stores only opaque commitments, handles, and sealed checkpoints", () => {
    expect(migration).toContain("audience_set_commitment");
    expect(migration).toContain("alternative_commitment");
    expect(migration).toContain("sealed_checkpoint");
    expect(migration).not.toMatch(/"(human_id|human_actor_id|source_id|source_ref|statement|anchor_ref|payload_bytes|content_hash)"/u);
    expect(migration).toContain("alternative_ordinal\" between 0 and 255");
  });
});
