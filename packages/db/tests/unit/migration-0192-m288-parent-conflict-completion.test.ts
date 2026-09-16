import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(import.meta.dir, "../../src/migrations/0192_silly_rumiko_fujikawa.sql"),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("M288 generated parent-conflict completion migration", () => {
  test("permits only parent-conflict work to complete before organization", () => {
    expect(migration).toContain(
      '"reflection_record_semantic_work"."stage" = \'organization\'',
    );
    expect(migration).toContain(
      'or "reflection_record_semantic_work"."change_reason" = \'parent_conflict\'',
    );
    expect(migration).toContain(
      '"reflection_record_semantic_work"."completed_generation" = "reflection_record_semantic_work"."generation"',
    );
  });

  test("changes no durable shape and precedes the M290 migration family", () => {
    expect(migration).not.toMatch(/CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN/u);
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0192_silly_rumiko_fujikawa",
    );
    expect(journal.entries[migrationIndex]).toMatchObject({
      idx: 192,
      tag: "0192_silly_rumiko_fujikawa",
    });
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 193,
      tag: "0193_lucky_silver_surfer",
    });
  });
});
