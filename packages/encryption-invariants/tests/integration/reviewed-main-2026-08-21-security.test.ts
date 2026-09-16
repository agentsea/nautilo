import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_21_FROZEN_DEBT,
  RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS,
  REVIEWED_MAIN_2026_08_21_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_21_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-08-21-coverage";
import {
  REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_21_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-21-source-alarms";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("reviewed main 2026-08-21 encryption inventory", () => {
  test("keeps the new Reflection fixture content in existing plaintext debt", () => {
    expect(REVIEWED_MAIN_2026_08_21_COVERAGE_ENTRIES).toHaveLength(2);
    for (const entry of REVIEWED_MAIN_2026_08_21_COVERAGE_ENTRIES) {
      expect(entry.classification).toBe("bounded_metadata");
      if (entry.classification !== "bounded_metadata") {
        throw new Error(`unexpected classification: ${entry.classification}`);
      }
      expect(entry.plaintextReason).toContain(
        "Memory content and its semantic vector are excluded",
      );
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }

    expect(REVIEWED_MAIN_2026_08_21_DEBT_LINKS).toHaveLength(1);
    const [memoryLink] = REVIEWED_MAIN_2026_08_21_DEBT_LINKS;
    expect(memoryLink?.targetDebtIds).toContain(
      "debt.db.public.memories.content",
    );
    expect(memoryLink?.targetDebtIds).toContain(
      "debt.db.public.memories.embedding",
    );
    expect(BASELINE_REGISTRY.reviewedDebtLinks).toContainEqual(memoryLink);
  });

  test("retires only the vanished restore identity deletions", () => {
    expect(RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS.size).toBe(2);
    expect(RETIRED_MAIN_2026_08_21_FROZEN_DEBT).toHaveLength(2);
    for (const locator of RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS) {
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) => entry.locator === locator))
        .toBe(false);
    }
    for (const retirement of RETIRED_MAIN_2026_08_21_FROZEN_DEBT) {
      expect(BASELINE_REGISTRY.retiredFrozenDebt).toContainEqual(retirement);
    }
  });

  test("records the managed-cloud research response without credential presence", () => {
    for (const locator of [
      "http:request_response:GET /api/setup/research-provider",
      "http:request_response:PUT /api/setup/research-provider",
    ]) {
      const declaration = DTO_BASELINE_DECLARATIONS.find((entry) =>
        entry.locator === locator
      );
      expect(declaration).toBeDefined();
      const signatures = declaration?.structuralSignatures ?? [];
      expect(signatures.some((signature) =>
        signature.includes("tavilyConfigured?:boolean")
      )).toBe(true);
      expect(signatures.some((signature) =>
        signature.includes("tavilyConfigured:boolean")
      )).toBe(false);
    }
  });

  test("closes the exact fixed-warning alarm", async () => {
    expect(REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS).toHaveLength(1);
    for (const review of REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS) {
      expect(review.closure).toBe("declaration");
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_21_SOURCE_ALARM_LOCATORS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(false);
    }

    const source = await scanSourceAlarms({ repoRoot: repositoryRoot });
    expect(source.errors).toEqual([]);
    expect(inspectSourceAlarmReviews(source.alarms).errors).toEqual([]);
  });
});
