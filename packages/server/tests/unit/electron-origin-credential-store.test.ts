import { describe, expect, test } from "bun:test";
import { createElectronOriginCredentialStore } from "../../src/remote-control/electron-origin-credential-store";

const NOW = 1_800_000_000_000;
const binding = {
  requestId: "11111111-1111-4111-8111-111111111111",
  userId: "user-a",
  actorId: "actor-a",
  relayId: "relay-a",
  desktopSessionId: "22222222-2222-4222-8222-222222222222",
  pairingGeneration: "generation-a",
  method: "POST",
  path: "/api/rooms/room-a/messages",
  bodySha256: "a".repeat(64),
} as const;

describe("Electron ordinary-origin credential store", () => {
  test("is one-use and bound to the exact request and live launch", () => {
    const store = createElectronOriginCredentialStore({
      now: () => new Date(NOW),
      randomToken: () => "fixed",
    });
    const issued = store.issue(binding);
    expect(store.consume({
      token: issued.token,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: binding.bodySha256,
      now: new Date(NOW),
      isCurrentRelaySession: (candidate) => candidate === binding || candidate.relayId === binding.relayId,
    })).toEqual({
      kind: "local_electron",
      userId: binding.userId,
      actorId: binding.actorId,
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
      pairingGeneration: binding.pairingGeneration,
      requestId: binding.requestId,
    });
    expect(store.consume({
      token: issued.token,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: binding.bodySha256,
      now: new Date(NOW),
      isCurrentRelaySession: () => true,
    })).toBeNull();
  });

  test("burns modified requests and rejects expiry or a replaced Relay session", () => {
    const store = createElectronOriginCredentialStore({
      now: () => new Date(NOW),
      ttlMs: 1_000,
      randomToken: (() => {
        let index = 0;
        return () => `fixed-${++index}`;
      })(),
    });
    const modified = store.issue(binding).token;
    expect(store.consume({
      token: modified,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: "b".repeat(64),
      now: new Date(NOW),
      isCurrentRelaySession: () => true,
    })).toBeNull();
    expect(store.consume({
      token: modified,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: binding.bodySha256,
      now: new Date(NOW),
      isCurrentRelaySession: () => true,
    })).toBeNull();

    const replaced = store.issue(binding).token;
    expect(store.consume({
      token: replaced,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: binding.bodySha256,
      now: new Date(NOW),
      isCurrentRelaySession: () => false,
    })).toBeNull();

    const expired = store.issue(binding).token;
    expect(store.consume({
      token: expired,
      userId: binding.userId,
      actorId: binding.actorId,
      method: binding.method,
      path: binding.path,
      bodySha256: binding.bodySha256,
      now: new Date(NOW + 1_001),
      isCurrentRelaySession: () => true,
    })).toBeNull();
  });
});
