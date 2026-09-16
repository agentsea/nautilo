import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0185_brave_sumo";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0185_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    checkConstraints?: Record<string, { value: string }>;
  }>;
};

describe("M279 populated-clone convergence migration repair", () => {
  test("reapplies the reason constraint under a new immutable name", () => {
    expect(journal.entries.find((entry) => entry.idx === 185)).toMatchObject({
      idx: 185,
      tag,
    });
    expect(migration).toContain(
      'DROP CONSTRAINT "reflection_record_semantic_work_reason_closed"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "reflection_record_semantic_work_reason_closed_v2"',
    );
    expect(migration).toContain(
      "'scheduled_review', 'created', 'revised', 'dependency_lost'",
    );
    const work = snapshot.tables["public.reflection_record_semantic_work"];
    expect(work?.checkConstraints?.[
      "reflection_record_semantic_work_reason_closed_v2"
    ]?.value).toContain("scheduled_review");
  });

  test("reinstalls the finalized monotonic guard for populated clones", () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "public"."reflection_semantic_work_guard_update"()',
    );
    expect(migration).toContain("WHEN 'scheduled_review' THEN 0");
    expect(migration).toContain("Quarantined Reflection semantic work recovery");
  });
});
