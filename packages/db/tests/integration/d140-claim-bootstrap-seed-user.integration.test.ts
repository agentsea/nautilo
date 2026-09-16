/**
 * D140 — `claimBootstrapSeedUserInTx` integration tests against
 * live Postgres.
 *
 * User-side mirror of `d140-claim-bootstrap-seed.integration.test.ts`.
 * Pins UPDATE-in-place: after a Logto-claim handoff,
 * `SELECT count(*) FROM users` is unchanged (no parallel claimer
 * row inserted) and the bootstrap-seed dummy is re-targeted to the
 * claimer. Predicate (M100-aligned): bootstrap-seed user = the row
 * with no `credentials` rows AND no `external_id`.
 *
 * DB-STATE INDEPENDENCE (run against any instance, incl. a populated
 * one like a retained QA source): `claimBootstrapSeedUserInTx` targets the GLOBALLY
 * oldest seed-shape user. On a real instance that is the operator's
 * own unclaimed bootstrap user — so a naive test would (a) pick the
 * wrong row and (b), worse, commit a claim + delete on real data.
 * Every test here therefore runs inside a transaction that is ALWAYS
 * rolled back (`inRollback`), and first `neutralizeSeedShapeUsers`
 * parks any pre-existing seed-shape rows (sets a unique sentinel
 * external_id) so the helper deterministically selects the row this
 * test seeds. Because the tx rolls back, neither the neutralization
 * nor the fixtures nor the claim side-effects ever touch real data.
 *
 * D140 post-rebase: tests no longer reference `users.is_bootstrap_seed`
 * (column removed; M100's predicate uses credentials presence).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  actors,
  channelIdentities,
  credentials,
  groupMembers,
  groups,
  users,
  claimBootstrapSeedUserInTx,
  eq,
  and,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  if (db) await db.end();
});

const OWNER_BOOT_CHANNELS = ["tui", "electron", "workbench"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ROLLBACK_SENTINEL = "__d140_rollback__";

/**
 * Runs `fn` inside a transaction that is always rolled back, so no real
 * DB state is mutated. Assertion failures inside `fn` propagate (the tx
 * still rolls back) and fail the test as normal.
 */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK_SENTINEL) throw e;
  }
}

/**
 * Park every pre-existing seed-shape user (no credentials AND no
 * external_id) behind a unique sentinel external_id so the claim
 * predicate skips them. Rolled back with the enclosing tx. The sentinel
 * is unique per row (id-suffixed) so the partial-unique index on
 * `external_id` is never violated.
 */
async function neutralizeSeedShapeUsers(tx: Tx): Promise<void> {
  await tx.execute(sql`
    UPDATE users
       SET external_id = '__d140_parked_' || id::text
     WHERE external_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM credentials c WHERE c.user_id = users.id
       )
  `);
}

async function seedFakeBootstrapUser(
  tx: Tx,
  suffix: string,
): Promise<{ userId: string; userActorId: string }> {
  const [user] = await tx
    .insert(users)
    .values({
      name: "bootstrap-dummy",
      email: `dummy-${suffix}@test.local`,
      handle: `dummy-${suffix}`.slice(0, 20),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("dummy seed");

  const [userActor] = await tx
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: "bootstrap-dummy",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!userActor) throw new Error("user actor seed");

  const [ownersGroup] = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) throw new Error("owners group missing");
  await tx
    .insert(groupMembers)
    .values({
      groupId: ownersGroup.id,
      userId: user.id,
      grantedBy: userActor.id,
    })
    .onConflictDoNothing({
      target: [groupMembers.groupId, groupMembers.userId],
    });

  return { userId: user.id, userActorId: userActor.id };
}

async function countUsers(tx: Tx): Promise<number> {
  const rows = (await tx.execute(
    sql`SELECT count(*)::int AS c FROM ${users}`,
  )) as unknown as Array<{ c: number }>;
  return rows[0]?.c ?? 0;
}

describe("D140 — claimBootstrapSeedUserInTx", () => {
  test("UPDATE-in-place: user count unchanged across claim", async () => {
    await inRollback(async (tx) => {
      await neutralizeSeedShapeUsers(tx);
      const ts = Date.now().toString(36);
      const seeded = await seedFakeBootstrapUser(tx, ts);

      const before = await countUsers(tx);

      const result = await claimBootstrapSeedUserInTx(tx, {
        name: "Claimer Path A",
        email: `claimer-${ts}@test.local`,
        handle: `claimer${ts}`.slice(0, 20),
        externalId: `logto-sub-fake-${ts}`,
        pin: {
          hashedPin: "FAKE_HASHED_PIN",
          ownerBootChannels: OWNER_BOOT_CHANNELS,
          federatedId: `claimer${ts}@stack-13-test`,
        },
      });

      expect(result).not.toBeNull();
      expect(result!.source).toBe("claim-seed");
      // Deterministic: neutralization guarantees OUR seed is the only
      // seed-shape row, so the helper must pick it.
      expect(result!.userId).toBe(seeded.userId);
      expect(result!.userActorId).toBe(seeded.userActorId);

      // UPDATE-in-place: no parallel claimer row inserted.
      const after = await countUsers(tx);
      expect(after).toBe(before);

      // The row previously had no credentials; it now has one (PIN).
      const [updatedUser] = await tx
        .select({
          id: users.id,
          handle: users.handle,
          email: users.email,
          externalId: users.externalId,
        })
        .from(users)
        .where(eq(users.id, seeded.userId))
        .limit(1);
      expect(updatedUser?.externalId).toBe(`logto-sub-fake-${ts}`);
      expect(updatedUser?.email).toBe(`claimer-${ts}@test.local`);

      const [ownersMembership] = await tx
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(
          and(
            eq(groups.type, "owners"),
            eq(groupMembers.userId, seeded.userId),
          ),
        )
        .limit(1);
      expect(ownersMembership?.groupId).toBeTruthy();

      const [credRow] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.userId, seeded.userId))
        .limit(1);
      expect(credRow?.id).toBeTruthy();

      // Channel identities reinserted for every owner-boot channel.
      for (const channel of OWNER_BOOT_CHANNELS) {
        const [chan] = await tx
          .select({ id: channelIdentities.id })
          .from(channelIdentities)
          .where(
            and(
              eq(channelIdentities.userId, seeded.userId),
              eq(channelIdentities.channel, channel),
            ),
          )
          .limit(1);
        expect(chan?.id).toBeTruthy();
      }

      // User-actor display_name was updated, id preserved.
      const [actorRow] = await tx
        .select({ id: actors.id, displayName: actors.displayName })
        .from(actors)
        .where(eq(actors.id, seeded.userActorId))
        .limit(1);
      expect(actorRow?.displayName).toBe("Claimer Path A");
    });
  });

  test("returns null when no bootstrap-seed user exists (fallback path)", async () => {
    await inRollback(async (tx) => {
      // Park every seed-shape row; seed none. The helper must return null.
      await neutralizeSeedShapeUsers(tx);
      const ts = Date.now().toString(36);

      const result = await claimBootstrapSeedUserInTx(tx, {
        name: "No Seed Claimer",
        email: `claimer-noseed-${ts}@test.local`,
        handle: `noseed${ts}`.slice(0, 20),
        externalId: null,
        pin: {
          hashedPin: "FAKE_HASHED_PIN",
          ownerBootChannels: OWNER_BOOT_CHANNELS,
          federatedId: `noseed${ts}@stack-13-test`,
        },
      });

      expect(result).toBeNull();
    });
  });

  // Reviewer Finding 2 + predicate-hardening regression test: an M105
  // half-redeemed user (externalId=logtoSub, no credentials) is NOT
  // the bootstrap seed and must NOT be picked up by the claim helper.
  test("half-redeemed user (externalId set, no credentials) is not claimed", async () => {
    await inRollback(async (tx) => {
      // Park real seed-shape rows so the only seed-shape candidate would
      // be the half-redeemed row we seed below — which the hardened
      // predicate (external_id IS NULL) must still skip.
      await neutralizeSeedShapeUsers(tx);
      const ts = Date.now().toString(36);
      const halfRedeemedEmail = `dummy-${ts}@test.local`;

      const [halfRedeemed] = await tx
        .insert(users)
        .values({
          name: "half-redeemed-dummy",
          email: halfRedeemedEmail,
          handle: null,
          externalId: `logto-sub-half-${ts}`,
        })
        .returning({ id: users.id });
      if (!halfRedeemed) throw new Error("half-redeemed seed failed");

      const result = await claimBootstrapSeedUserInTx(tx, {
        name: "Wrong Claimer",
        email: `claimer-${ts}@test.local`,
        handle: null,
        externalId: `logto-sub-other-${ts}`,
        pin: null,
      });

      // The hardened predicate (no credentials AND external_id IS NULL)
      // skips the half-redeemed row, and no other seed-shape row exists.
      expect(result).toBeNull();

      const [stillHalfRedeemed] = await tx
        .select({
          id: users.id,
          externalId: users.externalId,
          name: users.name,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, halfRedeemed.id))
        .limit(1);
      expect(stillHalfRedeemed?.externalId).toBe(`logto-sub-half-${ts}`);
      expect(stillHalfRedeemed?.name).toBe("half-redeemed-dummy");
      expect(stillHalfRedeemed?.email).toBe(halfRedeemedEmail);
    });
  });

  // Reviewer Finding 3: a second claim attempt on an already-bound
  // user row must NOT overwrite. With the conditional UPDATE
  // (`external_id IS NULL AND NOT EXISTS credentials` in the WHERE),
  // the second call sees no eligible seed row and returns null cleanly.
  test("conditional update is idempotent under repeated claim attempts", async () => {
    await inRollback(async (tx) => {
      await neutralizeSeedShapeUsers(tx);
      const ts = Date.now().toString(36);
      const seeded = await seedFakeBootstrapUser(tx, `race-${ts}`);

      const firstResult = await claimBootstrapSeedUserInTx(tx, {
        name: "First Claim",
        email: `claimer-first-${ts}@test.local`,
        handle: `first${ts}`.slice(0, 20),
        externalId: `logto-sub-first-${ts}`,
        pin: {
          hashedPin: "FAKE_HASHED_PIN_FIRST",
          ownerBootChannels: OWNER_BOOT_CHANNELS,
          federatedId: `first${ts}@stack-13-test`,
        },
      });
      expect(firstResult).not.toBeNull();
      expect(firstResult!.userId).toBe(seeded.userId);

      // Second attempt: the (now-claimed) row has credentials + external_id
      // and no other seed-shape row exists → helper returns null without
      // clobbering.
      const secondResult = await claimBootstrapSeedUserInTx(tx, {
        name: "Second Claim (should not bind)",
        email: `claimer-second-${ts}@test.local`,
        handle: `second${ts}`.slice(0, 20),
        externalId: `logto-sub-second-${ts}`,
        pin: {
          hashedPin: "FAKE_HASHED_PIN_SECOND",
          ownerBootChannels: OWNER_BOOT_CHANNELS,
          federatedId: `second${ts}@stack-13-test`,
        },
      });
      expect(secondResult).toBeNull();

      // Verify the first claim's data survived intact.
      const [survivor] = await tx
        .select({
          id: users.id,
          name: users.name,
          externalId: users.externalId,
        })
        .from(users)
        .where(eq(users.id, seeded.userId))
        .limit(1);
      expect(survivor?.name).toBe("First Claim");
      expect(survivor?.externalId).toBe(`logto-sub-first-${ts}`);
    });
  });
});
