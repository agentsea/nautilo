import { afterEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  mock.restore();
});

async function loadQueriesFresh(): Promise<typeof import("../../src/queries")> {
  const href = new URL("../../src/queries.ts", import.meta.url).href;
  return import(`${href}?visibility=${Date.now()}-${Math.random()}`) as Promise<
    typeof import("../../src/queries")
  >;
}

function visibilityDbMock(row: { kind: string; discoverable: boolean }) {
  let updatedValues: Record<string, unknown> | null = null;
  let updateCount = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    }),
    update: () => {
      updateCount += 1;
      return {
        set: (values: Record<string, unknown>) => {
          updatedValues = values;
          return { where: async () => [] };
        },
      };
    },
  };
  return {
    db,
    getUpdatedValues: () => updatedValues,
    getUpdateCount: () => updateCount,
  };
}

describe("updateRoomVisibility", () => {
  test("a flag-only change updates discoverable without touching kind", async () => {
    const fixture = visibilityDbMock({ kind: "open", discoverable: true });
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open", false)).toBe(true);
    expect(fixture.getUpdateCount()).toBe(1);
    expect(fixture.getUpdatedValues()).toMatchObject({ discoverable: false });
    expect(fixture.getUpdatedValues()).not.toHaveProperty("kind");
  });

  test("omitting discoverable preserves the stored value and remains idempotent", async () => {
    const fixture = visibilityDbMock({ kind: "open", discoverable: false });
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open")).toBe(false);
    expect(fixture.getUpdateCount()).toBe(0);
  });

  test("a kind change with omitted discoverable does not overwrite the flag", async () => {
    const fixture = visibilityDbMock({ kind: "group", discoverable: false });
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => fixture.db,
    }));
    const { updateRoomVisibility } = await loadQueriesFresh();

    expect(await updateRoomVisibility(ROOM_ID, "open")).toBe(true);
    expect(fixture.getUpdatedValues()).toMatchObject({ kind: "open" });
    expect(fixture.getUpdatedValues()).not.toHaveProperty("discoverable");
  });
});
