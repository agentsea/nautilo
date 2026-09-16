/** D488 — real Postgres proof for the zero-row controller install race. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  invites,
  isNotNull,
  isNull,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  getOwnerClaimProjection,
  installOwnerClaim,
  OWNER_CLAIM_RETIRED_HISTORY_LIMIT,
} from "../../src/lib/owner-claim-control";

const DISPLAY_NAME = "Controller owner claim";

describe("D488 owner claim controller on Postgres", () => {
  let first: ReturnType<typeof createDirectDb>;
  let second: ReturnType<typeof createDirectDb>;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    first = createDirectDb(1);
    second = createDirectDb(1);
  });

  beforeEach(async () => {
    await first.delete(invites).where(eq(invites.displayName, DISPLAY_NAME));
  });

  afterAll(async () => {
    if (first) {
      await first.delete(invites).where(eq(invites.displayName, DISPLAY_NAME));
      await first.end();
    }
    if (second) await second.end();
  });

  test("serializes two fresh concurrent installs and projects one active claim after restart", async () => {
    const now = new Date("2090-01-01T00:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const [a, b] = await Promise.all([
      installOwnerClaim({ claimHash: "a".repeat(64), expiresAt, now, db: first }),
      installOwnerClaim({ claimHash: "b".repeat(64), expiresAt, now, db: second }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const active = await first
      .select({ tokenHash: invites.tokenHash })
      .from(invites)
      .where(and(
        eq(invites.displayName, DISPLAY_NAME),
        eq(invites.usedCount, 0),
        isNull(invites.revokedAt),
    ));
    expect(active).toHaveLength(1);
    const winner = active[0];
    if (!winner) throw new Error("expected one active controller claim");
    expect(["a".repeat(64), "b".repeat(64)]).toContain(winner.tokenHash);

    // A fresh handle observes durable DB state, not process-local controller state.
    const restarted = createDirectDb(1);
    try {
      expect(await getOwnerClaimProjection(restarted)).toEqual({
        ownerBound: false,
        activeClaim: true,
        status: "claim-active",
      });
    } finally {
      await restarted.end();
    }
  });

  test("replacement revokes the prior unconsumed hash and an expired hash is never active", async () => {
    const issuedAt = new Date("2091-01-01T00:00:00.000Z");
    const firstExpiry = new Date(issuedAt.getTime() + 60_000).toISOString();
    const secondExpiry = new Date(issuedAt.getTime() + 2 * 60_000).toISOString();
    const firstHash = "c".repeat(64);
    const secondHash = "e".repeat(64);

    expect(
      await installOwnerClaim({
        claimHash: firstHash,
        expiresAt: firstExpiry,
        now: issuedAt,
        db: first,
      }),
    ).toMatchObject({ ok: true, status: "installed" });
    // An exact retry does not rotate the still-active claim capability.
    expect(
      await installOwnerClaim({
        claimHash: firstHash,
        expiresAt: firstExpiry,
        now: issuedAt,
        db: second,
      }),
    ).toMatchObject({ ok: true, status: "already-installed" });

    expect(
      await installOwnerClaim({
        claimHash: secondHash,
        expiresAt: secondExpiry,
        now: issuedAt,
        db: second,
      }),
    ).toMatchObject({ ok: true, status: "installed" });
    const retired = await first
      .select({ tokenHash: invites.tokenHash, revokedAt: invites.revokedAt })
      .from(invites)
      .where(and(eq(invites.displayName, DISPLAY_NAME), eq(invites.tokenHash, firstHash)))
      .limit(1);
    expect(retired[0]?.revokedAt).not.toBeNull();
    expect(await getOwnerClaimProjection(first)).toEqual({
      ownerBound: false,
      activeClaim: true,
      status: "claim-active",
    });

    // Once the server-bounded expiry has passed, projection is awaiting an
    // owner. Reinstalling the same historic hash is fail-closed and retires
    // it; callers must mint a new plaintext/hash pair for resume.
    const afterExpiry = new Date();
    await first
      .update(invites)
      .set({ expiresAt: new Date(afterExpiry.getTime() - 1_000) })
      .where(and(eq(invites.displayName, DISPLAY_NAME), eq(invites.tokenHash, secondHash)));
    expect(await getOwnerClaimProjection(second)).toEqual({
      ownerBound: false,
      activeClaim: false,
      status: "awaiting-owner",
    });
    expect(
      await installOwnerClaim({
        claimHash: secondHash,
        expiresAt: new Date(afterExpiry.getTime() + 60_000).toISOString(),
        now: afterExpiry,
        db: second,
      }),
    ).toEqual({ ok: false, status: "expired-claim" });
    const [expired] = await first
      .select({ revokedAt: invites.revokedAt })
      .from(invites)
      .where(and(eq(invites.displayName, DISPLAY_NAME), eq(invites.tokenHash, secondHash)))
      .limit(1);
    expect(expired?.revokedAt).not.toBeNull();
  });

  test("bounds revoked controller history while retaining one active claim", async () => {
    const now = new Date("2092-01-01T00:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    for (let index = 0; index < OWNER_CLAIM_RETIRED_HISTORY_LIMIT + 5; index += 1) {
      expect(await installOwnerClaim({
        claimHash: index.toString(16).padStart(64, "0"),
        expiresAt,
        now,
        db: first,
      })).toMatchObject({ ok: true });
    }

    const retired = await first
      .select({ id: invites.id })
      .from(invites)
      .where(and(
        eq(invites.displayName, DISPLAY_NAME),
        isNotNull(invites.revokedAt),
      ));
    const active = await first
      .select({ id: invites.id })
      .from(invites)
      .where(and(
        eq(invites.displayName, DISPLAY_NAME),
        isNull(invites.revokedAt),
      ));
    expect(retired).toHaveLength(OWNER_CLAIM_RETIRED_HISTORY_LIMIT);
    expect(active).toHaveLength(1);
  });
});
