import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mobileRoot = resolve(import.meta.dir, "..");

describe("mobile server registration URL contract", () => {
  test("the successful probe returns and persists the exact answering origin", () => {
    const api = readFileSync(resolve(mobileRoot, "lib/api.ts"), "utf8");
    const registry = readFileSync(resolve(mobileRoot, "providers/server-registry.tsx"), "utf8");

    expect(api).toContain("return { ok: true, displayName, serverUrl: url }");
    expect(registry).toContain("serverUrl: probe.serverUrl");
    expect(registry).not.toContain("serverUrl: rawUrl, displayName: probe.displayName");
  });
});
