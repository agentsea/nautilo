import { describe, expect, test } from "bun:test";

import {
  REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-09-05-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

describe("reviewed main 2026-09-05 encryption inventory", () => {
  test("keeps unrelated main alarms out of the M311 record", () => {
    expect(REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS).toHaveLength(6);
    expect(REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS.filter((review) =>
      review.closure === "declaration"
    )).toHaveLength(5);
    expect(REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS.filter((review) =>
      review.closure === "reviewed_exclusion"
    )).toHaveLength(1);

    for (const review of REVIEWED_MAIN_2026_09_05_SOURCE_ALARMS) {
      expect(review.reason.length).toBeGreaterThan(120);
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
  });
});
