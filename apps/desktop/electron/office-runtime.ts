/**
 * M206 Phase 3 — desktop bundled OfficeCLI probe + vendored-binary verification.
 *
 * Fail-closed: no PATH, Homebrew, or server-vendor fallback. Advertise `canRunOffice`
 * only after resolve + verify succeed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendoredBinaryOnce } from "@nautilo/config/vendored-binary";
import {
  detectDesktopPlatformKey,
  resolveDesktopOfficeCliPath,
} from "./tool-runtime-resolver.ts";
import {
  parseToolRuntimesManifest,
  type ToolRuntimePlatformKey,
} from "./tool-runtimes-manifest.ts";

const verificationCache = new Map<string, boolean>();

let cachedOfficeCliPath: string | null | undefined;
let cachedCanRunOffice = false;

function devVendorRoot(): string {
  return join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
}

function manifestPath(): string {
  return join(devVendorRoot(), "tool-runtimes.manifest.json");
}

function expectedSha256(platformKey: ToolRuntimePlatformKey): string | null {
  try {
    const manifest = parseToolRuntimesManifest(readFileSync(manifestPath(), "utf8"));
    const artifact = manifest["officecli"]?.artifacts[platformKey];
    return artifact?.sha256 ?? null;
  } catch {
    return null;
  }
}

export interface ProbeDesktopOfficeCliInput {
  resourcesPath?: string | null;
  /** Test hook — override dev vendor root (defaults to apps/desktop/vendor). */
  devVendorRoot?: string;
  platformKey?: ToolRuntimePlatformKey | null;
}

export interface ProbeDesktopOfficeCliResult {
  canRunOffice: boolean;
  binaryPath: string | null;
  error?: string | undefined;
}

/**
 * Resolve packaged/dev OfficeCLI, verify sha policy, cache runnable path.
 * Safe to call at relay boot and from unit tests with injected layout roots.
 */
export async function probeDesktopOfficeCli(
  input: ProbeDesktopOfficeCliInput = {},
): Promise<ProbeDesktopOfficeCliResult> {
  const platformKey =
    input.platformKey ?? detectDesktopPlatformKey(process.platform, process.arch);
  if (!platformKey) {
    cachedOfficeCliPath = null;
    cachedCanRunOffice = false;
    return {
      canRunOffice: false,
      binaryPath: null,
      error: "OfficeCLI bundling is macOS-only in v1",
    };
  }

  const resolved = resolveDesktopOfficeCliPath({
    resourcesPath: input.resourcesPath ?? process.resourcesPath ?? null,
    devVendorRoot: input.devVendorRoot ?? devVendorRoot(),
    platformKey,
  });
  if (!resolved) {
    cachedOfficeCliPath = null;
    cachedCanRunOffice = false;
    return {
      canRunOffice: false,
      binaryPath: null,
      error: `No desktop OfficeCLI binary for ${platformKey}`,
    };
  }

  const verify = await verifyVendoredBinaryOnce({
    binaryPath: resolved.path,
    expectedSha256: expectedSha256(platformKey),
    policy: "tolerate-signed",
    label: "OfficeCLI",
    cache: verificationCache,
  });
  if (!verify.ok) {
    cachedOfficeCliPath = null;
    cachedCanRunOffice = false;
    return {
      canRunOffice: false,
      binaryPath: null,
      error: verify.error,
    };
  }

  cachedOfficeCliPath = resolved.path;
  cachedCanRunOffice = true;
  return { canRunOffice: true, binaryPath: resolved.path };
}

export function getCachedDesktopOfficeCliPath(): string | null {
  return cachedOfficeCliPath ?? null;
}

export function getCachedCanRunOffice(): boolean {
  return cachedCanRunOffice;
}

/** Test hook — reset cached probe state. */
export function resetDesktopOfficeCliProbeCache(): void {
  cachedOfficeCliPath = undefined;
  cachedCanRunOffice = false;
  verificationCache.clear();
}

export async function officeRuntimeCapabilities(
  input: ProbeDesktopOfficeCliInput = {},
): Promise<{ canRunOffice?: true }> {
  const probe = await probeDesktopOfficeCli(input);
  return probe.canRunOffice ? { canRunOffice: true } : {};
}
