/**
 * M107 Phase 2c — partial-unique-index contract for `users.handle`.
 *
 * Migration `0046_m107_users_handle_unique.sql` creates
 *   CREATE UNIQUE INDEX users_handle_unique_local
 *     ON users(handle)
 *     WHERE server IS NULL AND handle IS NOT NULL;
 *
 * The predicate has two practical consequences:
 *
 *   1. Two LOCAL Humans (`server IS NULL`) cannot share the same
 *      non-NULL handle — the index aborts the second insert with a
 *      Postgres `23505 unique_violation`.
 *   2. A foreign-stub row (`server IS NOT NULL`, M047) may carry a
 *      handle that collides with a local Human's handle, because the
 *      index predicate excludes it. This preserves the federation
 *      contract: `@alice@nautilo.local` and `@alice@other.example`
 *      are distinct identities that happen to share a local part.
 *   3. Pre-onboarding rows with `handle IS NULL` (rare today, but the
 *      schema allows it) coexist freely — the index predicate excludes
 *      them via `handle IS NOT NULL`.
 *
 * This test exercises all three behaviours against a real Postgres so
 * a future schema change that drops the partial predicate is caught
 * immediately.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { ensureDatabase, createDirectDb, users, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

describe("M107 — users_handle_unique_local partial unique index", () => {
  let db: ReturnType<typeof createDirectDb>;
  const TAG = "m107-handle-uniq-test-";
  const handleLocal = `${TAG}alice`;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    db = createDirectDb(1);
  });

  afterEach(async () => {
    // Clean up all rows this test inserted, identified by the name tag.
    // (We avoid email-based cleanup because email is now nullable and
    // some fixtures below leave it NULL.)
    const allRows = await db.select({ id: users.id, name: users.name }).from(users);
    for (const r of allRows) {
      if (r.name.startsWith(TAG)) {
        await db.delete(users).where(eq(users.id, r.id));
      }
    }
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  test("two local Humans with the same handle → second insert fails 23505", async () => {
    await db.insert(users).values({
      name: `${TAG}A`,
      email: null,
      handle: handleLocal,
      server: null,
    });
    let caughtCode: string | undefined;
    try {
      await db.insert(users).values({
        name: `${TAG}B`,
        email: null,
        handle: handleLocal,
        server: null,
      });
    } catch (e) {
      // Drizzle wraps postgres-js errors in a generic Error whose top-level
      // `.code` is undefined and `.message` starts with "Failed query: ...".
      // The underlying PostgresError (with SQLSTATE) sits on `err.cause`.
      const err = e as {
        code?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      };
      caughtCode = err.code ?? err.cause?.code;
      if (caughtCode === undefined) {
        const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
        // Fallback for drivers that only set message
        caughtCode = /unique|duplicate|23505/i.test(msg) ? "23505" : undefined;
      }
    }
    expect(caughtCode).toBe("23505");
  });

  test("local Human + foreign-stub with same handle → both insertions succeed (federation)", async () => {
    await db.insert(users).values({
      name: `${TAG}local`,
      email: null,
      handle: handleLocal,
      server: null,
    });
    // Foreign stub: server IS NOT NULL. The partial index predicate
    // excludes this row, so the same handle is permitted.
    await db.insert(users).values({
      name: `${TAG}foreign`,
      email: null,
      handle: handleLocal,
      server: "other.example",
    });
    // No throw == pass; spot-check both rows exist.
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.handle, handleLocal));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("two local rows with handle NULL coexist (predicate excludes NULLs)", async () => {
    await db.insert(users).values({
      name: `${TAG}null-a`,
      email: null,
      handle: null,
      server: null,
    });
    await db.insert(users).values({
      name: `${TAG}null-b`,
      email: null,
      handle: null,
      server: null,
    });
    // No throw == pass.
    expect(true).toBe(true);
  });
});
