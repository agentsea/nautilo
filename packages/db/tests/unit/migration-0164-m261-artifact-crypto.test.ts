import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0164_light_korg";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0164_snapshot.json"), "utf8"),
) as { tables: Record<string, unknown>; prevId: string; id: string };

describe("M261 generated Artifact crypto migration", () => {
  test("keeps its immutable generated position before Wave 17 access", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({
      idx: 164,
      tag,
    });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 165,
      tag: "0165_groovy_red_wolf",
    });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|UPDATE "artifacts"|DELETE FROM/u);
    expect(sql).toContain('ALTER TABLE "artifacts" ALTER COLUMN "path" DROP NOT NULL');
    expect(sql).toContain('ALTER TABLE "artifacts" ADD COLUMN "crypto_object_id" text');
  });

  test("creates exactly the three Artifact-owned lifecycle tables", () => {
    for (const table of [
      "artifact_crypto_operations", "artifact_crypto_revisions",
      "artifact_crypto_blobs",
    ]) {
      expect(Reflect.has(snapshot.tables, `public.${table}`)).toBeTrue();
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).not.toContain("artifact_crypto_blob_references");
    expect(sql).not.toMatch(
      /FOREIGN KEY \("artifact_row_id"\) REFERENCES "public"\."artifacts"\("id"\)/u,
    );
  });

  test("keeps exact identity, fresh access genesis, and no-copy blob ownership", () => {
    expect(sql).toContain("artifact_crypto_revisions_exact_blob_fk");
    expect(sql).toContain('"blob_reference_state" text DEFAULT \'retained\' NOT NULL');
    expect(sql).toContain('"expected_required_namespace_fingerprint" "bytea"');
    expect(sql).toContain('"mime_class" text NOT NULL');
    expect(sql).toContain('"size_bucket" text NOT NULL');
    expect(sql).not.toMatch(/plaintext_length|chunk_count|mime_type.+artifact_crypto_revisions/u);
    expect(sql).toMatch(/operation_type" = 'content'[\s\S]+result_access_revision" = 0/u);
    expect(sql).toMatch(/operation_type" = 'control'[\s\S]+result_access_revision" = 0/u);
    expect(sql).toMatch(/operation_type" = 'create'[\s\S]+expected_required_namespace_fingerprint" is null/u);
    expect(sql).toMatch(/operation_type" = 'content'[\s\S]+expected_required_namespace_fingerprint" is not null/u);
    expect(sql).toContain("^artifact:v1:[0-9a-f]{64}$");
  });

  test("denies Agent/crypto roles and persists no sensitive control fields", () => {
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON TABLE[\s\S]+FROM PUBLIC, "nautilo_agent", "nautilo_crypto"/u);
    expect(sql).not.toMatch(/GRANT [^;]+TO "nautilo_(?:agent|crypto)"/u);
    expect(sql).not.toMatch(/plaintext|blob_dek|control_dek|logical_path|mime_type.+artifact_crypto_/u);
  });
});
