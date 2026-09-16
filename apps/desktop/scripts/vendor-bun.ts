#!/usr/bin/env bun
/**
 * Vendor the Bun runtime into the Electron app bundle (D057 2a.2).
 *
 * Downloads the specified Bun version for both macOS architectures
 * (arm64 + x64) into apps/desktop/vendor/bun/<arch>/bun. electron-builder
 * ships this directory via extraResources so the packaged .app contains
 * a self-hosted Bun at Contents/Resources/bun/<arch>/bun.
 *
 * Why: without a bundled runtime, the DMG silently fails for any user
 * who doesn't have Bun on their PATH. "Install Bun first" is not an
 * acceptable user experience for a shipped desktop app. See D057 2a.2
 * for the full rationale.
 *
 * Runs at build time (from apps/desktop/package.json `predist`/`prepack`).
 * Idempotent: if the target binaries already exist and match the pinned
 * version, the binaries are reused. The exact bundled license is always checked.
 *
 * Bun versioning: pinned to match the dev toolchain (`bun --version`
 * at the time this was written was 1.3.11). Kept in sync manually; a
 * future refinement is to read it from package.json#engines.bun or
 * a root-level .bun-version file.
 *
 * Supported platforms in this cut:
 *   - macOS arm64 (Apple Silicon)
 *   - macOS x64   (Intel)
 * Linux + Windows are D057 Phase 2d — this script's ARCHES map is the
 * single extension point.
 *
 * Licensing: Bun is MIT. LICENSE-bun.txt is written alongside the
 * binaries so the DMG's Contents/Resources/bun/ carries attribution.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { vendorPinnedBunLicense } from "./desktop-license-payload";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUN_VERSION = "1.3.11";

/**
 * Map: electron-builder arch identifier -> Bun release asset stem.
 * Keys match what electron-builder sets in process.arch at build and
 * runtime. Values are the artifact names in Bun's GitHub releases.
 */
const ARCHES: Record<string, string> = {
  "arm64": "bun-darwin-aarch64",
  "x64": "bun-darwin-x64",
};

// Repo-layout: __filename = apps/desktop/scripts/vendor-bun.ts
//              desktopRoot  = apps/desktop/
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const VENDOR_DIR = join(desktopRoot, "vendor", "bun");
const VERSION_STAMP = join(VENDOR_DIR, ".version");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(`[vendor-bun] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[vendor-bun] FATAL ${msg}\n`);
  process.exit(1);
}

/** Returns true if target binary exists AND the version stamp matches. */
function isFresh(): boolean {
  if (!existsSync(VERSION_STAMP)) return false;
  let stamped: string;
  try { stamped = readFileSync(VERSION_STAMP, "utf-8").trim(); }
  catch { return false; }
  if (stamped !== BUN_VERSION) return false;
  for (const arch of Object.keys(ARCHES)) {
    const binPath = join(VENDOR_DIR, arch, "bun");
    if (!existsSync(binPath)) return false;
    try {
      const st = statSync(binPath);
      // Bun binaries are sizeable (>20 MB). A tiny file means a prior
      // download failed mid-extract; treat as stale.
      if (st.size < 1_000_000) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  log(`GET ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

/**
 * Unzip via system `unzip`. At build time we're on a Mac with unzip
 * in the base install; this avoids pulling in a zip lib as a dep.
 * Destination dir is created if missing. Returns the list of extracted
 * top-level names.
 */
function unzipTo(zipPath: string, destDir: string): string[] {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("unzip", ["-o", "-q", zipPath, "-d", destDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "(no stderr)";
    fail(`unzip failed (${result.status}): ${stderr}`);
  }
  // Bun's zip lays out as bun-darwin-<arch>/bun — return the top dir.
  const ls = spawnSync("ls", [destDir], { encoding: "utf-8" });
  return (ls.stdout ?? "").trim().split(/\s+/).filter(Boolean);
}

async function vendorArch(arch: string, assetStem: string): Promise<void> {
  const targetDir = join(VENDOR_DIR, arch);
  const targetBin = join(targetDir, "bun");
  const zipName = `${assetStem}.zip`;
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${zipName}`;

  // Download into a tmp dir under VENDOR_DIR; extract; move binary into
  // place; clean up. Putting tmp under VENDOR_DIR keeps the operation
  // entirely under our repo, not in /tmp — makes cleanup deterministic.
  const tmpDir = join(VENDOR_DIR, ".tmp", arch);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const zipPath = join(tmpDir, zipName);
  await downloadTo(url, zipPath);

  unzipTo(zipPath, tmpDir);

  // Bun extracts to <tmpDir>/<assetStem>/bun
  const extractedBin = join(tmpDir, assetStem, "bun");
  if (!existsSync(extractedBin)) {
    fail(`extract did not produce expected binary at ${extractedBin}`);
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // Move via copy + unlink since rename across temp-dir + target-dir
  // could cross boundaries on some filesystems.
  const copied = readFileSync(extractedBin);
  writeFileSync(targetBin, copied);
  chmodSync(targetBin, 0o755);

  rmSync(tmpDir, { recursive: true, force: true });

  log(`vendored ${arch} -> ${targetBin} (${(copied.length / 1_000_000).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(VENDOR_DIR, { recursive: true });
  vendorPinnedBunLicense(BUN_VERSION, VENDOR_DIR);

  if (isFresh()) {
    log(`cache hit (Bun v${BUN_VERSION} for ${Object.keys(ARCHES).join(", ")}) — nothing to do`);
    return;
  }

  log(`vendoring Bun v${BUN_VERSION} into ${VENDOR_DIR}`);

  for (const [arch, stem] of Object.entries(ARCHES)) {
    await vendorArch(arch, stem);
  }

  writeFileSync(VERSION_STAMP, BUN_VERSION);
  log(`done. pinned to v${BUN_VERSION}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
