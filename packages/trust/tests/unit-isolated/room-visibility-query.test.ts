import { afterEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

afterEach(() => {
  mock.restore();
});

async function loadQueriesFresh(): Promise<typeof import("../../src/queries")> {
  const href = new URL("../../src/queries.ts", import.meta.url).href;
  return import(`${href}?visibility=${Date.now()}-${Math.random()}`) as Promise<
    typeof import("../../src/queries")
  >;
}

type VisibilityRoom = {
  ownerId: string;
  type: string;
  kind: string;
  discoverable: boolean;
};

type VisibilityMember = {
  kind: string;
  ownerId: string;
  agentId: string | null;
};

function visibilityDbMock(
  room: VisibilityRoom | null,
  roster: VisibilityMember[] = [],
) {
  let updatedValues: Record<string, unknown> | null = null;
  let updateCount = 0;
  const operations: string[] = [];
  const tx = {
    execute: async () => {
      operations.push("lock");
      return [];
    },
    select: () => ({
      from: (table: unknown) => {
        if (table === RealDb.rooms) {
          return {
            where: () => ({
              limit: async () => {
                operations.push("room");
                return room ? [room] : [];
              },
            }),
          };
        }
        if (table === RealDb.roomMembers) {
          return {
            innerJoin: () => ({
              where: async () => {
                operations.push("roster");
                return roster;
              },
            }),
          };
        }
        throw new Error("unexpected table");
      },
    }),
    update: () => {
      updateCount += 1;
      return {
        set: (values: Record<string, unknown>) => {
          updatedValues = values;
          return {
            where: async () => {
              operations.push("update");
              return [];
            },
          };
        },
      };
    },
  };
  const db = {
    transaction: async <T>(run: (transaction: typeof tx) => Promise<T>) => run(tx),
  };
  return {
    db,
    getUpdatedValues: () => updatedValues,
    getUpdateCount: () => updateCount,
    getOperations: () => operations,
  };
}

function room(overrides: Partial<VisibilityRoom> = {}): VisibilityRoom {
  return {
    ownerId: OWNER_ID,
    type: "shared",
    kind: "open",
    discoverable: true,
    ...overrides,
  };
}

function personalRoster(): VisibilityMember[] {
  return [
    { kind: "user", ownerId: OWNER_ID, agentId: null },
    { kind: "agent", ownerId: OWNER_ID, agentId: AGENT_ID },
  ];
}

describe("updateRoomVisibility", () => {
  test("a flag-only public change updates discoverable without touching kind", async () => {
    const fixture = visibilityDbMock(room());
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open", false)).toEqual({
      changed: true,
      kind: "open",
      discoverable: false,
    });
    expect(fixture.getUpdateCount()).toBe(1);
    expect(fixture.getUpdatedValues()).toMatchObject({ discoverable: false });
    expect(fixture.getUpdatedValues()).not.toHaveProperty("kind");
  });

  test("omitting discoverable preserves the stored value and remains idempotent", async () => {
    const fixture = visibilityDbMock(room({ discoverable: false }));
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open")).toEqual({
      changed: false,
      kind: "open",
      discoverable: false,
    });
    expect(fixture.getUpdateCount()).toBe(0);
  });

  test("opening a group preserves its discovery preference when omitted", async () => {
    const fixture = visibilityDbMock(room({ kind: "group", discoverable: false }));
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open")).toEqual({
      changed: true,
      kind: "open",
      discoverable: false,
    });
    expect(fixture.getUpdatedValues()).toMatchObject({ kind: "open" });
    expect(fixture.getUpdatedValues()).not.toHaveProperty("discoverable");
  });

  test("opens an existing private Room without changing its roster-derived metadata", async () => {
    const fixture = visibilityDbMock(
      room({ kind: "private", type: "private", discoverable: false }),
      personalRoster(),
    );
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open")).toEqual({
      changed: true,
      kind: "open",
      discoverable: false,
    });
    expect(fixture.getUpdatedValues()).toMatchObject({ kind: "open" });
    expect(fixture.getOperations()).toEqual(["lock", "room", "update"]);
  });

  test("a private target leaves an existing private Room private without inspecting its roster", async () => {
    const fixture = visibilityDbMock(
      room({ kind: "private", type: "shared" }),
      [{ kind: "user", ownerId: "someone-else", agentId: null }],
    );
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "group")).toEqual({
      changed: false,
      kind: "private",
      discoverable: true,
    });
    expect(fixture.getOperations()).toEqual(["lock", "room"]);
  });

  test("a private target does not reclassify an existing group", async () => {
    const fixture = visibilityDbMock(
      room({ kind: "group", type: "private" }),
      personalRoster(),
    );
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "group")).toEqual({
      changed: false,
      kind: "group",
      discoverable: true,
    });
    expect(fixture.getOperations()).toEqual(["lock", "room"]);
  });

  test("an opened personal Room restores private from its exact owner roster", async () => {
    const fixture = visibilityDbMock(
      room({ type: "private" }),
      personalRoster(),
    );
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "group")).toEqual({
      changed: true,
      kind: "private",
      discoverable: true,
    });
    expect(fixture.getUpdatedValues()).toMatchObject({ kind: "private" });
    expect(fixture.getOperations()).toEqual(["lock", "room", "roster", "update"]);
  });

  test.each([
    ["shared provenance", room({ type: "shared" }), personalRoster()],
    [
      "a joined Human",
      room({ type: "private" }),
      [
        ...personalRoster(),
        { kind: "user", ownerId: "joined-human", agentId: null },
      ],
    ],
    [
      "a foreign Genie",
      room({ type: "private" }),
      [
        { kind: "user", ownerId: OWNER_ID, agentId: null },
        { kind: "agent", ownerId: "another-owner", agentId: AGENT_ID },
      ],
    ],
    [
      "an actor without a Genie identity",
      room({ type: "private" }),
      [
        { kind: "user", ownerId: OWNER_ID, agentId: null },
        { kind: "agent", ownerId: OWNER_ID, agentId: null },
      ],
    ],
  ])("an open Room with %s returns to group", async (_label, source, roster) => {
    const fixture = visibilityDbMock(source, roster);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "group")).toEqual({
      changed: true,
      kind: "group",
      discoverable: true,
    });
    expect(fixture.getUpdatedValues()).toMatchObject({ kind: "group" });
  });

  test("rejects unsupported source kinds after taking the common Room lock", async () => {
    const fixture = visibilityDbMock(room({ kind: "subthread" }));
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { MembershipOpError, updateRoomVisibility } = await loadQueriesFresh();

    expect(updateRoomVisibility(ROOM_ID, "open")).rejects.toBeInstanceOf(
      MembershipOpError,
    );
    expect(fixture.getOperations()).toEqual(["lock", "room"]);
    expect(fixture.getUpdateCount()).toBe(0);
  });

  test("reports a missing Room without attempting a write", async () => {
    const fixture = visibilityDbMock(null);
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { MembershipOpError, updateRoomVisibility } = await loadQueriesFresh();

    expect(updateRoomVisibility(ROOM_ID, "open")).rejects.toBeInstanceOf(
      MembershipOpError,
    );
    expect(fixture.getUpdateCount()).toBe(0);
  });
});
