import { describe, test, expect } from "bun:test";
import { sanitizeRecommendedSetupUrl } from "../../src/lib/setup-surface-url";

describe("sanitizeRecommendedSetupUrl (D112)", () => {
  const ctx = {
    serverUrl: "http://127.0.0.1:3001",
    workbenchOrigin: "http://127.0.0.1:5173",
  };

  test("allows relative paths", () => {
    expect(sanitizeRecommendedSetupUrl("/admin/providers", ctx)).toBe(
      "/admin/providers",
    );
  });

  test("rejects protocol-relative URLs", () => {
    expect(sanitizeRecommendedSetupUrl("//evil.test/phish", ctx)).toBeNull();
  });

  test("allows URLs on the server origin", () => {
    expect(sanitizeRecommendedSetupUrl("http://127.0.0.1:3001/health", ctx)).toBe(
      "http://127.0.0.1:3001/health",
    );
  });

  test("allows URLs on the workbench origin", () => {
    expect(
      sanitizeRecommendedSetupUrl("http://127.0.0.1:5173/admin/providers", ctx),
    ).toBe("http://127.0.0.1:5173/admin/providers");
  });

  test("allows loopback-equivalent URLs on trusted origins", () => {
    expect(sanitizeRecommendedSetupUrl("http://localhost:3001/health", ctx)).toBe(
      "http://localhost:3001/health",
    );

    expect(
      sanitizeRecommendedSetupUrl("http://localhost:5173/admin/providers", ctx),
    ).toBe("http://localhost:5173/admin/providers");
  });

  test("denies loopback aliases on mismatched ports", () => {
    expect(sanitizeRecommendedSetupUrl("http://localhost:3000/health", ctx)).toBeNull();
  });

  test("denies malicious loopback lookalikes", () => {
    expect(
      sanitizeRecommendedSetupUrl("http://localhost.evil:3001/health", ctx),
    ).toBeNull();
    expect(
      sanitizeRecommendedSetupUrl("http://127.0.0.1.evil:3001/health", ctx),
    ).toBeNull();
  });

  test("denies other origins", () => {
    expect(sanitizeRecommendedSetupUrl("https://evil.example/phish", ctx)).toBeNull();
  });

  test("allows server-origin URLs when workbench origin is empty (SSR)", () => {
    expect(
      sanitizeRecommendedSetupUrl("http://127.0.0.1:3001/x", {
        serverUrl: "http://127.0.0.1:3001",
        workbenchOrigin: "",
      }),
    ).toBe("http://127.0.0.1:3001/x");
  });

  test("returns null when serverUrl is not a valid absolute URL base", () => {
    expect(
      sanitizeRecommendedSetupUrl("http://127.0.0.1:3001/", {
        serverUrl: "::not-a-url",
        workbenchOrigin: "",
      }),
    ).toBeNull();
  });

  test("returns null for empty", () => {
    expect(sanitizeRecommendedSetupUrl("", ctx)).toBeNull();
    expect(sanitizeRecommendedSetupUrl(null, ctx)).toBeNull();
  });
});
