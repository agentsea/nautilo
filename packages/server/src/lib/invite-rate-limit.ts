/**
 * M066 — in-process rate limits for unauthenticated invite endpoints.
 */

let nowMs: () => number = () => Date.now();

/** ISSUE-D126 Phase 11 — test seam. Restores real clock when passed null. */
export function __setInviteRateLimitClockForTests(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}

/** ISSUE-D126 Phase 11 — soft cap; triggers prune-all-expired sweep above this size. */
const MAX_ENTRIES = 2000;

const TOKEN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_FAIL_MAX = 5;
const tokenFailMap = new Map<string, { fails: number; windowStart: number }>();

const IP_WINDOW_MS = 60 * 1000;
const IP_MAX = 10;
const ipMap = new Map<string, { count: number; windowStart: number }>();

function pruneExpiredTokenFails(): void {
  if (tokenFailMap.size <= MAX_ENTRIES) return;
  const now = nowMs();
  for (const [k, v] of tokenFailMap) {
    if (now - v.windowStart > TOKEN_FAIL_WINDOW_MS) tokenFailMap.delete(k);
  }
}

function pruneExpiredIp(): void {
  if (ipMap.size <= MAX_ENTRIES) return;
  const now = nowMs();
  for (const [k, v] of ipMap) {
    if (now - v.windowStart > IP_WINDOW_MS) ipMap.delete(k);
  }
}

/** ISSUE-D126 Phase 11 — test helper; clears both in-memory maps. */
export function __resetInviteRateLimitForTests(): void {
  tokenFailMap.clear();
  ipMap.clear();
}

export function recordInviteRedeemFailure(tokenHash: string): void {
  pruneExpiredTokenFails();
  const now = nowMs();
  const cur = tokenFailMap.get(tokenHash);
  if (!cur || now - cur.windowStart > TOKEN_FAIL_WINDOW_MS) {
    tokenFailMap.set(tokenHash, { fails: 1, windowStart: now });
    return;
  }
  cur.fails += 1;
}

export function isInviteTokenLockedOut(tokenHash: string): boolean {
  pruneExpiredTokenFails();
  const cur = tokenFailMap.get(tokenHash);
  if (!cur) return false;
  const now = nowMs();
  if (now - cur.windowStart > TOKEN_FAIL_WINDOW_MS) {
    tokenFailMap.delete(tokenHash);
    return false;
  }
  /** After `TOKEN_FAIL_MAX` recorded failures, the next attempt is locked (M-3). */
  return cur.fails >= TOKEN_FAIL_MAX;
}

export function resetInviteTokenFailures(tokenHash: string): void {
  tokenFailMap.delete(tokenHash);
}

export function checkInviteIpLimit(ip: string): boolean {
  pruneExpiredIp();
  const now = nowMs();
  const cur = ipMap.get(ip);
  if (!cur || now - cur.windowStart > IP_WINDOW_MS) {
    ipMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  cur.count += 1;
  return cur.count <= IP_MAX;
}
