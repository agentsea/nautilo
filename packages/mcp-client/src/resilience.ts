/**
 * @nautilo/mcp-client — per-server resilience policy (D384 Phase 1, RES1/RES5).
 *
 * Wraps every `tools/call` in a composed cockatiel policy, outside-in:
 *
 *   bulkhead → circuit breaker → retry → timeout → tools/call
 *
 * Why this order:
 * - **timeout** (innermost) bounds each individual attempt.
 * - **retry** fires before the breaker trips; each attempt gets a fresh
 *   timeout budget. Exponential backoff + jitter avoids thundering herds.
 * - **circuit breaker** sees all failure modes (timeouts, exhausted
 *   retries, upstream errors) and fast-fails once a server is unhealthy so
 *   one dead MCP can't stall the agent on every call.
 * - **bulkhead** (outermost) caps concurrent in-flight calls per server so
 *   a slow MCP can't exhaust the process.
 *
 * ONE policy instance per connected server, shared across `dispatch` and
 * every tool factory for that server — the circuit-breaker state MUST be
 * shared to be meaningful.
 */

import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  TimeoutStrategy,
  bulkhead,
  circuitBreaker,
  handleAll,
  retry,
  timeout,
  wrap,
  type IPolicy,
} from "cockatiel";

export interface McpResilienceOptions {
  /** Per-attempt timeout (ms). Default 10_000. */
  readonly perAttemptTimeoutMs?: number;
  /** Retry attempts AFTER the first (cockatiel semantics). Default 1 (→ 2 total tries). */
  readonly maxAttempts?: number;
  /** Consecutive failures before the breaker opens. Default 5. */
  readonly breakerConsecutiveFailures?: number;
  /** How long the breaker stays open before a half-open probe (ms). Default 30_000. */
  readonly breakerHalfOpenAfterMs?: number;
  /** Max concurrent in-flight calls per server. Default 8. */
  readonly maxConcurrent?: number;
}

const DEFAULTS: Required<McpResilienceOptions> = {
  perAttemptTimeoutMs: 10_000,
  maxAttempts: 1,
  breakerConsecutiveFailures: 5,
  breakerHalfOpenAfterMs: 30_000,
  maxConcurrent: 8,
};

/** A resilience policy exposing `.execute(fn)`. */
export type McpResiliencePolicy = IPolicy;

/**
 * Build the shared per-server resilience policy. Create once per connected
 * server and reuse for all of that server's `tools/call`s.
 */
export function createMcpResiliencePolicy(
  serverName: string,
  options: McpResilienceOptions = {},
): McpResiliencePolicy {
  void serverName; // reserved for future per-server telemetry labels
  const o = { ...DEFAULTS, ...options };

  const timeoutPolicy = timeout(o.perAttemptTimeoutMs, TimeoutStrategy.Aggressive);
  const retryPolicy = retry(handleAll, {
    maxAttempts: o.maxAttempts,
    backoff: new ExponentialBackoff(),
  });
  const breakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: o.breakerHalfOpenAfterMs,
    breaker: new ConsecutiveBreaker(o.breakerConsecutiveFailures),
  });
  const bulkheadPolicy = bulkhead(o.maxConcurrent);

  return wrap(bulkheadPolicy, breakerPolicy, retryPolicy, timeoutPolicy);
}
