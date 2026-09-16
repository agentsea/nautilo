/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

mock.module("expo-notifications", () => ({ setBadgeCountAsync: mock(async () => true) }));
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
mock.module("@/lib/auth", () => ({ ensureValidToken: mock(async () => "unused") }));
mock.module("@/lib/push-permission-policy", () => ({
  createPushPermissionPolicy: () => ({ refresh: async () => ({ badge: "enabled" }) }),
}));
mock.module("@/lib/server-store", () => ({
  loadRegistry: mock(),
  loadServerRegistrationSnapshot: mock(),
  isServerRegistrationCurrent: mock(),
  loadTokenSnapshot: mock(),
}));
mock.module("@nautilo/api-client/browser", () => ({ NautiloApiClient: class {} }));

import type { NotificationStateResponse } from "@nautilo/types";
import type { ServerRecord } from "./server-store";

const {
  badgeProjection,
  createMobilePushBadgeReconciler,
  loadMobileNotificationStateBatch,
} = await import("./push-badge-reconciler");

function server(id: string): ServerRecord {
  return { id, serverUrl: `https://${id}.test`, displayName: id, lastActive: 1 };
}

function state(unreadCount: number, importantUnreadCount: number): NotificationStateResponse {
  return {
    generatedAt: "2026-08-05T00:00:00.000Z",
    preferences: { defaultLevel: "direct", roomOverrides: [] },
    totals: { unreadCount, importantUnreadCount },
    rooms: [],
    subthreads: [],
  };
}

function harness(input: {
  servers: ServerRecord[];
  stateById?: Map<string, NotificationStateResponse | Error>;
  tokenById?: Map<string, string | null | Error>;
  current?: (id: string) => boolean;
  badgeEnabled?: boolean;
  maxConcurrency?: number;
}) {
  const setBadgeCount = mock(async (_count: number) => true);
  const tokenProviders: string[] = [];
  const latchedTokens = new Map<string, string | null>();
  let concurrent = 0;
  let peakConcurrent = 0;
  const reconciler = createMobilePushBadgeReconciler({
    loadRegistry: async () => ({ servers: input.servers, activeId: input.servers[0]?.id ?? null }),
    loadServerRegistrationSnapshot: async (id) => {
      const found = input.servers.find((candidate) => candidate.id === id);
      return found ? { server: found, lifecycleRevision: 1 } : null;
    },
    isServerRegistrationCurrent: async (snapshot) => input.current?.(snapshot.server.id) ?? true,
    loadTokenSnapshot: async (id) => ({
      tokens: input.tokenById?.get(id) === null ? null : {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 60_000,
        userId: "human-a",
      },
      revision: 1,
    }),
    ensureValidToken: async (id) => {
      const token = input.tokenById?.get(id);
      if (token instanceof Error) throw token;
      return token ?? `token-${id}`;
    },
    createClient: (serverUrl) => ({
      setToken: (token) => { latchedTokens.set(serverUrl, token); },
      setTokenProvider: (_provider) => { tokenProviders.push(serverUrl); },
      getNotificationState: async () => {
        const id = input.servers.find((candidate) => candidate.serverUrl === serverUrl)?.id;
        if (!id || latchedTokens.get(serverUrl) !== (input.tokenById?.get(id) ?? `token-${id}`)) {
          throw new Error("notification state read is not authenticated");
        }
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        await Promise.resolve();
        concurrent -= 1;
        const result = id ? input.stateById?.get(id) : undefined;
        if (result instanceof Error) throw result;
        return result ?? state(0, 0);
      },
    }),
    setBadgeCount,
    isBadgeEnabled: async () => input.badgeEnabled ?? true,
    maxConcurrency: input.maxConcurrency ?? 2,
  });
  return { reconciler, setBadgeCount, tokenProviders, latchedTokens, peak: () => peakConcurrent };
}

describe("D468 authoritative mobile app badge", () => {
  test("uses the aggregate unread count across separate server clients", async () => {
    const one = server("one");
    const two = server("two");
    const source = harness({
      servers: [one, two],
      stateById: new Map([[one.id, state(9, 0)], [two.id, state(7, 3)]]),
    });

    expect(await source.reconciler.trigger()).toEqual({
      kind: "updated",
      presentation: "important",
      badgeCount: 16,
      unavailableServerIds: [],
    });
    expect(source.setBadgeCount).toHaveBeenCalledWith(16);
    expect(source.tokenProviders.sort()).toEqual([one.serverUrl, two.serverUrl]);
    expect(source.latchedTokens).toEqual(new Map([
      [one.serverUrl, `token-${one.id}`],
      [two.serverUrl, `token-${two.id}`],
    ]));
  });

  test("projects the exact unread counter and clears only fresh zero state", () => {
    expect(badgeProjection({ unread: 4, important: 0 })).toEqual({ presentation: "ambient", badgeCount: 4 });
    expect(badgeProjection({ unread: 0, important: 0 })).toEqual({ presentation: "clear", badgeCount: 0 });
    expect(badgeProjection({ unread: 8, important: 2 })).toEqual({ presentation: "important", badgeCount: 8 });
  });

  test("does not clear or replace an existing badge while any registered server is offline", async () => {
    const available = server("available");
    const offline = server("offline");
    const source = harness({
      servers: [available, offline],
      stateById: new Map<string, NotificationStateResponse | Error>([
        [available.id, state(0, 0)],
        [offline.id, new Error("offline")],
      ]),
    });

    expect(await source.reconciler.trigger()).toEqual({
      kind: "unchanged",
      unavailableServerIds: [offline.id],
    });
    expect(source.setBadgeCount).not.toHaveBeenCalled();
  });

  test("treats an offline saved server token refresh as unavailable across repeated runs", async () => {
    const available = server("available");
    const stale = server("stale");
    const source = harness({
      servers: [available, stale],
      stateById: new Map([[available.id, state(2, 0)]]),
      tokenById: new Map([[stale.id, new Error("fetch failed")]]),
    });

    const expected = { kind: "unchanged" as const, unavailableServerIds: [stale.id] };
    expect(await source.reconciler.trigger()).toEqual(expected);
    expect(await source.reconciler.trigger()).toEqual(expected);
    expect(source.setBadgeCount).not.toHaveBeenCalled();
  });

  test("a signed-out inactive server cannot affect another server's contribution or active auth", async () => {
    const active = server("active");
    const inactive = server("inactive");
    const source = harness({
      servers: [active, inactive],
      stateById: new Map([[active.id, state(5, 2)]]),
      tokenById: new Map([[inactive.id, null]]),
    });

    await source.reconciler.trigger();
    // The inactive row has no local session before the worker starts, so it
    // contributes nothing. No active singleton is touched or signed out.
    expect(source.setBadgeCount).toHaveBeenCalledWith(5);
    expect(source.tokenProviders).toEqual([active.serverUrl]);
  });

  test("an explicitly signed-out server contributes nothing so the remaining fresh state can clear", async () => {
    const signedOut = server("signed-out");
    const available = server("available");
    const source = harness({
      servers: [signedOut, available],
      tokenById: new Map([[signedOut.id, null]]),
      stateById: new Map([[available.id, state(0, 0)]]),
    });

    expect(await source.reconciler.trigger()).toMatchObject({
      kind: "updated",
      presentation: "clear",
      badgeCount: 0,
    });
    expect(source.setBadgeCount).toHaveBeenCalledWith(0);
  });

  test("excludes a removed server and immediately recomputes the remaining fresh registry", async () => {
    const removed = server("removed");
    const retained = server("retained");
    const source = harness({
      servers: [removed, retained],
      stateById: new Map([[removed.id, state(20, 8)], [retained.id, state(4, 0)]]),
      current: (id) => id !== removed.id,
    });

    expect(await source.reconciler.trigger()).toMatchObject({
      kind: "updated",
      presentation: "ambient",
      badgeCount: 4,
    });
  });

  test("bounds concurrent preserved-server reads", async () => {
    const servers = [server("one"), server("two"), server("three")];
    const source = harness({ servers, maxConcurrency: 2 });
    await source.reconciler.trigger();
    expect(source.peak()).toBeLessThanOrEqual(2);
  });

  test("shares the same two-at-a-time cap with inactive in-app attention refreshes", async () => {
    const servers = [server("one"), server("two"), server("three")];
    let concurrent = 0;
    let peak = 0;
    const results = await loadMobileNotificationStateBatch(servers, {
      load: async (candidate) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await Promise.resolve();
        concurrent -= 1;
        return { kind: "fresh" as const, snapshot: state(candidate.id === "three" ? 3 : 0, 0) };
      },
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(results.get("three")).toMatchObject({ kind: "fresh", snapshot: { totals: { unreadCount: 3 } } });
  });
});
