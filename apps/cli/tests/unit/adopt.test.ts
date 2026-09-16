import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComposeDriver } from "@nautilo/compose-driver";

import { adoptModule } from "../../src/commands/adopt.ts";
import { bootstrapLegacyModule } from "../../src/commands/bootstrap.ts";
import {
  setComposeDriverFactoryForTests,
} from "../../src/lib/compose-driver-factory.ts";
import { setCliProfileFlagOverride } from "../../src/lib/profile-aware-server.ts";

describe("adopt CLI command", () => {
  let home: string;
  let previousHome: string | undefined;
  const calls: unknown[][] = [];

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "nautilo-adopt-cli-"));
    process.env["HOME"] = home;
    process.exitCode = 0;
    setCliProfileFlagOverride(undefined);
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profiles, "legacy.toml"),
      `name = "legacy"
transport = "remote"
lifecycle = "compose"
from_source = true
base_url = "https://nautilo.example"
[ssh]
host = "203.0.113.8"
user = "root"
`,
      { mode: 0o600 },
    );
    setComposeDriverFactoryForTests(
      () =>
        ({
          adopt: async (...args: unknown[]) => {
            calls.push(args);
          },
          bootstrapLegacy: async (...args: unknown[]) => {
            calls.push(args);
          },
        }) as unknown as ComposeDriver,
    );
  });

  afterEach(() => {
    setComposeDriverFactoryForTests(undefined);
    setCliProfileFlagOverride(undefined);
    if (previousHome !== undefined) process.env["HOME"] = previousHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    calls.length = 0;
    process.exitCode = undefined;
  });

  test("defaults to a read-only inspection", async () => {
    await (adoptModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ dryRun: true, confirm: false });
    expect(process.exitCode).toBe(0);
  });

  test("--confirm opts into the manifest write after validation", async () => {
    await (adoptModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
      confirm: true,
      bundle: "/path/to/bundle",
    });

    expect(calls[0]![1]).toEqual({ dryRun: false, confirm: true, bundlePath: "/path/to/bundle" });
  });

  test("--confirm without --bundle is forwarded (driver enforces the verified-bundle requirement)", async () => {
    await (adoptModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
      confirm: true,
    });

    expect(calls[0]![1]).toEqual({ dryRun: false, confirm: true });
  });

  test("--dry-run is mutation-free and ignores --bundle", async () => {
    await (adoptModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
      "dry-run": true,
      bundle: "/path/to/bundle",
    });

    expect(calls[0]![1]).toEqual({ dryRun: true, confirm: false });
  });

  test("bootstrap legacy defaults to its read-only plan", async () => {
    await (bootstrapLegacyModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
    });

    expect(calls[0]![1]).toEqual({
      plan: true,
      confirmAdoption: false,
      confirmDeploy: false,
    });
  });

  test("bootstrap legacy forwards both explicit confirmations and bundle", async () => {
    await (bootstrapLegacyModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: "nautilo",
      profile: "legacy",
      "confirm-adoption": true,
      "confirm-deploy": true,
      bundle: "/path/to/verified-bundle",
      image: "registry.example/nautilo/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(calls[0]![1]).toEqual({
      plan: false,
      confirmAdoption: true,
      confirmDeploy: true,
      bundlePath: "/path/to/verified-bundle",
      imageRef: "registry.example/nautilo/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});
