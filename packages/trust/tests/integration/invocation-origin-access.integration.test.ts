import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, actors, agents, and, ensureDatabase, eq,
  getSharedDirectDb, namespaces, roomMembers, rooms, serverAdmission, tasks, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { isInvocationAccessAllowed } from "../../src/action-capability-admission";

beforeAll(async () => { bootstrapTestDbInstance(); await ensureDatabase(); }, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); });

async function fixture() {
  const db = getSharedDirectDb();
  const [human] = await db.insert(users).values({ name: "Origin authority fixture", externalId: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ handle: `origin-${randomUUID()}` }).returning();
  const [actor] = await db.insert(actors).values({ ownerId: human!.id, kind: "user", displayName: "Synthetic Human" }).returning();
  await db.insert(serverAdmission).values({ userId: human!.id, admitted: true });
  const spaces = await db.insert(namespaces).values([
    { scope: "room", label: "Source" }, { scope: "room", label: "Delivery" },
  ]).returning();
  const createdRooms = await db.insert(rooms).values(spaces.map(space => ({
    ownerId: human!.id, namespaceId: space.id, type: "shared", label: space.label, graphThreadId: randomUUID(),
  }))).returning();
  const source = createdRooms[0]!, delivery = createdRooms[1]!;
  await db.insert(roomMembers).values({ roomId: source.id, actorId: actor!.id });
  const base = { ownerId: human!.id, requestorId: human!.id, agentId: agent!.id, prompt: "Synthetic work" };
  const [root] = await db.insert(tasks).values({ ...base, callingRoomId: source.id, targetRoomId: delivery.id }).returning();
  const [child] = await db.insert(tasks).values({ ...base, parentTaskId: root!.id, callingRoomId: delivery.id }).returning();
  const check = (taskId = child!.id) => isInvocationAccessAllowed({ humanUserId: human!.id, taskId, roomId: delivery.id });
  return { db, human: human!, actor: actor!, source, delivery, root: root!, child: child!, check,
    removeSource: () => db.delete(roomMembers).where(and(eq(roomMembers.roomId, source.id), eq(roomMembers.actorId, actor!.id))),
    async cleanup() {
      await db.delete(users).where(eq(users.id, human!.id));
      await db.delete(agents).where(eq(agents.id, agent!.id));
      for (const space of spaces) await db.delete(namespaces).where(eq(namespaces.id, space.id));
    },
  };
}

test("descendants retain source authority while an Agent-only delivery Room remains valid", async () => {
  const f = await fixture();
  try {
    expect(await f.check()).toBe(true);
    await f.removeSource();
    expect(await f.check()).toBe(false);
    expect(await f.check(f.root.id)).toBe(false);
    await f.db.insert(roomMembers).values({ roomId: f.source.id, actorId: f.actor.id });
    expect(await f.check()).toBe(true);
  } finally { await f.cleanup(); }
});

test("cyclic or missing Task ancestry fails closed without an arbitrary traversal ceiling", async () => {
  const f = await fixture();
  try {
    expect(await f.check(randomUUID())).toBe(false);
    await f.db.update(tasks).set({ parentTaskId: f.child.id }).where(eq(tasks.id, f.root.id));
    expect(await f.check()).toBe(false);
  } finally { await f.cleanup(); }
});

test("a Task cannot substitute another Human's source authority", async () => {
  const f = await fixture();
  const [other] = await f.db.insert(users).values({ name: "Unrelated fixture", externalId: randomUUID() }).returning();
  try {
    await f.db.update(tasks).set({ requestorId: other!.id }).where(eq(tasks.id, f.root.id));
    expect(await f.check()).toBe(false);
  } finally { await f.cleanup(); await f.db.delete(users).where(eq(users.id, other!.id)); }
});

test("orphan Tasks have no invented Room membership requirement but still obey Server admission", async () => {
  const f = await fixture();
  try {
    await f.db.update(tasks).set({ callingRoomId: null }).where(eq(tasks.id, f.root.id));
    await f.removeSource();
    expect(await f.check()).toBe(true);
    await f.db.update(serverAdmission).set({ admitted: false }).where(eq(serverAdmission.userId, f.human.id));
    expect(await f.check()).toBe(false);
  } finally { await f.cleanup(); }
});

test("opaque Room origins compose with Task ancestry and independent account disable", async () => {
  const f = await fixture();
  try {
    const input = { humanUserId: f.human.id, originRoomId: f.source.id, originTaskId: f.child.id };
    expect(await isInvocationAccessAllowed(input)).toBe(true);
    await f.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.human.id));
    expect(await isInvocationAccessAllowed(input)).toBe(false);
    await f.db.update(users).set({ disabledAt: null }).where(eq(users.id, f.human.id));
    await f.removeSource();
    expect(await isInvocationAccessAllowed(input)).toBe(false);
  } finally { await f.cleanup(); }
});
