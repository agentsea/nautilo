import { describe, expect, test } from "bun:test";
import { assertFfmpegBuild, ffmpegDistribution, ffmpegManifest } from "../../scripts/ffmpeg-distribution";
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
    for (const artifact of Object.values(ffmpegManifest.artifacts)) {
      expect(artifact.binarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.binarySha256).not.toBe(artifact.sha256);
      expect(artifact.member).toBe("bin/ffmpeg");
    }
    expect(ffmpegDistribution.sources.map(file => file.path)).toContain("source/ffmpeg-9.0.1.tar.xz");
    expect(ffmpegDistribution.sources.map(file => file.path)).toContain("source/build-source.tar.gz");
    expect(ffmpegDistribution.binaries.some(file => file.path.includes("/lib/libavcodec."))).toBe(true);
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
    const args = desktopVideoEncoderArgs();
    expect(args[args.indexOf("-c:v") + 1]).toBe(process.platform === "darwin" ? "h264_videotoolbox" : "libx264");
    if (process.platform === "darwin") {
      expect(args).not.toContain("libx264"); expect(args).not.toContain("-crf"); expect(args).not.toContain("-preset");
    }
  });
});
