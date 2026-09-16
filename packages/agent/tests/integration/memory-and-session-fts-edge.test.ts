/**
 * M067A — pgvector edge cases on `memories` and FTS on `session_messages`.
 * Requires live Postgres (no OpenAI — raw SQL only for vectors).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  sql,
  users,
  agents,
  sessions,
  sessionMessages,
  memories,
  isNotNull,
  and,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let agentId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(3);
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({ name: "m067a-fts", email: `m067a-fts-${ts}@test.local` })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  ownerId = u.id;
  const [a] = await db
    .insert(agents)
    .values({ handle: `m067a-ag-${ts}` })
    .returning({ id: agents.id });
  if (!a) throw new Error("agent");
  agentId = a.id;
});

afterAll(async () => {
  if (db && ownerId) {
    await db.execute(sql`DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE owner_id = ${ownerId})`);
    await db.delete(sessions).where(eq(sessions.ownerId, ownerId));
    // M127: memories.agent_id is gone — this suite's memory rows are
    // tagged by content prefix, so clean up by that instead of agent.
    await db.execute(sql`DELETE FROM memories WHERE content LIKE 'm067a-%'`);
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(users).where(eq(users.id, ownerId));
  }
  if (db) await db.end();
});

describe("memories embedding constraints (integration)", () => {
  test("wrong embedding dimension is rejected by Postgres", () => {
    // M127: no agent_id column. The dimension check is what must reject
    // here (a 3-dim vector against the 1536-dim column), so the insert
    // must otherwise be valid.
    return expect(
      Promise.resolve().then(() =>
        db.execute(sql`
        INSERT INTO memories (type, content, embedding)
        VALUES ('fact', 'm067a-baddim', '[1,2,3]'::vector)
      `),
      ),
    ).rejects.toThrow();
  });

  test("empty vector literal is rejected", () => {
    return expect(
      Promise.resolve().then(() =>
        db.execute(sql`
        INSERT INTO memories (type, content, embedding)
        VALUES ('fact', 'm067a-emptyvec', '[]'::vector)
      `),
      ),
    ).rejects.toThrow();
  });

  test("vector similarity query over empty embedding set returns no rows", async () => {
    // M127: memories.agent_id is gone, so scope by a unique content tag
    // (not a global table scan, which picks up real rows on a populated
    // instance). A memory inserted WITHOUT an embedding must never appear
    // in an embedding-filtered query.
    const tag = `m067a-noembed-${Date.now()}`;
    await db.insert(memories).values({ type: "fact", content: tag });
    const rows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.content, tag), isNotNull(memories.embedding)));
    expect(rows.length).toBe(0);
    await db.delete(memories).where(eq(memories.content, tag));
  });
});

describe("session_messages FTS (integration)", () => {
  test("to_tsvector english finds mixed-language and emoji content", async () => {
    const threadId = `fts-m067a-${Date.now()}`;
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId,
        ownerId,
        agentId,
        channel: "tui",
        title: "t",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("session");

    const phrases = [
      { role: "user", content: "Colorless green ideas sleep furiously" },
      { role: "user", content: "В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!" },
      { role: "user", content: "床前明月光 疑是地上霜" },
      { role: "user", content: "   \t\n  " },
      { role: "user", content: "🚀🌙✨ mission patch" },
    ];

    for (const p of phrases) {
      await db.insert(sessionMessages).values({
        sessionId: sess.id,
        role: p.role,
        content: p.content,
      });
    }

    const q1 = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(
        sql`${sessionMessages.contentSearch} @@ plainto_tsquery('english', 'green ideas')`,
      );
    expect(q1.some((r) => {
      if (r.content === null) throw new Error("seeded ordinary Message missing content");
      return r.content.includes("Colorless");
    })).toBe(true);

    const qCyr = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(sql`${sessionMessages.content} ILIKE '%цитрус%'`);
    expect(qCyr.length).toBe(1);

    const qEmoji = await db
      .select({ content: sessionMessages.content })
      .from(sessionMessages)
      .where(
        sql`${sessionMessages.contentSearch} @@ plainto_tsquery('english', 'patch')`,
      );
    expect(qEmoji.some((r) => {
      if (r.content === null) throw new Error("seeded ordinary Message missing content");
      return r.content.includes("mission");
    })).toBe(true);

    const whitespace = await db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.content, "   \t\n  "));
    expect(whitespace.length).toBe(1);

    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sess.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
  });
});
