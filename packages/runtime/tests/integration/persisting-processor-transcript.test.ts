import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import { setupTestDb, createTestUser, cleanupTestUser, closeDirectDb } from "./helpers";
import { getTranscriptMessages, closeAgentDb } from "./agent-helpers";
import type { ServerEvent } from "@nautilo/types";
import { getBootstrapDefaultAgentId } from "@nautilo/trust";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createTestUser("persisting-proc");
  userId = u.userId;
});

afterAll(async () => {
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
});

describe("createPersistingProcessor (M070)", () => {
  test("persists assistant output from synthetic on_chain_end (resume-style path)", async () => {
    const threadId = `test-proc-persist-${randomUUID()}`;
    const laneKey = `lane:${threadId}`;
    const emitted: ServerEvent[] = [];
    const bus = { emit(e: ServerEvent) {
      emitted.push(e);
    } };

    const processor = createPersistingProcessor({
      threadId,
      ownerId: userId,
      laneKey,
      eventBus: bus,
      humanTurnId: "resume-style-turn",
      ...(getBootstrapDefaultAgentId()
        ? { agentId: getBootstrapDefaultAgentId() }
        : {}),
    });

    const reply = new AIMessage("Post-approval assistant reply for M070.");
    const ev = {
      event: "on_chain_end",
      name: "agent",
      data: { output: { messages: [reply] } },
    };

    await processor.process(ev);
    processor.flush();

    const rows = await getTranscriptMessages(threadId);
    const assistant = rows.find(
      (r) => r.role === "assistant" && r.content !== null && r.content.includes("Post-approval assistant reply"),
    );
    expect(assistant).toBeDefined();
  });
});
