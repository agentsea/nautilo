#!/usr/bin/env bun
/**
 * Verify the pinned OfficeCLI binary under the server vendor tree.
 *
 * Loads packages/server/vendor/officecli/manifest.json (or OFFICECLI_VENDOR_ROOT),
 * resolves the binary for the current platform, and checks sha256 + optional sizeMin.
 * No network I/O.
 *
 * Usage:
 *   bun dev/scripts/officecli/verify.ts
 *   OFFICECLI_VENDOR_ROOT=/custom/vendor bun dev/scripts/officecli/verify.ts
 *
 * Exit 0 on success; exit 1 with a clear message on provisioning failure.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkOfficeCliProvisioning,
  OfficeCliManifestError,
  OfficeCliProvisioningError,
} from "../../../packages/config/src/officecli/provisioning.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

function log(msg: string): void {
  process.stdout.write(`[officecli:verify] ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`[officecli:verify] FATAL ${msg}\n`);
  process.exit(1);
}

try {
  const result = await checkOfficeCliProvisioning({ repoRoot });
  log(`ok platform=${result.platformKey} version=${result.version}`);
  log(`binary=${result.binaryPath}`);
  log(`sha256=${result.sha256} size=${result.size}`);
  log(`suggested env: OFFICECLI_PATH=${result.binaryPath}`);
} catch (err) {
  if (err instanceof OfficeCliProvisioningError || err instanceof OfficeCliManifestError) {
    fail(err.message);
  }
  throw err;
}
