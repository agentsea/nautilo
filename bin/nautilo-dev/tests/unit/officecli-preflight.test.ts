import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOfficeCliPlatformKey, loadOfficeCliManifest } from "@nautilo/config/officecli";
import { NAUTILO_REPO_ROOT } from "../../src/lib/compose-infra";
import {
  ensureOfficeCliProvisioned,
  type SpawnSyncFn,
} from "../../src/lib/officecli-preflight";

const hostKey = detectOfficeCliPlatformKey()!;

type SpawnCall = {
  command: string;
  args: string[];
  options: { stdio: "inherit"; cwd: string };
};

const originalVendorRoot = process.env["OFFICECLI_VENDOR_ROOT"];
const repoRoot = "/repo";

afterEach(() => {
  if (originalVendorRoot === undefined) {
    delete process.env["OFFICECLI_VENDOR_ROOT"];
  } else {
    process.env["OFFICECLI_VENDOR_ROOT"] = originalVendorRoot;
  }
});

function makeVendorRoot(): string {
  return mkdtempSync(join(tmpdir(), "officecli-preflight-"));
}

function writeManifest(vendorRoot: string): void {
  writeFileSync(
    join(vendorRoot, "manifest.json"),
    JSON.stringify({
      officecli: {
        version: "9.9.9",
        source: "https://example.com",
        license: "Apache-2.0",
        binaryName: "officecli",
        artifacts: {
          [hostKey]: {
            sha256: "a".repeat(64),
            sizeMin: 10,
          },
        },
      },
    }),
  );
}

function writeBinary(vendorRoot: string): void {
  const dir = join(vendorRoot, hostKey);
  mkdirSync(dir, { recursive: true });
  const binaryPath = join(dir, "officecli");
  writeFileSync(binaryPath, Buffer.alloc(2000, 1));
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
}

function makeSpawnStub(status: number, calls: SpawnCall[]): SpawnSyncFn {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status };
  };
}

describe("ensureOfficeCliProvisioned", () => {
  test("repository cache stamp matches the pinned server manifest", () => {
    const vendorRoot = join(NAUTILO_REPO_ROOT, "packages/server/vendor/officecli");
    const manifest = loadOfficeCliManifest(join(vendorRoot, "manifest.json"));

    expect(readFileSync(join(vendorRoot, ".version"), "utf8").trim()).toBe(
      manifest.officecli.version,
    );
  });

  test("cache hit: returns true and does NOT spawn when .version matches and binary is big enough", () => {
    const vendorRoot = makeVendorRoot();
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;
    writeManifest(vendorRoot);
    writeFileSync(join(vendorRoot, ".version"), "9.9.9");
    writeBinary(vendorRoot);

    const calls: SpawnCall[] = [];
    const result = ensureOfficeCliProvisioned(repoRoot, { spawn: makeSpawnStub(0, calls) });

    expect(result).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("spawns the vendor script when the .version stamp is missing/stale", () => {
    const vendorRoot = makeVendorRoot();
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;
    writeManifest(vendorRoot);
    writeFileSync(join(vendorRoot, ".version"), "1.0.0");
    writeBinary(vendorRoot);

    const calls: SpawnCall[] = [];
    const result = ensureOfficeCliProvisioned(repoRoot, { spawn: makeSpawnStub(0, calls) });

    expect(result).toBe(true);
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.command).toBe("bun");
    expect(call.args).toEqual([
      join(repoRoot, "dev/scripts/vendor-officecli.ts"),
      hostKey,
    ]);
  });

  test("spawns when the binary is missing even though the stamp is fresh", () => {
    const vendorRoot = makeVendorRoot();
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;
    writeManifest(vendorRoot);
    writeFileSync(join(vendorRoot, ".version"), "9.9.9");

    const calls: SpawnCall[] = [];
    const result = ensureOfficeCliProvisioned(repoRoot, { spawn: makeSpawnStub(0, calls) });

    expect(result).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("returns false (non-fatal) when the vendor script exits non-zero", () => {
    const vendorRoot = makeVendorRoot();
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;
    writeManifest(vendorRoot);
    writeBinary(vendorRoot);

    const calls: SpawnCall[] = [];
    const result = ensureOfficeCliProvisioned(repoRoot, { spawn: makeSpawnStub(1, calls) });

    expect(result).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("returns false when there is no manifest", () => {
    const vendorRoot = makeVendorRoot();
    process.env["OFFICECLI_VENDOR_ROOT"] = vendorRoot;

    const calls: SpawnCall[] = [];
    const result = ensureOfficeCliProvisioned(repoRoot, { spawn: makeSpawnStub(0, calls) });

    expect(result).toBe(false);
    expect(calls.length).toBe(0);
  });
});
