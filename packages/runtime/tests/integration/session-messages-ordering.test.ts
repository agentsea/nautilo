import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getSessionMessages } from "@nautilo/agent";
import { sessions, sessionMessages } from "@nautilo/db";
import {
  setupTestDb,
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
} from "./helpers";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createTestUser("session-msg-order");
  userId = u.userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("getSessionMessages ordering", () => {
  test("identical created_at orders by ascending id", async () => {
    const db = getDirectDb();
    const threadId = `order-test-${Date.now()}`;
    const [session] = await db
      .insert(sessions)
      .values({
        threadId,
        ownerId: userId,
        personaId: "owner",
        title: "ordering",
      })
      .returning({ id: sessions.id });
    expect(session).toBeTruthy();
    const sessionId = session!.id;

    const sameTime = new Date("2024-06-15T14:30:00.000Z");
    await db.insert(sessionMessages).values([
      {
        sessionId,
        role: "user",
        content: "second-row-lower-id",
        fingerprint: `fp-o1-${threadId}`,
        createdAt: sameTime,
      },
      {
        sessionId,
        role: "user",
        content: "first-row-higher-id",
        fingerprint: `fp-o2-${threadId}`,
        createdAt: sameTime,
      },
    ]);

    const rows = await getSessionMessages(sessionId, 50, 0);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.content)).toEqual([
      "second-row-lower-id",
      "first-row-higher-id",
    ]);
  });
});
