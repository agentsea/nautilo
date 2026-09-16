/**
 * M168 — the merge gate (R9). Proves the three foreground room flows rebuild
 * their conversation history FROM the DB transcript with no context lost, on a
 * real Postgres. Mirrors the seeding harness in
 * `conductor-history-search.integration.test.ts`.
 *
 *   - **DM (Flow 1 / Phase C):** a multi-turn 1:1 room's full transcript
 *     (user/assistant/tool) is rebuilt by `allRoomMessages` + the deps factory.
 *   - **Group (Flow 2 / Phase D):** a 2-bot room — bot B's rebuilt history
 *     covers bot A's + the human's turns (per-bot fragmentation gone), and the
 *     triggering message is excluded (R5).
 *   - **Subthread (Flow 5 / Phase E):** parent-up-to-anchor window ++ subthread
 *     window, concatenated oldest→newest.
 *
 * The shared test bootstrap defaults to the disposable `test-cruft` database.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type BaseMessage } from "@langchain/core/messages";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  sessions,
  sessionMessages,
  namespaces,
  rooms,
  roomMembers,
  eq,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureSession } from "@nautilo/agent";
import {
  allRoomMessages,
  buildTranscriptContext,
  defaultBuildTranscriptContextDeps,
} from "@nautilo/runtime";

/**
 * R9 — content-coverage (NOT structural equality). Asserts the rendered block
 * contains the text of every expected transcript line. Representation differs
 * by design (structured checkpoint messages → narration).
 */
function assertCovers(block: string, expectedContents: string[]): void {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const haystack = norm(block);
  for (const c of expectedContents) {
    expect(haystack).toContain(norm(c));
  }
}

let db: ReturnType<typeof createDirectDb>;
const ts = Date.now().toString(36);

let owner = "";
let userActor = "";
let agentAId = "";
let agentAActor = "";
let agentBId = "";
let agentBActor = "";

// DM room ids.
let dmRoomId = "";
// Group room ids.
let groupRoomId = "";
let groupUserMsgId = 0;
// Subthread ids.
let parentRoomId = "";
let subRoomId = "";
let anchorId = 0;

const nsIds: string[] = [];

const BASE = Date.parse("2026-06-10T10:00:00.000Z");

async function freshNamespace(label: string): Promise<string> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `${label}-${ts}` })
    .returning({ id: namespaces.id });
  nsIds.push(ns!.id);
  return ns!.id;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [u] = await db
    .insert(users)
    .values({ name: `m168-${ts}`, email: `m168-${ts}@test.local`, handle: `m168${ts.slice(-6)}` })
    .returning({ id: users.id });
  owner = u!.id;
  const [ua] = await db
    .insert(actors)
    .values({ ownerId: owner, displayName: "Casey", kind: "user" })
    .returning({ id: actors.id });
  userActor = ua!.id;

  const [agA] = await db.insert(agents).values({ handle: `nova${ts.slice(-6)}` }).returning({ id: agents.id });
  agentAId = agA!.id;
  const [agAActor] = await db
    .insert(actors)
    .values({ ownerId: owner, displayName: "Nova", kind: "agent", agentId: agentAId })
    .returning({ id: actors.id });
  agentAActor = agAActor!.id;

  const [agB] = await db.insert(agents).values({ handle: `atlas${ts.slice(-6)}` }).returning({ id: agents.id });
  agentBId = agB!.id;
  const [agBActor] = await db
    .insert(actors)
    .values({ ownerId: owner, displayName: "Atlas", kind: "agent", agentId: agentBId })
    .returning({ id: actors.id });
  agentBActor = agBActor!.id;

  // ---- DM room (Flow 1): 1 human + 1 agent, multi-turn incl. a tool row. ----
  dmRoomId = randomUUID();
  const dmNs = await freshNamespace("m168-dm-ns");
  await db.insert(rooms).values({
    id: dmRoomId, ownerId: owner, type: "private", label: "m168 dm",
    graphThreadId: `room:${dmRoomId}`, namespaceId: dmNs, humanActorIds: [userActor],
  });
  await db.insert(roomMembers).values({ roomId: dmRoomId, actorId: userActor, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId: dmRoomId, actorId: agentAActor, roomRole: "member" });
  const dmHumanSid = await ensureSession({ threadId: `m168-dm-h-${ts}`, ownerId: owner, personaId: "owner", roomId: dmRoomId });
  const dmBotSid = await ensureSession({ threadId: `m168-dm-b-${ts}`, ownerId: owner, personaId: "owner", roomId: dmRoomId, agentId: agentAId });
  await db.insert(sessionMessages).values({ sessionId: dmHumanSid, role: "user", content: "DM what is the weather", createdAt: new Date(BASE) });
  await db.insert(sessionMessages).values({ sessionId: dmBotSid, role: "assistant", content: "DM let me check the forecast", createdAt: new Date(BASE + 1000) });
  await db.insert(sessionMessages).values({ sessionId: dmBotSid, role: "tool", content: "DM tool result: sunny 25C", createdAt: new Date(BASE + 1500) });
  await db.insert(sessionMessages).values({ sessionId: dmHumanSid, role: "user", content: "DM thanks and what about tomorrow", createdAt: new Date(BASE + 2000) });
  await db.insert(sessionMessages).values({ sessionId: dmBotSid, role: "assistant", content: "DM tomorrow looks rainy", createdAt: new Date(BASE + 3000) });

  // ---- Group room (Flow 2): 1 human + 2 agents. ----
  groupRoomId = randomUUID();
  const grpNs = await freshNamespace("m168-grp-ns");
  await db.insert(rooms).values({
    id: groupRoomId, ownerId: owner, type: "private", label: "m168 group",
    graphThreadId: `room:${groupRoomId}`, namespaceId: grpNs, humanActorIds: [userActor],
  });
  await db.insert(roomMembers).values({ roomId: groupRoomId, actorId: userActor, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId: groupRoomId, actorId: agentAActor, roomRole: "member" });
  await db.insert(roomMembers).values({ roomId: groupRoomId, actorId: agentBActor, roomRole: "member" });
  const grpHumanSid = await ensureSession({ threadId: `m168-grp-h-${ts}`, ownerId: owner, personaId: "owner", roomId: groupRoomId });
  const grpBotASid = await ensureSession({ threadId: `m168-grp-a-${ts}`, ownerId: owner, personaId: "owner", roomId: groupRoomId, agentId: agentAId });
  const grpBotBSid = await ensureSession({ threadId: `m168-grp-b-${ts}`, ownerId: owner, personaId: "owner", roomId: groupRoomId, agentId: agentBId });
  await db.insert(sessionMessages).values({ sessionId: grpHumanSid, role: "user", content: "GROUP hello team", createdAt: new Date(BASE + 10000) });
  await db.insert(sessionMessages).values({ sessionId: grpBotASid, role: "assistant", content: "GROUP Nova chimes in", createdAt: new Date(BASE + 11000) });
  await db.insert(sessionMessages).values({ sessionId: grpBotBSid, role: "assistant", content: "GROUP Atlas chimes in", createdAt: new Date(BASE + 12000) });
  const [grpU2] = await db.insert(sessionMessages)
    .values({ sessionId: grpHumanSid, role: "user", content: "GROUP the triggering message", createdAt: new Date(BASE + 13000) })
    .returning({ id: sessionMessages.id });
  groupUserMsgId = Number(grpU2!.id);

  // ---- Subthread (Flow 5): parent room + subthread rooted at an anchor. ----
  parentRoomId = randomUUID();
  subRoomId = randomUUID();
  const subNs = await freshNamespace("m168-sub-ns");
  await db.insert(rooms).values({
    id: parentRoomId, ownerId: owner, type: "private", label: "m168 parent",
    graphThreadId: `room:${parentRoomId}`, namespaceId: subNs, humanActorIds: [userActor],
  });
  await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: userActor, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: agentAActor, roomRole: "member" });
  const parentSid = await ensureSession({ threadId: `m168-parent-${ts}`, ownerId: owner, personaId: "owner", roomId: parentRoomId });
  const parentIds: number[] = [];
  for (let i = 0; i < 6; i++) {
    const [row] = await db.insert(sessionMessages)
      .values({ sessionId: parentSid, role: "user", content: `PARENT ${i}`, createdAt: new Date(BASE + 20000 + i * 1000) })
      .returning({ id: sessionMessages.id });
    parentIds.push(Number(row!.id));
  }
  anchorId = parentIds[2]!; // "PARENT 2" — mid-conversation anchor.
  await db.insert(rooms).values({
    id: subRoomId, ownerId: owner, type: "private", label: "m168 subthread",
    kind: "subthread", parentRoomId, threadRootMessageId: anchorId,
    graphThreadId: `room:${subRoomId}`, namespaceId: subNs, humanActorIds: [userActor],
  });
  await db.insert(roomMembers).values({ roomId: subRoomId, actorId: userActor, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId: subRoomId, actorId: agentAActor, roomRole: "member" });
  const subSid = await ensureSession({ threadId: `m168-sub-${ts}`, ownerId: owner, personaId: "owner", roomId: subRoomId });
  // The assistant reply lives in the per-bot (agent-backed) session so its
  // author resolves — same pattern as DM/group above and the M138 harness.
  const subBotSid = await ensureSession({ threadId: `m168-sub-b-${ts}`, ownerId: owner, personaId: "owner", roomId: subRoomId, agentId: agentAId });
  await db.insert(sessionMessages).values({ sessionId: subSid, role: "user", content: "SUB question one", createdAt: new Date(BASE + 30000) });
  await db.insert(sessionMessages).values({ sessionId: subBotSid, role: "assistant", content: "SUB answer one", createdAt: new Date(BASE + 31000) });
});

afterAll(async () => {
  if (!db) return;
  try {
    // Subthread room first (its FK to the parent anchor blocks anchor deletion).
    for (const rid of [subRoomId, parentRoomId, groupRoomId, dmRoomId]) {
      if (!rid) continue;
      const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
      const ids = sess.map((s) => s.id);
      if (ids.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
        await db.delete(sessions).where(inArray(sessions.id, ids));
      }
      await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
      await db.delete(rooms).where(eq(rooms.id, rid));
    }
    if (nsIds.length) await db.delete(namespaces).where(inArray(namespaces.id, nsIds));
    await db.delete(actors).where(eq(actors.ownerId, owner));
    await db.delete(agents).where(inArray(agents.id, [agentAId, agentBId]));
    await db.delete(users).where(eq(users.id, owner));
  } finally {
    await db.end();
  }
});

describe("M168 Flow 1 (DM) — full transcript rebuild", () => {
  test("allRoomMessages returns every row (user/assistant/tool), oldest-first", async () => {
    const hits = await allRoomMessages(db, { roomId: dmRoomId, userId: owner, agentId: agentAId });
    const snippets = hits.map((h) => h.snippet);
    expect(snippets).toEqual([
      "DM what is the weather",
      "DM let me check the forecast",
      "DM tool result: sunny 25C",
      "DM thanks and what about tomorrow",
      "DM tomorrow looks rainy",
    ]);
  });

  test("R9 — the built block covers every transcript row", async () => {
    const deps = defaultBuildTranscriptContextDeps(db);
    const out: BaseMessage[] = await buildTranscriptContext(
      { scope: { kind: "room", roomId: dmRoomId, ownerId: owner, agentId: agentAId }, maxLines: Number.MAX_SAFE_INTEGER },
      deps,
    );
    expect(out).toHaveLength(1);
    assertCovers(out[0]!.content as string, [
      "DM what is the weather",
      "DM let me check the forecast",
      "DM tool result: sunny 25C",
      "DM thanks and what about tomorrow",
      "DM tomorrow looks rainy",
    ]);
  });
});

describe("M168 Flow 2 (group) — one room transcript across bots, current msg excluded", () => {
  test("bot B's rebuilt history covers the human's AND bot A's turns (fragmentation gone)", async () => {
    const hits = await allRoomMessages(db, { roomId: groupRoomId, userId: owner, agentId: agentBId });
    const snippets = hits.map((h) => h.snippet);
    expect(snippets).toContain("GROUP hello team");
    expect(snippets).toContain("GROUP Nova chimes in"); // the OTHER bot's turn
    expect(snippets).toContain("GROUP Atlas chimes in");
  });

  test("R5 — excludeMessageId drops the triggering human row", async () => {
    const withMsg = await allRoomMessages(db, { roomId: groupRoomId, userId: owner, agentId: agentBId });
    expect(withMsg.map((h) => h.snippet)).toContain("GROUP the triggering message");

    const excluded = await allRoomMessages(db, {
      roomId: groupRoomId, userId: owner, agentId: agentBId, excludeMessageId: groupUserMsgId,
    });
    expect(excluded.map((h) => h.snippet)).not.toContain("GROUP the triggering message");
    // Everything else is still present.
    expect(excluded.map((h) => h.snippet)).toContain("GROUP Nova chimes in");
    expect(excluded.length).toBe(withMsg.length - 1);
  });
});

describe("M168 Flow 5 (subthread) — parent-anchor window ++ subthread window", () => {
  test("deps subthread scope concatenates parent-up-to-anchor + subthread, oldest-first", async () => {
    const deps = defaultBuildTranscriptContextDeps(db);
    const hits = await deps.readRoomTranscript({
      kind: "room",
      roomId: subRoomId,
      ownerId: owner,
      agentId: agentAId,
      subthread: { parentRoomId, anchorMessageId: anchorId },
    });
    const snippets = hits.map((h) => h.snippet);
    // Parent up to AND including the anchor (PARENT 0..2); PARENT 3+ excluded.
    expect(snippets.slice(0, 3)).toEqual(["PARENT 0", "PARENT 1", "PARENT 2"]);
    expect(snippets).not.toContain("PARENT 3");
    // Then the subthread window.
    expect(snippets).toContain("SUB question one");
    expect(snippets).toContain("SUB answer one");
  });

  test("R9 — the built subthread block covers the parent window + subthread", async () => {
    const deps = defaultBuildTranscriptContextDeps(db);
    const out = await buildTranscriptContext(
      {
        scope: {
          kind: "room", roomId: subRoomId, ownerId: owner, agentId: agentAId,
          subthread: { parentRoomId, anchorMessageId: anchorId },
        },
        maxLines: Number.MAX_SAFE_INTEGER,
      },
      deps,
    );
    expect(out).toHaveLength(1);
    assertCovers(out[0]!.content as string, ["PARENT 0", "PARENT 2", "SUB question one", "SUB answer one"]);
  });
});
