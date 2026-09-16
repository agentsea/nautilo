#!/usr/bin/env bun
/**
 * Vendor the gog CLI into the Electron app bundle (M195 / D345).
 *
 * Downloads pinned macOS darwin-arm64 + darwin-x64 GoReleaser tarballs into
 * apps/desktop/vendor/gog/<arch>/gog. electron-builder ships this directory
 * to Contents/Resources/tools-gog, and the relay resolves the correct arch
 * at runtime via process.arch.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const VENDOR_DIR = join(desktopRoot, "vendor", "gog");
const VERSION_STAMP = join(VENDOR_DIR, ".version");

const manifest = parseToolRuntimesManifest(
  readFileSync(join(desktopRoot, "vendor", "tool-runtimes.manifest.json"), "utf-8"),
);
const MANIFEST: ToolRuntimeManifestEntry = manifest["gog"]!;

function log(msg: string): void {
  process.stdout.write(`[vendor-gog] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[vendor-gog] FATAL ${msg}\n`);
  process.exit(1);
}

function vendorDirForPlatformKey(platformKey: ToolRuntimePlatformKey): string {
  return platformKey === "darwin-arm64" ? "arm64" : "x64";
}

function isFresh(): boolean {
  if (!MANIFEST || !existsSync(VERSION_STAMP)) return false;
  try {
    if (readFileSync(VERSION_STAMP, "utf-8").trim() !== MANIFEST.version) return false;
    for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
      const bin = join(VENDOR_DIR, vendorDirForPlatformKey(platformKey), "gog");
      if (!existsSync(bin) || statSync(bin).size < 1_000_000) return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function vendorPlatform(platformKey: ToolRuntimePlatformKey): Promise<void> {
  const artifact = MANIFEST?.artifacts?.[platformKey];
  if (!artifact) fail(`manifest is missing gog ${platformKey} artifact`);

  const archDir = vendorDirForPlatformKey(platformKey);
  try {
    await fetchAndVerifyVendoredBinary({
      url: artifact.url,
      sha256: artifact.sha256,
      destPath: join(VENDOR_DIR, archDir, "gog"),
      archive: { format: "tar.gz", member: artifact.member ?? "gog" },
      minBytes: 1_000_000,
      log: (msg) => log(`${platformKey}: ${msg}`),
    });
  } catch (err) {
    if (err instanceof VendoredBinaryFetchError) fail(err.message);
    throw err;
  }
}

async function main(): Promise<void> {
  if (!MANIFEST) fail("manifest is missing gog entry");
  mkdirSync(VENDOR_DIR, { recursive: true });

  if (isFresh()) {
    log(`cache hit (v${MANIFEST.version}) - nothing to do`);
    return;
  }

  for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
    await vendorPlatform(platformKey);
  }

  writeFileSync(
    join(VENDOR_DIR, "LICENSE-gog.txt"),
    `gogcli v${MANIFEST.version} is distributed under the MIT License.\n` +
      `Source: ${MANIFEST.source}\n`,
  );
  writeFileSync(VERSION_STAMP, MANIFEST.version);
  log(`done. pinned v${MANIFEST.version}`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
