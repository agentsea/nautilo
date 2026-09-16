import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const tag = "0166_abandoned_sunset_bain";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0166_snapshot.json"), "utf8"),
) as { tables: Record<string, unknown>; prevId: string; id: string };

describe("M264 generated Reflection search migration", () => {
  test("keeps its immutable generated position before M260", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 166, tag });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 167,
      tag: "0167_jazzy_jocasta",
    });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m264-reflection-search.ts",
    );
    expect(migration).not.toMatch(/^(?:DROP TABLE|ALTER TABLE .+ DROP COLUMN|UPDATE |DELETE FROM)/mu);
  });

  test("creates exactly one projection table with the locked field inventory", () => {
    expect(Reflect.has(
      snapshot.tables,
      "public.reflection_record_search_projections",
    )).toBeTrue();
    expect(migration.match(/CREATE TABLE "reflection_record_search_projections"/gu))
      .toHaveLength(1);
    for (const column of [
      "record_id",
      "record_processing_generation",
      "projection_version",
      "projection_generation",
      "embedding_provider",
      "embedding_canonical_model",
      "embedding_dimensions",
      "embedding_contract_version",
      "embedding",
      "created_at",
      "updated_at",
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).not.toMatch(
      /"(statement|source_ref|source_revision|anchor_ref|query_text|payload_bytes|receipt|queue|head)"/u,
    );
  });

  test("pins exact vector storage, versions, bounds, and non-zero norm", () => {
    expect(migration).toContain('"embedding" vector(1536) NOT NULL');
    expect(migration).toContain('"projection_version" = 1');
    expect(migration).toContain('"embedding_contract_version" = 1');
    expect(migration).toContain('"embedding_dimensions" = 1536');
    expect(migration).toContain('vector_dims("reflection_record_search_projections"."embedding") = 1536');
    expect(migration).toContain('vector_norm("reflection_record_search_projections"."embedding") > 0');
    expect(migration).toContain('octet_length("reflection_record_search_projections"."record_id") between 1 and 128');
    expect(migration).toContain('octet_length("reflection_record_search_projections"."embedding_provider") between 1 and 256');
    expect(migration).toContain('octet_length("reflection_record_search_projections"."embedding_canonical_model") between 1 and 256');
    expect(
      migration.split("^[A-Za-z0-9][A-Za-z0-9._:@/-]*$").length - 1,
    ).toBe(3);
  });

  test("uses only B-tree provenance/Record indexes and product-role authority", () => {
    expect(migration).toContain(
      'CREATE INDEX "idx_reflection_record_search_projections_provenance" ON "reflection_record_search_projections" USING btree',
    );
    expect(migration).toContain(
      'CREATE INDEX "idx_reflection_record_search_projections_record" ON "reflection_record_search_projections" USING btree',
    );
    expect(migration).not.toMatch(/USING (hnsw|ivfflat)|vector_(?:cosine|l2|ip)_ops/iu);
    expect(migration).toContain(
      'CREATE POLICY "reflection_record_search_projections_product_all" ON "reflection_record_search_projections" AS PERMISSIVE FOR ALL TO "nautilo"',
    );
    expect(migration).toContain(
      'ALTER TABLE "reflection_record_search_projections" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "reflection_record_search_projections" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reflection_record_search_projections" TO "nautilo"',
    );
    expect(migration).toContain(
      "reflection_record_search_projections_update_guard",
    );
    expect(migration).toContain(
      "Reflection search projection generation must advance exactly once",
    );
  });

  test("documents pgvector's exact V1 storage expectation", () => {
    expect(4 * 1_536 + 8).toBe(6_152);
    expect(migration).toContain("vector(1536)");
  });
});
