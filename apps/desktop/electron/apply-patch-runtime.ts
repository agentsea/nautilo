/**
 * D448 1.2 — desktop apply-patch runtime boundary.
 *
 * Only Darwin desktop relay has a v1 runtime. This resolver never consults
 * PATH, Cargo, a Codex installation, or a network location. The package/dev
 * command builds checked-in Rust source before Electron starts and writes the
 * exact output hash into its local runtime manifest.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  getApplyPatchDesktopManifestEntry,
  parseToolRuntimesManifest,
  type ApplyPatchDesktopManifestEntry,
  type ToolRuntimePlatformKey,
} from "./tool-runtimes-manifest.ts";
import { detectDesktopPlatformKey } from "./tool-runtime-resolver.ts";

export type ApplyPatchDesktopRuntimeOrigin = "source" | "packaged";
export type ApplyPatchDesktopRuntimeUnavailableReason =
  | "PLATFORM_UNSUPPORTED"
  | "PACKAGING_STATE_UNAVAILABLE"
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "BUILD_OUTPUT_MISSING"
  | "BINARY_MISSING"
  | "BINARY_NOT_EXECUTABLE"
  | "BINARY_TOO_SMALL"
  | "BINARY_WRONG_ARCHITECTURE"
  | "CHECKSUM_MISMATCH"
  | "VERSION_HANDSHAKE_FAILED";

export type ApplyPatchDesktopRuntimeResolution =
  | {
      readonly ok: true;
      readonly origin: ApplyPatchDesktopRuntimeOrigin;
      readonly binaryPath: string;
      readonly platformKey: ToolRuntimePlatformKey;
      readonly runtimeVersion: string;
      readonly protocol: string;
      readonly provenance: ApplyPatchDesktopManifestEntry["provenance"];
      /** Package-time nested signature/DR verification is separate from this pristine-byte result. */
      readonly integrity: "pristine-byte-sha256" | "package-signature-boundary";
    }
  | {
      readonly ok: false;
      readonly code: "runtime_unavailable";
      readonly reason: ApplyPatchDesktopRuntimeUnavailableReason;
      readonly message: string;
    };

export interface ResolveApplyPatchDesktopRuntimeInput {
  /** Exact Electron `app.isPackaged` signal. Defaults to the legacy resourcesPath heuristic in tests. */
  readonly isPackaged?: boolean;
  /** Electron resourcesPath in packaged mode; null for source/vendor mode. */
  readonly resourcesPath: string | null;
  /** Trusted apps/desktop/vendor root; never inferred from cwd or environment. */
  readonly devVendorRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly versionJsonRunner?: (binaryPath: string) => string;
}

export type ResolveElectronApplyPatchDesktopRuntimeInput =
  Omit<ResolveApplyPatchDesktopRuntimeInput, "isPackaged"> & {
    /** Exact Electron `app.isPackaged`; null means the trust boundary could not be established. */
    readonly isPackaged: boolean | null;
  };

function machOArch(binaryPath: string): "arm64" | "x64" | null {
  const header = readFileSync(binaryPath).subarray(0, 8);
  if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) return null;
  const cpu = header.readUInt32LE(4);
  return cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : null;
}

function exactVersionJson(output: string, entry: ApplyPatchDesktopManifestEntry): boolean {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const provenance = value["provenance"] as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(",");
    const provenanceKeys = Object.keys(provenance ?? {}).sort().join(",");
    return keys === "nautilo_extraction_revision,protocol,provenance,runtime_version,upstream_revision" &&
      provenanceKeys === "format,license_sha256,notice_sha256,upstream_revision" &&
      value["runtime_version"] === entry.version && value["protocol"] === entry.protocol &&
      value["upstream_revision"] === entry.provenance.upstreamRevision &&
      value["nautilo_extraction_revision"] === entry.provenance.nautiloExtractionRevision &&
      provenance?.["format"] === entry.provenance.format && provenance["license_sha256"] === entry.provenance.licenseSha256 &&
      provenance["notice_sha256"] === entry.provenance.noticeSha256;
  } catch { return false; }
}

function unavailable(reason: ApplyPatchDesktopRuntimeUnavailableReason, message: string): ApplyPatchDesktopRuntimeResolution {
  return { ok: false, code: "runtime_unavailable", reason, message };
}

/** Resolve from Electron only when its packaging trust boundary is known. */
export function resolveElectronApplyPatchDesktopRuntime(
  input: ResolveElectronApplyPatchDesktopRuntimeInput,
): ApplyPatchDesktopRuntimeResolution {
  if (input.isPackaged === null) {
    return unavailable(
      "PACKAGING_STATE_UNAVAILABLE",
      "Nautilo apply-patch runtime packaging state is unavailable.",
    );
  }
  return resolveApplyPatchDesktopRuntime({ ...input, isPackaged: input.isPackaged });
}

function candidatePaths(
  input: ResolveApplyPatchDesktopRuntimeInput,
  platformKey: ToolRuntimePlatformKey,
  isPackaged: boolean,
) {
  const sourceManifestPath = join(input.devVendorRoot, "apply-patch", "runtime-manifest.json");
  const sourceBinaryPath = join(input.devVendorRoot, "apply-patch", platformKey, "nautilo-apply-patch");
  if (!isPackaged) {
    return { origin: "source" as const, manifestPath: sourceManifestPath, binaryPath: sourceBinaryPath };
  }
  const resourcesPath = input.resourcesPath!;
  return {
    origin: "packaged" as const,
    manifestPath: join(resourcesPath, "tools-apply-patch", "runtime-manifest.json"),
    binaryPath: join(resourcesPath, "tools-apply-patch", platformKey, "nautilo-apply-patch"),
  };
}

/** Resolve the product-owned Darwin binary or return a stable unavailable outcome. */
export function resolveApplyPatchDesktopRuntime(
  input: ResolveApplyPatchDesktopRuntimeInput,
): ApplyPatchDesktopRuntimeResolution {
  const platformKey = detectDesktopPlatformKey(input.platform ?? process.platform, input.arch ?? process.arch);
  if (platformKey === null) {
    return unavailable("PLATFORM_UNSUPPORTED", "Nautilo apply-patch runtime is unavailable on this relay platform.");
  }
  const isPackaged = input.isPackaged ?? input.resourcesPath !== null;
  if (isPackaged && input.resourcesPath === null) {
    return unavailable("MANIFEST_MISSING", "Nautilo apply-patch runtime manifest is unavailable.");
  }
  const candidate = candidatePaths(input, platformKey, isPackaged);
  let entry: ApplyPatchDesktopManifestEntry;
  try {
    if (!existsSync(candidate.manifestPath)) return unavailable("MANIFEST_MISSING", "Nautilo apply-patch runtime manifest is unavailable.");
    entry = getApplyPatchDesktopManifestEntry(parseToolRuntimesManifest(readFileSync(candidate.manifestPath, "utf8")));
  } catch {
    return unavailable("MANIFEST_INVALID", "Nautilo apply-patch runtime manifest is invalid.");
  }
  const artifact = entry.artifacts[platformKey];
  if (artifact.sha256 === undefined) {
    return unavailable("BUILD_OUTPUT_MISSING", "Nautilo apply-patch runtime build output is unavailable; run the Desktop build command before starting Electron.");
  }
  if (!existsSync(candidate.binaryPath)) return unavailable("BINARY_MISSING", "Nautilo apply-patch runtime binary is unavailable.");
  try { accessSync(candidate.binaryPath, constants.X_OK); } catch { return unavailable("BINARY_NOT_EXECUTABLE", "Nautilo apply-patch runtime binary is not executable."); }
  if (statSync(candidate.binaryPath).size < (artifact.sizeMin ?? 100_000)) {
    return unavailable("BINARY_TOO_SMALL", "Nautilo apply-patch runtime failed its size check.");
  }
  if (machOArch(candidate.binaryPath) !== artifact.machOArch) return unavailable("BINARY_WRONG_ARCHITECTURE", "Nautilo apply-patch runtime has the wrong architecture.");
  // A packaged Mach-O is re-signed by electron-builder. Its bytes must not be
  // compared with the pristine release hash; package-time codesign + DR checks
  // prove its nested identity instead. Source vendor bytes remain pristine.
  if (candidate.origin === "source") {
    const actual = createHash("sha256").update(readFileSync(candidate.binaryPath)).digest("hex");
    if (actual !== artifact.sha256) return unavailable("CHECKSUM_MISMATCH", "Nautilo apply-patch runtime failed its pristine-byte integrity check.");
  }
  const output = input.versionJsonRunner?.(candidate.binaryPath) ?? (() => {
    const result = spawnSync(candidate.binaryPath, ["--version-json"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, env: {}, shell: false });
    return result.status === 0 ? result.stdout : "";
  })();
  if (!exactVersionJson(output, entry)) return unavailable("VERSION_HANDSHAKE_FAILED", "Nautilo apply-patch runtime failed its version handshake.");
  return {
    ok: true,
    origin: candidate.origin,
    binaryPath: candidate.binaryPath,
    platformKey,
    runtimeVersion: entry.version,
    protocol: entry.protocol,
    provenance: entry.provenance,
    integrity: candidate.origin === "source" ? "pristine-byte-sha256" : "package-signature-boundary",
  };
}
