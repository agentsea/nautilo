import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyFfmpegFile } from "../electron/ffmpeg-integrity";
import { desktopRuntimeArchDir } from "../electron/tool-runtime-resolver";
import { DESKTOP_DARWIN_PLATFORM_KEYS, parseToolRuntimesManifest, type ToolRuntimePlatformKey } from "../electron/tool-runtimes-manifest";
import distribution from "./ffmpeg-distribution.json";

export const ffmpegDistribution = distribution;
export const ffmpegManifest = parseToolRuntimesManifest(readFileSync(new URL("../vendor/tool-runtimes.manifest.json", import.meta.url), "utf8"))["ffmpeg"]!;
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Platform keys whose FFmpeg this host vendors, packages and executes. */
export function hostFfmpegPlatformKeys(platform: NodeJS.Platform = process.platform, arch: string = process.arch): readonly ToolRuntimePlatformKey[] {
  if (platform === "darwin") return DESKTOP_DARWIN_PLATFORM_KEYS;
  if (platform === "win32" && arch === "x64") return ["win-x64"];
  return [];
}

/** The executable inside a platform tree, relative to the distribution root. */
export function ffmpegExecutablePath(key: ToolRuntimePlatformKey): string {
  return `${desktopRuntimeArchDir(key)}/bin/ffmpeg${key.startsWith("win-") ? ".exe" : ""}`;
}

/** The receipt describes every platform; a package carries only its own trees
 * plus the shared sources and the sources only its platform needs. */
export function ffmpegDistributionFor(keys: readonly ToolRuntimePlatformKey[]) {
  const trees = keys.map(key => `${desktopRuntimeArchDir(key)}/`);
  const inTree = (file: { path: string }): boolean => trees.some(tree => file.path.startsWith(tree));
  return {
    sources: distribution.sources.filter(file => !("platform" in file) || keys.includes(file.platform as ToolRuntimePlatformKey)),
    notices: distribution.notices.filter(inTree),
    binaries: distribution.binaries.filter(inTree),
  };
}

export function assertFfmpegBuild(version: string, configuration: string, license: string): void {
  if (!version.startsWith(`ffmpeg version ${distribution.ffmpegVersion} `)) throw new Error("Unapproved FFmpeg version");
  const flags = configuration.split(/\s+/);
  for (const flag of ["gpl", "nonfree"]) {
    if (flags.includes(`--enable-${flag}`)) throw new Error(`FFmpeg must not enable ${flag}`);
  }
  if (!flags.includes("--disable-nonfree") || !flags.includes("--enable-version3")) throw new Error("FFmpeg must match the approved LGPLv3 configuration");
  if (!license.includes("GNU Lesser General Public") || /not legally redistributable/i.test(license)) throw new Error("FFmpeg license is not the approved LGPL build");
}

/** The LGPL build has no x264; export depends on the operating system's H.264 encoder. */
export function requiredFfmpegEncoders(key: ToolRuntimePlatformKey): readonly string[] {
  return [key.startsWith("win-") ? "h264_mf" : "h264_videotoolbox", "aac"];
}

function codecListed(listing: string, name: string): boolean {
  return listing.split(/\n/).some(line => line.trim().split(/\s+/)[1] === name);
}

/** Runs before packaging and again against the signed app. Hash every source and
 * notice even on cache hits; signing may change only executable signatures. */
export async function verifyFfmpegDistribution(root: string, signed = false, requireSignature = false, keys: readonly ToolRuntimePlatformKey[] = hostFfmpegPlatformKeys()): Promise<void> {
  if (keys.length === 0) throw new Error("Managed FFmpeg is bundled for macOS and Windows x64 only");
  if (ffmpegManifest.version !== distribution.version || ffmpegManifest.license !== "LGPL-3.0-or-later") throw new Error("FFmpeg distribution/pin mismatch");
  const files = ffmpegDistributionFor(keys);
  const allowed = new Set(["manifest.json", "distribution.json", "PROVENANCE.md", ".version", ...[...files.sources, ...files.notices, ...files.binaries].map(file => file.path)]);
  const walk = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative + "/");
      else if (!entry.isFile() || !allowed.has(relative)) throw new Error(`Unexpected FFmpeg package member: ${relative}`);
    }
  };
  walk(root);
  const packaged = parseToolRuntimesManifest(readFileSync(join(root, "manifest.json"), "utf8"))["ffmpeg"];
  if (JSON.stringify(packaged) !== JSON.stringify(ffmpegManifest)) throw new Error("FFmpeg packaged manifest differs from the approved pin");
  for (const file of [...files.sources, ...files.notices]) {
    if (digest(readFileSync(join(root, file.path))) !== file.sha256) throw new Error(`FFmpeg source/notice checksum mismatch: ${file.path}`);
  }
  if (readFileSync(join(root, "PROVENANCE.md"), "utf8") !== readFileSync(new URL("../FFMPEG.md", import.meta.url), "utf8")) throw new Error("FFmpeg provenance is stale");
  if (JSON.stringify(JSON.parse(readFileSync(join(root, "distribution.json"), "utf8"))) !== JSON.stringify(distribution)) throw new Error("FFmpeg distribution receipt differs from approved sources/libraries");
  const signing = signed ? { requireSignature, ...(process.env["APPLE_TEAM_ID"] ? { teamId: process.env["APPLE_TEAM_ID"] } : { allowAdHoc: true }) } : undefined;
  for (const file of files.binaries) {
    if (!await verifyFfmpegFile(join(root, file.path), file.sha256, new Map(), signing)) throw new Error(`FFmpeg integrity failed: ${file.path}`);
  }
  for (const key of keys) {
    const binary = join(root, ffmpegExecutablePath(key));
    const expected = ffmpegManifest.artifacts[key]?.binarySha256;
    if (!expected) throw new Error(`FFmpeg extracted-binary pin missing: ${key}`);
    // Every pinned tree was hashed above; execute only the native one. Native
    // Intel Mac qualification is performed by the macOS x64 CI lane.
    const native = key === "win-x64" ? process.platform === "win32" && process.arch === "x64"
      : process.platform === "darwin" && desktopRuntimeArchDir(key) === process.arch;
    if (!native) continue;
    const probe = (arg: string): string => execFileSync(binary, [arg], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assertFfmpegBuild(probe("-version"), probe("-buildconf"), probe("-L"));
    const decoders = probe("-decoders");
    for (const decoder of ["png", "mjpeg", "webp", "h264", "aac", "mp3"]) {
      if (!codecListed(decoders, decoder)) throw new Error(`FFmpeg required decoder missing: ${decoder}`);
    }
    const encoders = probe("-encoders");
    for (const encoder of requiredFfmpegEncoders(key)) {
      if (!codecListed(encoders, encoder)) throw new Error(`FFmpeg required encoder missing: ${encoder}`);
    }
  }
}
