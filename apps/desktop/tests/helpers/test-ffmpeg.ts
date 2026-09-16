import { constants, accessSync } from "node:fs";
import * as path from "node:path";

/** Resolve the real FFmpeg used by codec integration tests without PATH drift. */
export function testFfmpegPath(): string {
  const configured = process.env["NAUTILO_TEST_FFMPEG"];
  const binary = configured
    ? path.resolve(configured)
    : process.platform === "darwin"
      ? path.resolve(import.meta.dir, `../../vendor/ffmpeg/${process.arch === "arm64" ? "arm64" : "x64"}/bin/ffmpeg`)
      : null;
  if (!binary) {
    throw new Error("NAUTILO_TEST_FFMPEG must name the provisioned FFmpeg binary outside macOS");
  }
  accessSync(binary, constants.X_OK);
  return binary;
}

/** Fixture creation uses the same platform encoder as the Desktop executor. */
export const testH264EncoderArgs = process.platform === "darwin"
  ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1"] : ["-c:v", "libx264"];
