import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { videoMetadataFromSummary } from "./ffmpeg-media-metadata";
import { runFfmpegSummary } from "./ffmpeg-summary";

/** One-descriptor, fixed-memory copy of a canonical file; growth cannot extend the initial byte budget. */
export async function copyMediaSnapshot(sourcePath: string, destinationPath: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
  let source: Awaited<ReturnType<typeof fs.open>> | undefined;
  let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
  let copied = false;
  try {
    if (options.signal?.aborted || await fs.realpath(sourcePath) !== path.resolve(sourcePath)) return false;
    const entry = await fs.lstat(sourcePath);
    if (!entry.isFile() || !Number.isSafeInteger(entry.size) || entry.size <= 0) return false;
    source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await source.stat();
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size ||
        await fs.realpath(sourcePath) !== path.resolve(sourcePath)) return false;
    destination = await fs.open(destinationPath, "wx", 0o600);
    // IO chunk size, not a media admission ceiling: the full file is streamed.
    const buffer = Buffer.alloc(Math.min(before.size, 256 * 1024));
    let offset = 0;
    while (offset < before.size) {
      if (options.signal?.aborted) return false;
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) return false;
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destination.write(buffer, written, bytesRead - written, offset + written);
        if (!bytesWritten) return false;
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await source.stat();
    copied = !options.signal?.aborted && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;
    return copied;
  } catch { return false; }
  finally {
    await source?.close().catch(() => {});
    await destination?.close().catch(() => {});
    if (destination && !copied) await fs.unlink(destinationPath).catch(() => {});
  }
}

/** Read one native-picked regular file without allowing growth to bypass the caller's byte envelope. */
export async function readPickedMediaFile(sourcePath: string, maxBytes: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const handle = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) return null;
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    return offset === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      ? bytes.subarray(0, offset) : null;
  } finally { await handle.close(); }
}
export type SourceFormat = "mp4" | "wav" | "mp3" | "png" | "jpeg" | "webp";
export type InspectedMedia =
  | { mediaKind: "video"; mimeType: "video/mp4"; extension: "mp4"; durationSec: number; frameRate: { numerator: number; denominator: number } }
  | { mediaKind: "audio"; mimeType: "audio/mp4" | "audio/mpeg" | "audio/wav"; extension: "m4a" | "mp3" | "wav"; durationSec: number }
  | { mediaKind: "image"; mimeType: "image/png" | "image/jpeg" | "image/webp"; extension: "png" | "jpg" | "webp" };

/** Header classification is routing, not validation: the forced decoder below must also accept it. */
export async function detectMediaFormat(sourcePath: string): Promise<SourceFormat | null> {
  const handle = await fs.open(sourcePath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const b = bytes.subarray(0, bytesRead);
    if (b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
    if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    // JPEG also begins with the MPEG sync bits; identify it before MP3.
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
    if ((b.length >= 3 && b.subarray(0, 3).toString("ascii") === "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return "mp3";
    return null;
  } finally { await handle.close(); }
}

export function mediaInputArguments(format: SourceFormat): string[] {
  const image = format === "png" || format === "jpeg" || format === "webp";
  return ["-protocol_whitelist", "file,pipe", "-f", image ? "image2pipe" : format === "mp4" ? "mov" : format,
    ...(image ? ["-c:v", format === "jpeg" ? "mjpeg" : format] : [])];
}

export async function inspectMediaSource(binaryPath: string, sourcePath: string, options: { signal?: AbortSignal } = {}): Promise<InspectedMedia | null> {
  try {
    if (options.signal?.aborted) return null;
    const format = await detectMediaFormat(sourcePath);
    if (!format || options.signal?.aborted) return null;
    const image = format === "png" || format === "jpeg" || format === "webp";
    // Decode one frame per admitted stream. A zero-frame decode fails during
    // encoder initialization on valid HEVC inputs with current managed FFmpeg.
    const summary = await runFfmpegSummary(binaryPath, ["-hide_banner", "-nostdin", ...mediaInputArguments(format), "-i", sourcePath,
      "-map", "0:v:0?", "-map", "0:a:0?", "-frames:v", "1", "-frames:a", image ? "0" : "1", "-f", "null", "-"], {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!summary || options.signal?.aborted) return null;
    if (image) return summary.hasVideo
      ? { mediaKind: "image", mimeType: format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp", extension: format === "jpeg" ? "jpg" : format }
      : null;
    if (summary.hasVideo && format === "mp4") {
      const metadata = videoMetadataFromSummary(summary);
      return metadata ? { mediaKind: "video", mimeType: "video/mp4", extension: "mp4", ...metadata } : null;
    }
    const durationSec = summary.durationSec;
    if (durationSec === null || !summary.hasAudio) return null;
    return { mediaKind: "audio", mimeType: format === "mp4" ? "audio/mp4" : format === "wav" ? "audio/wav" : "audio/mpeg", extension: format === "mp4" ? "m4a" : format === "wav" ? "wav" : "mp3", durationSec };
  } catch { return null; }
}
