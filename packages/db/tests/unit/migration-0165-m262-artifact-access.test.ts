import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0165_groovy_red_wolf";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(readFileSync(
  resolve(migrations, "meta/_journal.json"), "utf8",
)) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(readFileSync(
  resolve(migrations, "meta/0165_snapshot.json"), "utf8",
)) as { tables: Record<string, unknown>; prevId: string; id: string };

describe("M262 generated Artifact access receipt migration", () => {
  test("changes only the existing content-free operation shape", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 165, tag });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 166,
      tag: "0166_abandoned_sunset_bain",
    });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(sql).toContain(
      'ALTER TABLE "artifact_crypto_operations" DROP CONSTRAINT "artifact_crypto_operations_shape"',
    );
    expect(sql).toContain(
      'ALTER TABLE "artifact_crypto_operations" ADD CONSTRAINT "artifact_crypto_operations_shape"',
    );
    expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN/u);
  });

  test("binds no-copy access N to N+1 without changing Artifact or blob revision", () => {
    expect(sql).toMatch(/operation_type" = 'access'/u);
    expect(sql).toMatch(
      /result_artifact_revision" = "artifact_crypto_operations"\."expected_artifact_revision"/u,
    );
    expect(sql).toMatch(
      /result_access_revision" = "artifact_crypto_operations"\."expected_access_revision" \+ 1/u,
    );
    expect(sql).toMatch(
      /result_blob_generation" = "artifact_crypto_operations"\."expected_blob_generation"/u,
    );
    expect(sql).toMatch(
      /result_blob_id" = "artifact_crypto_operations"\."expected_blob_id"/u,
    );
    expect(sql).not.toMatch(/plaintext|logical_path|mime_type|signed_bytes|envelope/u);
  });
});
