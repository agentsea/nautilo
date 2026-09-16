import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  isNotificationLevel,
  resolveEffectiveNotificationLevel,
} from "../../src/notification-preferences";

describe("M233 notification preference policy", () => {
  test("recognizes only the locked stored levels", () => {
    expect(["none", "direct", "all"].every(isNotificationLevel)).toBe(true);
    for (const value of ["inherit", "", "DIRECT", null, undefined, 1]) {
      expect(isNotificationLevel(value)).toBe(false);
    }
  });

  test("missing account and override state resolves to direct", () => {
    expect(DEFAULT_NOTIFICATION_LEVEL).toBe("direct");
    expect(
      resolveEffectiveNotificationLevel({
        defaultLevel: null,
        overrideLevel: null,
      }),
    ).toBe("direct");
  });

  test("Room override wins and account default otherwise applies", () => {
    expect(
      resolveEffectiveNotificationLevel({
        defaultLevel: "none",
        overrideLevel: "all",
      }),
    ).toBe("all");
    expect(
      resolveEffectiveNotificationLevel({
        defaultLevel: "none",
        overrideLevel: null,
      }),
    ).toBe("none");
  });
});
