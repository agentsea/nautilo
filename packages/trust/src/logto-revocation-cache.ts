/**
 * M052 (Logto cluster) — short-TTL revocation cache.
 *
 * Logto access tokens are valid until `exp` (~1h). When a user is
 * removed from the org or has their account suspended mid-session, we
 * want the change to take effect within minutes — not at JWT expiry.
 *
 * **Design (per `research/logto-integration-v1.md` §4.6.1).** On each
 * authenticated request, after JWT signature validation, the
 * preHandler asks `checkLogtoRevocation(payload.sub)`:
 *   - Cache hit within TTL_MS (60s) → return the cached verdict.
 *   - Cache miss → call `LogtoAdminClient.isUserActive(sub)`:
 *       * 200 + active → cache as valid for 1h, return true.
 *       * 200 + suspended OR 404 → cache as invalid, return false.
 *       * Network/server error → **fail OPEN**: log a warning and
 *         return true. The alternative is "Logto is down → everyone
 *         gets locked out", which is a strictly worse failure mode
 *         than "revoked users keep working until JWT exp".
 *
 * Operators monitor Logto liveness separately. If a deployment needs
 * stricter semantics (Enterprise tier), layer a fail-closed mode
 * behind a separate env flag in a future issue.
 */

import { getLogtoAdminClient, type LogtoAdminClient } from "./logto-admin";

const TTL_MS = 60_000; // 1 minute — design §4.6.1 default
const POSITIVE_HOLD_MS = 60 * 60_000; // 1h positive cache
const NEGATIVE_HOLD_MS = 0; // cache misses revalidate immediately

interface CacheEntry {
  /** `Date.now()` after which `valid` is considered stale. */
  validUntil: number;
  /** Wall-clock when the entry was last verified against Logto. */
  verifiedAt: number;
}

const cache = new Map<string, CacheEntry>();

type ClientResolver = () => LogtoAdminClient;
let resolveClient: ClientResolver = getLogtoAdminClient;

type Logger = (msg: string, meta?: Record<string, unknown>) => void;
const defaultWarn: Logger = (msg, meta) => {
  // The trust package has no @nautilo/logger dep today; use stderr so
  // the line shows up in dev logs without dragging in a transitive.
  // The msg+meta shape mirrors how the server preHandler logs.
  process.stderr.write(
    `[logto-revocation] ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`,
  );
};
let warnFn: Logger = defaultWarn;

/**
 * Returns `true` if the given Logto user (`sub`) is still active. See
 * the module docstring for the cache + fail-open semantics.
 */
export async function checkLogtoRevocation(sub: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(sub);
  if (cached && now - cached.verifiedAt < TTL_MS) {
    return now < cached.validUntil;
  }

  let valid = false;
  try {
    valid = await resolveClient().isUserActive(sub);
  } catch (err) {
    // Fail OPEN — see module docstring. Don't lock everyone out on a
    // Logto outage.
    warnFn("management_api_unreachable", {
      sub,
      err: err instanceof Error ? err.message : String(err),
    });
    valid = true;
  }

  cache.set(sub, {
    validUntil: valid ? now + POSITIVE_HOLD_MS : now + NEGATIVE_HOLD_MS,
    verifiedAt: now,
  });
  return valid;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Test-only: clears the cache so tests start from a clean slate. */
export function _resetRevocationCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only: substitute the function that resolves the
 * `LogtoAdminClient`. Pass `null` to restore the production resolver.
 */
export function _setLogtoAdminResolverForTests(
  resolver: ClientResolver | null,
): void {
  resolveClient = resolver ?? getLogtoAdminClient;
}

/** Test-only: substitute the warn-logger. Pass `null` to restore stderr. */
export function _setRevocationWarnLoggerForTests(
  logger: Logger | null,
): void {
  warnFn = logger ?? defaultWarn;
}
