import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import {
  actors, createDirectDb, ensureDatabase, eq, namespaces, roomMembers, rooms,
  sessionMessages, sessions, sql, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import * as trust from "@nautilo/trust";
import * as universal from "../../src/providers/universal";
import * as modelRoles from "../../src/config/model-role-resolution";
import { ensureSession, searchSessions } from "../../src/store/session-store";
import { getRoomMessagesAround, queryRoomMessageContentIndex, searchChats, searchRoomMessages } from "../../src/store/room-message-search";

const suffix = randomUUID().slice(0, 8);
const payload = Array.from({ length: 65_000 }, (_, i) =>
  createHash("md5").update(String(i)).digest("hex")).join(" ");
const body = `Startneedle Under_score running the CAFÉ /example/reports/Q4.xlsx /example/decoy/Q4x ${payload.slice(0, payload.length / 2)} Middleneedle ${payload.slice(payload.length / 2)} Tailneedle`;
let db: ReturnType<typeof createDirectDb>;
const fixtures: { ownerId: string; actorId: string; roomId: string; namespaceId: string; sessionId: string }[] = [];
let messageId: number;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  for (const index of [0, 1]) {
    const [user] = await db.insert(users).values({ name: `search-${suffix}-${index}`,
      handle: `s${suffix}${index}` }).returning();
    const ownerId = user!.id;
    const [actor] = await db.insert(actors).values({ ownerId, displayName: "Search fixture", kind: "user" }).returning();
    const [namespace] = await db.insert(namespaces).values({ scope: "private", label: "Search fixture" }).returning();
    const roomId = randomUUID();
    await db.insert(rooms).values({ id: roomId, ownerId, type: "private", label: "Search fixture",
      graphThreadId: `room:${roomId}`, namespaceId: namespace!.id, humanActorIds: [actor!.id] });
    await db.insert(roomMembers).values({ roomId, actorId: actor!.id, roomRole: "admin" });
    const sessionId = await ensureSession({ threadId: `search-${suffix}-${index}`, ownerId, personaId: "owner", roomId });
    fixtures.push({ ownerId, actorId: actor!.id, roomId, namespaceId: namespace!.id, sessionId });
    const [message] = await db.insert(sessionMessages).values({ sessionId, role: "user", content: body,
      createdAt: new Date("2025-01-01T00:00:00Z") }).returning({ id: sessionMessages.id });
    if (index === 0) messageId = message!.id;
  }
});

afterAll(async () => {
  for (const f of fixtures) {
    const ownedSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.ownerId, f.ownerId));
    for (const session of ownedSessions) await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, session.id));
    await db.delete(sessions).where(eq(sessions.ownerId, f.ownerId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, f.roomId));
    await db.delete(rooms).where(eq(rooms.id, f.roomId));
    await db.delete(namespaces).where(eq(namespaces.id, f.namespaceId));
    await db.delete(actors).where(eq(actors.id, f.actorId));
    await db.delete(users).where(eq(users.id, f.ownerId));
  }
  await db?.end();
});

describe("literal overflow search through existing readers", () => {
  test("distant terms match once, whole/prefix/path/case rules work, and complete source reloads", async () => {
    const f = fixtures[0]!;
    for (const [query, mode, ignoreCase, count] of [
      ["startneedle middleneedle tailneedle", "whole", true, 1],
      ["middleneedle", "whole", true, 1],
      ["under_score", "whole", true, 1], ["under_sco", "prefix", true, 1],
      ["under_scorer", "whole", true, 0], ["nder_score", "whole", true, 0],
      ["Under_score", "whole", false, 1], ["under_score", "whole", false, 0],
      ["Under_sco", "prefix", false, 1], ["under_sco", "prefix", false, 0],
      ["tailneed", "whole", true, 0], ["tailneed", "prefix", true, 1],
      ["/example/reports/Q4.", "prefix", false, 1],
      ["/example/decoy/Q4.", "prefix", true, 0],
      ["startneedle|absentneedle", "whole", true, 0],
      ["Startneedle", "whole", false, 1], ["startneedle", "whole", false, 0],
      ["café", "whole", true, 1], ["the", "whole", true, 1],
      ["runs", "whole", true, 0], ["running", "whole", true, 1],
    ] as const) {
      const result = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query, mode, ignoreCase });
      if ("validationError" in result) throw new Error(result.validationError.message);
      expect(result.hits).toHaveLength(count);
      if (count) expect(result.hits[0]!.messageId).toBe(messageId);
    }
    const page = await getRoomMessagesAround({ ownerId: f.ownerId, roomId: f.roomId, messageId });
    const restored = page?.messages.find((message) => Number(message.id) === messageId);
    if (typeof restored?.content !== "string") throw new Error("Full source was not returned");
    expect(createHash("sha256").update(restored.content).digest("hex"))
      .toBe(createHash("sha256").update(body).digest("hex"));
  });

  test("ordinary indexed messages retain underscore matching with case controls", async () => {
    const f = fixtures[0]!;
    const [ordinary] = await db.insert(sessionMessages).values({ sessionId: f.sessionId,
      role: "user", content: "Indexed_token" }).returning({ id: sessionMessages.id });
    for (const [query, mode, ignoreCase, count] of [
      ["indexed_token", "whole", true, 1], ["indexed_tok", "prefix", true, 1],
      ["Indexed_token", "whole", false, 1], ["indexed_token", "whole", false, 0],
      ["Indexed_tok", "prefix", false, 1], ["indexed_tok", "prefix", false, 0],
      ["indexed_tokens", "whole", false, 0],
    ] as const) {
      const result = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query, mode, ignoreCase });
      if ("validationError" in result) throw new Error(result.validationError.message);
      expect(result.hits).toHaveLength(count);
      if (count) expect(result.hits[0]!.messageId).toBe(ordinary!.id);
    }
  });

  test("cross-chat and Conductor readers preserve scope, visibility and paging", async () => {
    const f = fixtures[0]!;
    const outsider = fixtures[1]!;
    const result = await searchChats({ ownerId: f.ownerId, viewerActorId: f.actorId,
      query: "startneedle tailneedle", mode: "whole", limit: 1 });
    if ("validationError" in result) throw new Error(result.validationError.message);
    expect(result.messages.map((hit) => hit.messageId)).toEqual([messageId]);
    const next = await searchChats({ ownerId: f.ownerId, viewerActorId: f.actorId,
      query: "tailneedle", mode: "whole", cursor: result.nextOlderMessageCursor, asOf: result.messageAsOf });
    if ("validationError" in next) throw new Error(next.validationError.message);
    expect(next.messages).toHaveLength(0);
    const denied = await searchRoomMessages({ ownerId: outsider.ownerId, roomId: f.roomId, query: "tailneedle", mode: "whole" });
    if ("validationError" in denied) throw new Error(denied.validationError.message);
    expect(denied.hits).toHaveLength(0);
    const sharedArgs = { roomId: f.roomId, query: "startneedle tailneedle", mode: "whole" as const, limit: 5 };
    const shared = await queryRoomMessageContentIndex(db, { ...sharedArgs, visibilityPredicate: sql`AND sm.role = 'user'` });
    expect(shared.ok && shared.rows.length).toBe(1);
    const hidden = await queryRoomMessageContentIndex(db, { ...sharedArgs, visibilityPredicate: sql`AND sm.role = 'assistant'` });
    expect(hidden.ok && hidden.rows.length).toBe(0);
  });

  test("session search passes only a match-centered excerpt to its summarizer and retains source coordinates", async () => {
    const f = fixtures[0]!;
    const prompts: string[] = [];
    const modelRole = spyOn(modelRoles, "resolveModelRole").mockReturnValue("synthetic-session-summary");
    const provider = spyOn(universal, "createUniversalModel").mockImplementation(async () => ({
      invoke: async (messages: { content: unknown }[]) => {
        prompts.push(String(messages[0]!.content));
        return new AIMessage("Synthetic summary");
      },
    }) as Awaited<ReturnType<typeof universal.createUniversalModel>>);
    const admission = spyOn(trust, "assertCanUseServerProviderCredentials").mockResolvedValue(undefined);
    try {
      const results = await searchSessions({ ownerId: f.ownerId, humanUserId: f.ownerId, personaId: "owner", query: "tailneedle" });
      expect(results).toHaveLength(1);
      expect(results[0]!.sessionId).toBe(f.sessionId);
      expect(results[0]!.excerptSources).toEqual([{ roomId: f.roomId, messageId }]);
      expect(prompts[0]).toContain("Tailneedle");
      expect(prompts[0]).toContain("Partial excerpt");
      expect(prompts[0]!.length).toBeLessThan(1000);
      expect(admission).toHaveBeenCalledWith(f.ownerId, "session_search");
      expect(await searchSessions({ ownerId: f.ownerId, humanUserId: f.ownerId, personaId: "other", query: "tailneedle" })).toHaveLength(0);
      expect(await searchSessions({ ownerId: f.ownerId, humanUserId: f.ownerId, personaId: "owner", query: "tailneedle", excludeThreadId: `search-${suffix}-0` })).toHaveLength(0);
    } finally {
      provider.mockRestore();
      admission.mockRestore();
      modelRole.mockRestore();
    }
  });

  test("a newer nonmatching duplicate suppresses an old overflow match; edits and deletes remove stale hits", async () => {
    const f = fixtures[0]!;
    await db.update(sessionMessages).set({ fingerprint: "search-duplicate" }).where(eq(sessionMessages.id, messageId));
    const otherSession = await ensureSession({ threadId: `duplicate-${suffix}`, ownerId: f.ownerId, personaId: "owner", roomId: f.roomId });
    await db.insert(sessionMessages).values({ sessionId: otherSession, role: "user", content: "replacement text",
      fingerprint: "search-duplicate", createdAt: new Date("2025-01-02T00:00:00Z") });
    const suppressed = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query: "tailneedle", mode: "whole" });
    expect("hits" in suppressed && suppressed.hits.length).toBe(0);
    await db.update(sessionMessages).set({ content: "ordinary newneedle", fingerprint: null }).where(eq(sessionMessages.id, messageId));
    const old = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query: "tailneedle", mode: "whole" });
    expect("hits" in old && old.hits.length).toBe(0);
    const edited = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query: "newneedle", mode: "whole" });
    expect("hits" in edited && edited.hits.length).toBe(1);
    await db.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
    const deleted = await searchRoomMessages({ ownerId: f.ownerId, roomId: f.roomId, query: "newneedle", mode: "whole" });
    expect("hits" in deleted && deleted.hits.length).toBe(0);
  });
});
