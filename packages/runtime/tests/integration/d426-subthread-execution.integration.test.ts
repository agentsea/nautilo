/**
 * D426 Task 2.2 — real execution proof for a Subthread turn.
 *
 * The normal foreground executor is deliberately exercised with the same
 * deterministic ChatModel used by the graph plumbing suite. This makes the
 * assertion cover the production chain rather than a hand-wired persistence
 * call: DB transcript → anchored context → model → child transcript → root
 * summary event.
 */
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { __setStubModelForTests, ensureSession, setAgentEventSink } from "@nautilo/agent";
import {
  actors,
  __resetSharedDirectDbForTests,
  and,
  eq,
  jobs,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  collectEvents,
  getDirectDb,
  pollUntilComplete,
  waitForRunningForegroundJob,
} from "./helpers";
import { closeAgentDb, setupAgentTestEnv } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

const BASE = Date.parse("2026-07-22T09:00:00.000Z");

let ownerId = "";
let agentId = "";
let userActorId = "";
let agentActorId = "";
let parentRoomId = "";
let childRoomId = "";
let rootMessageId = 0;
let db: ReturnType<typeof getDirectDb>;
let jobManager: JobManager;

function renderedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

beforeAll(async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setAgentEventSink({ emit: (event) => eventBus.emit(event) });

  const env = await setupAgentTestEnv("d426-subthread-execution");
  ownerId = env.userId;
  agentId = env.agentId;
  // Some agent boot imports touch the runtime pool before setupTestDb has
  // selected test-cruft. Reopen this test-only singleton after setup so the
  // real JobManager + transcript reader share the scratch instance.
  await __resetSharedDirectDbForTests();
  db = getDirectDb();
  jobManager = new JobManager(fastCoalesce);
  // The DB history reader deliberately omits unresolved authors. Give this
  // fixture human a stable handle so its anchored parent/child rows become
  // labelled transcript lines, matching a provisioned Nautilo member.
  await db
    .update(users)
    .set({ handle: `d426human_${randomUUID().replace(/-/g, "").slice(0, 16)}` })
    .where(eq(users.id, ownerId));

  let [userActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerId), eq(actors.kind, "user")))
    .limit(1);
  let [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, ownerId), eq(actors.agentId, agentId)))
    .limit(1);
  if (!userActor) {
    [userActor] = await db
      .insert(actors)
      .values({ ownerId, kind: "user", displayName: "D426 human", trustState: "verified" })
      .returning({ id: actors.id });
  }
  if (!agentActor) {
    [agentActor] = await db
      .insert(actors)
      .values({ ownerId, kind: "agent", displayName: "D426 Genie", trustState: "verified", agentId })
      .returning({ id: actors.id });
  }
  if (!userActor || !agentActor) throw new Error("D426 fixture actors missing");
  userActorId = userActor.id;
  agentActorId = agentActor.id;

  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `d426-thread-${randomUUID()}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("D426 fixture namespace missing");

  parentRoomId = randomUUID();
  childRoomId = randomUUID();
  await db.insert(rooms).values({
    id: parentRoomId,
    ownerId,
    type: "private",
    label: "D426 parent",
    graphThreadId: `room:${parentRoomId}`,
    namespaceId: namespace.id,
    humanActorIds: [userActorId],
  });
  await db.insert(roomMembers).values([
    { roomId: parentRoomId, actorId: userActorId, roomRole: "admin" },
    { roomId: parentRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  const parentSessionId = await ensureSession({
    threadId: `d426-parent-seed-${randomUUID()}`,
    ownerId,
    personaId: "owner",
    roomId: parentRoomId,
  });
  const parentSeed = await db
    .insert(sessionMessages)
    .values([
      { sessionId: parentSessionId, role: "user", content: "PARENT BEFORE ANCHOR", createdAt: new Date(BASE) },
      { sessionId: parentSessionId, role: "user", content: "PARENT ANCHOR", createdAt: new Date(BASE + 1_000) },
      { sessionId: parentSessionId, role: "user", content: "PARENT AFTER ANCHOR MUST NOT LEAK", createdAt: new Date(BASE + 2_000) },
      { sessionId: parentSessionId, role: "user", content: "PARENT UNRELATED LATER CONTENT", createdAt: new Date(BASE + 3_000) },
    ])
    .returning({ id: sessionMessages.id, content: sessionMessages.content });
  rootMessageId = Number(parentSeed.find((row) => row.content === "PARENT ANCHOR")!.id);

  await db.insert(rooms).values({
    id: childRoomId,
    ownerId,
    type: "private",
    label: "D426 child",
    kind: "subthread",
    parentRoomId,
    threadRootMessageId: rootMessageId,
    graphThreadId: `room:${childRoomId}`,
    namespaceId: namespace.id,
    humanActorIds: [userActorId],
  });
  await db.insert(roomMembers).values([
    { roomId: childRoomId, actorId: userActorId, roomRole: "admin" },
    { roomId: childRoomId, actorId: agentActorId, roomRole: "member" },
  ]);
  const childSeedSessionId = await ensureSession({
    threadId: `d426-child-seed-${randomUUID()}`,
    ownerId,
    personaId: "owner",
    roomId: childRoomId,
  });
  await db.insert(sessionMessages).values({
    sessionId: childSeedSessionId,
    role: "user",
    content: "CHILD PRIOR CONTEXT",
    createdAt: new Date(BASE + 4_000),
    subthreadRoomId: childRoomId,
  });
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  setAgentEventSink(null);
  delete process.env["NAUTILO_TEST_MODE"];

  if (childRoomId) {
    const childSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, childRoomId));
    if (childSessions.length) await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, childSessions[0]!.id));
    if (childSessions.length > 1) {
      for (const session of childSessions.slice(1)) {
        await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, session.id));
      }
    }
    await db.delete(sessions).where(eq(sessions.roomId, childRoomId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, childRoomId));
    await db.delete(jobs).where(eq(jobs.roomId, childRoomId));
    await db.delete(rooms).where(eq(rooms.id, childRoomId));
  }
  if (parentRoomId) {
    const parentSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, parentRoomId));
    for (const session of parentSessions) await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, session.id));
    await db.delete(sessions).where(eq(sessions.roomId, parentRoomId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, parentRoomId));
    await db.delete(jobs).where(eq(jobs.roomId, parentRoomId));
    await db.delete(rooms).where(eq(rooms.id, parentRoomId));
  }
  await cleanupTestUserWithDestructivePermission(ownerId);
  await __resetSharedDirectDbForTests();
  await closeDirectDb();
  await closeAgentDb();
});

describe("D426 subthread execution", () => {
  test("real DB context reaches the selected Genie, whose output stays in the child and refreshes the root summary", async () => {
    const stub = createStubProvider({ responses: [{ type: "text", content: "D426 GENIE CHILD REPLY" }] });
    __setStubModelForTests(stub.asChatModel());
    const { events, cleanup } = collectEvents(eventBus);

    try {
      await jobManager.createForegroundJob(ownerId, ownerId, `room:${childRoomId}`, {
        message: "CHILD LIVE QUESTION",
        ownerId,
        agentId,
        threadId: `room:${childRoomId}`,
        roomId: childRoomId,
        subthreadRoomId: childRoomId,
        subthreadParentRoomId: parentRoomId,
        subthreadAnchorMessageId: rootMessageId,
        turnId: randomUUID(),
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 60_000);
      expect(job.status).toBe("completed");

      const modelInput = stub.invocations[0]?.messages.map((message) => renderedText(message.content)).join("\n") ?? "";
      expect(modelInput).toContain("PARENT BEFORE ANCHOR");
      expect(modelInput).toContain("PARENT ANCHOR");
      expect(modelInput).toContain("CHILD PRIOR CONTEXT");
      expect(modelInput).not.toContain("PARENT AFTER ANCHOR MUST NOT LEAK");
      expect(modelInput).not.toContain("PARENT UNRELATED LATER CONTENT");

      const childRows = await db
        .select({ role: sessionMessages.role, content: sessionMessages.content, subthreadRoomId: sessionMessages.subthreadRoomId })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, childRoomId));
      expect(childRows.some((row) => row.content === "D426 GENIE CHILD REPLY" && row.role === "assistant")).toBe(true);
      expect(childRows.every((row) => row.subthreadRoomId === childRoomId)).toBe(true);

      const parentRows = await db
        .select({ content: sessionMessages.content })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, parentRoomId));
      expect(parentRows.map((row) => row.content)).not.toContain("D426 GENIE CHILD REPLY");
      expect(parentRows.map((row) => row.content)).not.toContain("CHILD LIVE QUESTION");

      const [root] = await db
        .select({ replyCount: sessionMessages.replyCount, lastReplyAt: sessionMessages.lastReplyAt, summaryRevision: sessionMessages.summaryRevision })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, rootMessageId));
      expect(root).toMatchObject({ replyCount: 3, summaryRevision: 2 });
      expect(root!.lastReplyAt).toBeInstanceOf(Date);

      const summaries = events.filter((event) => event.type === "thread.summary.changed");
      const finalSummary = summaries[summaries.length - 1];
      expect(finalSummary).toMatchObject({
        laneKey: `room:${parentRoomId}`,
        anchorMessageId: rootMessageId,
        replyCount: 3,
        summaryRevision: 2,
      });
      expect(stub.remaining).toBe(0);
    } finally {
      cleanup();
    }
  });
});
