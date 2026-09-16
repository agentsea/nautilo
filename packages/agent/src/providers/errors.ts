/**
 * Provider-layer error types and formatting helpers.
 *
 * These live alongside the provider factories (rather than the
 * domain `errors/` module) because they are tightly coupled to the
 * upstream HTTP-client error shapes — `APIError` from
 * `@anthropic-ai/sdk` and `openai` (which our LangChain wrappers
 * wrap), and the ad-hoc `[GoogleGenerativeAI Error]` strings.
 *
 * We never put raw upstream bodies into user-facing strings; the
 * formatter below is for SERVER-SIDE log lines only.
 */

/** Default per-provider request timeout (ms). */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export type ProviderTimeoutKind =
  | "first_progress_timeout"
  | "progress_idle_timeout"
  | "absolute_timeout";

export interface ProviderTimeoutDetails {
  readonly kind: ProviderTimeoutKind;
  readonly attemptId: string;
  readonly policyProvenance: Readonly<Record<string, unknown>>;
  readonly elapsedMs: number;
  readonly visibleOutput: boolean;
  readonly partialState: boolean;
  readonly abortRequested: boolean;
  readonly safeToFallback: boolean;
}

/**
 * Thrown when a provider invocation exceeds its timeout budget.
 *
 * Supervised safe outcomes may use the existing bounded same-model retry.
 * Cross-model fallback remains subject to caller policy and output visibility.
 */
export class ProviderTimeoutError extends Error {
  readonly code = "NAUTILO_PROVIDER_TIMEOUT" as const;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly details: ProviderTimeoutDetails | undefined;

  constructor(modelId: string, timeoutMs: number, details?: ProviderTimeoutDetails) {
    super(
      `Provider request timed out after ${timeoutMs}ms for ${modelId}`,
    );
    this.name = "ProviderTimeoutError";
    this.modelId = modelId;
    this.timeoutMs = timeoutMs;
    this.details = details;
  }
}

export function isProviderTimeoutError(error: unknown): error is ProviderTimeoutError {
  return error instanceof ProviderTimeoutError;
}

/** Retry only supervised requests aborted before any assistant output was delivered. */
export function isSafelyRetryableProviderTimeout(error: unknown): error is ProviderTimeoutError & { details: ProviderTimeoutDetails } {
  return isProviderTimeoutError(error) && error.details?.abortRequested === true
    && error.details.safeToFallback === true && error.details.visibleOutput === false;
}

interface AnyRecord {
  [k: string]: unknown;
}

function pickString(obj: AnyRecord | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(obj: AnyRecord | undefined, key: string): number | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const HEADER_ALLOWLIST = [
  "x-request-id",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "retry-after",
  "openai-organization",
  "anthropic-request-id",
];

function pickHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  // Headers can be a Headers instance, a plain object, or a Map.
  // Handle them all without touching values outside the allowlist —
  // upstream auth tokens occasionally leak through `set-cookie`-like
  // headers and we don't want to log those.
  const entries: Array<[string, unknown]> = (() => {
    if (typeof (raw as { entries?: () => IterableIterator<[string, unknown]> }).entries === "function") {
      try {
        return Array.from((raw as { entries: () => IterableIterator<[string, unknown]> }).entries());
      } catch {
        return [];
      }
    }
    return Object.entries(raw as Record<string, unknown>);
  })();
  for (const [k, v] of entries) {
    const lk = String(k).toLowerCase();
    if (!HEADER_ALLOWLIST.includes(lk)) continue;
    if (typeof v === "string") out[lk] = v;
    else if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) out[lk] = v.join(", ");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Format an upstream provider error into a single rich log line for
 * server logs. Captures all the structured fields the OpenAI / Anthropic
 * SDKs surface on `APIError`:
 *
 *   - HTTP `status` / `statusCode`
 *   - `error.type`, `error.code`, `error.param`, `error.message`
 *   - request id + rate-limit headers (allowlisted)
 *
 * Falls back gracefully when the error doesn't match the SDK shape
 * (e.g. plain `Error` from `[GoogleGenerativeAI Error]` strings — the
 * Google SDK already inlines the body in the message).
 *
 * SECURITY: never put the output in user-facing error messages. The
 * `error.message` field can contain echoed user input or upstream
 * model output; keep it in server logs only.
 */
export function formatProviderError(err: unknown): string {
  if (err == null) return "unknown error (null)";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err !== "object") return `unknown error (${typeof err})`;

  const e = err as AnyRecord;
  const errorObj = e["error"] && typeof e["error"] === "object" ? (e["error"] as AnyRecord) : undefined;
  const responseObj = e["response"] && typeof e["response"] === "object" ? (e["response"] as AnyRecord) : undefined;

  const parts: string[] = [];
  if (err instanceof ProviderTimeoutError && err.details) {
    // Operator diagnosis only: never serialize arbitrary provider payloads or
    // reasoning text when recording why the local watchdog ended an attempt.
    const details = err.details;
    parts.push(`timeoutKind=${details.kind}`, `elapsedMs=${details.elapsedMs}`,
      `partialState=${details.partialState}`, `visibleOutput=${details.visibleOutput}`,
      `abortRequested=${details.abortRequested}`, `safeToFallback=${details.safeToFallback}`);
  }
  const status =
    pickNumber(e, "status") ??
    pickNumber(e, "statusCode") ??
    pickNumber(responseObj, "status");
  if (status !== undefined) parts.push(`status=${status}`);

  const errType = pickString(errorObj, "type") ?? pickString(e, "type");
  if (errType) parts.push(`type=${errType}`);

  const errCode = pickString(errorObj, "code") ?? pickString(e, "code");
  if (errCode) parts.push(`code=${errCode}`);

  const errParam = pickString(errorObj, "param") ?? pickString(e, "param");
  if (errParam) parts.push(`param=${errParam}`);

  const errMessage =
    pickString(errorObj, "message") ??
    pickString(e, "message") ??
    (err instanceof Error ? err.message : undefined);
  if (errMessage) parts.push(`message=${JSON.stringify(errMessage)}`);

  const headers = pickHeaders(e["headers"]) ?? pickHeaders(responseObj?.["headers"]);
  if (headers) {
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    parts.push(`headers=[${headerStr}]`);
  }

  if (parts.length === 0) {
    if (err instanceof Error) return err.message || err.name;
    try {
      return JSON.stringify(err);
    } catch {
      return "unknown error (unserializable object)";
    }
  }
  return parts.join(" ");
}
