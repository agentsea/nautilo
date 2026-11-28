import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { REVIEWED_MEMORY_RECOVERY_SOURCE_ALARMS } from "../../baseline/reviewed-memory-recovery-source-alarms";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");
const locators = REVIEWED_MEMORY_RECOVERY_SOURCE_ALARMS.map(
  (review) => review.locator,
);

describe("reviewed Memory recovery source alarms", () => {
  test("closes only the four bounded recovery warnings", async () => {
    expect(locators).toEqual([
      "packages/server/src/app.ts#log_emitter:4653f2598ab1da64:1",
      "packages/server/src/app.ts#log_emitter:4653f2598ab1da64:2",
      "packages/server/src/app.ts#log_emitter:52fc75dba775a07f:1",
      "packages/server/src/routes/reflection-status.ts#log_emitter:a90c23f4818770fe:3",
    ]);
    expect(new Set(locators).size).toBe(4);

    const scan = await scanSourceAlarms({
      repoRoot,
      scanRoots: ["packages/server/src"],
    });
    expect(scan.errors).toEqual([]);
    const owned = scan.alarms.filter((alarm) => locators.includes(alarm.locator));
    expect(owned.map((alarm) => alarm.locator)).toEqual(locators);
    expect(owned.map((alarm) => alarm.evidence)).toEqual([
      "log.warn(",
      "log.warn(",
      "log.warn(",
      "logError(",
    ]);
    expect(inspectSourceAlarmReviews(
      owned,
      REVIEWED_MEMORY_RECOVERY_SOURCE_ALARMS,
    )).toMatchObject({
      errors: [],
      counts: { declaration: 0, baselineDebt: 0, reviewedExclusion: 4, unmapped: 0 },
    });

    for (const review of REVIEWED_MEMORY_RECOVERY_SOURCE_ALARMS) {
      expect(review.closure).toBe("reviewed_exclusion");
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
      expect(review.reason).toContain("no ");
    }
  });

  test("anchors the complete emitted shapes without caught errors", async () => {
    const reflectionStatus = await Bun.file(resolve(repoRoot, "packages/server/src/routes/reflection-status.ts")).text();
    expect(reflectionStatus).toMatch(/logError\("\[reflection-status\] supplemental recovery details unavailable", \{\s*failureCode: "reflection_recovery_diagnostics_unavailable",\s*\}\);/);
    const app = await Bun.file(resolve(repoRoot, "packages/server/src/app.ts")).text();
    expect(app).toContain(
      'app.log.warn("[stenographer] automatic provider recovery scan failed")',
    );
    expect(app).toContain(
      'app.log.warn("[reflection] automatic provider recovery scan failed")',
    );
    expect(app).toContain(
      'app.log.warn({ processor }, "Memory recovery could not assess processor")',
    );
    expect(app).not.toContain(
      'app.log.warn({ processor, error }, "Memory recovery could not assess processor")',
    );
  });
});
