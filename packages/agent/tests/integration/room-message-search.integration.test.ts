import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  namespaces,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { getRoomMessagesAround, searchChats, searchRoomMessages } from "../../src/store/room-message-search";
import { ensureSession } from "../../src/store/session-store";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

let db: ReturnType<typeof createDirectDb>;
let ownerId: string;
let ownerActorId: string;
let roomId: string;
const suffix = Date.now().toString(36);

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const [user] = await db.insert(users).values({
    name: `d430-${suffix}`,
    email: `d430-${suffix}@test.local`,
    handle: `d430${suffix.slice(-6)}`,
  }).returning({ id: users.id });
  if (!user) throw new Error("user");
  ownerId = user.id;
  const [actor] = await db.insert(actors).values({ ownerId, displayName: "D430", kind: "user" }).returning({ id: actors.id });
  const [namespace] = await db.insert(namespaces).values({ scope: "private", label: `d430-${suffix}` }).returning({ id: namespaces.id });
  if (!actor || !namespace) throw new Error("room prerequisites");
  ownerActorId = actor.id;
  roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId,
    type: "private",
    label: "D430 search",
    graphThreadId: `room:${roomId}`,
    namespaceId: namespace.id,
    humanActorIds: [actor.id],
  });
  await db.insert(roomMembers).values({ roomId, actorId: actor.id, roomRole: "admin" });
});

async function clearRoom(): Promise<void> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, roomId));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
}

afterEach(clearRoom);

afterAll(async () => {
  await clearRoom();
  const namespace = await db.select({ namespaceId: rooms.namespaceId }).from(rooms).where(eq(rooms.id, roomId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
  await db.delete(rooms).where(eq(rooms.id, roomId));
  if (namespace[0]?.namespaceId) await db.delete(namespaces).where(eq(namespaces.id, namespace[0].namespaceId));
  await db.delete(actors).where(eq(actors.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.end();
});

describe("D430 Room message store readers", () => {
  test("whole and prefix candidate queries select the existing content-search GIN index", async () => {
    const sessionId = await ensureSession({ threadId: `room-d430-plan-${suffix}`, ownerId, personaId: "owner", roomId });
    await db.insert(sessionMessages).values({ sessionId, role: "user", content: "launching indexed campaign", createdAt: new Date("2025-02-01T09:00:00.000Z") });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
      await tx.execute(sql`SET LOCAL join_collapse_limit = 1`);
      await tx.execute(sql`SET LOCAL from_collapse_limit = 1`);
      await tx.execute(sql`SET LOCAL enable_nestloop = off`);
      await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
      const candidate = (tsquery: ReturnType<typeof sql>) => sql`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT sm.id
        FROM session_messages sm
        INNER JOIN sessions s ON s.id = sm.session_id
        INNER JOIN room_members rm ON rm.room_id = s.room_id
        INNER JOIN actors member_actor ON member_actor.id = rm.actor_id
        WHERE s.room_id = ${roomId}
          AND member_actor.kind = 'user'
          AND member_actor.owner_id = s.owner_id
          AND s.thread_id NOT LIKE 'subagent:%'
          AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task'
          AND sm.tool_name IS DISTINCT FROM 'react'
          AND sm.content_search @@ ${tsquery}
      `;
      const whole = await tx.execute<{ "QUERY PLAN": unknown }>(candidate(sql`plainto_tsquery('english', 'launch')`));
      const prefix = await tx.execute<{ "QUERY PLAN": unknown }>(candidate(sql`to_tsquery('english', '''launch'':*')`));
      expect(JSON.stringify(whole[0]?.["QUERY PLAN"])).toContain("idx_session_messages_content_search");
      expect(JSON.stringify(prefix[0]?.["QUERY PLAN"])).toContain("idx_session_messages_content_search");
    });
  });

  test("searches visible deduped content with stable newest-first continuation", async () => {
    const primary = await ensureSession({ threadId: `room-d430-${suffix}`, ownerId, personaId: "owner", roomId });
    const peer = await ensureSession({ threadId: `room-d430-peer-${suffix}`, ownerId, personaId: "owner", roomId });
    const subagent = await ensureSession({ threadId: `subagent:room-d430-${suffix}`, ownerId, personaId: "owner", roomId });
    const t = (minute: number) => new Date(`2025-02-01T10:${String(minute).padStart(2, "0")}:00.000Z`);
    await db.insert(sessionMessages).values([
      { sessionId: primary, role: "assistant", content: "", toolCalls: '[{"id":"call-1"}]', createdAt: t(0) },
      { sessionId: primary, role: "tool", content: "needle tool result", toolName: "lookup", createdAt: t(1) },
      { sessionId: primary, role: "tool", content: "needle react hidden", toolName: "react", createdAt: t(2) },
      { sessionId: primary, role: "tool", content: "needle legacy visible", toolName: null, createdAt: t(3) },
      { sessionId: primary, role: "user", content: "needle task hidden", metadata: { originatedBy: "task" }, createdAt: t(4) },
      { sessionId: subagent, role: "user", content: "needle subagent hidden", createdAt: t(5) },
      { sessionId: primary, role: "user", content: "needle duplicate", fingerprint: "d430-fp", createdAt: t(6) },
      { sessionId: peer, role: "user", content: "newer canonical content", fingerprint: "d430-fp", createdAt: t(7) },
      { sessionId: primary, role: "user", content: "needle latest", fingerprint: "d430-latest", createdAt: t(8) },
    ]);

    const first = await searchRoomMessages({ ownerId, roomId, query: "needle", mode: "whole", limit: 2 });
    if ("validationError" in first) throw new Error(first.validationError.message);
    expect(first.hits.map((hit) => hit.snippet)).toEqual(["needle latest", "needle legacy visible"]);
    expect(first.hasMoreOlder).toBe(true);
    expect(first.asOf).toEqual({ createdAt: first.hits[0]!.createdAt, messageId: first.hits[0]!.messageId });

    const second = await searchRoomMessages({
      ownerId,
      roomId,
      query: "needle",
      mode: "whole",
      limit: 2,
      asOf: first.asOf,
      cursor: first.nextOlderCursor,
    });
    if ("validationError" in second) throw new Error(second.validationError.message);
    expect(second.hits.map((hit) => hit.snippet)).toEqual(["needle tool result"]);
    expect(second.hasMoreOlder).toBe(false);
    expect([...first.hits, ...second.hits].map((hit) => hit.snippet)).not.toContain("needle react hidden");
    expect([...first.hits, ...second.hits].map((hit) => hit.snippet)).not.toContain("needle task hidden");
    expect([...first.hits, ...second.hits].map((hit) => hit.snippet)).not.toContain("needle subagent hidden");
    expect([...first.hits, ...second.hits].map((hit) => hit.snippet)).not.toContain("needle duplicate");
  });

  test("includes a best-effort preceding assistant tool-call companion around a tool target", async () => {
    const sessionId = await ensureSession({ threadId: `room-d430-around-${suffix}`, ownerId, personaId: "owner", roomId });
    const [assistant, tool] = await db.insert(sessionMessages).values([
      { sessionId, role: "assistant", content: "", toolCalls: '[{"id":"call-unknown"}]', createdAt: new Date("2025-02-02T10:00:00.000Z") },
      { sessionId, role: "tool", content: "target result", toolName: "lookup", createdAt: new Date("2025-02-02T10:01:00.000Z") },
    ]).returning({ id: sessionMessages.id });
    if (!assistant || !tool) throw new Error("messages");

    const page = await getRoomMessagesAround({ ownerId, roomId, messageId: tool.id, limit: 3 });
    expect(page?.messages.map((message) => message.id)).toEqual([String(assistant.id), String(tool.id)]);
    expect(page?.includedToolCallCompanion).toBe(true);
    expect(page?.messages).toHaveLength(2);
  });

  test("uses nearest newer rows and reports gaps outside final companion bounds", async () => {
    const sessionId = await ensureSession({ threadId: `room-d430-gaps-${suffix}`, ownerId, personaId: "owner", roomId });
    const rows = await db.insert(sessionMessages).values([
      { sessionId, role: "user", content: "older than companion", createdAt: new Date("2025-02-03T09:59:00.000Z") },
      { sessionId, role: "assistant", content: "", toolCalls: '[{"id":"call-2"}]', createdAt: new Date("2025-02-03T10:00:00.000Z") },
      { sessionId, role: "tool", content: "target", toolName: "lookup", createdAt: new Date("2025-02-03T10:01:00.000Z") },
      { sessionId, role: "user", content: "nearest newer", createdAt: new Date("2025-02-03T10:02:00.000Z") },
      { sessionId, role: "user", content: "farther newer", createdAt: new Date("2025-02-03T10:03:00.000Z") },
    ]).returning({ id: sessionMessages.id });
    const target = rows[2];
    if (!target) throw new Error("target");

    const page = await getRoomMessagesAround({ ownerId, roomId, messageId: target.id, limit: 3 });
    expect(page?.messages.map((message) => message.content)).toEqual(["", "target", "nearest newer"]);
    expect(page?.includedToolCallCompanion).toBe(true);
    expect(page?.hasOlder).toBe(true);
    expect(page?.hasNewer).toBe(true);
  });
});

describe("D470 set-wise Chats search", () => {
  test("many-Room / 500-message query shapes select the existing label and FTS indexes", async () => {
    const planRoomIds: string[] = [];
    const planNamespaceIds: string[] = [];
    let planSessionId = "";
    try {
      for (let index = 0; index < 24; index += 1) {
        const [namespace] = await db.insert(namespaces).values({
          scope: "private",
          label: `d470-plan-${suffix}-${index}`,
        }).returning({ id: namespaces.id });
        if (!namespace) throw new Error("D470 plan namespace");
        planNamespaceIds.push(namespace.id);
        const id = randomUUID();
        await db.insert(rooms).values({
          id,
          ownerId,
          type: "private",
          label: `Needle plan room ${index}`,
          graphThreadId: `room:${id}`,
          namespaceId: namespace.id,
          humanActorIds: [ownerActorId],
          createdBy: ownerActorId,
        });
        await db.insert(roomMembers).values({ roomId: id, actorId: ownerActorId, roomRole: "admin" });
        planRoomIds.push(id);
      }
      planSessionId = await ensureSession({
        threadId: `room-d470-plan-${suffix}`,
        ownerId,
        personaId: "owner",
        roomId: planRoomIds[0]!,
      });
      await db.insert(sessionMessages).values(
        Array.from({ length: 501 }, (_, index) => ({
          sessionId: planSessionId,
          role: "user",
          content: `needle production-shaped message ${index}`,
          createdAt: new Date(1740787200000 + index * 1000),
        })),
      );

      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_indexscan = off`);
        await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
        await tx.execute(sql`SET LOCAL join_collapse_limit = 1`);
        await tx.execute(sql`SET LOCAL from_collapse_limit = 1`);
        await tx.execute(sql`SET LOCAL enable_nestloop = off`);
        await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
        const messagePlan = await tx.execute<{ "QUERY PLAN": unknown }>(sql`
          EXPLAIN (FORMAT JSON, COSTS OFF)
          WITH authorized_room_ids AS MATERIALIZED (
            SELECT viewer_member.room_id
            FROM room_members viewer_member
            INNER JOIN actors viewer_actor ON viewer_actor.id = viewer_member.actor_id
            WHERE viewer_member.actor_id = ${ownerActorId}
              AND viewer_actor.kind = 'user'
              AND viewer_actor.owner_id = ${ownerId}
          )
          SELECT sm.id
          FROM session_messages sm
          INNER JOIN sessions s ON s.id = sm.session_id
          INNER JOIN authorized_room_ids authorized ON authorized.room_id = s.room_id
          INNER JOIN rooms r ON r.id = s.room_id
          INNER JOIN room_members source_member ON source_member.room_id = s.room_id
          INNER JOIN actors source_actor ON source_actor.id = source_member.actor_id
          WHERE r.archived_at IS NULL
            AND r.kind NOT IN ('task', 'access')
            AND source_actor.kind = 'user'
            AND source_actor.owner_id = s.owner_id
            AND s.thread_id NOT LIKE 'subagent:%'
            AND (sm.metadata->>'originatedBy') IS DISTINCT FROM 'task'
            AND sm.tool_name IS DISTINCT FROM 'react'
            AND sm.content_search @@ plainto_tsquery('english', 'needle')
          ORDER BY sm.created_at DESC, sm.id DESC
          LIMIT 51
        `);
        const conversationPlan = await tx.execute<{ "QUERY PLAN": unknown }>(sql`
          EXPLAIN (FORMAT JSON, COSTS OFF)
          WITH authorized_room_ids AS MATERIALIZED (
            SELECT viewer_member.room_id
            FROM room_members viewer_member
            INNER JOIN actors viewer_actor ON viewer_actor.id = viewer_member.actor_id
            WHERE viewer_member.actor_id = ${ownerActorId}
              AND viewer_actor.kind = 'user'
              AND viewer_actor.owner_id = ${ownerId}
          )
          SELECT r.id
          FROM authorized_room_ids authorized
          INNER JOIN rooms r ON r.id = authorized.room_id
          WHERE r.archived_at IS NULL
            AND r.kind NOT IN ('task', 'access', 'subthread')
            AND r.normalized_label LIKE '%needle%'
          ORDER BY r.label ASC, r.id ASC
          LIMIT 21
        `);
        expect(JSON.stringify(messagePlan[0]?.["QUERY PLAN"])).toContain("idx_session_messages_content_search");
        expect(JSON.stringify(conversationPlan[0]?.["QUERY PLAN"])).toMatch(
          /idx_rooms_normalized_label_(?:live|trgm_live)/,
        );
      });

      const first = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "needle",
        mode: "whole",
        limit: 50,
      });
      if ("validationError" in first) throw new Error(first.validationError.message);
      expect(first.conversations).toHaveLength(20);
      expect(first.conversationsTruncated).toBe(true);
      expect(first.messages).toHaveLength(50);
      expect(first.hasMoreOlderMessages).toBe(true);
      expect(first.messageAsOf).not.toBeNull();
      expect(first.nextOlderMessageCursor).not.toBeNull();

      const second = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "needle",
        mode: "whole",
        limit: 50,
        cursor: first.nextOlderMessageCursor,
        asOf: first.messageAsOf,
      });
      if ("validationError" in second) throw new Error(second.validationError.message);
      expect(second.messages).toHaveLength(50);
      expect(second.hasMoreOlderMessages).toBe(true);
      expect(second.messageAsOf).toEqual(first.messageAsOf);
      expect(new Set([...first.messages, ...second.messages].map((hit) => hit.messageId)).size).toBe(100);
    } finally {
      if (planSessionId) {
        await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, planSessionId));
        await db.delete(sessions).where(eq(sessions.id, planSessionId));
      }
      if (planRoomIds.length > 0) {
        await db.delete(roomMembers).where(inArray(roomMembers.roomId, planRoomIds));
        await db.delete(rooms).where(inArray(rooms.id, planRoomIds));
      }
      if (planNamespaceIds.length > 0) {
        await db.delete(namespaces).where(inArray(namespaces.id, planNamespaceIds));
      }
    }
  });

  test("uses exact membership once for bounded conversations and D430-parity cross-Room messages", async () => {
    const seededRoomIds: string[] = [];
    const seededNamespaceIds: string[] = [];
    const seededSessionIds: string[] = [];
    const seededPeerUserIds: string[] = [];
    const seededPeerActorIds: string[] = [];
    let parentRoomId = "";
    let childRoomId = "";

    const makeRoom = async (input: {
      label: string;
      kind?: "private" | "subthread" | "task" | "access";
      owner?: string;
      memberActorIds?: string[];
      parentRoomId?: string;
      threadRootMessageId?: number;
      archived?: boolean;
    }) => {
      const [namespace] = await db.insert(namespaces).values({
        scope: "private",
        label: `d470-${suffix}-${randomUUID()}`,
      }).returning({ id: namespaces.id });
      if (!namespace) throw new Error("namespace");
      seededNamespaceIds.push(namespace.id);
      const id = randomUUID();
      const members = input.memberActorIds ?? [ownerActorId];
      await db.insert(rooms).values({
        id,
        ownerId: input.owner ?? ownerId,
        type: "private",
        kind: input.kind ?? "private",
        label: input.label,
        graphThreadId: `room:${id}`,
        namespaceId: namespace.id,
        humanActorIds: members,
        parentRoomId: input.parentRoomId,
        threadRootMessageId: input.threadRootMessageId,
        archivedAt: input.archived ? new Date("2026-01-01T00:00:00.000Z") : null,
      });
      await db.insert(roomMembers).values(members.map((actorId) => ({
        roomId: id,
        actorId,
        roomRole: "member",
      })));
      seededRoomIds.push(id);
      return id;
    };
    const makeSession = async (roomId: string, thread = "main", sessionOwner = ownerId) => {
      const [session] = await db.insert(sessions).values({
        roomId,
        ownerId: sessionOwner,
        threadId: `${thread}:${randomUUID()}`,
        channel: "workbench",
      }).returning({ id: sessions.id });
      if (!session) throw new Error("session");
      seededSessionIds.push(session.id);
      return session.id;
    };

    try {
      const [participant] = await db.insert(users).values({
        name: `D470 participant ${suffix}`,
        email: `d470-participant-${suffix}@test.local`,
        handle: `needlehandle${suffix.slice(-5)}`,
      }).returning({ id: users.id, handle: users.handle });
      if (!participant) throw new Error("participant");
      seededPeerUserIds.push(participant.id);
      const [participantActor] = await db.insert(actors).values({
        ownerId: participant.id,
        displayName: "Needle participant",
        kind: "user",
      }).returning({ id: actors.id });
      if (!participantActor) throw new Error("participant actor");
      seededPeerActorIds.push(participantActor.id);

      parentRoomId = await makeRoom({ label: "Needle planning", memberActorIds: [ownerActorId, participantActor.id] });
      const primary = await makeSession(parentRoomId);
      const duplicate = await makeSession(parentRoomId);
      const subagent = await makeSession(parentRoomId, "subagent");
      const at = (minute: number) => new Date(`2026-03-01T10:${String(minute).padStart(2, "0")}:00.000Z`);
      const [anchor] = await db.insert(sessionMessages).values({
        sessionId: primary,
        role: "user",
        content: "thread anchor",
        createdAt: at(0),
      }).returning({ id: sessionMessages.id });
      if (!anchor) throw new Error("anchor");
      await db.insert(sessionMessages).values([
        { sessionId: primary, role: "user", content: "needle ordinary", createdAt: at(1) },
        { sessionId: primary, role: "tool", content: "needle lookup", toolName: "lookup", createdAt: at(2) },
        { sessionId: primary, role: "tool", content: "needle legacy tool", toolName: null, createdAt: at(2) },
        { sessionId: primary, role: "tool", content: "needle reaction", toolName: "react", createdAt: at(3) },
        { sessionId: primary, role: "user", content: "needle task row", metadata: { originatedBy: "task" }, createdAt: at(4) },
        { sessionId: subagent, role: "user", content: "needle subagent row", createdAt: at(5) },
        { sessionId: primary, role: "user", content: "needle duplicate old", fingerprint: "d470-duplicate", createdAt: at(6) },
        { sessionId: duplicate, role: "user", content: "needle duplicate canonical", fingerprint: "d470-duplicate", createdAt: at(7) },
        { sessionId: primary, role: "user", content: "needle same timestamp first", createdAt: at(8) },
        { sessionId: primary, role: "user", content: "needle same timestamp second", createdAt: at(8) },
      ]);

      childRoomId = await makeRoom({
        label: "Needle child",
        kind: "subthread",
        memberActorIds: [ownerActorId, participantActor.id],
        parentRoomId,
        threadRootMessageId: anchor.id,
      });
      const childSession = await makeSession(childRoomId);
      await db.insert(sessionMessages).values({
        sessionId: childSession,
        role: "user",
        content: "needle child reply",
        // Same Human fingerprint as the parent-room duplicate: dedupe must
        // remain Room-local, never collapse a Subthread result into its parent.
        fingerprint: "d470-duplicate",
        createdAt: at(9),
      });

      const participantOnlyRoom = await makeRoom({
        label: "Side topic",
        memberActorIds: [ownerActorId, participantActor.id],
      });
      await makeSession(participantOnlyRoom);
      const labelAndParticipantRoom = await makeRoom({
        label: "Needle label wins",
        memberActorIds: [ownerActorId, participantActor.id],
      });
      await makeSession(labelAndParticipantRoom);

      for (let index = 0; index < 20; index += 1) {
        await makeRoom({ label: `Needle truncation ${String(index).padStart(2, "0")}` });
      }

      const [outsider] = await db.insert(users).values({
        name: `D470 outsider ${suffix}`,
        email: `d470-outsider-${suffix}@test.local`,
        handle: `outsider${suffix.slice(-5)}`,
      }).returning({ id: users.id });
      if (!outsider) throw new Error("outsider");
      seededPeerUserIds.push(outsider.id);
      const [outsiderActor] = await db.insert(actors).values({
        ownerId: outsider.id,
        displayName: "Needle outsider",
        kind: "user",
      }).returning({ id: actors.id });
      if (!outsiderActor) throw new Error("outsider actor");
      seededPeerActorIds.push(outsiderActor.id);
      const unauthorized = await makeRoom({
        label: "Needle unauthorized",
        owner: outsider.id,
        memberActorIds: [outsiderActor.id],
      });
      const unauthorizedSession = await makeSession(unauthorized, "main", outsider.id);
      await db.insert(sessionMessages).values({ sessionId: unauthorizedSession, role: "user", content: "needle unauthorized", createdAt: at(10) });

      const spoofedViewer = await searchChats({
        ownerId,
        viewerActorId: outsiderActor.id,
        query: "needle",
        mode: "whole",
      });
      if ("validationError" in spoofedViewer) throw new Error(spoofedViewer.validationError.message);
      expect(spoofedViewer).toMatchObject({
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        messageAsOf: null,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      });

      let archivedRoomId = "";
      for (const hidden of [
        { label: "Needle archived", archived: true },
        { label: "Needle task room", kind: "task" as const },
        { label: "Needle access room", kind: "access" as const },
      ]) {
        const hiddenRoom = await makeRoom(hidden);
        if (hidden.archived) archivedRoomId = hiddenRoom;
        const hiddenSession = await makeSession(hiddenRoom);
        await db.insert(sessionMessages).values({ sessionId: hiddenSession, role: "user", content: `needle ${hidden.label}`, createdAt: at(11) });
      }

      const first = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "needle",
        mode: "whole",
        limit: 2,
      });
      if ("validationError" in first) throw new Error(first.validationError.message);
      expect(first.conversations).toHaveLength(20);
      expect(first.conversationsTruncated).toBe(true);
      expect(first.conversations.some((hit) => hit.room.id === childRoomId)).toBe(false);
      expect(first.conversations.find((hit) => hit.room.id === labelAndParticipantRoom)?.matchedBy).toBe("label");
      const participantSearch = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: participant.handle!,
        mode: "whole",
      });
      if ("validationError" in participantSearch) throw new Error(participantSearch.validationError.message);
      expect(participantSearch.conversations.find((hit) => hit.room.id === participantOnlyRoom)?.matchedBy).toBe("participant");
      expect(participantSearch.conversations.find((hit) => hit.room.id === participantOnlyRoom)?.room.roster.some(
        (member) => member.actorId === participantActor.id && member.handle === participant.handle,
      )).toBe(true);
      const participantDisplaySearch = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "Needle participant",
        mode: "whole",
      });
      if ("validationError" in participantDisplaySearch) throw new Error(participantDisplaySearch.validationError.message);
      expect(participantDisplaySearch.conversations.find((hit) => hit.room.id === participantOnlyRoom)?.matchedBy).toBe("participant");
      expect(first.conversations.some((hit) => hit.room.label.includes("unauthorized") || hit.room.label.includes("archived") || hit.room.kind === "task" || hit.room.kind === "access")).toBe(false);
      const archived = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "needle",
        mode: "whole",
        archiveScope: "archived",
      });
      if ("validationError" in archived) throw new Error(archived.validationError.message);
      expect(archived.conversations.map((hit) => hit.room.id)).toEqual([archivedRoomId]);
      expect(archived.messages.map((hit) => hit.roomId)).toEqual([archivedRoomId]);
      expect(first.messages.map((hit) => hit.snippet)).toEqual(["needle child reply", "needle same timestamp second"]);
      expect(first.messages[0]).toMatchObject({ roomId: childRoomId, parentRoomId, parentRoomLabel: "Needle planning" });
      expect(first.messageAsOf).toEqual({ createdAt: at(9), messageId: first.messages[0]!.messageId });

      const second = await searchChats({
        ownerId,
        viewerActorId: ownerActorId,
        query: "needle",
        mode: "whole",
        limit: 50,
        cursor: first.nextOlderMessageCursor!,
        asOf: first.messageAsOf!,
      });
      if ("validationError" in second) throw new Error(second.validationError.message);
      const all = [...first.messages, ...second.messages];
      expect(all.map((hit) => hit.snippet)).toEqual([
        "needle child reply",
        "needle same timestamp second",
        "needle same timestamp first",
        "needle duplicate canonical",
        "needle legacy tool",
        "needle lookup",
        "needle ordinary",
      ]);
      expect(all.map((hit) => hit.snippet)).not.toEqual(expect.arrayContaining([
        "needle reaction",
        "needle task row",
        "needle subagent row",
        "needle duplicate old",
        "needle unauthorized",
      ]));
    } finally {
      const childSessions = childRoomId
        ? await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, childRoomId))
        : [];
      const childSessionIds = childSessions.map((row) => row.id);
      if (childSessionIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, childSessionIds));
        await db.delete(sessions).where(inArray(sessions.id, childSessionIds));
      }
      if (childRoomId) {
        await db.delete(roomMembers).where(eq(roomMembers.roomId, childRoomId));
        await db.delete(rooms).where(eq(rooms.id, childRoomId));
      }
      const remainingSessionIds = seededSessionIds.filter((id) => !childSessionIds.includes(id));
      if (remainingSessionIds.length > 0) {
        await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, remainingSessionIds));
        await db.delete(sessions).where(inArray(sessions.id, remainingSessionIds));
      }
      const remainingRoomIds = seededRoomIds.filter((id) => id !== childRoomId);
      if (remainingRoomIds.length > 0) {
        await db.delete(roomMembers).where(inArray(roomMembers.roomId, remainingRoomIds));
        await db.delete(rooms).where(inArray(rooms.id, remainingRoomIds));
      }
      if (seededNamespaceIds.length > 0) await db.delete(namespaces).where(inArray(namespaces.id, seededNamespaceIds));
      if (seededPeerActorIds.length > 0) await db.delete(actors).where(inArray(actors.id, seededPeerActorIds));
      if (seededPeerUserIds.length > 0) await db.delete(users).where(inArray(users.id, seededPeerUserIds));
    }
  });
});
