/**
 * M075 — `ensureSession` keys rows by `(owner_id, thread_id)` so two humans
 * never share a session row for the same graph thread string.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  resolveAgentDatabaseConnectionString,
  users,
  sessions,
  eq,
  and,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureSession } from "../../src/store/session-store";

let db: ReturnType<typeof createDirectDb>;
let ownerA: string;
let ownerB: string;
const sharedThreadId = `room:m075-sess-${Date.now().toString(36)}`;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  if (!process.env["DB_AGENT_DIRECT_CONNECTION"]?.trim()) {
    process.env["DB_AGENT_DIRECT_CONNECTION"] = resolveAgentDatabaseConnectionString();
  }
  const ts = Date.now().toString(36);
  const [ua] = await db
    .insert(users)
    .values({
      name: "m075-sess-a",
      email: `m075sess-a-${ts}@test.local`,
      handle: `m075sa${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  const [ub] = await db
    .insert(users)
    .values({
      name: "m075-sess-b",
      email: `m075sess-b-${ts}@test.local`,
      handle: `m075sb${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!ua || !ub) throw new Error("users");
  ownerA = ua.id;
  ownerB = ub.id;
});

afterAll(async () => {
  if (!db) return;
  try {
    await db
      .delete(sessions)
      .where(
        and(eq(sessions.threadId, sharedThreadId), inArray(sessions.ownerId, [ownerA, ownerB])),
      );
    await db.delete(users).where(inArray(users.id, [ownerA, ownerB]));
  } finally {
    await db.end();
  }
});

describe("ensureSession (M075 multi-owner)", () => {
  test("same thread_id with different owner_id yields two distinct session rows", async () => {
    const idA = await ensureSession({
      threadId: sharedThreadId,
      ownerId: ownerA,
      personaId: "owner",
    });
    const idB = await ensureSession({
      threadId: sharedThreadId,
      ownerId: ownerB,
      personaId: "owner",
    });
    expect(idA).not.toBe(idB);

    const rows = await db
      .select({ id: sessions.id, ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.threadId, sharedThreadId));
    const owners = new Set(rows.map((r) => r.ownerId));
    expect(owners.has(ownerA)).toBe(true);
    expect(owners.has(ownerB)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("second call for same owner+thread returns existing session id", async () => {
    const again = await ensureSession({
      threadId: sharedThreadId,
      ownerId: ownerA,
      personaId: "owner",
    });
    const first = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.threadId, sharedThreadId), eq(sessions.ownerId, ownerA)))
      .limit(1);
    expect(again).toBe(first[0]!.id);
  });
});
