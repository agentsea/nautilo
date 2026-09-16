import { describe, expect, test } from "bun:test";
import { composeProjectName } from "../../src/composeProjectName.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

function profile(over: Partial<ComposeDriverProfile> = {}): ComposeDriverProfile {
  return {
    name: "p",
    transport: "local",
    lifecycle: "compose",
    from_source: true,
    ...over,
  };
}

describe("composeProjectName", () => {
  test('empty instance_id → "nautilo" (default project)', () => {
    expect(composeProjectName(profile({ instance_id: "" }))).toBe("nautilo");
  });

  test('undefined instance_id → "nautilo"', () => {
    expect(composeProjectName(profile())).toBe("nautilo");
  });

  test('whitespace-only instance_id → "nautilo"', () => {
    expect(composeProjectName(profile({ instance_id: "   " }))).toBe("nautilo");
  });

  test('non-empty instance_id → "nautilo-<id>"', () => {
    expect(composeProjectName(profile({ instance_id: "beta" }))).toBe(
      "nautilo-beta",
    );
  });
});
