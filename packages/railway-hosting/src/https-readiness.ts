/** Bounded, redacted readiness probe for the receipt-owned Nautilo origin. */

const MAX_ATTEMPTS = 100;
const MAX_ORIGIN_BYTES = 2048;

export type RailwayHttpsReadinessFailureCode =
  | "invalid-origin"
  | "redirect"
  | "terminal-http"
  | "wait-failed"
  | "retry-exhausted";

export type RailwayHttpsReadinessResult =
  | { readonly outcome: "complete"; readonly attempts: number }
  | { readonly outcome: "failure"; readonly attempts: number; readonly code: RailwayHttpsReadinessFailureCode };

export interface RailwayHttpsReadinessResponse {
  readonly status: number;
  readonly redirected?: boolean | undefined;
}

export interface RailwayHttpsReadinessInput {
  /** Exact canonical `https://host[:port]` receipt field; no trailing slash or path. */
  readonly origin: string;
  readonly fetch: (input: string, init: { readonly method: "GET"; readonly redirect: "error"; readonly signal: AbortSignal; readonly credentials: "omit" }) => Promise<RailwayHttpsReadinessResponse>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly requestTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
}

function canonicalOrigin(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_ORIGIN_BYTES) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.hostname.length === 0 || value !== parsed.origin) return undefined;
  return parsed.origin;
}

function validMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 300_000;
}

async function timedFetch(input: RailwayHttpsReadinessInput, url: string): Promise<RailwayHttpsReadinessResponse | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.requestTimeoutMs);
  try {
    const response = await input.fetch(url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal });
    const status = response.status;
    const redirected = response.redirected === true;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) return undefined;
    return { status, redirected };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes no endpoint except `/health/ready`. Inputs are snapshotted before the
 * first await so a caller cannot swap origins, timing, or fetch authority mid-run.
 */
export async function waitForRailwayHttpsReadiness(input: RailwayHttpsReadinessInput): Promise<RailwayHttpsReadinessResult> {
  const origin = canonicalOrigin(input.origin);
  if (origin === undefined || !validMilliseconds(input.requestTimeoutMs) || !validMilliseconds(input.retryDelayMs) || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS) {
    return { outcome: "failure", attempts: 0, code: "invalid-origin" };
  }
  const stable = {
    url: `${origin}/health/ready`,
    fetch: input.fetch,
    wait: input.wait,
    requestTimeoutMs: input.requestTimeoutMs,
    retryDelayMs: input.retryDelayMs,
    maxAttempts: input.maxAttempts,
  } as const;
  for (let attempts = 1; attempts <= stable.maxAttempts; attempts += 1) {
    const response = await timedFetch({ ...input, ...stable, origin }, stable.url);
    if (response !== undefined) {
      if (response.redirected || (response.status >= 300 && response.status < 400)) return { outcome: "failure", attempts, code: "redirect" };
      if (response.status === 200) return { outcome: "complete", attempts };
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 425 && response.status !== 429) return { outcome: "failure", attempts, code: "terminal-http" };
    }
    if (attempts < stable.maxAttempts) {
      try { await stable.wait(stable.retryDelayMs); } catch { return { outcome: "failure", attempts, code: "wait-failed" }; }
    }
  }
  return { outcome: "failure", attempts: stable.maxAttempts, code: "retry-exhausted" };
}
