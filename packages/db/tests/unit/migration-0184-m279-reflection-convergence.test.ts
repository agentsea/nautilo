import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import packageJson from "../../package.json";

const tag = "0184_goofy_logan";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0184_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    checkConstraints?: Record<string, { value: string }>;
  }>;
  prevId: string;
  id: string;
};

describe("M279 generated Reflection convergence migration", () => {
  test("is additive and reproducibly finalized", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)).toMatchObject({ idx: 184, tag });
    expect(snapshot.prevId).not.toBe(snapshot.id);
    expect(migration).not.toMatch(/DROP TABLE|DELETE FROM/u);
    expect(packageJson.scripts["db:generate"]?.split(" && ")).toContain(
      "bun scripts/finalize-m279-reflection-convergence.ts",
    );
  });

  test("adds delayed review to the closed reason set", () => {
    expect(migration).toContain(
      'DROP CONSTRAINT "reflection_record_semantic_work_reason_closed"',
    );
    expect(migration).toContain(
      "'scheduled_review', 'created', 'revised', 'dependency_lost'",
    );
    const work = snapshot.tables["public.reflection_record_semantic_work"];
    expect(work?.checkConstraints?.[
      "reflection_record_semantic_work_reason_closed"
    ]?.value).toContain("scheduled_review");
  });

  test("preserves the monotonic work guard with derived priority", () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "public"."reflection_semantic_work_guard_update"()',
    );
    expect(migration).toContain("WHEN 'scheduled_review' THEN 0");
    expect(migration).toContain("WHEN 'dependency_lost' THEN 3");
    expect(migration).toContain("Quarantined Reflection semantic work recovery");
  });
});
