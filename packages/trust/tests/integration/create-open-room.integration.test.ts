/**
 * M124 — `createOpenRoom` mints a discoverable public room (trust + DB).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  eq,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createOpenRoom } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let userId: string;
let actorId: string;
let peerUserId: string;
let peerActorId: string;
let agentId: string;
let agentActorId: string;
const createdRoomIds = new Set<string>();
const createdNamespaceIds = new Set<string>();

async function trackCreatedRoom(id: string): Promise<void> {
  createdRoomIds.add(id);
  const [room] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, id))
    .limit(1);
  if (room) createdNamespaceIds.add(room.namespaceId);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [user] = await db
    .insert(users)
    .values({
      name: "m124-create-open",
      email: `m124co-${ts}@test.local`,
      handle: `m124co${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user");
  userId = user.id;

  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "Creator",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor");
  actorId = actor.id;

  const [peerUser] = await db
    .insert(users)
    .values({
      name: "m124-create-open-peer",
      email: `m124co-peer-${ts}@test.local`,
      handle: `m124copeer${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!peerUser) throw new Error("peer user");
  peerUserId = peerUser.id;
  const [peerActor] = await db
    .insert(actors)
    .values({
      ownerId: peerUserId,
      displayName: "Peer",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!peerActor) throw new Error("peer actor");
  peerActorId = peerActor.id;

  const [agent] = await db
    .insert(agents)
    .values({ handle: `m124co-agent-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent");
  agentId = agent.id;
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "Selected agent",
      trustState: "verified",
      kind: "agent",
      agentId,
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("agent actor");
  agentActorId = agentActor.id;
});

afterAll(async () => {
  if (!db) return;
  try {
    for (const id of createdRoomIds) {
      await db.delete(roomMembers).where(eq(roomMembers.roomId, id));
      await db.delete(rooms).where(eq(rooms.id, id));
    }
    for (const id of createdNamespaceIds) {
      await db.delete(namespaces).where(eq(namespaces.id, id));
    }
    if (agentActorId) {
      await db.delete(actors).where(eq(actors.id, agentActorId));
    }
    if (agentId) {
      await db.delete(agents).where(eq(agents.id, agentId));
    }
    if (peerActorId) {
      await db.delete(actors).where(eq(actors.id, peerActorId));
    }
    if (peerUserId) {
      await db.delete(users).where(eq(users.id, peerUserId));
    }
    if (actorId) {
      await db.delete(actors).where(eq(actors.id, actorId));
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId));
    }
  } finally {
    await db.end();
  }
});

describe("createOpenRoom (M124)", () => {
  test("mints an open shared room with the creator as sole admin member", async () => {
    const detail = await createOpenRoom({
      creatorUserId: userId,
      creatorActorId: actorId,
      label: "#general",
    });
    await trackCreatedRoom(detail.id);

    expect(detail.kind).toBe("open");
    expect(detail.type).toBe("shared");
    expect(detail.graphThreadId).toBe(`room:${detail.id}`);
    expect(detail.members.length).toBe(1);
    expect(detail.members[0]?.actorId).toBe(actorId);
    expect(detail.members[0]?.roomRole).toBe("admin");
    expect(detail.members[0]?.kind).toBe("user");
    expect(detail.members.every((m) => m.kind !== "agent")).toBe(true);

    const [row] = await db
      .select({
        kind: rooms.kind,
        humanActorIds: rooms.humanActorIds,
        namespaceId: rooms.namespaceId,
      })
      .from(rooms)
      .where(eq(rooms.id, detail.id))
      .limit(1);
    if (!row) throw new Error("room row");

    expect(row.kind).toBe("open");
    expect(row.humanActorIds).toContain(actorId);
    expect(row.namespaceId).not.toBeNull();
  });

  test("persists an exact supplied human + agent roster atomically", async () => {
    const detail = await createOpenRoom({
      creatorUserId: userId,
      creatorActorId: actorId,
      label: "#selected-roster",
      members: [
        { kind: "user", id: userId },
        { kind: "user", id: peerUserId },
        { kind: "agent", id: agentId },
      ],
    });
    // Register both Room and Namespace before asserting its roster. If a
    // roster assertion fails, afterAll can still clean up the DB fixture.
    await trackCreatedRoom(detail.id);
    expect(detail.kind).toBe("open");
    expect(detail.members).toHaveLength(3);
    expect(
      detail.members.some(
        (member) =>
          member.actorId === actorId && member.kind === "user" && member.roomRole === "admin",
      ),
    ).toBe(true);
    expect(
      detail.members.some(
        (member) =>
          member.actorId === peerActorId &&
          member.kind === "user" &&
          member.roomRole === "member",
      ),
    ).toBe(true);
    expect(
      detail.members.some(
        (member) =>
          member.actorId === agentActorId &&
          member.kind === "agent" &&
          member.roomRole === "member",
      ),
    ).toBe(true);

    const [row] = await db
      .select({ humanActorIds: rooms.humanActorIds, namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, detail.id))
      .limit(1);
    if (!row) throw new Error("exact roster room row");
    expect(row.humanActorIds).toEqual([actorId, peerActorId].sort());

    const members = await db
      .select({ actorId: roomMembers.actorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, detail.id));
    expect(members.map((member) => member.actorId).sort()).toEqual(
      [actorId, peerActorId, agentActorId].sort(),
    );
  });

  test("invalid, duplicate, or creator-less explicit rosters mint no partial room", async () => {
    const invalidLabel = `#invalid-roster-${Date.now().toString(36)}`;
    const duplicateLabel = `#duplicate-roster-${Date.now().toString(36)}`;
    const creatorlessLabel = `#creatorless-roster-${Date.now().toString(36)}`;
    const expectRejection = async (promise: Promise<unknown>, message: string): Promise<void> => {
      let rejection: unknown;
      try {
        await promise;
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      if (rejection instanceof Error) {
        expect(rejection.message).toContain(message);
      }
    };
    await expectRejection(
      createOpenRoom({
        creatorUserId: userId,
        creatorActorId: actorId,
        label: invalidLabel,
        members: [
          { kind: "user", id: userId },
          { kind: "user", id: randomUUID() },
        ],
      }),
      "no user actor",
    );
    await expectRejection(
      createOpenRoom({
        creatorUserId: userId,
        creatorActorId: actorId,
        label: duplicateLabel,
        members: [
          { kind: "user", id: userId },
          { kind: "user", id: userId },
        ],
      }),
      "duplicate members",
    );
    await expectRejection(
      createOpenRoom({
        creatorUserId: userId,
        creatorActorId: actorId,
        label: creatorlessLabel,
        members: [{ kind: "user", id: peerUserId }],
      }),
      "creatorActorId must appear exactly once",
    );
    const created = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.label, invalidLabel));
    expect(created).toEqual([]);
    const duplicateCreated = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.label, duplicateLabel));
    expect(duplicateCreated).toEqual([]);
    const creatorlessCreated = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.label, creatorlessLabel));
    expect(creatorlessCreated).toEqual([]);
  });
});
