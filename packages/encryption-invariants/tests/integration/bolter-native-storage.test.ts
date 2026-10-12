import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BOLTER_NATIVE_STORAGE_COVERAGE, BOLTER_NATIVE_STORAGE_DECLARATIONS, BOLTER_NATIVE_STORAGE_ALARMS } from "../../baseline/reviewed-bolter-native-storage";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { inspectDeclaredSourceInventory, scanSourceAlarms } from "../../src/node/source-inventory";
import { inspectSourceAlarmReviews, CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";
import { validateCoverageEntry } from "../../src/model";
const repoRoot = resolve(import.meta.dir, "../../../..");
test("classifies sealed local recovery and exact content-free build/runtime sinks", async () => {
  expect((await inspectDeclaredSourceInventory({repoRoot, declarations:BOLTER_NATIVE_STORAGE_DECLARATIONS})).errors).toEqual([]);
  const paths = [...new Set(BOLTER_NATIVE_STORAGE_ALARMS.map(alarm => alarm.locator.split("#")[0]!))];
  const scan = await scanSourceAlarms({repoRoot, scanRoots:paths});
  expect(scan.errors).toEqual([]);
  expect(scan.alarms).toHaveLength(9);
  expect(inspectSourceAlarmReviews(scan.alarms,BOLTER_NATIVE_STORAGE_ALARMS).errors).toEqual([]);
  for (const review of BOLTER_NATIVE_STORAGE_ALARMS) expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
  for (const entry of BOLTER_NATIVE_STORAGE_COVERAGE) {
    expect(validateCoverageEntry(entry)).toEqual({ok:true});
    expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    expect(entry.classification).toBe("device_local");
  }
});
