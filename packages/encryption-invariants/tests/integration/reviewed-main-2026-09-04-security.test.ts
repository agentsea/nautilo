import { describe, expect, test } from "bun:test";

import {
  REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS,
} from "../../baseline/reviewed-main-2026-09-04-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

describe("reviewed main 2026-09-04 encryption inventory", () => {
  test("closes only the three reviewed local OpenConnector diagnostics", () => {
    expect(REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS).toHaveLength(3);
    expect(REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS.map((review) =>
      review.locator
    )).toEqual([
      "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:468c68ed4723a1f2:16",
      "bin/nautilo-dev/src/commands/infra-start.ts#log_emitter:c6d53eb0eb42455b:11",
      "bin/nautilo-dev/src/commands/infra-status.ts#log_emitter:6eab313eca52a747:3",
    ]);

    for (const review of REVIEWED_MAIN_2026_09_04_SOURCE_ALARMS) {
      expect(review.owner).toBe("bin/nautilo-dev");
      expect(review.closure).toBe("reviewed_exclusion");
      expect(review.reason).toContain("excludes Human content");
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
  });
});
