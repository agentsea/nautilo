import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  createDirectDb,
  eq,
  normalizedRoomLabelSql,
  roomMembers,
  rooms,
  setRuntimeStatementObserver,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { normalizeRoomName, resolveAuthorizedRoomName } from "../../src/room-name-resolver";
import { findAuthorizedRoomNameCandidates } from "../../src/queries";
import {
  Tracker,
  cleanupAll,
  mkActor,
  mkNamespace,
  mkRoom,
  mkUser,
  type Db,
} from "./helpers/unread-fixtures";

let db: Db;
const tracker = new Tracker();

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(2);
});

afterAll(async () => {
  try {
    await cleanupAll(db, tracker);
  } finally {
    await db.end();
  }
});

async function setLabel(roomId: string, label: string): Promise<void> {
  await db.update(rooms).set({ label }).where(eq(rooms.id, roomId));
}

describe("D476 Room-name resolver against the trust Room directory", () => {
  test("PostgreSQL normalization matches the JavaScript resolver contract", async () => {
    const values = [
      "  P\u{ff55}B—Room  ",
      "İstanbul",
      "i\u0307stanbul",
      "ΣΟΣ",
      "σος",
      "Straße",
      "C++ 😀 Lounge",
    ];
    for (const value of values) {
      const result = await db.execute(sql`
        SELECT ${normalizedRoomLabelSql(sql`${value}`)} AS normalized
      `);
      const [row] = result as unknown as Array<{ normalized: string }>;
      expect(row?.normalized).toBe(normalizeRoomName(value));
    }
  });

  test("migration supplies prefix and KNN trigram indexes for bounded lookup", async () => {
    const result = await db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_rooms_normalized_label_live', 'idx_rooms_normalized_label_trgm_live')
      ORDER BY indexname
    `);
    const definitions = new Map(
      (result as unknown as Array<{ indexname: string; indexdef: string }>).map((row) => [row.indexname, row.indexdef]),
    );
    const prefixDefinition = definitions.get("idx_rooms_normalized_label_live");
    const fuzzyDefinition = definitions.get("idx_rooms_normalized_label_trgm_live");
    expect(prefixDefinition).toBeDefined();
    expect(fuzzyDefinition).toBeDefined();
    if (!prefixDefinition || !fuzzyDefinition) {
      throw new Error("D476 Room-name indexes are not migrated in the integration database");
    }
    expect(prefixDefinition).toContain("text_pattern_ops");
    expect(prefixDefinition).toContain("id");
    expect(fuzzyDefinition).toContain("USING gist");
    expect(fuzzyDefinition).toContain("gist_trgm_ops");
  });

  test("resolves only a current member's live top-level Room and obtains its Namespace", async () => {
    const userId = await mkUser(db, tracker, `d476-resolver-${randomUUID().slice(0, 8)}`);
    const requesterActorId = await mkActor(db, tracker, userId, "D476 requester");
    const visibleNamespaceId = await mkNamespace(db, tracker);
    const visibleRoomId = await mkRoom(db, tracker, {
      ownerId: userId,
      namespaceId: visibleNamespaceId,
      humanActorIds: [requesterActorId],
      memberActorIds: [requesterActorId],
      kind: "open",
    });
    await setLabel(visibleRoomId, "pub-room");

    const hiddenNamespaceId = await mkNamespace(db, tracker);
    const hiddenRoomId = await mkRoom(db, tracker, {
      ownerId: userId,
      namespaceId: hiddenNamespaceId,
      humanActorIds: [],
      memberActorIds: [],
      kind: "private",
    });
    await setLabel(hiddenRoomId, "secret-room");

    const archivedNamespaceId = await mkNamespace(db, tracker);
    const archivedRoomId = await mkRoom(db, tracker, {
      ownerId: userId,
      namespaceId: archivedNamespaceId,
      humanActorIds: [requesterActorId],
      memberActorIds: [requesterActorId],
      kind: "private",
    });
    await setLabel(archivedRoomId, "archived-room");
    await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, archivedRoomId));

    const taskNamespaceId = await mkNamespace(db, tracker);
    const taskRoomId = await mkRoom(db, tracker, {
      ownerId: userId,
      namespaceId: taskNamespaceId,
      humanActorIds: [requesterActorId],
      memberActorIds: [requesterActorId],
      kind: "task",
    });
    await setLabel(taskRoomId, "task-room");

    const accessNamespaceId = await mkNamespace(db, tracker);
    const accessRoomId = await mkRoom(db, tracker, {
      ownerId: userId,
      namespaceId: accessNamespaceId,
      humanActorIds: [requesterActorId],
      memberActorIds: [requesterActorId],
      kind: "access",
    });
    await setLabel(accessRoomId, "access-room");

    const trustDirectoryDeps = {
      findAuthorizedRoomNameCandidates,
      userHasCapability: async () => true,
    };
    const common = { requesterUserId: userId, requesterActorId };

    let exactStatements = 0;
    const stopExactObservation = setRuntimeStatementObserver(() => {
      exactStatements += 1;
    });
    const resolved = await resolveAuthorizedRoomName(
      { ...common, targetRoomName: "PUB ROOM" },
      trustDirectoryDeps,
    ).finally(stopExactObservation);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error("expected the visible Room to resolve");
    expect(resolved.destination).toMatchObject({
      roomId: visibleRoomId,
      namespaceId: visibleNamespaceId,
      label: "pub-room",
      kind: "open",
      memberCount: 1,
    });
    expect(resolved.destination.audienceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(exactStatements).toBe(1);

    let shortMissStatements = 0;
    const stopShortObservation = setRuntimeStatementObserver(() => {
      shortMissStatements += 1;
    });
    const shortMiss = await findAuthorizedRoomNameCandidates({
      requesterUserId: userId,
      requesterActorId,
      normalizedTargetRoomName: "qz",
    }).finally(stopShortObservation);
    expect(shortMiss).toEqual([]);
    expect(shortMissStatements).toBe(2);
    for (const targetRoomName of ["secret room", "archived room", "task room", "access room"]) {
      expect(await resolveAuthorizedRoomName({ ...common, targetRoomName }, trustDirectoryDeps)).toEqual({
        status: "not_found",
      });
    }
  });

  test("changes the trusted audience fingerprint when a same-count member is replaced", async () => {
    const requesterUserId = await mkUser(db, tracker, `d476-audience-requester-${randomUUID().slice(0, 8)}`);
    const requesterActorId = await mkActor(db, tracker, requesterUserId, "D476 audience requester");
    const firstMemberUserId = await mkUser(db, tracker, `d476-audience-first-${randomUUID().slice(0, 8)}`);
    const firstMemberActorId = await mkActor(db, tracker, firstMemberUserId, "D476 audience first");
    const replacementUserId = await mkUser(db, tracker, `d476-audience-replacement-${randomUUID().slice(0, 8)}`);
    const replacementActorId = await mkActor(db, tracker, replacementUserId, "D476 audience replacement");
    const namespaceId = await mkNamespace(db, tracker);
    const roomId = await mkRoom(db, tracker, {
      ownerId: requesterUserId,
      namespaceId,
      humanActorIds: [requesterActorId, firstMemberActorId],
      memberActorIds: [requesterActorId, firstMemberActorId],
      kind: "open",
    });
    await setLabel(roomId, "audience-swap-room");

    const deps = {
      findAuthorizedRoomNameCandidates,
      userHasCapability: async () => true,
    };
    const input = {
      requesterUserId,
      requesterActorId,
      targetRoomName: "audience swap room",
    };
    const before = await resolveAuthorizedRoomName(input, deps);
    expect(before.status).toBe("resolved");
    if (before.status !== "resolved") throw new Error("expected initial audience Room to resolve");

    await db.delete(roomMembers).where(and(
      eq(roomMembers.roomId, roomId),
      eq(roomMembers.actorId, firstMemberActorId),
    ));
    await db.insert(roomMembers).values({ roomId, actorId: replacementActorId, roomRole: "member" });
    await db.update(rooms)
      .set({ humanActorIds: [requesterActorId, replacementActorId].sort() })
      .where(eq(rooms.id, roomId));

    const after = await resolveAuthorizedRoomName(input, deps);
    expect(after.status).toBe("resolved");
    if (after.status !== "resolved") throw new Error("expected replacement audience Room to resolve");
    expect(after.destination.memberCount).toBe(before.destination.memberCount);
    expect(after.destination.audienceFingerprint).not.toBe(before.destination.audienceFingerprint);
  });
});
