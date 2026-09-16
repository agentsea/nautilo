import { expect, test } from "bun:test";

import {
  readSettingsReauthNavigation,
  settingsReauthReturnPath,
  settingsVerificationIncompletePath,
} from "./settings-reauth-navigation-contract";

const origin = "https://alpha.example.test";

test("builds only the two named Mobile Web Settings action paths", () => {
  expect(settingsReauthReturnPath("reset-pin"))
    .toBe("/mobile/settings/security?reauth=reset-pin");
  expect(settingsReauthReturnPath("regenerate-account-codes"))
    .toBe("/mobile/settings/security?reauth=regenerate-account-codes");
});

test("reads one same-origin action and consumes it to the clean Security path", () => {
  expect(readSettingsReauthNavigation(
    `${origin}${settingsReauthReturnPath("reset-pin")}`,
    origin,
  )).toEqual({
    navigation: { kind: "intent", intent: "reset-pin" },
    cleanupPath: "/mobile/settings/security",
  });
  expect(readSettingsReauthNavigation(
    `${origin}${settingsVerificationIncompletePath()}`,
    origin,
  )).toEqual({
    navigation: { kind: "verification-incomplete" },
    cleanupPath: "/mobile/settings/security",
  });
});

test("rejects cross-origin, unknown, ambiguous, and decorated navigation state", () => {
  const invalid = [
    "https://evil.example/mobile/settings/security?reauth=reset-pin",
    `${origin}/mobile/settings/security?reauth=delete-account`,
    `${origin}/mobile/settings/security?reauth=reset-pin&verification=incomplete`,
    `${origin}/mobile/settings/security?reauth=reset-pin&code=secret`,
    `${origin}/mobile/settings/security?reauth=reset-pin#state=secret`,
  ];
  for (const value of invalid) {
    expect(readSettingsReauthNavigation(value, origin)).toBeNull();
  }
});
