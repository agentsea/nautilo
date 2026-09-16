import { describe, expect, test } from "bun:test";

import { isForegroundShadowDeviceKind } from "../../src/server/foreground-shadow-device-kind.ts";

describe("foreground Shadow device admission", () => {
  test("admits Browser and Electron while keeping unsupported clients closed", () => {
    expect(isForegroundShadowDeviceKind("browser")).toBe(true);
    expect(isForegroundShadowDeviceKind("electron")).toBe(true);
    expect(isForegroundShadowDeviceKind("tui")).toBe(false);
    expect(isForegroundShadowDeviceKind("mobile")).toBe(false);
    expect(isForegroundShadowDeviceKind(null)).toBe(false);
  });
});
