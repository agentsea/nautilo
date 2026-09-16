import { describe, expect, test } from "bun:test";
import { REVIEWED_LANDING_DTO_DECLARATIONS, SUPERSEDED_LANDING_DTO_LOCATORS } from "../../baseline/reviewed-main-2026-09-05-landing-dto";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  RETIRED_MAIN_2026_09_03_FROZEN_DEBT,
  REVIEWED_MAIN_2026_09_03_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_09_03_DEBT_LINKS,
  SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-03-coverage";
import {
  REVIEWED_MAIN_2026_09_03_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-03-dto";
import { SUPERSEDED_M311_DTO_LOCATORS } from
  "../../baseline/reviewed-m311-dto";
import {
  REVIEWED_MAIN_2026_09_03_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-03-source-alarms";
import {
  REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS,
  SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-dto";
import {
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import { REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS } from
  "../../baseline/reviewed-main-2026-09-09-platform-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";
import { REVIEWED_M318_DTO_DECLARATIONS, SUPERSEDED_M318_DTO_LOCATORS } from "../../baseline/reviewed-m318-dto";

describe("reviewed main 2026-09-03 encryption inventory", () => {
  test("classifies every reviewed current coverage coordinate exactly once", () => {
    for (const entry of REVIEWED_MAIN_2026_09_03_COVERAGE_ENTRIES) {
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    for (const link of REVIEWED_MAIN_2026_09_03_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
    for (const locator of SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS) {
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
    for (const retirement of RETIRED_MAIN_2026_09_03_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });

  test("pins current DTO structures and removes only superseded declarations", () => {
    expect(REVIEWED_MAIN_2026_09_03_DTO_DECLARATIONS.filter((declaration) =>
      SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(declaration.locator)
    ).map((declaration) => declaration.locator)).toEqual([
      "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
      "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
      "http:request_response:GET /api/tasks/pending-attention",
    ]);
    for (const declaration of REVIEWED_MAIN_2026_09_03_DTO_DECLARATIONS) {
      if (SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === declaration.locator))
          .toEqual(REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((entry) => entry.locator === declaration.locator));
        continue;
      }
      if (SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === declaration.locator))
          .toEqual(REVIEWED_M318_DTO_DECLARATIONS.filter((entry) => entry.locator === declaration.locator));
        continue;
      }
      if (SUPERSEDED_LANDING_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === declaration.locator))
          .toEqual(REVIEWED_LANDING_DTO_DECLARATIONS.filter((entry) => entry.locator === declaration.locator));
        continue;
      }
      if (
        SUPERSEDED_M311_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_M318_DTO_LOCATORS.has(declaration.locator)
      ) {
        expect(DTO_BASELINE_DECLARATIONS).not.toContainEqual(declaration);
      } else {
        expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
      }
    }
    for (const locator of SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS) {
      if (SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === locator))
          .toEqual(REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((entry) => entry.locator === locator));
        continue;
      }
      if (SUPERSEDED_M318_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === locator))
          .toEqual(REVIEWED_M318_DTO_DECLARATIONS.filter((entry) => entry.locator === locator));
        continue;
      }
      if (SUPERSEDED_LANDING_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter((entry) => entry.locator === locator))
          .toEqual(REVIEWED_LANDING_DTO_DECLARATIONS.filter((entry) => entry.locator === locator));
        continue;
      }
      const replacement = REVIEWED_MAIN_2026_09_03_DTO_DECLARATIONS.find(
        (declaration) => declaration.locator === locator,
      );
      const current = DTO_BASELINE_DECLARATIONS.filter((declaration) =>
        declaration.locator === locator
      );
      if (
        SUPERSEDED_M311_DTO_LOCATORS.has(locator)
        || SUPERSEDED_M318_DTO_LOCATORS.has(locator)
      ) {
        expect(current).toHaveLength(1);
        expect(current).not.toEqual(replacement ? [replacement] : []);
      } else {
        expect(current).toEqual(replacement ? [replacement] : []);
      }
    }
  });

  test("closes current source alarms without restoring stale sinks", () => {
    const movedWorkspaceArtifactPrefix =
      "packages/agent/src/tools/file/workspace-binary-artifact.ts#filesystem_write:";
    const currentWorkspaceArtifactReviews = CURRENT_SOURCE_ALARM_REVIEWS.filter((review) =>
      review.locator.startsWith(movedWorkspaceArtifactPrefix)
    );
    const september12WorkspaceArtifactReviews = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.filter((review) =>
      review.locator.startsWith(movedWorkspaceArtifactPrefix)
    );
    expect(september12WorkspaceArtifactReviews).toHaveLength(1);
    expect(currentWorkspaceArtifactReviews).toEqual(september12WorkspaceArtifactReviews);
    for (const review of REVIEWED_MAIN_2026_09_03_SOURCE_ALARMS) {
      if (SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)) {
        expect(CURRENT_SOURCE_ALARM_REVIEWS.some((current) => current.locator === review.locator)).toBe(false);
        continue;
      }
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    const reintroducedSeptember3Locators = [...SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS].filter((locator) =>
      REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS.some((review) => review.locator === locator)
    );
    expect(reintroducedSeptember3Locators).toEqual([
      "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:1",
      "packages/server/src/routes/stt.ts#log_emitter:7ef703451e44cded:2",
    ]);
    for (const locator of SUPERSEDED_MAIN_2026_09_03_SOURCE_ALARM_LOCATORS) {
      const laterReview = REVIEWED_MAIN_2026_09_09_PLATFORM_SOURCE_ALARMS.filter((review) =>
        review.locator === locator
      );
      expect(CURRENT_SOURCE_ALARM_REVIEWS.filter((review) => review.locator === locator))
        .toEqual(laterReview);
    }
  });
});
