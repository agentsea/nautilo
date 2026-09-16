import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(import.meta.dir, "../../src/migrations/0191_salty_azazel.sql"),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("M288 generated parent-conflict repair migration", () => {
  test("admits the closed parent_conflict work reason", () => {
    expect(migration).toContain("'parent_conflict'");
    expect(migration).toContain("WHEN 'parent_conflict' THEN 4");
    expect(migration).toContain(
      "Reflection semantic work reason cannot weaken within a generation",
    );
  });

  test("changes no durable shape and precedes the completion constraint", () => {
    expect(migration).not.toMatch(/CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN/u);
    const migrationIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0191_salty_azazel",
    );
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 192,
      tag: "0192_silly_rumiko_fujikawa",
    });
  });
});
