// M206 Phase 3 / D392 P2 — desktop bundled-runtime path resolver (not wired into relay yet).
//
// Resolves development vendor and packaged extraResources paths using os-arch keys.
// OfficeCLI is fail-closed: no PATH, Homebrew, or server-vendor fallback.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ToolRuntimePlatformKey } from "./tool-runtimes-manifest.ts";

export type DesktopBundledRuntimeName =
  | "agent-browser"
  | "gog"
  | "officecli"
  | "ffmpeg"
  | "ripgrep";

export interface ResolveDesktopRuntimePathInput {
  readonly runtime: DesktopBundledRuntimeName;
  /** Electron `process.resourcesPath` when packaged; null in unpackaged dev. */
  readonly resourcesPath: string | null;
  /** Absolute path to `apps/desktop/vendor` (development tree). */
  readonly devVendorRoot: string;
  /** Host platform key, e.g. darwin-arm64. */
  readonly platformKey: ToolRuntimePlatformKey;
}

export type DesktopRuntimePathSource = "bundled" | "dev-vendor";

export interface ResolveDesktopRuntimePathResult {
  readonly path: string;
  readonly source: DesktopRuntimePathSource;
}

export interface ResolveDesktopRuntimePathOutcome {
  readonly ok: true;
  readonly result: ResolveDesktopRuntimePathResult;
}

export interface ResolveDesktopRuntimePathMissing {
  readonly ok: false;
  readonly runtime: DesktopBundledRuntimeName;
  readonly platformKey: ToolRuntimePlatformKey;
  readonly error: string;
}

export type ResolveDesktopRuntimePathResponse =
  | ResolveDesktopRuntimePathOutcome
  | ResolveDesktopRuntimePathMissing;

type RuntimeLayout = {
  readonly bundledRoot: string;
  readonly vendorDir: string;
  readonly binaryName: string;
  readonly layout: "platform-key" | "arch-only";
};

const RUNTIME_LAYOUTS: Readonly<Record<DesktopBundledRuntimeName, RuntimeLayout>> = {
  "agent-browser": {
    bundledRoot: "tools-agent-browser",
    vendorDir: "agent-browser",
    binaryName: "agent-browser",
    layout: "arch-only",
  },
  gog: {
    bundledRoot: "tools-gog",
    vendorDir: "gog",
    binaryName: "gog",
    layout: "arch-only",
  },
  officecli: {
    bundledRoot: "tools-officecli",
    vendorDir: "officecli",
    binaryName: "officecli",
    layout: "platform-key",
  },
  ffmpeg: {
    bundledRoot: "tools-ffmpeg",
    vendorDir: "ffmpeg",
    binaryName: "bin/ffmpeg",
    layout: "arch-only",
  },
  ripgrep: {
    bundledRoot: "tools-ripgrep",
    vendorDir: "ripgrep",
    binaryName: "rg",
    layout: "platform-key",
  },
};

/** Map Node `process.platform` + `process.arch` to a desktop manifest platform key. */
export function detectDesktopPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ToolRuntimePlatformKey | null {
  if (platform !== "darwin") return null;
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  return null;
}

function archDirForPlatformKey(platformKey: ToolRuntimePlatformKey): string {
  return platformKey === "darwin-arm64" ? "arm64" : "x64";
}

function segmentForLayout(
  layout: RuntimeLayout["layout"],
  platformKey: ToolRuntimePlatformKey,
): string {
  return layout === "platform-key" ? platformKey : archDirForPlatformKey(platformKey);
}

function candidatePaths(input: ResolveDesktopRuntimePathInput): {
  readonly bundled: string | null;
  readonly devVendor: string;
} {
  const layout = RUNTIME_LAYOUTS[input.runtime];
  const segment = segmentForLayout(layout.layout, input.platformKey);
  const bundled =
    input.resourcesPath === null
      ? null
      : join(input.resourcesPath, layout.bundledRoot, segment, layout.binaryName);
  const devVendor = join(
    input.devVendorRoot,
    layout.vendorDir,
    segment,
    layout.binaryName,
  );
  return { bundled, devVendor };
}

/**
 * Resolve a desktop bundled runtime binary path.
 *
 * Packaged apps prefer `Contents/Resources/tools-*`; development falls back to
 * `apps/desktop/vendor/*`. OfficeCLI never probes PATH, Homebrew, or
 * `packages/server/vendor`.
 */
export function resolveDesktopRuntimePath(
  input: ResolveDesktopRuntimePathInput,
): ResolveDesktopRuntimePathResponse {
  const layout = RUNTIME_LAYOUTS[input.runtime];
  const { bundled, devVendor } = candidatePaths(input);

  if (bundled !== null && existsSync(bundled)) {
    return { ok: true, result: { path: bundled, source: "bundled" } };
  }
  if (existsSync(devVendor)) {
    return { ok: true, result: { path: devVendor, source: "dev-vendor" } };
  }

  return {
    ok: false,
    runtime: input.runtime,
    platformKey: input.platformKey,
    error:
      `No ${layout.binaryName} binary for ${input.platformKey}. ` +
      `Expected packaged ${bundled ?? "(no resourcesPath)"} or dev vendor ${devVendor}.`,
  };
}

/** OfficeCLI resolution is fail-closed — returns null when the binary is absent. */
export function resolveDesktopOfficeCliPath(
  input: Omit<ResolveDesktopRuntimePathInput, "runtime">,
): ResolveDesktopRuntimePathResult | null {
  const outcome = resolveDesktopRuntimePath({ ...input, runtime: "officecli" });
  return outcome.ok ? outcome.result : null;
}

/** Ripgrep resolution is product-owned and fail-closed — no ambient PATH fallback. */
export function resolveDesktopRipgrepPath(
  input: Omit<ResolveDesktopRuntimePathInput, "runtime">,
): ResolveDesktopRuntimePathResult | null {
  const outcome = resolveDesktopRuntimePath({ ...input, runtime: "ripgrep" });
  return outcome.ok ? outcome.result : null;
}
