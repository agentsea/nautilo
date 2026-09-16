import ffmpegDistribution from "../scripts/ffmpeg-distribution.json";
/**
 * Managed desktop FFmpeg runtime.
 *
 * Packaged apps resolve only the checksum-pinned binary shipped with Nautilo.
 * `NAUTILO_FFMPEG_BIN` is a developer-only, deliberately unverified escape
 * hatch and is never accepted when Electron reports `app.isPackaged`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codesignTeam, verifyFfmpegFile } from "./ffmpeg-integrity";
import {
  detectDesktopPlatformKey,
  resolveDesktopRuntimePath,
} from "./tool-runtime-resolver.ts";
import {
  parseToolRuntimesManifest,
  type ToolRuntimePlatformKey,
} from "./tool-runtimes-manifest.ts";

const verificationCache = new Map<string, boolean>();
type CachedFfmpeg = Extract<ProbeDesktopFfmpegResult, { ok: true }>;
let cachedFfmpeg: { readonly isPackaged: boolean; readonly result: CachedFfmpeg } | undefined;

function devVendorRoot(): string {
  return join(fileURLToPath(new URL("..", import.meta.url)), "vendor");
}

function expectedSha256(
  platformKey: ToolRuntimePlatformKey,
  input: { readonly isPackaged: boolean; readonly resourcesPath: string | null; readonly devVendorRoot: string },
): string | null {
  try {
    const manifest = parseToolRuntimesManifest(
      readFileSync(
        input.isPackaged
          ? input.resourcesPath
            ? join(input.resourcesPath, "tools-ffmpeg", "manifest.json")
            : ""
          : join(input.devVendorRoot, "tool-runtimes.manifest.json"),
        "utf8",
      ),
    );
    const artifact = manifest["ffmpeg"]?.artifacts[platformKey];
    return artifact?.binarySha256 ?? artifact?.sha256 ?? null;
  } catch {
    return null;
  }
}

export interface ProbeDesktopFfmpegInput {
  readonly resourcesPath?: string | null;
  readonly devVendorRoot?: string;
  readonly platformKey?: ToolRuntimePlatformKey | null;
  /** Exact Electron main-process `app.isPackaged` signal. */
  readonly isPackaged: boolean;
  /** Test seam — defaults to process.env. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Unit seam for path/manifest resolution; production always verifies real files. */
  readonly verifyFile?: typeof verifyFfmpegFile;
}

export type ProbeDesktopFfmpegResult =
  | { readonly ok: true; readonly binaryPath: string; readonly source: "managed" | "dev-override"; readonly unverified: boolean; readonly note?: string }
  | { readonly ok: false; readonly code: "FFMPEG_MISSING" | "FFMPEG_UNAVAILABLE"; readonly error: string };

/**
 * Resolve and verify the managed FFmpeg path once per process. This does not
 * execute FFmpeg; relay health probes execute the returned absolute path.
 */
export async function probeDesktopFfmpeg(
  input: ProbeDesktopFfmpegInput,
): Promise<ProbeDesktopFfmpegResult> {
  const environment = input.environment ?? process.env;
  const isPackaged = input.isPackaged;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath ?? null;
  const vendorRoot = input.devVendorRoot ?? devVendorRoot();
  const platformKey =
    input.platformKey ?? detectDesktopPlatformKey(process.platform, process.arch);

  if (cachedFfmpeg?.isPackaged === isPackaged) return cachedFfmpeg.result;

  if (!platformKey) {
    return {
      ok: false,
      code: "FFMPEG_MISSING",
      error: "Managed FFmpeg is currently bundled for macOS darwin-arm64 and darwin-x64 only.",
    };
  }

  const resolved = resolveDesktopRuntimePath({
    runtime: "ffmpeg",
    resourcesPath,
    devVendorRoot: vendorRoot,
    platformKey,
  });
  if (resolved.ok) {
    const sha256 = expectedSha256(platformKey, {
      isPackaged,
      resourcesPath,
      devVendorRoot: vendorRoot,
    });
    if (!sha256) {
      return {
        ok: false,
        code: "FFMPEG_UNAVAILABLE",
        error: `Managed FFmpeg checksum metadata is missing or unreadable for ${platformKey}.`,
      };
    }
    const teamId = isPackaged && process.platform === "darwin" ? codesignTeam(process.execPath) : null;
    const signing = isPackaged ? (teamId ? { teamId, requireSignature: true } : { allowAdHoc: true, requireSignature: true }) : undefined;
    const verifyFile = input.verifyFile ?? verifyFfmpegFile;
    const verified = await verifyFile(resolved.result.path, sha256, verificationCache, signing);
    if (verified) {
      const arch = platformKey === "darwin-arm64" ? "arm64" : "x64";
      const distributionRoot = isPackaged ? join(resourcesPath, "tools-ffmpeg") : join(vendorRoot, "ffmpeg");
      for (const library of ffmpegDistribution.binaries.filter(file => file.path.startsWith(`${arch}/lib/`))) {
        if (!await verifyFile(join(distributionRoot, library.path), library.sha256, verificationCache, signing)) {
          return { ok: false, code: "FFMPEG_UNAVAILABLE", error: "Managed FFmpeg library failed integrity verification." };
        }
      }
      const result: CachedFfmpeg = {
        ok: true,
        binaryPath: resolved.result.path,
        source: "managed",
        unverified: false,
      };
      cachedFfmpeg = { isPackaged, result };
      return result;
    }
    return { ok: false, code: "FFMPEG_UNAVAILABLE", error: "Managed FFmpeg failed integrity verification." };
  }

  // This escape hatch is intentionally last and never in packaged builds:
  // it exists only for local developers debugging a non-vendored FFmpeg.
  const override = environment["NAUTILO_FFMPEG_BIN"];
  if (!isPackaged && override) {
    const overridePath = resolve(override);
    if (existsSync(overridePath)) {
      return {
        ok: true,
        binaryPath: overridePath,
        source: "dev-override",
        unverified: true,
        note: "Using unverified developer override from NAUTILO_FFMPEG_BIN.",
      };
    }
  }

  return {
    ok: false,
    code: "FFMPEG_MISSING",
    error: isPackaged
      ? `Managed FFmpeg is missing for ${platformKey}; packaged builds do not use PATH or Homebrew.`
      : `Managed FFmpeg is missing for ${platformKey}. Run \`bun run vendor:ffmpeg\` before starting the desktop app.`,
  };
}

export function resetDesktopFfmpegProbeCache(): void {
  cachedFfmpeg = undefined;
  verificationCache.clear();
}
