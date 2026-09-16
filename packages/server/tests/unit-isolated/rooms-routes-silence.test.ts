/**
 * D279 Phase 3.5 — `/api/rooms/:roomId/silence` routes (hermetic).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { roomsRoutes, type RoomsRouteService } from "../../src/routes/rooms";
import type { RoomDetailPayload } from "@nautilo/trust";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const BOT_ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_BOT_ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVE_BOT_ACTOR_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_FOCUS_ID = "88888888-8888-4888-8888-888888888888";

const SILENCE_PAYLOAD = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "mute" as const,
  botActorId: null,
  botDisplayName: null,
  setByDisplayName: "Room Admin",
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
};

const getSpy = mock(
  (_roomId: string, _requester: string) => Promise.resolve<RoomDetailPayload | null>(null),
);
const loadActiveRoomSilenceMock = mock(async () => SILENCE_PAYLOAD as typeof SILENCE_PAYLOAD | null);
const setRoomSilenceMock = mock(async () => SILENCE_PAYLOAD);
const clearRoomSilenceMock = mock(async () => ({ cleared: 1 }));
const updateRoomConductorModeMock = mock(
  async (_roomId: string, _mode: "advanced" | "standard") => true,
);
const loadActiveFociMock = mock(async () => [] as Array<{
  focusId: string;
  botActorId: string;
  expiresAt: Date;
  openedSource: "mention" | "reply" | "ui" | "inferred";
}>);
const loadRecentFocusBotActorIdsMock = mock(async () => [] as string[]);
const openOrExtendFocusMock = mock(
  async (
    _db: unknown,
    _args: {
      roomId: string;
      userActorId: string;
      botActorId: string;
      source: "mention" | "reply" | "ui" | "inferred";
      reason?: string;
    },
  ) => ({
    focusId: "88888888-8888-4888-8888-888888888888",
    expiresAt: new Date("2026-06-12T12:01:30.000Z"),
    created: true,
  }),
);
const clearFocusMock = mock(
  async (
    _db: unknown,
    _args: {
      roomId: string;
      userActorId: string;
      focusId: string;
      reason?: string;
    },
  ) => ({ botActorId: OTHER_BOT_ACTOR_ID }),
);
const getUserCapabilitiesMock = mock(async () => ["read_memories", "manage_rooms"]);
const assertCallerCanManageRoomMock = mock(async () => ({ role: "owner" as const }));
const sharedDbMock = { select: mock(() => ({ from: mock(() => ({ where: mock(() => ({ limit: mock(async () => []) })) })) })) };

beforeAll(() => {
  bootstrapTestDbInstance();
});

mock.module("@nautilo/db", () => ({
  getSharedDirectDb: () => sharedDbMock,
}));

mock.module("../../../trust/src/room-silence", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("../../../trust/src/room-silence") as Record<string, unknown>;
  return {
    ...real,
    loadActiveRoomSilence: loadActiveRoomSilenceMock,
    setRoomSilence: setRoomSilenceMock,
    clearRoomSilence: clearRoomSilenceMock,
  };
});

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    getUserCapabilities: getUserCapabilitiesMock,
    updateRoomConductorMode: updateRoomConductorModeMock,
    loadActiveFoci: loadActiveFociMock,
    loadRecentFocusBotActorIds: loadRecentFocusBotActorIdsMock,
    openOrExtendFocus: openOrExtendFocusMock,
    clearFocus: clearFocusMock,
  };
});

mock.module("../../src/lib/agent-room-authz", () => ({
  assertCallerCanManageRoom: assertCallerCanManageRoomMock,
  ManageForbiddenError: class ManageForbiddenError extends Error {
    constructor() {
      super("forbidden");
      this.name = "ManageForbiddenError";
    }
  },
}));

function roomDetail(): RoomDetailPayload {
  return {
    id: ROOM_ID,
    label: "Test",
    type: "private",
    graphThreadId: `room:${ROOM_ID}`,
    createdAt: "2020-01-01T00:00:00.000Z",
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    conductorMode: "standard",
    members: [
      {
        actorId: ACTOR_ID,
        kind: "user",
        displayName: "Room Admin",
        userId: USER_ID,
        roomRole: "admin",
      },
      {
        actorId: BOT_ACTOR_ID,
        kind: "agent",
        displayName: "Genie",
        agentId: "agent-1",
        roomRole: "member",
      },
      {
        actorId: OTHER_BOT_ACTOR_ID,
        kind: "agent",
        displayName: "Jeannie",
        agentId: "agent-2",
        roomRole: "member",
      },
      {
        actorId: OBSERVE_BOT_ACTOR_ID,
        kind: "agent",
        displayName: "Observer",
        agentId: "agent-observer",
        roomRole: "member",
        agentResponseMode: "observe",
      },
    ],
  };
}

function makeApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  const service: RoomsRouteService = {
    listRoomsForActor: mock(async () => []),
    getRoomDetailForMember: getSpy,
    createRoomForOwner: mock(async () => roomDetail()),
    renamePrivateRoomForOwner: mock(async () => null),
    listManageableRoomsForUser: mock(async () => []),
    getRoomDetailForManager: mock(async () => null),
  };
  roomsRoutes(app, service);
  app.addHook("preHandler", async (request) => {
    (request as { sessionActorId?: string | null }).sessionActorId = ACTOR_ID;
    (request as { sessionUserId?: string | null }).sessionUserId = USER_ID;
  });
  return app;
}

afterAll(() => {
  mock.restore();
});

describe("rooms silence routes (D279 3.5)", () => {
  beforeEach(() => {
    getSpy.mockClear();
    getSpy.mockImplementation(async () => roomDetail());
    loadActiveRoomSilenceMock.mockClear();
    loadActiveRoomSilenceMock.mockImplementation(async () => SILENCE_PAYLOAD);
    setRoomSilenceMock.mockClear();
    setRoomSilenceMock.mockImplementation(async () => SILENCE_PAYLOAD);
    clearRoomSilenceMock.mockClear();
    clearRoomSilenceMock.mockImplementation(async () => ({ cleared: 1 }));
    updateRoomConductorModeMock.mockClear();
    updateRoomConductorModeMock.mockImplementation(async () => true);
    loadActiveFociMock.mockClear();
    loadActiveFociMock.mockImplementation(async () => []);
    loadRecentFocusBotActorIdsMock.mockClear();
    loadRecentFocusBotActorIdsMock.mockImplementation(async () => []);
    openOrExtendFocusMock.mockClear();
    openOrExtendFocusMock.mockImplementation(async () => ({
      focusId: "88888888-8888-4888-8888-888888888888",
      expiresAt: new Date("2026-06-12T12:01:30.000Z"),
      created: true,
    }));
    clearFocusMock.mockClear();
    clearFocusMock.mockImplementation(async () => ({ botActorId: OTHER_BOT_ACTOR_ID }));
    assertCallerCanManageRoomMock.mockClear();
    assertCallerCanManageRoomMock.mockImplementation(async () => ({ role: "owner" }));
  });

  afterEach(() => {
    loadActiveRoomSilenceMock.mockImplementation(async () => SILENCE_PAYLOAD);
  });

  test("GET silence — member sees active window + canManage", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/silence` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ silence: SILENCE_PAYLOAD, canManage: true });
    expect(loadActiveRoomSilenceMock.mock.calls.length).toBe(1);
  });

  test("GET silence — non-member 404", async () => {
    getSpy.mockImplementationOnce(async () => null);
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/silence` });
    expect(res.statusCode).toBe(404);
  });

  test("POST silence — manager sets mute window", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/silence`,
      payload: { kind: "mute", durationMs: 1_800_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ silence: SILENCE_PAYLOAD });
    expect(setRoomSilenceMock.mock.calls.length).toBe(1);
  });

  test("POST silence — forbidden without manage rights", async () => {
    const { ManageForbiddenError } = await import("../../src/lib/agent-room-authz");
    assertCallerCanManageRoomMock.mockImplementationOnce(async () => {
      throw new ManageForbiddenError();
    });
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/silence`,
      payload: { kind: "deaf" },
    });
    expect(res.statusCode).toBe(403);
    expect(setRoomSilenceMock.mock.calls.length).toBe(0);
  });

  test("DELETE silence — clears active windows", async () => {
    loadActiveRoomSilenceMock.mockImplementationOnce(async () => null);
    const app = makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${ROOM_ID}/silence`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, cleared: 1, silence: null });
    expect(clearRoomSilenceMock.mock.calls.length).toBe(1);
  });

  test("POST conductor-mode — manager sets standard mode", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/conductor-mode`,
      payload: { conductorMode: "standard" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ conductorMode: "standard" });
    expect(updateRoomConductorModeMock.mock.calls).toHaveLength(1);
    expect(updateRoomConductorModeMock.mock.calls[0]).toEqual([ROOM_ID, "standard"]);
  });

  test("POST conductor-mode — rejects invalid mode", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/conductor-mode`,
      payload: { conductorMode: "banana" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateRoomConductorModeMock.mock.calls.length).toBe(0);
  });

  test("POST conductor-mode — forbidden without manage rights", async () => {
    const { ManageForbiddenError } = await import("../../src/lib/agent-room-authz");
    assertCallerCanManageRoomMock.mockImplementationOnce(async () => {
      throw new ManageForbiddenError();
    });
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/conductor-mode`,
      payload: { conductorMode: "advanced" },
    });
    expect(res.statusCode).toBe(403);
    expect(updateRoomConductorModeMock.mock.calls.length).toBe(0);
  });

  test("POST focus — UI selection clears other active foci before opening target", async () => {
    loadActiveFociMock.mockImplementationOnce(async () => [
      {
        focusId: OTHER_FOCUS_ID,
        botActorId: OTHER_BOT_ACTOR_ID,
        expiresAt: new Date("2026-06-12T12:01:00.000Z"),
        openedSource: "inferred",
      },
      {
        focusId: "99999999-9999-4999-8999-999999999999",
        botActorId: BOT_ACTOR_ID,
        expiresAt: new Date("2026-06-12T12:01:00.000Z"),
        openedSource: "ui",
      },
    ]);
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/focus`,
      payload: { botActorId: BOT_ACTOR_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      botActorId: BOT_ACTOR_ID,
      clearedBotActorIds: [OTHER_BOT_ACTOR_ID],
    });
    expect(clearFocusMock.mock.calls).toHaveLength(1);
    expect(clearFocusMock.mock.calls[0]?.[1]).toMatchObject({
      roomId: ROOM_ID,
      userActorId: ACTOR_ID,
      focusId: OTHER_FOCUS_ID,
      reason: "ui selection switched focus",
    });
    expect(openOrExtendFocusMock.mock.calls).toHaveLength(1);
    expect(openOrExtendFocusMock.mock.calls[0]?.[1]).toMatchObject({
      roomId: ROOM_ID,
      userActorId: ACTOR_ID,
      botActorId: BOT_ACTOR_ID,
      source: "ui",
    });
  });

  test("GET focus returns only this requester's eligible-room recent Genie access", async () => {
    loadRecentFocusBotActorIdsMock.mockImplementationOnce(async () => [
      OTHER_BOT_ACTOR_ID,
      OBSERVE_BOT_ACTOR_ID,
      "not-a-member",
      BOT_ACTOR_ID,
    ]);
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}/focus` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      foci: [],
      recentBotActorIds: [OTHER_BOT_ACTOR_ID, BOT_ACTOR_ID],
    });
    expect(loadRecentFocusBotActorIdsMock).toHaveBeenCalledWith(sharedDbMock, ACTOR_ID);
  });
});
