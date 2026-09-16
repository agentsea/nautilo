import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import { drizzle } from "drizzle-orm/postgres-js";

import { createPostgresStenographerAuthorizationWaitPort } from "../../src/server/journal/postgres-stenographer-authorization-wait.ts";

const NOW = new Date("2026-09-10T12:32:34.490Z");

async function waitingQuery(lane: "live" | "compaction"): Promise<Readonly<{
  sql: string;
  params: unknown[];
}>> {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle.mock({
    logger: {
      logQuery(sql: string, params: unknown[]) {
        queries.push({ sql, params });
      },
    },
  }) as unknown as DirectDatabase;

  try {
    await createPostgresStenographerAuthorizationWaitPort(db).waiting({
      roomId: "room-1",
      lane,
      now: NOW,
    });
  } catch {
    // drizzle.mock compiles and logs the query before rejecting without a client.
  }

  expect(queries).toHaveLength(1);
  return queries[0]!;
}

describe("Postgres Stenographer authorization wait markers", () => {
  test("encodes extraction timestamps and retains the first wait in the same lane", async () => {
    const query = await waitingQuery("live");

    expect(query.params.some((param) => param instanceof Date)).toBe(false);
    expect(query.params.filter((param) => param === NOW.toISOString())).toHaveLength(3);
    expect(query.sql).toContain(
      'CASE WHEN "room_journal_state"."extraction_authorization_wait_lane" = $2',
    );
    expect(query.sql).toContain(
      'THEN COALESCE("room_journal_state"."extraction_authorization_waiting_since", $3) ELSE $4 END',
    );
  });

  test("encodes compaction timestamps and retains the first wait", async () => {
    const query = await waitingQuery("compaction");

    expect(query.params.some((param) => param instanceof Date)).toBe(false);
    expect(query.params.filter((param) => param === NOW.toISOString())).toHaveLength(2);
    expect(query.sql).toContain(
      '"compaction_authorization_waiting_since" = COALESCE("room_journal_state"."compaction_authorization_waiting_since", $1)',
    );
  });
});
