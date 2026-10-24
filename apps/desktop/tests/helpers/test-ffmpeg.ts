import { constants, accessSync } from "node:fs";
import * as path from "node:path";

/** Resolve the real FFmpeg used by codec integration tests without PATH drift. */
export function testFfmpegPath(): string {
  const configured = process.env["NAUTILO_TEST_FFMPEG"];
  const vendored = process.platform === "darwin"
    ? `../../vendor/ffmpeg/${process.arch === "arm64" ? "arm64" : "x64"}/bin/ffmpeg`
    : process.platform === "win32" && process.arch === "x64"
      ? "../../vendor/ffmpeg/win-x64/bin/ffmpeg.exe"
      : null;
  const binary = configured
    ? path.resolve(configured)
    : vendored
      ? path.resolve(import.meta.dir, vendored)
      : null;
  if (!binary) {
    throw new Error("NAUTILO_TEST_FFMPEG must name the provisioned FFmpeg binary outside macOS and Windows x64");
  }
  accessSync(binary, constants.X_OK);
  return binary;
}

/** Fixture creation uses the same platform encoder as the Desktop executor. */
export const testH264EncoderArgs = process.platform === "darwin"
  ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
  : process.platform === "win32"
    ? ["-c:v", "h264_mf", "-hw_encoding", "0"]
    : ["-c:v", "libx264"];
