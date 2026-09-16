import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_M301_COVERAGE_ENTRIES,
  REVIEWED_M301_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-m301-coverage";
import { REVIEWED_M301_DTO_DECLARATIONS } from "../../baseline/reviewed-m301-dto";
import { REVIEWED_M301_SOURCE_ALARMS } from "../../baseline/reviewed-m301-source-alarms";
import {
  RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
  REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-source-alarms";
import { collectRepositoryInventory } from "../../src/node/repository-inventory";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

const repositoryRoot = join(import.meta.dir, "../../../..");

describe("M301 V2 Domain-key authority encryption inventory", () => {
  test("classifies every new table, column, and transport without new debt", () => {
    expect(REVIEWED_M301_COVERAGE_ENTRIES).toHaveLength(152);
    expect(REVIEWED_M301_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "protected"
    )).toHaveLength(24);
    expect(REVIEWED_M301_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "bounded_metadata"
    )).toHaveLength(128);
    for (const entry of REVIEWED_M301_COVERAGE_ENTRIES) {
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      expect(entry.testEvidence.length).toBeGreaterThan(0);
      if (entry.classification === "protected") {
        expect(entry.migrationState).toBe("ciphertext_only");
        expect(entry.negativeTestEvidence.length).toBeGreaterThan(0);
      }
    }
  });

  test("pins every new production database writer", async () => {
    expect(REVIEWED_M301_DATABASE_WRITER_LOCATORS).toHaveLength(17);
    const inventory = await collectRepositoryInventory(repositoryRoot);
    const observed = new Set(inventory.databaseWriters.map((item) => item.locator));
    expect(
      REVIEWED_M301_DATABASE_WRITER_LOCATORS.filter((locator) =>
        !observed.has(locator)
      ),
    ).toEqual([]);
    expect(
      inventory.databaseWriters
        .filter((item) =>
          item.path ===
            "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts"
        )
        .map((item) => item.locator),
    ).toEqual([...REVIEWED_M301_DATABASE_WRITER_LOCATORS]);
  });

  test("pins the eleven closed wire contracts", () => {
    expect(REVIEWED_M301_DTO_DECLARATIONS).toHaveLength(11);
    for (const declaration of REVIEWED_M301_DTO_DECLARATIONS) {
      expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
    }
    expect(
      REVIEWED_M301_DTO_DECLARATIONS.flatMap((declaration) =>
        declaration.arbitraryPayloads
      ),
    ).toEqual([]);
  });

  test("keeps the new diagnostics and build/export boundaries explicitly reviewed", async () => {
    expect(REVIEWED_M301_SOURCE_ALARMS).toHaveLength(7);
    const unchanged = REVIEWED_M301_SOURCE_ALARMS.filter((review) =>
      !SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    const superseded = REVIEWED_M301_SOURCE_ALARMS.filter((review) =>
      SUPERSEDED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(review.locator)
    );
    expect(unchanged).toHaveLength(5);
    expect(superseded).toHaveLength(2);
    for (const review of unchanged) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const review of superseded) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).not.toContainEqual(review);
      const replacement = REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.find(
        (current) => current.locator === review.locator,
      );
      const retired = RETIRED_MAIN_2026_09_12_SOURCE_ALARM_LOCATORS.has(
        review.locator,
      );
      expect(replacement !== undefined || retired).toBe(true);
      expect(retired).toBe(false);
      expect(replacement?.closure).toBe("baseline_debt");
      if (!replacement) throw new Error(`Missing current review: ${review.locator}`);
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(replacement);
      if (replacement?.closure === "baseline_debt") {
        expect(replacement.releaseImpact).toBe("blocks_whole_product_claim");
      }
    }

    const currentDomainKeyDiagnostics = [
      "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:4",
      "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c6d53eb0eb42455b:5",
    ].map((locator) =>
      REVIEWED_MAIN_2026_09_12_SOURCE_ALARMS.find((review) =>
        review.locator === locator
      )
    );
    expect(currentDomainKeyDiagnostics).toHaveLength(2);
    for (const review of currentDomainKeyDiagnostics) {
      expect(review?.closure).toBe("declaration");
      if (!review) throw new Error("Missing current Domain-key diagnostic review");
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    const runtime = await readFile(
      join(repositoryRoot, "apps/workbench/src/adapters/nautilo-runtime.tsx"),
      "utf8",
    );
    expect(runtime).toContain(
      '"[nautilo-runtime] V2 Domain-key catch-up failed",\n'
        + "              error instanceof Error ? error.name : typeof error,",
    );
    expect(runtime).toContain(
      '"[nautilo-runtime] V2 Domain-key delivery failed",\n'
        + "              error instanceof Error ? error.name : typeof error,",
    );
  });
});
