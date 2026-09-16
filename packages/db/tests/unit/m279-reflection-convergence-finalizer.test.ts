import { describe, expect, test } from "bun:test";

import {
  M279_REFLECTION_CONVERGENCE_MARKER,
  finalizeM279ReflectionConvergenceMigration,
} from "../../scripts/finalize-m279-reflection-convergence";

describe("M279 generated Reflection convergence finalizer", () => {
  const generated = [
    'ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_reason_closed";',
    'ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_reason_closed" CHECK ("change_reason" in (\'scheduled_review\', \'created\', \'revised\', \'dependency_lost\'));',
    "",
  ].join("\n");

  test("extends the monotonic reason guard exactly once", () => {
    const once = finalizeM279ReflectionConvergenceMigration(generated);
    expect(finalizeM279ReflectionConvergenceMigration(once)).toBe(once);
    expect(once.match(new RegExp(M279_REFLECTION_CONVERGENCE_MARKER, "g")))
      .toHaveLength(1);
    expect(once).toContain("CREATE OR REPLACE FUNCTION");
    expect(once).toContain("WHEN 'scheduled_review' THEN 0");
    expect(once).toContain("WHEN 'dependency_lost' THEN 3");
    expect(once).toContain("WHEN 'parent_conflict' THEN 4");
    expect(once).toContain(
      "Reflection semantic work reason cannot weaken within a generation",
    );
    expect(once).toContain("Quarantined Reflection semantic work recovery");
  });

  test("refreshes an existing finalizer body without duplicating it", () => {
    const stale = `${generated}--> statement-breakpoint
${M279_REFLECTION_CONVERGENCE_MARKER}
obsolete body`;

    const refreshed = finalizeM279ReflectionConvergenceMigration(stale);

    expect(refreshed).not.toContain("obsolete body");
    expect(refreshed).toContain("WHEN 'parent_conflict' THEN 4");
    expect(refreshed.match(new RegExp(M279_REFLECTION_CONVERGENCE_MARKER, "g")))
      .toHaveLength(1);
    expect(finalizeM279ReflectionConvergenceMigration(refreshed)).toBe(refreshed);
  });

  test("ignores unrelated migrations", () => {
    const unrelated = 'ALTER TABLE "other" ADD COLUMN "scheduled_review" text;\n';
    expect(finalizeM279ReflectionConvergenceMigration(unrelated)).toBe(unrelated);
  });
});
