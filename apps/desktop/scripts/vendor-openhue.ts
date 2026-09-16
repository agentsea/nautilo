#!/usr/bin/env bun
/**
 * Vendor the universal OpenHue CLI into the Electron app bundle (Stack 173).
 *
 * Downloads the pinned Darwin universal tarball to
 * apps/desktop/vendor/openhue/openhue. electron-builder ships this directory
 * to Contents/Resources/tools, where the relay resolves `tools/openhue`.
 *
 * The artifact is universal, so only one macOS manifest entry is required.
 * It is downloaded only by explicit packaging scripts, never at app runtime.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAndVerifyVendoredBinary,
  VendoredBinaryFetchError,
} from "@nautilo/config/vendored-binary-fetch";
import {
  parseToolRuntimesManifest,
  type ToolRuntimeManifestEntry,
} from "../electron/tool-runtimes-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const VENDOR_DIR = join(desktopRoot, "vendor", "openhue");
const VERSION_STAMP = join(VENDOR_DIR, ".version");
const TARGET_BIN = join(VENDOR_DIR, "openhue");

const manifest = parseToolRuntimesManifest(
  readFileSync(join(desktopRoot, "vendor", "tool-runtimes.manifest.json"), "utf-8"),
);
const MANIFEST: ToolRuntimeManifestEntry = manifest["openhue"]!;
const ARTIFACT = MANIFEST?.artifacts["darwin-arm64"];

function log(msg: string): void {
  process.stdout.write(`[vendor-openhue] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[vendor-openhue] FATAL ${msg}\n`);
  process.exit(1);
}

function isFresh(): boolean {
  if (!MANIFEST || !ARTIFACT || !existsSync(VERSION_STAMP) || !existsSync(TARGET_BIN)) {
    return false;
  }
  try {
    return (
      readFileSync(VERSION_STAMP, "utf-8").trim() === MANIFEST.version &&
      statSync(TARGET_BIN).size >= (ARTIFACT.sizeMin ?? 1_000_000)
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!MANIFEST) fail("manifest is missing openhue entry");
  if (!ARTIFACT) fail("manifest is missing openhue darwin universal artifact");
  mkdirSync(VENDOR_DIR, { recursive: true });

  if (isFresh()) {
    log(`cache hit (v${MANIFEST.version}) — nothing to do`);
    return;
  }

  try {
    await fetchAndVerifyVendoredBinary({
      url: ARTIFACT.url,
      sha256: ARTIFACT.sha256,
      destPath: TARGET_BIN,
      archive: { format: "tar.gz", member: ARTIFACT.member ?? "openhue" },
      minBytes: ARTIFACT.sizeMin ?? 1_000_000,
      log,
    });
  } catch (err) {
    if (err instanceof VendoredBinaryFetchError) fail(err.message);
    throw err;
  }

  writeFileSync(
    join(VENDOR_DIR, "LICENSE-openhue.txt"),
    `OpenHue v${MANIFEST.version} is distributed under the Apache License 2.0.\n` +
      `Source: ${MANIFEST.source}\n`,
  );
  writeFileSync(VERSION_STAMP, MANIFEST.version);
  log(`done. pinned v${MANIFEST.version}`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
