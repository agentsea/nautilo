/**
 * D488 0B.6A.3/.4 — real Postgres races over the browser redemption row.
 *
 * This uses two independently constructed direct connections and commits the
 * bind/completion transactions. It deliberately uses an owners-targeted
 * `server` invite: that exercises the same reservation and completion code
 * without borrowing or mutating any ambient bootstrap-seed user in test-cruft.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  createDirectDb,
  credentials,
  ensureDatabase,
  eq,
  findClaimedOwnerIdWithDb,
  groupMembers,
  groups,
  inArray,
  inviteRedemptions,
  invites,
  isNotNull,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  completeInviteProfile,
  redeemInviteWithLogtoSub,
} from "../../src/lib/redeem-invite";
import { hydrateBootstrapOwnerState } from "../../src/lib/bootstrap-owner-state";
import { installOwnerClaim } from "../../src/lib/owner-claim-control";
import { cleanupInvitee } from "../integration/helpers/invite-redeem-helpers";
import {
  _resetBootstrapStateCacheForTests,
  getBootstrapOwnerId,
  isBootstrapOwnerBound,
} from "@nautilo/trust";

let first: ReturnType<typeof createDirectDb>;
let second: ReturnType<typeof createDirectDb>;
let ownersGroupId: string;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function uniqueToken(): string {
  return `inv_${randomUUID().replaceAll("-", "")}`;
}

function uniqueHandle(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 24);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createServerInvite(opts?: {
  expiresAt?: Date | null;
  maxUses?: number | null;
}): Promise<{ id: string; token: string; creatorId: string }> {
  // The production constraint intentionally requires every non-claim invite
  // to name its creator. Use a throwaway non-owner here rather than bypassing
  // that invariant with raw SQL: the race must exercise the normal server
  // invite shape.
  const [creator] = await first
    .insert(users)
    .values({
      name: "D488 race inviter",
      email: `d488-race-inviter-${randomUUID()}@test.invalid`,
      handle: uniqueHandle("inviter"),
      externalId: `d488-race-inviter-${randomUUID()}`,
      server: null,
    })
    .returning({ id: users.id });
  if (!creator) throw new Error("invite creator insert failed");

  const token = uniqueToken();
  const [invite] = await first
    .insert(invites)
    .values({
      tokenHash: tokenHash(token),
      kind: "server",
      targetGroupId: ownersGroupId,
      targetRoomId: null,
      maxUses: opts?.maxUses === undefined ? 1 : opts.maxUses,
      usedCount: 0,
      createdBy: creator.id,
      displayName: `d488-race-${randomUUID()}`,
      expiresAt: opts?.expiresAt ?? null,
      revokedAt: null,
    })
    .returning({ id: invites.id });
  if (!invite) throw new Error("invite insert failed");
  return { id: invite.id, token, creatorId: creator.id };
}

async function cleanupInviteAndUsers(
  inviteId: string,
  creatorId: string,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await cleanupInvitee({ db: first } as never, userId);
  }
  await first.delete(invites).where(eq(invites.id, inviteId));
  await first.delete(users).where(eq(users.id, creatorId));
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  first = createDirectDb(1);
  second = createDirectDb(1);
  const [owners] = await first
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!owners) throw new Error("canonical owners group missing");
  ownersGroupId = owners.id;
});

afterAll(async () => {
  if (first) await first.end();
  if (second) await second.end();
});

describe("M260 per-Human Invite redemption on independent connections", () => {
  test("three Humans complete one unlimited Invite sequentially", async () => {
    const { id, token, creatorId } = await createServerInvite({ maxUses: null });
    const createdUsers: string[] = [];
    try {
      for (const label of ["one", "two", "three"] as const) {
        const sub = `m260-unlimited-${label}-${randomUUID()}`;
        const bound = await redeemInviteWithLogtoSub(
          token,
          sub,
          { handle: uniqueHandle(`un${label}`), displayName: `Unlimited ${label}` },
          { db: first },
        );
        expect(bound.ok).toBe(true);
        if (!bound.ok) throw new Error("unlimited bind failed");
        createdUsers.push(bound.userId);
        const completed = await completeInviteProfile(
          token,
          sub,
          { displayName: `Unlimited ${label}`, pin: "847291" },
          { db: first },
        );
        expect(completed.ok).toBe(true);
      }

      const [invite] = await first
        .select({ usedCount: invites.usedCount })
        .from(invites)
        .where(eq(invites.id, id))
        .limit(1);
      expect(invite?.usedCount).toBe(3);
      const completedRows = await first
        .select({ userId: inviteRedemptions.userId })
        .from(inviteRedemptions)
        .where(
          and(
            eq(inviteRedemptions.inviteId, id),
            isNotNull(inviteRedemptions.completedAt),
          ),
        );
      expect(new Set(completedRows.map((row) => row.userId))).toEqual(
        new Set(createdUsers),
      );
    } finally {
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("same-subject retries converge while a different subject binds independently", async () => {
    const { id, token, creatorId } = await createServerInvite();
    const subA = `d488-sub-a-${randomUUID()}`;
    const subB = `d488-sub-b-${randomUUID()}`;
    const handleA = uniqueHandle("samea");
    const handleB = uniqueHandle("sameb");
    const createdUsers: string[] = [];

    try {
      const [sameA, sameARetry] = await Promise.all([
        redeemInviteWithLogtoSub(token, subA, { handle: handleA, displayName: "Same A" }, { db: first }),
        redeemInviteWithLogtoSub(token, subA, { handle: handleA, displayName: "Same A" }, { db: second }),
      ]);
      expect(sameA.ok).toBe(true);
      expect(sameARetry.ok).toBe(true);
      if (!sameA.ok || !sameARetry.ok) throw new Error("same-subject bind failed");
      expect(sameARetry.userId).toBe(sameA.userId);
      createdUsers.push(sameA.userId);

      const different = await redeemInviteWithLogtoSub(
        token,
        subB,
        { handle: handleB, displayName: "Different B" },
        { db: second },
      );
      expect(different.ok).toBe(true);
      if (!different.ok) throw new Error("different-subject bind failed");
      expect(different.userId).not.toBe(sameA.userId);
      createdUsers.push(different.userId);

      const bindings = await first
        .select({ userId: inviteRedemptions.userId, completedAt: inviteRedemptions.completedAt })
        .from(inviteRedemptions)
        .where(eq(inviteRedemptions.inviteId, id));
      expect(new Set(bindings.map((row) => row.userId))).toEqual(
        new Set([sameA.userId, different.userId]),
      );
      expect(bindings.every((row) => row.completedAt === null)).toBe(true);
      const prematureMemberships = await first
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, ownersGroupId),
            inArray(groupMembers.userId, [sameA.userId, different.userId]),
          ),
        );
      expect(prematureMemberships).toEqual([]);
    } finally {
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("only one concurrent completion can mint recovery codes; completion creates canonical owner truth", async () => {
    const { id, token, creatorId } = await createServerInvite();
    const sub = `d488-sub-complete-${randomUUID()}`;
    const handle = uniqueHandle("complete");
    const createdUsers: string[] = [];

    try {
      const bound = await redeemInviteWithLogtoSub(
        token,
        sub,
        { handle, displayName: "Completer" },
        { db: first },
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) throw new Error("bind failed");
      createdUsers.push(bound.userId);

      const [firstCompletion, secondCompletion] = await Promise.all([
        completeInviteProfile(token, sub, { displayName: "Completer", pin: "847291" }, { db: first }),
        completeInviteProfile(token, sub, { displayName: "Completer", pin: "847291" }, { db: second }),
      ]);
      const completed = [firstCompletion, secondCompletion].filter(
        (result): result is Extract<typeof result, { ok: true }> => result.ok,
      );
      expect(completed).toHaveLength(2);
      expect(completed.filter((result) => result.recoveryCodes.length > 0)).toHaveLength(1);
      const rejected = [firstCompletion, secondCompletion].filter(
        (result): result is Extract<typeof result, { ok: false }> => !result.ok,
      );
      expect(rejected).toEqual([]);

      const [invite] = await first
        .select({ usedCount: invites.usedCount })
        .from(invites)
        .where(eq(invites.id, id))
        .limit(1);
      expect(invite).toEqual({ usedCount: 1 });
      const [redemption] = await first
        .select({ completedAt: inviteRedemptions.completedAt })
        .from(inviteRedemptions)
        .where(and(eq(inviteRedemptions.inviteId, id), eq(inviteRedemptions.userId, bound.userId)))
        .limit(1);
      expect(redemption?.completedAt).toBeInstanceOf(Date);
      const [pin] = await first
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, bound.userId), eq(credentials.type, "pin")))
        .limit(1);
      const [profile] = await first
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.userId, bound.userId))
        .limit(1);
      expect(pin?.id).toBeTruthy();
      expect(profile?.userId).toBe(bound.userId);

      // The completed server invite seated the user in `owners`; the canonical
      // predicate consequently blocks a controller claim even on another DB
      // connection, not merely in a process-local cache.
      const refusal = await installOwnerClaim({
        claimHash: "d".repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        db: second,
      });
      expect(refusal).toEqual({ ok: false, status: "owner-bound" });
    } finally {
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("two bound Humans racing for the last use cannot oversubscribe membership", async () => {
    const { id, token, creatorId } = await createServerInvite();
    const createdUsers: string[] = [];
    try {
      const [boundA, boundB] = await Promise.all([
        redeemInviteWithLogtoSub(
          token,
          `m260-last-a-${randomUUID()}`,
          { handle: uniqueHandle("lasta"), displayName: "Last A" },
          { db: first },
        ),
        redeemInviteWithLogtoSub(
          token,
          `m260-last-b-${randomUUID()}`,
          { handle: uniqueHandle("lastb"), displayName: "Last B" },
          { db: second },
        ),
      ]);
      expect(boundA.ok).toBe(true);
      expect(boundB.ok).toBe(true);
      if (!boundA.ok || !boundB.ok) throw new Error("bounded bind failed");
      createdUsers.push(boundA.userId, boundB.userId);

      const [completionA, completionB] = await Promise.all([
        completeInviteProfile(
          token,
          boundA.logtoSub,
          { displayName: "Last A", pin: "847291" },
          { db: first },
        ),
        completeInviteProfile(
          token,
          boundB.logtoSub,
          { displayName: "Last B", pin: "847291" },
          { db: second },
        ),
      ]);
      const successes = [completionA, completionB].filter((result) => result.ok);
      const failures = [completionA, completionB].filter((result) => !result.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: "used_up" });

      const [invite] = await first
        .select({ usedCount: invites.usedCount })
        .from(invites)
        .where(eq(invites.id, id))
        .limit(1);
      expect(invite?.usedCount).toBe(1);
      const completed = await first
        .select({ userId: inviteRedemptions.userId })
        .from(inviteRedemptions)
        .where(
          and(
            eq(inviteRedemptions.inviteId, id),
            isNotNull(inviteRedemptions.completedAt),
          ),
        );
      expect(completed).toHaveLength(1);
      const ownerMemberships = await first
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, ownersGroupId),
            inArray(groupMembers.userId, [boundA.userId, boundB.userId]),
          ),
        );
      expect(ownerMemberships.map((row) => row.userId)).toEqual([
        completed[0]!.userId,
      ]);
    } finally {
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("revocation after bind publishes no target membership or use", async () => {
    const { id, token, creatorId } = await createServerInvite({ maxUses: null });
    const sub = `m260-revoked-${randomUUID()}`;
    const createdUsers: string[] = [];
    try {
      const bound = await redeemInviteWithLogtoSub(
        token,
        sub,
        { handle: uniqueHandle("revoked"), displayName: "Revoked" },
        { db: first },
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) throw new Error("revocation bind failed");
      createdUsers.push(bound.userId);
      await first
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(eq(invites.id, id));

      expect(
        await completeInviteProfile(
          token,
          sub,
          { displayName: "Revoked", pin: "847291" },
          { db: second },
        ),
      ).toMatchObject({ ok: false, code: "revoked" });
      const [invite] = await first
        .select({ usedCount: invites.usedCount })
        .from(invites)
        .where(eq(invites.id, id))
        .limit(1);
      expect(invite?.usedCount).toBe(0);
      const memberships = await first
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, ownersGroupId),
            eq(groupMembers.userId, bound.userId),
          ),
        );
      expect(memberships).toEqual([]);
      const [redemption] = await first
        .select({ completedAt: inviteRedemptions.completedAt })
        .from(inviteRedemptions)
        .where(
          and(
            eq(inviteRedemptions.inviteId, id),
            eq(inviteRedemptions.userId, bound.userId),
          ),
        )
        .limit(1);
      expect(redemption?.completedAt).toBeNull();
    } finally {
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("a process-equivalent restart rehydrates the persisted canonical owner", async () => {
    const canonicalOwnerBefore = await findClaimedOwnerIdWithDb(first);
    const { id, token, creatorId } = await createServerInvite();
    const sub = `d488-sub-restart-${randomUUID()}`;
    const createdUsers: string[] = [];
    let restarted: ReturnType<typeof createDirectDb> | undefined;

    try {
      const bound = await redeemInviteWithLogtoSub(
        token,
        sub,
        { handle: uniqueHandle("restart"), displayName: "Restart owner" },
        { db: first },
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) throw new Error("bind failed");
      createdUsers.push(bound.userId);
      expect(
        await completeInviteProfile(
          token,
          sub,
          { displayName: "Restart owner", pin: "847291" },
          { db: first },
        ),
      ).toMatchObject({ ok: true, newUserId: bound.userId });

      // Model a restored database under a fresh server process: nothing from
      // the old in-memory cache survives, so only the persisted PIN/profile/
      // owners-group projection may re-establish remote-bootstrap retirement.
      _resetBootstrapStateCacheForTests();
      expect(isBootstrapOwnerBound()).toBe(false);
      restarted = createDirectDb(1);
      const hydrated = await hydrateBootstrapOwnerState({
        seededOwnerId: `seeded-${randomUUID()}`,
        db: restarted,
      });
      const expectedCanonicalOwner = canonicalOwnerBefore ?? bound.userId;
      expect(hydrated).toEqual({
        ownerId: expectedCanonicalOwner,
        claimedOwnerId: expectedCanonicalOwner,
      });
      expect(getBootstrapOwnerId()).toBe(expectedCanonicalOwner);
      expect(isBootstrapOwnerBound()).toBe(true);
    } finally {
      if (restarted) await restarted.end();
      _resetBootstrapStateCacheForTests();
      await cleanupInviteAndUsers(id, creatorId, createdUsers);
    }
  });

  test("an expired invite is rejected before any subject reservation is created", async () => {
    const { id, token, creatorId } = await createServerInvite({
      expiresAt: new Date(Date.now() - 1_000),
    });
    const sub = `d488-sub-expired-${randomUUID()}`;
    try {
      const result = await redeemInviteWithLogtoSub(
        token,
        sub,
        { handle: uniqueHandle("expired"), displayName: "Expired" },
        { db: second },
      );
      expect(result).toEqual({ ok: false, httpStatus: 410, error: "expired", code: "expired" });
      const rows = await first
        .select({ userId: inviteRedemptions.userId })
        .from(inviteRedemptions)
        .where(eq(inviteRedemptions.inviteId, id));
      expect(rows).toEqual([]);
      const candidate = await first
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, sub));
      expect(candidate).toEqual([]);
    } finally {
      await first.delete(invites).where(eq(invites.id, id));
      await first.delete(users).where(eq(users.id, creatorId));
    }
  });

  test("a bind that passed its probe still rejects expiry committed while it waits for the invite lock", async () => {
    const { id, token, creatorId } = await createServerInvite({
      expiresAt: new Date(Date.now() + 60_000),
    });
    const releaseRowLock = deferred();
    const rowLocked = deferred();
    const sub = `d488-sub-expiry-boundary-${randomUUID()}`;
    const holder = first.transaction(async (tx) => {
      await tx
        .select({ id: invites.id })
        .from(invites)
        .where(eq(invites.id, id))
        .for("update")
        .limit(1);
      rowLocked.resolve();
      await releaseRowLock.promise;
      await tx
        .update(invites)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(invites.id, id));
    });

    try {
      await rowLocked.promise;
      const bind = redeemInviteWithLogtoSub(
        token,
        sub,
        { handle: uniqueHandle("expiryboundary"), displayName: "Expiry boundary" },
        { db: second },
      );
      // The route has started while the initial expiry is valid, but it must
      // wait for the authoritative row lock before it can reserve a subject.
      const stillWaiting = await Promise.race([
        bind.then(() => false),
        wait(25).then(() => true),
      ]);
      expect(stillWaiting).toBe(true);

      releaseRowLock.resolve();
      await holder;
      expect(await bind).toEqual({
        ok: false,
        httpStatus: 410,
        error: "expired",
        code: "expired",
      });

      const rows = await first
        .select({ userId: inviteRedemptions.userId })
        .from(inviteRedemptions)
        .where(eq(inviteRedemptions.inviteId, id));
      expect(rows).toEqual([]);
      const boundUsers = await first
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, sub));
      expect(boundUsers).toEqual([]);
    } finally {
      // Resolve on assertion failure too, so the holder can never pin its
      // connection and contaminate the following integration files.
      releaseRowLock.resolve();
      await holder;
      await first.delete(invites).where(eq(invites.id, id));
      await first.delete(users).where(eq(users.id, creatorId));
    }
  });
});
