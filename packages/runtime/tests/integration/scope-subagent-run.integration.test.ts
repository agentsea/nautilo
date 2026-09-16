/**
 * M084 — `runScopeSubagentUntilPause` with stub LLM + Postgres checkpoints /
 * session transcript metadata. No API keys when `NAUTILO_TEST_MODE=stub`.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq, sessionMessages, sessions, agents } from "@nautilo/db";
import {
  runScopeSubagentUntilPause,
  __setStubModelForTests,
  setAgentEventSink,
} from "@nautilo/agent";
import type { ScopeMemoryEnvelope } from "@nautilo/trust";
import { eventBus } from "../../src/event-bus";
import {
  cleanupTestUser,
  closeDirectDb,
  getDirectDb,
  setupTestDb,
} from "./helpers";
import {
  setupAgentTestEnv,
  closeAgentDb,
} from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  await closeDirectDb();
  await closeAgentDb();
});

describe("M084 — scope subagent run (stub LLM)", () => {
  let userId: string;
  let testAgentId: string;

  beforeAll(async () => {
    await setupTestDb();
    const env = await setupAgentTestEnv("scope-subagent-run");
    userId = env.userId;

    const db = getDirectDb();
    const [ag] = await db
      .insert(agents)
      .values({
        handle: `m084-subrun-${Date.now()}`,
      })
      .returning({ id: agents.id });
    if (!ag) throw new Error("Failed to insert test agent");
    testAgentId = ag.id;
  });

  afterAll(async () => {
    await cleanupTestUser(userId);
    await getDirectDb().delete(agents).where(eq(agents.id, testAgentId));
  });

  test("completes with final text and tags session_messages as subagent", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "SUBAGENT_STUB_LINE" }],
    });
    __setStubModelForTests(stub.asChatModel());

    const parentThreadId = `parent-m084-${Date.now()}`;
    const scopeId = randomUUID();
    const turnId = randomUUID();
    const scopeEnvelope: ScopeMemoryEnvelope = {
      memoryMode: "scope",
      ownerId: userId,
      actorId: userId,
      agentId: testAgentId,
      roomId: "",
      scopeId,
      toolPolicy: {},
    };

    const r = await runScopeSubagentUntilPause({
      parentThreadId,
      parentTurnId: turnId,
      parentOwnerId: userId,
      scopeId,
      brief: "Reply briefly.",
      toolWhitelist: [],
      subEnvelope: scopeEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: process.env["NAUTILO_MODEL"] ?? "",
      currentFolder: "",
      workspacePath: "",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "",
    });

    expect(r.status).toBe("completed");
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.threadId.startsWith(`subagent:${parentThreadId}`)).toBe(true);
    expect(r.finalText).toContain("full transcript for parent model");
    expect(r.finalText).toContain("[user]");
    expect(r.finalText).toContain("Reply briefly.");
    expect(r.finalText).toContain("[assistant]");
    expect(r.finalText).toContain("SUBAGENT_STUB_LINE");
    expect(r.finalResponseText).toBe("SUBAGENT_STUB_LINE");
    expect(stub.remaining).toBe(0);

    const db = getDirectDb();
    const metaRows = await db
      .select({
        transcriptOrigin: sessionMessages.transcriptOrigin,
        parentThreadId: sessionMessages.parentThreadId,
        scopeId: sessionMessages.scopeId,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(eq(sessions.threadId, r.threadId));

    expect(metaRows.length).toBeGreaterThan(0);
    for (const row of metaRows) {
      expect(row.transcriptOrigin).toBe("subagent");
      expect(row.parentThreadId).toBe(parentThreadId);
      expect(row.scopeId).toBe(scopeId);
    }
  });

  test("parent transcript includes block-shaped assistant content (multimodal-style)", async () => {
    const stub = createStubProvider({
      responses: [
        { type: "text", content: [{ type: "text", text: "BLOCK_ONLY_REPLY" }] },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const parentThreadId = `parent-m084-blocks-${Date.now()}`;
    const scopeId = randomUUID();
    const scopeEnvelope: ScopeMemoryEnvelope = {
      memoryMode: "scope",
      ownerId: userId,
      actorId: userId,
      agentId: testAgentId,
      roomId: "",
      scopeId,
      toolPolicy: {},
    };

    const r = await runScopeSubagentUntilPause({
      parentThreadId,
      parentTurnId: randomUUID(),
      parentOwnerId: userId,
      scopeId,
      brief: "Say hello.",
      toolWhitelist: [],
      subEnvelope: scopeEnvelope,
      actorRole: "owner",
      assistantName: "Genie",
      soulFile: "",
      modelId: process.env["NAUTILO_MODEL"] ?? "",
      currentFolder: "",
      workspacePath: "",
      subagentDepth: 1,
      subagentMaxDepth: 5,
      securityAuditClientMeta: null,
      roomRoster: [],
      roomId: "",
    });

    expect(r.status).toBe("completed");
    if (r.status !== "completed") throw new Error("expected completed");
    expect(r.finalText).toContain("[assistant]");
    expect(r.finalText).toContain("BLOCK_ONLY_REPLY");
    expect(r.finalResponseText).toBe("BLOCK_ONLY_REPLY");
    expect(stub.remaining).toBe(0);
  });
});
