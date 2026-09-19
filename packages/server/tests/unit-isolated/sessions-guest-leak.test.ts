/**
 * Regression tests for session routes; `beforeEach` pins owner/agent env for the suite.
 * Restore prior env in `afterAll` so other test files do not inherit `owner-test` / `agent-test`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";

type TestSession = {
  sessionId: string;
  threadId: string;
  title: string;
  messageCount: number;
  startedAt: Date;
};

type TestMessage = {
  id: string;
  logicalMessageKey?: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolName: string | null;
  createdAt: Date;
  editedAt?: Date | null;
  editRevision?: number;
  replyToMessageId?: number | null;
  replyCount?: number;
  lastReplyAt?: Date | null;
  summaryRevision?: number;
  sourceUserId?: string;
  authorAgentId?: string;
  authorHarnessId?: string;
};

const getLatestSession = mock<() => Promise<TestSession | null>>(() =>
  Promise.resolve(null),
);
const getLatestSessionForRoom = mock<
  (_ownerId: string, _roomId: string) => Promise<TestSession | null>
>(() => Promise.resolve(null));
const getLatestSessionMessages = mock<
  (_sessionId: string, _limit?: number) => Promise<TestMessage[]>
>(() =>
  Promise.resolve([]),
);
const getSessionMessages = mock<
  (_sessionId: string, _limit?: number, _offset?: number) => Promise<TestMessage[]>
>(() => Promise.resolve([]));
const getRoomMessagesAcrossMemberSessions = mock<
  (_args: {
    roomId: string;
    beforeCreatedAt: Date;
    beforeId: number;
    limit?: number;
  }) => Promise<{ messages: TestMessage[]; hasMoreBefore: boolean }>
>(() =>
  Promise.resolve({ messages: [], hasMoreBefore: false }),
);
const getRoomMessagesAcrossMemberSessionsWithSelection = mock(
  async (_args: Record<string, unknown>) => ({
    messages: [] as TestMessage[],
    hasMoreBefore: false,
    selectedCoordinates: [] as Array<{
      sessionId: string;
      messageId: number;
      editRevision: number;
      role: "user" | "assistant" | "tool" | "system";
      logicalMessageKey: string;
    }>,
  }),
);
type TestShadowReadProjection =
  | Readonly<{
      responseVersion: 1;
      status: "ineligible";
      selectedCount: number;
      eligibleCount: 0;
    }>
  | Readonly<{
      responseVersion: 1;
      status: "disabled";
      mode: "plaintext_only";
    }>;
const projectRoomHistoryShadowRead = mock<
  (_input: unknown) => Promise<TestShadowReadProjection>
>(async (_input: unknown) => ({
  responseVersion: 1,
  status: "ineligible",
  selectedCount: 1,
  eligibleCount: 0,
}));
const acknowledgeRoomHistoryShadowRead = mock(async (_input: unknown) => ({
  responseVersion: 1 as const,
  status: "accepted" as const,
  operationId: "history:one",
}));
const searchRoomMessages = mock<
  (_args: Record<string, unknown>) => Promise<Record<string, unknown>>
>(() => Promise.resolve({ hits: [], asOf: null, nextOlderCursor: null, hasMoreOlder: false }));
const searchChats = mock<
  (_args: Record<string, unknown>) => Promise<Record<string, unknown>>
>(() => Promise.resolve({
  conversations: [],
  conversationsTruncated: false,
  messages: [],
  messageAsOf: null,
  nextOlderMessageCursor: null,
  hasMoreOlderMessages: false,
}));
const getRoomMessagesAround = mock<
  (_args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
>(() => Promise.resolve(null));
// M125 Phase 2.5 — sessions.ts switched its dep from
// `getRoomGraphThreadForOwnerSession` (took a caller-supplied
// `defaultAgentId`, which scoped the membership join to the operator's
// agent and 404'd non-operator room owners) to
// `getRoomGraphThreadForViewer` (resolves the agent from `room_members`).
const getRoomGraphThreadForViewer = mock<
  (_roomId: string, _sessionUserId: string) => Promise<string | null>
>(() => Promise.resolve("room-thread"));
type RoomDetailLike = { id: string } | null;
const getRoomDetailForMember = mock<
  (_roomId: string, _userId: string) => Promise<RoomDetailLike>
>(() => Promise.resolve({ id: "room-detail" }));

import { sessionRoutes, type SessionRoutesDeps } from "../../src/routes/sessions";
import {
  setBootstrapOwnerId,
  setBootstrapDefaultAgentId,
  getBootstrapOwnerId,
  getBootstrapDefaultAgentId,
} from "@nautilo/trust";
import * as actualTrust from "@nautilo/trust";

// Unscoped/global transcript readers remain `read_memories` gated. M259 moves
// exact Room readers to membership, so tests also flip this to `[]` to prove a
// Guest member still reads the selected Room without gaining global search.
const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["read_memories"],
);
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

const PREV_OWNER_ENV = getBootstrapOwnerId();
const PREV_AGENT_ENV = getBootstrapDefaultAgentId();

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    sessionId: overrides.sessionId ?? "session-a",
    threadId: overrides.threadId ?? "thread-a",
    title: overrides.title ?? "Session A",
    messageCount: overrides.messageCount ?? 2,
    startedAt: overrides.startedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeMessage(id: string, content: string | null = `content ${id}`): TestMessage {
  return {
    id,
    role: "assistant",
    content,
    toolCalls: null,
    toolName: null,
    createdAt: new Date(`2026-01-01T00:00:0${id}.000Z`),
  };
}

function makeApp(
  role: string,
  userId: string | null = "owner-user",
  options: Readonly<{ shadowRead?: boolean; encryptedOnly?: boolean }> = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    (request as { policyContext?: { actorRole: string } }).policyContext = {
      actorRole: role,
    };
    (request as { sessionUserId?: string | null }).sessionUserId = userId;
    (request as { sessionActorId?: string | null }).sessionActorId = userId;
  });
  sessionRoutes(app, {
    getLatestSession,
    getLatestSessionForRoom,
    getLatestSessionMessages,
    getSessionMessages,
    getRoomMessagesAcrossMemberSessions,
    ...(options.shadowRead
      ? {
        getRoomMessagesAcrossMemberSessionsWithSelection:
          getRoomMessagesAcrossMemberSessionsWithSelection as unknown as
            NonNullable<SessionRoutesDeps[
              "getRoomMessagesAcrossMemberSessionsWithSelection"
            ]>,
        roomHistoryShadowRead: {
          project: projectRoomHistoryShadowRead,
          acknowledge: acknowledgeRoomHistoryShadowRead,
        } as unknown as NonNullable<SessionRoutesDeps["roomHistoryShadowRead"]>,
      }
      : {}),
    searchChats: searchChats as unknown as SessionRoutesDeps["searchChats"],
    searchRoomMessages: searchRoomMessages as unknown as SessionRoutesDeps["searchRoomMessages"],
    getRoomMessagesAround: getRoomMessagesAround as unknown as SessionRoutesDeps["getRoomMessagesAround"],
    getRoomGraphThreadForViewer,
    getRoomDetailForMember:
      getRoomDetailForMember as unknown as SessionRoutesDeps["getRoomDetailForMember"],
    strictShadowPolicyReader: (async () => ({
      mode: options.encryptedOnly ? "encrypted_only" : "plaintext_only",
      shadowBehavior: "fallback",
      revision: 1,
      shadowEncryptionStartedAt: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })) as unknown as NonNullable<SessionRoutesDeps["strictShadowPolicyReader"]>,
  });
  return app;
}

beforeEach(() => {
  setBootstrapOwnerId("owner-test");
  setBootstrapDefaultAgentId("agent-test");
  getLatestSession.mockClear();
  getLatestSessionForRoom.mockClear();
  getLatestSessionMessages.mockClear();
  getSessionMessages.mockClear();
  getRoomMessagesAcrossMemberSessions.mockClear();
  getRoomMessagesAcrossMemberSessionsWithSelection.mockClear();
  projectRoomHistoryShadowRead.mockClear();
  acknowledgeRoomHistoryShadowRead.mockClear();
  searchChats.mockClear();
  searchRoomMessages.mockClear();
  getRoomMessagesAround.mockClear();
  getRoomGraphThreadForViewer.mockClear();
  getRoomDetailForMember.mockClear();
  getUserCapabilitiesMock.mockClear();
  getUserCapabilitiesMock.mockImplementation(async () => ["read_memories"]);
});

/**
 * Regression tests for GET /api/sessions/latest.
 *
 * #1 — Guest actors must NOT see owner session history.
 *   Bug: getLatestSession was called with no threadId filter, leaking
 *   owner history to guests. Fix: return empty for non-owner actors.
 *
 * #2 — Owner sessions must remain visible after the M042B rooms
 *   migration (data-loss-on-restore regression).
 *   Bug: the route passed the literal thread_id "app:default" to
 *   getLatestSession, which matched pre-M042B rows but stopped
 *   matching after seedDefaultRoom rewrites those rows to
 *   "room:<roomId>" on boot. A user restoring a snapshot taken
 *   before M042B (or whose sessions cross the M042B boundary) saw
 *   an empty "No session yet" card even though rows existed in the
 *   database. Fix: drop the threadId filter entirely. Guest
 *   isolation is still enforced by the role check; multiple
 *   thread_id conventions (legacy "app:default", M042B+ "room:<id>",
 *   verified-guest "guest:<id>") are all legitimate owner history.
 */
describe("sessions endpoint — guest isolation", () => {
  test("non-owner role receives empty latest session without querying owner history", async () => {
    // M133 — a guest has no `read_memories` capability → gate denies.
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const app = makeApp("guest", "guest-session-user");
    try {
      const res = await app.inject({ method: "GET", url: "/api/sessions/latest" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ session: null, messages: [] });
      expect(getLatestSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("sessions endpoint — thread_id convention independence", () => {
  test("default latest route loads owner latest session and persisted message tail", async () => {
    getLatestSession.mockResolvedValueOnce(makeSession({ sessionId: "session-default" }));
    getLatestSessionMessages.mockResolvedValueOnce([
      makeMessage("1", "tail one"),
      makeMessage("2", "tail two"),
    ]);
    const app = makeApp("owner");
    try {
      const res = await app.inject({ method: "GET", url: "/api/sessions/latest?limit=2" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { session: { id: string }; messages: unknown[] };
      expect(body.session.id).toBe("session-default");
      expect(body.messages).toHaveLength(2);
      expect(getLatestSession).toHaveBeenCalledWith("owner-user");
      expect(getLatestSessionMessages).toHaveBeenCalledWith("session-default", 2);
      expect(getSessionMessages).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("latest history preserves harness author separately from its delegating agent", async () => {
    getLatestSession.mockResolvedValueOnce(makeSession({ sessionId: "session-default" }));
    getLatestSessionMessages.mockResolvedValueOnce([{
      ...makeMessage("1", "harness result"),
      authorAgentId: "agent-moxie",
      authorHarnessId: "claude-code",
    }]);
    const app = makeApp("owner");
    try {
      const res = await app.inject({ method: "GET", url: "/api/sessions/latest" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        messages: Array<{ authorAgentId?: string; authorHarnessId?: string }>;
      };
      expect(body.messages[0]).toMatchObject({
        authorAgentId: "agent-moxie",
        authorHarnessId: "claude-code",
      });
    } finally {
      await app.close();
    }
  });

  test("Guest room latest validates membership and loads without read_memories", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    getLatestSessionForRoom.mockResolvedValueOnce(makeSession({ sessionId: "session-room" }));
    getLatestSessionMessages.mockResolvedValueOnce([makeMessage("1")]);
    const app = makeApp("owner", "owner-user");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/latest?roomId=${ROOM_ID}&limit=5`,
      });
      expect(res.statusCode).toBe(200);
      expect(getRoomDetailForMember).toHaveBeenCalledWith(
        ROOM_ID,
        "owner-user",
      );
      expect(getLatestSessionForRoom).toHaveBeenCalledWith("owner-user", ROOM_ID);
      expect(getLatestSessionMessages).toHaveBeenCalledWith("session-room", 5);
    } finally {
      await app.close();
    }
    expect(getUserCapabilitiesMock).not.toHaveBeenCalled();
  });

  test("room latest route returns 404 when room access validation fails", async () => {
    getRoomDetailForMember.mockResolvedValueOnce(null);
    const app = makeApp("owner");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/latest?roomId=${ROOM_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(getLatestSessionForRoom).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("older room history is room-scoped and cursor-based", async () => {
    getRoomMessagesAcrossMemberSessions.mockResolvedValueOnce({
      messages: [
        {
          ...makeMessage("1"),
          authorAgentId: "agent-genie-id",
        },
      ],
      hasMoreBefore: true,
    });
    const app = makeApp("owner", "owner-user");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        messages: Array<{ authorAgentId?: string }>;
        pageInfo: { hasMoreBefore: boolean };
      };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.authorAgentId).toBe("agent-genie-id");
      expect(body.pageInfo.hasMoreBefore).toBe(true);
      expect(getRoomMessagesAcrossMemberSessions).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        ownerId: "owner-user",
        beforeCreatedAt: new Date("2026-01-01T00:00:09.000Z"),
        beforeId: 9,
        limit: 3,
      });
    } finally {
      await app.close();
    }
  });

  test("explicit v1 intent selects one canonical page and adds its Shadow sidecar", async () => {
    getRoomMessagesAcrossMemberSessionsWithSelection.mockResolvedValueOnce({
      messages: [{
        ...makeMessage("1", "ordinary fallback"),
        logicalMessageKey: "logical:1",
        role: "user",
        editRevision: 0,
      }],
      hasMoreBefore: false,
      selectedCoordinates: [{
        sessionId: "40000000-0000-4000-8000-000000000275",
        messageId: 1,
        editRevision: 0,
        role: "user",
        logicalMessageKey: "logical:1",
      }],
    });
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=50&shadowReadVersion=1&shadowReadRequestKey=history%3Aone&shadowReadDeviceId=device%3Abrowser`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        messages: [{ id: "1", content: "ordinary fallback" }],
        shadowEncryption: {
          responseVersion: 1,
          status: "ineligible",
          selectedCount: 1,
          eligibleCount: 0,
        },
      });
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
      expect(getRoomMessagesAcrossMemberSessionsWithSelection)
        .toHaveBeenCalledTimes(1);
      expect(getRoomDetailForMember).toHaveBeenCalledWith(ROOM_ID, "owner-user");
      expect(projectRoomHistoryShadowRead).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM_ID,
          readerDeviceId: "device:browser",
          clientRequestKey: "history:one",
          selectedCoordinates: [expect.objectContaining({ messageId: 1 })],
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("rejects a non-member before selected history or terminal sidecar projection", async () => {
    getRoomDetailForMember.mockResolvedValueOnce(null);
    const app = makeApp("guest", "other-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=50&shadowReadVersion=1&shadowReadRequestKey=history%3Aprivate&shadowReadDeviceId=device%3Abrowser`,
      });
      expect(res.statusCode).toBe(404);
      expect(getRoomMessagesAcrossMemberSessionsWithSelection).not.toHaveBeenCalled();
      expect(projectRoomHistoryShadowRead).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("Full requires protected intent before any ordinary history loader", async () => {
    const app = makeApp("owner", "owner-user", { shadowRead: true, encryptedOnly: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe("protected_history_read_intent_required");
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
      expect(getRoomMessagesAcrossMemberSessionsWithSelection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("Full requests a structural selected page and composes the protected sidecar", async () => {
    getRoomMessagesAcrossMemberSessionsWithSelection.mockResolvedValueOnce({
      messages: [{ ...makeMessage("1", null), role: "user", editRevision: 0 }],
      hasMoreBefore: false,
      selectedCoordinates: [{
        sessionId: "40000000-0000-4000-8000-000000000275",
        messageId: 1,
        editRevision: 0,
        role: "user",
        logicalMessageKey: "logical:1",
      }],
    });
    const app = makeApp("owner", "owner-user", { shadowRead: true, encryptedOnly: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&shadowReadVersion=1&shadowReadRequestKey=history%3Afull`,
      });
      expect(res.statusCode).toBe(200);
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
      expect(getRoomMessagesAcrossMemberSessionsWithSelection).toHaveBeenCalledWith(
        expect.objectContaining({ contentRepresentation: "structural" }),
      );
      expect(res.json<{ messages: { content: string | null }[] }>().messages[0]?.content).toBeNull();
      expect(projectRoomHistoryShadowRead).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test("does not issue a Shadow read admission for an empty canonical page", async () => {
    getRoomMessagesAcrossMemberSessionsWithSelection.mockResolvedValueOnce({
      messages: [],
      hasMoreBefore: false,
      selectedCoordinates: [],
    });
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=50&shadowReadVersion=1&shadowReadRequestKey=history%3Aempty&shadowReadDeviceId=device%3Abrowser`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        messages: [],
        pageInfo: { hasMoreBefore: false },
      });
      expect(JSON.parse(res.body)).not.toHaveProperty("shadowEncryption");
      expect(projectRoomHistoryShadowRead).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("stamps plaintext policy when a non-empty page has no Shadow coordinates", async () => {
    getRoomMessagesAcrossMemberSessionsWithSelection.mockResolvedValueOnce({
      messages: [makeMessage("1", "ordinary plaintext")],
      hasMoreBefore: false,
      selectedCoordinates: [],
    });
    projectRoomHistoryShadowRead.mockResolvedValueOnce({
      responseVersion: 1,
      status: "disabled",
      mode: "plaintext_only",
    });
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=50&shadowReadVersion=1&shadowReadRequestKey=history%3Aplaintext&shadowReadDeviceId=device%3Abrowser`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        messages: [{ id: "1", content: "ordinary plaintext" }],
        shadowEncryption: {
          responseVersion: 1,
          status: "disabled",
          mode: "plaintext_only",
        },
      });
      expect(projectRoomHistoryShadowRead).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM_ID,
          selectedCoordinates: [],
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("rejects partial Shadow intent before the ordinary history query", async () => {
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&shadowReadVersion=1`,
      });
      expect(res.statusCode).toBe(400);
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
      expect(getRoomMessagesAcrossMemberSessionsWithSelection)
        .not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("routes the exact signed Shadow-read acknowledgement once", async () => {
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${ROOM_ID}/messages/shadow-read/history%3Aone/ack`,
        payload: {
          requestVersion: 1,
          status: "client_unavailable",
          operationId: "history:one",
          tokenBase64url: "dG9rZW4",
          reason: "client_custody_unavailable",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(acknowledgeRoomHistoryShadowRead).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM_ID,
          operationId: "history:one",
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("projects one exact edited coordinate without loading an ordinary page", async () => {
    const app = makeApp("owner", "owner-user", { shadowRead: true, encryptedOnly: true });
    try {
      const coordinate = { sessionId: "40000000-0000-4000-8000-000000000275",
        messageId: 17, editRevision: 2, role: "user", logicalMessageKey: "logical:17" };
      const res = await app.inject({ method: "POST",
        url: `/api/rooms/${ROOM_ID}/messages/shadow-read`,
        payload: { intent: { requestVersion: 1, clientRequestKey: "edit:17",
          readerDeviceId: "device:browser" }, coordinate } });
      expect(res.statusCode).toBe(200);
      expect(projectRoomHistoryShadowRead).toHaveBeenCalledWith(expect.objectContaining({
        roomId: ROOM_ID, readerDeviceId: "device:browser",
        clientRequestKey: "edit:17", selectedCoordinates: [coordinate],
      }));
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
      expect(getRoomMessagesAcrossMemberSessionsWithSelection).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test("preserves V2 Human ordinary-repair evidence for the history handler", async () => {
    const app = makeApp("owner", "owner-user", { shadowRead: true });
    const coordinate = {
      sessionId: "10000000-0000-4000-8000-000000000010",
      messageId: 7, editRevision: 0, role: "user" as const,
      logicalMessageKey: "human:turn:7",
    };
    const repair = {
      version: 2 as const, purpose: "human_device_ordinary_repair" as const,
      operationId: "history:repair", policyRevision: 4,
      subjectHumanId: "human:one", readerDeviceId: "device:one",
      readerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 3,
      roomId: ROOM_ID, namespaceId: "10000000-0000-4000-8000-000000000011",
      namespaceAccessRevision: 5, namespaceKeyGeneration: 6,
      sessionId: coordinate.sessionId, messageId: 7, editRevision: 0,
      cryptoObjectId: "message:protected:7", authorRole: "user" as const,
      createdAt: 1_700_000_000_000,
      payloadDigestBase64url: "A".repeat(43), payloadBytesBase64url: "e30",
      issuedAt: 1_700_000_000_000, deadlineAt: 1_700_000_060_000,
      signatureBase64url: "A".repeat(86),
    };
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${ROOM_ID}/messages/shadow-read/history%3Arepair/ack`,
        payload: {
          requestVersion: 2, status: "signed_with_ordinary_repairs",
          operationId: "history:repair", tokenBase64url: "dG9rZW4",
          acknowledgementBytesBase64url: "AQ", selectedCoordinates: [coordinate],
          ordinaryRepairs: [repair],
        },
      });
      expect(res.statusCode).toBe(200);
      const call = acknowledgeRoomHistoryShadowRead.mock.calls.at(-1)?.[0] as
        | { request?: { ordinaryRepairs?: unknown } }
        | undefined;
      expect(call?.request?.ordinaryRepairs).toEqual([repair]);
    } finally { await app.close(); }
  });

  test("older room history serializes authoritative D426 root summaries and preserves quote replies", async () => {
    getRoomMessagesAcrossMemberSessions.mockResolvedValueOnce({
      messages: [
        {
          ...makeMessage("1", "root"),
          replyToMessageId: 41,
          replyCount: 2,
          lastReplyAt: new Date("2026-01-02T03:04:05.678Z"),
          summaryRevision: 7,
        },
        {
          ...makeMessage("2", "root after delete"),
          replyCount: 0,
          lastReplyAt: null,
          summaryRevision: 8,
        },
        makeMessage("3", "ordinary row"),
      ],
      hasMoreBefore: false,
    });
    const app = makeApp("owner", "owner-user");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages?beforeId=9&beforeCreatedAt=2026-01-01T00:00:09.000Z&limit=3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { messages: Array<Record<string, unknown>> };
      expect(body.messages[0]).toMatchObject({
        replyToMessageId: 41,
        replyCount: 2,
        lastReplyAt: "2026-01-02T03:04:05.678Z",
        summaryRevision: 7,
      });
      expect(body.messages[1]).toMatchObject({
        replyCount: 0,
        lastReplyAt: null,
        summaryRevision: 8,
      });
      expect(body.messages[2]).not.toHaveProperty("replyCount");
      expect(body.messages[2]).not.toHaveProperty("lastReplyAt");
      expect(body.messages[2]).not.toHaveProperty("summaryRevision");
    } finally {
      await app.close();
    }
  });

  test("older room history rejects missing cursor without querying messages", async () => {
    const app = makeApp("owner");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/rooms/${ROOM_ID}/messages`,
      });
      expect(res.statusCode).toBe(400);
      expect(getRoomMessagesAcrossMemberSessions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("D430 Room search and around routes", () => {
  const searchUrl = `/api/rooms/${ROOM_ID}/messages/search?query=launch&mode=prefix`;

  test("enforces authentication then exact membership; Guest members need no read_memories", async () => {
    const unauthenticated = makeApp("owner", null);
    try {
      const response = await unauthenticated.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(401);
      expect(getRoomDetailForMember).not.toHaveBeenCalled();
      expect(searchRoomMessages).not.toHaveBeenCalled();
    } finally {
      await unauthenticated.close();
    }

    getUserCapabilitiesMock.mockImplementation(async () => []);
    const guest = makeApp("guest", "guest-user");
    try {
      const response = await guest.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ hits: [], asOf: null, nextOlderCursor: null, hasMoreOlder: false });
      expect(getRoomDetailForMember).toHaveBeenCalledWith(ROOM_ID, "guest-user");
      expect(searchRoomMessages).toHaveBeenCalled();
      const around = await guest.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/messages/1/around` });
      expect(around.statusCode).toBe(404);
      expect(getRoomMessagesAround).toHaveBeenCalled();
      expect(getUserCapabilitiesMock).not.toHaveBeenCalled();
    } finally {
      await guest.close();
    }

    getRoomDetailForMember.mockClear();
    searchRoomMessages.mockClear();
    getRoomDetailForMember.mockResolvedValueOnce(null);
    const nonmember = makeApp("guest", "other-guest");
    try {
      const response = await nonmember.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(404);
      expect(searchRoomMessages).not.toHaveBeenCalled();
    } finally {
      await nonmember.close();
    }
  });

  test("rejects malformed search and around inputs before membership/store reads", async () => {
    const app = makeApp("owner", "owner-user");
    try {
      for (const url of [
        `/api/rooms/${ROOM_ID}/messages/search?mode=whole`,
        `/api/rooms/${ROOM_ID}/messages/search?query=&mode=whole`,
        `/api/rooms/${ROOM_ID}/messages/search?query=%21%40%23&mode=whole`,
        `/api/rooms/${ROOM_ID}/messages/search?query=${"x".repeat(257)}&mode=whole`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=bad`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=whole&limit=51`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=whole&cursorCreatedAt=2026-01-01T00:00:00.000Z`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=whole&asOfMessageId=1`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=whole&cursorCreatedAt=2026-01-01T00:00:00.000Z&cursorMessageId=1`,
        `/api/rooms/${ROOM_ID}/messages/search?query=x&mode=whole&asOfCreatedAt=2026-01-01T00:00:00.000Z&asOfMessageId=1`,
        `/api/rooms/${ROOM_ID}/messages/0/around`,
        `/api/rooms/${ROOM_ID}/messages/2/around?limit=101`,
        `/api/rooms/not-a-uuid/messages/search?query=x&mode=whole`,
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(400);
      }
      expect(getRoomDetailForMember).not.toHaveBeenCalled();
      expect(searchRoomMessages).not.toHaveBeenCalled();
      expect(getRoomMessagesAround).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("checks membership before store reads and makes absent/non-member around responses identical", async () => {
    getRoomDetailForMember.mockResolvedValueOnce(null);
    const app = makeApp("owner", "owner-user");
    try {
      const search = await app.inject({ method: "GET", url: searchUrl });
      expect(search.statusCode).toBe(404);
      expect(searchRoomMessages).not.toHaveBeenCalled();

      getRoomDetailForMember.mockResolvedValueOnce({ id: ROOM_ID });
      getRoomMessagesAround.mockResolvedValueOnce(null);
      const absent = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/messages/7/around` });
      expect(absent.statusCode).toBe(404);
      expect(JSON.parse(absent.body)).toEqual({ error: "Not found" });

      getRoomDetailForMember.mockResolvedValueOnce(null);
      const nonMember = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/messages/7/around` });
      expect(nonMember.statusCode).toBe(404);
      expect(nonMember.body).toBe(absent.body);
      expect(getRoomMessagesAround).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test("passes complete cursor tuples and serializes bounded search and chronological around pages", async () => {
    const createdAt = new Date("2026-02-03T04:05:06.789Z");
    getRoomDetailForMember.mockResolvedValue({ id: ROOM_ID });
    searchRoomMessages.mockResolvedValueOnce({
      hits: [{
        messageId: 7,
        createdAt,
        role: "tool",
        snippet: "&lt;bounded&gt;",
        toolName: "lookup",
        sourceUserId: "source-user",
        authorAgentId: "agent-1",
        authorActorId: "actor-1",
        authorDisplayName: "Agent One",
        authorHandle: null,
      }],
      asOf: { createdAt, messageId: 9 },
      nextOlderCursor: { createdAt, messageId: 7 },
      hasMoreOlder: true,
    });
    getRoomMessagesAround.mockResolvedValueOnce({
      messages: [{ ...makeMessage("6", "assistant invocation"), toolCalls: '[{"id":"call"}]', createdAt }, { ...makeMessage("7", "tool result"), role: "tool", toolName: "lookup", createdAt }],
      target: { createdAt, messageId: 7 },
      includedToolCallCompanion: true,
      hasOlder: true,
      hasNewer: false,
    });
    const app = makeApp("owner", "owner-user");
    try {
      const search = await app.inject({
        method: "GET",
        url: `${searchUrl}&limit=3&cursorCreatedAt=2026-01-01T00:00:00.000Z&cursorMessageId=4&asOfCreatedAt=2026-01-02T00:00:00.000Z&asOfMessageId=9`,
      });
      expect(search.statusCode).toBe(200);
      expect(searchRoomMessages).toHaveBeenCalledWith({
        ownerId: "owner-user",
        roomId: ROOM_ID,
        query: "launch",
        mode: "prefix",
        ignoreCase: true,
        limit: 3,
        cursor: { createdAt: new Date("2026-01-01T00:00:00.000Z"), messageId: 4 },
        asOf: { createdAt: new Date("2026-01-02T00:00:00.000Z"), messageId: 9 },
      });
      const searchBody = JSON.parse(search.body) as { hits: Array<Record<string, unknown>>; asOf: Record<string, string> };
      expect(searchBody.hits[0]).toEqual({ messageId: "7", createdAt: createdAt.toISOString(), role: "tool", snippet: "&lt;bounded&gt;", toolName: "lookup", sourceUserId: "source-user", authorAgentId: "agent-1", authorActorId: "actor-1", authorDisplayName: "Agent One" });
      expect(searchBody.hits[0]).not.toHaveProperty("content");
      expect(searchBody.asOf).toEqual({ createdAt: createdAt.toISOString(), messageId: "9" });

      const around = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/messages/7/around?limit=2` });
      expect(around.statusCode).toBe(200);
      expect(getRoomMessagesAround).toHaveBeenCalledWith({ ownerId: "owner-user", roomId: ROOM_ID, messageId: 7, limit: 2 });
      const aroundBody = JSON.parse(around.body) as { messages: Array<Record<string, unknown>>; target: Record<string, string>; includedToolCallCompanion: boolean; hasOlder: boolean };
      expect(aroundBody.messages.map((message) => message["id"])).toEqual(["6", "7"]);
      expect(aroundBody.messages[0]?.["createdAt"]).toBe(createdAt.toISOString());
      expect(aroundBody.messages[0]?.["toolCalls"]).toBe('[{"id":"call"}]');
      expect(aroundBody.target).toEqual({ createdAt: createdAt.toISOString(), messageId: "7" });
      expect(aroundBody.includedToolCallCompanion).toBe(true);
      expect(aroundBody.hasOlder).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("D470 Chats search route", () => {
  const searchUrl = "/api/rooms/search?query=launch&mode=prefix";

  test("enforces authentication and capability before the one set-wise store read", async () => {
    const unauthenticated = makeApp("owner", null);
    try {
      const response = await unauthenticated.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(401);
      expect(searchChats).not.toHaveBeenCalled();
    } finally {
      await unauthenticated.close();
    }

    getUserCapabilitiesMock.mockImplementation(async () => []);
    const denied = makeApp("guest", "guest-user");
    try {
      const response = await denied.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        messageAsOf: null,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      });
      expect(searchChats).not.toHaveBeenCalled();
    } finally {
      await denied.close();
    }
  });

  test("rejects malformed input before the set-wise store read", async () => {
    const app = makeApp("owner", "owner-user");
    try {
      for (const url of [
        "/api/rooms/search?mode=whole",
        "/api/rooms/search?query=&mode=whole",
        "/api/rooms/search?query=%21%40%23&mode=whole",
        `/api/rooms/search?query=${"x".repeat(257)}&mode=whole`,
        "/api/rooms/search?query=x",
        "/api/rooms/search?query=x&mode=bad",
        "/api/rooms/search?query=x&mode=whole&archiveScope=deleted",
        "/api/rooms/search?query=x&mode=whole&ignoreCase=maybe",
        "/api/rooms/search?query=x&mode=whole&limit=51",
        "/api/rooms/search?query=x&mode=whole&cursorCreatedAt=2026-01-01T00:00:00.000Z",
        "/api/rooms/search?query=x&mode=whole&asOfMessageId=1",
        "/api/rooms/search?query=x&mode=whole&cursorCreatedAt=2026-01-01T00:00:00.000Z&cursorMessageId=1",
        "/api/rooms/search?query=x&mode=whole&asOfCreatedAt=2026-01-01T00:00:00.000Z&asOfMessageId=1",
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(400);
      }
      expect(searchChats).not.toHaveBeenCalled();
      expect(getRoomDetailForMember).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("issues one set-wise request and serializes conversation and Subthread metadata", async () => {
    const createdAt = new Date("2026-02-03T04:05:06.789Z");
    searchChats.mockResolvedValueOnce({
      conversations: [{
        room: {
          id: ROOM_ID,
          label: "Product planning",
          type: "private",
          graphThreadId: `room:${ROOM_ID}`,
          createdAt,
          memberCount: 2,
          kind: "private",
          parentRoomId: null,
          threadRootMessageId: null,
          roster: [{
            actorId: "actor-1",
            kind: "user",
            displayName: "Owner",
            handle: "owner",
            userId: "owner-user",
          }],
        },
        matchedBy: "participant",
      }],
      conversationsTruncated: true,
      messages: [{
        messageId: 7,
        createdAt,
        role: "tool",
        snippet: "&lt;bounded&gt;",
        toolName: "lookup",
        sourceUserId: "owner-user",
        authorAgentId: "agent-1",
        authorActorId: "actor-1",
        authorDisplayName: "Agent One",
        authorHandle: "agent-one",
        roomId: "child-room",
        roomLabel: "Thread",
        roomKind: "subthread",
        parentRoomId: ROOM_ID,
        parentRoomLabel: "Product planning",
      }],
      messageAsOf: { createdAt, messageId: 9 },
      nextOlderMessageCursor: { createdAt, messageId: 7 },
      hasMoreOlderMessages: true,
    });
    const app = makeApp("owner", "owner-user");
    try {
      const response = await app.inject({
        method: "GET",
        url: `${searchUrl}&limit=3&cursorCreatedAt=2026-01-01T00:00:00.000Z&cursorMessageId=4&asOfCreatedAt=2026-01-02T00:00:00.000Z&asOfMessageId=9`,
      });
      expect(response.statusCode).toBe(200);
      expect(searchChats).toHaveBeenCalledTimes(1);
      expect(searchChats).toHaveBeenCalledWith({
        ownerId: "owner-user",
        viewerActorId: "owner-user",
        query: "launch",
        mode: "prefix",
        archiveScope: "active",
        ignoreCase: true,
        limit: 3,
        cursor: { createdAt: new Date("2026-01-01T00:00:00.000Z"), messageId: 4 },
        asOf: { createdAt: new Date("2026-01-02T00:00:00.000Z"), messageId: 9 },
      });
      expect(getRoomDetailForMember).not.toHaveBeenCalled();
      expect(JSON.parse(response.body)).toEqual({
        conversations: [{
          room: {
            id: ROOM_ID,
            label: "Product planning",
            type: "private",
            graphThreadId: `room:${ROOM_ID}`,
            createdAt: createdAt.toISOString(),
            memberCount: 2,
            kind: "private",
            parentRoomId: null,
            threadRootMessageId: null,
            roster: [{
              actorId: "actor-1",
              kind: "user",
              displayName: "Owner",
              handle: "owner",
              userId: "owner-user",
            }],
          },
          matchedBy: "participant",
        }],
        conversationsTruncated: true,
        messages: [{
          messageId: "7",
          createdAt: createdAt.toISOString(),
          role: "tool",
          snippet: "&lt;bounded&gt;",
          toolName: "lookup",
          sourceUserId: "owner-user",
          authorAgentId: "agent-1",
          authorActorId: "actor-1",
          authorDisplayName: "Agent One",
          authorHandle: "agent-one",
          roomId: "child-room",
          roomLabel: "Thread",
          roomKind: "subthread",
          parentRoomId: ROOM_ID,
          parentRoomLabel: "Product planning",
        }],
        messageAsOf: { createdAt: createdAt.toISOString(), messageId: "9" },
        nextOlderMessageCursor: { createdAt: createdAt.toISOString(), messageId: "7" },
        hasMoreOlderMessages: true,
      });
    } finally {
      await app.close();
    }
  });

  test("passes through an empty no-result page with one request", async () => {
    const app = makeApp("owner", "owner-user");
    try {
      const response = await app.inject({ method: "GET", url: searchUrl });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        conversations: [],
        conversationsTruncated: false,
        messages: [],
        messageAsOf: null,
        nextOlderMessageCursor: null,
        hasMoreOlderMessages: false,
      });
      expect(searchChats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

afterAll(() => {
  setBootstrapOwnerId(PREV_OWNER_ENV);
  setBootstrapDefaultAgentId(PREV_AGENT_ENV);
});
