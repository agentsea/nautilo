/**
 * D128 — shouldFireLLMTurn matrix (mode × room shape).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  eq,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { shouldFireLLMTurn, type AgentResponseMode } from "../../src/agent-response";
import { addRoomMember } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
const ts = Date.now().toString(36);
const AGENT_HANDLE = `g${ts.slice(-6)}`;

let ownerUserId: string;
let ownerActorId: string;
let peerUserId: string;
let peerActorId: string;
let agentId: string;
let agentActorId: string;

const roomIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(1);

  const [u1] = await db
    .insert(users)
    .values({
      name: "gate-owner",
      email: `gate-owner-${ts}@test.local`,
      handle: `go${ts.slice(-5)}`,
    })
    .returning({ id: users.id });
  if (!u1) throw new Error("owner user");
  ownerUserId = u1.id;

  const [u2] = await db
    .insert(users)
    .values({
      name: "gate-peer",
      email: `gate-peer-${ts}@test.local`,
      handle: `gp${ts.slice(-5)}`,
    })
    .returning({ id: users.id });
  if (!u2) throw new Error("peer user");
  peerUserId = u2.id;

  const [a1] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "Owner",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!a1) throw new Error("owner actor");
  ownerActorId = a1.id;

  const [a2] = await db
    .insert(actors)
    .values({
      ownerId: peerUserId,
      displayName: "Peer",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!a2) throw new Error("peer actor");
  peerActorId = a2.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: AGENT_HANDLE })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;

  const [aa] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "Gate Agent",
      trustState: "verified",
      kind: "agent",
      agentId: ag.id,
    })
    .returning({ id: actors.id });
  if (!aa) throw new Error("agent actor");
  agentActorId = aa.id;
});

afterAll(async () => {
  if (!db) return;
  for (const roomId of roomIds) {
    const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
    for (const s of sess) {
      await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, s.id));
    }
    await db.delete(sessions).where(eq(sessions.roomId, roomId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    const [rm] = await db.select({ namespaceId: rooms.namespaceId }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
    await db.delete(rooms).where(eq(rooms.id, roomId));
    if (rm?.namespaceId) await db.delete(namespaces).where(eq(namespaces.id, rm.namespaceId));
  }
  await db.delete(actors).where(eq(actors.id, agentActorId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(actors).where(eq(actors.id, peerActorId));
  await db.delete(actors).where(eq(actors.id, ownerActorId));
  await db.delete(users).where(eq(users.id, peerUserId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  await db.end();
});

async function mintRoom(
  label: string,
  memberActorIds: string[],
  agentMode: AgentResponseMode | null,
  opts?: { omitAgentModeColumn?: boolean },
): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${label}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");

  const roomId = crypto.randomUUID();
  const humanActorIds = memberActorIds.filter((id) => id !== agentActorId).sort();

  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds,
    kind: memberActorIds.length > 2 ? "group" : "private",
    createdBy: ownerActorId,
  });

  for (const actorId of memberActorIds) {
    const isAgent = actorId === agentActorId;
    if (isAgent && opts?.omitAgentModeColumn) {
      await db.insert(roomMembers).values({
        roomId,
        actorId,
        roomRole: "member",
      });
    } else {
      await db.insert(roomMembers).values({
        roomId,
        actorId,
        roomRole: actorId === ownerActorId ? "admin" : "member",
        ...(isAgent ? { agentResponseMode: agentMode } : {}),
      });
    }
  }

  roomIds.push(roomId);
  return roomId;
}

async function mintHumanOnlyRoom(label: string, humanActorIds: string[]): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `ns-${label}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");

  const roomId = crypto.randomUUID();
  const sortedHumans = [...humanActorIds].sort();

  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: sortedHumans,
    kind: humanActorIds.length > 1 ? "group" : "private",
    createdBy: ownerActorId,
  });

  for (const actorId of humanActorIds) {
    await db.insert(roomMembers).values({
      roomId,
      actorId,
      roomRole: actorId === ownerActorId ? "admin" : "member",
    });
  }

  roomIds.push(roomId);
  return roomId;
}

async function insertAgentReplyMessage(roomId: string): Promise<number> {
  const [sess] = await db
    .insert(sessions)
    .values({
      threadId: `room:${roomId}`,
      ownerId: ownerUserId,
      personaId: "owner",
      agentId,
      roomId,
      channel: "tui",
    })
    .returning({ id: sessions.id });
  if (!sess) throw new Error("session");

  const [msg] = await db
    .insert(sessionMessages)
    .values({ sessionId: sess.id, role: "assistant", content: "prior agent reply" })
    .returning({ id: sessionMessages.id });
  if (!msg) throw new Error("msg");
  return msg.id;
}

describe("shouldFireLLMTurn matrix", () => {
  test("active × 1:1 → fire (active)", async () => {
    const roomId = await mintRoom("active-1-1", [ownerActorId, agentActorId], "active");
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("active × group-no-mention → fire (active)", async () => {
    const roomId = await mintRoom(
      "active-grp",
      [ownerActorId, peerActorId, agentActorId],
      "active",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("active × group-with-mention → fire (active)", async () => {
    const roomId = await mintRoom(
      "active-grp-m",
      [ownerActorId, peerActorId, agentActorId],
      "active",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: `@${AGENT_HANDLE} help` },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("mention_only × 1:1 → fire (active carve-out)", async () => {
    const roomId = await mintRoom("mo-1-1", [ownerActorId, agentActorId], "mention_only");
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("mention_only × group-no-mention → suppressed", async () => {
    const roomId = await mintRoom(
      "mo-grp",
      [ownerActorId, peerActorId, agentActorId],
      "mention_only",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({
      fire: false,
      reason: "suppressed_no_mention",
      effectiveMode: "mention_only",
    });
  });

  test("mention_only × group-with-mention → fire (mention)", async () => {
    const roomId = await mintRoom(
      "mo-grp-m",
      [ownerActorId, peerActorId, agentActorId],
      "mention_only",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: `@${AGENT_HANDLE} vegan options?` },
    });
    expect(r).toEqual({ fire: true, reason: "mention", effectiveMode: "mention_only" });
  });

  test("observe × 1:1 → fire (active carve-out)", async () => {
    const roomId = await mintRoom("obs-1-1", [ownerActorId, agentActorId], "observe");
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("observe × group-no-mention → suppressed_by_mode", async () => {
    const roomId = await mintRoom(
      "obs-grp",
      [ownerActorId, peerActorId, agentActorId],
      "observe",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({
      fire: false,
      reason: "suppressed_by_mode",
      effectiveMode: "observe",
    });
  });

  test("observe × group-with-mention → suppressed_by_mode", async () => {
    const roomId = await mintRoom(
      "obs-grp-m",
      [ownerActorId, peerActorId, agentActorId],
      "observe",
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: `@${AGENT_HANDLE} hello` },
    });
    expect(r).toEqual({
      fire: false,
      reason: "suppressed_by_mode",
      effectiveMode: "observe",
    });
  });

  test("reply_to_agent on mention_only group without @mention", async () => {
    const roomId = await mintRoom(
      "mo-reply",
      [ownerActorId, peerActorId, agentActorId],
      "mention_only",
    );
    const parentId = await insertAgentReplyMessage(roomId);
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "follow-up", replyToMessageId: parentId },
    });
    expect(r).toEqual({ fire: true, reason: "reply_to_agent", effectiveMode: "mention_only" });
  });

  test("NULL agent_response_mode × group-no-mention → suppressed (composition default)", async () => {
    const roomId = await mintRoom(
      "null-mode",
      [ownerActorId, peerActorId, agentActorId],
      null,
      { omitAgentModeColumn: true },
    );
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r.effectiveMode).not.toBe("active");
    expect(r).toEqual({
      fire: false,
      reason: "suppressed_no_mention",
      effectiveMode: "mention_only",
    });
  });

  test("NULL agent_response_mode × 1:1 → fire (DM force-active)", async () => {
    const roomId = await mintRoom("null-dm", [ownerActorId, agentActorId], null, {
      omitAgentModeColumn: true,
    });
    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r).toEqual({ fire: true, reason: "active", effectiveMode: "active" });
  });

  test("addRoomMember stamps mention_only when humanCount>=2", async () => {
    const roomId = await mintHumanOnlyRoom("add-agent-grp", [ownerActorId, peerActorId]);
    await addRoomMember(roomId, { agentId }, "member");

    const [row] = await db
      .select({ mode: roomMembers.agentResponseMode })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)))
      .limit(1);
    expect(row?.mode).toBe("mention_only");

    const r = await shouldFireLLMTurn(db, {
      roomId,
      agentActorId,
      agentHandle: AGENT_HANDLE,
      message: { content: "dinner?" },
    });
    expect(r.effectiveMode).not.toBe("active");
    expect(r).toEqual({
      fire: false,
      reason: "suppressed_no_mention",
      effectiveMode: "mention_only",
    });
  });

  test("addRoomMember stamps active when humanCount===1", async () => {
    const roomId = await mintHumanOnlyRoom("add-agent-dm", [ownerActorId]);
    await addRoomMember(roomId, { agentId }, "member");

    const [row] = await db
      .select({ mode: roomMembers.agentResponseMode })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)))
      .limit(1);
    expect(row?.mode).toBe("active");
  });
});
