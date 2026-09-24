import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  __resetSharedDirectDbForTests, __resetSharedDirectCryptoDbForTests, getSharedDirectCryptoDb, actors, capabilities, createPostgresJsBridgeConnection,
  ensureDatabase, eq, getSharedDirectDb, groupMembers, groupRoles, groups, roleCapabilities,
  roles, rooms, serverAdmission, sql, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { addRoomMember, createOpenRoom } from "@nautilo/trust";
import { applyModeration, inspectModerationPerson } from "../../../trust/src/moderation-coordinator";
import { completeModerationEnrollmentInTx } from "../../../trust/src/moderation-enrollment";
import { PostgresNamespaceProductAuthority, inspectNamespaceProductAuthoritySnapshot } from "../../src/server/delivery/postgres-namespace-product-authority";

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase();
}, 120_000);
afterAll(async () => { await __resetSharedDirectCryptoDbForTests(); await __resetSharedDirectDbForTests(); });

async function fixture() {
  const db = getSharedDirectDb();
  const people = await db.insert(users).values([{ name: "Recipient moderator" }, { name: "Recipient target" }]).returning();
  const moderator = people[0]!, target = people[1]!;
  const members = await db.insert(actors).values(people.map(person => ({ ownerId: person.id, kind: "user" as const, displayName: person.name }))).returning();
  const moderatorActor = members.find(actor => actor.ownerId === moderator.id)!, targetActor = members.find(actor => actor.ownerId === target.id)!;
  await db.insert(serverAdmission).values(people.map(person => ({ userId: person.id, admitted: true })));
  const slugs = ["ban_server_members", "kick_server_members", "view_server_moderation"];
  await db.insert(capabilities).values(slugs.map(slug => ({ slug, description: "Recipient test", category: "moderation" }))).onConflictDoNothing();
  const [role] = await db.insert(roles).values({ slug: `recipient-${randomUUID()}`, label: "Moderator", isSystem: false }).returning();
  const [group] = await db.insert(groups).values({ ownerId: moderator.id, type: `custom:recipient-${randomUUID()}`, label: "Moderator", isSystem: false }).returning();
  for (const slug of slugs) {
    const [capability] = await db.select().from(capabilities).where(eq(capabilities.slug, slug));
    await db.insert(roleCapabilities).values({ roleId: role!.id, capabilityId: capability!.id });
  }
  await db.insert(groupRoles).values({ groupId: group!.id, roleId: role!.id });
  await db.insert(groupMembers).values({ groupId: group!.id, userId: moderator.id });
  const room = await createOpenRoom({ creatorUserId: moderator.id, creatorActorId: moderatorActor.id, label: "Recipient test Room" });
  await addRoomMember(room.id, { userId: target.id }, "member");
  const bridge = createPostgresJsBridgeConnection(db);
  const authority = new PostgresNamespaceProductAuthority(bridge);
  const snapshot = (person = moderator, actor = moderatorActor) => authority.withCurrentHumanNamespaceRoom({
    subjectUserId: person.id, subjectHumanId: actor.id, roomId: room.id, namespaceId: room.namespaceId!,
    use: async handle => {
      const current = inspectNamespaceProductAuthoritySnapshot(handle);
      return { participants: current.participantHumanIds.map(String), revision: current.accessRevision, namespace: current.namespaceId };
    },
  });
  const moderate = async (action: "ban" | "kick", roomId: string | null = null) => {
    const current = await inspectModerationPerson(moderator.id, target.id, roomId);
    return applyModeration(moderator.id, { operationId: randomUUID(), targetUserId: target.id, roomId, action,
      reason: "Recipient test", privateNote: null, expiresAt: null, restrictionId: null, restrictionRevision: null,
      targetRevision: current.targetRevision }, { issuer: "https://identity.example", appendAudit: async () => {}, converge: async () => {} });
  };
  return { db, moderator, target, moderatorActor, targetActor, room, snapshot, moderate };
}

test("Server removal fences old encryption authority without deleting the canonical Room roster", async () => {
  const f = await fixture();
  const before = await f.snapshot();
  expect(before?.participants).toEqual([f.moderatorActor.id, f.targetActor.id].sort());
  await f.moderate("ban");
  const after = await f.snapshot();
  expect(after?.participants).toEqual([f.moderatorActor.id]);
  expect(after!.revision).toBeGreaterThan(before!.revision);
  expect(after?.namespace).toBe(before?.namespace);
  expect(await f.snapshot(f.target, f.targetActor)).toBeNull();
  const [stored] = await f.db.select().from(rooms).where(eq(rooms.id, f.room.id));
  expect(stored?.humanActorIds).toEqual(before?.participants);
});

test("fresh Invite readmission advances encryption authority again and exact completion replay does not", async () => {
  const f = await fixture();
  await f.moderate("kick");
  const removed = await f.snapshot();
  expect(removed?.participants).toEqual([f.moderatorActor.id]);
  const [admission] = await f.db.select().from(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
  await f.db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, undefined, null, admission!.epoch));
  const admitted = await f.snapshot(f.target, f.targetActor);
  expect(admitted?.participants).toEqual([f.moderatorActor.id, f.targetActor.id].sort());
  expect(admitted!.revision).toBeGreaterThan(removed!.revision);
  await f.db.transaction(tx => completeModerationEnrollmentInTx(tx, f.target.id, undefined, null, admission!.epoch));
  expect((await f.snapshot())?.revision).toBe(admitted?.revision);
});

test("scoped bans preserve other Room recipients and missing Server admission fails closed", async () => {
  const f = await fixture();
  const other = await createOpenRoom({ creatorUserId: f.moderator.id, creatorActorId: f.moderatorActor.id, label: "Unrelated recipient Room" });
  await addRoomMember(other.id, { userId: f.target.id }, "member");
  await f.moderate("ban", other.id);
  expect((await f.snapshot(f.target, f.targetActor))?.participants).toHaveLength(2);
  await f.db.delete(serverAdmission).where(eq(serverAdmission.userId, f.target.id));
  expect(await f.snapshot(f.target, f.targetActor)).toBeNull();
  expect((await f.snapshot())?.participants).toEqual([f.moderatorActor.id]);
});

test("crypto sees only the access projection; agent and private moderation tables remain excluded", async () => {
  const rows = await getSharedDirectDb().execute(sql`SELECT
    has_function_privilege('nautilo_crypto', 'public.moderation_effective_humans(uuid[],uuid)', 'EXECUTE') AS crypto_projection,
    has_function_privilege('nautilo_agent', 'public.moderation_effective_humans(uuid[],uuid)', 'EXECUTE') AS agent_projection,
    has_table_privilege('nautilo_crypto', 'moderation_actions', 'SELECT') AS crypto_actions,
    has_table_privilege('nautilo_crypto', 'moderation_restrictions', 'SELECT') AS crypto_restrictions`);
  expect(rows[0]).toMatchObject({ crypto_projection: true, agent_projection: false, crypto_actions: false, crypto_restrictions: false });
});


test("the restricted crypto role executes the recipient projection without reading moderation records", async () => {
  const f = await fixture();
  const crypto = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
  const candidates = [f.moderatorActor.id, f.targetActor.id].sort();
  const read = () => crypto.query("SELECT public.moderation_effective_humans($1::uuid[], $2::uuid)::text[] AS humans", [candidates, f.room.id]);
  expect((await read())[0]?.["humans"]).toEqual(candidates);
  await f.moderate("ban");
  expect((await read())[0]?.["humans"]).toEqual([f.moderatorActor.id]);
  await Promise.resolve(expect(crypto.query("SELECT reason FROM moderation_actions")).rejects.toThrow());
});
