import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createPostgresJsBridgeConnection,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  inspectNamespaceProductAuthoritySnapshot,
  PostgresNamespaceProductAuthority,
  type NamespaceProductAuthoritySnapshot,
} from "../../src/server/delivery/postgres-namespace-product-authority.ts";

bootstrapTestDbInstance();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for this integration test`);
  }
  return value;
}

function assertSameClone(adminConnection: string, productConnection: string): void {
  const adminUrl = new URL(adminConnection);
  const productUrl = new URL(productConnection);
  if (
    adminUrl.hostname !== productUrl.hostname
    || adminUrl.port !== productUrl.port
    || adminUrl.pathname !== productUrl.pathname
    || productUrl.username !== "nautilo"
  ) {
    throw new Error("Integration database URLs do not identify one product clone");
  }
}

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const productUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
assertSameClone(adminUrl, productUrl);

const adminClient = postgres(adminUrl, { max: 1, prepare: false });
const productClient = postgres(productUrl, { max: 2, prepare: false });
const adminDatabase = drizzle(adminClient);
const authority = new PostgresNamespaceProductAuthority(
  createPostgresJsBridgeConnection(drizzle(productClient)),
);

afterAll(async () => Promise.all([adminClient.end(), productClient.end()]));

type RoomName =
  | "openSolo"
  | "openHumans"
  | "openAi"
  | "openSubthread"
  | "privateAgent"
  | "groupShared"
  | "privateTarget"
  | "publicSuperset"
  | "publicMissing"
  | "archivedPublic"
  | "visibilitySource";

type Fixture = Readonly<{
  userIds: readonly string[];
  humanIds: readonly string[];
  agentId: string;
  agentActorId: string;
  roomIds: Readonly<Record<RoomName, string>>;
  namespaceIds: Readonly<Record<Exclude<RoomName, "openSubthread">, string>>;
  sessionId: string;
}>;

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function roomRow(input: Readonly<{
  id: string;
  ownerId: string;
  namespaceId: string;
  humanActorIds: readonly string[];
  kind: "private" | "group" | "open";
  createdBy: string;
  label: string;
}>) {
  return {
    id: input.id,
    ownerId: input.ownerId,
    type: input.kind === "private" ? "private" : "shared",
    label: input.label,
    graphThreadId: `m314-product-authority:${input.id}`,
    namespaceId: input.namespaceId,
    namespaceAccessRevision: 7,
    humanActorIds: sorted(input.humanActorIds),
    kind: input.kind,
    createdBy: input.createdBy,
  } as const;
}

async function createFixture(): Promise<Fixture> {
  const userIds = Array.from({ length: 4 }, () => randomUUID());
  const humanIds = Array.from({ length: 4 }, () => randomUUID());
  const agentId = randomUUID();
  const agentActorId = randomUUID();
  const roomIds = {
    openSolo: randomUUID(),
    openHumans: randomUUID(),
    openAi: randomUUID(),
    openSubthread: randomUUID(),
    privateAgent: randomUUID(),
    groupShared: randomUUID(),
    privateTarget: randomUUID(),
    publicSuperset: randomUUID(),
    publicMissing: randomUUID(),
    archivedPublic: randomUUID(),
    visibilitySource: randomUUID(),
  } satisfies Record<RoomName, string>;
  const namespaceIds = {
    openSolo: randomUUID(),
    openHumans: randomUUID(),
    openAi: randomUUID(),
    privateAgent: randomUUID(),
    groupShared: randomUUID(),
    privateTarget: randomUUID(),
    publicSuperset: randomUUID(),
    publicMissing: randomUUID(),
    archivedPublic: randomUUID(),
    visibilitySource: randomUUID(),
  } satisfies Record<Exclude<RoomName, "openSubthread">, string>;
  const sessionId = randomUUID();
  const [subjectHumanId, peerHumanId, extraHumanId] = humanIds;
  const [subjectUserId] = userIds;
  if (
    subjectHumanId === undefined
    || peerHumanId === undefined
    || extraHumanId === undefined
    || subjectUserId === undefined
  ) throw new Error("Missing M314 fixture identity");

  await adminDatabase.transaction(async (database) => {
    await database.insert(users).values(userIds.map((id, index) => ({
      id,
      name: `M314 product authority Human ${index}`,
    })));
    await database.insert(agents).values({
      id: agentId,
      handle: `m314-product-authority-${agentId}`,
    });
    await database.insert(actors).values([
      ...humanIds.map((id, index) => ({
        id,
        ownerId: userIds[index]!,
        displayName: `M314 product authority Human ${index}`,
        trustState: "verified",
        kind: "user",
      })),
      {
        id: agentActorId,
        ownerId: subjectUserId,
        displayName: "M314 product authority Agent",
        trustState: "verified",
        kind: "agent",
        agentId,
      },
    ]);
    await database.insert(namespaces).values(
      Object.entries(namespaceIds).map(([name, id]) => ({
        id,
        scope: "room",
        label: `M314 ${name}`,
      })),
    );
    await database.insert(rooms).values([
      roomRow({ id: roomIds.openSolo, ownerId: subjectUserId,
        namespaceId: namespaceIds.openSolo, humanActorIds: [subjectHumanId],
        kind: "open", createdBy: subjectHumanId, label: "M314 open 1H0A" }),
      roomRow({ id: roomIds.openHumans, ownerId: subjectUserId,
        namespaceId: namespaceIds.openHumans,
        humanActorIds: [subjectHumanId, peerHumanId], kind: "open",
        createdBy: subjectHumanId, label: "M314 open XH0A" }),
      roomRow({ id: roomIds.openAi, ownerId: subjectUserId,
        namespaceId: namespaceIds.openAi,
        humanActorIds: [subjectHumanId, peerHumanId], kind: "open",
        createdBy: subjectHumanId, label: "M314 open XHYA" }),
      roomRow({ id: roomIds.privateAgent, ownerId: subjectUserId,
        namespaceId: namespaceIds.privateAgent, humanActorIds: [subjectHumanId],
        kind: "private", createdBy: subjectHumanId,
        label: "M314 exact private 1H1A" }),
      roomRow({ id: roomIds.groupShared, ownerId: subjectUserId,
        namespaceId: namespaceIds.groupShared,
        humanActorIds: [subjectHumanId, peerHumanId], kind: "group",
        createdBy: subjectHumanId, label: "M314 M296 closed shared" }),
      roomRow({ id: roomIds.privateTarget, ownerId: subjectUserId,
        namespaceId: namespaceIds.privateTarget,
        humanActorIds: [subjectHumanId, peerHumanId], kind: "private",
        createdBy: subjectHumanId, label: "M314 private target" }),
      roomRow({ id: roomIds.publicSuperset, ownerId: subjectUserId,
        namespaceId: namespaceIds.publicSuperset,
        humanActorIds: [subjectHumanId, peerHumanId, extraHumanId], kind: "open",
        createdBy: subjectHumanId, label: "M314 public superset" }),
      roomRow({ id: roomIds.publicMissing, ownerId: subjectUserId,
        namespaceId: namespaceIds.publicMissing,
        humanActorIds: [subjectHumanId], kind: "open",
        createdBy: subjectHumanId, label: "M314 public missing Human" }),
      {
        ...roomRow({ id: roomIds.archivedPublic, ownerId: subjectUserId,
          namespaceId: namespaceIds.archivedPublic,
          humanActorIds: [subjectHumanId, peerHumanId], kind: "open",
          createdBy: subjectHumanId, label: "M314 archived public" }),
        archivedAt: new Date(),
      },
      roomRow({ id: roomIds.visibilitySource, ownerId: subjectUserId,
        namespaceId: namespaceIds.visibilitySource,
        humanActorIds: [subjectHumanId, peerHumanId], kind: "group",
        createdBy: subjectHumanId, label: "M314 visibility source" }),
    ]);

    const humanMemberships: Array<{
      roomId: string;
      actorId: string;
      roomRole: string;
    }> = [];
    const addHumans = (roomId: string, actorIds: readonly string[]) => {
      actorIds.forEach((actorId, index) => humanMemberships.push({
        roomId,
        actorId,
        roomRole: index === 0 ? "admin" : "member",
      }));
    };
    addHumans(roomIds.openSolo, [subjectHumanId]);
    addHumans(roomIds.openHumans, [subjectHumanId, peerHumanId]);
    addHumans(roomIds.openAi, [subjectHumanId, peerHumanId]);
    addHumans(roomIds.privateAgent, [subjectHumanId]);
    addHumans(roomIds.groupShared, [subjectHumanId, peerHumanId]);
    addHumans(roomIds.privateTarget, [subjectHumanId, peerHumanId]);
    addHumans(roomIds.publicSuperset,
      [subjectHumanId, peerHumanId, extraHumanId]);
    addHumans(roomIds.publicMissing, [subjectHumanId]);
    addHumans(roomIds.archivedPublic, [subjectHumanId, peerHumanId]);
    addHumans(roomIds.visibilitySource, [subjectHumanId, peerHumanId]);
    await database.insert(roomMembers).values([
      ...humanMemberships,
      ...[
        roomIds.openAi,
        roomIds.privateAgent,
        roomIds.groupShared,
        roomIds.visibilitySource,
      ].map((roomId) => ({
        roomId,
        actorId: agentActorId,
        roomRole: "member",
        agentResponseMode: "active" as const,
      })),
    ]);

    await database.insert(sessions).values({
      id: sessionId,
      threadId: `m314-product-authority:${sessionId}`,
      ownerId: subjectUserId,
      roomId: roomIds.openAi,
      channel: "integration",
    });
    const [root] = await database.insert(sessionMessages).values({
      sessionId,
      role: "user",
      content: "M314 public Subthread anchor",
      humanTurnId: `turn-${randomUUID()}`,
    }).returning({ id: sessionMessages.id });
    if (root === undefined) throw new Error("Missing M314 Subthread anchor");
    await database.insert(rooms).values({
      id: roomIds.openSubthread,
      ownerId: subjectUserId,
      type: "shared",
      label: "M314 public Subthread",
      graphThreadId: `m314-product-authority:${roomIds.openSubthread}`,
      namespaceId: namespaceIds.openAi,
      namespaceAccessRevision: 7,
      humanActorIds: sorted([subjectHumanId, peerHumanId]),
      kind: "subthread",
      parentRoomId: roomIds.openAi,
      threadRootMessageId: root.id,
      createdBy: subjectHumanId,
    });
    await database.insert(roomMembers).values([
      { roomId: roomIds.openSubthread, actorId: subjectHumanId,
        roomRole: "admin" },
      { roomId: roomIds.openSubthread, actorId: peerHumanId,
        roomRole: "member" },
      { roomId: roomIds.openSubthread, actorId: agentActorId,
        roomRole: "member", agentResponseMode: "active" },
    ]);
    await database.update(rooms).set({ namespaceAccessRevision: 7 }).where(
      inArray(rooms.id, Object.values(roomIds)),
    );
  });

  return Object.freeze({
    userIds: Object.freeze(userIds),
    humanIds: Object.freeze(humanIds),
    agentId,
    agentActorId,
    roomIds: Object.freeze(roomIds),
    namespaceIds: Object.freeze(namespaceIds),
    sessionId,
  });
}

async function destroyFixture(fixture: Fixture): Promise<void> {
  await adminDatabase.transaction(async (database) => {
    await database.delete(rooms).where(eq(rooms.id, fixture.roomIds.openSubthread));
    await database.delete(sessionMessages)
      .where(eq(sessionMessages.sessionId, fixture.sessionId));
    await database.delete(sessions).where(eq(sessions.id, fixture.sessionId));
    await database.delete(rooms).where(inArray(
      rooms.id,
      Object.values(fixture.roomIds).filter((id) =>
        id !== fixture.roomIds.openSubthread
      ),
    ));
    await database.delete(namespaces).where(inArray(
      namespaces.id,
      Object.values(fixture.namespaceIds),
    ));
    await database.delete(actors).where(inArray(
      actors.id,
      [...fixture.humanIds, fixture.agentActorId],
    ));
    await database.delete(agents).where(eq(agents.id, fixture.agentId));
    await database.delete(users).where(inArray(users.id, [...fixture.userIds]));
  });
}

function inspect(handle: NamespaceProductAuthoritySnapshot) {
  const snapshot = inspectNamespaceProductAuthoritySnapshot(handle);
  const result = Object.freeze({
    roomId: snapshot.roomId,
    namespaceId: snapshot.namespaceId,
    accessRevision: snapshot.accessRevision,
    participantHumanIds: Object.freeze(snapshot.participantHumanIds.map(String)),
  });
  snapshot.audienceFingerprint.fill(0);
  return result;
}

function own(fixture: Fixture) {
  return {
    subjectUserId: fixture.userIds[0]!,
    subjectHumanId: fixture.humanIds[0]!,
  };
}

async function readSingle(
  fixture: Fixture,
  sourceRoomId: string,
  namespaceId: string,
) {
  return authority.withCurrentReadableNamespace({
    ...own(fixture),
    sourceRoomId,
    namespaceId,
    keyClass: "ai",
    use: async (handle) => inspect(handle),
  });
}

async function readSet(
  fixture: Fixture,
  sourceRoomId: string,
  namespaceIds: readonly string[],
) {
  return authority.withCurrentReadableNamespaceSet({
    ...own(fixture),
    sourceRoomId,
    namespaceIds: sorted(namespaceIds),
    use: async (entries) => entries.map((entry) => inspect(entry.authority)),
  });
}

describe("M314 public Room product authority", () => {
  test("qualifies open 1H0A, XH0A, and XHYA live and repair authority", async () => {
    const fixture = await createFixture();
    try {
      const subjectHumanId = fixture.humanIds[0]!;
      const peerHumanId = fixture.humanIds[1]!;
      for (const roomName of ["openSolo", "openHumans"] as const) {
        const expectedHumans = roomName === "openSolo"
          ? [subjectHumanId]
          : sorted([subjectHumanId, peerHumanId]);
        expect(await authority.withCurrentHumanOnlyRoom({
          ...own(fixture),
          roomId: fixture.roomIds[roomName],
          namespaceId: fixture.namespaceIds[roomName],
          use: async (handle) => inspect(handle).participantHumanIds,
        })).toEqual(expectedHumans);
        expect(await authority.withCurrentMessageRepairRoom({
          ...own(fixture),
          roomId: fixture.roomIds[roomName],
          namespaceId: fixture.namespaceIds[roomName],
          use: async (handle, keyClass) => ({
            keyClass,
            humans: inspect(handle).participantHumanIds,
          }),
        })).toEqual({ keyClass: "human", humans: expectedHumans });
      }

      expect(await authority.withCurrentHumanAiReadableRoom({
        ...own(fixture),
        roomId: fixture.roomIds.openAi,
        namespaceId: fixture.namespaceIds.openAi,
        use: async (handle) => inspect(handle).participantHumanIds,
      })).toEqual(sorted([subjectHumanId, peerHumanId]));
      expect(await authority.withCurrentMessageRepairRoom({
        ...own(fixture),
        roomId: fixture.roomIds.openAi,
        namespaceId: fixture.namespaceIds.openAi,
        use: async (handle, keyClass) => ({
          keyClass,
          roomId: inspect(handle).roomId,
        }),
      })).toEqual({ keyClass: "ai", roomId: fixture.roomIds.openAi });
    } finally {
      await destroyFixture(fixture);
    }
  });

  test("inherits public parent authority for detached Subthread history", async () => {
    const fixture = await createFixture();
    try {
      expect(await authority.withDetachedCurrentMessageHistoryRead({
        ...own(fixture),
        roomId: fixture.roomIds.openSubthread,
        namespaceId: fixture.namespaceIds.openAi,
        use: async (handle) => inspect(handle),
      })).toMatchObject({
        roomId: fixture.roomIds.openAi,
        namespaceId: fixture.namespaceIds.openAi,
        accessRevision: 7,
      });
      expect(await authority.withDetachedCurrentHumanAiReadableRoomRead({
        ...own(fixture),
        roomId: fixture.roomIds.openSubthread,
        namespaceId: fixture.namespaceIds.openAi,
        use: async (handle) => inspect(handle).roomId,
      })).toBe(fixture.roomIds.openAi);
    } finally {
      await destroyFixture(fixture);
    }
  });

  test("enforces M227 for single and batch reads in every public direction", async () => {
    const fixture = await createFixture();
    try {
      const { roomIds, namespaceIds } = fixture;
      for (const read of [readSingle, async (
        value: Fixture,
        sourceRoomId: string,
        namespaceId: string,
      ) => readSet(value, sourceRoomId, [namespaceId])] as const) {
        expect(await read(fixture, roomIds.openAi, namespaceIds.privateTarget))
          .toBeNull();
        expect(await read(fixture, roomIds.privateAgent, namespaceIds.publicSuperset))
          .not.toBeNull();
        expect(await read(fixture, roomIds.openAi, namespaceIds.publicSuperset))
          .not.toBeNull();
        expect(await read(fixture, roomIds.openAi, namespaceIds.publicMissing))
          .toBeNull();
        expect(await read(fixture, roomIds.openAi, namespaceIds.archivedPublic))
          .toBeNull();
      }

      const nonmember = {
        subjectUserId: fixture.userIds[3]!,
        subjectHumanId: fixture.humanIds[3]!,
      };
      expect(await authority.withCurrentReadableNamespace({
        ...nonmember,
        sourceRoomId: roomIds.openAi,
        namespaceId: namespaceIds.openAi,
        keyClass: "ai",
        use: async () => "forbidden",
      })).toBeNull();
      expect(await authority.withCurrentReadableNamespaceSet({
        ...nonmember,
        sourceRoomId: roomIds.openAi,
        namespaceIds: [namespaceIds.openAi],
        use: async () => "forbidden",
      })).toBeNull();
      expect(await authority.withCurrentHumanAiReadableRoom({
        ...nonmember,
        roomId: roomIds.openAi,
        namespaceId: namespaceIds.openAi,
        use: async () => "forbidden",
      })).toBeNull();
      expect(await authority.withCurrentMessageRepairRoom({
        ...own(fixture),
        roomId: roomIds.archivedPublic,
        namespaceId: namespaceIds.archivedPublic,
        use: async () => "forbidden",
      })).toBeNull();

      await adminDatabase.update(rooms).set({ archivedAt: new Date() })
        .where(eq(rooms.id, roomIds.openAi));
      expect(await readSingle(fixture, roomIds.openAi, namespaceIds.openAi))
        .toBeNull();
      expect(await readSet(fixture, roomIds.openAi, [namespaceIds.openAi]))
        .toBeNull();
      expect(await authority.withCurrentMessageRepairRoom({
        ...own(fixture),
        roomId: roomIds.openAi,
        namespaceId: namespaceIds.openAi,
        use: async () => "forbidden",
      })).toBeNull();
    } finally {
      await destroyFixture(fixture);
    }
  });

  test("visibility changes readable policy without changing Namespace authority facts", async () => {
    const fixture = await createFixture();
    try {
      const { roomIds, namespaceIds } = fixture;
      const [before] = await adminDatabase.select({
        namespaceId: rooms.namespaceId,
        accessRevision: rooms.namespaceAccessRevision,
        humanActorIds: rooms.humanActorIds,
        kind: rooms.kind,
      }).from(rooms).where(eq(rooms.id, roomIds.visibilitySource));
      if (before === undefined) throw new Error("Missing visibility source Room");
      expect(before?.kind).toBe("group");
      expect(await readSet(fixture, roomIds.visibilitySource, [
        namespaceIds.privateTarget,
        namespaceIds.publicSuperset,
      ])).not.toBeNull();

      await adminDatabase.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, roomIds.visibilitySource));
      const [after] = await adminDatabase.select({
        namespaceId: rooms.namespaceId,
        accessRevision: rooms.namespaceAccessRevision,
        humanActorIds: rooms.humanActorIds,
        kind: rooms.kind,
      }).from(rooms).where(eq(rooms.id, roomIds.visibilitySource));
      expect(after).toEqual({ ...before, kind: "open" });
      expect(await readSet(fixture, roomIds.visibilitySource, [
        namespaceIds.privateTarget,
        namespaceIds.publicSuperset,
      ])).toBeNull();
      expect(await readSingle(
        fixture,
        roomIds.visibilitySource,
        namespaceIds.privateTarget,
      )).toBeNull();
      expect(await readSet(
        fixture,
        roomIds.visibilitySource,
        [namespaceIds.publicSuperset],
      )).not.toBeNull();
    } finally {
      await destroyFixture(fixture);
    }
  });

  test("preserves exact-private 1H1A and M296 closed shared compatibility", async () => {
    const fixture = await createFixture();
    try {
      expect(await authority.withCurrentPrivateRoom({
        ...own(fixture),
        roomId: fixture.roomIds.privateAgent,
        namespaceId: fixture.namespaceIds.privateAgent,
        use: async (handle) => inspect(handle).roomId,
      })).toBe(fixture.roomIds.privateAgent);
      expect(await authority.withCurrentSharedAgentRoom({
        ...own(fixture),
        roomId: fixture.roomIds.privateAgent,
        namespaceId: fixture.namespaceIds.privateAgent,
        recipientAgentId: fixture.agentId,
        use: async () => "forbidden",
      })).toBeNull();
      await adminDatabase.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, fixture.roomIds.privateAgent));
      expect(await authority.withCurrentPrivateRoom({
        ...own(fixture),
        roomId: fixture.roomIds.privateAgent,
        namespaceId: fixture.namespaceIds.privateAgent,
        use: async () => "forbidden",
      })).toBeNull();
      expect(await authority.withCurrentHumanAiReadableRoom({
        ...own(fixture),
        roomId: fixture.roomIds.privateAgent,
        namespaceId: fixture.namespaceIds.privateAgent,
        use: async () => "topology-neutral",
      })).toBe("topology-neutral");

      expect(await authority.withCurrentSharedAgentRoom({
        ...own(fixture),
        roomId: fixture.roomIds.groupShared,
        namespaceId: fixture.namespaceIds.groupShared,
        recipientAgentId: fixture.agentId,
        use: async (handle) => inspect(handle).participantHumanIds.length,
      })).toBe(2);
      await adminDatabase.update(rooms).set({ kind: "private" })
        .where(eq(rooms.id, fixture.roomIds.groupShared));
      expect(await authority.withCurrentSharedAgentRoom({
        ...own(fixture),
        roomId: fixture.roomIds.groupShared,
        namespaceId: fixture.namespaceIds.groupShared,
        recipientAgentId: fixture.agentId,
        use: async (handle) => inspect(handle).participantHumanIds.length,
      })).toBe(2);
      await adminDatabase.update(rooms).set({ kind: "open" })
        .where(eq(rooms.id, fixture.roomIds.groupShared));
      expect(await authority.withCurrentSharedAgentRoom({
        ...own(fixture),
        roomId: fixture.roomIds.groupShared,
        namespaceId: fixture.namespaceIds.groupShared,
        recipientAgentId: fixture.agentId,
        use: async () => "forbidden",
      })).toBeNull();
    } finally {
      await destroyFixture(fixture);
    }
  });

  test("accepts an open Human-only Room with 4,097 real Human rows", async () => {
    const userIds = Array.from({ length: 4_097 }, () => randomUUID());
    const humanIds = sorted(Array.from({ length: 4_097 }, () => randomUUID()));
    const roomId = randomUUID();
    const namespaceId = randomUUID();
    const chunkSize = 500;
    try {
      await adminDatabase.transaction(async (database) => {
        for (let offset = 0; offset < userIds.length; offset += chunkSize) {
          await database.insert(users).values(userIds.slice(offset, offset + chunkSize)
            .map((id, index) => ({
              id,
              name: `M314 capacity Human ${offset + index}`,
            })));
          await database.insert(actors).values(
            humanIds.slice(offset, offset + chunkSize).map((id, index) => ({
              id,
              ownerId: userIds[offset + index]!,
              displayName: `M314 capacity Human ${offset + index}`,
              trustState: "verified",
              kind: "user",
            })),
          );
        }
        await database.insert(namespaces).values({
          id: namespaceId,
          scope: "room",
          label: "M314 capacity Namespace",
        });
        await database.insert(rooms).values(roomRow({
          id: roomId,
          ownerId: userIds[0]!,
          namespaceId,
          humanActorIds: humanIds,
          kind: "open",
          createdBy: humanIds[0]!,
          label: "M314 capacity open Room",
        }));
        for (let offset = 0; offset < humanIds.length; offset += chunkSize) {
          await database.insert(roomMembers).values(
            humanIds.slice(offset, offset + chunkSize).map((actorId, index) => ({
              roomId,
              actorId,
              roomRole: offset + index === 0 ? "admin" : "member",
            })),
          );
        }
      });

      expect(await authority.withCurrentHumanOnlyRoom({
        subjectUserId: userIds[0]!,
        subjectHumanId: humanIds[0]!,
        roomId,
        namespaceId,
        use: async (handle) => inspect(handle).participantHumanIds.length,
      })).toBe(4_097);
    } finally {
      await adminDatabase.delete(rooms).where(eq(rooms.id, roomId));
      await adminDatabase.delete(namespaces).where(eq(namespaces.id, namespaceId));
      for (let offset = 0; offset < userIds.length; offset += chunkSize) {
        await adminDatabase.delete(users).where(inArray(
          users.id,
          userIds.slice(offset, offset + chunkSize),
        ));
      }
    }
  });
});
