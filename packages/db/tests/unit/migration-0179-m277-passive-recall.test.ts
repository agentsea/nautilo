import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0179_wild_masked_marvel";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M277 passive-recall server control migration", () => {
  test("retains the immutable default-on context-policy migration", () => {
    const entry = journal.entries.find((candidate) => candidate.idx === 179);
    expect(entry?.tag).toBe(tag);
    expect(migration).toContain(
      'ALTER TABLE "server_context_config" ADD COLUMN '
      + '"passive_recall_enabled" boolean DEFAULT true NOT NULL;',
    );
  });

  test("does not replay the already-applied reasoning-policy migration", () => {
    expect(migration).not.toContain("server_model_config");
    expect(migration).not.toContain("reasoning_policy");
    expect(migration.match(/ALTER TABLE/gu)).toHaveLength(1);
  });
});
