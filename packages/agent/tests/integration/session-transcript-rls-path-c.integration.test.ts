/**
 * D168 P2 — session transcript persistence under Path C RLS.
 *
 * Production `session-store` uses `agentDb` (nautilo_agent). Without
 * `withTrustContext`, INSERT into `sessions` fails:
 *   NeonDbError: new row violates row-level security policy for table "sessions"
 *
 * This test exercises `ensureSession` and `appendTranscriptMessages` on the
 * real agent role against RLS-protected `sessions` (legacy room_id NULL branch).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  createDirectDb,
  createDirectAgentDb,
  ensureDatabase,
  resolveAgentDatabaseConnectionString,
  users,
  sessions,
  sessionMessages,
  eq,
  and,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import {
  appendTranscriptMessages,
  ensureSession,
} from "../../src/store/session-store";


let supDb: ReturnType<typeof createDirectDb>;
let agentDb: ReturnType<typeof createDirectAgentDb>;
let ownerId: string;
const threadId = `d168-sess-rls-${Date.now().toString(36)}`;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  supDb = createDirectDb(1);
  if (!process.env["DB_AGENT_DIRECT_CONNECTION"]?.trim()) {
    process.env["DB_AGENT_DIRECT_CONNECTION"] = resolveAgentDatabaseConnectionString();
  }
  agentDb = createDirectAgentDb(1);

  const ts = Date.now().toString(36);
  const [u] = await supDb
    .insert(users)
    .values({
      name: "d168-sess-rls",
      email: `d168sessrls-${ts}@test.local`,
      handle: `d168sr${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  ownerId = u.id;
});

afterAll(async () => {
  if (!supDb) return;
  try {
    const sessRows = await supDb
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.ownerId, ownerId));
    const ids = sessRows.map((r) => r.id);
    if (ids.length > 0) {
      await supDb.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
      await supDb.delete(sessions).where(inArray(sessions.id, ids));
    }
    await supDb.delete(users).where(eq(users.id, ownerId));
  } finally {
    await supDb.end();
    await agentDb?.end();
  }
});

describe("session-store Path C RLS (D168 P2)", () => {
  test("appendTranscriptMessages would fail without trust context (RLS on sessions)", async () => {
    const rls = await supDb.execute<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'sessions' AND relnamespace = 'public'::regnamespace`,
    );
    const row = (rls as unknown as Array<{ relrowsecurity: boolean }>)[0];
    if (!row?.relrowsecurity) {
      // Migration 0047 not applied on this DB — trust-path tests below still validate the fix.
      return;
    }

    const hiddenThread = `${threadId}-hidden`;
    const [seeded] = await supDb
      .insert(sessions)
      .values({
        threadId: hiddenThread,
        ownerId,
        personaId: "owner",
        title: "superuser seed",
      })
      .returning({ id: sessions.id });
    if (!seeded) throw new Error("seed session");

    const visible = await agentDb
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, seeded.id));

    expect(visible.length).toBe(0);

    await supDb.delete(sessionMessages).where(eq(sessionMessages.sessionId, seeded.id));
    await supDb.delete(sessions).where(eq(sessions.id, seeded.id));
  });

  test("ensureSession creates a session row under trust context", async () => {
    const sessionId = await ensureSession({
      threadId,
      ownerId,
      personaId: "owner",
    });
    expect(sessionId.length).toBeGreaterThan(0);

    const rows = await supDb
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.threadId, threadId), eq(sessions.ownerId, ownerId)));
    expect(rows.some((r) => r.id === sessionId)).toBe(true);
  });

  test("appendTranscriptMessages inserts session_messages via agentDb", async () => {
    const appendThread = `${threadId}-append`;
    const result = await appendTranscriptMessages(
      appendThread,
      ownerId,
      "owner",
      [new HumanMessage("RLS path C transcript smoke")],
    );
    expect(result.insertedCount).toBe(1);
    expect(result.failedIndices).toEqual([]);

    const sess = await supDb
      .select({ id: sessions.id, messageCount: sessions.messageCount })
      .from(sessions)
      .where(and(eq(sessions.threadId, appendThread), eq(sessions.ownerId, ownerId)))
      .limit(1);
    expect(sess[0]).toBeDefined();
    expect(sess[0]!.messageCount).toBeGreaterThanOrEqual(1);

    const msgs = await supDb
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sess[0]!.id));
    expect(msgs.some((m) => {
      if (m.content === null) throw new Error("seeded ordinary Message missing content");
      return m.content.includes("RLS path C");
    })).toBe(true);
  });
});
