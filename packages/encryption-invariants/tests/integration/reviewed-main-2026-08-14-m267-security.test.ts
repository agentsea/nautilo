import { describe, expect, test } from "bun:test";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_14_M267_FROZEN_DEBT,
  RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/retired-main-2026-08-14-m267";
import {
  REVIEWED_MAIN_2026_08_14_M267_COVERAGE_ENTRIES,
  SUPERSEDED_MAIN_2026_08_14_M267_COVERAGE_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-14-m267";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

describe("reviewed M267 landing security decisions", () => {
  test("separates Record payload writers from content-free cutover state", () => {
    expect(REVIEWED_MAIN_2026_08_14_M267_COVERAGE_ENTRIES).toHaveLength(51);
    const protectedEntries =
      REVIEWED_MAIN_2026_08_14_M267_COVERAGE_ENTRIES.filter((entry) =>
        entry.classification === "protected"
      );
    expect(protectedEntries).toHaveLength(2);
    expect(protectedEntries.map((entry) => entry.migrationState).sort()).toEqual([
      "ciphertext_only",
      "shadow",
    ]);
    for (const entry of REVIEWED_MAIN_2026_08_14_M267_COVERAGE_ENTRIES) {
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      if (entry.classification === "bounded_metadata") {
        expect(entry.plaintextReason).toContain("content-free identifiers");
      }
    }
  });

  test("retires replaced writers without rewriting frozen Wave 0 history", () => {
    expect(RETIRED_MAIN_2026_08_14_M267_FROZEN_DEBT).toHaveLength(4);
    for (const locator of
      RETIRED_MAIN_2026_08_14_M267_RAW_DATABASE_WRITER_LOCATORS) {
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_14_M267_COVERAGE_LOCATORS) {
      expect(BASELINE_REGISTRY.entries.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
  });

  test("reviews the deterministic migration finalizer as build-time only", () => {
    const locator =
      "packages/db/scripts/finalize-m267-stenographer-record-cutover.ts#filesystem_write:3dcc6339408547a4:1";
    expect(CURRENT_SOURCE_ALARM_REVIEWS.find((review) =>
      review.locator === locator
    )).toMatchObject({
      locator,
      closure: "reviewed_exclusion",
      owner: "packages/db",
    });
  });
});
