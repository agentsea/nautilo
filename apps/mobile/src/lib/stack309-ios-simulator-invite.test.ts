/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  consumeStack309IosSimulatorInvite,
  stack309IosSimulatorHarnessEnabled,
} from "./stack309-ios-simulator-invite";

function staged(value: string, exists = true) {
  let present = exists;
  let deleted = 0;
  return {
    file: {
      get exists() { return present; },
      text: async () => value,
      delete: () => { present = false; deleted += 1; },
    },
    deleted: () => deleted,
  };
}

const validLocator = "https://example.test/redeem/inv_abc123";

describe("Stack 309 iOS Simulator invite staging", () => {
  test("is impossible outside a development iOS Simulator", () => {
    expect(stack309IosSimulatorHarnessEnabled({ isDevelopment: true, platform: "ios", isPhysicalDevice: false })).toBe(true);
    expect(stack309IosSimulatorHarnessEnabled({ isDevelopment: false, platform: "ios", isPhysicalDevice: false })).toBe(false);
    expect(stack309IosSimulatorHarnessEnabled({ isDevelopment: true, platform: "ios", isPhysicalDevice: true })).toBe(false);
    expect(stack309IosSimulatorHarnessEnabled({ isDevelopment: true, platform: "android", isPhysicalDevice: false })).toBe(false);
  });

  test("deletes a staged locator only after canonical custody accepts it", async () => {
    const fixture = staged(validLocator);
    const outcome = await consumeStack309IosSimulatorInvite(fixture.file, async () => ({
      kind: "accepted",
      route: { pathname: "/(onboarding)/invite", params: { serverUrl: "https://example.test", serverId: "srv", generation: "1", ceremonyId: "c" } },
    }));
    expect(outcome).toBe("consumed");
    expect(fixture.deleted()).toBe(1);
  });

  test("retains a valid locator when custody cannot commit", async () => {
    const fixture = staged(validLocator);
    const outcome = await consumeStack309IosSimulatorInvite(fixture.file, async () => ({ kind: "persistence-failed", message: "no" }));
    expect(outcome).toBe("retained");
    expect(fixture.deleted()).toBe(0);
  });

  test("removes malformed staged bytes without routing them", async () => {
    const fixture = staged("not a locator");
    let accepted = false;
    const outcome = await consumeStack309IosSimulatorInvite(fixture.file, async () => {
      accepted = true;
      return { kind: "duplicate" };
    });
    expect(outcome).toBe("discarded-invalid");
    expect(accepted).toBe(false);
    expect(fixture.deleted()).toBe(1);
  });
});
