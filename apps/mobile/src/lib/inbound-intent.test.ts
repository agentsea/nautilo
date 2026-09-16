import { describe, expect, test } from "bun:test";

import {
  createInboundIntentCoordinator,
  createOneShotPushHandoff,
  createPushIntentResolver,
  parseMobilePushEnvelope,
  parseMobilePushNotification,
  shouldPresentForegroundPush,
  shouldSuppressForegroundPush,
  type InboundUrlIntent,
  type MobilePushIntentResolverDeps,
} from "./inbound-intent";

const serverId = "srv_nautilo";
const serverUrl = "https://nautilo.example";
const bindingId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const childRoomId = "44444444-4444-4444-8444-444444444444";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    notificationId: "11111111-1111-4111-8111-111111111111",
    bindingId,
    kind: "important_message",
    roomId,
    topLevelRoomId: roomId,
    messageId: 42,
    occurredAt: "2026-08-05T20:00:00.000Z",
    ...overrides,
  };
}

function parsedEnvelope(overrides: Record<string, unknown> = {}) {
  const parsed = parseMobilePushEnvelope(envelope(overrides));
  if (!parsed) throw new Error("fixture is not a valid push envelope");
  return parsed;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function resolverFixture(
  overrides: Partial<MobilePushIntentResolverDeps> = {},
) {
  const calls: string[] = [];
  const deps: MobilePushIntentResolverDeps = {
    loadRegistry: async () => ({ servers: [{ id: serverId, serverUrl }] }),
    loadBinding: async (id) => id === serverId ? { bindingId } : null,
    loadServerRegistrationSnapshot: async (id) =>
      id === serverId ? { server: { id: serverId, serverUrl }, lifecycleRevision: 0 } : null,
    isServerRegistrationCurrent: async () => true,
    ensureValidToken: async () => "bearer",
    createClient: () => ({
      setToken: (token) => { calls.push(`token:${token}`); },
      getRoom: async (id) => ({ id, parentRoomId: null }),
      getRoomMessagesAround: async ({ messageId }) => ({ target: { messageId } }),
    }),
    ...overrides,
  };
  return { resolver: createPushIntentResolver(deps), calls };
}

describe("D468 inbound push envelope", () => {
  test("fails closed for malformed, unknown, and target-bearing test payloads", () => {
    expect(parseMobilePushEnvelope({ ...envelope(), version: 2 })).toBeNull();
    expect(parseMobilePushEnvelope({ ...envelope(), kind: "marketing" })).toBeNull();
    expect(parseMobilePushEnvelope({
      version: 1,
      notificationId: "11111111-1111-4111-8111-111111111111",
      bindingId,
      kind: "test",
      roomId,
      occurredAt: "2026-08-05T20:00:00.000Z",
    })).toBeNull();
  });

  test("acknowledges a valid test notification without resolving a binding or navigating", async () => {
    const { resolver } = resolverFixture({
      loadRegistry: async () => { throw new Error("test intent must not resolve registry"); },
    });
    const testEnvelope = parseMobilePushEnvelope({
      version: 1,
      notificationId: "11111111-1111-4111-8111-111111111111",
      bindingId,
      kind: "test",
      occurredAt: "2026-08-05T20:00:00.000Z",
    });
    if (!testEnvelope) throw new Error("fixture is not a valid test envelope");
    const result = await resolver.resolve(testEnvelope);
    expect(result).toEqual({ kind: "test_acknowledged" });
  });

  test("makes an explicit test visible in foreground while ordinary pushes keep the quiet policy", () => {
    const testEnvelope = parseMobilePushNotification({
      request: {
        content: {
          data: {
            version: 1,
            notificationId: "11111111-1111-4111-8111-111111111111",
            bindingId,
            kind: "test",
            occurredAt: "2026-08-05T20:00:00.000Z",
          },
        },
      },
    });
    if (!testEnvelope) throw new Error("fixture is not a valid test notification");
    expect(shouldPresentForegroundPush(testEnvelope)).toBe(true);
    expect(shouldPresentForegroundPush(parsedEnvelope())).toBe(false);
  });

  test("never lets an unknown binding add or select a server", async () => {
    const { resolver } = resolverFixture({ loadBinding: async () => null });
    expect(await resolver.resolve(parsedEnvelope())).toEqual({ kind: "unknown_binding" });
  });

  test("reports a locally known but signed-out server without fetching the target", async () => {
    let fetched = 0;
    const { resolver } = resolverFixture({
      ensureValidToken: async () => null,
      createClient: () => ({
        setToken: () => {},
        getRoom: async () => { fetched += 1; return { id: roomId, parentRoomId: null }; },
        getRoomMessagesAround: async () => ({ target: { messageId: "42" } }),
      }),
    });
    expect(await resolver.resolve(parsedEnvelope())).toEqual({
      kind: "signed_out",
      target: { serverId, serverUrl, lifecycleRevision: 0 },
    });
    expect(fetched).toBe(0);
  });

  test("retains an authorized offline target for one reconnect attempt", async () => {
    const { resolver } = resolverFixture({
      createClient: () => ({
        setToken: () => {},
        getRoom: async () => { throw new TypeError("Network request failed"); },
        getRoomMessagesAround: async () => ({ target: { messageId: "42" } }),
      }),
    });
    expect(await resolver.resolve(parsedEnvelope())).toEqual({
      kind: "offline",
      target: { serverId, serverUrl, lifecycleRevision: 0 },
    });
  });

  test("revalidates the exact subthread and exact message before navigation", async () => {
    const { resolver, calls } = resolverFixture({
      createClient: () => ({
        setToken: (token) => { calls.push(`token:${token}`); },
        getRoom: async (id) => ({ id, parentRoomId: roomId }),
        getRoomMessagesAround: async ({ roomId: requestedRoomId, messageId }) => {
          calls.push(`around:${requestedRoomId}:${messageId}`);
          return { target: { messageId } };
        },
      }),
    });
    expect(await resolver.resolve(parsedEnvelope({
      roomId: childRoomId,
      topLevelRoomId: roomId,
    }))).toEqual({
      kind: "navigate",
      target: {
        serverId,
        serverUrl,
        lifecycleRevision: 0,
        roomId: childRoomId,
        messageId: "42",
      },
    });
    expect(calls).toEqual(["token:bearer", `around:${childRoomId}:42`]);
  });

  test("does not commit a target after its registration changes during validation", async () => {
    const room = deferred<{ id: string; parentRoomId: null }>();
    let checks = 0;
    const { resolver } = resolverFixture({
      createClient: () => ({
        setToken: () => {},
        getRoom: async () => room.promise,
        getRoomMessagesAround: async () => ({ target: { messageId: "42" } }),
      }),
      isServerRegistrationCurrent: async () => {
        checks += 1;
        return checks === 1;
      },
    });
    const pending = resolver.resolve(parsedEnvelope());
    room.resolve({ id: roomId, parentRoomId: null });
    expect(await pending).toEqual({ kind: "unknown_binding" });
  });
});

describe("D468 root inbound coordinator", () => {
  test("serializes and deduplicates a server-qualified invite URL without treating it as a push target", async () => {
    const urlListeners: Array<(url: string) => void> = [];
    const intents: InboundUrlIntent[] = [];
    const locator = "https://alpha.example.test/redeem/inv_alpha";
    const coordinator = createInboundIntentCoordinator({
      parseUrl: () => ({ kind: "invite", serverUrl: "https://alpha.example.test", token: "inv_alpha" }),
      linking: {
        getInitialUrl: async () => locator,
        addUrlListener: (listener) => { urlListeners.push(listener); return () => {}; },
      },
      notifications: {
        getLastResponse: () => null,
        addResponseListener: () => () => {},
        addReceivedListener: () => () => {},
      },
      onUrlIntent: (intent) => { intents.push(intent); },
      onPushResponse: async () => {},
      onForegroundPush: async () => {},
    });
    coordinator.start();
    urlListeners[0]?.(locator);
    await coordinator.consumeUrl(locator);
    expect(intents).toEqual([{ kind: "invite", serverUrl: "https://alpha.example.test", token: "inv_alpha" }]);
    coordinator.stop();
  });

  test("deduplicates cold and warm notification responses before navigation", async () => {
    const urlListeners: Array<(url: string) => void> = [];
    const responseListeners: Array<(value: unknown) => void> = [];
    const received: unknown[] = [];
    const intents: InboundUrlIntent[] = [];
    const coordinator = createInboundIntentCoordinator({
      parseUrl: (raw) => raw === "nautilo://add-server/example.com"
        ? { kind: "add-server", url: "https://example.com" }
        : { kind: "unknown" },
      linking: {
        getInitialUrl: async () => null,
        addUrlListener: (listener) => { urlListeners.push(listener); return () => {}; },
      },
      notifications: {
        getLastResponse: () => ({ notification: { request: { content: { data: envelope() } } } }),
        addResponseListener: (listener) => { responseListeners.push(listener); return () => {}; },
        addReceivedListener: () => () => {},
      },
      onUrlIntent: (intent) => { intents.push(intent); },
      onPushResponse: async (push) => { received.push(push); },
      onForegroundPush: async () => {},
    });
    coordinator.start();
    responseListeners[0]?.({ notification: { request: { content: { data: envelope() } } } });
    urlListeners[0]?.("nautilo://add-server/example.com");
    // Join the coordinator's serialized queue rather than relying on a
    // particular number of microtasks for cold + warm delivery.
    await coordinator.consumeUrl("nautilo://add-server/example.com");

    expect(received).toHaveLength(1);
    expect(intents).toEqual([{ kind: "add-server", url: "https://example.com" }]);
    coordinator.stop();
  });

  test("allows only one matching auth or reconnect resume", () => {
    const handoff = createOneShotPushHandoff();
    const push = parsedEnvelope();
    if (push.kind !== "important_message") throw new Error("fixture is important");
    handoff.replace({ envelope: push, serverId, reason: "signed_out" });
    expect(handoff.takeForSignedIn(serverId)).toEqual(push);
    expect(handoff.takeForSignedIn(serverId)).toBeNull();
    handoff.replace({ envelope: push, serverId, reason: "offline" });
    expect(handoff.takeForReconnect("other")).toBeNull();
    expect(handoff.takeForReconnect(serverId)).toEqual(push);
    expect(handoff.takeForReconnect(serverId)).toBeNull();
  });

  test("suppresses foreground presentation only for the exact open Room on the matching server", () => {
    const push = parsedEnvelope();
    expect(shouldSuppressForegroundPush(push, {
      bindingServerId: serverId,
      activeServerId: serverId,
      openRoomId: roomId,
    })).toBe(true);
    expect(shouldSuppressForegroundPush(push, {
      bindingServerId: serverId,
      activeServerId: serverId,
      openRoomId: childRoomId,
    })).toBe(false);
  });
});
