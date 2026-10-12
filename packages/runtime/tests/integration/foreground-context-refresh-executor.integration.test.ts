import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  __setStubModelForTests,
  setAgentEventSink,
  type ChatModel,
} from "@nautilo/agent";
import {
  actors,
  and,
  eq,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import { z } from "zod";
import { eventBus } from "../../src/event-bus";
import { JobManager } from "../../src/job-manager";
import {
  closeAgentDb,
  getTranscriptMessages,
  registerIntegrationTestTool,
  setupAgentTestEnv,
} from "./agent-helpers";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  collectEvents,
  createTestRoom,
  getDirectDb,
  pollUntilComplete,
  waitForRunningForegroundJob,
} from "./helpers";
import { createStubProvider } from "./helpers/stub-provider";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;
const progressToolName = "foreground_refresh_progress_fixture";

let userId = "";
let agentId = "";
let roomId = "";
let namespaceId = "";
let jobManager: JobManager;

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (block && typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    return "";
  }).join("");
}

beforeAll(async () => {
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setAgentEventSink({ emit: (event) => eventBus.emit(event) });

  const env = await setupAgentTestEnv("foreground-refresh-executor");
  registerIntegrationTestTool({
    name: progressToolName,
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: progressToolName,
      description: "Return the durable receipt for one deterministic progress step.",
      schema: z.object({ sequence: z.number().int().positive() }),
      func: async ({ sequence }) => `EXECUTOR RECEIPT ${sequence}`,
    }),
  });
  userId = env.userId;
  agentId = env.agentId;
  jobManager = new JobManager(fastCoalesce);

  ({ roomId } = await createTestRoom(userId));
  const db = getDirectDb();
  const [room] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room?.namespaceId) throw new Error("foreground refresh test Room has no namespace");
  namespaceId = room.namespaceId;

  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.agentId, agentId)))
    .limit(1);
  if (!agentActor) throw new Error("foreground refresh test Agent actor is missing");
  await db.insert(roomMembers).values({
    roomId,
    actorId: agentActor.id,
    roomRole: "member",
  });
});

afterAll(async () => {
  __setStubModelForTests(null);
  setAgentEventSink(null);
  delete process.env["NAUTILO_TEST_MODE"];
  if (userId) await cleanupTestUserWithDestructivePermission(userId);
  if (namespaceId) {
    await getDirectDb().delete(namespaces).where(eq(namespaces.id, namespaceId));
  }
  await closeDirectDb();
  await closeAgentDb();
});

describe("foreground context refresh executor composition", () => {
  test("rebuilds after visible text and a settled tool result in the same durable turn", async () => {
    const toolCallId = `refresh-tool-${randomUUID()}`;
    const visibleBeforeTool = `VISIBLE BEFORE REFRESH ${randomUUID()}`;
    const finalText = `FINAL AFTER REFRESH ${randomUUID()}`;
    const acceptedRequest = "Inspect the filesystem tools, then give me the final result.";
    const stub = createStubProvider({
      responses: [
        {
          type: "tool_call",
          name: "discover_tools",
          args: { query: "filesystem" },
          id: toolCallId,
        },
        { type: "text", content: finalText },
      ],
    });
    const stubModel = stub.asChatModel();
    const visibleToolModel: ChatModel = {
      invoke: async (messages, options) => {
        const response = await stubModel.invoke(messages, options) as AIMessage;
        if (!response.tool_calls?.length) return response;
        return new AIMessage({
          content: visibleBeforeTool,
          tool_calls: response.tool_calls,
        });
      },
      bindTools: () => visibleToolModel,
    };
    __setStubModelForTests(visibleToolModel);

    const threadId = `room:${roomId}`;
    const turnId = randomUUID();
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const runningJob = waitForRunningForegroundJob(jobManager);
      await jobManager.createForegroundJob(userId, userId, threadId, {
        message: acceptedRequest,
        ownerId: userId,
        causalHumanUserId: userId,
        agentId,
        actorRole: "owner",
        explicitlySelected: true,
        roomId,
        threadId,
        turnId,
      });
      const job = await runningJob;
      await pollUntilComplete(job, 60_000);

      expect(job.status).toBe("completed");
      expect(stub.remaining).toBe(0);
      expect(stub.invocations).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool.start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool.end")).toHaveLength(1);

      const secondInvocation = stub.invocations[1]!.messages;
      expect(secondInvocation.some((message) => ToolMessage.isInstance(message))).toBe(false);
      expect(secondInvocation.some((message) =>
        AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0,
      )).toBe(false);
      const rebuiltContents = secondInvocation.map(messageText);
      const acceptedRequestIndex = rebuiltContents.findIndex((content) =>
        content.includes(acceptedRequest),
      );
      const completedProgressIndex = rebuiltContents.findIndex((content) =>
        content.includes(visibleBeforeTool),
      );
      expect(acceptedRequestIndex).toBeGreaterThan(-1);
      expect(completedProgressIndex).toBeGreaterThan(acceptedRequestIndex);
      expect(rebuiltContents.join("\n")).toContain(
        "Completed progress in the current logical turn",
      );

      const transcript = await getTranscriptMessages(threadId);
      expect(transcript.filter((row) => row.role === "user")).toHaveLength(1);
      expect(transcript.filter((row) =>
        row.role === "assistant" && messageText(row).includes(visibleBeforeTool),
      )).toHaveLength(1);
      expect(transcript.filter((row) => row.role === "tool")).toHaveLength(1);
      expect(transcript.filter((row) =>
        row.role === "assistant" && messageText(row).includes(finalText),
      )).toHaveLength(1);

      const toolCalls = transcript.flatMap((row) => {
        if (!row.toolCalls) return [];
        return JSON.parse(row.toolCalls) as Array<{ id?: string; name?: string }>;
      });
      // The graph may normalize provider-supplied call ids before persistence.
      // The durable invariant here is one call to the requested tool, paired
      // with the one start/end lifecycle already asserted above.
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.name).toBe("discover_tools");

      const db = getDirectDb();
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.ownerId, userId), eq(sessions.threadId, threadId)))
        .limit(1);
      if (!session) throw new Error("foreground refresh test transcript session is missing");
      const durableRows = await db
        .select({
          role: sessionMessages.role,
          humanTurnId: sessionMessages.humanTurnId,
          metadata: sessionMessages.metadata,
        })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, session.id));
      expect(durableRows.find((row) => row.role === "user")?.humanTurnId).toBe(turnId);
      expect(durableRows.filter((row) => row.role !== "user")).toHaveLength(3);
      expect(durableRows.filter((row) => row.role !== "user").every((row) =>
        row.metadata?.["nautilo_foreground_execution_id"] === turnId,
      )).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("the final provider invocation retains a fitting turn across more than fifty refreshes", async () => {
    const rounds = 56;
    const originalSentinel = `ORIGINAL REQUEST ${randomUUID()}`;
    const finalSentinel = `FINAL PROVIDER CHECK ${randomUUID()}`;
    let finalProviderEvidence: {
      original: boolean;
      earliestProgress: boolean;
      latestReceipt: boolean;
    } | undefined;

    const receiptPattern = /EXECUTOR RECEIPT (\d+)/g;
    const visibleReceiptModel: ChatModel = {
      async invoke(messages) {
        const joined = messages.map(messageText).join("\n");
        const visibleReceipts = [...joined.matchAll(receiptPattern)]
          .map((match) => Number(match[1]));
        const latestVisibleReceipt = visibleReceipts.length === 0
          ? 0
          : Math.max(...visibleReceipts);

        if (latestVisibleReceipt >= rounds) {
          finalProviderEvidence = {
            original: joined.includes(originalSentinel),
            earliestProgress: joined.includes("COMPLETED PROGRESS 1"),
            latestReceipt: joined.includes(`EXECUTOR RECEIPT ${rounds}`),
          };
          return new AIMessage(finalSentinel);
        }

        const nextSequence = latestVisibleReceipt + 1;
        return new AIMessage({
          content: `COMPLETED PROGRESS ${nextSequence}`,
          tool_calls: [{
            id: `foreground-refresh-${nextSequence}-${randomUUID()}`,
            name: progressToolName,
            args: { sequence: nextSequence },
          }],
        });
      },
      bindTools: () => visibleReceiptModel,
    };
    __setStubModelForTests(visibleReceiptModel);

    const threadId = `room:${roomId}`;
    const runningJob = waitForRunningForegroundJob(jobManager);
    await jobManager.createForegroundJob(userId, userId, threadId, {
      message: `${originalSentinel}: complete every numbered progress step.`,
      ownerId: userId,
      causalHumanUserId: userId,
      agentId,
      actorRole: "owner",
      explicitlySelected: true,
      roomId,
      threadId,
      turnId: randomUUID(),
    });
    const job = await runningJob;
    await pollUntilComplete(job, 180_000);

    expect(job.status).toBe("completed");
    expect(finalProviderEvidence).toEqual({
      original: true,
      earliestProgress: true,
      latestReceipt: true,
    });
    const transcript = await getTranscriptMessages(threadId);
    const transcriptText = transcript.map(messageText).join("\n");
    expect(transcriptText).toContain(originalSentinel);
    expect(transcriptText).toContain("COMPLETED PROGRESS 1");
    expect(transcriptText).toContain(`EXECUTOR RECEIPT ${rounds}`);
    expect(transcriptText).toContain(finalSentinel);
  }, 200_000);
});
