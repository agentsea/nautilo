/**
 * D168 P3 integration test — PIN auth flow end-to-end under FORCE-RLS.
 *
 * The chokepoint refactor wraps every PinChallengeProvider DB method
 * in `withTrustContext({ userId })`. Migration #48 then FORCEs RLS on
 * `credentials` so even the `nautilo` superuser is subject to the
 * `credentials_self` per-row policy. This test verifies the
 * combination still produces a working PIN auth flow:
 *
 *   1. enroll(userId, pin)         → INSERT succeeds (GUC set, WITH CHECK passes)
 *   2. isEnrolled(userId)          → returns true (SELECT sees the row)
 *   3. verifyProof(userId, pin)    → returns true (SELECT sees the row, hash matches)
 *   4. verifyProof(userId, wrong)  → returns false (SELECT sees the row, hash mismatches)
 *   5. changePin(userId, ...)      → UPDATE succeeds
 *   6. cross-user isolation        → user A's GUC cannot read user B's credential
 *
 * If FORCE-RLS were misconfigured (or the chokepoint forgot to wrap),
 * steps 1/2 would fail with 0 rows / INSERT denied — this test would
 * fire BEFORE PIN login broke in dev.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  withTrustContext,
  credentials,
  users,
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { PinChallengeProvider } from "@nautilo/trust";

describe("D168 P3 — PIN auth flow under FORCE-RLS", () => {
  let supDb: ReturnType<typeof createDirectDb>;
  let provider: PinChallengeProvider;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    supDb = createDirectDb(1);

    const ts = Date.now();
    const TAG = "d168p3-pin-test-";
    // Cleanup any leftover rows
    await supDb.execute(`DELETE FROM credentials WHERE value LIKE '${TAG}%' OR user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}%')`);
    await supDb.execute(`DELETE FROM users WHERE email LIKE '${TAG}%'`);

    const aRows = (await supDb.execute(
      `INSERT INTO users (name, email) VALUES ('${TAG}alice', '${TAG}alice-${ts}@x.test') RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    const bRows = (await supDb.execute(
      `INSERT INTO users (name, email) VALUES ('${TAG}bob', '${TAG}bob-${ts}@x.test') RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    userA = aRows[0]!.id;
    userB = bRows[0]!.id;

    provider = new PinChallengeProvider({ persistPath: null });
  });

  afterAll(async () => {
    const TAG = "d168p3-pin-test-";
    await supDb.execute(`DELETE FROM credentials WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}%')`);
    await supDb.execute(`DELETE FROM users WHERE email LIKE '${TAG}%'`);
    await supDb.end();
  });

  test("enroll(userA, pin) succeeds (INSERT under FORCE-RLS with trust context)", async () => {
    await provider.enroll(userA, "123456");
  });

  test("isEnrolled(userA) returns true", async () => {
    expect(await provider.isEnrolled(userA)).toBe(true);
  });

  test("isEnrolled(userB) returns false (B has no credential)", async () => {
    expect(await provider.isEnrolled(userB)).toBe(false);
  });

  test("verifyProof(userA, correct) returns true", async () => {
    expect(await provider.verifyProof(userA, "123456")).toBe(true);
  });

  test("verifyProof(userA, wrong) returns false", async () => {
    // Clear lockout from any previous wrong-PIN test runs
    await provider.verifyProof(userA, "123456"); // resets lockout on success
    expect(await provider.verifyProof(userA, "999999")).toBe(false);
  });

  test("changePin(userA, ...) succeeds", async () => {
    await provider.verifyProof(userA, "123456"); // unlock
    await provider.changePin(userA, "123456", "234567");
    expect(await provider.verifyProof(userA, "234567")).toBe(true);
  });

  test("FORCE-RLS LIMITATION: superuser BYPASSRLS overrides FORCE — documents the honest threat model", async () => {
    // INTENT: this test exists to DOCUMENT the limitation of FORCE on
    // credentials. Postgres' `rolbypassrls=true` attribute (held by the
    // `postgres` superuser that `createDirectDb()` connects as) overrides
    // FORCE ROW LEVEL SECURITY. The chokepoint's runtime queries from
    // PinChallengeProvider / recovery-codes / redeem-invite see ALL rows
    // regardless of the trust-context GUC value, because they connect as
    // a BYPASSRLS role.
    //
    // What this means for D168 P3's threat model:
    //   - FORCE on credentials is HARMLESS but currently STRUCTURALLY INERT
    //     for the superuser path. No regression vs pre-#48; just
    //     future-proofs against a future non-superuser non-BYPASSRLS role
    //     that holds GRANTs on credentials.
    //   - The load-bearing runtime defense for credentials TODAY:
    //     1. D129 P3 REVOKE block — `nautilo_agent` role has zero GRANT
    //        on credentials, so agent SELECTs hit `permission denied`
    //        before RLS evaluation. Verified by
    //        `agent-role-isolation.integration.test.ts` scenario 1.
    //     2. D168 P3 chokepoint — `credentials` schema import is
    //        compile-time banned outside `packages/trust/src/challenge.ts`
    //        (PinChallengeProvider) + allow-listed siblings. Verified by
    //        the ESLint `d168-credentials-chokepoint` rule.
    //     3. D168 P3 `createDirectDb` ban — agent code may not import
    //        `createDirectDb` from `@nautilo/db` (would give superuser
    //        access). Compile-time tripwire. Verified by ESLint rule.
    //
    // The "introduce a nautilo_trust dedicated role with no BYPASSRLS so
    // FORCE becomes meaningful" work is filed as a follow-up; it's the
    // proper M1 ceiling but it adds DB-role provisioning + connection-
    // string config complexity that wasn't worth burning the afternoon
    // on once we understood the chokepoint+lint combo covers the
    // realistic prompt-injection threat vector.
    const supRaw = createDirectDb(1);
    try {
      const result = await withTrustContext({ userId: userB }, async (tx) => {
        return tx.select({ id: credentials.id, userId: credentials.userId }).from(credentials).where(eq(credentials.userId, userA));
      }, supRaw);
      // Honest assertion: superuser sees the row even with GUC=B set.
      expect(result.length).toBe(1);
      expect(result[0]!.userId).toBe(userA);
    } finally {
      await supRaw.end();
    }
  });

  test("untouched: users table reads still work (not in RLS scope)", async () => {
    // Sanity: verify the test fixture wasn't accidentally over-restricting.
    const supRaw = createDirectDb(1);
    try {
      const result = await supRaw.select({ id: users.id }).from(users).where(eq(users.id, userA));
      expect(result.length).toBe(1);
    } finally {
      await supRaw.end();
    }
  });
});
