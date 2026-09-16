import { describe, expect, test } from "bun:test";
import { loadProfileFromObject } from "../../src/lib/profile-schema.ts";

describe("profile office field", () => {
  test("office defaults to false when omitted (local compose)", () => {
    const p = loadProfileFromObject(
      { name: "x", transport: "local", lifecycle: "compose" },
      "x",
    );
    expect(p.office ?? false).toBe(false);
  });

  test("office=true parses (local compose)", () => {
    const p = loadProfileFromObject(
      { name: "x", transport: "local", lifecycle: "compose", office: true },
      "x",
    );
    expect(p.office).toBe(true);
  });

  test("office=true parses (remote compose)", () => {
    const p = loadProfileFromObject(
      {
        name: "y",
        transport: "remote",
        lifecycle: "compose",
        ssh: { host: "h", user: "u" },
        office: true,
      },
      "y",
    );
    expect(p.office).toBe(true);
  });
});
