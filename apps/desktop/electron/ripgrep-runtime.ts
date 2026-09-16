/**
 * D446 — managed Desktop ripgrep runtime.
 *
 * This is the same resolve-manifest-verify pattern used by the other bundled
 * Desktop tools. It never searches PATH and never downloads or compiles at
 * runtime; packaging installs the official pinned release archive first.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendoredBinaryOnce } from "@nautilo/config/vendored-binary";
import {
  detectDesktopPlatformKey,
  resolveDesktopRipgrepPath,
} from "./tool-runtime-resolver.ts";
import {
  parseToolRuntimesManifest,
  type ToolRuntimePlatformKey,
} from "./tool-runtimes-manifest.ts";

const verificationCache = new Map<string, boolean>();
let cached:
  | { readonly key: string; readonly result: Extract<ProbeDesktopRipgrepResult, { ok: true }> }
  | undefined;

function defaultDevVendorRoot(): string {
  return join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
}

export interface ProbeDesktopRipgrepInput {
  readonly resourcesPath?: string | null;
  readonly devVendorRoot?: string;
  readonly platformKey?: ToolRuntimePlatformKey | null;
  readonly isPackaged: boolean;
}

export type ProbeDesktopRipgrepResult =
  | { readonly ok: true; readonly binaryPath: string; readonly version: string }
  | { readonly ok: false; readonly code: "SEARCH_UNAVAILABLE"; readonly error: string };

function manifestFor(input: {
  readonly resourcesPath: string | null;
  readonly devVendorRoot: string;
  readonly isPackaged: boolean;
}) {
  const manifestPath = input.isPackaged
    ? input.resourcesPath
      ? join(input.resourcesPath, "tools-ripgrep", "manifest.json")
      : ""
    : join(input.devVendorRoot, "ripgrep", "manifest.json");
  return parseToolRuntimesManifest(readFileSync(manifestPath, "utf8"));
}

export async function probeDesktopRipgrep(
  input: ProbeDesktopRipgrepInput,
): Promise<ProbeDesktopRipgrepResult> {
  const resourcesPath = input.resourcesPath ?? process.resourcesPath ?? null;
  const devVendorRoot = input.devVendorRoot ?? defaultDevVendorRoot();
  const platformKey =
    input.platformKey ?? detectDesktopPlatformKey(process.platform, process.arch);
  if (platformKey === null) {
    return {
      ok: false,
      code: "SEARCH_UNAVAILABLE",
      error: "Managed ripgrep is currently bundled for macOS darwin-arm64 and darwin-x64 only.",
    };
  }
  const cacheKey = JSON.stringify([
    input.isPackaged,
    resourcesPath,
    devVendorRoot,
    platformKey,
  ]);
  if (cached?.key === cacheKey) return cached.result;

  const resolved = resolveDesktopRipgrepPath({
    resourcesPath,
    devVendorRoot,
    platformKey,
  });
  if (resolved === null) {
    return {
      ok: false,
      code: "SEARCH_UNAVAILABLE",
      error: `No packaged ripgrep binary is installed for ${platformKey}.`,
    };
  }

  try {
    const manifest = manifestFor({ resourcesPath, devVendorRoot, isPackaged: input.isPackaged });
    const runtime = manifest["ripgrep"];
    const artifact = runtime?.artifacts[platformKey];
    if (runtime === undefined || artifact?.binarySha256 === undefined) {
      throw new Error(`ripgrep checksum metadata is missing for ${platformKey}`);
    }
    const verified = await verifyVendoredBinaryOnce({
      binaryPath: resolved.path,
      expectedSha256: artifact.binarySha256,
      // electron-builder signs nested Mach-O files after vendoring. Reuse the
      // repository's established signed-package verification policy there;
      // development bytes remain strict against the extracted-file digest.
      policy: input.isPackaged ? "tolerate-signed" : "strict",
      label: "ripgrep",
      cache: verificationCache,
    });
    if (!verified.ok) throw new Error(verified.error);
    const result = { ok: true as const, binaryPath: resolved.path, version: runtime.version };
    cached = { key: cacheKey, result };
    return result;
  } catch (cause) {
    return {
      ok: false,
      code: "SEARCH_UNAVAILABLE",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function resetDesktopRipgrepProbeCache(): void {
  cached = undefined;
  verificationCache.clear();
}
