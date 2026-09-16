import { describe, expect, test } from "bun:test";
import { finalizeExpiredSilenceWindows } from "../../src/room-silence";

describe("finalizeExpiredSilenceWindows idempotency (D279 3.6)", () => {
  test("only the caller that deletes rows returns true", async () => {
    let deleteCalls = 0;
    const db = {
      delete: () => ({
        where: () => ({
          returning: async () => {
            deleteCalls += 1;
            return deleteCalls === 1 ? [{ id: "win-1" }] : [];
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
          innerJoin: () => ({
            where: async () => [],
          }),
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const first = await finalizeExpiredSilenceWindows(
      db as never,
      "room-1",
      new Date("2026-06-09T13:00:00.000Z"),
    );
    const second = await finalizeExpiredSilenceWindows(
      db as never,
      "room-1",
      new Date("2026-06-09T13:00:00.000Z"),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(deleteCalls).toBe(2);
  });
});
