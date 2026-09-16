import { describe, expect, test } from "bun:test";
import { sanitizeActiveMiniAppContextSafe } from "../../src/messaging/active-mini-app-context";

describe("sanitizeActiveMiniAppContextSafe", () => {
  test("drops malformed payloads without throwing", () => {
    expect(sanitizeActiveMiniAppContextSafe(null)).toBeNull();
    expect(sanitizeActiveMiniAppContextSafe(undefined)).toBeNull();
    expect(sanitizeActiveMiniAppContextSafe("bad")).toBeNull();
    expect(sanitizeActiveMiniAppContextSafe({ appId: "" , updatedAt: 1 })).toBeNull();
    expect(sanitizeActiveMiniAppContextSafe({ appId: "test-canvas", updatedAt: "nope" })).toBeNull();
  });

  test("bounds strings and strips control characters", () => {
    const out = sanitizeActiveMiniAppContextSafe({
      appId: "test-canvas",
      appName: "Spread\nsheet",
      documentPath: "budget.spreadsheet.json",
      targetKind: "artifact",
      updatedAt: 1_700_000_000_000,
    });
    expect(out).toEqual({
      appId: "test-canvas",
      appName: "Spreadsheet",
      documentPath: "budget.spreadsheet.json",
      targetKind: "artifact",
      updatedAt: 1_700_000_000_000,
    });
  });

  test("strips forbidden ids and full cell payloads from JSON fields", () => {
    const out = sanitizeActiveMiniAppContextSafe({
      appId: "test-canvas",
      updatedAt: 1,
      selection: {
        sheetName: "Sheet1",
        artifactId: "secret",
        cells: [{ a1: "x" }],
      },
      summary: {
        roomId: "secret-room",
        spreadsheet: {
          sheetName: "Sheet1",
          usedRange: "A1:F40",
        },
      },
    });
    expect(out?.selection).toEqual({ sheetName: "Sheet1" });
    expect(out?.summary).toEqual({
      spreadsheet: {
        sheetName: "Sheet1",
        usedRange: "A1:F40",
      },
    });
  });

  test("drops oversized JSON fields", () => {
    const out = sanitizeActiveMiniAppContextSafe({
      appId: "test-canvas",
      updatedAt: 1,
      summary: { blob: "x".repeat(20_000) },
    });
    expect(out).toEqual({ appId: "test-canvas", updatedAt: 1 });
  });
});
