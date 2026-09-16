import { describe, expect, test } from "bun:test";
import { gates } from "../../src/gates.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const ok: ComposeDriverProfile = {
  name: "p",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

describe("gates", () => {
  test("accepts a local + compose + from_source profile", () => {
    expect(() => gates(ok)).not.toThrow();
  });

  test("accepts a remote + compose + from_source profile", () => {
    expect(() =>
      gates({
        name: "r",
        transport: "remote",
        lifecycle: "compose",
        from_source: true,
        ssh: { host: "1.2.3.4", user: "root" },
      }),
    ).not.toThrow();
  });

  test("rejects lifecycle=external with the documented message", () => {
    expect(() =>
      gates({
        name: "r",
        transport: "remote",
        lifecycle: "external",
        from_source: true,
      }),
    ).toThrow(/M092 ComposeDriver only operates on lifecycle=compose profiles/);
  });

  test("rejects lifecycle=external with the documented message (local)", () => {
    expect(() =>
      gates({ ...ok, lifecycle: "external" }),
    ).toThrow(/M092 ComposeDriver only operates on lifecycle=compose profiles/);
  });

  test("accepts a location-only profile without from_source (D420)", () => {
    const p: ComposeDriverProfile = {
      name: "p",
      transport: "local",
      lifecycle: "compose",
    };
    expect(() => gates(p)).not.toThrow();
  });

  test("accepts a legacy registry bridge without a persisted tag", () => {
    expect(() => gates({ ...ok, from_source: false })).not.toThrow();
  });
});
