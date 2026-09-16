import { describe, expect, test } from "bun:test";
import { buildGuestToolPolicy } from "../../src/personal-policy-resolver";
import { getToolPolicy } from "../../src/tool-policies";

describe("D419 deactivate_tools trust posture", () => {
  test("mirrors activate_tools for registered and guest policy access", () => {
    expect(getToolPolicy("deactivate_tools")).toEqual(getToolPolicy("activate_tools"));

    const guestPolicy = buildGuestToolPolicy();
    expect(guestPolicy["deactivate_tools"]).toBe(guestPolicy["activate_tools"]);
    expect(guestPolicy["deactivate_tools"]).toBe("allow");
  });
});
