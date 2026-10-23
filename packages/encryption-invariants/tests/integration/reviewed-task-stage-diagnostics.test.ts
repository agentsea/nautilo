import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS } from
  "../../baseline/reviewed-task-foundation-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS, inspectSourceAlarmReviews } from
  "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");
const sourcePath = "packages/server/src/routes/protected-task-native-fixed-memory-segment.ts";
const locators = [1, 2].map(occurrence =>
  `${sourcePath}#log_emitter:7ef703451e44cded:${occurrence}`);

describe("protected Task stage diagnostics", () => {
  test("closes only the two exact content-free stage emitters", async () => {
    const scan = await scanSourceAlarms({ repoRoot });
    expect(scan.errors).toEqual([]);
    const alarms = scan.alarms.filter(alarm => alarm.path === sourcePath);
    expect(alarms.map(alarm => alarm.locator).sort()).toEqual(locators);
    const reviews = REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS.filter(review =>
      locators.includes(review.locator));
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review.closure).toBe("reviewed_exclusion");
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    expect(inspectSourceAlarmReviews(alarms, reviews).errors).toEqual([]);

    const source = await Bun.file(resolve(repoRoot, sourcePath)).text();
    const calls = source.match(/\blog\(`[^`]*`\);/gu) ?? [];
    expect(calls).toEqual([
      "log(`[task-observer] protected fixed Memory segment rejected code=${failurePhase}`);",
      "log(`[task-observer] protected fixed Memory failure publication rejected code=PTFMS008 source=${failurePhase}`);",
    ]);
    const assignments = [...source.matchAll(/failurePhase(?:\s*:\s*ProtectedTaskFixedMemoryFailurePhase)?\s*=\s*"([^"]+)"/gu)];
    expect(assignments.map(match => match[1]).sort()).toEqual([
      "PTFMS001", "PTFMS002", "PTFMS003", "PTFMS004", "PTFMS005", "PTFMS006", "PTFMS007",
    ]);
  }, 120_000);
});
