import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, and, eq, sql, actors, capabilities, ensureDatabase, getSharedDirectDb, groupMembers, groupRoles, groups,
  moderationActions, moderationRestrictions, moderationSubjects, roleCapabilities, roles, serverAdmission, users,
  moderationAccessAllowedSql, roomMembers, sessions, sessionMessages } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { applyModeration, inspectModerationPerson, readModerationReceipt, recoverModerationEffects, type ModerationDelivery } from "../../src/moderation-coordinator";
import { assertRoomMembershipNotBannedInTx } from "../../src/moderation-membership";
import { findRoomForUserMember, findRoomIdByGraphThreadIdForUser, findRoomIdByGraphThreadIdForOwner, listRoomsForActor, getRoomWithAccess, findCurrentReadableNamespacesForHumanActor, listDiscoverableRoomsForUser, createOpenRoom, createSubthreadRoom, joinOpenRoom, addRoomMember, removeRoomMember, resolveInviteLandingRoomInTx } from "../../src/queries";
import { assertCanInvokeAgent } from "../../src/action-capability-admission";
import { PersonalPolicyResolver } from "../../src/personal-policy-resolver";
import { prepareModerationEnrollmentInTx, completeModerationEnrollmentInTx } from "../../src/moderation-enrollment";

beforeAll(async () => {
  bootstrapTestDbInstance();
  // A concurrent scratch schema conflict should be visible, never auto-reset.
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase();
}, 120_000);

afterAll(async () => { await __resetSharedDirectDbForTests(); });

async function fixture() {
  const db = getSharedDirectDb();
  const [moderator, target] = await db.insert(users).values([
    { name: "Moderation test caller", externalId: randomUUID() },
    { name: "Moderation test target", externalId: randomUUID() },
  ]).returning();
  if (!moderator || !target) throw new Error("Missing fixture Humans");
  await db.insert(actors).values([
    { ownerId: moderator.id, kind: "user", displayName: "Moderator" },
    { ownerId: target.id, kind: "user", displayName: "Target" },
  ]);
  await db.insert(serverAdmission).values([{ userId: moderator.id, admitted: true }, { userId: target.id, admitted: true }]);
  const slugs = ["ban_server_members", "kick_server_members", "view_server_moderation"];
  await db.insert(capabilities).values(slugs.map((slug) => ({ slug, description: "Moderation test permission", category: "moderation" }))).onConflictDoNothing();
  const [role] = await db.insert(roles).values({ slug: `moderation-test-${randomUUID()}`, label: "Moderator", isSystem: false }).returning();
  const [group] = await db.insert(groups).values({ ownerId: moderator.id, type: `custom:moderation-test-${randomUUID()}`, label: "Moderators", isSystem: false }).returning();
  if (!role || !group) throw new Error("Missing fixture grants");
  for (const slug of slugs) {
    const [cap] = await db.select().from(capabilities).where(eq(capabilities.slug, slug));
    if (!cap) throw new Error("Missing fixture capability");
    await db.insert(roleCapabilities).values({ roleId: role.id, capabilityId: cap.id });
  }
  await db.insert(groupRoles).values({ groupId: group.id, roleId: role.id });
  await db.insert(groupMembers).values({ groupId: group.id, userId: moderator.id });
  const inspection = await inspectModerationPerson(moderator.id, target.id, null);
  const command = { operationId: randomUUID(), targetUserId: target.id, roomId: null, action: "ban",
    reason: "Repeated unwanted contact", privateNote: "Staff-only fixture note", expiresAt: null,
    restrictionId: null, restrictionRevision: null, targetRevision: inspection.targetRevision };
  return { moderator, target, command, group };
}

const delivery = (): ModerationDelivery => ({ issuer: "https://identity.example", appendAudit: async () => {}, converge: async () => {} });

describe("moderation authority transactions", () => {
  test("ban and receipt commit together; lifting then replaying cannot re-ban", async () => {
    const f = await fixture();
    const receipt = await applyModeration(f.moderator.id, f.command, delivery());
    expect(receipt.committed).toBe(true);
    expect(receipt.replayed).toBe(false);
    const db = getSharedDirectDb();
    const [access] = await db.select({ allowed: moderationAccessAllowedSql(sql`${users.id}`) }).from(users).where(eq(users.id, f.target.id));
    expect(access?.allowed).toBe(false);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, null);
    await applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), action: "lift",
      targetRevision: inspection.targetRevision, restrictionId: receipt.restrictionId, restrictionRevision: 1 }, delivery());
    const replay = await applyModeration(f.moderator.id, f.command, delivery());
    expect(replay.replayed).toBe(true);
    expect(replay.operationId).toBe(receipt.operationId);
    const [restriction] = await db.select().from(moderationRestrictions).where(eq(moderationRestrictions.id, receipt.restrictionId!));
    expect(restriction?.liftedAt).not.toBeNull();
    const [admission] = await db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
    expect(admission?.admitted).toBe(false);
    expect(admission?.epoch).toBe(1);
    const [subject] = await db.select().from(moderationSubjects).where(eq(moderationSubjects.userId, f.target.id));
    expect(subject?.identityDigest).toBeNull();
  });

  test("audit outage is pending committed success and an exact retry repairs the projection", async () => {
    const f = await fixture();
    const pending = await applyModeration(f.moderator.id, f.command, { ...delivery(), appendAudit: async () => { throw new Error("fixture audit unavailable"); } });
    expect(pending.committed).toBe(true);
    expect(pending.auditRecorded).toBe(false);
    let event: unknown;
    const repaired = await applyModeration(f.moderator.id, f.command, { ...delivery(), appendAudit: async (value) => { event = value; } });
    expect(repaired.auditRecorded).toBe(true);
    expect(repaired.replayed).toBe(true);
    expect(JSON.stringify(event)).not.toContain(f.command.reason);
    expect(JSON.stringify(event)).not.toContain(f.command.privateNote);
    expect((await getSharedDirectDb().select().from(moderationActions).where(eq(moderationActions.operationId, f.command.operationId))).length).toBe(1);
  });

  test("restart delivery survives grant revocation and cannot repeat a lifted ban after readmission", async () => {
    const f = await fixture();
    const db = getSharedDirectDb();
    const receipt = await applyModeration(f.moderator.id, f.command, { ...delivery(),
      converge: async () => "pending", appendAudit: async () => { throw new Error("offline"); } });
    expect(receipt.auditRecorded).toBe(false);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, null);
    await applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), action: "lift",
      targetRevision: inspection.targetRevision, restrictionId: receipt.restrictionId, restrictionRevision: 1 }, delivery());
    const epoch = await db.transaction(tx => prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null));
    await db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null, epoch));
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, f.group.id), eq(groupMembers.userId, f.moderator.id)));
    await Promise.resolve(expect(readModerationReceipt(f.moderator.id, f.command.operationId)).rejects.toThrow("forbidden_scope"));
    let observedAdmitted: boolean | undefined;
    const result = await recoverModerationEffects(f.command.operationId, {
      appendAudit: async () => {},
      converge: async () => {
        const [current] = await db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
        observedAdmitted = current?.admitted;
        return "pending";
      },
    });
    expect(result).toEqual({ auditRecorded: true, converged: false });
    expect(observedAdmitted).toBe(true);
    const [current] = await db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
    expect(current?.epoch).toBe(epoch);
    expect(current?.admitted).toBe(true);
    const [restriction] = await db.select().from(moderationRestrictions).where(eq(moderationRestrictions.id, receipt.restrictionId!));
    expect(restriction?.liftedAt).not.toBeNull();
  });

  test("concurrent workers serialize each effect and audit proceeds when convergence fails", async () => {
    const f = await fixture();
    await applyModeration(f.moderator.id, f.command, { ...delivery(),
      converge: async () => "pending", appendAudit: async () => { throw new Error("offline"); } });
    let audits = 0;
    let convergences = 0;
    const effects = {
      appendAudit: async () => { audits += 1; },
      converge: async () => { convergences += 1; throw new Error("work owner offline"); },
    };
    const results = await Promise.all([
      recoverModerationEffects(f.command.operationId, effects),
      recoverModerationEffects(f.command.operationId, effects),
    ]);
    expect(results).toEqual([{ auditRecorded: true, converged: false }, { auditRecorded: true, converged: false }]);
    expect(audits).toBe(1);
    expect(convergences).toBe(2);
    convergences = 0;
    await Promise.all([
      recoverModerationEffects(f.command.operationId, { ...effects, converge: async () => { convergences += 1; } }),
      recoverModerationEffects(f.command.operationId, { ...effects, converge: async () => { convergences += 1; } }),
    ]);
    expect(audits).toBe(1);
    expect(convergences).toBe(1);
  });

  test("changed payload and revoked authority cannot replay a stored action", async () => {
    const f = await fixture();
    await applyModeration(f.moderator.id, f.command, delivery());
    await Promise.resolve(expect(applyModeration(f.moderator.id, { ...f.command, reason: "Changed" }, delivery())).rejects.toThrow("idempotency_conflict"));
    await getSharedDirectDb().delete(groupMembers).where(and(eq(groupMembers.groupId, f.group.id), eq(groupMembers.userId, f.moderator.id)));
    await Promise.resolve(expect(applyModeration(f.moderator.id, f.command, delivery())).rejects.toThrow("forbidden_scope"));
  });

  test("stale target authority rolls back all action state", async () => {
    const f = await fixture();
    await getSharedDirectDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.target.id));
    await Promise.resolve(expect(applyModeration(f.moderator.id, f.command, delivery())).rejects.toThrow("stale_revision"));
    expect((await getSharedDirectDb().select().from(moderationActions).where(eq(moderationActions.operationId, f.command.operationId))).length).toBe(0);
  });

  test("database guards protect replay identity while permitting text erasure", async () => {
    const f = await fixture();
    await applyModeration(f.moderator.id, f.command, delivery());
    const db = getSharedDirectDb();
    await Promise.resolve(expect(Promise.resolve(db.update(moderationActions).set({ action: "kick" }).where(eq(moderationActions.operationId, f.command.operationId)))).rejects.toThrow());
    await Promise.resolve(expect(Promise.resolve(db.delete(moderationActions).where(eq(moderationActions.operationId, f.command.operationId)))).rejects.toThrow());
    await db.update(moderationActions).set({ reason: null, privateNote: null }).where(eq(moderationActions.operationId, f.command.operationId));
    expect((await applyModeration(f.moderator.id, f.command, delivery())).replayed).toBe(true);
  });

  test("account erasure does not cascade away an active ban or identity match", async () => {
    const f = await fixture();
    const receipt = await applyModeration(f.moderator.id, f.command, delivery());
    const db = getSharedDirectDb();
    await db.delete(users).where(eq(users.id, f.target.id));
    const [restriction] = await db.select().from(moderationRestrictions).where(eq(moderationRestrictions.id, receipt.restrictionId!));
    expect(restriction?.liftedAt).toBeNull();
    const [subject] = await db.select().from(moderationSubjects).where(eq(moderationSubjects.id, restriction!.subjectId));
    expect(subject?.userId).toBeNull();
    expect(subject?.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await applyModeration(f.moderator.id, f.command, delivery())).replayed).toBe(true);
    const [replacement] = await db.insert(users).values({ name: "Different display name", externalId: f.target.externalId }).returning();
    await Promise.resolve(expect(db.transaction(tx => prepareModerationEnrollmentInTx(tx, replacement!.id, delivery().issuer, null))).rejects.toThrow("active_ban"));
  });

  test("a kick requires a fresh enrollment epoch and retains no identity digest", async () => {
    const f = await fixture();
    const db = getSharedDirectDb();
    const oldEpoch = await db.transaction(tx => prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null));
    await applyModeration(f.moderator.id, { ...f.command, action: "kick" }, delivery());
    await Promise.resolve(expect(db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null, oldEpoch))).rejects.toThrow("admission_withdrawn"));
    const [subject] = await db.select().from(moderationSubjects).where(eq(moderationSubjects.userId, f.target.id));
    expect(subject?.identityDigest).toBeNull();
    const newEpoch = await db.transaction(tx => prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null));
    expect(newEpoch).toBe(oldEpoch + 1);
    await db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null, newEpoch));
    const [access] = await db.select({ allowed: moderationAccessAllowedSql(sql`${users.id}`) }).from(users).where(eq(users.id, f.target.id));
    expect(access?.allowed).toBe(true);
  });

  test("pending enrollment has no access and an active ban blocks publication", async () => {
    const f = await fixture();
    const db = getSharedDirectDb();
    await db.delete(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
    const epoch = await db.transaction(tx => prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null));
    const [pending] = await db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
    expect(pending?.admitted).toBe(false);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, null);
    await applyModeration(f.moderator.id, { ...f.command, targetRevision: inspection.targetRevision }, delivery());
    await Promise.resolve(expect(db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null, epoch))).rejects.toThrow("active_ban"));
  });

  test("a withdrawn moderator cannot read or replay their receipt", async () => {
    const f = await fixture();
    await applyModeration(f.moderator.id, f.command, delivery());
    await getSharedDirectDb().update(serverAdmission).set({ admitted: false }).where(eq(serverAdmission.userId, f.moderator.id));
    await Promise.resolve(expect(readModerationReceipt(f.moderator.id, f.command.operationId)).rejects.toThrow("forbidden_scope"));
    await Promise.resolve(expect(applyModeration(f.moderator.id, f.command, delivery())).rejects.toThrow("forbidden_scope"));
  });

  test("concurrent actions from the same revision publish only one outcome", async () => {
    const f = await fixture();
    const second = { ...f.command, operationId: randomUUID(), action: "kick" };
    const outcomes = await Promise.allSettled([
      applyModeration(f.moderator.id, f.command, delivery()),
      applyModeration(f.moderator.id, second, delivery()),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(result => result.status === "rejected");
    expect(failed?.status === "rejected" ? String(failed.reason) : null).toContain("stale_revision");
    const rows = await getSharedDirectDb().select({ id: moderationActions.operationId }).from(moderationActions)
      .where(sql`${moderationActions.operationId} IN (${f.command.operationId}, ${second.operationId})`);
    expect(rows).toHaveLength(1);
  });
});

async function roomFixture() {
  const f = await fixture();
  const db = getSharedDirectDb();
  const [moderatorActor] = await db.select().from(actors).where(and(eq(actors.ownerId, f.moderator.id), eq(actors.kind, "user")));
  const [targetActor] = await db.select().from(actors).where(and(eq(actors.ownerId, f.target.id), eq(actors.kind, "user")));
  if (!moderatorActor || !targetActor) throw new Error("Missing Room fixture Actors");
  const room = await createOpenRoom({ creatorUserId: f.moderator.id, creatorActorId: moderatorActor.id, label: "Moderation Room" });
  const join = () => joinOpenRoom({ userId: f.target.id, actorId: targetActor.id, roomId: room.id });
  await join();
  const ban = async (roomId = room.id) => {
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, roomId);
    return applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), roomId, targetRevision: inspection.targetRevision }, delivery());
  };
  return { ...f, moderatorActor, targetActor, room, join, ban };
}

async function membershipExists(roomId: string, actorId: string): Promise<boolean> {
  const [row] = await getSharedDirectDb().select({ actorId: roomMembers.actorId }).from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)));
  return row !== undefined;
}

async function childRoom(f: Awaited<ReturnType<typeof roomFixture>>) {
  const db = getSharedDirectDb();
  const [session] = await db.insert(sessions).values({ threadId: randomUUID(), ownerId: f.moderator.id,
    personaId: "owner", roomId: f.room.id, channel: "tui" }).returning();
  if (!session) throw new Error("Missing anchor session");
  const [anchor] = await db.insert(sessionMessages).values({ sessionId: session.id, role: "user", content: "Room fixture anchor" }).returning();
  if (!anchor) throw new Error("Missing anchor message");
  return (await createSubthreadRoom({ parentRoomId: f.room.id, anchorMessageId: anchor.id,
    requesterActorId: f.moderatorActor.id })).subthreadRoomId;
}

describe("Room ban re-entry", () => {
  test("self-join, direct addition and explicit Invite landing cannot undo a ban; lift permits an ordinary join", async () => {
    const f = await roomFixture();
    const receipt = await f.ban();
    expect((await listDiscoverableRoomsForUser(f.target.id)).some(room => room.id === f.room.id)).toBe(false);
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(false);
    await Promise.resolve(expect(f.join()).rejects.toMatchObject({ code: "active_ban" }));
    await Promise.resolve(expect(addRoomMember(f.room.id, { userId: f.target.id }, "member")).rejects.toMatchObject({ code: "active_ban" }));
    await Promise.resolve(expect(getSharedDirectDb().transaction(tx => resolveInviteLandingRoomInTx(tx, {
      inviteeUserId: f.target.id, inviteeActorId: f.targetActor.id, targetRoomId: f.room.id,
    }))).rejects.toMatchObject({ code: "active_ban" }));
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(false);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, f.room.id);
    await applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), roomId: f.room.id,
      action: "lift", restrictionId: receipt.restrictionId, restrictionRevision: 1, targetRevision: inspection.targetRevision }, delivery());
    expect((await listDiscoverableRoomsForUser(f.target.id)).some(room => room.id === f.room.id)).toBe(true);
    // Lifting the ban does not itself restore membership.
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(false);
    await f.join();
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(true);
  });

  test("a parent ban removes children and rejects direct child re-entry", async () => {
    const f = await roomFixture();
    const childId = await childRoom(f);
    await f.ban();
    expect(await membershipExists(childId, f.targetActor.id)).toBe(false);
    await Promise.resolve(expect(addRoomMember(childId, { userId: f.target.id }, "member")).rejects.toMatchObject({ code: "active_ban" }));
  });

  test("a child ban survives idempotent parent repair and direct parent re-addition without excluding sibling Rooms", async () => {
    const f = await roomFixture();
    const bannedChild = await childRoom(f);
    const sibling = await childRoom(f);
    await f.ban(bannedChild);
    await f.join();
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(true);
    expect(await membershipExists(bannedChild, f.targetActor.id)).toBe(false);
    expect(await membershipExists(sibling, f.targetActor.id)).toBe(true);
    await removeRoomMember(f.room.id, f.targetActor.id, {});
    await addRoomMember(f.room.id, { userId: f.target.id }, "member");
    expect(await membershipExists(bannedChild, f.targetActor.id)).toBe(false);
    expect(await membershipExists(sibling, f.targetActor.id)).toBe(true);
  });

  test("a transaction started before a ban sees the ban when checking membership and enrollment afterward", async () => {
    const f = await roomFixture();
    await getSharedDirectDb().transaction(async tx => {
      await tx.execute(sql`SELECT CURRENT_TIMESTAMP`);
      await f.ban();
      await Promise.resolve(expect(assertRoomMembershipNotBannedInTx(tx, f.targetActor.id, f.room.id))
        .rejects.toMatchObject({ code: "active_ban" }));
      await Promise.resolve(expect(prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, f.room.id))
        .rejects.toMatchObject({ code: "active_ban" }));
    });
  });

  test("a concurrent public join cannot survive a committed Room ban", async () => {
    const f = await roomFixture();
    await removeRoomMember(f.room.id, f.targetActor.id, {});
    const [ban, join] = await Promise.allSettled([f.ban(), f.join()]);
    if (ban.status === "rejected") {
      expect(ban.reason).toMatchObject({ code: "stale_revision" });
      await f.ban();
    }
    if (join.status === "rejected") expect(join.reason).toMatchObject({ code: "active_ban" });
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(false);
    await Promise.resolve(expect(f.join()).rejects.toMatchObject({ code: "active_ban" }));
  });

  test("a Server ban also rejects Room addition while preserving existing graph rows", async () => {
    const f = await roomFixture();
    await applyModeration(f.moderator.id, f.command, delivery());
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(true);
    await Promise.resolve(expect(f.join()).rejects.toMatchObject({ code: "active_ban" }));
    const other = await createOpenRoom({ creatorUserId: f.moderator.id, creatorActorId: f.moderatorActor.id, label: "Other Room" });
    await Promise.resolve(expect(addRoomMember(other.id, { userId: f.target.id }, "member")).rejects.toMatchObject({ code: "active_ban" }));
  });
});


describe("current Room and Namespace reads after moderation", () => {
  test("Server withdrawal denies retained Room membership, resume and rebuilt envelopes until readmission", async () => {
    const f = await roomFixture();
    const ownRoom = await createOpenRoom({ creatorUserId: f.target.id, creatorActorId: f.targetActor.id, label: "Target owned Room" });
    const moderatorRoom = await createOpenRoom({ creatorUserId: f.moderator.id, creatorActorId: f.moderatorActor.id, label: "Moderator Room" });
    const moderatorAccess = await getRoomWithAccess(moderatorRoom.id);
    const room = await findRoomForUserMember(f.room.id, f.targetActor.id);
    const own = await findRoomForUserMember(ownRoom.id, f.targetActor.id);
    const access = await getRoomWithAccess(f.room.id, f.targetActor.id);
    if (!room || !own || !access || !moderatorAccess) throw new Error("Missing admitted Room fixture");
    const resolver = new PersonalPolicyResolver(f.moderator.id, "");
    expect((await resolver.buildEnvelope(f.targetActor.id, "workbench", undefined, f.room.id)).writableNamespaces).toEqual([access.namespaceId]);
    const receipt = await applyModeration(f.moderator.id, f.command, delivery());
    expect(await membershipExists(f.room.id, f.targetActor.id)).toBe(true);
    expect(await findRoomForUserMember(f.room.id, f.targetActor.id)).toBeNull();
    expect(await findRoomIdByGraphThreadIdForUser(f.target.id, room.graphThreadId)).toBeNull();
    expect(await findRoomIdByGraphThreadIdForOwner(f.target.id, own.graphThreadId)).toBeNull();
    expect(await listRoomsForActor(f.targetActor.id, { includeRoster: false })).toEqual([]);
    expect(await findCurrentReadableNamespacesForHumanActor(f.targetActor.id)).toEqual([]);
    expect(await getRoomWithAccess(f.room.id, f.targetActor.id)).toBeNull();
    const envelope = await resolver.buildEnvelope(f.targetActor.id, "workbench", undefined, f.room.id);
    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
    expect(envelope.mutableNamespaces).toEqual([]);
    expect(await findRoomForUserMember(f.room.id, f.moderatorActor.id)).not.toBeNull();
    expect(await findCurrentReadableNamespacesForHumanActor(f.moderatorActor.id)).toContain(access.namespaceId);
    const remainingEnvelope = await resolver.buildEnvelope(f.moderatorActor.id, "workbench", undefined, f.room.id);
    expect(remainingEnvelope.readableNamespaces).toContain(moderatorAccess.namespaceId);
    expect((await getRoomWithAccess(f.room.id))?.humanActorIds).toEqual([f.moderatorActor.id]);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, null);
    await applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), action: "lift",
      targetRevision: inspection.targetRevision, restrictionId: receipt.restrictionId, restrictionRevision: 1 }, delivery());
    expect(await findRoomForUserMember(f.room.id, f.targetActor.id)).toBeNull();
    const db = getSharedDirectDb();
    const epoch = await db.transaction(tx => prepareModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null));
    await db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, delivery().issuer, null, epoch));
    expect(await findRoomForUserMember(f.room.id, f.targetActor.id)).not.toBeNull();
    expect(await findCurrentReadableNamespacesForHumanActor(f.targetActor.id)).toContain(access.namespaceId);
  });

  test("parent bans deny retained child membership while unrelated Rooms stay accessible", async () => {
    const f = await roomFixture();
    const childId = await childRoom(f);
    const other = await createOpenRoom({ creatorUserId: f.target.id, creatorActorId: f.targetActor.id, label: "Unrelated Room" });
    const child = await findRoomForUserMember(childId, f.targetActor.id);
    const access = await getRoomWithAccess(f.room.id);
    if (!child || !access) throw new Error("Missing child fixture");
    await f.ban();
    expect(await membershipExists(childId, f.targetActor.id)).toBe(false);
    // A stale external projection must not grant authority even if it restores
    // a historical child membership after the canonical removal.
    await getSharedDirectDb().insert(roomMembers).values({ roomId: childId, actorId: f.targetActor.id });
    expect(await membershipExists(childId, f.targetActor.id)).toBe(true);
    expect(await findRoomForUserMember(childId, f.targetActor.id)).toBeNull();
    expect(await findRoomIdByGraphThreadIdForUser(f.target.id, child.graphThreadId)).toBeNull();
    expect((await listRoomsForActor(f.targetActor.id, { includeRoster: false, includeSubthreads: true })).map(row => row.id)).not.toContain(childId);
    expect(await findCurrentReadableNamespacesForHumanActor(f.targetActor.id)).not.toContain(access.namespaceId);
    expect(await getRoomWithAccess(childId, f.targetActor.id)).toBeNull();
    expect(await findRoomForUserMember(other.id, f.targetActor.id)).not.toBeNull();
    expect(await getRoomWithAccess(childId, f.moderatorActor.id)).not.toBeNull();
  });

  test("a Human cannot rebuild a Namespace envelope for another person's Room", async () => {
    const f = await roomFixture();
    const other = await fixture();
    expect(await getRoomWithAccess(f.room.id)).not.toBeNull();
    const [outsider] = await getSharedDirectDb().select().from(actors).where(and(eq(actors.ownerId, other.target.id), eq(actors.kind, "user")));
    if (!outsider) throw new Error("Missing outsider fixture");
    expect(await getRoomWithAccess(f.room.id, outsider.id)).toBeNull();
    const envelope = await new PersonalPolicyResolver(f.moderator.id, "").buildEnvelope(outsider.id, "workbench", undefined, f.room.id);
    expect(envelope.readableNamespaces).toEqual([]);
    expect(envelope.writableNamespaces).toEqual([]);
  });
});


async function grantInvocation(userId: string) {
  const db = getSharedDirectDb();
  const [cap] = await db.insert(capabilities).values({ slug: "invoke_agents", description: "Invoke Genies", category: "agents" })
    .onConflictDoUpdate({ target: capabilities.slug, set: { slug: "invoke_agents" } }).returning();
  const [role] = await db.insert(roles).values({ slug: `invocation-test-${randomUUID()}`, label: "Invoker", isSystem: false }).returning();
  const [group] = await db.insert(groups).values({ ownerId: userId, type: `custom:invocation-${randomUUID()}`, label: "Invokers", isSystem: false }).returning();
  if (!cap || !role || !group) throw new Error("Missing invocation grant fixture");
  await db.insert(roleCapabilities).values({ roleId: role.id, capabilityId: cap.id });
  await db.insert(groupRoles).values({ groupId: group.id, roleId: role.id });
  await db.insert(groupMembers).values({ groupId: group.id, userId });
}

describe("invocation cannot outlive current Human access", () => {
  test("Room bans deny deferred work in scope without replacing transcript membership policy", async () => {
    const f = await roomFixture();
    await grantInvocation(f.target.id);
    const other = await createOpenRoom({ creatorUserId: f.target.id, creatorActorId: f.targetActor.id, label: "Independent work" });
    const input = { humanUserId: f.target.id, origin: "task_dispatch" as const, roomId: f.room.id };
    await assertCanInvokeAgent(input);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, f.room.id);
    await applyModeration(f.moderator.id, { ...f.command, operationId: randomUUID(), roomId: f.room.id,
      action: "ban", targetRevision: inspection.targetRevision }, delivery());
    await Promise.resolve(expect(assertCanInvokeAgent(input)).rejects.toMatchObject({ code: "invocation_access_withdrawn" }));
    await assertCanInvokeAgent({ ...input, roomId: other.id });
    await assertCanInvokeAgent({ ...input, roomId: other.id, origin: "foreground_resume" });
    const deliveryRoom = await createOpenRoom({ creatorUserId: f.moderator.id, creatorActorId: f.moderatorActor.id, label: "Delivery only Room" });
    expect(await membershipExists(deliveryRoom.id, f.targetActor.id)).toBe(false);
    await assertCanInvokeAgent({ ...input, roomId: deliveryRoom.id });
  });

  test("Server withdrawal and independent account disabling override retained invocation grants", async () => {
    const f = await roomFixture();
    await grantInvocation(f.target.id);
    const input = { humanUserId: f.target.id, origin: "background_job" as const };
    await assertCanInvokeAgent(input);
    const db = getSharedDirectDb();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.target.id));
    await Promise.resolve(expect(assertCanInvokeAgent(input)).rejects.toMatchObject({ code: "invocation_access_withdrawn" }));
    expect(await getRoomWithAccess(f.room.id, f.targetActor.id)).toBeNull();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, f.target.id));
    await assertCanInvokeAgent(input);
    const inspection = await inspectModerationPerson(f.moderator.id, f.target.id, null);
    await applyModeration(f.moderator.id, { ...f.command, targetRevision: inspection.targetRevision }, delivery());
    await Promise.resolve(expect(assertCanInvokeAgent(input)).rejects.toMatchObject({ code: "invocation_access_withdrawn" }));
  });
});
