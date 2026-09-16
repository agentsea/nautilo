import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const migration = readFileSync(
  resolve(import.meta.dir, "../../src/migrations/0188_common_kronos.sql"),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("M287 generated Record dependency repair migration", () => {
  test("adds one bounded content-free direct-parent repair cursor", () => {
    expect(migration).toContain(
      'CREATE TABLE "reflection_record_dependency_change_repairs"',
    );
    expect(migration).toContain('"change_commitment" "bytea" PRIMARY KEY');
    expect(migration).toContain('"changed_record_id" text NOT NULL');
    expect(migration).toContain('"continuation" text');
    expect(migration).toContain(
      "reflection_record_dependency_change_repairs_update_guard",
    );
    expect(migration).not.toMatch(
      /"(?:statement|message_body|memory_body|source_ref|embedding|prompt|model_output|key_bytes|audience_list)"/u,
    );
  });

  test("is product-only, FORCE-RLS, retained, and precedes parent-conflict repair", () => {
    expect(migration).toContain(
      'ALTER TABLE "reflection_record_dependency_change_repairs" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "reflection_record_dependency_change_repairs" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "reflection_record_dependency_change_repairs" TO "nautilo"',
    );
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m271-reflection-semantic-work.ts",
    );
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0188_common_kronos",
    );
    expect(journal.entries.find(({ idx }) => idx === 188)).toMatchObject({
      idx: 188,
      tag: "0188_common_kronos",
    });
    expect(journal.entries[migrationIndex + 3]).toMatchObject({
      idx: 191,
      tag: "0191_salty_azazel",
    });
  });
});
