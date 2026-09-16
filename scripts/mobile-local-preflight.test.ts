import { describe, expect, test } from "bun:test";

import { instanceRoot, parseInstance, requiredAndroidReversePorts } from "./mobile-local-preflight";

describe("mobile local preflight", () => {
  test("requires an explicit named instance", () => {
    expect(parseInstance(["--instance", "mobile-fixture"])).toBe("mobile-fixture");
    expect(() => parseInstance([])).toThrow("--instance");
  });

  test("resolves default and named instance roots", () => {
    expect(instanceRoot("default", "/tmp/home")).toBe("/tmp/home/.nautilo");
    expect(instanceRoot("mobile-fixture", "/tmp/home")).toBe("/tmp/home/.nautilo-mobile-fixture");
  });

  test("configures Metro, server, and Logto tunnels without duplicates", () => {
    expect(requiredAndroidReversePorts({
      server: { port: 8401 },
      logto: { corePort: 8701 },
    })).toEqual([8081, 8401, 8701]);
    expect(requiredAndroidReversePorts({
      server: { port: 8081 },
      logto: { corePort: 8701 },
    })).toEqual([8081, 8701]);
  });
});
