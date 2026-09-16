import { desktopVideoEncoderArgs } from "./video-encoder";
/**
 * D385 Phase 0 disk-to-disk media executor.
 *
 * This is intentionally not wired to relay transport yet. It accepts the
 * shared, authority-free control frame, and the injected host resolver is the
 * only seam permitted to convert an opaque source ref into a local path.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE,
  MEDIA_PROCESS_PROTOCOL_VERSION,
  parseMediaProcessRequest,
  parseMediaProcessProgress,
  parseMediaProcessResult,
  type MediaProcessFailureCode,
  type MediaProcessProgress,
  type MediaProcessRequest,
  type MediaProcessResult,
} from "@nautilo/relay";

const MAX_PROGRESS_LINE_BYTES = 1024;
const CANCEL_KILL_GRACE_MS = 5_000;
const PROCESS_DEADLINE_MS = 10 * 60_000;
const POST_KILL_WAIT_MS = 5_000;
const MP4_COMPATIBLE_BRANDS = new Set(["isom", "iso2", "avc1", "mp41", "mp42"]);

export interface MediaProcessFileStat {
  readonly size: number;
  isFile(): boolean;
}

export interface MediaProcessDependencies {
  /** Host-only authority resolution; the resulting canonical path is private. */
  readonly resolveSource: (
    sourceRef: string,
  ) => Promise<{ readonly ok: true; readonly canonicalPath: string } | { readonly ok: false }>;
  /** The managed bundled runtime resolver; never caller-supplied. */
  readonly resolveFfmpeg: () => Promise<{ readonly ok: true; readonly binaryPath: string } | { readonly ok: false }>;
  /**
   * Trusted host seam: atomically take ownership (move/copy) of the already
   * validated private file before resolving an opaque ref. This executor does
   * not claim to solve post-validation TOCTOU; that is registrar authority.
   */
  readonly registerOutput: (input: {
    readonly outputPath: string;
    readonly operation: "transcode_proxy";
    readonly mimeType: "video/mp4";
    readonly sizeBytes: number;
    readonly signal: AbortSignal | undefined;
  }) => Promise<{ readonly ok: true; readonly outputRef: string } | { readonly ok: false }>;
  /** Undo a successfully registered opaque output when cancellation wins. */
  readonly discardOutput: (outputRef: string) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: MediaProcessProgress) => void) | undefined;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: readonly ["ignore", "ignore", "pipe"] },
  ) => ChildProcess;
  readonly makeTempDir?: () => Promise<string>;
  readonly removeTempDir?: (tempDir: string) => Promise<void>;
  readonly stat?: (filePath: string) => Promise<MediaProcessFileStat>;
  /** Bounded output-only inspection. It must never receive the source path. */
  readonly readOutputHeader?: (filePath: string) => Promise<Uint8Array>;
  readonly cancelKillGraceMs?: number | undefined;
  readonly processDeadlineMs?: number | undefined;
  readonly postKillWaitMs?: number | undefined;
}

function resultBase(request: MediaProcessRequest) {
  return {
    type: "relay:media-process-result" as const,
    version: MEDIA_PROCESS_PROTOCOL_VERSION,
    requestId: request.requestId,
  };
}

function failed(request: MediaProcessRequest, code: MediaProcessFailureCode): MediaProcessResult {
  return { ...resultBase(request), status: "failed", code };
}

function cancelled(request: MediaProcessRequest): MediaProcessResult {
  return { ...resultBase(request), status: "cancelled" };
}

function proxyArgs(inputPath: string, outputPath: string): string[] {
  // Only host-derived canonical/private paths participate in this argv.
  return [
    "-hide_banner", "-nostdin", "-y", "-i", inputPath,
    "-map", "0:v:0?", "-map", "0:a?",
    ...desktopVideoEncoderArgs(),
    "-c:a", "aac", "-movflags", "+faststart",
    "-progress", "pipe:2", "-nostats",
    outputPath,
  ];
}

async function defaultTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-process-"));
}

async function defaultRemoveTempDir(tempDir: string): Promise<void> {
  await fsp.rm(tempDir, { recursive: true, force: true });
}

async function defaultReadOutputHeader(filePath: string): Promise<Uint8Array> {
  const handle = await fsp.open(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isMp4Header(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const boxSize = Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.byteLength) return false;
  if (!Buffer.from(bytes.subarray(4, 8)).equals(Buffer.from("ftyp"))) return false;
  return MP4_COMPATIBLE_BRANDS.has(Buffer.from(bytes.subarray(8, 12)).toString("ascii"));
}

function observeProgress(
  child: ChildProcess,
  request: MediaProcessRequest,
  report: ((progress: MediaProcessProgress) => void) | undefined,
  nextSequence: () => number | null,
): void {
  // Always consume stderr: FFmpeg's -progress pipe can otherwise fill and
  // block even when this executor has no UI observer.
  if (child.stderr === null) return;
  let tail = "";
  let lastProcessedTimeUs = -1;
  child.stderr.on("data", (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = `${tail}${text}`.split(/\r?\n/);
    tail = lines.pop() ?? "";
    if (Buffer.byteLength(tail, "utf8") > MAX_PROGRESS_LINE_BYTES) tail = "";
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_PROGRESS_LINE_BYTES) continue;
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (!match) continue;
      const processedTimeUs = Number(match[1]);
      if (!Number.isSafeInteger(processedTimeUs) || processedTimeUs <= lastProcessedTimeUs) continue;
      lastProcessedTimeUs = processedTimeUs;
      if (!report) continue;
      const sequence = nextSequence();
      if (sequence === null) continue;
      const progress: MediaProcessProgress = {
        type: "relay:media-process-progress",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId: request.requestId,
        stage: "transcoding",
        sequence,
        processedTimeUs,
      };
      if (!parseMediaProcessProgress(progress).ok) continue;
      try {
        report(progress);
      } catch {
        // Progress is observational, never execution authority.
      }
    }
  });
}

type ProcessTerminal = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

function createTerminalWaiter(child: ChildProcess): { wait: (timeoutMs: number) => Promise<ProcessTerminal | null> } {
  let terminal: ProcessTerminal | undefined;
  let resolveTerminal: ((value: ProcessTerminal) => void) | undefined;
  const settled = new Promise<ProcessTerminal>((resolve) => { resolveTerminal = resolve; });
  const finish = (value: ProcessTerminal): void => {
    if (terminal !== undefined) return;
    terminal = value;
    resolveTerminal?.(value);
  };
  child.once("close", (code, signal) => finish({
    code: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? signal : null,
  }));
  child.once("error", () => finish({ code: null, signal: null }));
  return {
    wait: async (timeoutMs: number): Promise<ProcessTerminal | null> => {
      if (terminal !== undefined) return terminal;
      return await new Promise<ProcessTerminal | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        void settled.then((value) => { clearTimeout(timer); resolve(value); });
      });
    },
  };
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); } catch { /* terminal waiter decides the outcome */ }
}

/**
 * Executes exactly the shared `transcode_proxy` request. Parsing occurs before
 * source resolution, stat, temp allocation, or spawn, so raw paths, URLs,
 * argv, bytes, and unknown keys cannot cross this public boundary.
 */
export async function executeMediaProcess(
  rawRequest: unknown,
  dependencies: MediaProcessDependencies,
): Promise<MediaProcessResult> {
  const parsed = parseMediaProcessRequest(rawRequest);
  if (!parsed.ok) {
    // A malformed frame has no trustworthy requestId for a terminal receipt.
    return {
      type: "relay:media-process-result",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: "invalid",
      status: "failed",
      code: "invalid_request",
    };
  }
  const request = parsed.value;
  if (dependencies.signal?.aborted) return cancelled(request);

  let tempDir: string | null = null;
  let removeAbortListener: (() => void) | undefined;
  let wasCancelled = false;
  let sequence = 0;
  const nextSequence = (): number | null =>
    sequence < MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE ? ++sequence : null;
  const progress = (stage: "queued" | "preparing"): void => {
    if (!dependencies.onProgress) return;
    const next = nextSequence();
    if (next === null) return;
    const event: MediaProcessProgress = {
      type: "relay:media-process-progress",
      version: MEDIA_PROCESS_PROTOCOL_VERSION,
      requestId: request.requestId,
      stage,
      sequence: next,
    };
    if (!parseMediaProcessProgress(event).ok) return;
    try {
      dependencies.onProgress(event);
    } catch { /* observer cannot alter process truth */ }
  };

  try {
    progress("queued");
    const source = await dependencies.resolveSource(request.sourceRef);
    if (!source.ok) return failed(request, "source_unavailable");
    if (dependencies.signal?.aborted) return cancelled(request);
    // Metadata only: source bytes are never read, buffered, or sent anywhere.
    const sourceStat = await (dependencies.stat ?? fsp.stat)(source.canonicalPath);
    if (dependencies.signal?.aborted) return cancelled(request);
    if (!sourceStat.isFile() || sourceStat.size <= 0) return failed(request, "source_unavailable");

    const ffmpeg = await dependencies.resolveFfmpeg();
    if (!ffmpeg.ok) return failed(request, "ffmpeg_unavailable");
    if (dependencies.signal?.aborted) return cancelled(request);
    progress("preparing");
    tempDir = await (dependencies.makeTempDir ?? defaultTempDir)();
    if (dependencies.signal?.aborted) return cancelled(request);
    const outputPath = path.join(tempDir, "output.mp4");
    const child = (dependencies.spawn ?? nodeSpawn)(ffmpeg.binaryPath, proxyArgs(source.canonicalPath, outputPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const terminal = createTerminalWaiter(child);
    observeProgress(child, request, dependencies.onProgress, nextSequence);
    let resolveAbortRace: (() => void) | undefined;
    const abortRace = new Promise<void>((resolve) => { resolveAbortRace = resolve; });
    const abort = () => {
      if (wasCancelled) return;
      wasCancelled = true;
      kill(child, "SIGTERM");
      resolveAbortRace?.();
    };
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => dependencies.signal?.removeEventListener("abort", abort);
    if (dependencies.signal?.aborted) abort();
    const initial = await Promise.race([
      terminal.wait(boundedDuration(dependencies.processDeadlineMs, PROCESS_DEADLINE_MS)).then((value) => ({ kind: "terminal" as const, value })),
      abortRace.then(() => ({ kind: "aborted" as const })),
    ]);
    let exit: ProcessTerminal | null;
    if (initial.kind === "aborted") {
      exit = await terminal.wait(boundedDuration(dependencies.cancelKillGraceMs, CANCEL_KILL_GRACE_MS));
      if (exit === null) {
        kill(child, "SIGKILL");
        exit = await terminal.wait(boundedDuration(dependencies.postKillWaitMs, POST_KILL_WAIT_MS));
      }
      removeAbortListener?.();
      removeAbortListener = undefined;
      // A user-cancel terminal receipt is bounded even if a pathological child
      // never reports close/error after SIGKILL. It never reaches registration.
      return cancelled(request);
    }
    exit = initial.value;
    if (exit === null) {
      kill(child, "SIGTERM");
      exit = await terminal.wait(boundedDuration(dependencies.cancelKillGraceMs, CANCEL_KILL_GRACE_MS));
      if (exit === null) {
        kill(child, "SIGKILL");
        await terminal.wait(boundedDuration(dependencies.postKillWaitMs, POST_KILL_WAIT_MS));
      }
      return failed(request, "timed_out");
    }
    removeAbortListener();
    removeAbortListener = undefined;
    if (wasCancelled || dependencies.signal?.aborted) return cancelled(request);
    if (exit.code !== 0 || exit.signal !== null) return failed(request, "processing_failed");

    const outputStat = await (dependencies.stat ?? fsp.stat)(outputPath);
    if (wasCancelled || dependencies.signal?.aborted) return cancelled(request);
    if (!outputStat.isFile() || !Number.isSafeInteger(outputStat.size) || outputStat.size <= 0) return failed(request, "invalid_output");
    const header = await (dependencies.readOutputHeader ?? defaultReadOutputHeader)(outputPath);
    if (wasCancelled || dependencies.signal?.aborted) return cancelled(request);
    if (!isMp4Header(header)) return failed(request, "invalid_output");
    if (wasCancelled || dependencies.signal?.aborted) return cancelled(request);
    const registered = await dependencies.registerOutput({
      outputPath,
      operation: request.operation,
      mimeType: "video/mp4",
      sizeBytes: outputStat.size,
      signal: dependencies.signal,
    });
    if (wasCancelled || dependencies.signal?.aborted) {
      if (registered.ok) await dependencies.discardOutput(registered.outputRef);
      return cancelled(request);
    }
    if (!registered.ok) return failed(request, "output_registration_failed");
    const success: MediaProcessResult = {
      ...resultBase(request),
      status: "succeeded",
      outputRef: registered.outputRef,
      mimeType: "video/mp4",
      sizeBytes: outputStat.size,
    };
    return parseMediaProcessResult(success).ok ? success : failed(request, "output_registration_failed");
  } catch {
    return wasCancelled || dependencies.signal?.aborted
      ? cancelled(request)
      : failed(request, "processing_failed");
  } finally {
    removeAbortListener?.();
    if (tempDir !== null) await (dependencies.removeTempDir ?? defaultRemoveTempDir)(tempDir).catch(() => {});
  }
}
