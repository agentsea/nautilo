import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0174_typical_mongoose";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M271 generated quarantine recovery migration", () => {
  test("makes legacy quarantine immediately recoverable before adding invariants", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)).toMatchObject({ idx: 174, tag });
    const migrationIndex = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[migrationIndex + 1]).toMatchObject({
      idx: 175,
      tag: "0175_d525_media_completion_wakes",
    });
    expect(migration).toContain('ADD COLUMN "quarantine_round" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain('ADD COLUMN "recover_after" timestamp with time zone');
    const repair = migration.indexOf('UPDATE "reflection_record_semantic_work"');
    const constraint = migration.indexOf(
      'ADD CONSTRAINT "reflection_record_semantic_work_recovery_coherent"',
    );
    expect(repair).toBeGreaterThan(0);
    expect(constraint).toBeGreaterThan(repair);
    expect(migration).toContain('WHERE "state" = \'quarantined\'');
  });

  test("replaces the obsolete terminal-quarantine trigger with one bounded recovery edge", () => {
    const drop = migration.indexOf(
      'DROP TRIGGER "reflection_record_semantic_work_update_guard"',
    );
    const repair = migration.indexOf('UPDATE "reflection_record_semantic_work"');
    const replace = migration.indexOf(
      'CREATE OR REPLACE FUNCTION "public"."reflection_semantic_work_guard_update"',
    );
    const recreate = migration.indexOf(
      'CREATE TRIGGER "reflection_record_semantic_work_update_guard"',
    );
    expect(drop).toBeGreaterThan(0);
    expect(repair).toBeGreaterThan(drop);
    expect(replace).toBeGreaterThan(repair);
    expect(recreate).toBeGreaterThan(replace);
    expect(migration).toContain("OLD.state = 'complete'");
    expect(migration).toContain(
      "OLD.state = 'quarantined' AND NEW.state = 'claimed'",
    );
    expect(migration).toContain("NEW.quarantine_round <> OLD.quarantine_round + 1");
    expect(migration).not.toContain(
      "OLD.state IN ('complete', 'quarantined') AND NEW IS DISTINCT FROM OLD",
    );
  });
});
