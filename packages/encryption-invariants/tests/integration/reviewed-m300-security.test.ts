import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_M300_COVERAGE_ENTRIES } from "../../baseline/reviewed-m300-coverage";
import { REVIEWED_M300_DTO_DECLARATIONS } from "../../baseline/reviewed-m300-dto";
import { SUPERSEDED_M301_DTO_LOCATORS } from "../../baseline/reviewed-m301-dto";
import {
  SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-03-coverage";
import { SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS } from
  "../../baseline/reviewed-main-2026-09-03-dto";

describe("M300 additional-device encryption inventory", () => {
  test("classifies the added enrollment routes as ciphertext-only", () => {
    expect(REVIEWED_M300_COVERAGE_ENTRIES).toHaveLength(3);
    for (const entry of REVIEWED_M300_COVERAGE_ENTRIES) {
      expect(entry.classification).toBe("protected");
      if (entry.classification !== "protected") {
        throw new Error("M300 additional-device route must be protected");
      }
      expect(entry.keyFamily).toBe("namespace_human");
      expect(entry.migrationState).toBe("ciphertext_only");
      if (SUPERSEDED_MAIN_2026_09_03_COVERAGE_LOCATORS.has(entry.locator)) {
        expect(BASELINE_REGISTRY.entries.some((candidate) =>
          candidate.locator === entry.locator
        )).toBe(false);
      } else {
        expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      }
    }
  });

  test("pins the complete additional-device wire shapes", () => {
    expect(REVIEWED_M300_DTO_DECLARATIONS).toHaveLength(7);
    for (const declaration of REVIEWED_M300_DTO_DECLARATIONS) {
      expect(declaration.arbitraryPayloads).toEqual([]);
      if (
        SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator)
      ) {
        expect(DTO_BASELINE_DECLARATIONS.filter((candidate) =>
          candidate.locator === declaration.locator
        )).toHaveLength(1);
      } else if (SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS.has(declaration.locator)) {
        expect(DTO_BASELINE_DECLARATIONS).not.toContainEqual(declaration);
      } else {
        expect(DTO_BASELINE_DECLARATIONS).toContainEqual(declaration);
      }
    }
    const grantSync = REVIEWED_M300_DTO_DECLARATIONS.find((declaration) =>
      declaration.locator.endsWith("/:operationId/grant-sync-page")
    );
    expect(grantSync?.structuralSignatures?.join("\n")).toContain(
      "namespaces?:{namespaceId:string;roomId:string}[]",
    );
  });
});
