import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  namespaces,
  roomEventRollups,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureSession } from "@nautilo/agent";
import type { RoomHistoryHit } from "../../src/conductor/history-search";
import { buildForegroundHistoryMessages } from "../../src/context/foreground-history";

const marker = randomUUID().replaceAll("-", "");
const executionId = `foreground-refresh-${marker}`;
const competingExecutionId = `foreground-refresh-competing-${marker}`;
const baseTime = Date.parse("2026-09-01T08:00:00.000Z");

let db: ReturnType<typeof createDirectDb>;
let ownerId = "";
let userActorId = "";
let otherOwnerId = "";
let otherUserActorId = "";
let agentId = "";
let agentActorId = "";
let otherAgentId = "";
let otherAgentActorId = "";
let namespaceId = "";
let roomId = "";
let humanSessionId = "";
let otherHumanSessionId = "";
let agentSessionId = "";
let otherAgentSessionId = "";
let firstAcceptedMessageId = 0;
let triggerMessageId = 0;
let acceptedReplyMessageId = 0;
let throughMessageIdInclusive = 0;
const currentPairCount = 51;
const acceptedReplyText = "YES INCLUDE THE COMMITTED FIXTURES";

function messageText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function insertMessage(input: {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  ordinal: number;
  fingerprint?: string;
  toolName?: string;
  foregroundExecutionId?: string;
}): Promise<number> {
  const [row] = await db.insert(sessionMessages).values({
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    createdAt: new Date(baseTime + input.ordinal * 1_000),
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    ...(input.foregroundExecutionId === undefined
      ? {}
      : {
          metadata: {
            nautilo_foreground_execution_id: input.foregroundExecutionId,
          },
        }),
  }).returning({ id: sessionMessages.id });
  if (!row) throw new Error("failed to insert foreground refresh fixture message");
  return Number(row.id);
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [user] = await db.insert(users).values({
    name: `Foreground refresh ${marker}`,
    email: `foreground-refresh-${marker}@integration.test`,
    handle: `foreground_refresh_${marker.slice(0, 12)}`,
  }).returning({ id: users.id });
  if (!user) throw new Error("failed to create foreground refresh user");
  ownerId = user.id;

  const [userActor] = await db.insert(actors).values({
    ownerId,
    displayName: "Foreground refresh human",
    kind: "user",
  }).returning({ id: actors.id });
  if (!userActor) throw new Error("failed to create foreground refresh user actor");
  userActorId = userActor.id;

  const [otherUser] = await db.insert(users).values({
    name: `Concurrent human ${marker}`,
    email: `foreground-refresh-other-${marker}@integration.test`,
    handle: `foreground_refresh_other_${marker.slice(0, 12)}`,
  }).returning({ id: users.id });
  if (!otherUser) throw new Error("failed to create concurrent foreground user");
  otherOwnerId = otherUser.id;
  const [otherUserActor] = await db.insert(actors).values({
    ownerId: otherOwnerId,
    displayName: "Concurrent foreground human",
    kind: "user",
  }).returning({ id: actors.id });
  if (!otherUserActor) throw new Error("failed to create concurrent foreground actor");
  otherUserActorId = otherUserActor.id;

  const [agent] = await db.insert(agents).values({
    handle: `foreground-refresh-${marker}`,
  }).returning({ id: agents.id });
  const [otherAgent] = await db.insert(agents).values({
    handle: `foreground-refresh-other-${marker}`,
  }).returning({ id: agents.id });
  if (!agent || !otherAgent) throw new Error("failed to create foreground refresh agents");
  agentId = agent.id;
  otherAgentId = otherAgent.id;

  const [agentActor] = await db.insert(actors).values({
    ownerId,
    displayName: "Foreground refresh agent",
    kind: "agent",
    agentId,
  }).returning({ id: actors.id });
  const [otherAgentActor] = await db.insert(actors).values({
    ownerId,
    displayName: "Other foreground agent",
    kind: "agent",
    agentId: otherAgentId,
  }).returning({ id: actors.id });
  if (!agentActor || !otherAgentActor) {
    throw new Error("failed to create foreground refresh agent actors");
  }
  agentActorId = agentActor.id;
  otherAgentActorId = otherAgentActor.id;

  const [namespace] = await db.insert(namespaces).values({
    scope: "private",
    label: `foreground-refresh-${marker}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("failed to create foreground refresh namespace");
  namespaceId = namespace.id;

  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "Foreground refresh integration",
    graphThreadId: `room:${roomId}`,
    namespaceId,
    humanActorIds: [userActorId, otherUserActorId],
    createdBy: userActorId,
  });
  await db.insert(roomMembers).values([
    { roomId, actorId: userActorId, roomRole: "admin" },
    { roomId, actorId: otherUserActorId, roomRole: "member" },
    { roomId, actorId: agentActorId, roomRole: "member" },
    { roomId, actorId: otherAgentActorId, roomRole: "member" },
  ]);

  humanSessionId = await ensureSession({
    threadId: `foreground-refresh-human:${marker}`,
    ownerId,
    personaId: "owner",
    roomId,
  });
  otherHumanSessionId = await ensureSession({
    threadId: `foreground-refresh-other-human:${marker}`,
    ownerId: otherOwnerId,
    personaId: "owner",
    roomId,
  });
  agentSessionId = await ensureSession({
    threadId: `foreground-refresh-agent:${marker}`,
    ownerId,
    personaId: "owner",
    roomId,
    agentId,
  });
  otherAgentSessionId = await ensureSession({
    threadId: `foreground-refresh-other-agent:${marker}`,
    ownerId,
    personaId: "owner",
    roomId,
    agentId: otherAgentId,
  });

  firstAcceptedMessageId = await insertMessage({
    sessionId: humanSessionId,
    role: "user",
    content: "FIRST ACCEPTED HUMAN MUST NOT BE COPIED",
    fingerprint: `fp:accepted-one:${marker}`,
    ordinal: 1,
  });
  triggerMessageId = await insertMessage({
    sessionId: humanSessionId,
    role: "user",
    content: "TRIGGER HUMAN MUST NOT BE COPIED",
    fingerprint: `fp:accepted-trigger:${marker}`,
    ordinal: 2,
  });
  await insertMessage({
    sessionId: agentSessionId,
    role: "assistant",
    content: "",
    ordinal: 3,
    foregroundExecutionId: executionId,
  });
  await insertMessage({
    sessionId: agentSessionId,
    role: "tool",
    toolName: "fixture_reader",
    content: `ACTIVE TOOL EVIDENCE ${"large-result ".repeat(2_000)}`,
    ordinal: 4,
    foregroundExecutionId: executionId,
  });
  await insertMessage({
    sessionId: agentSessionId,
    role: "assistant",
    content: "",
    ordinal: 5,
    foregroundExecutionId: competingExecutionId,
  });
  await insertMessage({
    sessionId: agentSessionId,
    role: "tool",
    toolName: "fixture_reader",
    content: "COMPETING SAME AGENT TOOL NARRATION",
    ordinal: 6,
    foregroundExecutionId: competingExecutionId,
  });
  await insertMessage({
    sessionId: agentSessionId,
    role: "assistant",
    content: "SHOULD I INCLUDE THE COMMITTED FIXTURES?",
    ordinal: 7,
    foregroundExecutionId: executionId,
  });
  acceptedReplyMessageId = await insertMessage({
    sessionId: otherHumanSessionId,
    role: "user",
    content: acceptedReplyText,
    fingerprint: `fp:accepted-reply:${marker}`,
    ordinal: 8,
  });
  await insertMessage({
    sessionId: otherAgentSessionId,
    role: "assistant",
    content: "OTHER AGENT OUTPUT NARRATION",
    ordinal: 9,
    foregroundExecutionId: executionId,
  });
  await insertMessage({
    sessionId: otherHumanSessionId,
    role: "user",
    content: "CONCURRENT OTHER HUMAN NARRATION",
    fingerprint: `fp:queued:${marker}`,
    ordinal: 10,
  });
  await insertMessage({
    sessionId: otherHumanSessionId,
    role: "user",
    content: "DUPLICATED ACCEPTED INPUT MUST NOT BE COPIED",
    fingerprint: `fp:accepted-one:${marker}`,
    ordinal: 11,
  });
  for (let index = 0; index < currentPairCount; index += 1) {
    await insertMessage({
      sessionId: agentSessionId,
      role: "assistant",
      content: `CURRENT PAIR CALL ${index}`,
      ordinal: 12 + index * 2,
      foregroundExecutionId: executionId,
    });
    throughMessageIdInclusive = await insertMessage({
      sessionId: agentSessionId,
      role: "tool",
      toolName: "fixture_reader",
      content: `CURRENT PAIR RESULT ${index}`,
      ordinal: 13 + index * 2,
      foregroundExecutionId: executionId,
    });
  }

  await db.insert(roomEventRollups).values({
    roomId,
    throughEventSequence: 1,
    content: "JOURNAL DECISION RETAINED DURING BOUNDED REFRESH",
    sourceEventCount: 1,
    modelId: "integration-fixture",
    compactorVersion: `foreground-refresh-${marker}`,
    createdAt: new Date(baseTime),
  });
});

afterAll(async () => {
  if (!db) return;
  try {
    const roomSessions = await db.select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, roomId));
    const sessionIds = roomSessions.map((session) => session.id);
    if (sessionIds.length > 0) {
      await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    await db.delete(actors).where(inArray(actors.id, [agentActorId, otherAgentActorId]));
    await db.delete(agents).where(inArray(agents.id, [agentId, otherAgentId]));
    await db.delete(actors).where(inArray(actors.id, [userActorId, otherUserActorId]));
    await db.delete(users).where(inArray(users.id, [ownerId, otherOwnerId]));
  } finally {
    await db.end();
  }
});

describe("foreground context refresh durable transcript", () => {
  test("keeps the complete current run and narrates concurrent visible Room rows", async () => {
    let authorizedHits: readonly RoomHistoryHit[] = [];
    const messages = await buildForegroundHistoryMessages({
      roomId,
      transcriptOwnerId: ownerId,
      agentId,
      modelId: "openai:gpt-5.5-2026-04-23",
      currentHumanText: "FIRST ACCEPTED HUMAN MUST NOT BE COPIED\nTRIGGER HUMAN MUST NOT BE COPIED",
      currentMessageId: triggerMessageId,
      excludeMessageIds: [firstAcceptedMessageId, triggerMessageId],
      throughMessageIdInclusive,
      foregroundExecutionId: executionId,
      maximumContextCharacters: 100_000,
      onAuthorizedHistory: (hits) => {
        authorizedHits = hits;
      },
    });

    const snippets = authorizedHits.map((hit) => hit.snippet);
    expect(snippets).toContain("ACTIVE TOOL EVIDENCE " + "large-result ".repeat(2_000));
    expect(snippets).toContain("COMPETING SAME AGENT TOOL NARRATION");
    expect(snippets).toContain("OTHER AGENT OUTPUT NARRATION");
    expect(snippets).toContain("CONCURRENT OTHER HUMAN NARRATION");
    expect(snippets).not.toContain("DUPLICATED ACCEPTED INPUT MUST NOT BE COPIED");
    expect(
      authorizedHits.find((hit) => hit.snippet === "OTHER AGENT OUTPUT NARRATION")
        ?.authorAgentId,
    ).toBe(otherAgentId);
    expect(
      authorizedHits.find((hit) => hit.snippet === "COMPETING SAME AGENT TOOL NARRATION")
        ?.authorAgentId,
    ).toBe(agentId);
    expect(
      authorizedHits.filter((hit) =>
        hit.foregroundExecutionId === executionId
        && hit.snippet.startsWith("CURRENT PAIR")
      ),
    ).toHaveLength(currentPairCount * 2);
    const rendered = messages.map((message) => messageText(message.content)).join("\n");
    expect(rendered).toContain("ACTIVE TOOL EVIDENCE");
    expect(rendered).toContain("COMPETING SAME AGENT TOOL NARRATION");
    expect(rendered).toContain("OTHER AGENT OUTPUT NARRATION");
    expect(rendered).toContain("CONCURRENT OTHER HUMAN NARRATION");
    expect(rendered).toContain("CURRENT PAIR RESULT 50");
    for (const surrounding of [
      "COMPETING SAME AGENT TOOL NARRATION",
      "OTHER AGENT OUTPUT NARRATION",
    ]) {
      const before = rendered.slice(0, rendered.indexOf(surrounding));
      expect(before.lastIndexOf("Surrounding Room activity"))
        .toBeGreaterThan(before.lastIndexOf("Completed progress"));
    }
    expect(rendered).not.toContain("FIRST ACCEPTED HUMAN MUST NOT BE COPIED");
    expect(rendered).not.toContain("TRIGGER HUMAN MUST NOT BE COPIED");
    expect(rendered).not.toContain("DUPLICATED ACCEPTED INPUT MUST NOT BE COPIED");
  });

  test("places a committed accepted reply exactly between durable question and progress", async () => {
    const reply = new HumanMessage(acceptedReplyText);
    const messages = await buildForegroundHistoryMessages({
      roomId,
      transcriptOwnerId: ownerId,
      agentId,
      modelId: "openai:gpt-5.5-2026-04-23",
      currentHumanText: `TRIGGER HUMAN MUST NOT BE COPIED\n${acceptedReplyText}`,
      currentMessageId: triggerMessageId,
      excludeMessageIds: [firstAcceptedMessageId, triggerMessageId],
      throughMessageIdInclusive,
      foregroundExecutionId: executionId,
      maximumContextCharacters: 100_000,
      acceptedHumanMessages: [{ messageId: acceptedReplyMessageId, message: reply }],
    });

    const replyIndex = messages.indexOf(reply);
    expect(replyIndex).toBeGreaterThan(0);
    expect(replyIndex).toBeLessThan(messages.length - 1);
    expect(messages.filter((message) => message === reply)).toHaveLength(1);
    const visible = messages.map((message) => messageText(message.content)).join("\n");
    expect(visible.match(new RegExp(acceptedReplyText, "g"))).toHaveLength(1);
    expect(
      messages.slice(0, replyIndex).map((message) => messageText(message.content)).join("\n"),
    ).toContain("SHOULD I INCLUDE THE COMMITTED FIXTURES?");
    expect(
      messages.slice(replyIndex + 1).map((message) => messageText(message.content)).join("\n"),
    ).toContain("CURRENT PAIR RESULT 50");
  });

  test("pins an earlier admitted reply before the newest suffix under pressure", async () => {
    const reply = new HumanMessage(acceptedReplyText);
    const messages = await buildForegroundHistoryMessages({
      roomId,
      transcriptOwnerId: ownerId,
      agentId,
      modelId: "openai:gpt-5.5-2026-04-23",
      currentHumanText: `TRIGGER HUMAN MUST NOT BE COPIED\n${acceptedReplyText}`,
      currentMessageId: triggerMessageId,
      excludeMessageIds: [firstAcceptedMessageId, triggerMessageId],
      throughMessageIdInclusive,
      foregroundExecutionId: executionId,
      maximumContextCharacters: 700,
      acceptedHumanMessages: [{ messageId: acceptedReplyMessageId, message: reply }],
    });

    expect(messages[0]).toBe(reply);
    const tail = messages.slice(1).map((message) => messageText(message.content)).join("\n");
    expect(tail).toContain("CURRENT PAIR RESULT 50");
    expect(tail).toContain("earlier narrative entries omitted");
    expect(tail).not.toContain(acceptedReplyText);
  });

  test("bounds a huge tool result while retaining the Room journal", async () => {
    const maximumContextCharacters = 800;
    const messages = await buildForegroundHistoryMessages({
      roomId,
      transcriptOwnerId: ownerId,
      agentId,
      modelId: "openai:gpt-5.5-2026-04-23",
      currentHumanText: "Continue the accepted request.",
      currentMessageId: triggerMessageId,
      excludeMessageIds: [firstAcceptedMessageId, triggerMessageId],
      throughMessageIdInclusive,
      foregroundExecutionId: executionId,
      maximumContextCharacters,
    });

    expect(messages).toHaveLength(1);
    const rendered = messageText(messages[0]!.content);
    expect(rendered.length).toBeLessThanOrEqual(maximumContextCharacters);
    expect(rendered).toContain("JOURNAL DECISION RETAINED DURING BOUNDED REFRESH");
    expect(rendered).not.toContain("large-result ".repeat(200));
  });
});
