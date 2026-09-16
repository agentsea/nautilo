/**
 * D385 Phase 0 media-process control plane.
 *
 * This deliberately carries authority-free control facts only. Source and
 * output references are opaque host-minted tokens; this protocol must never
 * be widened to transport paths, URLs, bytes, or executable arguments.
 */
export const MEDIA_PROCESS_PROTOCOL_VERSION = 1 as const;
export const MEDIA_PROCESS_MAX_FRAME_BYTES = 8 * 1024;
export const MEDIA_PROCESS_MAX_OPAQUE_ID_BYTES = 256;
export const MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE = 1_000_000_000;

export type MediaProcessOperation = "transcode_proxy";
export type MediaProcessProgressStage = "queued" | "preparing" | "transcoding";
export type MediaProcessFailureCode =
  | "invalid_request"
  | "source_unavailable"
  | "ffmpeg_unavailable"
  | "resource_limit"
  | "timed_out"
  | "processing_failed"
  | "invalid_output"
  | "output_registration_failed";

/** One closed operation; no caller-provided codec, path, URL, or argv exists. */
export type MediaProcessRequest = Readonly<{
  type: "relay:media-process-request";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  operation: "transcode_proxy";
  sourceRef: string;
}>;

/**
 * Setup emits no invented completion estimate. Consumers, not the parser,
 * enforce monotonic sequence ordering for their particular transport.
 */
export type MediaProcessSetupProgress = Readonly<{
  type: "relay:media-process-progress";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  stage: "queued" | "preparing";
  sequence: number;
}>;

/** FFmpeg's monotonic `out_time_us` projection, without claiming a percent. */
export type MediaProcessTranscodingProgress = Readonly<{
  type: "relay:media-process-progress";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  stage: "transcoding";
  sequence: number;
  processedTimeUs: number;
}>;

export type MediaProcessProgress =
  | MediaProcessSetupProgress
  | MediaProcessTranscodingProgress;

export type MediaProcessSucceededResult = Readonly<{
  type: "relay:media-process-result";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  status: "succeeded";
  outputRef: string;
  mimeType: "video/mp4";
  sizeBytes: number;
}>;

export type MediaProcessCancelledResult = Readonly<{
  type: "relay:media-process-result";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  status: "cancelled";
}>;

export type MediaProcessFailedResult = Readonly<{
  type: "relay:media-process-result";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
  status: "failed";
  code: MediaProcessFailureCode;
}>;

export type MediaProcessResult =
  | MediaProcessSucceededResult
  | MediaProcessCancelledResult
  | MediaProcessFailedResult;

/** Cancellation is correlated only; it carries no user text or process signal. */
export type MediaProcessCancel = Readonly<{
  type: "relay:media-process-cancel";
  version: typeof MEDIA_PROCESS_PROTOCOL_VERSION;
  requestId: string;
}>;

export type MediaProcessMessage =
  | MediaProcessRequest
  | MediaProcessProgress
  | MediaProcessResult
  | MediaProcessCancel;

export type MediaProcessParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: "MEDIA_PROCESS_FRAME_INVALID" }>;

export function parseMediaProcessRequest(value: unknown): MediaProcessParseResult<MediaProcessRequest> {
  return isRecord(value)
    && exact(value, ["type", "version", "requestId", "operation", "sourceRef"])
    && value["type"] === "relay:media-process-request"
    && version(value["version"])
    && opaqueId(value["requestId"])
    && value["operation"] === "transcode_proxy"
    && opaqueId(value["sourceRef"])
    ? valid(value as MediaProcessRequest)
    : invalid();
}

export function parseMediaProcessProgress(value: unknown): MediaProcessParseResult<MediaProcessProgress> {
  if (!isRecord(value)
    || value["type"] !== "relay:media-process-progress"
    || !version(value["version"])
    || !opaqueId(value["requestId"])
    || !sequence(value["sequence"])) return invalid();
  if (value["stage"] === "queued" || value["stage"] === "preparing") {
    return exact(value, ["type", "version", "requestId", "stage", "sequence"])
      ? valid(value as MediaProcessSetupProgress)
      : invalid();
  }
  return value["stage"] === "transcoding"
    && exact(value, ["type", "version", "requestId", "stage", "sequence", "processedTimeUs"])
    && processedTimeUs(value["processedTimeUs"])
    ? valid(value as MediaProcessTranscodingProgress)
    : invalid();
}

export function parseMediaProcessResult(value: unknown): MediaProcessParseResult<MediaProcessResult> {
  if (!isRecord(value) || value["type"] !== "relay:media-process-result" || !version(value["version"]) || !opaqueId(value["requestId"])) {
    return invalid();
  }
  if (value["status"] === "succeeded") {
    return exact(value, ["type", "version", "requestId", "status", "outputRef", "mimeType", "sizeBytes"])
      && opaqueId(value["outputRef"])
      && value["mimeType"] === "video/mp4"
      && outputSize(value["sizeBytes"])
      ? valid(value as MediaProcessSucceededResult)
      : invalid();
  }
  if (value["status"] === "cancelled") {
    return exact(value, ["type", "version", "requestId", "status"])
      ? valid(value as MediaProcessCancelledResult)
      : invalid();
  }
  return value["status"] === "failed"
    && exact(value, ["type", "version", "requestId", "status", "code"])
    && failureCode(value["code"])
    ? valid(value as MediaProcessFailedResult)
    : invalid();
}

export function parseMediaProcessCancel(value: unknown): MediaProcessParseResult<MediaProcessCancel> {
  return isRecord(value)
    && exact(value, ["type", "version", "requestId"])
    && value["type"] === "relay:media-process-cancel"
    && version(value["version"])
    && opaqueId(value["requestId"])
    ? valid(value as MediaProcessCancel)
    : invalid();
}

export function parseMediaProcessMessage(value: unknown): MediaProcessParseResult<MediaProcessMessage> {
  if (!isRecord(value) || typeof value["type"] !== "string") return invalid();
  switch (value["type"]) {
    case "relay:media-process-request": return parseMediaProcessRequest(value);
    case "relay:media-process-progress": return parseMediaProcessProgress(value);
    case "relay:media-process-result": return parseMediaProcessResult(value);
    case "relay:media-process-cancel": return parseMediaProcessCancel(value);
    default: return invalid();
  }
}

export function parseMediaProcessJsonFrame(raw: string): MediaProcessParseResult<MediaProcessMessage> {
  if (byteLength(raw) > MEDIA_PROCESS_MAX_FRAME_BYTES) return invalid();
  try {
    return parseMediaProcessMessage(JSON.parse(raw) as unknown);
  } catch {
    return invalid();
  }
}

function version(value: unknown): value is typeof MEDIA_PROCESS_PROTOCOL_VERSION {
  return value === MEDIA_PROCESS_PROTOCOL_VERSION;
}

function sequence(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MEDIA_PROCESS_MAX_PROGRESS_SEQUENCE;
}

function processedTimeUs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function outputSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

function failureCode(value: unknown): value is MediaProcessFailureCode {
  return value === "invalid_request"
    || value === "source_unavailable"
    || value === "ffmpeg_unavailable"
    || value === "resource_limit"
    || value === "timed_out"
    || value === "processing_failed"
    || value === "invalid_output"
    || value === "output_registration_failed";
}

/**
 * Opaque ids intentionally exclude path separators, URL syntax, and control
 * characters. The host alone resolves them to local or artifact authority.
 */
function opaqueId(value: unknown): value is string {
  return typeof value === "string"
    && byteLength(value) > 0
    && byteLength(value) <= MEDIA_PROCESS_MAX_OPAQUE_ID_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function valid<T>(value: T): MediaProcessParseResult<T> {
  return { ok: true, value };
}

function invalid(): MediaProcessParseResult<never> {
  return { ok: false, error: "MEDIA_PROCESS_FRAME_INVALID" };
}
