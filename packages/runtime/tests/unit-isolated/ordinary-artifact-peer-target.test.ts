import { beforeEach, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DirectDatabase, Task } from "@nautilo/db";

const trust = await import("@nautilo/trust");
const database = await import("@nautilo/db");
const peerActor = "10000000-0000-4000-8000-000000000001";
const peerUser = "10000000-0000-4000-8000-000000000002";
const lookup = mock(async () => ({ id: peerUser }));
const create = mock(async () => { throw new Error("No new Room expected"); });
const update = mock(async () => undefined);
mock.module("@nautilo/trust", () => ({ ...trust, findLocalUserByHandle: lookup, createRoomFromMembers: create }));
mock.module("@nautilo/db", () => ({ ...database, updateTask: update }));
const { resolveTargetRoom } = await import("../../src/tasks/resolve-target-room");
function task(overrides: Partial<Task> = {}): Task {
  return { id: "task", ownerId: "owner", requestorId: "owner", agentId: "agent", preset: "ask_peer",
    targetChat: "last_dm", targetChatHandle: "@mutable", targetRoomId: null,
    targetUserIds: ["owner", peerUser], metadata: { ordinaryArtifactPeer: true, expectedArtifactPeerActorId: peerActor },
    ...overrides } as Task;
}
function dbWith(rows: unknown[][]) {
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const dialect = new PgDialect();
  const select = mock(() => {
    const query = { from() { return query; }, where(where: SQL) {
      predicates.push(dialect.sqlToQuery(where)); return query;
    }, orderBy() { return query; }, limit() { return Promise.resolve(rows.shift() ?? []); }, getSQL() { return database.sql`SELECT room_id FROM room_members`; } };
    return query;
  });
  return { db: { select } as unknown as DirectDatabase, select, predicates };
}
beforeEach(() => { lookup.mockClear(); create.mockClear(); update.mockClear(); });

test("ordinary marker without pin rejects before handle lookup, Room reuse or writes", async () => {
  const f = dbWith([]);
  for (const metadata of [{ ordinaryArtifactPeer: true }, { expectedArtifactPeerActorId: peerActor },
    { ordinaryArtifactPeer: true, expectedArtifactPeerActorId: "invalid" }]) {
    const error = await resolveTargetRoom(task({ targetRoomId: "memoized", metadata }), f).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
  }
  expect(lookup).not.toHaveBeenCalled(); expect(f.select).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

test("reassigned handle cannot contact a different Human or create/update a DM", async () => {
  const f = dbWith([[]]); // No Actor with BOTH the pinned id and today's handle owner.
  const error = await resolveTargetRoom(task(), f).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(f.predicates[0]?.params).toContain(peerActor);
  expect(f.predicates[0]?.params).toContain(peerUser);
  expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});

test("memoized DM proves exact pinned Human and Agent membership without reinterpreting the handle", async () => {
  const f = dbWith([[{ ownerId: peerUser }], [{ id: peerActor }], [{ id: "agent-actor" }], [{ id: "memoized" }]]);
  const result = await resolveTargetRoom(task({ targetRoomId: "memoized" }), f);
  expect(result.roomId).toBe("memoized");
  expect(lookup).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  const roomPredicate = f.predicates.at(-1)!;
  expect(roomPredicate.params).toContain("memoized");
  expect(roomPredicate.params).toContain(peerActor);
  expect(roomPredicate.sql).toContain("archived_at");
  expect(roomPredicate.sql).toContain("count(*)");
  expect(f.predicates.some((query) => query.params.includes(peerActor) && query.sql.includes("actor_id"))).toBe(true);
});

test("wrong/stale memoized DM fails instead of finding or creating another DM", async () => {
  const f = dbWith([[{ ownerId: peerUser }], [{ id: peerActor }], [{ id: "agent-actor" }], []]);
  const error = await resolveTargetRoom(task({ targetRoomId: "wrong-room" }), f).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(lookup).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});

test("legacy memoized DM stays DB-free; ordinary pin cannot redirect into another task target mode", async () => {
  const f = dbWith([]);
  expect((await resolveTargetRoom(task({ metadata: {}, targetRoomId: "legacy" }), f)).roomId).toBe("legacy");
  const error = await resolveTargetRoom(task({ targetChat: "orphan", targetRoomId: "other" }), f).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(f.select).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
});
