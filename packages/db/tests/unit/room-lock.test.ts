import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  acquireRoomWriteLock,
  type RoomLockTransaction,
} from "../../src/queries/room-lock";

describe("acquireRoomWriteLock", () => {
  test("executes exactly one parameterized Room row lock", async () => {
    const queries: SQL[] = [];
    const tx: RoomLockTransaction = {
      execute: async (query) => {
        queries.push(query);
        return [];
      },
    };

    await acquireRoomWriteLock(tx, "11111111-1111-4111-8111-111111111111");

    expect(queries).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(queries[0]!);
    expect(rendered.sql.replaceAll(/\s+/g, " ").trim()).toBe(
      "SELECT id FROM rooms WHERE id = $1 FOR UPDATE",
    );
    expect(rendered.params).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  test("rejects an empty Room id before touching the transaction", async () => {
    let calls = 0;
    const tx: RoomLockTransaction = {
      execute: async () => {
        calls += 1;
        return [];
      },
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(acquireRoomWriteLock(tx, "   ")).rejects.toThrow(
      "roomId is required",
    );
    expect(calls).toBe(0);
  });
});
