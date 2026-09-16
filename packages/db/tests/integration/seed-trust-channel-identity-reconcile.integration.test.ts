/**
 * Restart reconciliation for trusted first-owner channel identities.
 *
 * These use real Postgres rows and the actual seeder helper. The duplicate
 * shape is legal under the historic `(channel, external_id)` uniqueness key:
 * a user can have an already-canonical current id plus stale prior ids for
 * the same boot channel.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  and,
  channelIdentities,
  createDirectDb,
  ensureDatabase,
  eq,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import { reconcileChannelIdentity } from "../../src/utils/seed-trust-personal";

let db: ReturnType<typeof createDirectDb>;

async function createUser(label: string): Promise<string> {
  const suffix = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: label,
      email: `d488-${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@test.invalid`,
      handle: `d488${suffix.replaceAll("-", "").slice(0, 20)}`,
      externalId: `d488-user-${suffix}`,
      server: null,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("test user insert failed");
  return user.id;
}

async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
});

afterAll(async () => {
  if (db) await db.end();
});

describe("seedTrustPersonal channel identity restart reconciliation", () => {
  test("a same-user canonical row wins and removes redundant stale channel rows", async () => {
    const ownerId = await createUser("Canonical owner");
    const channel = `d488-restart-${randomUUID()}`;
    const canonicalExternalId = `@owner-${randomUUID()}@test`;
    const staleExternalIds = [
      `@owner-old-a-${randomUUID()}@test`,
      `@owner-old-b-${randomUUID()}@test`,
    ];

    try {
      const [canonical] = await db
        .insert(channelIdentities)
        .values({
          channel,
          externalId: canonicalExternalId,
          userId: ownerId,
          verifiedAt: null,
        })
        .returning({ id: channelIdentities.id });
      if (!canonical) throw new Error("canonical channel identity insert failed");
      await db.insert(channelIdentities).values(
        staleExternalIds.map((externalId) => ({
          channel,
          externalId,
          userId: ownerId,
          verifiedAt: null,
        })),
      );

      await reconcileChannelIdentity(db, channel, canonicalExternalId, ownerId, () => {});

      const rows = await db
        .select({
          id: channelIdentities.id,
          externalId: channelIdentities.externalId,
          verifiedAt: channelIdentities.verifiedAt,
        })
        .from(channelIdentities)
        .where(and(eq(channelIdentities.userId, ownerId), eq(channelIdentities.channel, channel)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(canonical.id);
      expect(rows[0]?.externalId).toBe(canonicalExternalId);
      expect(rows[0]?.verifiedAt).toBeInstanceOf(Date);
    } finally {
      await cleanupUsers([ownerId]);
    }
  });

  test("a canonical row for another user remains fail-closed and untouched", async () => {
    const ownerId = await createUser("Target owner");
    const conflictingUserId = await createUser("Conflicting owner");
    const channel = `d488-conflict-${randomUUID()}`;
    const canonicalExternalId = `@conflict-${randomUUID()}@test`;
    const targetStaleId = `@target-old-${randomUUID()}@test`;

    try {
      await db.insert(channelIdentities).values([
        {
          channel,
          externalId: canonicalExternalId,
          userId: conflictingUserId,
          verifiedAt: new Date(),
        },
        {
          channel,
          externalId: targetStaleId,
          userId: ownerId,
          verifiedAt: null,
        },
      ]);

      let failure: unknown;
      try {
        await reconcileChannelIdentity(db, channel, canonicalExternalId, ownerId, () => {});
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("expected cross-user reconciliation failure");
      expect(failure.message).toContain("channel_identity ownership conflict");

      const rows = await db
        .select({ externalId: channelIdentities.externalId, userId: channelIdentities.userId })
        .from(channelIdentities)
        .where(eq(channelIdentities.channel, channel));
      expect(rows).toHaveLength(2);
      const canonical = rows.find((row) => row.externalId === canonicalExternalId);
      const stale = rows.find((row) => row.externalId === targetStaleId);
      expect(canonical?.userId).toBe(conflictingUserId);
      expect(stale?.userId).toBe(ownerId);
    } finally {
      await cleanupUsers([ownerId, conflictingUserId]);
    }
  });

  test("concurrent restart reconciliations with different target ids retain one user/channel row", async () => {
    const ownerId = await createUser("Concurrent owner");
    const channel = `d488-concurrent-${randomUUID()}`;
    const firstExternalId = `@concurrent-a-${randomUUID()}@test`;
    const secondExternalId = `@concurrent-b-${randomUUID()}@test`;
    const secondDb = createDirectDb(1);

    try {
      await Promise.all([
        reconcileChannelIdentity(db, channel, firstExternalId, ownerId, () => {}),
        reconcileChannelIdentity(secondDb, channel, secondExternalId, ownerId, () => {}),
      ]);

      const rows = await db
        .select({ externalId: channelIdentities.externalId, userId: channelIdentities.userId })
        .from(channelIdentities)
        .where(and(eq(channelIdentities.userId, ownerId), eq(channelIdentities.channel, channel)));
      expect(rows).toHaveLength(1);
      const winner = rows[0];
      if (!winner) throw new Error("expected one reconciled channel identity");
      expect(winner.userId).toBe(ownerId);
      expect([firstExternalId, secondExternalId]).toContain(winner.externalId);
    } finally {
      await secondDb.end();
      await cleanupUsers([ownerId]);
    }
  });
});
