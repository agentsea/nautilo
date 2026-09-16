import { randomBytes } from "node:crypto";
import {
  getSharedDirectDb,
  recoveryCodes,
  credentials,
  eq,
  and,
  count,
  RECOVERY_CODE_PURPOSE,
  sql,
  withTrustContext,
  type Database,
} from "@nautilo/db";
import { hashPin, verifyPin } from "./pin-hash";

/**
 * D168 P3 — recovery-codes chokepoint.
 *
 * Every read/write against `recovery_codes` (and the narrow
 * `credentials` reset in `useRecoveryCode`) goes through this module.
 * The ESLint rule `d168-credentials-chokepoint` enforces the boundary
 * structurally: no other file may import `recoveryCodes` or
 * `credentials` from `@nautilo/db`.
 *
 * After migration `0051_d168_p3_force_rls_credentials.sql` lands,
 * FORCE ROW LEVEL SECURITY on `credentials` makes the per-row policy
 * fire even for the `nautilo` superuser that `getSharedDirectDb()` uses.
 * Every method here MUST therefore wrap its DB ops in
 * `withTrustContext({ userId })` so the policy lets the caller's row
 * through. Forgetting = 0 rows / silent insert failure at runtime
 * (fail-closed, not silent leak).
 *
 * `recovery_codes` itself is NOT FORCE'd in #48 (the Path C policy
 * still gates the nautilo_agent role; superuser bypasses), but
 * wrapping reads is good hygiene and future-proofs against a flip.
 */

type RecoveryTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const CODE_COUNT = 8;
const CODE_BYTES = 12; // 24 hex chars = 96 bits entropy per code

const WEAK_PINS = new Set([
  "123456", "000000", "111111", "222222", "333333", "444444",
  "555555", "666666", "777777", "888888", "999999",
  "123123", "121212", "112233", "654321", "012345", "987654",
  "12345678", "00000000", "11111111",
]);

function pinPurposeEq() {
  return eq(recoveryCodes.purpose, RECOVERY_CODE_PURPOSE.PIN);
}

// ---------------------------------------------------------------------------
// generateRecoveryCodes — create 8 fresh single-use account recovery codes.
// ---------------------------------------------------------------------------

export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const db = getSharedDirectDb();
  const codes: string[] = [];
  const rows: Array<{
    userId: string;
    purpose: string;
    codeHash: string;
  }> = [];

  for (let i = 0; i < CODE_COUNT; i++) {
    const code = randomBytes(CODE_BYTES).toString("hex");
    const hash = await hashPin(code);
    codes.push(code);
    rows.push({
      userId,
      purpose: RECOVERY_CODE_PURPOSE.PIN,
      codeHash: hash,
    });
  }

  await withTrustContext({ userId }, async (tx) => {
    await tx.insert(recoveryCodes).values(rows);
  }, db);
  return codes;
}

/**
 * M066 — same semantics as {@link generateRecoveryCodes}, but inserts
 * through an existing transaction (invite redemption atomicity).
 */
export async function generateRecoveryCodesInTx(
  tx: RecoveryTx,
  userId: string,
): Promise<string[]> {
  const codes: string[] = [];
  const rows: Array<{ userId: string; codeHash: string }> = [];

  for (let i = 0; i < CODE_COUNT; i++) {
    const code = randomBytes(CODE_BYTES).toString("hex");
    const hash = await hashPin(code);
    codes.push(code);
    rows.push({ userId, codeHash: hash });
  }

  await tx.insert(recoveryCodes).values(rows);
  return codes;
}

// ---------------------------------------------------------------------------
// useRecoveryCode — verify a plaintext code, mark it used, reset PIN.
// ---------------------------------------------------------------------------

export type UseRecoveryCodeResult =
  | { success: true; codesRemaining: number }
  | { success: false; reason: "invalid" | "no_codes" | "weak_pin" | "invalid_pin_length" };

export async function useRecoveryCode(
  userId: string,
  code: string,
  newPin: string,
): Promise<UseRecoveryCodeResult> {
  if (newPin.length < 6 || newPin.length > 8) {
    return { success: false, reason: "invalid_pin_length" };
  }
  if (WEAK_PINS.has(newPin)) {
    return { success: false, reason: "weak_pin" };
  }

  const db = getSharedDirectDb();
  return await withTrustContext({ userId }, async (tx) => {
    const unused = await tx
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          pinPurposeEq(),
          eq(recoveryCodes.used, false),
        ),
      );

    if (unused.length === 0) {
      return { success: false, reason: "no_codes" } as const;
    }

    let matchedId: string | null = null;
    for (const row of unused) {
      if (await verifyPin(code, row.codeHash)) {
        matchedId = row.id;
        break;
      }
    }

    if (!matchedId) {
      return { success: false, reason: "invalid" } as const;
    }

    const newHash = await hashPin(newPin);

    await tx
      .update(recoveryCodes)
      .set({ used: true, usedAt: new Date() })
      .where(eq(recoveryCodes.id, matchedId));

    await tx
      .delete(credentials)
      .where(and(eq(credentials.userId, userId), eq(credentials.type, "pin")));

    await tx.insert(credentials).values({ userId, type: "pin", value: newHash });

    const remaining = unused.length - 1;
    return { success: true, codesRemaining: remaining } as const;
  }, db);
}

// ---------------------------------------------------------------------------
// getRecoveryCodeStatus — account recovery codes.
// ---------------------------------------------------------------------------

export async function getRecoveryCodeStatus(
  userId: string,
): Promise<{ total: number; used: number; remaining: number }> {
  const db = getSharedDirectDb();
  return await withTrustContext({ userId }, async (tx) => {
    const [totals] = await tx
      .select({
        total: count(),
        used: count(recoveryCodes.usedAt),
      })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), pinPurposeEq()));

    const total = Number(totals?.total ?? 0);
    const used = Number(totals?.used ?? 0);
    return { total, used, remaining: total - used };
  }, db);
}

// ---------------------------------------------------------------------------
// regenerateRecoveryCodes — PIN codes only: invalidate + fresh set.
// ---------------------------------------------------------------------------

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes: string[] = [];
  const rows: Array<{
    userId: string;
    purpose: string;
    codeHash: string;
  }> = [];

  for (let i = 0; i < CODE_COUNT; i++) {
    const code = randomBytes(CODE_BYTES).toString("hex");
    const hash = await hashPin(code);
    codes.push(code);
    rows.push({
      userId,
      purpose: RECOVERY_CODE_PURPOSE.PIN,
      codeHash: hash,
    });
  }

  const db = getSharedDirectDb();
  await withTrustContext({ userId }, async (tx) => {
    await tx
      .delete(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), pinPurposeEq()));
    await tx.insert(recoveryCodes).values(rows);
  }, db);
  return codes;
}

// ===========================================================================
// M120 — account password recovery uses the setup-generated recovery-code pool.
// ===========================================================================
//
// Historical note: D104 introduced a separate LOGTO_ACCOUNT purpose for Logto
// password reset. M120's OSS product model deliberately collapses that user-
// visible split: the one set of recovery codes printed at setup must recover
// the account password. Keep these Logto-named helpers as compatibility seams
// for account UI / API callers, but have them operate on the PIN purpose pool
// generated by `generateRecoveryCodes()`.

export async function regenerateLogtoAccountRecoveryCodes(
  userId: string,
): Promise<string[]> {
  return regenerateRecoveryCodes(userId);
}

export async function getLogtoAccountRecoveryCodeStatus(userId: string): Promise<{
  total: number;
  used: number;
  remaining: number;
  lastGeneratedAt: Date | null;
}> {
  const status = await getRecoveryCodeStatus(userId);
  return {
    total: status.total,
    used: status.used,
    remaining: status.remaining,
    lastGeneratedAt: null,
  };
}

/**
 * Verify an account recovery code and mark it used under a per-user advisory
 * lock so concurrent requests cannot redeem the same code twice. Kept for
 * older call sites/tests; M120's relay flow verifies first and calls
 * `markLogtoAccountRecoveryCodeUsed` when the relay code is released.
 */
export async function claimLogtoAccountRecoveryCode(
  userId: string,
  code: string,
): Promise<string | null> {
  const db = getSharedDirectDb();
  return await withTrustContext({ userId }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);

    const unused = await tx
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          pinPurposeEq(),
          eq(recoveryCodes.used, false),
        ),
      );

    let matchedId: string | null = null;
    for (const row of unused) {
      if (await verifyPin(code, row.codeHash)) {
        matchedId = row.id;
        break;
      }
    }
    if (!matchedId) return null;

    const updated = await tx
      .update(recoveryCodes)
      .set({ used: true, usedAt: new Date() })
      .where(
        and(
          eq(recoveryCodes.id, matchedId),
          pinPurposeEq(),
          eq(recoveryCodes.used, false),
        ),
      )
      .returning({ id: recoveryCodes.id });

    return updated[0]?.id ?? null;
  }, db);
}

/**
 * Mark a previously verified account recovery code as consumed.
 *
 * M120 hardening: the relay flow verifies the recovery code before opening the
 * Logto hosted reset page, but only burns it once the relayed Logto verification
 * code is actually released to the client. This avoids losing a recovery code
 * when the user closes the hosted reset tab before requesting a verification
 * code.
 */
export async function markLogtoAccountRecoveryCodeUsed(
  userId: string,
  recoveryCodeRowId: string,
): Promise<boolean> {
  const db = getSharedDirectDb();
  return await withTrustContext({ userId }, async (tx) => {
    const updated = await tx
      .update(recoveryCodes)
      .set({ used: true, usedAt: new Date() })
      .where(
        and(
          eq(recoveryCodes.id, recoveryCodeRowId),
          pinPurposeEq(),
          eq(recoveryCodes.used, false),
        ),
      )
      .returning({ id: recoveryCodes.id });

    return updated.length > 0;
  }, db);
}

/**
 * Undo `claimLogtoAccountRecoveryCode` when Logto password set fails after claim.
 *
 * D168 P3 — `userId` added to the signature so we can establish trust
 * context for the FORCE-RLS-enforced `recovery_codes` row update.
 * The caller in `packages/server/src/lib/logto-recover-with-code.ts`
 * already has the user in scope from the Logto auth resolution; passing
 * it here is a no-op.
 */
export async function releaseLogtoAccountRecoveryCode(
  userId: string,
  recoveryCodeRowId: string,
): Promise<void> {
  const db = getSharedDirectDb();
  await withTrustContext({ userId }, async (tx) => {
    await tx
      .update(recoveryCodes)
      .set({ used: false, usedAt: null })
      .where(and(eq(recoveryCodes.id, recoveryCodeRowId), pinPurposeEq()));
  }, db);
}

/**
 * Returns the row id of a matching unused account recovery code, or null.
 * Does not mark the code used — for read-only checks / tests.
 */
export async function findMatchingUnusedLogtoAccountRecoveryCode(
  userId: string,
  code: string,
): Promise<string | null> {
  const db = getSharedDirectDb();
  return await withTrustContext({ userId }, async (tx) => {
    const unused = await tx
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          pinPurposeEq(),
          eq(recoveryCodes.used, false),
        ),
      );

    for (const row of unused) {
      if (await verifyPin(code, row.codeHash)) {
        return row.id;
      }
    }
    return null;
  }, db);
}
