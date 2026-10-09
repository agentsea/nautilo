import { expect, mock, test } from "bun:test";
import { parseExternalMessageOrigin, type ExternalMessageAttribution } from "@nautilo/types";

const sponsor = "10000000-0000-4000-8000-000000000001";
const viewer = "10000000-0000-4000-8000-000000000002";
const origin = parseExternalMessageOrigin({ kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
  connectionId: "10000000-0000-4000-8000-000000000003", bindingId: "10000000-0000-4000-8000-000000000004",
  providerAgentId: "provider-agent", chatId: "chat", threadRootId: null, messageId: "message", senderId: "sender",
  senderType: "user", senderLabel: "Outside participant", createdAt: "2026-01-01T00:00:00Z" })!;
let rows: Record<string, unknown>[] = [];
let canonical: ReadonlyMap<number, ExternalMessageAttribution> = new Map();
let receiptIds: ReadonlySet<number> = new Set();
let ordinaryReads = 0;
let activeViewerTransactions = 0;
const provenanceOwners: string[] = [];
const selections: string[][] = [];
const accessOwners: string[] = [];
const fakeDb = {
  select(fields: Record<string, unknown>) {
    selections.push(Object.keys(fields));
    const selected = rows.map(row => Object.fromEntries(Object.keys(fields).map(key => [key, row[key]])));
    const query = { from: () => query, where: () => query, innerJoin: () => query, orderBy: () => query,
      limit: () => query, offset: () => query,
      then: (resolve: (value: Record<string, unknown>[]) => unknown) => Promise.resolve(selected).then(resolve) };
    return query;
  },
  execute: () => Promise.resolve(rows),
};
const database = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({ ...database, agentDb: fakeDb,
  getBolterCanonicalAttributions: (ctx: { userId: string }, ids: readonly number[]) => {
    expect(activeViewerTransactions).toBe(0);
    ordinaryReads++; provenanceOwners.push(ctx.userId);
    return Promise.resolve(new Map([...canonical].filter(([id]) => ids.includes(id))));
  },
  getBolterReceiptMessageIds: (ctx: { userId: string }, ids: readonly number[]) => {
    expect(activeViewerTransactions).toBe(0);
    provenanceOwners.push(ctx.userId); return Promise.resolve(new Set([...receiptIds].filter(id => ids.includes(id))));
  },
}));
const trustDb = await import("../../src/store/trust-agent-db");
mock.module("../../src/store/trust-agent-db", () => ({ ...trustDb,
  withAgentTrustContext: async (ctx: { userId: string }, work: (tx: typeof fakeDb) => unknown) => {
    accessOwners.push(ctx.userId);
    activeViewerTransactions++;
    try { return await work(fakeDb); }
    finally { activeViewerTransactions--; }
  },
}));
const store = await import("../../src/store/session-store");
const search = await import("../../src/store/room-message-search");

function fixture() {
  return { id: 1, sessionId: "session", role: "user", content: "Outside content", toolCalls: null, toolName: null,
    metadata: { externalOrigin: origin, externalReceiptId: "receipt" }, createdAt: new Date("2026-01-01T00:00:00Z"),
    editedAt: null, editRevision: 0, fingerprint: "turn", sourceUserId: sponsor, sessionAgentId: null };
}
test("authorized non-sponsor history verifies the selected row's receipt owner without identifying that sponsor as author", async () => {
  rows = [fixture()]; canonical = new Map([[1, { status: "verified", origin }]]); receiptIds = new Set([1]);
  provenanceOwners.length = 0; accessOwners.length = 0;
  const result = await store.getRoomMessagesAcrossMemberSessionsWithSelection({ ownerId: viewer, roomId: "room", beforeCreatedAt: new Date(), beforeId: 9 });
  expect(accessOwners).toContain(viewer);
  expect(provenanceOwners).toEqual([sponsor]);
  expect(result.messages[0]?.externalOrigin).toEqual(origin);
  expect(result.messages[0]).not.toHaveProperty("sourceUserId");
});
test("structural history detects receipt linkage without reading ordinary metadata or origin labels", async () => {
  rows = [fixture()]; selections.length = 0; ordinaryReads = 0;
  const result = await store.getRoomMessagesAcrossMemberSessionsWithSelection({ ownerId: viewer, roomId: "room", beforeCreatedAt: new Date(), beforeId: 9, contentRepresentation: "structural" });
  expect(ordinaryReads).toBe(0);
  expect(selections[0]).not.toContain("metadata");
  expect(result.messages[0]?.content).toBeNull();
  expect(result.messages[0]?.externalAttributionInvalid).toBe(true);
  expect(result.messages[0]).not.toHaveProperty("sourceUserId");
  expect(result.messages[0]).not.toHaveProperty("externalOrigin");
});
test("structural history preserves restrictive authorship after receipt and metadata cleanup", async () => {
  rows = [{ ...fixture(), metadata: null, externalAuthorship: true }];
  canonical = new Map(); receiptIds = new Set(); selections.length = 0; ordinaryReads = 0;
  const result = await store.getRoomMessagesAcrossMemberSessionsWithSelection({ ownerId: viewer, roomId: "room", beforeCreatedAt: new Date(), beforeId: 9, contentRepresentation: "structural" });
  expect(ordinaryReads).toBe(0);
  expect(selections[0]).toContain("externalAuthorship");
  expect(selections[0]).not.toContain("metadata");
  expect(result.messages[0]?.content).toBeNull();
  expect(result.messages[0]?.externalAttributionInvalid).toBe(true);
  expect(result.messages[0]).not.toHaveProperty("sourceUserId");
  expect(result.messages[0]).not.toHaveProperty("externalOrigin");
});
test("forged metadata stays unverified and the ordinary session reader retains visible text", async () => {
  rows = [fixture()]; canonical = new Map();
  const result = await store.getSessionMessages("session");
  expect(result[0]?.content).toBe("Outside content");
  expect(result[0]?.externalAttributionInvalid).toBe(true);
  expect(result[0]).not.toHaveProperty("externalOrigin");
});
test("cursor history releases its viewer transaction before borrowing a provenance connection", async () => {
  rows = [fixture()]; canonical = new Map([[1, { status: "verified", origin }]]);
  const result = await store.getRoomMessagesBeforeCursor({
    ownerId: sponsor, roomId: "room", beforeCreatedAt: new Date(), beforeId: 9,
  });
  expect(result.messages[0]?.externalOrigin).toEqual(origin);
  expect(activeViewerTransactions).toBe(0);
});
test("authorized non-sponsor search omits local principal attribution on imported results", async () => {
  canonical = new Map([[1, { status: "verified", origin }]]); provenanceOwners.length = 0;
  rows = [{ message_id: 1, session_id: "session", role: "user", content: "Outside content", metadata: { externalOrigin: origin },
    tool_calls: null, tool_name: null, created_at: new Date("2026-01-01T00:00:00Z"), edited_at: null, edit_revision: 0,
    source_user_id: sponsor, session_agent_id: "genie", user_actor_id: "sponsor-actor", user_display_name: "Sponsor", user_handle: "sponsor" }];
  const result = await search.searchRoomMessages({ ownerId: viewer, roomId: "room", query: "Outside", mode: "whole" });
  if ("validationError" in result) throw new Error("Unexpected fixture validation error");
  expect(provenanceOwners).toEqual([sponsor]);
  expect(result.hits[0]?.externalOrigin).toEqual(origin);
  expect(result.hits[0]).not.toHaveProperty("sourceUserId");
  expect(result.hits[0]?.authorActorId).toBeNull();
  expect(result.hits[0]?.authorAgentId).toBeNull();
  expect(result.hits[0]?.authorDisplayName).toBe("Outside participant");
});
test("receipt-free marked search results keep content and suppress local principals", async () => {
  canonical = new Map(); receiptIds = new Set();
  rows = [{ message_id: 1, session_id: "session", role: "user", content: "Outside content", metadata: null, external_authorship: true,
    tool_calls: null, tool_name: null, created_at: new Date("2026-01-01T00:00:00Z"), edited_at: null, edit_revision: 0,
    source_user_id: sponsor, session_agent_id: "genie", user_actor_id: "sponsor-actor", user_display_name: "Sponsor", user_handle: "sponsor" }];
  const result = await search.searchRoomMessages({ ownerId: viewer, roomId: "room", query: "Outside", mode: "whole" });
  if ("validationError" in result) throw new Error("Unexpected fixture validation error");
  expect(result.hits[0]?.externalAttributionInvalid).toBe(true);
  expect(result.hits[0]).not.toHaveProperty("sourceUserId");
  expect(result.hits[0]?.authorActorId).toBeNull();
  expect(result.hits[0]?.authorAgentId).toBeNull();
  expect(result.hits[0]?.authorDisplayName).toBe("External participant");
  expect(result.hits[0]?.snippet).toContain("Outside content");
});
test("cross-chat search retains durable external authorship without returning its internal marker", async () => {
  canonical = new Map(); receiptIds = new Set();
  rows = [{ conversations: [], conversation_count: 0, messages: [{ messageId: 1, roomId: "room", roomLabel: "External room",
    roomKind: "private", createdAt: "2026-01-01T00:00:00Z", role: "user", snippet: "Outside content", metadata: null,
    externalAuthorship: true, sourceUserId: sponsor, authorActorId: "sponsor-actor", authorDisplayName: "Sponsor", authorHandle: "sponsor" }] }];
  const result = await search.searchChats({ ownerId: viewer, viewerActorId: "viewer-actor", query: "Outside", mode: "whole" });
  if ("validationError" in result) throw new Error("Unexpected fixture validation error");
  expect(result.messages[0]?.externalAttributionInvalid).toBe(true);
  expect(result.messages[0]?.sourceUserId).toBeUndefined();
  expect(result.messages[0]?.authorActorId).toBeNull();
  expect(result.messages[0]?.authorDisplayName).toBe("External participant");
  expect(result.messages[0]?.snippet).toContain("Outside content");
  expect(result.messages[0]).not.toHaveProperty("externalAuthorship");
  expect(result.messages[0]).not.toHaveProperty("metadata");
});
