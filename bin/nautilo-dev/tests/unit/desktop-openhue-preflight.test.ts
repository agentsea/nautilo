import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDesktopOpenHueProvisioned } from "../../src/lib/desktop-openhue-preflight";
import type { SpawnSyncFn } from "../../src/lib/officecli-preflight";

type SpawnCall = {
  command: string;
  args: string[];
  options: { stdio: "inherit"; cwd: string };
};

function writeManifest(repoRoot: string, version = "0.24"): void {
  const vendorRoot = join(repoRoot, "apps/desktop/vendor");
  mkdirSync(vendorRoot, { recursive: true });
  writeFileSync(
    join(vendorRoot, "tool-runtimes.manifest.json"),
    JSON.stringify({ openhue: { version } }),
  );
}

function writeFreshVendor(repoRoot: string, version = "0.24"): void {
  const vendorDir = join(repoRoot, "apps/desktop/vendor/openhue");
  mkdirSync(vendorDir, { recursive: true });
  writeFileSync(join(vendorDir, ".version"), version);
  const binary = join(vendorDir, "openhue");
  writeFileSync(binary, "#!/bin/sh\n");
  chmodSync(binary, 0o755);
}

function successfulVendorSpawn(repoRoot: string, calls: SpawnCall[]): SpawnSyncFn {
  return (command, args, options) => {
    calls.push({ command, args, options });
    writeFreshVendor(repoRoot);
    return { status: 0 };
  };
}

describe("ensureDesktopOpenHueProvisioned", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot !== undefined) rmSync(repoRoot, { recursive: true, force: true });
  });

  test("cache hit: returns true and does not spawn for a version-stamped executable", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    writeManifest(repoRoot);
    writeFreshVendor(repoRoot);
    const calls: SpawnCall[] = [];

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: successfulVendorSpawn(repoRoot, calls) })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("provisions the desktop vendor script when the stamp is stale", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    writeManifest(repoRoot);
    writeFreshVendor(repoRoot, "0.23");
    const calls: SpawnCall[] = [];

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: successfulVendorSpawn(repoRoot, calls) })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "bun",
      args: [join(repoRoot, "apps/desktop/scripts/vendor-openhue.ts")],
      options: { stdio: "inherit", cwd: join(repoRoot, "apps/desktop") },
    });
  });

  test("provisions when the binary is missing or not executable", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    writeManifest(repoRoot);
    const vendorDir = join(repoRoot, "apps/desktop/vendor/openhue");
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, ".version"), "0.24");
    writeFileSync(join(vendorDir, "openhue"), "not executable");
    const calls: SpawnCall[] = [];

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: successfulVendorSpawn(repoRoot, calls) })).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("fails closed when provisioning exits non-zero", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    writeManifest(repoRoot);
    const calls: SpawnCall[] = [];
    const failingSpawn: SpawnSyncFn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 1 };
    };

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: failingSpawn })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("fails closed when a successful vendor command produces no executable", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    writeManifest(repoRoot);
    const calls: SpawnCall[] = [];
    const incompleteSpawn: SpawnSyncFn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    };

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: incompleteSpawn })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("fails closed without a valid manifest entry", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-openhue-preflight-"));
    const vendorRoot = join(repoRoot, "apps/desktop/vendor");
    mkdirSync(vendorRoot, { recursive: true });
    writeFileSync(join(vendorRoot, "tool-runtimes.manifest.json"), "{}");
    const calls: SpawnCall[] = [];

    expect(ensureDesktopOpenHueProvisioned(repoRoot, { spawn: successfulVendorSpawn(repoRoot, calls) })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
