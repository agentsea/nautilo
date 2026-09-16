import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDesktopOfficeCliProvisioned } from "../../src/lib/desktop-officecli-preflight";
import type { SpawnSyncFn } from "../../src/lib/officecli-preflight";

type SpawnCall = {
  command: string;
  args: string[];
  options: { stdio: "inherit"; cwd: string };
};

function makeSpawnStub(status: number, calls: SpawnCall[]): SpawnSyncFn {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status };
  };
}

function writeManifest(repoRoot: string, version = "9.9.9"): void {
  const manifestDir = join(repoRoot, "apps/desktop/vendor");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "tool-runtimes.manifest.json"),
    JSON.stringify({
      officecli: {
        version,
        license: "Apache-2.0",
        source: "https://example.com",
        binaryName: "officecli",
        artifacts: {
          "darwin-arm64": { url: "https://example.com/a", sha256: "a".repeat(64), sizeMin: 10 },
          "darwin-x64": { url: "https://example.com/b", sha256: "b".repeat(64), sizeMin: 10 },
        },
      },
    }),
  );
}

function writeFreshVendor(repoRoot: string, version = "9.9.9"): void {
  const vendorDir = join(repoRoot, "apps/desktop/vendor/officecli");
  mkdirSync(join(vendorDir, "darwin-arm64"), { recursive: true });
  mkdirSync(join(vendorDir, "darwin-x64"), { recursive: true });
  writeFileSync(join(vendorDir, ".version"), version);
  writeFileSync(join(vendorDir, "darwin-arm64", "officecli"), Buffer.alloc(2000, 1));
  writeFileSync(join(vendorDir, "darwin-x64", "officecli"), Buffer.alloc(2000, 1));
}

describe("ensureDesktopOfficeCliProvisioned", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot !== undefined) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("cache hit: returns true and does NOT spawn when both darwin binaries are fresh", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-officecli-preflight-"));
    writeManifest(repoRoot);
    writeFreshVendor(repoRoot);

    const calls: SpawnCall[] = [];
    const result = ensureDesktopOfficeCliProvisioned(repoRoot, {
      spawn: makeSpawnStub(0, calls),
    });

    expect(result).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("spawns apps/desktop vendor script when the .version stamp is stale", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-officecli-preflight-"));
    writeManifest(repoRoot, "9.9.9");
    writeFreshVendor(repoRoot, "1.0.0");

    const calls: SpawnCall[] = [];
    const result = ensureDesktopOfficeCliProvisioned(repoRoot, {
      spawn: makeSpawnStub(0, calls),
    });

    expect(result).toBe(true);
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.command).toBe("bun");
    expect(call.args).toEqual([join(repoRoot, "apps/desktop/scripts/vendor-officecli.ts")]);
    expect(call.options.cwd).toBe(join(repoRoot, "apps/desktop"));
  });

  test("spawns when a darwin binary is missing even though the stamp is fresh", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-officecli-preflight-"));
    writeManifest(repoRoot);
    const vendorDir = join(repoRoot, "apps/desktop/vendor/officecli");
    mkdirSync(join(vendorDir, "darwin-arm64"), { recursive: true });
    writeFileSync(join(vendorDir, ".version"), "9.9.9");
    writeFileSync(join(vendorDir, "darwin-arm64", "officecli"), Buffer.alloc(2000, 1));

    const calls: SpawnCall[] = [];
    const result = ensureDesktopOfficeCliProvisioned(repoRoot, {
      spawn: makeSpawnStub(0, calls),
    });

    expect(result).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("returns false (fail closed) when the vendor script exits non-zero", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-officecli-preflight-"));
    writeManifest(repoRoot);

    const calls: SpawnCall[] = [];
    const result = ensureDesktopOfficeCliProvisioned(repoRoot, {
      spawn: makeSpawnStub(1, calls),
    });

    expect(result).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("returns false when there is no officecli manifest entry", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "desktop-officecli-preflight-"));
    mkdirSync(join(repoRoot, "apps/desktop/vendor"), { recursive: true });
    writeFileSync(join(repoRoot, "apps/desktop/vendor/tool-runtimes.manifest.json"), "{}");

    const calls: SpawnCall[] = [];
    const result = ensureDesktopOfficeCliProvisioned(repoRoot, {
      spawn: makeSpawnStub(0, calls),
    });

    expect(result).toBe(false);
    expect(calls.length).toBe(0);
  });
});
