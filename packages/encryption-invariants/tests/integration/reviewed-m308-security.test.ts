import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_M308_COVERAGE_ENTRIES } from
  "../../baseline/reviewed-m308-coverage";
import { REVIEWED_M308_DTO_DECLARATIONS } from
  "../../baseline/reviewed-m308-dto";

describe("M308 personal encryption coverage inventory", () => {
  test("classifies the aggregate database reader and wire response as bounded metadata", () => {
    expect(REVIEWED_M308_COVERAGE_ENTRIES).toHaveLength(5);
    for (const entry of REVIEWED_M308_COVERAGE_ENTRIES) {
      expect(entry.classification).toBe("bounded_metadata");
      expect(entry.testEvidence.length).toBeGreaterThan(0);
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
    expect(REVIEWED_M308_COVERAGE_ENTRIES[0]?.writers).toEqual([]);
  });

  test("pins the closed personal coverage contract", () => {
    expect(REVIEWED_M308_DTO_DECLARATIONS).toHaveLength(1);
    expect(DTO_BASELINE_DECLARATIONS).toContainEqual(
      REVIEWED_M308_DTO_DECLARATIONS[0]!,
    );
  });
});
