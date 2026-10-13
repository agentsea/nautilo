import { describe, expect, test } from "bun:test";
import { memoryReviewRuntimeAdmission } from "../../src/lib/memory-review-runtime";

describe("Memory review runtime admission", () => {
  test("does not globally gate claims on a server model before per-claim admission", () => {
    expect(memoryReviewRuntimeAdmission({
      enabled: true,
      maintenanceAccepting: true,
      ordinaryContentAvailable: true,
    })).toBe(true);
  });

  test.each([
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ])("retains lifecycle and ordinary-content gates", (enabled, maintenanceAccepting, ordinaryContentAvailable) => {
    expect(memoryReviewRuntimeAdmission({ enabled, maintenanceAccepting, ordinaryContentAvailable })).toBe(false);
  });
});
