import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { REVIEWED_M288_COVERAGE_ENTRIES } from "../../baseline/reviewed-m288-coverage";

describe("M288 encryption inventory", () => {
  test("keeps the aggregate parent-violation diagnostic content-free", () => {
    const declaration = DTO_BASELINE_DECLARATIONS.find((entry) =>
      entry.locator === "http:request_response:GET /api/admin/reflection-status"
    );
    expect(declaration).toBeDefined();
    const status = declaration?.structuralSignatures?.find((signature) =>
      signature.startsWith("response.body:{current:")
    );
    expect(status).toContain("currentParentViolations:number");
    expect(status).not.toContain("recordRef");
    expect(status).not.toContain("roomId");
    expect(status).not.toContain("namespaceId");
    expect(status).not.toContain("humanRef");
  });

  test("reviews only bounded metadata for disposable fixture mutations", () => {
    expect(REVIEWED_M288_COVERAGE_ENTRIES).toHaveLength(5);
    for (const entry of REVIEWED_M288_COVERAGE_ENTRIES) {
      if (entry.classification !== "bounded_metadata") {
        throw new Error("M288 fixture coverage must be bounded metadata");
      }
      expect(entry.plaintextReason).toContain("writes no Record payload");
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
  });
});
