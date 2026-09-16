import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../src/config/database";
import { discoverRoomAuthorityInTx, lockDiscoveredRoomAuthorityInTx,
  RoomAuthorityChangedError, type RoomAuthoritySnapshot } from "../../src/queries/room-authority-locks";

const top = (id: string): RoomAuthoritySnapshot => ({ id, namespaceId: `ns:${id}`, kind: "group",
  parentRoomId: null, humanActorIds: ["a", "b"], namespaceAccessRevision: 2 });
const child: RoomAuthoritySnapshot = { ...top("a-child"), namespaceId: "ns:z-parent", kind: "subthread", parentRoomId: "z-parent" };

function fixture(responses: readonly RoomAuthoritySnapshot[][]) {
  const pending = [...responses];
  const queries: Array<{ sql: string; params: unknown[]; lock: string }> = [];
  const tx = { select: () => {
    let query: SQL, lock = "none";
    const chain = {
      from() { return chain; },
      where(value: SQL) { query = value; return chain; },
      for(value: string) { lock = value; return chain; },
      then(resolve: (rows: RoomAuthoritySnapshot[]) => unknown, reject: (error: unknown) => unknown) {
        const next = pending.shift();
        if (!next) return Promise.reject(new Error("unexpected query")).then(resolve, reject);
        queries.push({ ...new PgDialect().sqlToQuery(query), lock });
        return Promise.resolve(next).then(resolve, reject);
      },
    };
    return chain;
  } };
  return { tx: tx as unknown as Database, queries, assertConsumed: () => expect(pending).toHaveLength(0) };
}

describe("canonical multi-Room authority lock phase", () => {
  test("locks sorted top-level Rooms before sorted children regardless of input order", async () => {
    const parent = top("z-parent"), other = top("b-other");
    const f = fixture([[other], [parent], [child]]);
    const locked = await lockDiscoveredRoomAuthorityInTx(f.tx, [child, parent, other, parent], "share");
    expect(locked.map((room) => room.id)).toEqual(["b-other", "z-parent", "a-child"]);
    expect(f.queries.map((query) => query.params)).toEqual([["b-other"], ["z-parent"], ["a-child"]]);
    expect(f.queries.map((query) => query.lock)).toEqual(["share", "share", "share"]);
    f.assertConsumed();
  });

  test("Room deletion, topology change or membership revision drift fails the proof", async () => {
    const parent = top("parent");
    for (const rows of [[], [{ ...parent, namespaceAccessRevision: 3 }], [{ ...parent, namespaceId: "other-ns" }]]) {
      const f = fixture([rows]);
      const error = await lockDiscoveredRoomAuthorityInTx(f.tx, [parent], "update")
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(RoomAuthorityChangedError);
      expect(f.queries).toHaveLength(1);
    }
  });

  test("a child without its discovered owner fails before taking any lock", async () => {
    const f = fixture([]);
    const error = await lockDiscoveredRoomAuthorityInTx(f.tx, [child], "share")
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RoomAuthorityChangedError);
    expect(f.queries).toEqual([]);
  });

  test("discovery reads requested Rooms and Namespace owners without locking unrelated child rosters", async () => {
    const parent = top("z-parent");
    const f = fixture([[child], [child, parent]]);
    expect(await discoverRoomAuthorityInTx(f.tx, [child.id], ["attachment-ns"])).toEqual([child, parent]);
    expect(f.queries.map((query) => query.lock)).toEqual(["none", "none"]);
    expect(f.queries[1]!.params).toEqual([child.id, "attachment-ns", "ns:z-parent", "subthread"]);
    expect(f.queries[1]!.sql).toContain('"rooms"."kind" <>');
    f.assertConsumed();
  });
});
