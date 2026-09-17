import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  RETIRED_MAIN_2026_08_31_FROZEN_DEBT,
  REVIEWED_MAIN_2026_08_31_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_31_DEBT_LINKS,
  SUPERSEDED_MAIN_2026_08_31_COVERAGE_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-coverage";
import {
  REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-dto";
import {
  REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-31-source-alarms";
import { SUPERSEDED_M301_DTO_LOCATORS } from "../../baseline/reviewed-m301-dto";
import { SUPERSEDED_D565_RELAY_DTO_LOCATORS } from "../../baseline/reviewed-d565-relay-dto";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

const RELEASE_EXTRACTION_REMOVED_SOURCE_ALARM_LOCATORS = [
  "apps/desktop/scripts/publish-computer-use-host.ts#filesystem_write:162bcab80738ba43:1",
  "apps/desktop/scripts/publish-computer-use-host.ts#filesystem_write:fe2009f74a6d7d4f:1",
  "apps/desktop/scripts/publish-computer-use-host.ts#filesystem_write:d26d205da85a8f86:1",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:1",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:2",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:3",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:4",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:5",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:6",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:468c68ed4723a1f2:7",
  "apps/desktop/scripts/publish-computer-use-host.ts#log_emitter:c467686340f4efc2:1",
] as const;

describe("reviewed main 2026-08-31 encryption inventory", () => {
  test("pins the typed Computer Use request without hiding relay plaintext debt", () => {
    expect(REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS).toHaveLength(6);
    for (const declaration of REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS) {
      if (
        SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
        || SUPERSEDED_D565_RELAY_DTO_LOCATORS.has(declaration.locator)
      ) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === declaration.locator
        )).toHaveLength(1);
      } else {
        expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
      }
      for (const payload of declaration.arbitraryPayloads.filter((item) =>
        item.path.includes("computerUseRequest")
        || declaration.locator.includes("ComputerUseHostDispatchRequest")
      )) {
        expect("schema" in payload ? payload.schema : "").toMatch(
          /^ComputerUseHost(?:Arguments|Contract)V1$/u,
        );
      }
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_31_DTO_LOCATORS) {
      if (SUPERSEDED_D565_RELAY_DTO_LOCATORS.has(locator)) {
        expect(DTO_BASELINE_DECLARATIONS.filter(
          (declaration) => declaration.locator === locator,
        )).toHaveLength(1);
        continue;
      }
      const expected = REVIEWED_MAIN_2026_08_31_DTO_DECLARATIONS.find(
        (declaration) => declaration.locator === locator,
      );
      expect(DTO_BASELINE_DECLARATIONS.filter(
        (declaration) => declaration.locator === locator,
      )).toEqual(
        SUPERSEDED_M301_DTO_LOCATORS.has(locator)
          ? DTO_BASELINE_DECLARATIONS.filter((declaration) =>
            declaration.locator === locator
          )
          : expected ? [expected] : [],
      );
    }

    expect(REVIEWED_MAIN_2026_08_31_COVERAGE_ENTRIES).toHaveLength(5);
    expect(REVIEWED_MAIN_2026_08_31_DEBT_LINKS).toHaveLength(7);
    expect(REVIEWED_MAIN_2026_08_31_COVERAGE_ENTRIES.every(
      (entry) => entry.classification === "bounded_metadata",
    )).toBe(true);
    expect(REVIEWED_MAIN_2026_08_31_DEBT_LINKS.slice(0, 6).every(
      (link) => link.locator.includes("computerUse")
        || link.locator.includes("ComputerUse"),
    )).toBe(true);
    for (const entry of REVIEWED_MAIN_2026_08_31_COVERAGE_ENTRIES) {
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    for (const link of REVIEWED_MAIN_2026_08_31_DEBT_LINKS) {
      expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(link);
    }
  });

  test("preserves renamed processor debt and removes retired coordinates", () => {
    expect(RETIRED_MAIN_2026_08_31_FROZEN_DEBT).toHaveLength(1);
    expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(
      RETIRED_MAIN_2026_08_31_FROZEN_DEBT[0],
    );
    for (const locator of SUPERSEDED_MAIN_2026_08_31_COVERAGE_LOCATORS) {
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
  });

  test("reviews every new sink and retains uncertain diagnostics as debt", () => {
    expect(REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS).toHaveLength(28);
    expect(REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS.filter(
      (review) => review.closure === "reviewed_exclusion",
    )).toHaveLength(11);
    expect(REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS.filter(
      (review) => review.closure === "baseline_debt",
    )).toHaveLength(3);
    for (const review of REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of RELEASE_EXTRACTION_REMOVED_SOURCE_ALARM_LOCATORS) {
      expect(REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS.some((review) =>
        review.locator === locator
      )).toBe(false);
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }
  });
});
