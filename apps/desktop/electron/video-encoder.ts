import { normalizeVideoExportSettings, videoExportCodecArgs, type VideoExportSettings } from "@nautilo/types";

/** Mac production uses the bundled LGPL encoder. Other development hosts keep
 * their separately provisioned FFmpeg; no alternate binary is tried on failure. */
export function desktopVideoEncoderArgs(settings: VideoExportSettings = normalizeVideoExportSettings(undefined)!): string[] {
  return process.platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-pix_fmt", "yuv420p", ...videoExportCodecArgs(settings, "videotoolbox")]
    : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...videoExportCodecArgs(settings)];
}
