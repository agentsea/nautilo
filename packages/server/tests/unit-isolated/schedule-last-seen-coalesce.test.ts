/**
 * D124 — coalesce scheduled `bumpLastSeen` calls per user (~30s window).
 */
import { afterAll, describe, expect, mock, test } from "bun:test";

const bumpLastSeenMock = mock(() => Promise.resolve());

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return { ...trust, bumpLastSeen: bumpLastSeenMock };
});

import { scheduleLastSeenBump } from "../../src/preHandlers/schedule-last-seen";

afterAll(() => {
  mock.restore();
});

describe("scheduleLastSeenBump coalescing (B2)", () => {
  test("schedules at most one bump per 30s window per user", async () => {
    const origNow = Date.now;
    let t = 1_700_000_000_000;
    Date.now = () => t;

    try {
      bumpLastSeenMock.mockClear();
      for (let i = 0; i < 5; i++) {
        scheduleLastSeenBump("user-1");
      }
      await new Promise<void>((r) => setImmediate(r));
      expect(bumpLastSeenMock.mock.calls.length).toBe(1);

      t += 31_000;
      scheduleLastSeenBump("user-1");
      await new Promise<void>((r) => setImmediate(r));
      expect(bumpLastSeenMock.mock.calls.length).toBe(2);
    } finally {
      Date.now = origNow;
    }
  });
});
