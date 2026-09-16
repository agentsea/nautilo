/**
 * M135 P7 — room-scoped history search integration tests (Postgres + FTS).
 *
 * Asserts the likeliest bug first: results fan in across EVERY member session
 * of the room (per-(room,member) session fan-out), exclude other rooms, and
 * resolve each author (human handle / bot handle). The shared test bootstrap
 * defaults to the disposable `test-cruft` database.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
import { HumanMessage } from "@langchain/core/messages";
import {
  ensureSession,
  createNautiloGraph,
  createCheckpointSaver,
  defaultPostModelDeps,
} from "@nautilo/agent";
import { getPolicyResolver } from "@nautilo/trust";
import {
  searchRoomHistory,
  recentRoomMessages,
  roomMessagesSince,
  lastBotMessageTs,
  latestRoomMessageId,
  parentMessagesUpToAnchor,
  subthreadContextWindow,
  deterministicHistoryOwner,
  routeRoomMessage,
  runFloorManager,
  assembleCompositeContextBlock,
  type RoomMemberView,
  type ConductorContext,
} from "@nautilo/runtime";

let db: ReturnType<typeof createDirectDb>;
const ts = Date.now().toString(36);

let ownerA = "";
let ownerB = "";
let userActorA = "";
let userActorB = "";
let agentId = "";
let agentActorId = "";
let roomId = "";
let otherRoomId = "";
let sidA = "";
let sidB = "";
let sidBot = "";
const BASE = Date.parse("2026-06-01T10:00:00.000Z");
const BOT_LAST_TS = new Date(BASE + 2000);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [ua] = await db
    .insert(users)
    .values({ name: `m135-a-${ts}`, email: `m135a-${ts}@test.local`, handle: `m135a${ts.slice(-6)}` })
    .returning({ id: users.id });
  const [ub] = await db
    .insert(users)
    .values({ name: `m135-b-${ts}`, email: `m135b-${ts}@test.local`, handle: `m135b${ts.slice(-6)}` })
    .returning({ id: users.id });
  ownerA = ua!.id;
  ownerB = ub!.id;

  const [aa] = await db
    .insert(actors)
    .values({ ownerId: ownerA, displayName: "User A", kind: "user" })
    .returning({ id: actors.id });
  const [ab] = await db
    .insert(actors)
    .values({ ownerId: ownerB, displayName: "User B", kind: "user" })
    .returning({ id: actors.id });
  userActorA = aa!.id;
  userActorB = ab!.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: `nova${ts.slice(-6)}` })
    .returning({ id: agents.id });
  agentId = ag!.id;
  const [agActor] = await db
    .insert(actors)
    .values({ ownerId: ownerA, displayName: "Nova", kind: "agent", agentId })
    .returning({ id: actors.id });
  agentActorId = agActor!.id;

  const [ns1] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m135-ns1-${ts}` })
    .returning({ id: namespaces.id });
  const [ns2] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m135-ns2-${ts}` })
    .returning({ id: namespaces.id });

  roomId = randomUUID();
  otherRoomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId, ownerId: ownerA, type: "private", label: "m135 room",
    graphThreadId: `room:${roomId}`, namespaceId: ns1!.id,
    humanActorIds: [userActorA, userActorB],
  });
  await db.insert(rooms).values({
    id: otherRoomId, ownerId: ownerA, type: "private", label: "m135 other",
    graphThreadId: `room:${otherRoomId}`, namespaceId: ns2!.id,
    humanActorIds: [userActorA],
  });
  await db.insert(roomMembers).values({ roomId, actorId: userActorA, roomRole: "admin" });
  await db.insert(roomMembers).values({ roomId, actorId: userActorB, roomRole: "member" });
  await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
  await db.insert(roomMembers).values({ roomId: otherRoomId, actorId: userActorA, roomRole: "admin" });

  // Member A session: a user message about "deploy".
  sidA = await ensureSession({ threadId: `m135-a-${ts}`, ownerId: ownerA, personaId: "owner", roomId });
  // Member B session: ANOTHER member's user message in the SAME room (fan-out).
  sidB = await ensureSession({ threadId: `m135-b-${ts}`, ownerId: ownerB, personaId: "owner", roomId });
  // Per-bot session: assistant message authored by the agent.
  sidBot = await ensureSession({ threadId: `m135-bot-${ts}`, ownerId: ownerA, personaId: "owner", roomId, agentId });
  // Other-room session: must be EXCLUDED.
  const sidOther = await ensureSession({ threadId: `m135-other-${ts}`, ownerId: ownerA, personaId: "owner", roomId: otherRoomId });

  const base = BASE;
  await db.insert(sessionMessages).values({ sessionId: sidA, role: "user", content: "what is blocking the deploy pipeline", createdAt: new Date(base) });
  await db.insert(sessionMessages).values({ sessionId: sidB, role: "user", content: "the deploy keeps failing on auth", createdAt: new Date(base + 1000) });
  await db.insert(sessionMessages).values({ sessionId: sidBot, role: "assistant", content: "the deploy callback needs a staging fix", createdAt: new Date(base + 2000) });
  await db.insert(sessionMessages).values({ sessionId: sidOther, role: "user", content: "unrelated deploy chatter in another room", createdAt: new Date(base + 3000) });
});

afterAll(async () => {
  if (!db) return;
  try {
    for (const rid of [roomId, otherRoomId]) {
      const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
      const ids = sess.map((s) => s.id);
      if (ids.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
        await db.delete(sessions).where(inArray(sessions.id, ids));
      }
      await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
    }
    const nsIds: string[] = [];
    for (const rid of [roomId, otherRoomId]) {
      const r = await db.select({ namespaceId: rooms.namespaceId }).from(rooms).where(eq(rooms.id, rid)).limit(1);
      if (r[0]?.namespaceId) nsIds.push(r[0].namespaceId);
      await db.delete(rooms).where(eq(rooms.id, rid));
    }
    if (nsIds.length) await db.delete(namespaces).where(inArray(namespaces.id, nsIds));
    await db.delete(actors).where(inArray(actors.ownerId, [ownerA, ownerB]));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(users).where(inArray(users.id, [ownerA, ownerB]));
  } finally {
    await db.end();
  }
});

describe("searchRoomHistory (M135 P7)", () => {
  test("fans in across every member session of the room AND excludes other rooms", async () => {
    const hits = await searchRoomHistory(db, { roomId, query: "deploy", limit: 20 });
    const contents = hits.map((h) => h.snippet);
    // Member A, member B, and the bot session are all in the target room.
    expect(contents.some((c) => c.includes("blocking the deploy"))).toBe(true);
    expect(contents.some((c) => c.includes("keeps failing on auth"))).toBe(true);
    expect(contents.some((c) => c.includes("callback needs a staging"))).toBe(true);
    // Other-room message must NOT appear.
    expect(contents.some((c) => c.includes("another room"))).toBe(false);
  });

  test("resolves authors: human handle/displayName and bot handle/displayName", async () => {
    const hits = await searchRoomHistory(db, { roomId, query: "deploy", limit: 20 });
    const bot = hits.find((h) => h.snippet.includes("staging"));
    expect(bot?.authorActorId).toBe(agentActorId);
    expect(bot?.authorDisplayName).toBe("Nova");
    const fromB = hits.find((h) => h.snippet.includes("auth"));
    expect(fromB?.authorActorId).toBe(userActorB);
    expect(fromB?.authorDisplayName).toBe("User B");
  });

  test("deterministicHistoryOwner returns the single bot owner; multi-owner → null", async () => {
    const hits = await searchRoomHistory(db, { roomId, query: "deploy", limit: 20 });
    const candidates: RoomMemberView[] = [
      { kind: "agent", actorId: agentActorId, agentId, handle: "nova", agentResponseMode: "active" },
    ];
    // Only the bot is a candidate ⇒ single clear owner.
    expect(deterministicHistoryOwner(hits, [], candidates)).toBe(agentActorId);
  });

  test("recentRoomMessages returns oldest-first author-resolved lines", async () => {
    const recent = await recentRoomMessages(db, { roomId, limit: 10 });
    expect(recent.length).toBeGreaterThanOrEqual(3);
    // oldest-first
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i]!.ts.getTime()).toBeGreaterThanOrEqual(recent[i - 1]!.ts.getTime());
    }
    const handles = recent.map((r) => r.handle);
    expect(handles).toContain("nova" + ts.slice(-6));
  });

  test("latestRoomMessageId returns the newest message id in the room", async () => {
    const latest = await latestRoomMessageId(db, roomId);
    expect(latest).not.toBeNull();
    const recent = await recentRoomMessages(db, { roomId, limit: 50 });
    const maxId = Math.max(...recent.map((r) => r.messageId));
    expect(latest).toBe(maxId);
  });
});

describe("routeRoomMessage history-intent (D299 P2, real DB)", () => {
  test("history-intent triggers persisted room search and wakes single bot owner", async () => {
    const novaHandle = `nova${ts.slice(-6)}`;
    const decision = await routeRoomMessage(
      {
        loadActiveFoci: async () => [],
        searchRoomHistory: (rid, query, limit) =>
          searchRoomHistory(db, { roomId: rid, query, limit }),
      },
      {
        roomId,
        userActorId: userActorA,
        message: {
          content: "who was I talking with about the deploy?",
        },
        members: [
          { kind: "user", actorId: userActorA, handle: "alex" },
          {
            kind: "agent",
            actorId: agentActorId,
            agentId,
            handle: novaHandle,
            agentResponseMode: "mention_only",
          },
        ],
        now: new Date(),
      },
    );
    expect(decision.kind).toBe("wake");
    if (decision.kind === "wake") {
      expect(decision.botActorIds).toEqual([agentActorId]);
      expect(decision.source).toBe("inferred");
      expect(decision.writeFocus).toBe(true);
      expect(decision.reason).toBe("history-intent");
    }
  });

  test("history-intent search excludes other rooms", async () => {
    const hits = await searchRoomHistory(db, {
      roomId,
      query: "deploy",
      limit: 20,
    });
    expect(hits.some((h) => h.snippet.includes("another room"))).toBe(false);
  });
});

describe("Floor Manager request_search round-trip (P5 ↔ P7, real DB)", () => {
  test("request_search runs the real searchRoomHistory; hits feed the re-call; then wakes", async () => {
    const ctx: ConductorContext = {
      roomId,
      userActorId: userActorA,
      message: { content: "what was the deploy issue again?" },
      members: [
        { kind: "user", actorId: userActorA, handle: "user-a" },
        { kind: "agent", actorId: agentActorId, agentId, handle: `nova${ts.slice(-6)}`, agentResponseMode: "active" },
      ],
      now: new Date(),
    };
    let call = 0;
    let secondPrompt = "";
    const decision = await runFloorManager(
      ctx,
      {
        coldVolunteer: [
          { kind: "agent", actorId: agentActorId, agentId, handle: `nova${ts.slice(-6)}`, agentResponseMode: "active" },
        ],
        active: [],
        searchRoomHistory: (rid, query, limit) => searchRoomHistory(db, { roomId: rid, query, limit }),
      },
      {
        invokeModel: async (prompt) => {
          call += 1;
          if (call === 1) {
            return '{"action":"request_search","query":"deploy","limit":10,"reason":"need evidence"}';
          }
          secondPrompt = prompt;
          return `{"action":"wake","bot_handle":"@nova${ts.slice(-6)}","reason":"owns the deploy thread"}`;
        },
      },
    );
    expect(call).toBe(2);
    // Second prompt must contain real DB-sourced hit snippets.
    expect(secondPrompt).toContain("deploy");
    expect(decision.kind).toBe("wake");
    if (decision.kind === "wake") expect(decision.botActorIds).toEqual([agentActorId]);
  });
});

describe("P6 anchored context window — diff since the bot last spoke", () => {
  // Simulate an ALREADY-ACTIVE bot: after Nova's last reply (BOT_LAST_TS),
  // three humans post in parallel. The next time Nova is woken it must see
  // ALL of them — not a fixed recent slice.
  test("lastBotMessageTs returns the bot's last assistant message time", async () => {
    const tsBot = await lastBotMessageTs(db, { roomId, agentId });
    expect(tsBot).not.toBeNull();
    expect(tsBot!.getTime()).toBe(BOT_LAST_TS.getTime());
  });

  test("lastBotMessageTs is null for a bot that never spoke in the room", async () => {
    // A fresh agent with no messages here.
    const tsNone = await lastBotMessageTs(db, { roomId, agentId: randomUUID() });
    expect(tsNone).toBeNull();
  });

  test("roomMessagesSince(lastBotMessageTs) returns the FULL parallel burst, excludes pre-reply msgs and the bot's own reply", async () => {
    // Insert 3 messages from two humans AFTER the bot's last reply.
    await db.insert(sessionMessages).values({ sessionId: sidA, role: "user", content: "BURST one from A", createdAt: new Date(BASE + 4000) });
    await db.insert(sessionMessages).values({ sessionId: sidB, role: "user", content: "BURST two from B", createdAt: new Date(BASE + 5000) });
    await db.insert(sessionMessages).values({ sessionId: sidA, role: "user", content: "BURST three from A", createdAt: new Date(BASE + 6000) });

    const since = await lastBotMessageTs(db, { roomId, agentId });
    const msgs = await roomMessagesSince(db, { roomId, since, limit: 120 });
    const contents = msgs.map((m) => m.snippet);

    // All three post-reply messages present...
    expect(contents).toContain("BURST one from A");
    expect(contents).toContain("BURST two from B");
    expect(contents).toContain("BURST three from A");
    // ...and NOTHING from before/at the bot's last reply.
    expect(contents.some((c) => c.includes("blocking the deploy"))).toBe(false);
    expect(contents.some((c) => c.includes("keeps failing on auth"))).toBe(false);
    expect(contents.some((c) => c.includes("callback needs a staging"))).toBe(false);
    // Oldest-first ordering.
    expect(contents).toEqual(["BURST one from A", "BURST two from B", "BURST three from A"]);

    // And the assembled block carries every burst line, attributed by author.
    const block = assembleCompositeContextBlock({ messages: msgs, maxLines: 60, seenText: "" });
    expect(block).toContain("BURST one from A");
    expect(block).toContain("BURST three from A");
    expect(block).toContain("(@m135a" + ts.slice(-6) + ")");
    expect(block).toContain("(@m135b" + ts.slice(-6) + ")");
    // No manual cleanup: this describe runs after the FTS/owner tests, the
    // re-wake test below tolerates extra rows, and afterAll wipes the room.
  });
});

describe("M138 subthread window queries (parentMessagesUpToAnchor / subthreadContextWindow)", () => {
  // Self-contained parent room + subthread, reusing the top-level owner/agent
  // actors. Cleaned in this describe's afterAll (before the outer afterAll
  // deletes the shared actors/users).
  let parentRoomId = "";
  let subRoomId = "";
  let nsId = "";
  let parentSid = "";
  let subSid = "";
  let anchorId = 0;
  const M138_BASE = Date.parse("2026-06-02T09:00:00.000Z");

  beforeAll(async () => {
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: `m138-ns-${ts}` })
      .returning({ id: namespaces.id });
    nsId = ns!.id;

    parentRoomId = randomUUID();
    subRoomId = randomUUID();
    await db.insert(rooms).values({
      id: parentRoomId, ownerId: ownerA, type: "private", label: "m138 parent",
      graphThreadId: `room:${parentRoomId}`, namespaceId: nsId,
      humanActorIds: [userActorA],
    });
    await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: userActorA, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: parentRoomId, actorId: agentActorId, roomRole: "member" });

    // Parent transcript: 12 messages. We anchor the thread on message #5.
    // All human-authored (these tests target windowing/ordering, which is
    // role-agnostic; bot-author resolution is covered by the P6/P7 tests
    // above). Author rows must resolve, so they live in the human session.
    parentSid = await ensureSession({ threadId: `m138-parent-${ts}`, ownerId: ownerA, personaId: "owner", roomId: parentRoomId });
    const parentRows: { id: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const [row] = await db
        .insert(sessionMessages)
        .values({
          sessionId: parentSid,
          role: "user",
          content: `PARENT ${i}`,
          createdAt: new Date(M138_BASE + i * 1000),
        })
        .returning({ id: sessionMessages.id });
      parentRows.push(row!);
    }
    anchorId = parentRows[4]!.id; // "PARENT 4" — mid-conversation anchor.

    // Subthread room rooted at the anchor.
    await db.insert(rooms).values({
      id: subRoomId, ownerId: ownerA, type: "private", label: "m138 subthread",
      kind: "subthread", parentRoomId, threadRootMessageId: anchorId,
      graphThreadId: `room:${subRoomId}`, namespaceId: nsId,
      humanActorIds: [userActorA],
    });
    await db.insert(roomMembers).values({ roomId: subRoomId, actorId: userActorA, roomRole: "admin" });
    await db.insert(roomMembers).values({ roomId: subRoomId, actorId: agentActorId, roomRole: "member" });
    subSid = await ensureSession({ threadId: `m138-sub-${ts}`, ownerId: ownerA, personaId: "owner", roomId: subRoomId });
  });

  afterAll(async () => {
    // Tear down the subthread room (incl. its row) FIRST: while it exists and
    // points at the anchor, deleting the anchor (a parent message) trips the
    // FK SET NULL and violates `rooms_subthread_invariant`.
    for (const rid of [subRoomId, parentRoomId]) {
      const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
      const ids = sess.map((s) => s.id);
      if (ids.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
        await db.delete(sessions).where(inArray(sessions.id, ids));
      }
      await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
      await db.delete(rooms).where(eq(rooms.id, rid));
    }
    if (nsId) await db.delete(namespaces).where(eq(namespaces.id, nsId));
  });

  test("parentMessagesUpToAnchor returns ≤limit messages ending AT the anchor, oldest-first", async () => {
    const hits = await parentMessagesUpToAnchor(db, { parentRoomId, anchorMessageId: anchorId, limit: 10 });
    // Anchor is "PARENT 4" (the 5th message) → only 5 messages exist up to it.
    expect(hits.map((h) => h.snippet)).toEqual([
      "PARENT 0", "PARENT 1", "PARENT 2", "PARENT 3", "PARENT 4",
    ]);
    // Anchor is the LAST element.
    expect(hits[hits.length - 1]!.messageId).toBe(anchorId);
    // Later parent messages are excluded.
    expect(hits.some((h) => h.snippet === "PARENT 5")).toBe(false);
  });

  test("parentMessagesUpToAnchor caps at `limit`, keeping the anchor and its predecessors", async () => {
    // Anchor on the LAST parent message → limit truncates to the newest 10.
    const lastAnchor = (await recentRoomMessages(db, { roomId: parentRoomId, limit: 50 }))
      .filter((h) => h.snippet.startsWith("PARENT"))
      .map((h) => h.messageId)
      .sort((a, b) => a - b)
      .at(-1)!;
    const hits = await parentMessagesUpToAnchor(db, { parentRoomId, anchorMessageId: lastAnchor, limit: 10 });
    expect(hits.length).toBe(10);
    expect(hits[hits.length - 1]!.messageId).toBe(lastAnchor);
    expect(hits[0]!.snippet).toBe("PARENT 2"); // newest 10 of 12 → drops 0 and 1.
  });

  test("parentMessagesUpToAnchor returns [] for a missing/deleted anchor (no throw)", async () => {
    const hits = await parentMessagesUpToAnchor(db, { parentRoomId, anchorMessageId: 2147483600, limit: 10 });
    expect(hits).toEqual([]);
  });

  test("subthreadContextWindow returns ALL messages for a small thread (≤ threshold)", async () => {
    // Seed 3 subthread messages.
    for (let i = 0; i < 3; i++) {
      await db.insert(sessionMessages).values({
        sessionId: subSid, role: "user",
        content: `SUB-SMALL ${i}`, createdAt: new Date(M138_BASE + 100000 + i * 1000),
      });
    }
    const hits = await subthreadContextWindow(db, {
      subthreadRoomId: subRoomId, smallThreshold: 40, headCount: 5, tailCount: 50,
    });
    expect(hits.map((h) => h.snippet)).toEqual(["SUB-SMALL 0", "SUB-SMALL 1", "SUB-SMALL 2"]);
  });

  test("subthreadContextWindow returns first-head + last-tail for a long thread, deduped + ordered", async () => {
    // Reset the subthread session to a long thread of 60 messages.
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, subSid));
    for (let i = 0; i < 60; i++) {
      await db.insert(sessionMessages).values({
        sessionId: subSid, role: "user",
        content: `LONG ${i}`, createdAt: new Date(M138_BASE + 200000 + i * 1000),
      });
    }
    const hits = await subthreadContextWindow(db, {
      subthreadRoomId: subRoomId, smallThreshold: 40, headCount: 5, tailCount: 50,
    });
    const snippets = hits.map((h) => h.snippet);
    // head 5: LONG 0..4 ; tail 50: LONG 10..59 — no overlap → 55 total.
    expect(hits.length).toBe(55);
    expect(snippets.slice(0, 5)).toEqual(["LONG 0", "LONG 1", "LONG 2", "LONG 3", "LONG 4"]);
    expect(snippets[snippets.length - 1]).toBe("LONG 59");
    // The middle (LONG 5..9) is elided.
    expect(snippets).not.toContain("LONG 7");
    // No duplicate message ids; strictly ascending by ts.
    expect(new Set(hits.map((h) => h.messageId)).size).toBe(hits.length);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.ts.getTime()).toBeGreaterThanOrEqual(hits[i - 1]!.ts.getTime());
    }
  });
});

describe("P6 composite context — re-wake idempotency against a real checkpoint", () => {
  test("second wake's block excludes lines already injected into the bot's checkpoint", async () => {
    const recent = await recentRoomMessages(db, { roomId, limit: 20 });
    expect(recent.length).toBeGreaterThan(0);

    // Wake 1: nothing seen yet ⇒ full block.
    const block1 = assembleCompositeContextBlock({ messages: recent, maxLines: 20, seenText: "" });
    expect(block1).not.toBeNull();

    // Inject block1 as a TRANSIENT context message into a real per-(room,bot)
    // checkpoint (mirrors the executor), then read it back as the seen-set.
    const threadId = `m135-p6-${ts}`;
    const graph = createNautiloGraph(createCheckpointSaver(), getPolicyResolver(), defaultPostModelDeps);
    const cfg = { configurable: { thread_id: threadId } };
    await graph.updateState(cfg, {
      messages: [
        new HumanMessage({ content: `[ctx]\n${block1}`, additional_kwargs: { nautilo_transient_context: true } }),
        new HumanMessage("the actual question"),
      ],
    });
    const state = await graph.getState(cfg);
    const seenText = ((state?.values?.["messages"] ?? []) as Array<{ content?: unknown }>)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    // Wake 2: every recent line is now in the checkpoint ⇒ block is null.
    const block2 = assembleCompositeContextBlock({ messages: recent, maxLines: 20, seenText });
    expect(block2).toBeNull();
  });
});
