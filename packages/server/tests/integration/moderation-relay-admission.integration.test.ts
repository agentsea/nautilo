import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actors, ensureDatabase, eq, getSharedDirectDb, relayTokens, serverAdmission,
  users, __resetSharedDirectDbForTests } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { getRelayTokenStore, resetRelayTokenStore } from "../../src/lib/relay-token-store";

beforeAll(async () => {
  bootstrapTestDbInstance(); process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase(); resetRelayTokenStore();
}, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  const db = getSharedDirectDb();
  const [human] = await db.insert(users).values({ name: "Relay admission fixture", externalId: randomUUID() }).returning();
  const [actor] = await db.insert(actors).values({ ownerId: human!.id, kind: "user", displayName: "Fixture Human" }).returning();
  await db.insert(serverAdmission).values({ userId: human!.id, admitted: true });
  const [token] = await db.insert(relayTokens).values({ userId: human!.id, actorId: actor!.id,
    tokenHash: randomUUID(), label: "Fixture Relay" }).returning();
  return { id: token!.id, userId: human!.id, actorId: actor!.id };
}

describe("Relay registration and moderation share one Human admission boundary", () => {
  test("a ban winning the Human lock prevents an earlier credential lookup from publishing", async () => {
    const row = await fixture();
    const db = getSharedDirectDb();
    const held = latch(); const finish = latch();
    const withdrawal = db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, row.userId)).for("update");
      await tx.update(serverAdmission).set({ admitted: false, epoch: 1 }).where(eq(serverAdmission.userId, row.userId));
      held.release(); await finish.promise;
    });
    await held.promise;
    let published = false;
    const registration = getRelayTokenStore().withRegistrationAdmission!(row, () => { published = true; return Promise.resolve("registered"); });
    finish.release(); await withdrawal;
    expect(await registration).toBeNull();
    expect(published).toBe(false);
  });

  test("registration winning the lock publishes before withdrawal can complete", async () => {
    const row = await fixture();
    const db = getSharedDirectDb();
    const inside = latch(); const finish = latch();
    let published = false;
    const registration = getRelayTokenStore().withRegistrationAdmission!(row, async () => {
      inside.release(); await finish.promise; published = true; return "registered";
    });
    await inside.promise;
    const withdrawal = db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, row.userId)).for("update");
      expect(published).toBe(true);
      await tx.update(serverAdmission).set({ admitted: false, epoch: 1 }).where(eq(serverAdmission.userId, row.userId));
    });
    finish.release(); expect(await registration).toBe("registered"); await withdrawal;
  });

  test("revoked pairing, mismatched identity, and independent account disable deny publication", async () => {
    const row = await fixture();
    const store = getRelayTokenStore(); const db = getSharedDirectDb();
    const publish = () => { throw new Error("Forbidden publication"); };
    expect(await store.withRegistrationAdmission!({ ...row, actorId: randomUUID() }, publish)).toBeNull();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, row.userId));
    expect(await store.withRegistrationAdmission!(row, publish)).toBeNull();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, row.userId));
    await db.update(relayTokens).set({ revokedAt: new Date() }).where(eq(relayTokens.id, row.id));
    expect(await store.withRegistrationAdmission!(row, publish)).toBeNull();
  });
});
