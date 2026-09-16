import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDirectDb, ensureDatabase } from "../../src";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
});

afterAll(async () => {
  await db?.end();
});

describe("M233 nautilo_agent notification privilege boundary", () => {
  test("denies preference policy and grants only SELECT/INSERT on facts", async () => {
    const result = await db.execute<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      SELECT
        table_name,
        has_table_privilege('nautilo_agent', format('public.%I', table_name), 'SELECT') AS can_select,
        has_table_privilege('nautilo_agent', format('public.%I', table_name), 'INSERT') AS can_insert,
        has_table_privilege('nautilo_agent', format('public.%I', table_name), 'UPDATE') AS can_update,
        has_table_privilege('nautilo_agent', format('public.%I', table_name), 'DELETE') AS can_delete
      FROM (
        VALUES
          ('user_notification_settings'),
          ('room_notification_settings'),
          ('session_message_directed_recipients'),
          ('subthread_notification_participants')
      ) AS notification_tables(table_name)
      ORDER BY table_name
    `);
    const rows = [...result];
    expect(rows).toEqual([
      {
        table_name: "room_notification_settings",
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
      },
      {
        table_name: "session_message_directed_recipients",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
      {
        table_name: "subthread_notification_participants",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
      {
        table_name: "user_notification_settings",
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
      },
    ]);
  });
});
