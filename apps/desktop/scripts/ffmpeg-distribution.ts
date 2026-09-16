import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyFfmpegFile } from "../electron/ffmpeg-integrity";
import { DESKTOP_DARWIN_PLATFORM_KEYS, parseToolRuntimesManifest } from "../electron/tool-runtimes-manifest";
import distribution from "./ffmpeg-distribution.json";

export const ffmpegDistribution = distribution;
export const ffmpegManifest = parseToolRuntimesManifest(readFileSync(new URL("../vendor/tool-runtimes.manifest.json", import.meta.url), "utf8"))["ffmpeg"]!;
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function assertFfmpegBuild(version: string, configuration: string, license: string): void {
  if (!version.startsWith(`ffmpeg version ${distribution.ffmpegVersion} `)) throw new Error("Unapproved FFmpeg version");
  const flags = configuration.split(/\s+/);
  for (const flag of ["gpl", "nonfree"]) {
    if (flags.includes(`--enable-${flag}`)) throw new Error(`FFmpeg must not enable ${flag}`);
  }
  if (!flags.includes("--disable-nonfree") || !flags.includes("--enable-version3")) throw new Error("FFmpeg must match the approved LGPLv3 configuration");
  if (!license.includes("GNU Lesser General Public") || /not legally redistributable/i.test(license)) throw new Error("FFmpeg license is not the approved LGPL build");
}

/** Runs before packaging and again against the signed app. Hash every source and
 * notice even on cache hits; signing may change only executable signatures. */
export async function verifyFfmpegDistribution(root: string, signed = false, requireSignature = false): Promise<void> {
  if (ffmpegManifest.version !== distribution.version || ffmpegManifest.license !== "LGPL-3.0-or-later") throw new Error("FFmpeg distribution/pin mismatch");
  const allowed = new Set(["manifest.json", "distribution.json", "PROVENANCE.md", ".version", ...[...distribution.sources, ...distribution.notices, ...distribution.binaries].map(file => file.path)]);
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
  for (const file of [...distribution.sources, ...distribution.notices]) {
    if (digest(readFileSync(join(root, file.path))) !== file.sha256) throw new Error(`FFmpeg source/notice checksum mismatch: ${file.path}`);
  }
  if (readFileSync(join(root, "PROVENANCE.md"), "utf8") !== readFileSync(new URL("../FFMPEG.md", import.meta.url), "utf8")) throw new Error("FFmpeg provenance is stale");
  if (JSON.stringify(JSON.parse(readFileSync(join(root, "distribution.json"), "utf8"))) !== JSON.stringify(distribution)) throw new Error("FFmpeg distribution receipt differs from approved sources/libraries");
  const signing = signed ? { requireSignature, ...(process.env["APPLE_TEAM_ID"] ? { teamId: process.env["APPLE_TEAM_ID"] } : { allowAdHoc: true }) } : undefined;
  for (const file of distribution.binaries) {
    if (!await verifyFfmpegFile(join(root, file.path), file.sha256, new Map(), signing)) throw new Error(`FFmpeg integrity failed: ${file.path}`);
  }
  for (const key of DESKTOP_DARWIN_PLATFORM_KEYS) {
    const arch = key === "darwin-arm64" ? "arm64" : "x64";
    const binary = join(root, arch, "bin", "ffmpeg");
    const expected = ffmpegManifest.artifacts[key]?.binarySha256;
    if (!expected) throw new Error(`FFmpeg extracted-binary pin missing: ${key}`);
    // The foreign architecture was pinned above; execute only the native one.
    // Native Intel qualification is performed by the macOS x64 CI lane.
    if (process.platform === "darwin" && arch === process.arch) {
      const probe = (arg: string): string => execFileSync(binary, [arg], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assertFfmpegBuild(probe("-version"), probe("-buildconf"), probe("-L"));
      const decoders = probe("-decoders");
      for (const decoder of ["png", "mjpeg", "webp", "h264", "aac", "mp3"]) {
        if (!decoders.split(/\n/).some(line => line.trim().split(/\s+/)[1] === decoder)) throw new Error(`FFmpeg required decoder missing: ${decoder}`);
      }
    }
  }
}
