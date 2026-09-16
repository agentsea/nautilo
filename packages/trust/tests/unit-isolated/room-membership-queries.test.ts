/**
 * M213 Phase 4 — room membership query guards and picker delegation.
 * Mocked `getSharedDirectDb` only; no Postgres required.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ACTOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  mock.restore();
});

afterEach(() => {
  mock.restore();
});

async function loadQueriesFresh(): Promise<typeof import("../../src/queries")> {
  const href = new URL("../../src/queries.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<typeof import("../../src/queries")>;
}

function membershipQueryMock(
  rows: Array<{ id: string; type: string; graphThreadId: string; createdAt?: Date | null }>,
) {
  let dbCalls = 0;
  const terminal = {
    limit: () => {
      dbCalls += 1;
      return Promise.resolve(rows);
    },
    then: (resolve: (value: typeof rows) => void) => {
      dbCalls += 1;
      resolve(rows);
      return Promise.resolve(rows);
    },
  };
  const where = () => terminal;
  const innerJoin = () => ({ innerJoin, where });
  const from = () => ({ innerJoin, where });
  const select = () => {
    dbCalls += 1;
    return { from, innerJoin, where };
  };
  const db = { select };
  return { db, getDbCalls: () => dbCalls };
}

describe("findRoomForUserAndAgentMembers (M213 Phase 4)", () => {
  test("rejects invalid UUID without touching the database", async () => {
    const { db, getDbCalls } = membershipQueryMock([]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findRoomForUserAndAgentMembers } = await loadQueriesFresh();
    expect(
      await findRoomForUserAndAgentMembers("not-a-uuid", USER_ACTOR_ID, AGENT_ID),
    ).toBeNull();
    expect(getDbCalls()).toBe(0);
  });

  test("rejects empty userActorId or agentId without touching the database", async () => {
    const { db, getDbCalls } = membershipQueryMock([]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findRoomForUserAndAgentMembers } = await loadQueriesFresh();
    expect(await findRoomForUserAndAgentMembers(ROOM_ID, "", AGENT_ID)).toBeNull();
    expect(await findRoomForUserAndAgentMembers(ROOM_ID, USER_ACTOR_ID, "")).toBeNull();
    expect(getDbCalls()).toBe(0);
  });

  test("returns projected room row when both memberships match", async () => {
    const row = {
      id: ROOM_ID,
      type: "private",
      graphThreadId: "app:default",
    };
    const { db } = membershipQueryMock([row]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findRoomForUserAndAgentMembers } = await loadQueriesFresh();
    expect(
      await findRoomForUserAndAgentMembers(ROOM_ID, USER_ACTOR_ID, AGENT_ID),
    ).toEqual(row);
  });

  test("returns null when the joined membership query finds no row", async () => {
    const { db } = membershipQueryMock([]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findRoomForUserAndAgentMembers } = await loadQueriesFresh();
    expect(
      await findRoomForUserAndAgentMembers(ROOM_ID, USER_ACTOR_ID, AGENT_ID),
    ).toBeNull();
  });
});

describe("findDefaultRoomForActor (M213 Phase 4)", () => {
  test("returns null when no private room has both memberships", async () => {
    const { db } = membershipQueryMock([]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findDefaultRoomForActor } = await loadQueriesFresh();
    expect(await findDefaultRoomForActor(USER_ACTOR_ID, AGENT_ID)).toBeNull();
  });

  test("delegates deterministic pick to pickDefaultRoomFromPrivateMemberCandidates", async () => {
    const dLegacy = new Date("2018-01-01");
    const dOlder = new Date("2019-01-01");
    const { db } = membershipQueryMock([
      {
        id: "room-newer",
        type: "private",
        graphThreadId: "room:newer",
        createdAt: new Date("2022-01-01"),
      },
      {
        id: "room-legacy",
        type: "private",
        graphThreadId: "app:default",
        createdAt: dLegacy,
      },
      {
        id: "room-older",
        type: "private",
        graphThreadId: "room:older",
        createdAt: dOlder,
      },
    ]);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => db,
    }));
    const { findDefaultRoomForActor } = await loadQueriesFresh();
    const picked = await findDefaultRoomForActor(USER_ACTOR_ID, AGENT_ID);
    expect(picked).toEqual({
      id: "room-legacy",
      type: "private",
      graphThreadId: "app:default",
    });
  });
});
