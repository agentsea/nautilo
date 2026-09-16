import { FfmpegSummaryParser, runFfmpegSummary, type FfmpegSummary } from "./ffmpeg-summary";

export interface VideoMediaMetadata {
  readonly durationSec: number;
  readonly frameRate: {
    readonly numerator: number;
    readonly denominator: number;
  };
}

const COMMON_FRACTIONAL_RATES = [
  { displayed: 23.98, numerator: 24_000, denominator: 1_001 },
  { displayed: 29.97, numerator: 30_000, denominator: 1_001 },
  { displayed: 47.95, numerator: 48_000, denominator: 1_001 },
  { displayed: 59.94, numerator: 60_000, denominator: 1_001 },
  { displayed: 119.88, numerator: 120_000, denominator: 1_001 },
] as const;

function rationalizeDisplayedFrameRate(value: number): VideoMediaMetadata["frameRate"] | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const common = COMMON_FRACTIONAL_RATES.find((candidate) => Math.abs(candidate.displayed - value) < 0.006);
  if (common) return { numerator: common.numerator, denominator: common.denominator };
  const integer = Math.round(value);
  if (Math.abs(integer - value) < 0.000_001) return Number.isSafeInteger(integer) ? { numerator: integer, denominator: 1 } : null;
  const denominator = 1_000;
  const numerator = Math.round(value * denominator);
  if (!Number.isSafeInteger(numerator)) return null;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

/**
 * Parse the stable human-readable input summary emitted by FFmpeg itself.
 *
 * Nautilo vendors FFmpeg but not FFprobe. A zero-frame copy command asks the
 * managed binary to validate the first video stream and print its container
 * duration/rate without decoding or copying the source into JavaScript memory.
 */
export function parseFfmpegVideoMetadata(stderr: string): VideoMediaMetadata | null {
  const parser = new FfmpegSummaryParser(); parser.push(stderr);
  return videoMetadataFromSummary(parser.finish());
}

export function videoMetadataFromSummary(summary: FfmpegSummary): VideoMediaMetadata | null {
  const durationSec = summary.durationSec;
  const frameRate = summary.frameRate === null ? null : rationalizeDisplayedFrameRate(summary.frameRate);
  if (durationSec === null || !summary.hasVideo || !frameRate) return null;
  return { durationSec, frameRate };
}

export async function probeVideoMetadataWithFfmpeg(
  binaryPath: string,
  sourcePath: string,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<VideoMediaMetadata | null> {
  try {
    const result = await runFfmpegSummary(binaryPath, [
      "-hide_banner",
      "-nostdin", "-protocol_whitelist", "file,pipe",
      "-i", sourcePath,
      "-map", "0:v:0",
      "-c", "copy",
      "-frames:v", "0",
      "-f", "null",
      "-",
    ], options);
    return result ? videoMetadataFromSummary(result) : null;
  } catch {
    return null;
  }
}
