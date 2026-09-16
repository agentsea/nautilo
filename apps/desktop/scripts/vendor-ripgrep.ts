#!/usr/bin/env bun
/**
 * Vendor official checksum-pinned ripgrep release archives for the universal
 * macOS app. This extends Nautilo's existing Desktop runtime supply chain; it
 * never invokes Cargo, Homebrew, npm, or an ambient `rg`.
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
const vendorDir = join(desktopRoot, "vendor", "ripgrep");
const versionStamp = join(vendorDir, ".version");
const packagedManifest = join(vendorDir, "manifest.json");
const licensePath = join(vendorDir, "LICENSE-ripgrep.txt");
const provenancePath = join(vendorDir, "PROVENANCE.md");

const manifest = parseToolRuntimesManifest(
  readFileSync(join(desktopRoot, "vendor", "tool-runtimes.manifest.json"), "utf8"),
);
const ripgrep: ToolRuntimeManifestEntry = manifest["ripgrep"]!;

function log(message: string): void {
  process.stdout.write(`[vendor-ripgrep] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[vendor-ripgrep] FATAL ${message}\n`);
  process.exit(1);
}

function binaryPath(platformKey: ToolRuntimePlatformKey): string {
  return join(vendorDir, platformKey, ripgrep.binaryName ?? "rg");
}

function isFresh(): boolean {
  if (
    !ripgrep ||
    !existsSync(versionStamp) ||
    !existsSync(packagedManifest) ||
    !existsSync(licensePath) ||
    !existsSync(provenancePath)
  ) {
    return false;
  }
  try {
    if (readFileSync(versionStamp, "utf8").trim() !== ripgrep.version) return false;
    const packaged = parseToolRuntimesManifest(readFileSync(packagedManifest, "utf8"))["ripgrep"];
    if (!packaged || packaged.version !== ripgrep.version) return false;
    for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
      const artifact = ripgrep.artifacts[platformKey];
      if (!artifact || packaged.artifacts[platformKey]?.sha256 !== artifact.sha256) return false;
      if (packaged.artifacts[platformKey]?.binarySha256 !== artifact.binarySha256) return false;
      if (!existsSync(binaryPath(platformKey))) return false;
      if (artifact.sizeMin !== undefined && statSync(binaryPath(platformKey)).size < artifact.sizeMin) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function vendorPlatform(platformKey: ToolRuntimePlatformKey): Promise<void> {
  const artifact = ripgrep.artifacts[platformKey];
  if (!artifact) fail(`manifest is missing ripgrep ${platformKey} artifact`);
  await fetchAndVerifyVendoredBinary({
    url: artifact.url,
    sha256: artifact.sha256,
    ...(artifact.binarySha256 !== undefined
      ? { binarySha256: artifact.binarySha256 }
      : {}),
    destPath: binaryPath(platformKey),
    archive: { format: "tar.gz", member: artifact.member ?? "rg" },
    ...(artifact.sizeMin !== undefined ? { minBytes: artifact.sizeMin } : {}),
    log: (message) => log(`${platformKey}: ${message}`),
  });
}

async function main(): Promise<void> {
  if (!ripgrep) fail("manifest is missing ripgrep entry");
  mkdirSync(vendorDir, { recursive: true });
  if (isFresh()) {
    log(`cache hit (${ripgrep.version}) - nothing to do`);
    return;
  }

  for (const platformKey of DESKTOP_DARWIN_PLATFORM_KEYS) {
    await vendorPlatform(platformKey);
  }

  const licenseUrl = `https://raw.githubusercontent.com/BurntSushi/ripgrep/${ripgrep.version}/LICENSE-MIT`;
  const licenseResponse = await fetch(licenseUrl);
  if (!licenseResponse.ok) fail(`could not fetch pinned upstream license (${licenseResponse.status})`);
  writeFileSync(licensePath, await licenseResponse.text());
  writeFileSync(
    provenancePath,
    `ripgrep ${ripgrep.version}\nSource: ${ripgrep.source}\nRelease: ${ripgrep.source}/releases/tag/${ripgrep.version}\nLicense: MIT OR Unlicense\n`,
  );
  writeFileSync(packagedManifest, `${JSON.stringify({ ripgrep }, null, 2)}\n`);
  writeFileSync(versionStamp, `${ripgrep.version}\n`);
  log(`done. pinned ${ripgrep.version}`);
}

main().catch((error) => {
  if (error instanceof VendoredBinaryFetchError) fail(error.message);
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
