import { describe, expect, test } from "bun:test";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-09-document-media-coverage";
import { REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DTO_DECLARATIONS } from "../../baseline/reviewed-main-2026-09-09-document-media-dto";

describe("current-main document and media inventory", () => {
  test("keeps document bytes and Video labels on explicit plaintext debt", () => {
    for (const locator of [
      "app_bridge:app_to_host:nautilo.app.document.req#saveCopy#value",
      "public.video_generation_links.shot_label",
    ]) {
      expect(REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DEBT_LINKS.some((entry) => entry.locator === locator)).toBe(true);
      expect(REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_COVERAGE_ENTRIES.some((entry) => entry.locator === locator)).toBe(false);
    }
    expect(REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_COVERAGE_ENTRIES.filter((entry) => entry.classification === "protected")).toHaveLength(0);
  });

  test("registers exact generated app bridge shapes", () => {
    const saveCopy = REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DTO_DECLARATIONS.find((entry) => entry.locator.endsWith("#AppDocumentSaveCopyRequest"));
    expect(saveCopy?.structuralSignatures?.join(" ")).toContain('op:"saveCopy"');
    expect(saveCopy?.arbitraryPayloads.map((entry) => entry.path)).toContain("value");
    expect((BASELINE_REGISTRY.reviewedDebtLinks ?? []).some((entry) =>
      entry.locator
        === "app_bridge:app_to_host:nautilo.app.document.req#saveCopy#value"
    )).toBe(true);
  });
});
