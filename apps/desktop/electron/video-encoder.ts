import { normalizeVideoExportSettings, videoExportCodecArgs, type VideoExportSettings } from "@nautilo/types";

/** Mac and Windows production use the bundled LGPL FFmpeg, which has no x264:
 * the operating system's H.264 encoder does the work. Windows forces Media
 * Foundation's software encoder, since hardware encoders depend on the GPU
 * driver, and asks for High profile instead of its Baseline default. That
 * encoder refuses frames under 48 pixels per side. Other development hosts
 * keep their separately provisioned FFmpeg; no alternate binary is tried on
 * failure. */
export function desktopVideoEncoderArgs(settings: VideoExportSettings = normalizeVideoExportSettings(undefined)!): string[] {
  if (process.platform === "darwin") {
    return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-pix_fmt", "yuv420p", ...videoExportCodecArgs(settings, "videotoolbox")];
  }
  if (process.platform === "win32") {
    return ["-c:v", "h264_mf", "-hw_encoding", "0", "-profile:v", "100", "-pix_fmt", "yuv420p", ...videoExportCodecArgs(settings, "mediafoundation")];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...videoExportCodecArgs(settings)];
}
