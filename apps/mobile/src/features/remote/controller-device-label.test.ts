import { describe, expect, test } from "bun:test";

import { controllerDeviceLabel } from "./controller-device-label";

describe("controller device labels", () => {
  test("uses a real device model without exposing an installation identifier", () => {
    expect(controllerDeviceLabel({
      isDevice: true,
      modelName: "  Pixel 10 Pro  ",
      platform: "android",
    })).toBe("Pixel 10 Pro");
  });

  test("uses explicit simulator fallbacks", () => {
    expect(controllerDeviceLabel({
      isDevice: false,
      modelName: "iPhone 17 Pro",
      platform: "ios",
    })).toBe("iPhone simulator");
    expect(controllerDeviceLabel({
      isDevice: false,
      modelName: null,
      platform: "android",
    })).toBe("Android phone simulator");
  });

  test("bounds provider-supplied model names to the server contract", () => {
    expect(controllerDeviceLabel({
      isDevice: true,
      modelName: "x".repeat(250),
      platform: "ios",
    })).toHaveLength(200);
  });
});
