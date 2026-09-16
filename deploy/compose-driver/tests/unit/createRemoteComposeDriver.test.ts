import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRemoteComposeDriver } from "../../src/createRemoteComposeDriver.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

describe("createRemoteComposeDriver", () => {
  test("constructs without throwing for valid remote profile", () => {
    const templateDir = mkdtempSync(join(tmpdir(), "remote-compose-tpl-"));
    writeFileSync(join(templateDir, "docker-compose.yml"), "# marker\n");
    const profile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const driver = createRemoteComposeDriver(profile, { templateDir });
    expect(driver).toBeDefined();
  });

  test("passes the explicit operator home to bootstrap custody", () => {
    const templateDir = mkdtempSync(join(tmpdir(), "remote-compose-tpl-home-"));
    const operatorHome = mkdtempSync(join(tmpdir(), "remote-compose-home-"));
    writeFileSync(join(templateDir, "docker-compose.yml"), "# marker\n");
    const profile: ComposeDriverProfile = {
      name: "remote-explicit-home",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    let observedHome: string | undefined;
    const driver = createRemoteComposeDriver(profile, {
      templateDir,
      operatorHome,
      ensureBootstrapToken: (_targetProfile, callbackHome) => {
        observedHome = callbackHome;
        return "factory-token";
      },
    });
    const internal = driver as unknown as {
      deps: { ensureBootstrapToken?: (targetProfile: ComposeDriverProfile, callbackHome: string) => string };
    };

    internal.deps.ensureBootstrapToken?.(profile, join(operatorHome, "wrong-home"));

    expect(observedHome).toBe(operatorHome);
  });

  test("throws without ssh block", () => {
    const templateDir = mkdtempSync(join(tmpdir(), "remote-compose-tpl2-"));
    expect(() =>
      createRemoteComposeDriver(
        {
          name: "bad",
          transport: "remote",
          lifecycle: "compose",
        },
        { templateDir },
      ),
    ).toThrow(/requires transport="remote"/);
  });
});
