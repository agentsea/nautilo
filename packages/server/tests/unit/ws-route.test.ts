/**
 * `/ws` first-message authentication.
 *
 * Drives the per-connection state machine via the exported
 * `handleWsConnection` so the test never touches a real WS upgrade.
 * A scriptable fake `WebSocket` records sent frames + close calls;
 * the `addClient` and `onVoiceStop` hooks are spied on directly.
 *
 * Three branches under test:
 *   - timeout / wrong-first-frame / malformed first frame
 *   - invalid token (resolveBearer returns !ok)
 *   - happy path → addClient called, voice.stop reaches the spy
 *     ONLY after auth, ping → pong round-trip works
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  handleWsConnection,
  WS_AUTH_CLOSE_CODE,
  getWsPolicyContext,
} from "../../src/routes/ws";
import type { ResolveBearer, ResolveBearerResult } from "../../src/auth/resolve-bearer";
import type { RuntimePolicyContext } from "@nautilo/trust";
import type { WebSocket as WsSocket } from "ws";
import {
  ClientActionBindingRegistry,
  installClientActionBindingRegistry,
} from "../../src/realtime/client-action-binding-registry";

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
  // Inspection
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
      // Mirror real WS — close fires its own "close" event listeners.
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

const FAKE_PRINCIPAL = {
  logtoSub: "sub",
  userId: "user-1",
  disabledAt: null,
  actorId: "actor-1",
  actorDisplayName: "Actor",
  handle: "user",
  displayName: "User",
  server: "server",
  federatedId: "@user@server",
  workbenchChannelBinding: null,
  personalAgent: null,
};

const okResult: ResolveBearerResult = {
  ok: true,
  depth: "policy",
  principal: FAKE_PRINCIPAL,
  rbacProjection: {
    highestRole: null,
    capabilitySlugs: [],
    groupChips: [],
  },
  policyContext: FAKE_CTX,
  memoryEnvelope: { ownerId: "o" } as unknown as ResolveBearerResult extends {
    memoryEnvelope: infer M;
  }
    ? M
    : never,
  sessionActorId: "actor-1",
  sessionUserId: "user-1",
  accessTokenIssuedAt: null,
  accessTokenExpiresAt: null,
};

function fakeOkBearer(): ResolveBearer {
  return mock(async () => okResult);
}

function fakeBadBearer(): ResolveBearer {
  return mock(async () => ({ ok: false, reason: "logto.revoked" }) as ResolveBearerResult);
}

afterEach(() => {
  /* per-test fakes only — nothing global to reset */
});

describe("handleWsConnection ()", () => {
  test("auth timeout → relay-style close with 4401 + auth.rejected:auth_timeout, addClient NOT called", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 10,
      listRoomsForActor: emptyRoomList,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.sent.find((m) => m.type === "auth.rejected")).toMatchObject({
      type: "auth.rejected",
      error: "auth_timeout",
    });
    expect(socket.closes[0]?.code).toBe(WS_AUTH_CLOSE_CODE);
    expect(addClient).not.toHaveBeenCalled();
  });

  test("non-auth first frame → auth.rejected:auth_required + 4401 close, no addClient", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));
    await new Promise((r) => setTimeout(r, 5));
    expect(socket.sent.find((m) => m.type === "auth.rejected")).toMatchObject({
      type: "auth.rejected",
      error: "auth_required",
    });
    expect(socket.closes[0]?.code).toBe(WS_AUTH_CLOSE_CODE);
    expect(addClient).not.toHaveBeenCalled();
  });

  test("malformed first frame → close 1003, no auth.rejected payload", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    socket.emit("message", Buffer.from("{not json"));
    await new Promise((r) => setTimeout(r, 5));
    expect(socket.sent.length).toBe(0);
    expect(socket.closes[0]?.code).toBe(1003);
    expect(addClient).not.toHaveBeenCalled();
  });

  test("auth with bad token → auth.rejected:invalid_token + 4401, no addClient", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeBadBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "junk" })),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(socket.sent.find((m) => m.type === "auth.rejected")).toMatchObject({
      type: "auth.rejected",
      error: "invalid_token",
    });
    expect(socket.sent.find((m) => m.type === "client.session.v1")).toBeUndefined();
    expect(socket.closes[0]?.code).toBe(WS_AUTH_CLOSE_CODE);
    expect(addClient).not.toHaveBeenCalled();
  });

  test("happy path: auth.accepted sent, addClient called, policy context attached", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const listRooms = mock(emptyRoomList);
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: listRooms,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.sent.find((m) => m.type === "auth.accepted")).toBeDefined();
    expect(addClient).toHaveBeenCalledTimes(1);
    expect(listRooms).toHaveBeenCalledWith("actor-1", {
      includeRoster: false,
      includeSubthreads: true,
    });
    expect(getWsPolicyContext(socket as unknown as WsSocket)).toBe(FAKE_CTX);
  });

  test("device admission rejects before room lookup and client registration", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const listRooms = mock(emptyRoomList);
    const checkDeviceAdmission = mock(async () => ({
      status: "required" as const,
      reason: "device_removed_or_stale" as const,
    }));
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: listRooms,
      checkDeviceAdmission,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(checkDeviceAdmission).toHaveBeenCalledWith({
      credentialDigestBase64url:
        "7GVPrJWZ9i554nBqvvI9-3wHwIGFqobbTYaV8LcY0bM",
      userId: "user-1",
      humanActorId: "actor-1",
    });
    expect(socket.sent.find((frame) => frame.type === "auth.rejected"))
      .toMatchObject({ error: "device_removed_or_stale" });
    expect(socket.sent.find((frame) => frame.type === "auth.accepted"))
      .toBeUndefined();
    expect(listRooms).not.toHaveBeenCalled();
    expect(addClient).not.toHaveBeenCalled();
  });

  test("device admission allows the existing WebSocket path unchanged", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const checkDeviceAdmission = mock(async () => ({ status: "admitted" as const }));
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      checkDeviceAdmission,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(socket.sent.find((frame) => frame.type === "auth.accepted")).toBeDefined();
    expect(addClient).toHaveBeenCalledTimes(1);
  });

  test("an open socket closes when its admitted device becomes stale", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    let checks = 0;
    const checkDeviceAdmission = mock(async () => {
      checks += 1;
      return checks === 1
        ? { status: "admitted" as const }
        : {
          status: "required" as const,
          reason: "device_removed_or_stale" as const,
        };
    });
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      checkDeviceAdmission,
      deviceAdmissionRecheckMs: 5,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.sent.find((frame) => frame.type === "auth.accepted"))
      .toBeDefined();
    expect(socket.sent.find((frame) =>
      frame.type === "auth.rejected"
      && frame["error"] === "device_removed_or_stale"
    )).toBeDefined();
    expect(socket.closes.at(-1)).toEqual({
      code: WS_AUTH_CLOSE_CODE,
      reason: "device_removed_or_stale",
    });
  });

  test("mints one socket-local client session only after auth.accepted and rotates per connection", async () => {
    const first = makeFakeSocket();
    const second = makeFakeSocket();
    const connect = async (socket: FakeSocket): Promise<string> => {
      handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
        addClient: () => {},
        onVoiceStop: () => {},
        authTimeoutMs: 5_000,
        listRoomsForActor: emptyRoomList,
      });
      expect(socket.sent.find((frame) => frame.type === "client.session.v1")).toBeUndefined();
      socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "valid" })));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const acceptedAt = socket.sent.findIndex((frame) => frame.type === "auth.accepted");
      const controlAt = socket.sent.findIndex((frame) => frame.type === "client.session.v1");
      expect(acceptedAt).toBeGreaterThanOrEqual(0);
      expect(controlAt).toBeGreaterThan(acceptedAt);
      const control = socket.sent[controlAt] as { clientActionSessionId?: unknown };
      expect(control.clientActionSessionId).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/u,
      );
      return control.clientActionSessionId as string;
    };
    expect(await connect(first)).not.toBe(await connect(second));
  });

  test("stores a closed auth-frame surface beside the fresh live session", async () => {
    const registry = new ClientActionBindingRegistry();
    const uninstall = installClientActionBindingRegistry(registry);
    const connect = async (surface: unknown): Promise<unknown> => {
      const socket = makeFakeSocket();
      handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
        addClient: () => {}, onVoiceStop: () => {}, authTimeoutMs: 5_000, listRoomsForActor: emptyRoomList,
      });
      socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "valid", initiatingClientSurface: surface })));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const sessionId = socket.sent.find((frame) => frame.type === "client.session.v1")?.["clientActionSessionId"];
      const handle = registry.reserve({ clientActionSessionId: sessionId, actorId: "actor-1" });
      return handle ? registry.coalescingContextForHandle(handle)?.initiatingClientSurface : undefined;
    };
    try {
      expect(await connect("mobile.web")).toBe("mobile.web");
      expect(await connect("forged.surface")).toBe("unknown");
      expect(await connect(undefined)).toBe("unknown");
    } finally {
      uninstall();
    }
  });

  test("close during room lookup unregisters the unpublished client session", async () => {
    const socket = makeFakeSocket();
    const registry = new ClientActionBindingRegistry();
    const uninstall = installClientActionBindingRegistry(registry);
    const rooms = Promise.withResolvers<Array<{ id: string }>>();
    try {
      handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
        addClient: () => {},
        onVoiceStop: () => {},
        authTimeoutMs: 5_000,
        listRoomsForActor: async () => rooms.promise,
      });
      socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "valid" })));
      await new Promise((resolve) => setTimeout(resolve, 1));
      socket.close();
      rooms.resolve([]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(socket.sent.find((frame) => frame.type === "client.session.v1")).toBeUndefined();
      expect(registry.reserve({
        clientActionSessionId: "AAAAAAAAAAAAAAAAAAAAAA",
        actorId: "actor-1",
      })).toBeNull();
    } finally {
      uninstall();
    }
  });

  test("voice.stop BEFORE auth → ignored; AFTER auth → reaches spy", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const onVoiceStop = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop,
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });

    // Pre-auth voice.stop — treated as a non-auth first frame and
    // closes the socket with auth_required. The spy must NOT fire.
    socket.emit("message", Buffer.from(JSON.stringify({ type: "voice.stop" })));
    await new Promise((r) => setTimeout(r, 5));
    expect(onVoiceStop).not.toHaveBeenCalled();
  });

  test("post-auth: voice.stop reaches spy, ping → pong round-trip", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const onVoiceStop = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop,
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(addClient).toHaveBeenCalledTimes(1);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "voice.stop" })));
    expect(onVoiceStop).toHaveBeenCalledTimes(1);
    expect(onVoiceStop).toHaveBeenLastCalledWith("user-1", undefined);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "voice.stop", userId: "foreign-user", turnId: "turn-a" })));
    expect(onVoiceStop).toHaveBeenLastCalledWith("user-1", "turn-a");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "voice.stop", turnId: 42 })));
    expect(onVoiceStop).toHaveBeenCalledTimes(2);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));
    const pong = socket.sent.find((m) => m.type === "pong");
    expect(pong).toBeDefined();
    expect(typeof pong?.["timestamp"]).toBe("number");
  });

  test("close before auth fires → policy context cleared (WeakMap delete)", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "auth", token: "valid" })),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(getWsPolicyContext(socket as unknown as WsSocket)).toBe(FAKE_CTX);
    socket.close();
    expect(getWsPolicyContext(socket as unknown as WsSocket)).toBeUndefined();
  });

  test("remote.host.resume is authenticated, user-scoped, and sends only its snapshot/replay", async () => {
    const socket = makeFakeSocket();
    const addClient = mock(() => {});
    const resumeForUser = mock(async (userId: string, cursor: unknown) => {
      expect(userId).toBe("user-1");
      expect(cursor).toEqual({ streamId: "stream-a", sequence: 4, snapshotRevision: 3 });
      return [
        {
          type: "remote.host.snapshot" as const,
          hosts: [],
          cursor: { streamId: "stream-a", sequence: 5, snapshotRevision: 3 },
        },
      ];
    });
    handleWsConnection(socket as unknown as WsSocket, fakeOkBearer(), {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: emptyRoomList,
      remoteHostPresenceStream: { resumeForUser },
    });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "valid" })));
    await new Promise((r) => setTimeout(r, 5));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "remote.host.resume",
          cursor: { streamId: "stream-a", sequence: 4, snapshotRevision: 3 },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(resumeForUser).toHaveBeenCalledTimes(1);
    expect(socket.sent.find((frame) => frame.type === "remote.host.snapshot")).toMatchObject({
      hosts: [],
      cursor: { streamId: "stream-a", sequence: 5, snapshotRevision: 3 },
    });
  });
});
