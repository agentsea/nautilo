/**
 * M033 Phase 3 — `findUserDisplayInfo` with mocked `agentDb`.
 * Runs in its own `bun test` process via `scripts/run-unit.sh` so
 * `mock.module("@nautilo/db")` does not poison other unit tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

const USER_ID = "11111111-1111-4111-8111-111111111111";

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

describe("findUserDisplayInfo (M033 Phase 3)", () => {
  test("returns projected identity columns from users_public", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      agentDb: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: USER_ID,
                    name: "Alice",
                    handle: "alice",
                    server: null,
                  },
                ]),
            }),
          }),
        }),
      },
    }));
    const { findUserDisplayInfo } = await loadQueriesFresh();
    const got = await findUserDisplayInfo(USER_ID);
    expect(got).toEqual({
      id: USER_ID,
      name: "Alice",
      handle: "alice",
      server: null,
    });
    expect(got).not.toHaveProperty("externalId");
    expect(got).not.toHaveProperty("serverRole");
  });

  test("returns null when no row", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      agentDb: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      },
    }));
    const { findUserDisplayInfo } = await loadQueriesFresh();
    expect(await findUserDisplayInfo(USER_ID)).toBeNull();
  });
});
