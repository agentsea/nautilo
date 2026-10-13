import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS } from
  "../../baseline/reviewed-paid-service-funding-source-alarms";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");
const LOCATOR =
  "packages/server/src/lib/personal-llm-attempt-owner.ts#log_emitter:dd9ce09822966263:1";
const SOURCE_PATH = "packages/server/src/lib/personal-llm-attempt-owner.ts";

describe("personal attempt owner source-alarm review", () => {
  test("closes the exact fixed content-free heartbeat warning", async () => {
    const review = REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS.find(
      (entry) => entry.locator === LOCATOR,
    );
    expect(review).toMatchObject({
      locator: LOCATOR,
      owner: "packages/server",
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.paid-service-funding.personal-attempt-owner-heartbeat-warning",
    });
    expect(review?.reason).toContain("fixed failureCode attempt_owner_heartbeat_failed");
    if (!review) throw new Error("personal attempt owner source-alarm review is missing");
    expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);

    const scan = await scanSourceAlarms({ repoRoot });
    expect(scan.errors).toEqual([]);
    const alarms = scan.alarms.filter((alarm) => alarm.locator === LOCATOR);
    expect(alarms).toHaveLength(1);
    expect(inspectSourceAlarmReviews(alarms, [review]).errors).toEqual([]);

    const source = await Bun.file(resolve(repoRoot, SOURCE_PATH)).text();
    const warning = source.match(
      /warn\(\s*"\[nautilo\/usage\] personal attempt owner heartbeat remains pending",\s*\{\s*failureCode: "attempt_owner_heartbeat_failed",\s*\}\s*\);/u,
    );
    expect(warning).toHaveLength(1);
    if (!warning) throw new Error("fixed personal attempt owner warning is missing");
    for (const forbidden of [
      "ownerToken", "attemptId", "apiKey", "credential", "request", "response",
      "error", "prompt", "content", "url",
    ]) {
      expect(warning[0]).not.toContain(forbidden);
    }
  }, 120_000);
});
