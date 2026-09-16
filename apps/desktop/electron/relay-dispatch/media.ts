import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  RELAY_FS_MAX_BYTES,
  RELAY_MEDIA_CHUNK_BYTES,
  RELAY_MEDIA_MAX_BYTES,
  type RelayDispatchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
} from "./router.ts";

const MEDIA_EXTRACT_TIMEOUT_MS = 60_000;
const MAX_MEDIA_SESSIONS = 2;
const MAX_MEDIA_BUFFERED_BYTES = RELAY_MEDIA_MAX_BYTES * 2;
const MAX_BASE64_MEDIA_BYTES = Math.ceil(RELAY_FS_MAX_BYTES / 3) * 4;
const defaultExecFile = promisify(nodeExecFile);

export interface MediaSessionRecord {
  source: Buffer[];
  expectedIndex: number;
  chunkCount: number;
  totalBytes: number;
  receivedBytes: number;
  createdAt: number;
  audio?: Buffer;
}

export interface MediaSessionsPort {
  readonly size: () => number;
  readonly get: (sessionId: string) => MediaSessionRecord | undefined;
  readonly has: (sessionId: string) => boolean;
  readonly set: (sessionId: string, session: MediaSessionRecord) => void;
  readonly release: (sessionId: string) => void;
  readonly expire: () => void;
  readonly getBufferedBytes: () => number;
  readonly adjustBufferedBytes: (delta: number) => void;
}

type FfmpegProbeResult =
  | { readonly ok: true; readonly bin: string }
  | {
      readonly ok: false;
      readonly code: "FFMPEG_MISSING" | "FFMPEG_UNAVAILABLE";
      readonly message: string;
    };

type MediaExecFile = (
  binary: string,
  argv: string[],
  options: { readonly timeout: number; readonly maxBuffer: number },
) => Promise<unknown>;

type RelayExtractAudioFromVideoRequest = {
  readonly sourceBase64: string;
  readonly outputFormat: "m4a";
};

type RelayExtractAudioFromVideoResult =
  | { readonly ok: true; readonly audioBase64: string; readonly mimeType: "audio/mp4" }
  | {
      readonly ok: false;
      readonly code:
        | "FFMPEG_MISSING"
        | "FFMPEG_UNAVAILABLE"
        | "INVALID_MP4"
        | "NO_AUDIO_STREAM"
        | "EXTRACTION_FAILED"
        | "OUTPUT_TOO_LARGE";
      readonly message: string;
    };

function isMp4Bytes(bytes: Buffer): boolean {
  return bytes.byteLength >= 12 && bytes.subarray(4, 8).equals(Buffer.from("ftyp"));
}

function decodeBoundedCanonicalBase64(
  value: string,
): { ok: true; bytes: Buffer } | { ok: false } {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_MEDIA_BYTES ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return { ok: false };
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > RELAY_FS_MAX_BYTES) return { ok: false };
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === decodedLength && bytes.toString("base64") === value
    ? { ok: true, bytes }
    : { ok: false };
}

function mediaExtractionError(
  code: Extract<RelayExtractAudioFromVideoResult, { ok: false }>["code"],
  message: string,
): RelayDispatchResult {
  return {
    status: "ok",
    result: {
      ok: false,
      code,
      message,
    } satisfies RelayExtractAudioFromVideoResult,
  };
}

function mediaSessionError(message: string): RelayDispatchResult {
  return { status: "error", error: message };
}

function decodeMediaChunk(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(RELAY_MEDIA_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= RELAY_MEDIA_CHUNK_BYTES &&
    bytes.toString("base64") === value
    ? bytes
    : null;
}

async function extractAudioFromVideo(
  request: RelayDispatchRequest,
  probeFfmpeg: () => Promise<FfmpegProbeResult>,
  execFile: MediaExecFile,
): Promise<RelayDispatchResult> {
  if (request.impact !== "high" || !request.approvalObtained) {
    return {
      status: "error",
      error:
        "extract_audio_from_video requires high impact and approvalObtained=true from the server.",
    };
  }
  if (
    typeof request.args["sourceBase64"] !== "string" ||
    request.args["outputFormat"] !== "m4a" ||
    Object.keys(request.args).some(
      (key) => key !== "sourceBase64" && key !== "outputFormat",
    )
  ) {
    return mediaExtractionError(
      "EXTRACTION_FAILED",
      "Malformed extract_audio_from_video request: only sourceBase64 and outputFormat=\"m4a\" are accepted.",
    );
  }
  const args: RelayExtractAudioFromVideoRequest = {
    sourceBase64: request.args["sourceBase64"],
    outputFormat: "m4a",
  };
  const decodedSource = decodeBoundedCanonicalBase64(args.sourceBase64);
  if (!decodedSource.ok || !isMp4Bytes(decodedSource.bytes)) {
    return mediaExtractionError(
      "INVALID_MP4",
      "Input is not a supported MP4 within the relay media size limit.",
    );
  }

  const ffmpeg = await probeFfmpeg();
  if (!ffmpeg.ok) return mediaExtractionError(ffmpeg.code, ffmpeg.message);

  let tempDir: string | null = null;
  try {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-extract-"));
    const inputPath = path.join(tempDir, "input.mp4");
    const outputPath = path.join(tempDir, "output.m4a");
    await fsp.writeFile(inputPath, decodedSource.bytes, { mode: 0o600 });
    await execFile(ffmpeg.bin, [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath,
    ], {
      timeout: MEDIA_EXTRACT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const outputStat = await fsp.stat(outputPath);
    if (outputStat.size <= 0) {
      return mediaExtractionError(
        "EXTRACTION_FAILED",
        "ffmpeg produced an empty audio output.",
      );
    }
    if (outputStat.size > RELAY_FS_MAX_BYTES) {
      return mediaExtractionError(
        "OUTPUT_TOO_LARGE",
        `Extracted audio is ${outputStat.size} bytes, exceeding the ${RELAY_FS_MAX_BYTES}-byte relay media limit.`,
      );
    }
    const audio = await fsp.readFile(outputPath);
    return {
      status: "ok",
      result: {
        ok: true,
        audioBase64: audio.toString("base64"),
        mimeType: "audio/mp4",
      } satisfies RelayExtractAudioFromVideoResult,
    };
  } catch (error) {
    return classifyExtractionFailure(error, true);
  } finally {
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function classifyExtractionFailure(
  errorValue: unknown,
  includeMessage: boolean,
): RelayDispatchResult {
  const error = errorValue as {
    readonly code?: string;
    readonly stderr?: string;
    readonly stdout?: string;
    readonly killed?: boolean;
    readonly message?: string;
  };
  if (error.code === "ENOENT") {
    return mediaExtractionError(
      "FFMPEG_MISSING",
      "Managed FFmpeg is not available on this desktop relay. Repackage with the vendored runtime and retry.",
    );
  }
  if (
    error.killed ||
    error.code === "SIGABRT" ||
    /dyld|library not loaded|abort/i.test(error.stderr ?? "")
  ) {
    return mediaExtractionError(
      "FFMPEG_UNAVAILABLE",
      "Managed FFmpeg became unavailable on this desktop relay. Repackage with the vendored runtime and retry.",
    );
  }
  const detail = (
    error.stderr ??
    error.stdout ??
    (includeMessage ? error.message : undefined) ??
    ""
  ).trim();
  if (
    /does not contain any stream|matches no streams|output file .* does not contain any stream/i.test(
      detail,
    )
  ) {
    return mediaExtractionError(
      "NO_AUDIO_STREAM",
      "The MP4 does not contain an extractable audio stream.",
    );
  }
  if (/invalid data found|moov atom not found|not a valid mp4/i.test(detail)) {
    return mediaExtractionError("INVALID_MP4", "Input is not a supported MP4 file.");
  }
  return mediaExtractionError(
    "EXTRACTION_FAILED",
    "ffmpeg could not extract audio from this MP4.",
  );
}

async function dispatchMediaSession(
  request: RelayDispatchRequest,
  sessions: MediaSessionsPort,
  probeFfmpeg: () => Promise<FfmpegProbeResult>,
  execFile: MediaExecFile,
): Promise<RelayDispatchResult> {
  if (request.impact !== "high" || !request.approvalObtained) {
    return mediaSessionError("chunked media transport requires server approval");
  }
  sessions.expire();
  const sessionId = request.args["sessionId"];
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return mediaSessionError("invalid media session identity");
  }

  if (request.toolName === "media_extract_start") {
    const totalBytes = request.args["totalBytes"];
    const chunkCount = request.args["chunkCount"];
    if (
      request.args["outputFormat"] !== "m4a" ||
      typeof totalBytes !== "number" ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      totalBytes > RELAY_MEDIA_MAX_BYTES ||
      typeof chunkCount !== "number" ||
      !Number.isSafeInteger(chunkCount) ||
      chunkCount !== Math.ceil(totalBytes / RELAY_MEDIA_CHUNK_BYTES) ||
      sessions.has(sessionId) ||
      sessions.size() >= MAX_MEDIA_SESSIONS ||
      sessions.getBufferedBytes() + totalBytes > MAX_MEDIA_BUFFERED_BYTES
    ) {
      return mediaSessionError("invalid media transfer start");
    }
    sessions.set(sessionId, {
      source: [],
      expectedIndex: 0,
      chunkCount,
      totalBytes,
      receivedBytes: 0,
      createdAt: Date.now(),
    });
    return { status: "ok", result: { ok: true } };
  }

  const session = sessions.get(sessionId);
  if (!session) return mediaSessionError("unknown or expired media session");

  if (request.toolName === "media_extract_chunk") {
    const index = request.args["index"];
    if (
      !Number.isSafeInteger(index) ||
      index !== session.expectedIndex ||
      request.args["chunkCount"] !== session.chunkCount
    ) {
      sessions.release(sessionId);
      return mediaSessionError("out-of-order media chunk");
    }
    const chunk = decodeMediaChunk(request.args["data"]);
    const remaining = session.totalBytes - session.receivedBytes;
    if (
      !chunk ||
      chunk.byteLength <= 0 ||
      chunk.byteLength > remaining ||
      (index < session.chunkCount - 1 &&
        chunk.byteLength !== RELAY_MEDIA_CHUNK_BYTES)
    ) {
      sessions.release(sessionId);
      return mediaSessionError("malformed or oversized media chunk");
    }
    if (
      sessions.getBufferedBytes() + chunk.byteLength >
      MAX_MEDIA_BUFFERED_BYTES
    ) {
      sessions.release(sessionId);
      return mediaSessionError("media aggregate buffer limit exceeded");
    }
    session.source.push(chunk);
    session.receivedBytes += chunk.byteLength;
    sessions.adjustBufferedBytes(chunk.byteLength);
    session.expectedIndex++;
    return { status: "ok", result: { ok: true } };
  }

  if (request.toolName === "media_extract_finish") {
    if (
      session.expectedIndex !== session.chunkCount ||
      session.receivedBytes !== session.totalBytes
    ) {
      sessions.release(sessionId);
      return mediaSessionError("incomplete media transfer");
    }
    const source = Buffer.concat(session.source);
    if (!isMp4Bytes(source)) {
      sessions.release(sessionId);
      return mediaSessionError("invalid MP4 input");
    }
    const ffmpeg = await probeFfmpeg();
    if (!ffmpeg.ok) {
      sessions.release(sessionId);
      return mediaExtractionError(ffmpeg.code, ffmpeg.message);
    }
    const tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "nautilo-media-extract-"),
    );
    try {
      const inputPath = path.join(tempDir, "input.mp4");
      const outputPath = path.join(tempDir, "output.m4a");
      await fsp.writeFile(inputPath, source, { mode: 0o600 });
      await execFile(ffmpeg.bin, [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ], {
        timeout: MEDIA_EXTRACT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      const audio = await fsp.readFile(outputPath);
      if (
        audio.byteLength <= 0 ||
        audio.byteLength > RELAY_MEDIA_MAX_BYTES ||
        sessions.getBufferedBytes() - session.receivedBytes + audio.byteLength >
          MAX_MEDIA_BUFFERED_BYTES
      ) {
        sessions.release(sessionId);
        return mediaSessionError("extracted audio exceeds media buffer cap");
      }
      sessions.adjustBufferedBytes(-session.receivedBytes);
      session.receivedBytes = 0;
      session.audio = audio;
      session.source = [];
      sessions.adjustBufferedBytes(audio.byteLength);
      return {
        status: "ok",
        result: {
          ok: true,
          totalBytes: audio.byteLength,
          chunkCount: Math.ceil(audio.byteLength / RELAY_MEDIA_CHUNK_BYTES),
          sha256: createHash("sha256").update(audio).digest("hex"),
          mimeType: "audio/mp4",
        },
      };
    } catch (error) {
      sessions.release(sessionId);
      return classifyExtractionFailure(error, false);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (request.toolName === "media_extract_output_chunk") {
    const index = request.args["index"];
    const audio = session.audio;
    const count = audio
      ? Math.ceil(audio.byteLength / RELAY_MEDIA_CHUNK_BYTES)
      : 0;
    if (
      !audio ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      request.args["chunkCount"] !== count
    ) {
      return mediaSessionError("invalid audio output chunk request");
    }
    const data = audio
      .subarray(
        index * RELAY_MEDIA_CHUNK_BYTES,
        Math.min(audio.byteLength, (index + 1) * RELAY_MEDIA_CHUNK_BYTES),
      )
      .toString("base64");
    if (index === count - 1) sessions.release(sessionId);
    return {
      status: "ok",
      result: { ok: true, index, chunkCount: count, data },
    };
  }

  return mediaSessionError("unknown media transport operation");
}

/** Fixed media adapter over relay-owned transfer sessions and managed FFmpeg. */
export function createMediaDispatchHandler(ports: {
  readonly sessions: MediaSessionsPort;
  readonly probeFfmpeg: () => Promise<FfmpegProbeResult>;
  readonly execFile?: MediaExecFile;
}): FixedDesktopDispatchHandler {
  const execFile = ports.execFile ?? defaultExecFile;
  return async ({ request }) => {
    if (request.toolName === "extract_audio_from_video") {
      return {
        handled: true,
        result: await extractAudioFromVideo(request, ports.probeFfmpeg, execFile),
      };
    }
    if (
      request.toolName === "media_extract_start" ||
      request.toolName === "media_extract_chunk" ||
      request.toolName === "media_extract_finish" ||
      request.toolName === "media_extract_output_chunk"
    ) {
      return {
        handled: true,
        result: await dispatchMediaSession(
          request,
          ports.sessions,
          ports.probeFfmpeg,
          execFile,
        ),
      };
    }
    return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
  };
}
