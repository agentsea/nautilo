#!/usr/bin/env bun
/**
 * Vendor OfficeCLI into the Electron app bundle (M206 Phase 3 / D392 P2).
 *
 * Downloads pinned macOS darwin-arm64 + darwin-x64 binaries into
 * apps/desktop/vendor/officecli/<platform-key>/officecli. electron-builder
 * ships this directory to Contents/Resources/tools-officecli.
 *
 * Pins are sourced from apps/desktop/vendor/tool-runtimes.manifest.json
 * (aligned with packages/server/vendor/officecli/manifest.json). Development
 * must use this desktop vendor output — not packages/server/vendor.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAndVerifyVendoredBinary,
  VendoredBinaryFetchError,
} from "@nautilo/config/vendored-binary-fetch";
import {
  DESKTOP_DARWIN_PLATFORM_KEYS,
  parseToolRuntimesManifest,
  type ToolRuntimeManifestEntry,
  type ToolRuntimePlatformKey,
} from "../electron/tool-runtimes-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const VENDOR_DIR = join(desktopRoot, "vendor", "officecli");
const VERSION_STAMP = join(VENDOR_DIR, ".version");

const manifest = parseToolRuntimesManifest(
  readFileSync(join(desktopRoot, "vendor", "tool-runtimes.manifest.json"), "utf-8"),
);
const MANIFEST: ToolRuntimeManifestEntry = manifest["officecli"]!;
const BINARY_NAME = MANIFEST?.binaryName ?? "officecli";

/** OfficeCLI auto-update sidecars that must never ship in the signed app bundle. */
export const OFFICECLI_UPDATE_SIDECAR_NAMES = [
  "officecli.update",
  "officecli.update.partial",
] as const;

/**
 * Remove OfficeCLI update sidecars from vendored platform directories.
 * Preserves the canonical runtime binary; safe when sidecars are absent.
 */
export function removeOfficeCliUpdateSidecars(
  vendorDir: string,
  platformKeys: readonly string[],
  binaryName: string = "officecli",
): void {
  for (const platformKey of platformKeys) {
    const platformDir = join(vendorDir, platformKey);
    for (const sidecarName of OFFICECLI_UPDATE_SIDECAR_NAMES) {
      if (sidecarName === binaryName) continue;
      const sidecarPath = join(platformDir, sidecarName);
      if (existsSync(sidecarPath)) {
        unlinkSync(sidecarPath);
      }
    }
  }
}

function log(msg: string): void {
  process.stdout.write(`[vendor-officecli] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[vendor-officecli] FATAL ${msg}\n`);
  process.exit(1);
}

function isFresh(): boolean {
  if (!MANIFEST || !existsSync(VERSION_STAMP)) return false;
  try {
    if (readFileSync(VERSION_STAMP, "utf-8").trim() !== MANIFEST.version) return false;
    for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
      const bin = join(VENDOR_DIR, platformKey, BINARY_NAME);
      const minBytes = MANIFEST.artifacts[platformKey]?.sizeMin ?? 1_000_000;
      if (!existsSync(bin) || statSync(bin).size < minBytes) return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function vendorPlatform(platformKey: ToolRuntimePlatformKey): Promise<void> {
  const artifact = MANIFEST?.artifacts?.[platformKey];
  if (!artifact) fail(`manifest is missing officecli ${platformKey} artifact`);

  try {
    await fetchAndVerifyVendoredBinary({
      url: artifact.url,
      sha256: artifact.sha256,
      destPath: join(VENDOR_DIR, platformKey, BINARY_NAME),
      ...(artifact.sizeMin !== undefined ? { minBytes: artifact.sizeMin } : { minBytes: 1_000_000 }),
      log: (msg) => log(`${platformKey}: ${msg}`),
    });
  } catch (err) {
    if (err instanceof VendoredBinaryFetchError) fail(err.message);
    throw err;
  }
}

async function main(): Promise<void> {
  if (!MANIFEST) fail("manifest is missing officecli entry");
  mkdirSync(VENDOR_DIR, { recursive: true });
  removeOfficeCliUpdateSidecars(VENDOR_DIR, DESKTOP_DARWIN_PLATFORM_KEYS, BINARY_NAME);

  if (isFresh()) {
    log(`cache hit (v${MANIFEST.version}) - nothing to do`);
    return;
  }

  for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
    await vendorPlatform(platformKey);
  }

  writeFileSync(
    join(VENDOR_DIR, "LICENSE-officecli.txt"),
    `OfficeCLI v${MANIFEST.version} is distributed under the Apache License 2.0.\n` +
      `Source: ${MANIFEST.source}\n`,
  );
  writeFileSync(VERSION_STAMP, MANIFEST.version);
  log(`done. pinned v${MANIFEST.version}`);
}

if (import.meta.main) {
  main().catch((err) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
}
