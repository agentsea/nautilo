#!/usr/bin/env bun
/**
 * Vendor the agent-browser CLI into the Electron app bundle (M195 / D345).
 *
 * Downloads pinned macOS darwin-arm64 + darwin-x64 binaries into
 * apps/desktop/vendor/agent-browser/<arch>/agent-browser. electron-builder
 * ships this directory to Contents/Resources/tools-agent-browser, and the
 * relay resolves the correct arch at runtime via process.arch.
 *
 * agent-browser is Apache-2.0. It attaches to the embedded Electron webview
 * over CDP; this script does not download or bundle Chrome.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const VENDOR_DIR = join(desktopRoot, "vendor", "agent-browser");
const VERSION_STAMP = join(VENDOR_DIR, ".version");

const manifest = parseToolRuntimesManifest(
  readFileSync(join(desktopRoot, "vendor", "tool-runtimes.manifest.json"), "utf-8"),
);
const MANIFEST: ToolRuntimeManifestEntry = manifest["agent-browser"]!;

function log(msg: string): void {
  process.stdout.write(`[vendor-agent-browser] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[vendor-agent-browser] FATAL ${msg}\n`);
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
      const bin = join(
        VENDOR_DIR,
        vendorDirForPlatformKey(platformKey),
        "agent-browser",
      );
      if (!existsSync(bin) || statSync(bin).size < 1_000_000) return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function vendorPlatform(platformKey: ToolRuntimePlatformKey): Promise<void> {
  const artifact = MANIFEST?.artifacts?.[platformKey];
  if (!artifact || artifact.url === null || artifact.sha256 === null) {
    fail(`manifest is missing agent-browser ${platformKey} artifact`);
  }

  const archDir = vendorDirForPlatformKey(platformKey);
  try {
    const destPath = join(VENDOR_DIR, archDir, "agent-browser");
    await fetchAndVerifyVendoredBinary({
      url: artifact.url,
      sha256: artifact.sha256,
      destPath,
      minBytes: 1_000_000,
      log: (msg) => log(`${platformKey}: ${msg}`),
    });
    // Current upstream macOS artifacts are linker/adhoc signed. A fresh
    // downloaded v0.35.x artifact passes its pinned checksum but macOS can
    // still terminate it before main() until the local code directory is
    // regenerated. Electron packaging later applies the real Developer ID;
    // this local ad-hoc signature only makes source/dev execution reliable.
    if (process.platform === "darwin") {
      const signed = spawnSync("codesign", ["--force", "--sign", "-", destPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (signed.status !== 0) {
        fail(`codesign failed for ${platformKey} (status ${signed.status ?? "unknown"})`);
      }
    }
  } catch (err) {
    if (err instanceof VendoredBinaryFetchError) fail(err.message);
    throw err;
  }
}

async function main(): Promise<void> {
  if (!MANIFEST) fail("manifest is missing agent-browser entry");
  mkdirSync(VENDOR_DIR, { recursive: true });

  if (isFresh()) {
    log(`cache hit (v${MANIFEST.version}) - nothing to do`);
    return;
  }

  for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
    await vendorPlatform(platformKey);
  }

  writeFileSync(
    join(VENDOR_DIR, "LICENSE-agent-browser.txt"),
    `agent-browser v${MANIFEST.version} is distributed under the Apache License 2.0.\n` +
      `Source: ${MANIFEST.source}\n`,
  );
  writeFileSync(VERSION_STAMP, MANIFEST.version);
  log(`done. pinned v${MANIFEST.version}`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
