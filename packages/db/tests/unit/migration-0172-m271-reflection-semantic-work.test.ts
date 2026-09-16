import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const tag = "0172_wandering_baron_zemo";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0174_snapshot.json"), "utf8"),
) as { tables: Record<string, unknown>; prevId: string; id: string };

describe("M271 generated Reflection semantic-work migration", () => {
  test("is additive, chained, and retains the finalizer", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)).toMatchObject({ idx: 172, tag });
    const migrationIndex = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 173,
      tag: "0173_volatile_nick_fury",
    });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m271-reflection-semantic-work.ts",
    );
    expect(migration).not.toMatch(/DROP TABLE|DELETE FROM/u);
  });

  test("creates one coalesced work row per native Record", () => {
    expect(migration).toContain(
      'CREATE TABLE "reflection_record_semantic_work"',
    );
    expect(migration).toContain('"record_id" text PRIMARY KEY NOT NULL');
    for (const column of [
      "generation",
      "completed_generation",
      "change_reason",
      "stage",
      "state",
      "claim_generation",
      "attempt_count",
      "lease_token",
      "lease_expires_at",
      "next_attempt_at",
      "failure_code",
      "due_since",
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).toContain(
      "reflection_record_semantic_work_generations_coherent",
    );
    expect(migration).toContain(
      "reflection_record_semantic_work_claim_coherent",
    );
    expect(migration).toContain(
      "reflection_record_semantic_work_completion_coherent",
    );
    expect(migration).toContain(
      "reflection_record_semantic_work_update_guard",
    );
    expect(migration).toContain("IF (CASE NEW.change_reason");
    expect(migration).toContain("END) < (CASE OLD.change_reason");
  });

  test("suppresses replay with content-free immutable admission receipts", () => {
    expect(migration).toContain(
      'CREATE TABLE "reflection_record_semantic_work_admissions"',
    );
    expect(migration).toContain('"admission_commitment" "bytea"');
    expect(migration).toContain('"assigned_generation" integer NOT NULL');
    expect(migration).toContain(
      "uq_reflection_semantic_work_admission_generation",
    );
    expect(migration).toContain(
      "reflection_record_semantic_work_admissions_immutable",
    );
  });

  test("adds only a server-keyed content-free source reverse index", () => {
    expect(migration).toContain(
      'CREATE TABLE "reflection_record_source_dependency_index"',
    );
    expect(migration).toContain('"source_dependency_commitment" "bytea"');
    expect(migration).toContain(
      "reflection_record_source_dependency_commitment_size",
    );
    expect(migration).toContain(
      "reflection_record_source_dependency_index_immutable",
    );
    expect(migration).not.toMatch(
      /"(?:statement|message_body|memory_body|source_id|source_ref|embedding|prompt|model_output|key_bytes|audience_list)"/u,
    );
  });

  test("persists one bounded HMAC-only source-change repair cursor", () => {
    expect(migration).toContain(
      'CREATE TABLE "reflection_record_source_change_repairs"',
    );
    expect(migration).toContain('"source_change_commitment" "bytea" PRIMARY KEY');
    expect(migration).toContain('"source_dependency_commitment" "bytea"');
    expect(migration).toContain('"continuation" text');
    expect(migration).toContain(
      "reflection_record_source_change_repairs_update_guard",
    );
  });

  test("forces product-only RLS and denies Agent, crypto, and PUBLIC", () => {
    for (const table of [
      "reflection_record_source_dependency_index",
      "reflection_record_semantic_work_admissions",
      "reflection_record_semantic_work",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`,
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO "nautilo"`,
      );
    }
    const repair = "reflection_record_source_change_repairs";
    expect(migration).toContain(
      `ALTER TABLE "${repair}" FORCE ROW LEVEL SECURITY`,
    );
    expect(migration).toContain(
      `REVOKE ALL ON TABLE "${repair}" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"`,
    );
    expect(migration).toContain(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "${repair}" TO "nautilo"`,
    );
    expect(migration).not.toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${repair}" TO "nautilo"`,
    );
    expect(migration).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
  });
});
