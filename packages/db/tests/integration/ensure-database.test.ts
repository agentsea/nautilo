import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  __resetSharedDirectDbForTests,
  ensureDatabase,
  createDirectDb,
  getSharedDirectDb,
  sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

bootstrapTestDbInstance();

describe("ensureDatabase()", () => {
  afterAll(async () => {
    await __resetSharedDirectDbForTests();
  });

  test("second call is idempotent when Postgres is already up", async () => {
    const first = await ensureDatabase();
    expect(first.migrationsRan).toBe(true);

    const second = await ensureDatabase();
    expect(second.migrationsRan).toBe(true);
    expect(second.containerStarted).toBe(false);
  });

  test("returns a runtime app-role connection that can use the migrated public schema", async () => {
    await ensureDatabase();

    const appDb = getSharedDirectDb();
    const result = await appDb.execute(sql`
      SELECT
        current_user AS role_name,
        to_regclass('public.profiles')::text AS profiles_table
    `);

    expect(result[0]).toEqual({
      role_name: "nautilo",
      profiles_table: "profiles",
    });
  });
});

describe("createDirectDb pool sizing", () => {
  let db: ReturnType<typeof createDirectDb>;

  beforeAll(async () => {
    await ensureDatabase();
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  test("pool size limits concurrent queries (third query queues)", async () => {
    db = createDirectDb(2);
    const longQuery = sql`SELECT pg_sleep(0.15)`;
    const start = Date.now();
    await Promise.all([
      db.execute(longQuery),
      db.execute(longQuery),
      db.execute(longQuery),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(280);
  });
});
