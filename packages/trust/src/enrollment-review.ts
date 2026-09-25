import { createHash } from "node:crypto";
import { and, asc, eq, getSharedDirectDb, inviteRedemptions, invites, isNull, ilike, or, sql, users } from "@nautilo/db";
import type { EnrollmentReviewItem, EnrollmentReviewStatus } from "@nautilo/types";
import { prepareModerationEnrollmentInTx } from "./moderation-enrollment";
import { ModerationError } from "./moderation-policy";
import { readServerModerationPolicy, requireEnrollmentManager } from "./moderation-settings";
import { isAuthorityTransactionConflict, lockFingerprintState } from "./rbac-mutation-locks";

/** The verified OIDC subject and durable Invite binding are the only applicant identity. */
export async function applicantEnrollmentReview(input: {
  inviteToken: string; subject: string; issuer: string; message?: string;
}): Promise<EnrollmentReviewStatus> {
  const message = input.message?.trim();
  if (message !== undefined && !message) throw new ModerationError("join_message_required");
  const db = getSharedDirectDb();
  return db.transaction(async tx => {
    const [invite] = await tx.select().from(invites).where(eq(invites.tokenHash,
      createHash("sha256").update(input.inviteToken).digest("hex"))).for("update");
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date())) throw new ModerationError("target_unavailable");
    const [human] = await tx.select().from(users).where(eq(users.externalId, input.subject)).for("update");
    if (!human) throw new ModerationError("target_unavailable");
    const [redemption] = await tx.select().from(inviteRedemptions).where(and(
      eq(inviteRedemptions.inviteId, invite.id), eq(inviteRedemptions.userId, human.id),
    )).for("update");
    if (!redemption) throw new ModerationError("target_unavailable");
    const epoch = await prepareModerationEnrollmentInTx(tx, human.id, input.issuer, invite.targetRoomId);
    if (epoch !== (redemption.completedAt ? redemption.completionAdmissionEpoch : redemption.boundAdmissionEpoch)) {
      throw new ModerationError("admission_withdrawn");
    }
    if (redemption.completedAt === null && invite.maxUses !== null && invite.usedCount >= invite.maxUses) throw new ModerationError("target_unavailable");
    const policy = await readServerModerationPolicy();
    if (redemption.completedAt !== null) return { required: policy.approvalRequired, paused: policy.joinsPaused,
      state: "completed", message: redemption.joinMessage, revision: redemption.reviewRevision };
    let review = redemption;
    if (message !== undefined && (review.reviewState === null || review.reviewState === "pending") && review.joinMessage !== message) {
      const [changed] = await tx.update(inviteRedemptions).set({ joinMessage: message, reviewState: "pending",
        reviewRevision: review.reviewRevision + 1,
      }).where(and(eq(inviteRedemptions.inviteId, invite.id), eq(inviteRedemptions.userId, human.id))).returning();
      review = changed!;
    }
    return { required: policy.approvalRequired, paused: policy.joinsPaused, state: review.reviewState ?? "not_requested",
      message: review.joinMessage, revision: review.reviewRevision };
  });
}

export async function listEnrollmentReviews(callerUserId: string, input: {
  limit: number; search?: string; after?: { inviteId: string; userId: string };
}): Promise<{ items: EnrollmentReviewItem[]; next: { inviteId: string; userId: string } | null }> {
  const db = getSharedDirectDb();
  await requireEnrollmentManager(db, callerUserId);
  const term = input.search?.trim();
  const pattern = term ? `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : undefined;
  const handlePattern = term?.startsWith("@") ? `%${term.slice(1).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : pattern;
  const rows = await db.select({ redemption: inviteRedemptions, displayName: users.name, handle: users.handle })
    .from(inviteRedemptions).innerJoin(users, eq(users.id, inviteRedemptions.userId))
    .where(and(eq(inviteRedemptions.reviewState, "pending"), isNull(inviteRedemptions.completedAt),
      pattern ? or(ilike(users.name, pattern), ilike(users.handle, handlePattern!), ilike(inviteRedemptions.joinMessage, pattern)) : undefined,
      input.after ? sql`(${inviteRedemptions.inviteId}, ${inviteRedemptions.userId}) > (${input.after.inviteId}::uuid, ${input.after.userId}::uuid)` : undefined,
    )).orderBy(asc(inviteRedemptions.inviteId), asc(inviteRedemptions.userId)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1)?.redemption;
  return { items: page.map(({ redemption: r, displayName, handle }) => ({
    inviteId: r.inviteId, userId: r.userId, displayName, handle, message: r.joinMessage!, state: r.reviewState!, revision: r.reviewRevision,
  })), next: rows.length > input.limit && last ? { inviteId: last.inviteId, userId: last.userId } : null };
}

/** Approval is eligibility, never membership. Final publication still checks
 * the Invite, current pause/ban state and exact admission epoch atomically.
 */
export async function decideEnrollmentReview(callerUserId: string, input: {
  inviteId: string; userId: string; revision: number; decision: "approved" | "rejected";
}, issuer: string): Promise<void> {
  const db = getSharedDirectDb();
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await lockFingerprintState(tx);
      await requireEnrollmentManager(tx, callerUserId);
      const [invite] = await tx.select().from(invites).where(eq(invites.id, input.inviteId)).for("update");
      if (!invite) throw new ModerationError("target_unavailable");
      // Rejection grants no access and must remain possible for stale requests.
      if (input.decision === "approved" && (invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()))) throw new ModerationError("target_unavailable");
      const epoch = input.decision === "approved"
        ? await prepareModerationEnrollmentInTx(tx, input.userId, issuer, invite.targetRoomId) : null;
      const [review] = await tx.select().from(inviteRedemptions).where(and(
        eq(inviteRedemptions.inviteId, input.inviteId), eq(inviteRedemptions.userId, input.userId),
      )).for("update");
      if (!review || review.completedAt !== null || !review.joinMessage?.trim()) throw new ModerationError("target_unavailable");
      if (epoch !== null && review.boundAdmissionEpoch !== epoch) throw new ModerationError("admission_withdrawn");
      if (review.reviewState === input.decision && review.reviewRevision === input.revision + 1 && review.reviewedBy === callerUserId) return;
      if (review.reviewRevision !== input.revision) throw new ModerationError("stale_revision");
      await tx.update(inviteRedemptions).set({ reviewState: input.decision, reviewRevision: review.reviewRevision + 1,
        reviewedAt: new Date(), reviewedBy: callerUserId,
      }).where(and(eq(inviteRedemptions.inviteId, input.inviteId), eq(inviteRedemptions.userId, input.userId)));
    });
  } catch (error) {
    if (isAuthorityTransactionConflict(error)) throw new ModerationError("stale_revision");
    throw error;
  }
}
