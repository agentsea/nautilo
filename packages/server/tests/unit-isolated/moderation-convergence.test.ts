import { afterEach, expect, mock, test } from "bun:test";
import type { WebSocket } from "ws";
import { addClient, flushPendingWebSocketBroadcasts } from "../../src/realtime/ws-publisher";

const rows: unknown[][] = [];
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => database }));
const database = {
  select: () => {
    const query = { from: () => query, innerJoin: () => query, where: async () => {
      const result = rows.shift();
      if (result === undefined) throw new Error("Unexpected moderation query");
      return result;
    } };
    return query;
  },
};
const { convergeModerationRealtime } = await import("../../src/realtime/moderation-convergence");
const sockets: Array<ReturnType<typeof client>> = [];
function client(userId: string) {
  const listeners: Array<() => void> = [];
  const socket = { OPEN: 1, readyState: 1, frames: [] as Array<Record<string, unknown>>, closes: [] as string[],
    send(data: string) { this.frames.push(JSON.parse(data) as Record<string, unknown>); },
    close(_code?: number, reason = "test cleanup") { this.closes.push(reason); this.readyState = 3; listeners.forEach(fn => fn()); },
    on(_event: string, fn: () => void) { listeners.push(fn); },
  };
  addClient(socket as unknown as WebSocket, { userId, actorId: `${userId}-actor`, roomIds: new Set(["room"]) });
  return socket;
}
afterEach(() => { rows.length = 0; sockets.splice(0).forEach(socket => socket.close()); });

test("committed Server removal closes UI and Relay authority and wakes only current key recipients", async () => {
  const target = client("target"), peer = client("peer"); sockets.push(target, peer);
  rows.push([{roomId: null, userId: "target", action: "ban"}], [{actorId: "target-actor", admitted: false}],
    [{roomId: "room", namespaceId: "namespace"}], [{userId: "peer"}]);
  const closeRelays = mock(() => 1), unregister = mock(async () => {});
  await convergeModerationRealtime("operation", { relayRegistry: { snapshotForUser: () => [{relayId: "relay"}] as never, unregister }, relaySockets: {closeRelays}, work: { reconcileInvocationAccess: async () => {} } });
  await flushPendingWebSocketBroadcasts();
  expect(target.closes).toEqual(["server_access_withdrawn"]);
  expect(closeRelays).toHaveBeenCalledWith(["relay"]);
  expect(unregister).toHaveBeenCalledWith("relay");
  expect(target.frames.some(frame => frame["type"] === "crypto.domain_key_catch_up_requested")).toBe(false);
  expect(peer.frames.filter(frame => frame["type"] === "crypto.domain_key_catch_up_requested").map(frame => frame["keyClass"])).toEqual(["human", "ai"]);
  expect(rows).toHaveLength(0);
});

test("an erased subject cannot be incorrectly marked converged by local session cleanup", async () => {
  rows.push([{roomId: null, userId: null, action: "ban"}]);
  await Promise.resolve(expect(convergeModerationRealtime("operation", {relayRegistry: {snapshotForUser: () => [], unregister: async () => {}}, relaySockets: {closeRelays: () => 0}, work: { reconcileInvocationAccess: async () => {} }}))
    .rejects.toThrow("account-erasure convergence"));
});


test("work convergence selects the retained subject and a failure leaves the receipt retryable", async () => {
  rows.push([{ roomId: null, userId: "target", action: "kick" }], [{ actorId: "target-actor", admitted: false }], []);
  const closeRelays = mock(() => 0);
  const work = mock(async () => { throw new Error("work convergence pending"); });
  await Promise.resolve(expect(convergeModerationRealtime("operation", {
    relayRegistry: { snapshotForUser: () => [], unregister: async () => {} },
    relaySockets: { closeRelays }, work: { reconcileInvocationAccess: work },
  })).rejects.toThrow("work convergence pending"));
  expect(work).toHaveBeenCalledWith("target");
  await Bun.sleep(0);
  expect(closeRelays).toHaveBeenCalledTimes(1);
});
