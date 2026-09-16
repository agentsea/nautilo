import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { DirectDatabase } from "../../src/config/direct-database";
import { createEventFeedPreferenceStore } from "../../src/queries/event-feed-preferences";

const USER = "11111111-1111-4111-8111-111111111111";
function fixture(rows: unknown[][] = []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  // Compile and execute the real Drizzle builders against a recording transport.
  const database = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  }) as unknown as DirectDatabase;
  return { store: createEventFeedPreferenceStore(database), queries };
}

describe("Events preference persistence", () => {
  test("an absent settings row defaults to active and reads only the caller", async () => {
    const { store, queries } = fixture();
    expect(await store.get(USER)).toEqual({ mode: "active" });
    expect(queries[0]?.sql).toContain('where "user_notification_settings"."user_id" = $1');
    expect(queries[0]?.params[0]).toBe(USER);
  });

  test("round-trips the stored deadline through the timestamp decoder", async () => {
    const { store } = fixture([["snoozed", "2099-01-01 09:00:00+00"]]);
    expect(await store.get(USER)).toEqual({ mode: "snoozed", until: "2099-01-01T09:00:00.000Z" });
  });

  test("upserts Events columns without overwriting chat policy or feed read state", async () => {
    const { store, queries } = fixture();
    expect(await store.set(USER, { mode: "quiet" })).toEqual({ mode: "quiet" });
    const query = queries[0]!;
    expect(query.params).toContain(USER); expect(query.params).toContain("quiet");
    const update = query.sql.split('do update set')[1];
    expect(update).toContain('"event_feed_quiet_mode"');
    expect(update).toContain('"event_feed_quiet_until"');
    expect(update).not.toContain('"default_level"');
    expect(query.sql).not.toContain("feed_recipients");
    expect(query.sql).not.toContain("feed_events");
    await store.set(USER, { mode: "active" });
    expect(queries[1]?.params).toContain(null);
  });

  test("rejects an expired snooze before writing", async () => {
    const { store, queries } = fixture();
    expect(await store.set(USER, { mode: "snoozed", until: "2000-01-01T00:00:00Z" }).catch(error => (error as Error).message)).toBe("invalid_input");
    expect(queries).toHaveLength(0);
  });
});
