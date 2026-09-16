import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0169_m267_record_lifecycle_generation_guard";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0169_snapshot.json"), "utf8"),
) as { prevId: string; id: string };

describe("M267 generated Record lifecycle-generation guard correction", () => {
  test("remains chained after the applied cutover and before later additive work", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 169, tag });
    expect(journal.entries[index + 1]).toMatchObject({ idx: 170, tag: "0170_chunky_wong" });
    expect(snapshot.prevId).not.toBe(snapshot.id);
  });

  test("keeps semantic identity immutable while fencing lifecycle changes", () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "public"."reflection_record_guard_record_mutation"()',
    );
    expect(migration).toContain(
      "NEW.processing_generation IS DISTINCT FROM OLD.processing_generation + 1",
    );
    expect(migration).toContain(
      "Reflection Record lifecycle generation must advance exactly once",
    );
    expect(migration).toContain(
      "ELSIF OLD.processing_generation IS DISTINCT FROM NEW.processing_generation",
    );
    expect(migration).toContain(
      "Reflection Record semantic identity is immutable",
    );
  });
});
