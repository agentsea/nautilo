import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0173_volatile_nick_fury";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M271 generated Reflection model selection migration", () => {
  test("is additive and remains immutably chained", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)).toMatchObject({ idx: 173, tag });
    const migrationIndex = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 174,
      tag: "0174_typical_mongoose",
    });
    expect(migration.trim()).toBe(
      'ALTER TABLE "server_model_config" ADD COLUMN "reflection_model" text;',
    );
  });
});
