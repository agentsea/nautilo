import { describe, expect, test } from "bun:test";
import { httpsMode } from "../../src/https-mode.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

function p(over: Partial<ComposeDriverProfile> = {}): ComposeDriverProfile {
  return { name: "x", transport: "local", lifecycle: "compose", from_source: true, ...over };
}

describe("httpsMode", () => {
  test("defaults to off when field absent", () => {
    expect(httpsMode(p())).toBe("off");
  });
  test("returns the field value when present", () => {
    expect(httpsMode(p({ https: "letsencrypt" }))).toBe("letsencrypt");
    expect(httpsMode(p({ https: "off" }))).toBe("off");
  });
});
