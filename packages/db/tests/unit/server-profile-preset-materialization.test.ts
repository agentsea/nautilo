import { describe, expect, test } from "bun:test";
import { SERVER_ICON_PRESET_IDS, type AvatarRef } from "@nautilo/types";
import type { ServerProfileRow } from "../../src/schema/server-profile";
import {
  materializeDefaultServerProfileOnce,
  upsertServerProfile,
  type ServerProfileDb,
} from "../../src/utils/server-profile-queries";

function rowWith(icon: AvatarRef | null): ServerProfileRow {
  return {
    id: "server",
    name: null,
    description: null,
    descriptionVisibility: "public",
    icon,
    reviewedAt: null,
    updatedAt: new Date("2026-07-18T00:00:00.000Z"),
  };
}

function fakeDb(initial: ServerProfileRow | null) {
  let row = initial;
  let insertValues: Partial<ServerProfileRow> = {};

  const insertBuilder = {
    values(values: Partial<ServerProfileRow>) {
      insertValues = values;
      return insertBuilder;
    },
    onConflictDoUpdate(config: {
      set: Partial<ServerProfileRow>;
      setWhere?: unknown;
    }) {
      const existed = row !== null;
      if (!row) {
        row = {
          ...rowWith(null),
          ...insertValues,
        };
        return {
          returning: async () => [row],
        };
      }

      const isConditionalMaterialization = config.setWhere !== undefined;
      const isLegacy =
        row.icon === null ||
        (row.icon.kind === "preset" && row.icon.id === "server-default");
      if (!isConditionalMaterialization || isLegacy) {
        row = { ...row, ...config.set };
        return {
          returning: async () => [row],
        };
      }
      return {
        returning: async () => (existed ? [] : [row]),
      };
    },
  };

  const selectBuilder = {
    from() {
      return selectBuilder;
    },
    where() {
      return selectBuilder;
    },
    async limit() {
      return row ? [row] : [];
    },
  };

  return {
    db: {
      insert: () => insertBuilder,
      select: () => selectBuilder,
    } as unknown as ServerProfileDb,
    getRow: () => row,
  };
}

const firstPreset = SERVER_ICON_PRESET_IDS[0];
const secondPreset = SERVER_ICON_PRESET_IDS[1];

describe("materializeDefaultServerProfileOnce", () => {
  test("unset profile persists one entropy-selected canonical preset", async () => {
    const store = fakeDb(null);
    const profile = await materializeDefaultServerProfileOnce(store.db, {
      randomIndex: () => 1,
    });
    expect(profile.icon).toEqual({ kind: "preset", id: secondPreset });
    expect(store.getRow()?.icon).toEqual(profile.icon);
  });

  test("repeat calls and concurrent first reads cannot reroll", async () => {
    const store = fakeDb(null);
    const [first, second] = await Promise.all([
      materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 0 }),
      materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 1 }),
    ]);
    expect(first.icon).toEqual({ kind: "preset", id: firstPreset });
    expect(second.icon).toEqual(first.icon);
    expect(store.getRow()?.icon).toEqual(first.icon);
  });

  test("legacy server-default is upgraded exactly once", async () => {
    const store = fakeDb(rowWith({ kind: "preset", id: "server-default" }));
    await materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 1 });
    await materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 0 });
    expect(store.getRow()?.icon).toEqual({ kind: "preset", id: secondPreset });
  });

  test.each([
    { kind: "uploaded", blobId: "uploaded-1" } as const,
    { kind: "generated", blobId: "generated-1" } as const,
    { kind: "preset", id: secondPreset } as const,
  ])("preserves explicit $kind icons", async (icon) => {
    const store = fakeDb(rowWith(icon));
    const profile = await materializeDefaultServerProfileOnce(store.db, {
      randomIndex: () => 0,
    });
    expect(profile.icon).toEqual(icon);
    expect(store.getRow()?.icon).toEqual(icon);
  });

  test("preserves a later Admin override across re-materialization", async () => {
    const store = fakeDb(null);
    await materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 0 });
    const adminIcon = { kind: "uploaded", blobId: "admin-choice" } as const;
    await upsertServerProfile(store.db, { icon: adminIcon });
    await materializeDefaultServerProfileOnce(store.db, { randomIndex: () => 1 });
    expect(store.getRow()?.icon).toEqual(adminIcon);
  });
});
