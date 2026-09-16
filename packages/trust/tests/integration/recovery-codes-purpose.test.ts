/**
 * M120 — account recovery uses the setup-generated recovery-code pool.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createDirectDb, ensureDatabase, users, recoveryCodes, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  generateRecoveryCodes,
  regenerateLogtoAccountRecoveryCodes,
  getRecoveryCodeStatus,
  getLogtoAccountRecoveryCodeStatus,
  findMatchingUnusedLogtoAccountRecoveryCode,
  claimLogtoAccountRecoveryCode,
} from "../../src/recovery-codes";

let db: ReturnType<typeof createDirectDb>;
let userId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const [u] = await db
    .insert(users)
    .values({
      name: "rc-purpose-test",
      email: `rc-purpose-${Date.now()}@test.local`,
      handle: `rcp${Date.now().toString(36).slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("no user");
  userId = u.id;
});

afterAll(async () => {
  if (db && userId) {
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.end();
  }
});

describe("account recovery code unification", () => {
  test("setup-generated recovery codes are valid for Logto password recovery", async () => {
    const setupCodes = await generateRecoveryCodes(userId);
    const one = setupCodes[0]!;

    const match = await findMatchingUnusedLogtoAccountRecoveryCode(userId, one);
    expect(match).not.toBeNull();

    const first = await claimLogtoAccountRecoveryCode(userId, one);
    expect(first).not.toBeNull();
    const second = await claimLogtoAccountRecoveryCode(userId, one);
    expect(second).toBeNull();

    const status = await getRecoveryCodeStatus(userId);
    const logtoStatus = await getLogtoAccountRecoveryCodeStatus(userId);
    expect(logtoStatus.total).toBe(status.total);
    expect(logtoStatus.remaining).toBe(status.remaining);
  });

  test("regenerating account recovery codes regenerates the unified setup-code pool", async () => {
    const fresh = await regenerateLogtoAccountRecoveryCodes(userId);
    expect(fresh).toHaveLength(8);

    const status = await getRecoveryCodeStatus(userId);
    const logtoStatus = await getLogtoAccountRecoveryCodeStatus(userId);
    expect(status.total).toBe(8);
    expect(logtoStatus.total).toBe(8);
    expect(logtoStatus.remaining).toBe(8);
  });
});
