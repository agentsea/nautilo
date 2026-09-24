import { describe, expect, mock, spyOn, test } from "bun:test";
import Fastify from "fastify";
import type { RoomDetailPayload } from "@nautilo/trust";
import type { RoomPresenceResponse } from "@nautilo/types";
import type { WebSocket } from "ws";
import type { ResolveBearer, ResolveBearerResult } from "../../src/auth/resolve-bearer";
import { roomsRoutes, type RoomsRouteService } from "../../src/routes/rooms";
import { addClient } from "../../src/realtime/ws-publisher";
import { handleWsConnection } from "../../src/routes/ws";

const ROOM = "11111111-1111-4111-8111-111111111111";
const VIEWER = "actor:viewer";
const PEER = "actor:peer";
const AGENT = "actor:genie";

const detail = {
  id: ROOM,
  label: "Shared room",
  type: "shared",
  graphThreadId: `room:${ROOM}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  kind: "group",
  parentRoomId: null,
  threadRootMessageId: null,
  conductorMode: "standard",
  members: [
    { actorId: VIEWER, kind: "user", displayName: "Viewer", roomRole: "member" },
    { actorId: AGENT, kind: "agent", displayName: "Genie", roomRole: "member" },
    { actorId: PEER, kind: "user", displayName: "Peer", roomRole: "member" },
  ],
} as RoomDetailPayload;

function makeApp(options: {
  actorId?: string | null;
  userId?: string | null;
  getDetail?: (roomId: string, actorId: string) => Promise<RoomDetailPayload | null>;
}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  const getDetail = options.getDetail ?? mock(async () => detail);
  const capability = mock(async () => false);
  const service = {
    getRoomDetailForMember: getDetail,
    userHasCapability: capability,
  } as unknown as RoomsRouteService;
  app.addHook("preHandler", async (request) => {
    request.sessionActorId = options.actorId ?? null;
    request.sessionUserId = options.userId ?? null;
    request.policyContext = { actorRole: "member" } as typeof request.policyContext;
  });
  roomsRoutes(app, service);
  return { app, getDetail, capability };
}

function connectPeer() {
  let closeHandler = () => {};
  const socket = {
    OPEN: 1,
    readyState: 1,
    on(event: string, handler: () => void) { if (event === "close") closeHandler = handler; },
    close() { this.readyState = 3; closeHandler(); },
  };
  addClient(socket as unknown as WebSocket, {
    userId: "user:peer", actorId: PEER, roomIds: new Set([ROOM]),
  });
  return socket;
}

async function authenticateHuman(actorId: string) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    OPEN: 1,
    readyState: 1,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    send(_frame: string) {},
    close() {
      this.readyState = 3;
      for (const handler of handlers.get("close") ?? []) handler();
    },
    emit(frame: object) {
      for (const handler of handlers.get("message") ?? []) handler(Buffer.from(JSON.stringify(frame)));
    },
  };
  const resolveBearer = (async () => ({
    ok: true,
    depth: "policy",
    sessionUserId: `user:${actorId}`,
    sessionActorId: actorId,
    policyContext: { actorRole: "member" },
  }) as ResolveBearerResult) as ResolveBearer;
  handleWsConnection(socket as unknown as WebSocket, resolveBearer, {
    addClient, onVoiceStop: () => {}, authTimeoutMs: 5_000,
    listRoomsForActor: async () => [{ id: ROOM }],
  });
  socket.emit({ type: "auth", token: "test" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return socket;
}

describe("GET /api/rooms/:id/presence", () => {
  test("two authenticated Humans transition Online, Idle, and Offline through the Room read", async () => {
    const now = spyOn(Date, "now").mockReturnValue(5_000_000);
    const viewer = await authenticateHuman(VIEWER);
    const peer = await authenticateHuman(PEER);
    const { app } = makeApp({ actorId: VIEWER, userId: "user:viewer" });
    const read = async () => {
      const response = await app.inject({ method: "GET", url: `/api/rooms/${ROOM}/presence` });
      expect(response.statusCode).toBe(200);
      return response.json<RoomPresenceResponse>();
    };
    try {
      expect((await read()).members).toEqual([
        { actorId: VIEWER, status: "online" },
        { actorId: PEER, status: "online" },
      ]);
      now.mockReturnValue(5_000_100);
      peer.emit({ type: "ping", idle: true, actorId: VIEWER });
      expect((await read()).members).toEqual([
        { actorId: VIEWER, status: "online" },
        { actorId: PEER, status: "idle" },
      ]);
      peer.close();
      expect((await read()).members).toEqual([
        { actorId: VIEWER, status: "online" },
        { actorId: PEER, status: "offline" },
      ]);
    } finally {
      viewer.close();
      peer.close();
      now.mockRestore();
      await app.close();
    }
  });

  test("an ordinary member sees only current Human roster, in roster order", async () => {
    const socket = connectPeer();
    const { app, getDetail, capability } = makeApp({ actorId: VIEWER, userId: "user:viewer" });
    try {
      const response = await app.inject({ method: "GET", url: `/api/rooms/${ROOM}/presence` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<RoomPresenceResponse>()).toEqual({ members: [
        { actorId: VIEWER, status: "offline" },
        { actorId: PEER, status: "online" },
      ] });
      expect(getDetail).toHaveBeenCalledWith(ROOM, VIEWER);
      expect(capability).not.toHaveBeenCalled();
    } finally {
      socket.close();
      await app.close();
    }
  });

  test("membership removal denies the read despite an active peer socket", async () => {
    const socket = connectPeer();
    const getDetail = mock(async () => null);
    const { app } = makeApp({ actorId: VIEWER, userId: "user:viewer", getDetail });
    try {
      const response = await app.inject({ method: "GET", url: `/api/rooms/${ROOM}/presence` });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>()).toEqual({ error: "Not found" });
      expect(getDetail).toHaveBeenCalledWith(ROOM, VIEWER);
    } finally {
      socket.close();
      await app.close();
    }
  });

  test("missing Human session or malformed Room ID is denied before member query", async () => {
    const { app, getDetail } = makeApp({ actorId: VIEWER, userId: null });
    try {
      expect((await app.inject({ method: "GET", url: `/api/rooms/${ROOM}/presence` })).statusCode)
        .toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/rooms/not-a-uuid/presence" })).statusCode)
        .toBe(404);
      expect(getDetail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
