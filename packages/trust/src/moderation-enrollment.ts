import { and, eq, isNull, or, sql, users, serverAdmission, moderationSubjects, moderationRestrictions, inviteRedemptions,
  type InviteSeedTx } from "@nautilo/db";
import { advanceModerationRecipientRevisionsInTx } from "./moderation-recipient-revision";
import { ModerationError, moderationIdentityDigest } from "./moderation-policy";
import { assertServerEnrollmentOpenInTx } from "./moderation-settings";

/** Share this lock with sanctions, including when a deleted account is recreated. */
export async function lockModerationIdentity(tx: InviteSeedTx, digest: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation:identity:${digest}`}, 0))`);
}

/** The Invite remains the enrollment authority. This check can only subtract access. */
export async function prepareModerationEnrollmentInTx(tx: InviteSeedTx, userId: string, issuer: string | undefined,
  roomId: string | null): Promise<number> {
  const [person] = await tx.select({ externalId: users.externalId, server: users.server, disabledAt: users.disabledAt })
    .from(users).where(eq(users.id, userId)).for("update");
  if (!person || person.disabledAt !== null) throw new ModerationError("admission_withdrawn");
  if (person.server !== null || (person.externalId !== null && !issuer)) throw new ModerationError("unsupported_identity");
  const digest = person.externalId === null ? null : moderationIdentityDigest(issuer!, person.externalId);
  if (digest !== null) await lockModerationIdentity(tx, digest);
  const [ban] = await tx.select({ id: moderationRestrictions.id }).from(moderationRestrictions)
    .innerJoin(moderationSubjects, eq(moderationSubjects.id, moderationRestrictions.subjectId))
    .where(and(
      or(eq(moderationSubjects.userId, userId), ...(digest === null ? [] : [eq(moderationSubjects.identityDigest, digest)])),
      eq(moderationRestrictions.kind, "access"), isNull(moderationRestrictions.liftedAt),
      sql`${moderationRestrictions.startsAt} <= statement_timestamp()`,
      sql`(${moderationRestrictions.expiresAt} IS NULL OR ${moderationRestrictions.expiresAt} > statement_timestamp())`,
      roomId === null ? isNull(moderationRestrictions.roomId) : or(isNull(moderationRestrictions.roomId),
        eq(moderationRestrictions.roomId, roomId),
        sql`${moderationRestrictions.roomId} = (SELECT parent_room_id FROM rooms WHERE id = ${roomId})`),
    )).limit(1);
  if (ban) throw new ModerationError("active_ban");
  await tx.insert(serverAdmission).values({ userId, admitted: false }).onConflictDoNothing();
  const [admission] = await tx.select().from(serverAdmission).where(eq(serverAdmission.userId, userId)).for("update");
  if (!admission) throw new Error("Missing enrollment authority");
  return admission.epoch;
}

/** Called only after a fresh Invite is validated, in its completion transaction. */
export async function completeModerationEnrollmentInTx(tx: InviteSeedTx, userId: string, issuer: string | undefined,
  roomId: string | null, boundEpoch: number, inviteId?: string): Promise<number> {
  const epoch = await prepareModerationEnrollmentInTx(tx, userId, issuer, roomId);
  if (epoch !== boundEpoch) throw new ModerationError("admission_withdrawn");
  const policy = await assertServerEnrollmentOpenInTx(tx);
  if (policy.approvalRequired) {
    if (!inviteId) throw new ModerationError("enrollment_review_required");
    const [review] = await tx.select().from(inviteRedemptions).where(and(
      eq(inviteRedemptions.inviteId, inviteId), eq(inviteRedemptions.userId, userId),
    )).for("share");
    if (!review?.joinMessage?.trim()) throw new ModerationError("join_message_required");
    if (review.boundAdmissionEpoch !== epoch) throw new ModerationError("admission_withdrawn");
    if (review.reviewState === "rejected") throw new ModerationError("enrollment_rejected");
    if (review.reviewState !== "approved") throw new ModerationError("enrollment_review_required");
  }
  const changed = await tx.update(serverAdmission).set({ admitted: true })
    .where(and(eq(serverAdmission.userId, userId), eq(serverAdmission.epoch, epoch), eq(serverAdmission.admitted, false)))
    .returning({ userId: serverAdmission.userId });
  if (changed.length > 0) await advanceModerationRecipientRevisionsInTx(tx, userId);
  return epoch;
}
