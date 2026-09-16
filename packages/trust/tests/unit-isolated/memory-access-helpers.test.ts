/**
 * M173 / M212 — `resolveActorsDisplay` + `findRoomByNamespaceId` with a mocked
 * `getSharedDirectDb`. Runs in its own `bun test` process (unit-isolated) so the
 * `mock.module("@nautilo/db")` does not poison other unit tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

const NS_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mock.restore();
});
afterEach(() => {
  mock.restore();
});

/** A query builder that returns `rows` no matter the chain shape. */
function fakeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy"]) {
    chain[m] = () => chain;
  }
  // Make it thenable so `await db.select()...` resolves to `rows`.
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) =>
    resolve(rows);
  return chain;
}

function mockDbReturning(rows: unknown[]) {
  mock.module("@nautilo/db", () => ({
    ...RealDb,
    getSharedDirectDb: () => ({
      select: () => fakeChain(rows),
    }),
  }));
}

async function loadQueriesFresh(): Promise<typeof import("../../src/queries")> {
  const href = new URL("../../src/queries.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<
    typeof import("../../src/queries")
  >;
}

describe("findRoomByNamespaceId (M173)", () => {
  test("maps the row and defaults humanActorIds", async () => {
    mockDbReturning([
      { roomId: ROOM_ID, label: "Fam", humanActorIds: ["a", "b"] },
    ]);
    const { findRoomByNamespaceId } = await loadQueriesFresh();
    expect(await findRoomByNamespaceId(NS_ID)).toEqual({
      roomId: ROOM_ID,
      label: "Fam",
      humanActorIds: ["a", "b"],
    });
  });

  test("returns null when no room backs the namespace", async () => {
    mockDbReturning([]);
    const { findRoomByNamespaceId } = await loadQueriesFresh();
    expect(await findRoomByNamespaceId(NS_ID)).toBeNull();
  });

  test("returns null for empty namespaceId without hitting the db", async () => {
    mockDbReturning([{ roomId: ROOM_ID, label: "x", humanActorIds: null }]);
    const { findRoomByNamespaceId } = await loadQueriesFresh();
    expect(await findRoomByNamespaceId("")).toBeNull();
  });
});

describe("resolveActorsDisplay (M173)", () => {
  test("dedups multiple actors of the same user", async () => {
    // Two actor rows, same owner user id → one entry out.
    mockDbReturning([
      { userId: "u1", handle: "alice", name: "Alice" },
      { userId: "u1", handle: "alice", name: "Alice" },
      { userId: "u2", handle: "bob", name: "Bob" },
    ]);
    const { resolveActorsDisplay } = await loadQueriesFresh();
    const out = await resolveActorsDisplay(["act-1", "act-2", "act-3"]);
    expect(out).toEqual([
      { userHandle: "alice", displayName: "Alice" },
      { userHandle: "bob", displayName: "Bob" },
    ]);
  });

  test("coerces null handle/name to empty strings", async () => {
    mockDbReturning([{ userId: "u3", handle: null, name: null }]);
    const { resolveActorsDisplay } = await loadQueriesFresh();
    expect(await resolveActorsDisplay(["act-9"])).toEqual([
      { userHandle: "", displayName: "" },
    ]);
  });

  test("returns [] for empty input without hitting the db", async () => {
    mockDbReturning([{ userId: "u1", handle: "alice", name: "Alice" }]);
    const { resolveActorsDisplay } = await loadQueriesFresh();
    expect(await resolveActorsDisplay([])).toEqual([]);
  });
});
