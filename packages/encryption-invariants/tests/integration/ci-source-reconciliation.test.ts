import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CI_SOURCE_ALARM_DEBT_LINEAGE,
  REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS,
  SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS,
} from "../../baseline/reviewed-ci-source-reconciliation";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");
const replacementLocators = new Set([
  "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:13",
  "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:15",
  "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:16",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:8e6cfffeb0550793:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:fdc33a22c73a3493:1",
]);

describe("current source alarm reconciliation", () => {
  test("retires exact historical locators and closes every current replacement", async () => {
    expect(SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS.size).toBe(93);
    expect(REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS).toHaveLength(51);
    const closureIds = CURRENT_SOURCE_ALARM_REVIEWS.map((review) => {
      if (review.closure === "declaration") return review.declarationId;
      if (review.closure === "reviewed_exclusion") return review.exclusionId;
      return review.debtId;
    });
    expect(new Set(closureIds).size).toBe(closureIds.length);
    expect(CI_SOURCE_ALARM_DEBT_LINEAGE.supersededLocators).toHaveLength(45);
    expect(new Set(CI_SOURCE_ALARM_DEBT_LINEAGE.supersededLocators).size).toBe(45);
    expect(CI_SOURCE_ALARM_DEBT_LINEAGE.supersededLocators.every((locator) =>
      SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS.has(locator)
    )).toBe(true);
    expect(CI_SOURCE_ALARM_DEBT_LINEAGE.currentLocators.every((locator) =>
      REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.some((review) =>
        review.locator === locator && review.closure === "baseline_debt"
      )
    )).toBe(true);
    const declarationIds = REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.filter((review) =>
      review.closure === "declaration"
    ).map((review) => review.declarationId);
    for (const declarationId of [
      "source.file.desktop-filesystem-grants",
      "source.backup.dev-snapshot",
      "source.main-2026-08-15.log.server-mdns-announcement",
      "source.main-2026-08-15.log.server-listening-origin",
      "source.backup.compose-bundle",
    ]) expect(declarationIds).toContain(declarationId);
    expect(REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.some((review) =>
      review.closure === "reviewed_exclusion"
      && review.exclusionId === "exclusion.external-room.provider-failure-category"
    )).toBe(true);
    for (const locator of [
      "packages/server/src/lib/surplus-cost-reconciliation.ts#network_processor:86dfa121e0954a46:1",
      "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:a04d34a13e441ff9:1",
    ]) {
      expect(REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.some((review) =>
        review.locator === locator && review.closure === "baseline_debt"
      )).toBe(true);
    }

    const historicalPaths = [...SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS]
      .map((locator) => locator.split("#")[0]!)
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .filter((path) => existsSync(resolve(repoRoot, path)));
    const currentPaths = REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS
      .map((review) => review.locator.split("#")[0]!)
      .filter((path, index, paths) => paths.indexOf(path) === index);
    const scan = await scanSourceAlarms({
      repoRoot,
      scanRoots: [...new Set([...historicalPaths, ...currentPaths])],
    });
    expect(scan.errors).toEqual([]);
    const observed = new Set(scan.alarms.map((alarm) => alarm.locator));

    for (const locator of SUPERSEDED_CI_SOURCE_RECONCILIATION_LOCATORS) {
      expect(observed.has(locator)).toBe(replacementLocators.has(locator));
    }
    for (const review of REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS) {
      expect(observed.has(review.locator)).toBe(true);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.filter((candidate) =>
        candidate.locator === review.locator)).toEqual([review]);
    }

    const reconciledAlarms = scan.alarms.filter((alarm) =>
      REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.some((review) =>
        review.locator === alarm.locator
      )
    );
    expect(inspectSourceAlarmReviews(
      reconciledAlarms,
      REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS,
    ).errors).toEqual([]);
  });

  test("keeps provider-controlled diagnostic data as release-blocking evidence debt", () => {
    const review = REVIEWED_CI_SOURCE_RECONCILIATION_ALARMS.find((candidate) =>
      candidate.locator === "apps/desktop/electron/bolter-bridge/connection-owner.ts#log_emitter:d9fe2303095b762b:1"
    );
    expect(review?.closure).toBe("baseline_debt");
    expect(review && "releaseImpact" in review ? review.releaseImpact : "").toBe(
      "blocks_whole_product_claim",
    );
    expect(review && "reason" in review ? review.reason : "").toContain(
      "provider-controlled event kind",
    );
    expect(review && "evidenceGap" in review ? review.evidenceGap : "").toContain(
      "closed metadata vocabulary",
    );
  });
});
