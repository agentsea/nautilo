/**
 * M055 follow-up — Logto-vs-host clock-skew compensation.
 *
 * **Why this exists.**
 *
 * Logto OSS runs in a Docker container. On macOS / Windows the Docker
 * VM's clock can drift from the host clock — sometimes by hours, e.g.
 * after the Mac sleeps and wakes. Logto signs JWTs using the
 * container's clock; the Nautilo server verifies them using the host
 * clock. When the gap > 0, every freshly-issued JWT looks "already
 * expired" to the verifier, the trust preHandler falls through to
 * guest, and the user is stuck on a Guest badge with no clear cause.
 *
 * Restarting Docker reseats the VM clock — but that's not a fix we
 * can ship to users. The robust answer is to evaluate `exp`/`iat`
 * against **Logto's** clock, not the host's. We learn Logto's clock
 * by reading the `Date:` HTTP response header on a probe to the
 * discovery doc; the difference between Logto's `Date:` and our
 * `Date.now()` is the offset we feed into `jose.jwtVerify`'s
 * `currentDate` option.
 *
 * **Threat model.** Logto's `Date:` header is trusted in our model
 * because Logto is a trust root for JWTs (its JWKS is what we
 * verify against). An attacker who can manipulate Logto's response
 * headers already controls JWT signing. So accepting Logto's
 * declared "now" doesn't widen the trust boundary.
 *
 * **Caching.** The HTTP probe takes a round-trip; we don't want it
 * on the hot path of every request. Cache the offset and refresh
 * lazily — `REFRESH_INTERVAL_MS` for the timer, plus an explicit
 * re-probe on verification failure (cheap because it's gated on the
 * unhappy path).
 *
 * **HTTP `Date:` granularity.** Per RFC 7231 §7.1.1.2 the header is
 * second-resolution. Plenty for evaluating JWT `exp` (also second
 * resolution).
 */

const REFRESH_INTERVAL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;

interface CacheState {
  offsetMs: number;
  lastProbeAtMs: number;
}

const state: CacheState = {
  offsetMs: 0,
  lastProbeAtMs: 0,
};

/**
 * Optional probe override. Tests inject a fake to avoid real HTTP;
 * production code never sets this.
 */
let probeOverride: (() => Promise<number | null>) | null = null;

/**
 * Internal probe. Returns the (Logto - host) offset in ms, or null
 * if the probe failed (in which case the cache keeps its previous
 * value — better to stay on a slightly stale offset than fall back
 * to zero on a transient network blip).
 */
async function defaultProbe(): Promise<number | null> {
  // M092 — prefer container-DNS endpoint when present (deploy stack).
  // Host-mode falls back to `LOGTO_ENDPOINT`.
  const endpoint =
    process.env["LOGTO_ENDPOINT_INTERNAL"] ?? process.env["LOGTO_ENDPOINT"];
  if (!endpoint) return null;
  let res: Response;
  try {
    res = await fetch(
      `${endpoint}/oidc/.well-known/openid-configuration`,
      {
        method: "HEAD",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  const dateHeader = res.headers.get("date");
  if (!dateHeader) return null;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return null;
  // Round-trip jitter: the `Date` header reflects when Logto wrote
  // the response, which is somewhere in the middle of the network
  // round-trip. We approximate by snapping the offset against
  // `Date.now()` at the moment the response lands. With sub-second
  // local-network latency this is well within JWT second-precision.
  return serverMs - Date.now();
}

/**
 * Returns the cached Logto clock offset in milliseconds. Refreshes
 * automatically when the cache is older than `REFRESH_INTERVAL_MS`,
 * or when the caller passes `force: true` (used by the verifier on
 * an `exp`/`iat` rejection — a fresh probe is the cheapest way to
 * tell "drifted since last probe" from "actually a stale token").
 */
export async function getLogtoClockOffsetMs(
  force = false,
): Promise<number> {
  const now = Date.now();
  if (!force && now - state.lastProbeAtMs < REFRESH_INTERVAL_MS) {
    return state.offsetMs;
  }
  const probed = probeOverride
    ? await probeOverride()
    : await defaultProbe();
  state.lastProbeAtMs = now;
  if (probed !== null) state.offsetMs = probed;
  return state.offsetMs;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Test-only — replace the probe with an in-memory stub. */
export function _setProbeForTests(
  fn: (() => Promise<number | null>) | null,
): void {
  probeOverride = fn;
}

/** Test-only — clear the cached offset + lastProbe timestamp. */
export function _resetClockSkewForTests(): void {
  state.offsetMs = 0;
  state.lastProbeAtMs = 0;
  probeOverride = null;
}
