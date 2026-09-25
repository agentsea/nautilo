import { createHash, randomUUID } from "node:crypto";
import { lockModerationIdentity } from "./moderation-enrollment";
import {
  and, asc, eq, inArray, isNull, or, sql,
  actors, capabilities, groupMembers, groupRoles, groups, roleCapabilities, roles, rooms,
  groupModerationScopes, moderationActions, moderationRestrictions, moderationSubjects, serverAdmission,
  moderationAccessAllowedSql,
  type InviteSeedTx, type ModerationActionRow,
  users,
} from "@nautilo/db";
import type { ModerationCommand, ModerationPerson, ModerationReceipt } from "@nautilo/types";
import {
  assertModerationTarget, holdsModerationPermission, ModerationError,
  moderationIdentityDigest, moderationRequestDigest,
  type ModerationAuthority, type ModerationGroupGrant,
} from "./moderation-policy";

export async function loadModerationAuthority(tx: Pick<InviteSeedTx, "select">, userId: string): Promise<ModerationAuthority> {
  const [user] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
  if (!user) throw new ModerationError("target_unavailable");
  const rows = await tx.select({ groupId: groups.id, groupType: groups.type, slug: capabilities.slug })
    .from(groupMembers).innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(roles.id, groupRoles.roleId))
    .innerJoin(roleCapabilities, eq(roleCapabilities.roleId, roles.id))
    .innerJoin(capabilities, eq(capabilities.id, roleCapabilities.capabilityId))
    .where(eq(groupMembers.userId, userId)).orderBy(asc(groups.id), asc(capabilities.slug));
  const groupIds = [...new Set(rows.map((r) => r.groupId))];
  const scopeRows = groupIds.length ? await tx.select().from(groupModerationScopes)
    .where(inArray(groupModerationScopes.groupId, groupIds)).orderBy(asc(groupModerationScopes.roomId)) : [];
  const grants: ModerationGroupGrant[] = groupIds.map((groupId) => ({
    groupId,
    capabilities: [...new Set(rows.filter((r) => r.groupId === groupId).map((r) => r.slug))],
    roomIds: scopeRows.filter((r) => r.groupId === groupId).map((r) => r.roomId),
  }));
  return { userId, disabled: user.disabledAt !== null, owner: rows.some((r) => r.groupType === "owners"), grants };
}

export async function requireModerationCaller(tx: Pick<InviteSeedTx, "select">, callerUserId: string, roomId: string | null) {
  const caller = await loadModerationAuthority(tx, callerUserId);
  if (!["ban", "kick", "timeout", "view"].some((p) => holdsModerationPermission(caller, p as "ban" | "kick" | "timeout" | "view", roomId))) throw new ModerationError("forbidden_scope");
  const [callerAdmission] = await tx.select({ allowed: moderationAccessAllowedSql(sql`${users.id}`, roomId === null ? undefined : sql`${roomId}`) }).from(users).where(eq(users.id, callerUserId));
  if (!callerAdmission?.allowed) throw new ModerationError("forbidden_scope");
  return caller;
}

export async function loadModerationTarget(tx: Pick<InviteSeedTx, "select">, callerUserId: string, targetUserId: string, roomId: string | null) {
  const caller = await requireModerationCaller(tx, callerUserId, roomId);
  const [target] = await tx.select({ id: users.id, name: users.name, externalId: users.externalId, server: users.server })
    .from(users).where(eq(users.id, targetUserId));
  if (!target) throw new ModerationError("target_unavailable");
  const targetAuthority = await loadModerationAuthority(tx, targetUserId);
  const [targetActor] = await tx.select({ id: actors.id }).from(actors).where(and(eq(actors.ownerId, targetUserId), eq(actors.kind, "user")));
  if (!targetActor) throw new ModerationError("target_unavailable");
  const room = roomId === null ? null : (await tx.select({ id: rooms.id, ownerId: rooms.ownerId, kind: rooms.kind })
    .from(rooms).where(eq(rooms.id, roomId)))[0];
  if (roomId !== null && (!room || room.kind === "access")) throw new ModerationError("target_unavailable");
  const [admission] = await tx.select().from(serverAdmission).where(eq(serverAdmission.userId, targetUserId));
  const revision = createHash("sha256").update(JSON.stringify({ caller, target: targetAuthority, targetActor, room, admission })).digest("hex");
  return { caller, target: targetAuthority, person: target, actorId: targetActor.id, room, revision };
}

export function projectModerationPerson(snapshot: Awaited<ReturnType<typeof loadModerationTarget>>): ModerationPerson {
  const roomId = snapshot.room?.id ?? null;
  const allowedActions = (["ban", "kick"] as const).filter((action) => {
    if (snapshot.person.server !== null) return false;
    try {
      assertModerationTarget({ caller: snapshot.caller, target: snapshot.target, roomId,
        permission: action, removesAccess: true, targetOwnsRoom: snapshot.room?.ownerId === snapshot.target.userId });
      return true;
    } catch (e) { if (e instanceof ModerationError) return false; throw e; }
  });
  return { userId: snapshot.target.userId, displayName: snapshot.person.name, roomId,
    targetRevision: snapshot.revision, allowedActions,
    protectedTarget: snapshot.target.owner || snapshot.caller.userId === snapshot.target.userId
      || snapshot.room?.ownerId === snapshot.target.userId };
}

export function projectModerationReceipt(row: ModerationActionRow, replayed: boolean): ModerationReceipt {
  return { operationId: row.operationId, action: row.action, roomId: row.roomId,
    restrictionId: row.restrictionId, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt?.toISOString() ?? null,
    messageCleanup: !row.deleteCommunityMessages ? "not_requested" : row.communityMessagesDeletedAt ? "complete" : "pending",
    committed: true, replayed, auditRecorded: row.auditRecordedAt !== null, converged: row.convergedAt !== null };
}

/** Acquire before inspecting authority. An exact historical retry never writes. */
export async function findModerationReplay(tx: InviteSeedTx, requesterUserId: string, command: ModerationCommand): Promise<ModerationActionRow | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation:operation:${command.operationId}`}, 0))`);
  const [row] = await tx.select().from(moderationActions).where(eq(moderationActions.operationId, command.operationId));
  if (!row) return null;
  if (row.requesterUserId !== requesterUserId || row.requestDigest !== moderationRequestDigest(command)) throw new ModerationError("idempotency_conflict");
  return row;
}

/** Caller already holds current authorization and target locks in this transaction. */
export async function resolveModerationSubject(tx: InviteSeedTx, person: { id: string; externalId: string | null; server: string | null }, issuer: string) {
  // Display-name federation stubs do not establish an authenticated external subject.
  if (person.server !== null) throw new ModerationError("unsupported_identity");
  const digest = person.externalId === null ? null : moderationIdentityDigest(issuer, person.externalId);
  if (digest !== null) await lockModerationIdentity(tx, digest);
  const [existing] = await tx.select().from(moderationSubjects).where(or(eq(moderationSubjects.userId, person.id),
    ...(digest === null ? [] : [eq(moderationSubjects.identityDigest, digest)]))).for("update");
  if (existing) {
    if (existing.userId !== null && existing.userId !== person.id) throw new ModerationError("unsupported_identity");
    await tx.update(moderationSubjects).set({ userId: person.id, identityDigest: digest }).where(eq(moderationSubjects.id, existing.id));
    return existing.id;
  }
  const [created] = await tx.insert(moderationSubjects).values({ userId: person.id, identityDigest: digest }).returning({ id: moderationSubjects.id });
  if (!created) throw new Error("Moderation subject insert failed");
  return created.id;
}

/** All writes, including the receipt, share the coordinator's authority transaction. */
export async function publishModerationAction(tx: InviteSeedTx, requesterUserId: string, subjectId: string, command: ModerationCommand, now: Date): Promise<ModerationActionRow> {
  const restrictionId = command.action === "kick" ? null : command.restrictionId ?? randomUUID();
  const [row] = await tx.insert(moderationActions).values({
    operationId: command.operationId, requesterUserId, subjectId, roomId: command.roomId,
    requestDigest: moderationRequestDigest(command), action: command.action, restrictionId,
    reason: command.reason, privateNote: command.privateNote, deleteCommunityMessages: command.deleteCommunityMessages ?? false,
    expiresAt: command.expiresAt === null ? null : new Date(command.expiresAt), createdAt: now,
  }).returning();
  if (!row) throw new Error("Moderation receipt insert failed");
  if (command.action === "lift") {
    const lifted = await tx.update(moderationRestrictions).set({ liftedAt: now, liftOperationId: command.operationId,
      revision: sql`${moderationRestrictions.revision} + 1` }).where(and(
      eq(moderationRestrictions.id, restrictionId!), eq(moderationRestrictions.subjectId, subjectId),
      command.roomId === null ? isNull(moderationRestrictions.roomId) : eq(moderationRestrictions.roomId, command.roomId),
      eq(moderationRestrictions.revision, command.restrictionRevision!), isNull(moderationRestrictions.liftedAt),
    )).returning({ id: moderationRestrictions.id });
    if (lifted.length !== 1) throw new ModerationError("stale_revision");
  } else if (restrictionId !== null) {
    await tx.insert(moderationRestrictions).values({ id: restrictionId, subjectId, roomId: command.roomId,
      kind: command.action === "ban" ? "access" : "participation", startsAt: now,
      expiresAt: row.expiresAt, createOperationId: command.operationId });
  }
  if (command.roomId === null && (command.action === "ban" || command.action === "kick")) {
    await tx.insert(serverAdmission).values({ userId: command.targetUserId, admitted: false, epoch: 1, operationId: command.operationId })
      .onConflictDoUpdate({ target: serverAdmission.userId, set: { admitted: false, epoch: sql`${serverAdmission.epoch} + 1`, operationId: command.operationId } });
  }
  return row;
}

export async function moderationLiftPermission(tx: InviteSeedTx, command: ModerationCommand): Promise<"ban" | "timeout"> {
  const [row] = await tx.select({ kind: moderationRestrictions.kind }).from(moderationRestrictions)
    .innerJoin(moderationSubjects, eq(moderationSubjects.id, moderationRestrictions.subjectId))
    .where(and(eq(moderationRestrictions.id, command.restrictionId!), eq(moderationSubjects.userId, command.targetUserId),
      command.roomId === null ? isNull(moderationRestrictions.roomId) : eq(moderationRestrictions.roomId, command.roomId)));
  if (!row) throw new ModerationError("target_unavailable");
  return row.kind === "access" ? "ban" : "timeout";
}
