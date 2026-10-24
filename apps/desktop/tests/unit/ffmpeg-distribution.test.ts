import { describe, expect, test } from "bun:test";
import { assertFfmpegBuild, ffmpegDistribution, ffmpegDistributionFor, ffmpegExecutablePath, ffmpegManifest, hostFfmpegPlatformKeys, requiredFfmpegEncoders } from "../../scripts/ffmpeg-distribution";
import { DESKTOP_DARWIN_PLATFORM_KEYS, type ToolRuntimePlatformKey } from "../../electron/tool-runtimes-manifest";
import { desktopVideoEncoderArgs } from "../../electron/video-encoder";
import { normalizeVideoExportSettings, videoExportCodecArgs } from "@nautilo/types";

const version = "ffmpeg version 9.0.1 Copyright (c) FFmpeg";
const config = "--disable-nonfree --enable-version3 --enable-videotoolbox";
const license = "GNU Lesser General Public License, version 3 or later";

describe("LGPL FFmpeg distribution", () => {
  test("accepts the approved license/configuration and rejects the retired nonfree combination", () => {
    expect(() => assertFfmpegBuild(version, config, license)).not.toThrow();
    for (const flag of ["gpl", "nonfree"]) {
      expect(() => assertFfmpegBuild(version, config + ` --enable-${flag}`, license)).toThrow();
    }
    expect(() => assertFfmpegBuild(version, config.replace("--disable-nonfree", ""), license)).toThrow();
    expect(() => assertFfmpegBuild("ffmpeg version 6.0 Copyright", "--enable-gpl --enable-version3 --enable-nonfree", "not legally redistributable")).toThrow();
    expect(() => assertFfmpegBuild(version, config, "GNU General Public License")).toThrow();
    expect(() => assertFfmpegBuild(version, config, license + " not legally redistributable")).toThrow();
  });

  test("every production archive has a separate executable pin and exact source inputs", () => {
    expect(ffmpegDistribution.version).toBe(ffmpegManifest.version);
    expect(Object.keys(ffmpegManifest.artifacts).sort()).toEqual(["darwin-arm64", "darwin-x64", "win-x64"]);
    for (const [key, artifact] of Object.entries(ffmpegManifest.artifacts)) {
      expect(artifact.binarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.binarySha256).not.toBe(artifact.sha256);
      expect(artifact.member).toBe(key === "win-x64" ? "ffmpeg.exe" : "bin/ffmpeg");
      const executable = ffmpegDistribution.binaries.find(file => file.path === ffmpegExecutablePath(key as ToolRuntimePlatformKey));
      expect(executable?.sha256).toBe(artifact.binarySha256);
    }
    expect(ffmpegDistribution.sources.map(file => file.path)).toContain("source/ffmpeg-9.0.1.tar.xz");
    expect(ffmpegDistribution.sources.map(file => file.path)).toContain("source/build-source.tar.gz");
    expect(ffmpegDistribution.binaries.some(file => file.path.includes("/lib/libavcodec."))).toBe(true);
    expect(ffmpegDistribution.binaries.some(file => file.path === "win-x64/bin/avcodec-63.dll")).toBe(true);
  });

  test("each package carries only its own platform trees and the sources they need", () => {
    const windows = ffmpegDistributionFor(["win-x64"]);
    const mac = ffmpegDistributionFor(DESKTOP_DARWIN_PLATFORM_KEYS);
    expect([...windows.binaries, ...windows.notices].every(file => file.path.startsWith("win-x64/"))).toBe(true);
    expect([...mac.binaries, ...mac.notices].every(file => /^(arm64|x64)\//.test(file.path))).toBe(true);
    expect(windows.binaries).toHaveLength(10);
    // Header-only GPU interfaces and the Windows-only DLL sources stay out of Mac packages.
    const windowsOnly = ["nv-codec-headers-n12.2.72.0.tar.gz", "AMF-headers-v1.5.2.tar.gz", "libvpl-2.17.0.tar.gz", "mingw-w64_6.0.0.orig.tar.bz2"].map(name => `source/${name}`);
    expect(windows.sources.map(file => file.path)).toEqual(expect.arrayContaining(windowsOnly));
    expect(mac.sources.map(file => file.path)).not.toEqual(expect.arrayContaining([windowsOnly[0]]));
    expect(mac.sources.length + windowsOnly.length).toBe(windows.sources.length);
    expect(hostFfmpegPlatformKeys("darwin", "arm64")).toEqual(DESKTOP_DARWIN_PLATFORM_KEYS);
    expect(hostFfmpegPlatformKeys("win32", "x64")).toEqual(["win-x64"]);
    expect(hostFfmpegPlatformKeys("win32", "arm64")).toEqual([]);
    expect(hostFfmpegPlatformKeys("linux", "x64")).toEqual([]);
  });

  test("the LGPL build relies on the operating system's H.264 encoder", () => {
    expect(requiredFfmpegEncoders("darwin-arm64")).toEqual(["h264_videotoolbox", "aac"]);
    expect(requiredFfmpegEncoders("win-x64")).toEqual(["h264_mf", "aac"]);
  });

  test("VideoToolbox quality targets increase with quality/resolution and preserve explicit custom bitrate", () => {
    for (const resolution of ["720p", "1080p", "4k"] as const) {
      const targets = ["smaller", "balanced", "high"].map(quality => {
        const args = videoExportCodecArgs(normalizeVideoExportSettings({ resolution, quality })!, "videotoolbox");
        expect(args).not.toContain("-crf");
        return Number(args[args.indexOf("-b:v") + 1]);
      });
      expect(targets[0]!).toBeGreaterThan(0);
      expect(targets[1]!).toBeGreaterThan(targets[0]!);
      expect(targets[2]!).toBeGreaterThan(targets[1]!);
    }
    expect(videoExportCodecArgs(normalizeVideoExportSettings({ quality: "custom", videoBitrateKbps: 6750, audioBitrateKbps: 320 })!, "videotoolbox"))
      .toEqual(["-b:v", "6750000", "-b:a", "320k"]);
    for (const quality of ["smaller", "balanced", "high", "custom"] as const) {
      const settings = normalizeVideoExportSettings(quality === "custom" ? { quality, videoBitrateKbps: 6750 } : { quality })!;
      expect(videoExportCodecArgs(settings, "mediafoundation")).toEqual(videoExportCodecArgs(settings, "videotoolbox"));
    }
    const args = desktopVideoEncoderArgs();
    const expected = process.platform === "darwin" ? "h264_videotoolbox" : process.platform === "win32" ? "h264_mf" : "libx264";
    expect(args[args.indexOf("-c:v") + 1]).toBe(expected);
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(args).not.toContain("libx264"); expect(args).not.toContain("-crf"); expect(args).not.toContain("-preset");
    }
    if (process.platform === "win32") {
      // Hardware Media Foundation encoders depend on the GPU driver; the
      // software encoder is the one every Windows installation provides.
      expect(args.slice(args.indexOf("-hw_encoding"), args.indexOf("-hw_encoding") + 2)).toEqual(["-hw_encoding", "0"]);
      expect(args.slice(args.indexOf("-profile:v"), args.indexOf("-profile:v") + 2)).toEqual(["-profile:v", "100"]);
    }
  });
});
