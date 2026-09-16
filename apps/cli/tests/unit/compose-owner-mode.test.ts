import { describe, expect, test } from "bun:test";

import { resolveComposeOwnerMode } from "../../src/lib/compose-owner-mode.ts";

describe("resolveComposeOwnerMode", () => {
  const defaultOwnerConfigPath = "/protected/deploy.toml";
  const ownerResultPath = "/safe/owner-result.json";

  test("interactive absence selects hosted claim regardless of ambient config", () => {
    for (const protectedOwnerConfigPresent of [false, true]) {
      expect(resolveComposeOwnerMode({
        defaultOwnerConfigPath,
        protectedOwnerConfigPresent,
        requestedOwnerMode: undefined,
        requestedOwnerConfigPath: undefined,
        requestedOwnerResultPath: undefined,
        redeem: true,
        interactive: true,
        json: false,
      })).toEqual({ kind: "claim", ownerMode: "claim" });
    }
  });

  test("JSON and noninteractive absence require explicit intent regardless of ambient config", () => {
    for (const protectedOwnerConfigPresent of [false, true]) {
      for (const input of [
        { interactive: false, json: false },
        { interactive: true, json: true },
      ]) {
        expect(resolveComposeOwnerMode({
          defaultOwnerConfigPath,
          protectedOwnerConfigPresent,
          requestedOwnerMode: undefined,
          requestedOwnerConfigPath: undefined,
          requestedOwnerResultPath: undefined,
          redeem: true,
          ...input,
        })).toMatchObject({ kind: "rejected", code: "owner-mode-required" });
      }
    }
  });

  test("explicit owner-config accepts explicit config/result paths", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: undefined,
      requestedOwnerConfigPath: " /protected/cloud-owner.toml ",
      requestedOwnerResultPath: " /safe/owner-result.json ",
      redeem: true,
      interactive: false,
      json: false,
    })).toEqual({
      kind: "config",
      ownerMode: "config",
      ownerConfigPath: "/protected/cloud-owner.toml",
      ownerResultPath: "/safe/owner-result.json",
    });
  });

  test("explicit config mode uses the protected default only when it is present", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: ownerResultPath,
      redeem: true,
      interactive: false,
      json: true,
    })).toEqual({
      kind: "config",
      ownerMode: "config",
      ownerConfigPath: defaultOwnerConfigPath,
      ownerResultPath,
    });
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: ownerResultPath,
      redeem: true,
      interactive: false,
      json: true,
    })).toMatchObject({ kind: "rejected", code: "owner-config-missing" });
  });

  test("no-redeem is never a bypass", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: undefined,
      redeem: false,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "redeem-disabled" });
  });

  test("explicit claim ignores ambient config and preserves flag conflicts", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "claim",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: undefined,
      redeem: true,
      interactive: false,
      json: true,
    })).toEqual({ kind: "claim", ownerMode: "claim" });

    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "claim",
      requestedOwnerConfigPath: "/protected/owner.toml",
      requestedOwnerResultPath: undefined,
      redeem: true,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-config-conflicts-claim" });
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "claim",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: ownerResultPath,
      redeem: true,
      interactive: true,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-result-conflicts-claim" });
  });

  test("rejects missing config and result inputs for explicit config selection", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: undefined,
      redeem: true,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-config-missing" });
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: undefined,
      redeem: true,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-result-missing" });
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: undefined,
      requestedOwnerConfigPath: "/protected/owner.toml",
      requestedOwnerResultPath: undefined,
      redeem: true,
      interactive: true,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-result-missing" });
  });

  test("result path alone is not a selector, including with ambient config", () => {
    for (const protectedOwnerConfigPresent of [false, true]) {
      expect(resolveComposeOwnerMode({
        defaultOwnerConfigPath,
        protectedOwnerConfigPresent,
        requestedOwnerMode: undefined,
        requestedOwnerConfigPath: undefined,
        requestedOwnerResultPath: ownerResultPath,
        redeem: true,
        interactive: false,
        json: true,
      })).toMatchObject({ kind: "rejected", code: "owner-result-requires-config" });
    }
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: true,
      requestedOwnerMode: undefined,
      requestedOwnerConfigPath: undefined,
      requestedOwnerResultPath: ownerResultPath,
      redeem: true,
      interactive: true,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-result-requires-config" });
  });

  test("requires absolute normalized config and result paths", () => {
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: "relative-owner.toml",
      requestedOwnerResultPath: ownerResultPath,
      redeem: true,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-config-invalid" });
    expect(resolveComposeOwnerMode({
      defaultOwnerConfigPath,
      protectedOwnerConfigPresent: false,
      requestedOwnerMode: "config",
      requestedOwnerConfigPath: "/protected/owner.toml",
      requestedOwnerResultPath: "/safe/../owner-result.json",
      redeem: true,
      interactive: false,
      json: false,
    })).toMatchObject({ kind: "rejected", code: "owner-result-invalid" });
  });
});
