import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { setupTestDb, createTestUser, cleanupTestUser, closeDirectDb } from "./helpers";
import { getTranscriptMessages, closeAgentDb } from "./agent-helpers";
import { persistMessages } from "../../src/executors/persist-messages";
import type { ServerEvent } from "@nautilo/types";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createTestUser("session-dedup");
  userId = u.userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

describe("session_messages dedupe (M070 integration)", () => {
  test("concurrent persist of same human message same turn dedupes to one row", async () => {
    const threadId = `test-dedup-concurrent-${randomUUID()}`;
    const userMessage = new HumanMessage("hello genie");
    const fp1 = new Set<string>();
    const fp2 = new Set<string>();
    const emitted: ServerEvent[] = [];
    const bus = {
      emit(e: ServerEvent) {
        emitted.push(e);
      },
    };
    const turnId = "shared-turn-concurrent";

    await Promise.all([
      persistMessages(threadId, userId, [userMessage], fp1, {
        eventBus: bus,
        humanTurnId: turnId,
      }),
      persistMessages(threadId, userId, [userMessage], fp2, {
        eventBus: bus,
        humanTurnId: turnId,
      }),
    ]);

    const rows = await getTranscriptMessages(threadId);
    const userRows = rows.filter((r) => r.role === "user" && r.content === "hello genie");
    expect(userRows).toHaveLength(1);
    expect(emitted.filter((e) => e.type === "session.persistence_failed")).toHaveLength(0);
  });

  test("identical user text on two different turns persists two rows", async () => {
    const threadId = `test-dup-text-${Date.now()}`;
    const bus = { emit(_e: ServerEvent) {} };

    await persistMessages(threadId, userId, [new HumanMessage("ok")], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-a",
    });
    await persistMessages(threadId, userId, [new HumanMessage("ok")], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-b",
    });

    const rows = await getTranscriptMessages(threadId);
    const userRows = rows.filter((m) => {
      if (m.role !== "user") return false;
      if (m.content === null) throw new Error("seeded user content unavailable");
      return m.content.trim() === "ok";
    });
    expect(userRows).toHaveLength(2);
  });

  test("persist failure emits session.persistence_failed", async () => {
    const threadId = `test-persist-fail-${randomUUID()}`;
    const badOwner = randomUUID();
    const emitted: ServerEvent[] = [];
    const bus = { emit(e: ServerEvent) {
      emitted.push(e);
    } };

    await persistMessages(threadId, badOwner, [new AIMessage("x")], new Set(), { eventBus: bus });

    const fail = emitted.find((e) => e.type === "session.persistence_failed");
    expect(fail).toBeDefined();
    if (fail && fail.type === "session.persistence_failed") {
      expect(fail.threadId).toBe(threadId);
      expect(fail.sessionId).toBeNull();
      expect(fail.droppedCount).toBe(1);
      expect(fail.errorCode).toBe("fk_violation");
    }
  });
});
