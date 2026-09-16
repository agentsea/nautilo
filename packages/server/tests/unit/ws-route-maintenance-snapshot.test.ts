/**
 * D420 (Wave 3 task 3.2.1) — unit tests for the authenticated-connect
 * `maintenance.status` snapshot sent inside `handleWsConnection`.
 *
 * Protection targets:
 *   - after auth.accepted, a current snapshot frame is delivered so a client
 *     that missed a live event starts truthful;
 *   - pre-auth sockets receive nothing;
 *   - a snapshot read failure (provider throws) or a null result MUST NOT
 *     poison the connection: auth.accepted still lands, no fabricated frame
 *     is sent, and the socket stays admitted (open).
 */
import { describe, expect, mock, test } from "bun:test";
import { handleWsConnection } from "../../src/routes/ws";
import type { ResolveBearer, ResolveBearerPolicyOk } from "../../src/auth/resolve-bearer";
import type { MaintenanceStatusEvent } from "@nautilo/types";
import type { RuntimePolicyContext } from "@nautilo/trust";
import type { WebSocket as WsSocket } from "ws";

interface SentFrame {
  type: string;
  [k: string]: unknown;
}

interface FakeSocket {
  readyState: number;
  readonly OPEN: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  sent: SentFrame[];
  closes: Array<{ code?: number | undefined; reason?: string | undefined }>;
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: SentFrame[] = [];
  const closes: Array<{ code?: number | undefined; reason?: string | undefined }> = [];
  const socket: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    sent,
    closes,
    send(data: string) {
      sent.push(JSON.parse(data) as SentFrame);
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
      socket.readyState = 3;
      const list = handlers.get("close") ?? [];
      for (const fn of list) fn();
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      for (const fn of list) fn(...args);
    },
  };
  return socket;
}

const FAKE_CTX = { actorRole: "owner" } as unknown as RuntimePolicyContext;
const emptyRoomList = async (_actorId: string): Promise<Array<{ id: string }>> => [];

const okResult: ResolveBearerPolicyOk = {
  ok: true,
  depth: "policy",
  principal: {} as ResolveBearerPolicyOk["principal"],
  rbacProjection: {} as ResolveBearerPolicyOk["rbacProjection"],
  policyContext: FAKE_CTX,
  memoryEnvelope: { ownerId: "o" } as unknown as ResolveBearerPolicyOk["memoryEnvelope"],
  sessionActorId: "actor-1",
  sessionUserId: "user-1",
  accessTokenIssuedAt: null,
  accessTokenExpiresAt: null,
};

function fakeOkBearer(): ResolveBearer {
  return mock(async () => okResult);
}

const DRAINING_EVENT: MaintenanceStatusEvent = {
  type: "maintenance.status",
  state: "draining",
  operationId: "op-snap",
  leaseExpiresAt: "2026-07-14T12:05:00.000Z",
  hardExpiresAt: "2026-07-14T12:30:00.000Z",
};

async function authAndWait(socket: FakeSocket): Promise<void> {
  socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "valid" })));
  await new Promise((r) => setTimeout(r, 15));
}

describe("handleWsConnection maintenance.status connect snapshot (D420 3.2.1)", () => {
  test("after auth.accepted, the snapshot frame is delivered", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const provider = mock(async (): Promise<MaintenanceStatusEvent | null> => DRAINING_EVENT);
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      getMaintenanceStatusEvent: provider,
    });
    await authAndWait(socket);

    expect(socket.sent.find((m) => m.type === "auth.accepted")).toBeDefined();
    const snap = socket.sent.find((m) => m.type === "maintenance.status");
    expect(snap).toMatchObject({
      type: "maintenance.status",
      state: "draining",
      operationId: "op-snap",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("snapshot frame is payload-free (no work/job/prompt/user fields)", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      getMaintenanceStatusEvent: async () => DRAINING_EVENT,
    });
    await authAndWait(socket);

    const snap = socket.sent.find((m) => m.type === "maintenance.status");
    expect(snap).toBeDefined();
    const wire = JSON.stringify(snap);
    for (const forbidden of ["work", "jobId", "prompt", "laneKey", "userId", "actorId"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  test("provider returning null → no snapshot frame, auth.accepted still lands", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const provider = mock(async (): Promise<MaintenanceStatusEvent | null> => null);
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      getMaintenanceStatusEvent: provider,
    });
    await authAndWait(socket);

    expect(socket.sent.find((m) => m.type === "auth.accepted")).toBeDefined();
    expect(socket.sent.find((m) => m.type === "maintenance.status")).toBeUndefined();
    expect(socket.closes).toHaveLength(0);
    expect(socket.readyState).toBe(socket.OPEN);
  });

  test("provider throwing → no snapshot frame, connection admitted (not poisoned)", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const provider = mock(async (): Promise<MaintenanceStatusEvent | null> => {
      throw new Error("db unavailable");
    });
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      getMaintenanceStatusEvent: provider,
    });
    await authAndWait(socket);

    // auth already succeeded — the snapshot failure must NOT close the socket
    // or fabricate a frame. The client stays admitted and truthful.
    expect(socket.sent.find((m) => m.type === "auth.accepted")).toBeDefined();
    expect(socket.sent.find((m) => m.type === "maintenance.status")).toBeUndefined();
    expect(socket.closes).toHaveLength(0);
    expect(socket.readyState).toBe(socket.OPEN);
    expect(addClient).toHaveBeenCalledTimes(1);
  });

  test("no provider wired → no snapshot frame (backward-compatible seam)", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    await authAndWait(socket);

    expect(socket.sent.find((m) => m.type === "auth.accepted")).toBeDefined();
    expect(socket.sent.find((m) => m.type === "maintenance.status")).toBeUndefined();
  });

  test("pre-auth socket receives no maintenance.status frame", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const provider = mock(async (): Promise<MaintenanceStatusEvent | null> => DRAINING_EVENT);
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      getMaintenanceStatusEvent: provider,
    });
    // A short pre-auth window — the snapshot is gated on auth.accepted.
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.sent.find((m) => m.type === "maintenance.status")).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    expect(addClient).not.toHaveBeenCalled();
  });
});
