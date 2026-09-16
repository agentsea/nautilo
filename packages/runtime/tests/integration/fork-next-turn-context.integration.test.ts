/**
 * M170 R8 — a fork's reply reaches the parent's next turn via the DB
 * transcript rebuild (M168), NOT a checkpoint splice (the splice is deleted).
 *
 * Persists a prior main turn pair (u1/a1) + a fork's reply pair (u2/a2) to the
 * parent ROOM transcript, then rebuilds foreground history exactly as the next
 * main turn would (`resolveForegroundHistoryMessages`) and asserts it contains
 * the fork's contribution in order. Real Postgres; no checkpoint, no splice.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { users, agents, actors, eq } from "@nautilo/db";
import { resolveForegroundHistoryMessages } from "../../src/executors/langgraph-executor";
import { persistMessages } from "../../src/executors/persist-messages";
import { eventBus } from "../../src/event-bus";
import {
  createTestUser,
  cleanupTestUser,
  closeDirectDb,
  setupTestDb,
  createTestRoom,
  getDirectDb,
} from "./helpers";

let userId: string;
let agentId: string;
const tag = Date.now().toString(36).slice(-6);

beforeAll(async () => {
  await setupTestDb();
  userId = (await createTestUser("fork-next-turn-context")).userId;
  const db = getDirectDb();
  // `allRoomMessages` → `mapHistoryRows` drops any row whose author has no
  // resolvable handle, so the rebuilt transcript is only non-empty once the
  // human + agent carry handles AND the assistant rows live in an agent-backed
  // session (the production shape). Seed both. `cleanupTestUser` tears down the
  // user-owned agent + agent-actor.
  await db.update(users).set({ handle: `forku${tag}` }).where(eq(users.id, userId));
  const [ag] = await db.insert(agents).values({ handle: `forkbot${tag}` }).returning({ id: agents.id });
  agentId = ag!.id;
  await db
    .insert(actors)
    .values({ ownerId: userId, kind: "agent", displayName: "ForkBot", agentId });
});
afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
});

describe("M170 fork reply survives into the parent's next turn via DB rebuild", () => {
  test("rebuilt foreground history includes the fork's u2/a2 (no splice, no checkpoint)", async () => {
    const { roomId } = await createTestRoom(userId);
    const parentThreadId = `room:${roomId}`;

    // Prior main turn pair (what a main turn would have persisted). `agentId`
    // routes the pair into the agent-backed session so the assistant rows
    // resolve their author on rebuild (matches the production persist shape).
    await persistMessages(
      parentThreadId,
      userId,
      [new HumanMessage("u1"), new AIMessage("a1")],
      new Set(),
      { roomId, agentId, humanTurnId: randomUUID(), eventBus },
    );

    // The fork persists its own reply pair to the SAME parent room transcript.
    await persistMessages(
      parentThreadId,
      userId,
      [new HumanMessage("u2"), new AIMessage("a2")],
      new Set(),
      { roomId, agentId, humanTurnId: randomUUID(), eventBus },
    );

    // Rebuild history exactly as the next main turn (and the fork) now does.
    const history: BaseMessage[] = await resolveForegroundHistoryMessages({
      turnKind: "fresh",
      roomId,
      transcriptOwnerId: userId,
      agentId,
    });

    // M168 rebuilds the room history as ONE composite labelled-transcript
    // message (newest last), not one message per row — assert on its content.
    expect(history).toHaveLength(1);
    const block = history[0]!.content as string;
    // The fork's contribution is visible to the next turn.
    expect(block).toContain("u2");
    expect(block).toContain("a2");
    // The prior turn is still there too, and u1 precedes u2 (transcript order).
    expect(block).toContain("u1");
    expect(block).toContain("a1");
    expect(block.indexOf("u1")).toBeLessThan(block.indexOf("u2"));
  });
});
