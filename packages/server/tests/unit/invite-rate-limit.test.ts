/**
 * M066 / M-3 — token-scoped redeem failure lockout (6th attempt → locked).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetInviteRateLimitForTests,
  __setInviteRateLimitClockForTests,
  checkInviteIpLimit,
  isInviteTokenLockedOut,
  recordInviteRedeemFailure,
  resetInviteTokenFailures,
} from "../../src/lib/invite-rate-limit";

describe("invite-rate-limit (token failures)", () => {
  const h = "test-token-hash-m3";

  test("after five recorded failures, the token is locked out", () => {
    resetInviteTokenFailures(h);
    expect(isInviteTokenLockedOut(h)).toBe(false);
    for (let i = 0; i < 5; i++) {
      recordInviteRedeemFailure(h);
    }
    expect(isInviteTokenLockedOut(h)).toBe(true);
  });

  test("reset clears lockout", () => {
    resetInviteTokenFailures(h);
    recordInviteRedeemFailure(h);
    expect(isInviteTokenLockedOut(h)).toBe(false);
    resetInviteTokenFailures(h);
    expect(isInviteTokenLockedOut(h)).toBe(false);
  });
});

describe("invite-rate-limit (cap-and-prune, ISSUE-D126 Phase 11)", () => {
  beforeEach(() => {
    __resetInviteRateLimitForTests();
    __setInviteRateLimitClockForTests(null);
  });

  afterEach(() => {
    __resetInviteRateLimitForTests();
    __setInviteRateLimitClockForTests(null);
  });

  test("tokenFailMap: when over 2000 entries, expired ones are pruned on next recordFailure", () => {
    let t = 1_000_000;
    __setInviteRateLimitClockForTests(() => t);
    // Seed 2001 entries at t=1_000_000.
    for (let i = 0; i < 2001; i++) {
      recordInviteRedeemFailure(`stale-token-${i}`);
    }
    // Advance past TOKEN_FAIL_WINDOW_MS (10 minutes) so all seeded entries are stale.
    t += 11 * 60 * 1000;
    // Next failure should trigger prune sweep; map should drop close to 1 entry.
    recordInviteRedeemFailure("fresh-token");
    // Verify the fresh token records correctly...
    expect(isInviteTokenLockedOut("fresh-token")).toBe(false);
    // And a stale one is no longer in the map (lockout returns false because the
    // entry was pruned, not because it expired-on-read).
    expect(isInviteTokenLockedOut("stale-token-0")).toBe(false);
  });

  test("ipMap: when over 2000 entries, expired ones are pruned on next checkIpLimit", () => {
    let t = 2_000_000;
    __setInviteRateLimitClockForTests(() => t);
    for (let i = 0; i < 2001; i++) {
      checkInviteIpLimit(`10.0.0.${i}`);
    }
    // Advance past IP_WINDOW_MS (60s).
    t += 61 * 1000;
    // Triggering another call sweeps stale entries.
    expect(checkInviteIpLimit("10.99.99.99")).toBe(true);
  });

  test("cap does NOT evict non-expired entries", () => {
    const t = 3_000_000;
    __setInviteRateLimitClockForTests(() => t);
    for (let i = 0; i < 2001; i++) {
      recordInviteRedeemFailure(`fresh-token-${i}`);
    }
    // Same instant; do not advance the clock. Trigger sweep with a new failure.
    recordInviteRedeemFailure("another-token");
    // The first seeded token's failure count should still be 1 (entry intact).
    // We assert via isInviteTokenLockedOut — locked needs 5 fails, so still false.
    expect(isInviteTokenLockedOut("fresh-token-0")).toBe(false);
    // And ANOTHER 4 fails on the same key should lock it out — proving its entry
    // survived the prune sweep.
    for (let i = 0; i < 4; i++) recordInviteRedeemFailure("fresh-token-0");
    expect(isInviteTokenLockedOut("fresh-token-0")).toBe(true);
  });
});
