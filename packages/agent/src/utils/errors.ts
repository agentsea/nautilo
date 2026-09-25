import { sleep } from "./time";

export type ErrorCategory =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "TOKEN_LIMIT"
  | "SERVICE_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "UNKNOWN";

export type RetryStrategyKind = "none" | "immediate" | "standard" | "long_backoff";

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN",
  "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_MESSAGE_KEYWORDS = [
  "socket hang up", "other side closed", "fetch failed",
  "connection reset", "connection closed", "connection refused",
  "tls handshake", "unexpected eof", "terminated", "network error",
  "dns lookup", "econnreset", "econnrefused", "econnaborted",
  "enetunreach", "ehostunreach", "enotfound", "eai_again", "epipe",
  "und_err_socket", "und_err_connect_timeout",
  "und_err_headers_timeout", "und_err_body_timeout",
];

const TOKEN_LIMIT_KEYWORDS = [
  "token limit", "context length", "maximum context",
  "too many tokens", "max tokens", "prompt too long",
  "context_length_exceeded", "reduce the length",
];

const RATE_LIMIT_KEYWORDS = [
  "rate limit", "too many requests", "slow down", "quota",
  "insufficient_quota", "requests per minute", "requests per day", "429",
];

const AUTH_KEYWORDS = [
  "invalid api key", "incorrect api key", "no api key",
  "missing api key", "unauthorized", "forbidden",
  "permission denied", "access denied",
];

const SERVICE_KEYWORDS = [
  "overloaded", "temporarily unavailable", "service unavailable",
  "server busy", "bad gateway", "internal server error",
  "upstream error", "capacity",
];

export interface ClassifiedError {
  category: ErrorCategory;
  originalError: unknown;
  message: string;
  statusCode?: number;
  code?: string;
  provider?: string;
  retryable: boolean;
  retryStrategy?: RetryStrategyKind;
  retryAfterSeconds?: number;
}

export interface RetryStrategy {
  shouldRetry: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  jitter?: boolean;
  retryAfterMs?: number;
}

function readNested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractStatus(error: unknown): number | undefined {
  const candidates: Array<unknown> = [
    readNested(error, ["status"]), readNested(error, ["statusCode"]),
    readNested(error, ["httpStatus"]), readNested(error, ["response", "status"]),
    readNested(error, ["response", "statusCode"]), readNested(error, ["error", "status"]),
    readNested(error, ["cause", "status"]), readNested(error, ["cause", "response", "status"]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function extractCode(error: unknown): string | undefined {
  const candidates: Array<unknown> = [
    readNested(error, ["code"]), readNested(error, ["error", "code"]),
    readNested(error, ["error", "type"]),
    readNested(error, ["response", "data", "error", "type"]),
    readNested(error, ["response", "data", "error", "code"]),
    readNested(error, ["cause", "code"]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function extractProvider(error: unknown): string | undefined {
  const candidates: Array<unknown> = [
    readNested(error, ["provider"]),
    readNested(error, ["response", "data", "provider"]),
    readNested(error, ["cause", "provider"]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const code = extractCode(error)?.toLowerCase();
  if (code?.includes("openai")) return "openai";
  if (code?.includes("anthropic")) return "anthropic";
  const message = extractMessage(error).toLowerCase();
  if (message.includes("openai")) return "openai";
  if (message.includes("anthropic")) return "anthropic";
  if (message.includes("tavily")) return "tavily";
  return undefined;
}

interface HeadersLike { get: (name: string) => unknown; }

function extractRetryAfterSeconds(error: unknown): number | undefined {
  const headers = readNested(error, ["response", "headers"]);
  const headerValue =
    (typeof headers === "object" && headers !== null && "get" in headers && typeof (headers as HeadersLike).get === "function"
      ? (headers as HeadersLike).get("retry-after")
      : undefined) ?? readNested(error, ["retry_after"]) ?? readNested(error, ["error", "retry_after"]);
  if (typeof headerValue === "number" && Number.isFinite(headerValue)) return headerValue;
  if (typeof headerValue === "string" && headerValue.trim()) {
    const parsed = Number.parseFloat(headerValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message ?? String(error);
  const fromMessage = readNested(error, ["message"]);
  if (typeof fromMessage === "string" && fromMessage.trim()) return fromMessage;
  const nested = [
    readNested(error, ["error", "message"]),
    readNested(error, ["response", "data", "error", "message"]),
    readNested(error, ["response", "data", "message"]),
    readNested(error, ["data", "message"]),
    readNested(error, ["body", "message"]),
    readNested(error, ["cause", "message"]),
  ];
  for (const candidate of nested) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  if (error && typeof error === "object") {
    try { return JSON.stringify(error); } catch { return "error"; }
  }
  if (error == null) return "error";
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  return "error";
}

function hasKeyword(source: string, keywords: string[]): boolean {
  const lower = source.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function isTimeoutMessage(message: string, code?: string): boolean {
  if (code && code.toUpperCase() === "ETIMEDOUT") return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("aborterror") ||
    lower.includes("operation was aborted")
  );
}

/** Provider wording that usually means the chosen model cannot handle this modality (shared with chat fallback). */
export function messageImpliesCapabilityMismatch(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unsupported image") ||
    (lower.includes("does not support") &&
      (lower.includes("image") ||
        lower.includes("pdf") ||
        lower.includes("vision") ||
        lower.includes("multimodal") ||
        lower.includes("audio")))
  );
}

export function classifyError(error: unknown): ClassifiedError {
  const statusCode = extractStatus(error);
  const code = extractCode(error);
  const provider = extractProvider(error);
  const message = extractMessage(error);
  const messageLower = message.toLowerCase();
  const retryAfterSeconds = extractRetryAfterSeconds(error);
  const codeUpper = code?.toUpperCase();

  const networkCode = codeUpper ? NETWORK_ERROR_CODES.has(codeUpper) : false;
  const isNetworkMsg = hasKeyword(messageLower, NETWORK_MESSAGE_KEYWORDS);
  const timeout = isTimeoutMessage(messageLower, codeUpper);

  const auth = statusCode === 401 || statusCode === 403 ||
    hasKeyword(messageLower, AUTH_KEYWORDS) ||
    codeUpper === "AUTHENTICATION_ERROR" || codeUpper === "PERMISSION_ERROR";

  const rateLimit = statusCode === 429 ||
    hasKeyword(messageLower, RATE_LIMIT_KEYWORDS) ||
    codeUpper === "RATE_LIMIT_ERROR" || codeUpper === "INSUFFICIENT_QUOTA";

  const tokenLimit = hasKeyword(messageLower, TOKEN_LIMIT_KEYWORDS) || codeUpper === "CONTEXT_LENGTH_EXCEEDED"
    || codeUpper === "NAUTILO_PREPARED_CONTEXT_EXCEEDED";

  const serviceError =
    (typeof statusCode === "number" && [500, 502, 503, 504, 529].includes(statusCode)) ||
    hasKeyword(messageLower, SERVICE_KEYWORDS) || codeUpper === "OVERLOADED_ERROR";

  const capabilityMismatch = messageImpliesCapabilityMismatch(message);

  const invalidRequest =
    (typeof statusCode === "number" && [400, 404, 422].includes(statusCode)) ||
    messageLower.includes("invalid request") || messageLower.includes("bad request") ||
    messageLower.includes("validation error") || messageLower.includes("must contain at least") ||
    messageLower.includes("too small") || messageLower.includes("too big") ||
    codeUpper === "INVALID_REQUEST_ERROR" ||
    (error && typeof error === "object" && "name" in error && error.name === "ZodError") ||
    capabilityMismatch;

  let category: ErrorCategory = "UNKNOWN";
  let retryable = false;
  let retryStrategy: RetryStrategyKind = "none";

  if (auth) { category = "AUTH_ERROR"; }
  else if (rateLimit) { category = "RATE_LIMIT"; retryable = true; retryStrategy = "long_backoff"; }
  else if (tokenLimit) { category = "TOKEN_LIMIT"; }
  else if (timeout) { category = "TIMEOUT"; retryable = true; retryStrategy = "immediate"; }
  else if (networkCode || isNetworkMsg) { category = "NETWORK_ERROR"; retryable = true; retryStrategy = "immediate"; }
  else if (serviceError) { category = "SERVICE_ERROR"; retryable = true; retryStrategy = "standard"; }
  else if (invalidRequest) { category = "INVALID_REQUEST"; }
  else if (typeof statusCode === "number" && statusCode >= 500 && statusCode <= 599) {
    category = "SERVICE_ERROR"; retryable = true; retryStrategy = "standard";
  }

  const classified: ClassifiedError = { category, originalError: error, message, retryable, retryStrategy };
  if (statusCode !== undefined) classified.statusCode = statusCode;
  if (code !== undefined) classified.code = code;
  if (provider !== undefined) classified.provider = provider;
  if (retryAfterSeconds !== undefined) classified.retryAfterSeconds = retryAfterSeconds;
  return classified;
}

export function getRetryStrategy(classified: ClassifiedError): RetryStrategy {
  if (!classified.retryable) {
    return { shouldRetry: false, maxAttempts: 0, baseDelayMs: 0, jitter: false };
  }
  switch (classified.category) {
    case "RATE_LIMIT": {
      const retryAfterMs = classified.retryAfterSeconds ? Math.max(0, classified.retryAfterSeconds * 1000) : undefined;
      const strategy: RetryStrategy = { shouldRetry: true, maxAttempts: 4, baseDelayMs: retryAfterMs ?? 2000, jitter: true };
      if (retryAfterMs !== undefined) strategy.retryAfterMs = retryAfterMs;
      return strategy;
    }
    case "SERVICE_ERROR":
      return { shouldRetry: true, maxAttempts: 4, baseDelayMs: 1500, jitter: true };
    case "NETWORK_ERROR":
      return { shouldRetry: true, maxAttempts: 3, baseDelayMs: 1000, jitter: true };
    case "TIMEOUT":
      return { shouldRetry: true, maxAttempts: 3, baseDelayMs: 1000, jitter: true };
    default:
      return { shouldRetry: false, maxAttempts: 0, baseDelayMs: 0, jitter: false };
  }
}

export function isTokenLimitError(error: unknown): boolean { return classifyError(error).category === "TOKEN_LIMIT"; }
export function isRateLimitError(error: unknown): boolean { return classifyError(error).category === "RATE_LIMIT"; }
export function isNetworkError(error: unknown): boolean { const c = classifyError(error); return c.category === "NETWORK_ERROR" || c.category === "TIMEOUT"; }
export function isTimeoutError(error: unknown): boolean { return classifyError(error).category === "TIMEOUT"; }
export function isRetryableError(error: unknown): boolean { return classifyError(error).retryable; }

export function isOverloadedError(error: unknown): boolean {
  const classified = classifyError(error);
  if (classified.category !== "SERVICE_ERROR") return false;
  const msg = classified.message.toLowerCase();
  return classified.code === "OVERLOADED_ERROR" || msg.includes("overload") ||
    msg.includes("temporarily unavailable") || msg.includes("service unavailable") ||
    msg.includes("server busy") || msg.includes("capacity");
}

export function formatErrorBrief(error: unknown, max = 160): string {
  const message = extractMessage(error);
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return singleLine.slice(0, max) + "...";
}

export async function waitForRetryDelay(attempt: number, strategy: RetryStrategy): Promise<void> {
  if (!strategy.shouldRetry) return;
  const exponent = Math.max(0, attempt - 1);
  const base = Math.max(0, strategy.baseDelayMs);
  let delay = base * Math.pow(2, exponent);
  if (strategy.retryAfterMs !== undefined) {
    delay = Math.max(delay, strategy.retryAfterMs);
  }
  if (strategy.jitter !== false) {
    delay = Math.floor(delay * (0.5 + Math.random()));
  }
  if (delay > 0) await sleep(delay);
}

/** Legacy binary bucket for older callers; prefer {@link classifyError} categories. */
export function classifyErrorSimple(error: unknown): "retriable" | "non_retriable" {
  return classifyError(error).retryable ? "retriable" : "non_retriable";
}
