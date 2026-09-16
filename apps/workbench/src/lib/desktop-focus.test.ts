import { describe, expect, test } from "bun:test";
import { resolveWorkbenchSurfaceFocused } from "./desktop";

describe("resolveWorkbenchSurfaceFocused", () => {
  test("uses browser document focus when no Desktop signal exists", () => {
    expect(
      resolveWorkbenchSurfaceFocused({ documentFocused: true }),
    ).toBe(true);
    expect(
      resolveWorkbenchSurfaceFocused({ documentFocused: false }),
    ).toBe(false);
  });

  test("trusts Desktop when Chromium stays focused on another macOS Space", () => {
    expect(
      resolveWorkbenchSurfaceFocused({
        nativeFocus: () => false,
        documentFocused: true,
      }),
    ).toBe(false);
  });

  test("fails closed when the Desktop focus bridge throws", () => {
    expect(
      resolveWorkbenchSurfaceFocused({
        nativeFocus: () => {
          throw new Error("bridge unavailable");
        },
        documentFocused: true,
      }),
    ).toBe(false);
  });
});
