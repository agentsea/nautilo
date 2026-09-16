import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(import.meta.dir, "../../src/migrations/0187_sleepy_nebula.sql"),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("M287 generated Reflection latency migration", () => {
  test("adds only one nullable content-free first-claim coordinate", () => {
    expect(migration).toContain(
      'ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "started_at" timestamp with time zone',
    );
    expect(migration).toContain(
      '"started_at" is null or "reflection_record_semantic_work"."started_at" >= "reflection_record_semantic_work"."due_since"',
    );
    expect(migration).not.toMatch(/CREATE TABLE|DROP TABLE|UPDATE |DELETE FROM/u);
  });

  test("precedes the generated dependency-repair migration", () => {
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0187_sleepy_nebula",
    );
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 188,
      tag: "0188_common_kronos",
    });
  });
});
