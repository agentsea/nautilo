/**
 * D090 §1.7 — session-notifications integration tests.
 *
 * Covers the two DB-backed helpers (`appendSessionNotification`,
 * `drainSessionNotifications`) against a live Postgres + fixture
 * user + agent. Pure block-formatting is covered by the unit suite
 * (`tests/unit/session-notifications.test.ts`) — this file exists
 * purely to exercise what SQL actually does.
 *
 * Fixtures: one test user + one test agent in `beforeAll`; cleaned
 * up via ON DELETE CASCADE on user delete in `afterAll`. Thread ids
 * are string literals unique per test.
 *
 * Requires: live Postgres (test-cruft instance via bootstrapTestDbInstance).
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  eq,
  and,
  sql,
  users,
  agents,
  sessionNotifications,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  appendSessionNotification,
  drainSessionNotifications,
} from "../../src/notifications/session-notifications";


let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let agentId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({
      name: "notif-e2e",
      email: `notif-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  ownerId = user.id;

  // M045: `agents.owner_id` was dropped — insert payload is handle +
  // displayName only.
  const [agent] = await db
    .insert(agents)
    .values({
      handle: `notif-e2e-${Date.now()}`,
    })
    .returning({ id: agents.id });
  if (!agent) throw new Error("Failed to create test agent");
  agentId = agent.id;
});

afterAll(async () => {
  if (db && ownerId) {
    // M045: `DELETE FROM users` no longer cascades to `agents` (the
    // owner_id FK was dropped). Delete the agent row explicitly before
    // the user — file_revisions / session_notifications rows still
    // cascade via the user delete.
    if (agentId) {
      await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`);
    await db.end();
  }
});

/**
 * Unique-per-test thread id so parallel / sequential tests don't
 * cross-contaminate the buffer. Keeps the assertions sharp
 * (exact-row comparisons) without needing a full table truncate
 * between cases.
 */
function freshThread(label: string): string {
  return `thread-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

describe("appendSessionNotification (DB-backed)", () => {
  test("writes a pending row and returns its id", async () => {
    const threadId = freshThread("append-1");
    const id = await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "9fbe7e65:067b238f",
      absolutePath: "/tmp/notif-1.md",
    });
    expect(typeof id).toBe("string");
    expect(id).not.toBeNull();

    const rows = await db
      .select()
      .from(sessionNotifications)
      .where(eq(sessionNotifications.threadId, threadId));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.kind).toBe("reject");
    expect(row.patchId).toBe("9fbe7e65:067b238f");
    expect(row.absolutePath).toBe("/tmp/notif-1.md");
    expect(row.drainedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("swallows and returns null on invalid agentId (FK violation)", async () => {
    // Bogus agent id — not in fixtures, not a valid UUID either, so
    // the FK constraint fires. The helper swallows + logs + returns
    // null; a reject click shouldn't poison the apply path.
    const id = await appendSessionNotification({
      threadId: freshThread("append-bad-fk"),
      agentId: "00000000-0000-0000-0000-000000000000",
      kind: "reject",
      patchId: "abc:def",
      absolutePath: "/tmp/notif-bad-fk.md",
    });
    expect(id).toBeNull();
  });

  test("two consecutive appends produce two rows", async () => {
    const threadId = freshThread("append-batch");
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "p1:a",
      absolutePath: "/tmp/batch-1.md",
    });
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "p2:b",
      absolutePath: "/tmp/batch-2.md",
    });

    const rows = await db
      .select()
      .from(sessionNotifications)
      .where(eq(sessionNotifications.threadId, threadId));
    expect(rows.length).toBe(2);
    const patchIds = rows.map((r) => r.patchId).sort();
    expect(patchIds).toEqual(["p1:a", "p2:b"]);
  });
});

describe("drainSessionNotifications (DB-backed)", () => {
  test("empty thread → empty array", async () => {
    const threadId = freshThread("drain-empty");
    const rows = await drainSessionNotifications(threadId, agentId);
    expect(rows).toEqual([]);
  });

  test("empty thread or agent id → empty array (guard rail)", async () => {
    expect(await drainSessionNotifications("", agentId)).toEqual([]);
    expect(await drainSessionNotifications(freshThread("x"), "")).toEqual([]);
  });

  test("returns pending rows in createdAt ASC order and marks them drained", async () => {
    const threadId = freshThread("drain-order");
    // Three appends in order; DB-side timestamps should resolve to
    // ASC on the `created_at` column.
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "p1:a",
      absolutePath: "/tmp/drain-1.md",
    });
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "p2:b",
      absolutePath: "/tmp/drain-2.md",
    });
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "p3:c",
      absolutePath: "/tmp/drain-3.md",
    });

    const drained = await drainSessionNotifications(threadId, agentId);
    expect(drained.length).toBe(3);
    expect(drained.map((r) => r.patchId)).toEqual(["p1:a", "p2:b", "p3:c"]);
    // Returned rows reflect pre-drain state (drainedAt is null).
    for (const r of drained) {
      expect(r.drainedAt).toBeNull();
    }

    // On-disk state post-drain: rows still exist (soft delete) but
    // drainedAt is set.
    const after = await db
      .select()
      .from(sessionNotifications)
      .where(eq(sessionNotifications.threadId, threadId));
    expect(after.length).toBe(3);
    for (const r of after) {
      expect(r.drainedAt).not.toBeNull();
      expect(r.drainedAt).toBeInstanceOf(Date);
    }
  });

  test("second drain with no new appends → empty (idempotent)", async () => {
    const threadId = freshThread("drain-idempotent");
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "once:x",
      absolutePath: "/tmp/once.md",
    });
    const first = await drainSessionNotifications(threadId, agentId);
    expect(first.length).toBe(1);
    const second = await drainSessionNotifications(threadId, agentId);
    expect(second).toEqual([]);
  });

  test("drain is scoped to (threadId, agentId) — other threads unaffected", async () => {
    const threadA = freshThread("scope-A");
    const threadB = freshThread("scope-B");

    await appendSessionNotification({
      threadId: threadA,
      agentId,
      kind: "reject",
      patchId: "a:1",
      absolutePath: "/tmp/scope-a.md",
    });
    await appendSessionNotification({
      threadId: threadB,
      agentId,
      kind: "reject",
      patchId: "b:1",
      absolutePath: "/tmp/scope-b.md",
    });

    const drainedA = await drainSessionNotifications(threadA, agentId);
    expect(drainedA.length).toBe(1);
    expect(drainedA[0]!.patchId).toBe("a:1");

    // threadB still has its row pending.
    const remainingB = await db
      .select()
      .from(sessionNotifications)
      .where(
        and(
          eq(sessionNotifications.threadId, threadB),
          eq(sessionNotifications.patchId, "b:1"),
        ),
      );
    expect(remainingB.length).toBe(1);
    expect(remainingB[0]!.drainedAt).toBeNull();
  });

  test("drain ignores already-drained rows on the same thread", async () => {
    const threadId = freshThread("drain-skip-drained");
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "first:x",
      absolutePath: "/tmp/first.md",
    });
    const first = await drainSessionNotifications(threadId, agentId);
    expect(first.length).toBe(1);

    // New row after the first drain — only the new one should come
    // out on the next call.
    await appendSessionNotification({
      threadId,
      agentId,
      kind: "reject",
      patchId: "second:y",
      absolutePath: "/tmp/second.md",
    });
    const second = await drainSessionNotifications(threadId, agentId);
    expect(second.length).toBe(1);
    expect(second[0]!.patchId).toBe("second:y");
  });
});
