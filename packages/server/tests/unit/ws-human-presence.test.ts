import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { WebSocket } from "ws";
import type { ResolveBearer, ResolveBearerResult } from "../../src/auth/resolve-bearer";
import { addClient, readHumanPresence, recordClientPing } from "../../src/realtime/ws-publisher";
import { handleWsConnection } from "../../src/routes/ws";

type Socket = {
  OPEN: number;
  readyState: number;
  on: (event: string, handler: () => void) => void;
  close: () => void;
};

const sockets: Socket[] = [];
function connect(actorId: string, userId = `user:${actorId}`): Socket {
  let onClose = () => {};
  const socket: Socket = {
    OPEN: 1,
    readyState: 1,
    on(event, handler) { if (event === "close") onClose = handler; },
    close() { this.readyState = 3; onClose(); },
  };
  sockets.push(socket);
  addClient(socket as unknown as WebSocket, { actorId, userId, roomIds: new Set() });
  return socket;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  spyOn(Date, "now").mockRestore();
});

describe("Human chat socket presence", () => {
  test("only an authenticated socket's ping changes its server-bound Human identity", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const sent: Array<{ type: string }> = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      send(frame: string) { sent.push(JSON.parse(frame) as { type: string }); },
      close() {
        this.readyState = 3;
        for (const handler of handlers.get("close") ?? []) handler();
      },
      emit(frame: object) {
        for (const handler of handlers.get("message") ?? []) handler(Buffer.from(JSON.stringify(frame)));
      },
    };
    sockets.push(socket);
    const now = spyOn(Date, "now").mockReturnValue(4_000_000);
    const other = connect("human:other");
    const resolveBearer = (async () => ({
      ok: true,
      depth: "policy",
      sessionUserId: "user:authed",
      sessionActorId: "human:authed",
      policyContext: { actorRole: "member" },
    }) as ResolveBearerResult) as ResolveBearer;
    handleWsConnection(socket as unknown as WebSocket, resolveBearer, {
      addClient,
      onVoiceStop: () => {},
      authTimeoutMs: 5_000,
      listRoomsForActor: async () => [],
    });
    // Before auth, a claimed ping is rejected and cannot register presence.
    socket.emit({ type: "ping", actorId: "human:other", idle: true });
    expect(readHumanPresence(["human:authed", "human:other"]).get("human:authed"))
      .toBe("offline");
    expect(socket.readyState).toBe(3);
    expect(readHumanPresence(["human:other"]).get("human:other")).toBe("online");

    // A fresh socket authenticates, then ping contents cannot select another Human.
    const admitted = { ...socket, readyState: 1 };
    const admittedHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
    admitted.on = (event, handler) => admittedHandlers.set(event, [...(admittedHandlers.get(event) ?? []), handler]);
    admitted.emit = (frame) => {
      for (const handler of admittedHandlers.get("message") ?? []) handler(Buffer.from(JSON.stringify(frame)));
    };
    admitted.close = () => {
      admitted.readyState = 3;
      for (const handler of admittedHandlers.get("close") ?? []) handler();
    };
    sockets.push(admitted);
    handleWsConnection(admitted as unknown as WebSocket, resolveBearer, {
      addClient, onVoiceStop: () => {}, authTimeoutMs: 5_000,
      listRoomsForActor: async () => [],
    });
    admitted.emit({ type: "auth", token: "test" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sent.some((frame) => frame.type === "auth.accepted")).toBe(true);
    now.mockReturnValue(4_000_100);
    admitted.emit({ type: "ping", actorId: "human:other", idle: true });
    expect(readHumanPresence(["human:authed", "human:other"]))
      .toEqual(new Map([["human:authed", "idle"], ["human:other", "online"]]));
    other.close();
    admitted.close();
  });

  test("seeds a fresh legacy socket and becomes stale at the exact five-heartbeat boundary", () => {
    spyOn(Date, "now").mockReturnValue(1_000_000);
    connect("human:legacy");
    expect(readHumanPresence(["human:legacy", "human:absent"], 1_074_999))
      .toEqual(new Map([["human:legacy", "online"], ["human:absent", "offline"]]));
    expect(readHumanPresence(["human:legacy"], 1_075_000).get("human:legacy"))
      .toBe("offline");
  });

  test("freshest open device wins; last close makes the Human offline", () => {
    const now = spyOn(Date, "now").mockReturnValue(2_000_000);
    const phone = connect("human:multi");
    const desktop = connect("human:multi");
    now.mockReturnValue(2_000_100);
    recordClientPing(phone as WebSocket, true);
    recordClientPing(desktop as WebSocket, true);
    expect(readHumanPresence(["human:multi"]).get("human:multi")).toBe("idle");
    recordClientPing(desktop as WebSocket, false);
    expect(readHumanPresence(["human:multi"]).get("human:multi")).toBe("online");
    desktop.close();
    expect(readHumanPresence(["human:multi"]).get("human:multi")).toBe("idle");
    phone.close();
    expect(readHumanPresence(["human:multi"]).get("human:multi")).toBe("offline");
  });

  test("ping refreshes only its authenticated socket; malformed idle and closed sockets cannot assert idle", () => {
    const now = spyOn(Date, "now").mockReturnValue(3_000_000);
    const first = connect("human:first");
    const second = connect("human:second");
    now.mockReturnValue(3_074_999);
    recordClientPing(first as WebSocket, true);
    recordClientPing(second as WebSocket, "true");
    const rogue = { OPEN: 1, readyState: 1 } as WebSocket;
    recordClientPing(rogue, true);
    expect(readHumanPresence(["human:first", "human:second", "human:rogue"], 3_075_000))
      .toEqual(new Map([
        ["human:first", "idle"],
        ["human:second", "online"],
        ["human:rogue", "offline"],
      ]));
    first.close();
    now.mockReturnValue(3_075_001);
    recordClientPing(first as WebSocket, false);
    expect(readHumanPresence(["human:first"]).get("human:first")).toBe("offline");
    second.close();
  });
});
