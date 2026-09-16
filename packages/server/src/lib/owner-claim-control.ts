import {
  and,
  desc,
  eq,
  getSharedDirectDb,
  hasClaimedOwner,
  hasUnredeemedClaimInvite,
  inviteRedemptions,
  invites,
  inArray,
  isNotNull,
  isNull,
  sql,
  type DirectDatabase,
} from "@nautilo/db";

/** Railway controller claims are short-lived; the server bounds their submitted expiry. */
export const OWNER_CLAIM_TTL_MS = 15 * 60 * 1000;
/** Keep bounded correlation history without retaining one row per resume forever. */
export const OWNER_CLAIM_RETIRED_HISTORY_LIMIT = 32;
const OWNER_CLAIM_LOCK_KEY = "nautilo:owner-claim-controller:v1";

const OWNER_CLAIM_HASH_RE = /^[a-f0-9]{64}$/;

export type OwnerClaimStatus =
  | "awaiting-owner"
  | "claim-active"
  | "owner-bound";

export type OwnerClaimProjection = {
  status: OwnerClaimStatus;
  ownerBound: boolean;
  activeClaim: boolean;
};

export type InstallOwnerClaimResult =
  | { ok: true; status: "installed" | "already-installed"; expiresAt: Date | null }
  | { ok: false; status: "owner-bound" | "invalid-claim" | "expired-claim" };

export type RevokeOwnerClaimResult =
  | { ok: true; status: "revoked" | "nothing-to-revoke" }
  | { ok: false; status: "owner-bound" };

export function isValidOwnerClaimHash(claimHash: unknown): claimHash is string {
  return typeof claimHash === "string" && OWNER_CLAIM_HASH_RE.test(claimHash);
}

/** Strict UTC wire format keeps controller receipts stable and unambiguous. */
export function parseOwnerClaimExpiresAt(expiresAt: unknown): Date | null {
  if (
    typeof expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
  ) {
    return null;
  }
  const parsed = new Date(expiresAt);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== expiresAt ? null : parsed;
}

/**
 * Redacted target-state projection used by status surfaces. It intentionally
 * contains no token, token hash, filesystem path, or bootstrap credential.
 */
export async function getOwnerClaimProjection(
  db: DirectDatabase = getSharedDirectDb(),
): Promise<OwnerClaimProjection> {
  const [ownerBound, activeClaim] = await Promise.all([
    hasClaimedOwner(db),
    hasUnredeemedClaimInvite(db),
  ]);

  return {
    ownerBound,
    activeClaim,
    status: ownerBound ? "owner-bound" : activeClaim ? "claim-active" : "awaiting-owner",
  };
}

async function pruneRetiredOwnerClaims(db: DirectDatabase): Promise<void> {
  const stale = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.kind, "claim"), isNotNull(invites.revokedAt)))
    .orderBy(desc(invites.revokedAt), desc(invites.createdAt))
    .offset(OWNER_CLAIM_RETIRED_HISTORY_LIMIT);
  if (stale.length === 0) return;
  await db.delete(invites).where(inArray(invites.id, stale.map((row) => row.id)));
}

/**
 * Install the exact controller-generated claim hash under a single database
 * transaction. Any prior unconsumed claim is revoked before the replacement
 * is inserted, satisfying the historical partial-unique invite constraint.
 */
export async function installOwnerClaim(args: {
  claimHash: unknown;
  expiresAt: unknown;
  db?: DirectDatabase;
  now?: Date;
}): Promise<InstallOwnerClaimResult> {
  if (!isValidOwnerClaimHash(args.claimHash)) {
    return { ok: false, status: "invalid-claim" };
  }

  const db = args.db ?? getSharedDirectDb();
  const now = args.now ?? new Date();
  const expiresAt = parseOwnerClaimExpiresAt(args.expiresAt);
  if (
    !expiresAt ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() > now.getTime() + OWNER_CLAIM_TTL_MS
  ) {
    return { ok: false, status: "invalid-claim" };
  }
  const claimHash = args.claimHash;

  return db.transaction(async (tx) => {
    // A row lock cannot serialize the first two installers when no claim row
    // exists yet. The stable transaction lock covers the zero-row case and is
    // released automatically on commit/rollback.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${OWNER_CLAIM_LOCK_KEY}::text, 0))
    `);
    if (await hasClaimedOwner(tx as unknown as DirectDatabase)) {
      return { ok: false, status: "owner-bound" } as const;
    }

    // Lock every still-unconsumed row, including expired rows. The latter are
    // inactive for projection purposes but must be retired before an INSERT
    // because the legacy partial unique index has no expiry predicate.
    const existing = await tx
      .select({
        id: invites.id,
        tokenHash: invites.tokenHash,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(
        and(
          eq(invites.kind, "claim"),
          eq(invites.usedCount, 0),
          isNull(invites.revokedAt),
        ),
      )
      .for("update");

    const sameActive = existing.find(
      (row) => row.tokenHash === claimHash && (row.expiresAt === null || row.expiresAt > now),
    );
    if (sameActive) {
      return {
        ok: true,
        status: "already-installed",
        expiresAt: sameActive.expiresAt,
      } as const;
    }

    // `token_hash` is globally unique, including retired history. A resume
    // after expiry must mint a fresh local plaintext/hash rather than trying
    // to recycle the expired capability.
    if (existing.some((row) => row.tokenHash === claimHash)) {
      await tx
        .update(invites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invites.kind, "claim"),
            eq(invites.usedCount, 0),
            isNull(invites.revokedAt),
          ),
        );
      await pruneRetiredOwnerClaims(tx as unknown as DirectDatabase);
      return { ok: false, status: "expired-claim" } as const;
    }

    const reservationRows = existing.length === 0
      ? []
      : await tx
          .select({ userId: inviteRedemptions.userId })
          .from(inviteRedemptions)
          .where(
            and(
              inArray(inviteRedemptions.inviteId, existing.map((row) => row.id)),
              isNull(inviteRedemptions.completedAt),
            ),
          );
    const reservedUserIds = new Set(reservationRows.map((row) => row.userId));
    if (reservedUserIds.size > 1) {
      throw new Error("owner claim reservation invariant violated");
    }
    const [reservedUserId] = reservedUserIds;

    if (existing.length > 0) {
      await tx
        .update(invites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invites.kind, "claim"),
            eq(invites.usedCount, 0),
            isNull(invites.revokedAt),
          ),
        );
    }

    const [inserted] = await tx.insert(invites).values({
      tokenHash: claimHash,
      kind: "claim",
      targetGroupId: null,
      targetRoomId: null,
      maxUses: 1,
      usedCount: 0,
      createdBy: null,
      displayName: "Controller owner claim",
      expiresAt,
      revokedAt: null,
    }).returning({ id: invites.id });
    if (!inserted) throw new Error("owner claim insert failed");
    if (reservedUserId !== undefined) {
      await tx.insert(inviteRedemptions).values({
        inviteId: inserted.id,
        userId: reservedUserId,
        boundAt: now,
      });
    }
    await pruneRetiredOwnerClaims(tx as unknown as DirectDatabase);

    return { ok: true, status: "installed", expiresAt } as const;
  });
}

/** Revoke unconsumed bootstrap claims without ever returning their capability. */
export async function revokeOwnerClaim(args: {
  db?: DirectDatabase;
  now?: Date;
}): Promise<RevokeOwnerClaimResult> {
  const db = args.db ?? getSharedDirectDb();
  const now = args.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${OWNER_CLAIM_LOCK_KEY}::text, 0))
    `);
    if (await hasClaimedOwner(tx as unknown as DirectDatabase)) {
      return { ok: false, status: "owner-bound" } as const;
    }
    const existing = await tx
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.kind, "claim"),
          eq(invites.usedCount, 0),
          isNull(invites.revokedAt),
        ),
      )
      .for("update");
    if (existing.length === 0) {
      return { ok: true, status: "nothing-to-revoke" } as const;
    }
    await tx
      .update(invites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invites.kind, "claim"),
          eq(invites.usedCount, 0),
          isNull(invites.revokedAt),
        ),
      );
    await pruneRetiredOwnerClaims(tx as unknown as DirectDatabase);
    return { ok: true, status: "revoked" } as const;
  });
}
