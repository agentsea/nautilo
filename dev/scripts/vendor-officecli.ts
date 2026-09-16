#!/usr/bin/env bun
/**
 * Download and install a pinned OfficeCLI binary for a given platform key.
 *
 * Reads packages/server/vendor/officecli/manifest.json (or OFFICECLI_VENDOR_ROOT),
 * fetches the upstream artifact URL, verifies sha256 (+ optional sizeMin), and
 * writes the binary to:
 *   `<vendorRoot>/<platformKey>/<binaryName>`
 *
 * Fetch-at-build model: operators and CI run this on demand; only manifest +
 * optional pre-vendored darwin-arm64 are committed.
 *
 * Usage:
 *   bun dev/scripts/vendor-officecli.ts <platform-key>
 *   bun dev/scripts/vendor-officecli.ts linux-x64
 *
 * Exit 0 on success; exit 1 with a clear message on failure.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchAndVerifyVendoredBinary,
  VendoredBinaryFetchError,
} from "../../packages/config/src/vendored-binary-fetch.ts";
import {
  loadOfficeCliManifest,
  OfficeCliManifestError,
  OfficeCliProvisioningError,
  resolveOfficeCliVendorRoot,
  resolveVendoredOfficeCliPath,
  type OfficeCliPlatformKey,
} from "../../packages/config/src/officecli/provisioning.ts";

const PLATFORM_KEYS: readonly OfficeCliPlatformKey[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-x64",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

function log(msg: string): void {
  process.stdout.write(`[officecli:vendor] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[officecli:vendor] FATAL ${msg}\n`);
  process.exit(1);
}

function parsePlatformKey(raw: string | undefined): OfficeCliPlatformKey {
  if (raw === undefined || raw.length === 0) {
    fail(`usage: bun dev/scripts/vendor-officecli.ts <platform-key>\n  keys: ${PLATFORM_KEYS.join(", ")}`);
  }
  if (!PLATFORM_KEYS.includes(raw as OfficeCliPlatformKey)) {
    fail(`unknown platform key ${JSON.stringify(raw)}; expected one of: ${PLATFORM_KEYS.join(", ")}`);
  }
  return raw as OfficeCliPlatformKey;
}

try {
  const platformKey = parsePlatformKey(process.argv[2]);
  const vendorRoot = resolveOfficeCliVendorRoot({ repoRoot });
  const manifestPath = resolve(vendorRoot, "manifest.json");
  const manifest = loadOfficeCliManifest(manifestPath);
  const artifact = manifest.officecli.artifacts[platformKey];
  if (artifact === undefined) {
    fail(`manifest has no artifact for platform ${platformKey}`);
  }
  const url = artifact.url;
  if (url === undefined || url.length === 0) {
    fail(`manifest artifact ${platformKey} has no url — cannot download`);
  }

  const binaryPath = resolveVendoredOfficeCliPath({ vendorRoot, platformKey, manifest });

  // Shared D392 fetch+verify+install path (raw binary, no archive).
  const result = await fetchAndVerifyVendoredBinary({
    url,
    sha256: artifact.sha256,
    destPath: binaryPath,
    ...(artifact.sizeMin !== undefined ? { minBytes: artifact.sizeMin } : {}),
    executable: !platformKey.startsWith("win-"),
    log,
  });

  log(`ok platform=${platformKey} version=${manifest.officecli.version}`);
  log(`binary=${result.destPath}`);
  log(`sha256=${result.sha256} size=${result.size}`);
  log(`suggested env: OFFICECLI_PATH=${result.destPath}`);
} catch (err) {
  if (
    err instanceof VendoredBinaryFetchError ||
    err instanceof OfficeCliProvisioningError ||
    err instanceof OfficeCliManifestError
  ) {
    fail(err.message);
  }
  throw err;
}
