import { describe, expect, test } from "bun:test";

import { resolveInitialTheme } from "../../src/hooks/use-theme";

describe("resolveInitialTheme", () => {
  test("defaults to dark when no explicit theme is stored", () => {
    expect(resolveInitialTheme({ getItem: () => null })).toBe("dark");
  });

  test("preserves an explicit light preference", () => {
    expect(resolveInitialTheme({ getItem: () => "light" })).toBe("light");
  });

  test("preserves an explicit dark preference", () => {
    expect(resolveInitialTheme({ getItem: () => "dark" })).toBe("dark");
  });

  test("falls back to dark when storage throws", () => {
    expect(resolveInitialTheme({
      getItem: () => {
        throw new Error("blocked");
      },
    })).toBe("dark");
  });
});
