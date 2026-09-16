/**
 * D458 — strict Logto active-user verification for authority ceremonies.
 *
 * Ordinary authenticated requests use `checkLogtoRevocation`, whose documented
 * availability posture is fail-open during a Logto Management API outage. That
 * is deliberately not sufficient when a request creates or replaces durable
 * remote-control authority. This adapter is the narrow, auth-pure fail-closed
 * gate for those ceremonies.
 *
 * The input is the already-verified OIDC token's canonical `sub`. It does not
 * look up, normalize, or substitute a username, email address, or client ID;
 * callers must resolve Nautilo principal/RBAC separately.
 */

import { getLogtoAdminClient, type LogtoAdminClient } from "./logto-admin";

/** Only this verdict permits an authority-creating/replacing ceremony. */
export type StrictLogtoActiveUserStatus =
  | "active"
  | "inactive"
  | "unavailable"
  | "invalid-subject";

/** Narrow client shape keeps this adapter auth-pure and easy to test. */
export type StrictLogtoActiveUserClient = Pick<
  LogtoAdminClient,
  "isUserActive"
>;

export interface VerifyLogtoActiveUserForAuthorityOptions {
  /** Internal test/integration seam. Production resolves the Logto client. */
  client?: StrictLogtoActiveUserClient;
  /** Bounded management check; expiry is an unavailable (therefore denied) verdict. */
  timeoutMs?: number;
}

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol("strict-logto-active-user-timeout");

function isNonBlankSubject(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return DEFAULT_MANAGEMENT_TIMEOUT_MS;
  }
  return Math.floor(timeoutMs);
}

/**
 * Verifies that a canonical Logto subject is currently active for a ceremony
 * that would create or replace remote authority.
 *
 * `inactive`, `unavailable`, and `invalid-subject` are all non-mutating deny
 * verdicts. In particular, Management API errors and timeouts must never be
 * converted into an implicit active verdict.
 */
export async function verifyLogtoActiveUserForAuthority(
  sub: unknown,
  options: VerifyLogtoActiveUserForAuthorityOptions = {},
): Promise<StrictLogtoActiveUserStatus> {
  if (!isNonBlankSubject(sub)) return "invalid-subject";

  const timeoutMs = boundedTimeout(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Client construction resolves the M2M configuration and can throw before
    // a Management API request exists. It is part of this strict ceremony's
    // fail-closed boundary just like an API error or timeout.
    const client = options.client ?? getLogtoAdminClient();
    const verdict = await Promise.race([
      client.isUserActive(sub),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (verdict === TIMED_OUT) return "unavailable";
    return verdict ? "active" : "inactive";
  } catch {
    // Authority ceremonies are intentionally fail-closed. Do not expose
    // Management API error detail here; route-level audit/log policy owns it.
    return "unavailable";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
