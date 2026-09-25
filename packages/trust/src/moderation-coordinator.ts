import { and, asc, eq, isNull, moderationActions, moderationRestrictions, moderationSubjects, getSharedDirectDb,
  acquireRoomWriteLock, roomMembers, users, sql, type ModerationActionRow } from "@nautilo/db";
import type { ModerationReceipt } from "@nautilo/types";
import { advanceModerationRecipientRevisionsInTx } from "./moderation-recipient-revision";
import { removeRoomMemberInTx } from "./queries";
import { isAuthorityTransactionConflict, lockFingerprintState } from "./rbac-mutation-locks";
import { assertModerationTarget, holdsModerationPermission, ModerationError, normalizeModerationCommand, permissionForModerationAction } from "./moderation-policy";
import { findModerationReplay, requireModerationCaller, loadModerationTarget, moderationLiftPermission,
  projectModerationPerson, projectModerationReceipt, publishModerationAction, resolveModerationSubject } from "./moderation-store";

export interface ModerationEffects {
  /** Private informational confirmation; never changes the committed result. */
  readonly notify?: (row: ModerationActionRow) => Promise<void>;
  /** Redacted event projection only. Private reasons/notes stay in the DB.
   * The sink must deduplicate by operationId across a crash before checkpointing.
   */
  readonly appendAudit: (event: { operationId: string; requesterUserId: string | null; subjectId: string;
    action: ModerationActionRow["action"]; roomId: string | null; createdAt: string }) => Promise<void>;
  /** Reconcile current authority, never repeat the mutation. Partial owners
   * return pending; only complete convergence may advance the checkpoint.
   */
  /** Durable ban cleanup, separately checkpointed from live connection cleanup. */
  readonly deleteCommunityMessages?: (row: ModerationActionRow) => Promise<void>;
  readonly converge?: (operationId: string) => Promise<void | "pending">;
}

export interface ModerationDelivery extends ModerationEffects {
  /** Verified local identity-provider issuer; never read from a request body. */
  readonly issuer: string;
  readonly converge: NonNullable<ModerationEffects["converge"]>;
}

async function deliverModerationAction(row: ModerationActionRow, deps: ModerationEffects): Promise<ModerationActionRow> {
  const db = getSharedDirectDb();
  let delivered = row;
  // Serialize each effect against exact retries and other recovery workers.
  // A committed action survives either effect failing; the other still runs.
  if (deps.converge !== undefined) {
    try {
      delivered = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(moderationActions)
          .where(eq(moderationActions.operationId, row.operationId)).for("update");
        if (!current) throw new Error("Moderation receipt unavailable");
        if (current.convergedAt !== null) return current;
        if (await deps.converge!(current.operationId) === "pending") return current;
        const [updated] = await tx.update(moderationActions).set({ convergedAt: new Date() })
          .where(eq(moderationActions.operationId, current.operationId)).returning();
        return updated!;
      });
    } catch { /* Do not misreport a committed restriction as a failed mutation. */ }
  }
  if (deps.deleteCommunityMessages) {
    try {
      delivered = await db.transaction(async tx => {
        const [current] = await tx.select().from(moderationActions)
          .where(eq(moderationActions.operationId, row.operationId)).for("update");
        if (!current) throw new Error("Moderation receipt unavailable");
        if (!current.deleteCommunityMessages || current.communityMessagesDeletedAt !== null) return current;
        await deps.deleteCommunityMessages!(current);
        const [updated] = await tx.update(moderationActions).set({ communityMessagesDeletedAt: new Date() })
          .where(eq(moderationActions.operationId, current.operationId)).returning();
        return updated!;
      });
    } catch { /* The ban remains committed and cleanup is retried from its receipt. */ }
  }
  try {
    delivered = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(moderationActions)
        .where(eq(moderationActions.operationId, row.operationId)).for("update");
      if (!current) throw new Error("Moderation receipt unavailable");
      if (current.auditRecordedAt !== null) return current;
      await deps.appendAudit({ operationId: current.operationId, requesterUserId: current.requesterUserId,
        subjectId: current.subjectId, action: current.action, roomId: current.roomId, createdAt: current.createdAt.toISOString() });
      const [updated] = await tx.update(moderationActions).set({ auditRecordedAt: new Date() })
        .where(eq(moderationActions.operationId, current.operationId)).returning();
      return updated!;
    });
  } catch { /* The committed action and pending checkpoint are the recovery source. */ }
  try { await deps.notify?.(delivered); } catch { /* Feed availability cannot undo moderation. */ }
  return delivered;
}

/** Trusted delivery worker only: no command, caller authority, or mutation replay.
 * Revoking the original moderator cannot cancel effects of a committed decision.
 * HTTP callers must continue to use the scoped receipt reader below.
 */
export async function recoverModerationEffects(operationId: string, deps: ModerationEffects): Promise<{
  auditRecorded: boolean; converged: boolean;
}> {
  const [row] = await getSharedDirectDb().select().from(moderationActions)
    .where(eq(moderationActions.operationId, operationId));
  if (!row) throw new Error("Moderation receipt unavailable");
  const delivered = await deliverModerationAction(row, deps);
  return { auditRecorded: delivered.auditRecordedAt !== null, converged: delivered.convergedAt !== null };
}

export async function inspectModerationPerson(callerUserId: string, targetUserId: string, roomId: string | null) {
  return projectModerationPerson(await loadModerationTarget(getSharedDirectDb(), callerUserId, targetUserId, roomId));
}

/** A single owner for authority checks, canonical membership changes and receipt. */
export async function applyModeration(callerUserId: string, raw: unknown, deps: ModerationDelivery): Promise<ModerationReceipt> {
  const command = normalizeModerationCommand(raw);
  // Participation actions are enabled only with their complete writer/work gates.
  if (command.action === "timeout" || command.action === "mute") throw new ModerationError("invalid_request");
  const db = getSharedDirectDb();
  let outcome: { row: ModerationActionRow; replayed: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      const replay = await findModerationReplay(tx, callerUserId, command);
      await lockFingerprintState(tx);
      await tx.select({ id: users.id }).from(users).where(sql`${users.id} IN (${callerUserId}, ${command.targetUserId})`).orderBy(asc(users.id)).for("update");
      if (replay) {
        // A caller can reconcile their own exact action under current action or
        // history authority. This does not expose anyone else's private notes.
        await authorizeReceipt(tx, callerUserId, replay);
        return { row: replay, replayed: true };
      }
      const snapshot = await loadModerationTarget(tx, callerUserId, command.targetUserId, command.roomId);
      const permission = command.action === "lift" ? await moderationLiftPermission(tx, command) : permissionForModerationAction(command.action);
      assertModerationTarget({ caller: snapshot.caller, target: snapshot.target, roomId: command.roomId,
        permission, removesAccess: command.action === "ban" || command.action === "kick",
        targetOwnsRoom: snapshot.room?.ownerId === command.targetUserId });
      if (snapshot.revision !== command.targetRevision) throw new ModerationError("stale_revision");
      const now = new Date();
      if (command.expiresAt !== null && new Date(command.expiresAt) <= now) throw new ModerationError("invalid_request");
      const subjectId = await resolveModerationSubject(tx, snapshot.person, deps.issuer);
      if (command.roomId !== null && (command.action === "ban" || command.action === "kick")) {
        // Lock even when this snapshot has no membership. A concurrent join
        // changes Room authority and must invalidate a stale serializable view.
        await acquireRoomWriteLock(tx, command.roomId);
        const [membership] = await tx.select({ actorId: roomMembers.actorId }).from(roomMembers)
          .where(and(eq(roomMembers.roomId, command.roomId), eq(roomMembers.actorId, snapshot.actorId)));
        if (membership) await removeRoomMemberInTx(tx, command.roomId, snapshot.actorId, {});
      }
      const row = await publishModerationAction(tx, callerUserId, subjectId, command, now);
      if (command.roomId === null && (command.action === "ban" || command.action === "kick")) {
        await advanceModerationRecipientRevisionsInTx(tx, command.targetUserId);
      }
      if (command.action === "lift" || command.action === "kick") {
        const [activeBan] = await tx.select({ id: moderationRestrictions.id }).from(moderationRestrictions)
          .where(and(eq(moderationRestrictions.subjectId, subjectId), eq(moderationRestrictions.kind, "access"),
            isNull(moderationRestrictions.liftedAt), sql`(${moderationRestrictions.expiresAt} IS NULL OR ${moderationRestrictions.expiresAt} > CURRENT_TIMESTAMP)`)).limit(1);
        if (!activeBan) await tx.update(moderationSubjects).set({ identityDigest: null }).where(eq(moderationSubjects.id, subjectId));
      }
      return { row, replayed: false };
    });
  } catch (e) {
    if (isAuthorityTransactionConflict(e)) throw new ModerationError("stale_revision");
    throw e;
  }
  return projectModerationReceipt(await deliverModerationAction(outcome.row, deps), outcome.replayed);
}

async function authorizeReceipt(db: Pick<ReturnType<typeof getSharedDirectDb>, "select">, callerUserId: string, row: ModerationActionRow) {
  const authority = await requireModerationCaller(db, callerUserId, row.roomId);
  const [restriction] = row.action === "lift" && row.restrictionId
    ? await db.select({ kind: moderationRestrictions.kind }).from(moderationRestrictions).where(eq(moderationRestrictions.id, row.restrictionId)) : [];
  const ownPermission = row.action === "lift" ? (restriction?.kind === "participation" ? "timeout" : "ban") : permissionForModerationAction(row.action);
  if (!holdsModerationPermission(authority, "view", row.roomId)
    && !(row.requesterUserId === callerUserId && holdsModerationPermission(authority, ownPermission, row.roomId))) throw new ModerationError("forbidden_scope");
}

export async function readModerationReceipt(callerUserId: string, operationId: string): Promise<ModerationReceipt> {
  const db = getSharedDirectDb();
  const [row] = await db.select().from(moderationActions).where(eq(moderationActions.operationId, operationId));
  if (!row) throw new ModerationError("target_unavailable");
  await authorizeReceipt(db, callerUserId, row);
  return projectModerationReceipt(row, true);
}
