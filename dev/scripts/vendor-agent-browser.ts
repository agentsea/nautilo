#!/usr/bin/env bun
/**
 * Fetch one checksum-pinned agent-browser release binary for the server's
 * named local or Linux runtime platform. This is deliberately separate from
 * Desktop's Darwin packaging cache: the server image has its own provenance
 * boundary and never receives Electron resources.
 *
 * Usage: bun dev/scripts/vendor-agent-browser.ts <platform-key>
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAndVerifyVendoredBinary,
  VendoredBinaryFetchError,
} from "../../packages/config/src/vendored-binary-fetch.ts";

const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
type PlatformKey = (typeof PLATFORM_KEYS)[number];

type Artifact = Readonly<{
  url: string;
  sha256: string;
  sizeMin: number;
}>;

type Manifest = Readonly<{
  "agent-browser": Readonly<{
    version: string;
    binaryName: "agent-browser";
    artifacts: Readonly<Record<PlatformKey, Artifact>>;
  }>;
}>;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const vendorRoot = join(repoRoot, "packages", "server", "vendor", "agent-browser");

function log(message: string): void {
  process.stdout.write(`[agent-browser:vendor] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[agent-browser:vendor] FATAL ${message}\n`);
  process.exit(1);
}

function platformKey(value: string | undefined): PlatformKey {
  if (value !== undefined && PLATFORM_KEYS.includes(value as PlatformKey)) return value as PlatformKey;
  fail(`usage: bun dev/scripts/vendor-agent-browser.ts <platform-key>\n  keys: ${PLATFORM_KEYS.join(", ")}`);
}

function loadManifest(path: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("agent-browser vendor manifest is unreadable");
  }
  const entry = (parsed as { [key: string]: unknown })["agent-browser"];
  if (entry === null || typeof entry !== "object") fail("agent-browser vendor manifest is malformed");
  const record = entry as { version?: unknown; binaryName?: unknown; artifacts?: unknown };
  if (record.version !== "0.35.2" || record.binaryName !== "agent-browser" || record.artifacts === null || typeof record.artifacts !== "object") {
    fail("agent-browser vendor manifest is malformed");
  }
  for (const key of PLATFORM_KEYS) {
    const artifact = (record.artifacts as { [key: string]: unknown })[key];
    if (artifact === null || typeof artifact !== "object") fail(`agent-browser manifest is missing ${key}`);
    const value = artifact as { url?: unknown; sha256?: unknown; sizeMin?: unknown };
    if (typeof value.url !== "string" || !value.url.startsWith("https://github.com/vercel-labs/agent-browser/releases/download/v0.35.2/")
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.sizeMin !== "number" || !Number.isInteger(value.sizeMin) || value.sizeMin < 10_000_000) {
      fail(`agent-browser manifest artifact ${key} is malformed`);
    }
  }
  return parsed as Manifest;
}

try {
  const target = platformKey(process.argv[2]);
  const manifest = loadManifest(join(vendorRoot, "manifest.json"));
  const artifact = manifest["agent-browser"].artifacts[target];
  const destination = join(vendorRoot, target, manifest["agent-browser"].binaryName);
  mkdirSync(dirname(destination), { recursive: true });
  const result = await fetchAndVerifyVendoredBinary({
    url: artifact.url,
    sha256: artifact.sha256,
    destPath: destination,
    minBytes: artifact.sizeMin,
    log,
  });
  log(`ok platform=${target} version=${manifest["agent-browser"].version}`);
  log(`binary=${result.destPath}`);
  log(`sha256=${result.binarySha256} size=${result.size}`);
} catch (error) {
  if (error instanceof VendoredBinaryFetchError) fail(error.message);
  throw error;
}
