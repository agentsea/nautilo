import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, ensureDatabase, eq, getSharedDirectDb,
  serverAdmission, serverModerationPolicy, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { completeModerationEnrollmentInTx, prepareModerationEnrollmentInTx } from "../../src/moderation-enrollment";
import { isInvocationAccessAllowed } from "../../src/action-capability-admission";
import { readServerModerationPolicy, updateServerModerationPolicy } from "../../src/moderation-settings";

beforeAll(async () => { bootstrapTestDbInstance(); await ensureDatabase(); }, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });

test("pause rejects an already-bound signup without changing its admission or epoch", async () => {
  const db = getSharedDirectDb();
  const rollback = new Error("Roll back fixture");
  try {
    await db.transaction(async tx => {
      const [human] = await tx.insert(users).values({ name: "Pending enrollment fixture", externalId: randomUUID() }).returning();
      const epoch = await prepareModerationEnrollmentInTx(tx, human!.id, "https://identity.example", null);
      await tx.update(serverModerationPolicy).set({ joinsPaused: true }).where(eq(serverModerationPolicy.singleton, true));
      await Promise.resolve(expect(completeModerationEnrollmentInTx(tx, human!.id, "https://identity.example", null, epoch)).rejects.toThrow("enrollment_paused"));
      const [admission] = await tx.select().from(serverAdmission).where(eq(serverAdmission.userId, human!.id));
      expect(admission?.admitted).toBe(false); expect(admission?.epoch).toBe(epoch);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
});

test("pause applies even with moderation controls disabled and resuming permits ordinary completion", async () => {
  const db = getSharedDirectDb();
  const rollback = new Error("Roll back fixture");
  try {
    await db.transaction(async tx => {
      const [human] = await tx.insert(users).values({ name: "New identity fixture", externalId: randomUUID() }).returning();
      const epoch = await prepareModerationEnrollmentInTx(tx, human!.id, "https://identity.example", null);
      await tx.update(serverModerationPolicy).set({ enabled: false, joinsPaused: true }).where(eq(serverModerationPolicy.singleton, true));
      await Promise.resolve(expect(completeModerationEnrollmentInTx(tx, human!.id, "https://identity.example", null, epoch)).rejects.toThrow("enrollment_paused"));
      await tx.update(serverModerationPolicy).set({ joinsPaused: false }).where(eq(serverModerationPolicy.singleton, true));
      await completeModerationEnrollmentInTx(tx, human!.id, "https://identity.example", null, epoch);
      const [admission] = await tx.select().from(serverAdmission).where(eq(serverAdmission.userId, human!.id));
      expect(admission?.admitted).toBe(true);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
});

test("an ordinary member cannot edit the Server's enrollment policy", async () => {
  const db = getSharedDirectDb();
  const [human] = await db.insert(users).values({ name: "Unprivileged fixture", externalId: randomUUID() }).returning();
  try {
    const policy = await readServerModerationPolicy();
    await Promise.resolve(expect(updateServerModerationPolicy(human!.id, { ...policy, joinsPaused: true })).rejects.toThrow("forbidden_scope"));
    expect(await readServerModerationPolicy()).toEqual(policy);
    await db.insert(serverAdmission).values({ userId: human!.id, admitted: true });
    expect(await isInvocationAccessAllowed({ humanUserId: human!.id })).toBe(true);
  } finally { await db.delete(users).where(eq(users.id, human!.id)); }
});
