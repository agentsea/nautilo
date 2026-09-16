/**
 * M157 — room-list `kind` filtering.
 *
 * Proves the query-layer guards that keep internal subagent rooms out of
 * user-facing room-list surfaces:
 *   - `kind='task'` orphan rooms (subagent transcript holders, zero human
 *     members) never appear in `listRoomsForActor` (explorer feed) NOR in
 *     `listManageableRoomsForUser` (the /manage-rooms picker, owner + admin).
 *   - `kind='subthread'` rooms are hidden from user-facing lists, but internal
 *     realtime membership enumeration can explicitly include them.
 *   - normal `private` rooms are unaffected (visible in both surfaces).
 *
 * Runs against a live, already-migrated instance (NAUTILO_INSTANCE_ID selects
 * it) — does NOT call ensureDatabase, so no migrations are applied.
 */
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createDirectDb, eq, rooms, sql } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  listRoomsForActor,
  listManageableRoomsForUser,
  renamePrivateRoomForOwner,
} from "../../src/queries";
import {
  Tracker,
  cleanupAll,
  mkActor,
  mkAgent,
  mkMessage,
  mkNamespace,
  mkRoom,
  mkSession,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const t = new Tracker();

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(2);
});

afterAll(async () => {
  try {
    await cleanupAll(db, t);
  } finally {
    await db.end();
  }
});

describe("M157 room-list kind filtering", () => {
  test("task room is hidden from explorer feed AND picker (owner + admin)", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "m157task");
    const human = await mkActor(db, t, uid, "M157 Task Owner");
    // Mirror resolveOrphan: owned by the task owner, zero human members,
    // zero room_members.
    const taskRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [],
      memberActorIds: [],
      kind: "task",
      type: "private",
    });

    const explorer = await listRoomsForActor(human);
    expect(explorer.some((r) => r.id === taskRoomId)).toBe(false);

    const ownerPicker = await listManageableRoomsForUser(uid, { isAdmin: false });
    expect(ownerPicker.some((r) => r.id === taskRoomId)).toBe(false);

    const adminPicker = await listManageableRoomsForUser(uid, { isAdmin: true });
    expect(adminPicker.some((r) => r.id === taskRoomId)).toBe(false);
  });

  test("subthread is hidden from lists but retained for explicit realtime scope", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "m157sub");
    const human = await mkActor(db, t, uid, "M157 Sub Owner");
    const agentActor = await mkActor(db, t, uid, "M157 Sub Bot", {
      kind: "agent",
      agentId,
    });

    const parentId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });
    const pSess = await mkSession(db, t, { roomId: parentId, ownerId: uid, agentId });
    let rootMsg = 0;
    for (let i = 0; i < 2; i++) {
      rootMsg = await mkMessage(db, t, { sessionId: pSess, role: "assistant" });
    }
    // subthread invariant requires both parent_room_id + thread_root_message_id.
    const subId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "subthread",
      parentRoomId: parentId,
      threadRootMessageId: rootMsg,
    });

    // Picker: subthread excluded (parent still shown).
    const ownerPicker = await listManageableRoomsForUser(uid, { isAdmin: false });
    expect(ownerPicker.some((r) => r.id === subId)).toBe(false);
    expect(ownerPicker.some((r) => r.id === parentId)).toBe(true);

    // Explorer/default: child hidden; parent remains navigable.
    const explorer = await listRoomsForActor(human);
    expect(explorer.some((r) => r.id === subId)).toBe(false);
    expect(explorer.some((r) => r.id === parentId)).toBe(true);

    // Realtime lane enumeration explicitly retains child memberships.
    const realtime = await listRoomsForActor(human, {
      includeRoster: false,
      includeSubthreads: true,
    });
    expect(realtime.some((r) => r.id === subId)).toBe(true);
    expect(realtime.some((r) => r.id === parentId)).toBe(true);
  });

  test("M173: access room is hidden from explorer feed AND picker", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "m173access");
    const human = await mkActor(db, t, uid, "M173 Access Owner");
    // An access room HAS humans (unlike task rooms) but no conversation; it must
    // still never surface as a chat.
    const accessRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "access",
      type: "shared",
    });

    const explorer = await listRoomsForActor(human);
    expect(explorer.some((r) => r.id === accessRoomId)).toBe(false);

    const ownerPicker = await listManageableRoomsForUser(uid, { isAdmin: false });
    expect(ownerPicker.some((r) => r.id === accessRoomId)).toBe(false);

    const adminPicker = await listManageableRoomsForUser(uid, { isAdmin: true });
    expect(adminPicker.some((r) => r.id === accessRoomId)).toBe(false);
  });

  test("M173: rooms_kind_check admits 'access' and rejects a bogus kind", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "m173check");
    // Inserting kind='access' must succeed (proves 0090 widened the CHECK).
    const ok = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [],
      memberActorIds: [],
      kind: "access",
    });
    expect(ok).toBeTruthy();

    // A bogus kind must be rejected by rooms_kind_check (proves the CHECK still
    // enforces — i.e. 0090 didn't drop the constraint or any prior value).
    const ns2 = await mkNamespace(db, t);
    let rejected = false;
    try {
      await db.execute(sql`
        INSERT INTO rooms (id, owner_id, type, kind, label, graph_thread_id, namespace_id, human_actor_ids)
        VALUES (${randomUUID()}, ${uid}, 'private', 'definitely_not_a_kind', 'bad', ${`room:bogus-${randomUUID()}`}, ${ns2}, '{}')
      `);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("normal private room is unaffected — visible in both surfaces", async () => {
    const ns = await mkNamespace(db, t);
    const agentId = await mkAgent(db, t);
    const uid = await mkUser(db, t, "m157priv");
    const human = await mkActor(db, t, uid, "M157 Priv Owner");
    const agentActor = await mkActor(db, t, uid, "M157 Priv Bot", {
      kind: "agent",
      agentId,
    });
    const roomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human, agentActor],
      kind: "private",
    });

    const explorer = await listRoomsForActor(human);
    expect(explorer.some((r) => r.id === roomId)).toBe(true);

    const ownerPicker = await listManageableRoomsForUser(uid, { isAdmin: false });
    expect(ownerPicker.some((r) => r.id === roomId)).toBe(true);

    const adminPicker = await listManageableRoomsForUser(uid, { isAdmin: true });
    expect(adminPicker.some((r) => r.id === roomId)).toBe(true);
  });

  test("manageable rows carry one-batch roster membership and include archived rows only on request", async () => {
    const ns = await mkNamespace(db, t);
    const uid = await mkUser(db, t, "d529manageable");
    const human = await mkActor(db, t, uid, "D529 Manager");
    const activeRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "group",
      type: "shared",
    });
    const archivedRoomId = await mkRoom(db, t, {
      ownerId: uid,
      namespaceId: ns,
      humanActorIds: [human],
      memberActorIds: [human],
      kind: "group",
      type: "shared",
    });
    await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, archivedRoomId));

    const active = await listManageableRoomsForUser(uid, { isAdmin: false });
    expect(active.some((room) => room.id === archivedRoomId)).toBe(false);
    expect(active.find((room) => room.id === activeRoomId)?.roster).toEqual([
      expect.objectContaining({ actorId: human, kind: "user" }),
    ]);

    const includingArchived = await listManageableRoomsForUser(uid, {
      isAdmin: false,
      includeArchived: true,
    });
    const archived = includingArchived.find((room) => room.id === archivedRoomId);
    expect(archived?.kind).toBe("group");
    expect(archived?.roster).toEqual([
      expect.objectContaining({ actorId: human, kind: "user" }),
    ]);
  });

  test("global Room managers may rename another owner's private Room only as members", async () => {
    const ns = await mkNamespace(db, t);
    const ownerUserId = await mkUser(db, t, "d529renameowner");
    const managerUserId = await mkUser(db, t, "d529renamemanager");
    const outsiderUserId = await mkUser(db, t, "d529renameoutsider");
    const ownerActorId = await mkActor(db, t, ownerUserId, "D529 Rename Owner");
    const managerActorId = await mkActor(db, t, managerUserId, "D529 Rename Manager");
    const outsiderActorId = await mkActor(db, t, outsiderUserId, "D529 Rename Outsider");
    const privateRoomId = await mkRoom(db, t, {
      ownerId: ownerUserId,
      namespaceId: ns,
      humanActorIds: [ownerActorId, managerActorId],
      memberActorIds: [ownerActorId, managerActorId],
      kind: "private",
      type: "private",
    });

    expect(await renamePrivateRoomForOwner({
      roomId: privateRoomId,
      ownerUserId: managerUserId,
      requesterActorId: managerActorId,
      label: "Manager renamed",
    })).toBeNull();
    expect((await renamePrivateRoomForOwner({
      roomId: privateRoomId,
      ownerUserId: managerUserId,
      requesterActorId: managerActorId,
      label: "Manager renamed",
      allowNonOwner: true,
    }))?.label).toBe("Manager renamed");
    expect(await renamePrivateRoomForOwner({
      roomId: privateRoomId,
      ownerUserId: outsiderUserId,
      requesterActorId: outsiderActorId,
      label: "Outsider rename",
      allowNonOwner: true,
    })).toBeNull();

    const sharedRoomId = await mkRoom(db, t, {
      ownerId: ownerUserId,
      namespaceId: ns,
      humanActorIds: [ownerActorId, managerActorId],
      memberActorIds: [ownerActorId, managerActorId],
      kind: "group",
      type: "shared",
    });
    expect(await renamePrivateRoomForOwner({
      roomId: sharedRoomId,
      ownerUserId: managerUserId,
      requesterActorId: managerActorId,
      label: "Shared rename",
      allowNonOwner: true,
    })).toBeNull();
  });
});
