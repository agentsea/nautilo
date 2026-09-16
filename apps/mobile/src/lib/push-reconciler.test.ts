/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

mock.module("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0-test" } } }));
mock.module("react-native", () => ({ Platform: { OS: "ios" } }));
mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));
mock.module("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
mock.module("expo-notifications", () => ({}));
mock.module("./auth", () => ({ ensureValidToken: mock(async () => "unused") }));
mock.module("./push-binding-store", () => ({
  acknowledgePushBinding: mock(),
  drainPushRevokeTombstones: mock(),
  loadOrCreatePushBinding: mock(),
  loadPushBinding: mock(),
}));
mock.module("./push-installation", () => ({
  refreshPushInstallation: mock(),
  subscribeToPushTokenRotations: mock(),
}));
mock.module("./push-permission-policy", () => ({ loadPushBadgePreference: mock(async () => true) }));
mock.module("./server-store", () => ({
  loadRegistry: mock(),
  loadServerRegistrationSnapshot: mock(),
  isServerRegistrationCurrent: mock(),
  loadTokenSnapshot: mock(),
}));
mock.module("@nautilo/api-client/browser", () => ({
  NautiloApiClient: class {},
  MobilePushInstallationApiError: class MobilePushInstallationApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  },
}));

import type { PushInstallationState } from "./push-installation";
import type { PushBinding, PushRevokeTombstone } from "./push-binding-store";
import type { ServerRecord } from "./server-store";

const { createMobilePushReconciler } = await import("./push-reconciler");

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function native(overrides: Partial<PushInstallationState> = {}): PushInstallationState {
  return {
    version: 1,
    installationId: INSTALLATION_ID,
    expoPushToken: "ExponentPushToken[native-token]",
    tokenGeneration: 1,
    permission: "granted",
    ...overrides,
  };
}

function server(id: string, serverUrl = `https://${id}.test`): ServerRecord {
  return { id, serverUrl, displayName: id, lastActive: 1 };
}

function binding(id: string, ownerUserId = "human-a"): PushBinding {
  const suffix = id.padEnd(12, "0").slice(0, 12).replace(/[^a-f0-9]/g, "a");
  return {
    version: 1,
    ownerUserId,
    bindingId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    revokeProof: "b".repeat(64),
    lastAcknowledged: null,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** Deterministic test clock; no wall-clock sleeps in lifecycle race tests. */
function deadlineClock(): {
  readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clear: (handle: ReturnType<typeof setTimeout>) => void;
  fireNext(): void;
  activeCount(): number;
} {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    schedule: (callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (handle) => { callbacks.delete(handle as unknown as number); },
    fireNext: () => {
      const next = callbacks.entries().next().value as [number, () => void] | undefined;
      if (!next) throw new Error("expected an active reconciliation deadline");
      callbacks.delete(next[0]);
      next[1]();
    },
    activeCount: () => callbacks.size,
  };
}

async function flushAsyncWork(): Promise<void> {
  // Reconciliation deliberately crosses independent SecureStore/auth/client
  // promises. Drain a fixed microtask budget instead of sleeping on the wall
  // clock, then fire the injected deadline at an exact known boundary.
  for (let index = 0; index < 96; index += 1) await Promise.resolve();
}

function harness(input: {
  servers: ServerRecord[];
  nativeStates?: PushInstallationState[];
  tombstone?: PushRevokeTombstone;
  current?: (id: string) => boolean;
  ownerByServer?: (id: string) => string | null;
  onRegister?: () => void;
  waitForRegister?: () => Promise<void>;
  waitForToken?: (serverId: string) => Promise<string | null>;
  refreshInstallation?: () => Promise<PushInstallationState>;
  reconciliationDeadlineMs?: number;
  scheduleRunDeadline?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearRunDeadline?: (handle: ReturnType<typeof setTimeout>) => void;
  badgeEnabled?: boolean;
  badgeEndpointStatus?: number;
}): {
  reconciler: ReturnType<typeof createMobilePushReconciler>;
  bindings: Map<string, PushBinding>;
  registerCalls: Array<{ serverUrl: string; input: Record<string, unknown> }>;
  disableCalls: Array<{ serverUrl: string; input: Record<string, unknown> }>;
  revokeCalls: Array<{ serverUrl: string; input: Record<string, unknown> }>;
  badgeCalls: Array<{ serverUrl: string; input: Record<string, unknown> }>;
  tokenCalls: string[];
  acknowledgeCalls: number;
  rotation: { subscribeCount: number; removeCount: number; listener: (() => void) | null };
} {
  const bindings = new Map<string, PushBinding>();
  const registerCalls: Array<{ serverUrl: string; input: Record<string, unknown> }> = [];
  const disableCalls: Array<{ serverUrl: string; input: Record<string, unknown> }> = [];
  const revokeCalls: Array<{ serverUrl: string; input: Record<string, unknown> }> = [];
  const badgeCalls: Array<{ serverUrl: string; input: Record<string, unknown> }> = [];
  const tokenCalls: string[] = [];
  let acknowledgeCalls = 0;
  const rotation = { subscribeCount: 0, removeCount: 0, listener: null as (() => void) | null };
  const states = input.nativeStates ? [...input.nativeStates] : [native()];

  const reconciler = createMobilePushReconciler({
    loadRegistry: async () => ({ servers: input.servers, activeId: input.servers[0]?.id ?? null }),
    loadServerRegistrationSnapshot: async (id) => {
      const found = input.servers.find((candidate) => candidate.id === id);
      return found ? { server: found, lifecycleRevision: 1 } : null;
    },
    isServerRegistrationCurrent: async (snapshot) => input.current?.(snapshot.server.id) ?? true,
    ensureValidToken: async (id) => {
      tokenCalls.push(id);
      if (input.waitForToken) return input.waitForToken(id);
      return id === "srv_signed_out" ? null : `token-for-${id}`;
    },
    loadTokenSnapshot: async (id) => ({
      tokens: input.ownerByServer?.(id) === null
        ? null
        : {
          accessToken: `token-for-${id}`,
          refreshToken: `refresh-for-${id}`,
          expiresAt: Date.now() + 60_000,
          userId: input.ownerByServer?.(id) ?? "human-a",
        },
      revision: 1,
    }),
    createClient: (serverUrl) => ({
      setTokenProvider: () => {},
      registerPushInstallation: async (request) => {
        registerCalls.push({ serverUrl, input: request as unknown as Record<string, unknown> });
        input.onRegister?.();
        await input.waitForRegister?.();
        return {} as never;
      },
      disablePushInstallation: async (request) => {
        disableCalls.push({ serverUrl, input: request as unknown as Record<string, unknown> });
        return {} as never;
      },
      setPushInstallationBadgePreference: async (request) => {
        badgeCalls.push({ serverUrl, input: request as unknown as Record<string, unknown> });
        if (input.badgeEndpointStatus !== undefined) {
          throw Object.assign(new Error("badge preference unavailable"), { status: input.badgeEndpointStatus });
        }
        return {} as never;
      },
      revokePushInstallationWithProof: async (request) => {
        revokeCalls.push({ serverUrl, input: request as unknown as Record<string, unknown> });
      },
    }),
    refreshInstallation: input.refreshInstallation ?? (async () => states.shift() ?? native()),
    loadBadgePreference: async () => input.badgeEnabled ?? true,
    loadBinding: async (id) => bindings.get(id) ?? null,
    loadOrCreateBinding: async (id, ownerUserId) => {
      const existing = bindings.get(id);
      if (existing) return existing;
      const created = binding(id, ownerUserId);
      bindings.set(id, created);
      return created;
    },
    acknowledgeBinding: async (request) => {
      acknowledgeCalls += 1;
      const current = bindings.get(request.serverId);
      if (
        !current
        || current.ownerUserId !== request.ownerUserId
        || current.bindingId !== request.bindingId
      ) return false;
      if ((current.lastAcknowledged?.tokenGeneration ?? 0) > request.acknowledgement.tokenGeneration) return false;
      bindings.set(request.serverId, { ...current, lastAcknowledged: request.acknowledgement });
      return true;
    },
    drainTombstones: async (attempt) => {
      if (!input.tombstone) return { attempted: 0, cleared: 0, retained: 0 };
      const outcome = await attempt(input.tombstone);
      return { attempted: 1, cleared: outcome === "retry" ? 0 : 1, retained: outcome === "retry" ? 1 : 0 };
    },
    subscribeTokenRotations: (listener) => {
      rotation.subscribeCount += 1;
      rotation.listener = () => listener(native({ expoPushToken: "ExponentPushToken[rotated]", tokenGeneration: 2 }));
      return { remove: () => { rotation.removeCount += 1; } };
    },
    platform: "android",
    appVersion: () => "0.1.0-test",
    maxConcurrency: 2,
    reconciliationDeadlineMs: input.reconciliationDeadlineMs ?? 15_000,
    scheduleRunDeadline: input.scheduleRunDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearRunDeadline: input.clearRunDeadline ?? ((handle) => clearTimeout(handle)),
  });

  return {
    reconciler,
    bindings,
    registerCalls,
    disableCalls,
    revokeCalls,
    badgeCalls,
    tokenCalls,
    get acknowledgeCalls() { return acknowledgeCalls; },
    rotation,
  };
}

describe("D468 headless multi-server push reconciliation", () => {
  test("registers active and inactive servers independently with distinct bindings", async () => {
    const first = server("srv_active");
    const second = server("srv_inactive");
    const testHarness = harness({ servers: [first, second] });

    const result = await testHarness.reconciler.trigger();

    expect(result.native).toBe("ready");
    expect(result.servers).toEqual(new Map([
      [first.id, "registered"],
      [second.id, "registered"],
    ]));
    expect(testHarness.tokenCalls.sort()).toEqual([first.id, second.id]);
    expect(testHarness.registerCalls.map((call) => call.serverUrl).sort()).toEqual([
      first.serverUrl,
      second.serverUrl,
    ]);
    expect(testHarness.registerCalls[0]?.input.bindingId).not.toBe(testHarness.registerCalls[1]?.input.bindingId);
    expect(testHarness.registerCalls.every((call) => call.input.platform === "android")).toBe(true);
    expect(testHarness.badgeCalls).toHaveLength(2);
    expect(testHarness.badgeCalls.every((call) => call.input.enabled === false)).toBe(true);
  });

  test("keeps server-authored background badge counts enabled for one registered server", async () => {
    const only = server("srv_only");
    const testHarness = harness({ servers: [only], badgeEnabled: true });

    await testHarness.reconciler.trigger();

    expect(testHarness.badgeCalls[0]?.input.enabled).toBe(true);
  });

  test("synchronizes badge off for an acknowledged binding and tolerates an older server", async () => {
    const current = server("srv_current");
    const currentHarness = harness({ servers: [current], badgeEnabled: false });
    const currentBinding = binding(current.id);
    currentHarness.bindings.set(current.id, {
      ...currentBinding,
      lastAcknowledged: { tokenGeneration: 1, permission: "granted" },
    });

    expect((await currentHarness.reconciler.trigger()).servers.get(current.id)).toBe("unchanged");
    expect(currentHarness.registerCalls).toEqual([]);
    expect(currentHarness.badgeCalls[0]?.input).toEqual({
      version: 1,
      bindingId: currentBinding.bindingId,
      tokenGeneration: 1,
      enabled: false,
    });

    const old = server("srv_old");
    const oldHarness = harness({ servers: [old], badgeEndpointStatus: 404 });
    expect((await oldHarness.reconciler.trigger()).servers.get(old.id)).toBe("registered");
    expect(oldHarness.registerCalls).toHaveLength(1);
    expect(oldHarness.badgeCalls).toHaveLength(1);
  });

  test("reports a current badge-sync outage so activation will retry it", async () => {
    const one = server("srv_badge_outage");
    const testHarness = harness({ servers: [one], badgeEndpointStatus: 503 });
    expect((await testHarness.reconciler.trigger()).servers.get(one.id)).toBe("unavailable");
    expect(testHarness.registerCalls).toHaveLength(1);
    expect(testHarness.acknowledgeCalls).toBe(1);
  });

  test("uses a permission-off disable only for an existing binding and never creates one", async () => {
    const known = server("srv_known");
    const unknown = server("srv_unknown");
    const testHarness = harness({
      servers: [known, unknown],
      nativeStates: [native({ permission: "denied", expoPushToken: null, tokenGeneration: 1 })],
    });
    testHarness.bindings.set(known.id, binding(known.id));

    const result = await testHarness.reconciler.trigger();

    expect(result.servers.get(known.id)).toBe("disabled");
    expect(result.servers.get(unknown.id)).toBe("unchanged");
    expect(testHarness.disableCalls).toHaveLength(1);
    expect(testHarness.disableCalls[0]?.input.enabled).toBe(false);
    expect(testHarness.bindings.has(unknown.id)).toBe(false);
  });

  test("token-generation acknowledgement is monotonic and stale native state cannot re-register", async () => {
    const one = server("srv_generation");
    const testHarness = harness({
      servers: [one],
      nativeStates: [
        native({ tokenGeneration: 2, expoPushToken: "ExponentPushToken[generation-two]" }),
        native({ tokenGeneration: 1, expoPushToken: "ExponentPushToken[generation-one]" }),
      ],
    });

    expect((await testHarness.reconciler.trigger()).servers.get(one.id)).toBe("registered");
    expect((await testHarness.reconciler.trigger()).servers.get(one.id)).toBe("unchanged");
    expect(testHarness.registerCalls).toHaveLength(1);
    expect(testHarness.bindings.get(one.id)?.lastAcknowledged?.tokenGeneration).toBe(2);
  });

  test("drains proof-only tombstones without active-server auth and rejects a late removed acknowledgement", async () => {
    const removed = server("srv_removed");
    let current = true;
    const testHarness = harness({
      servers: [removed],
      current: () => current,
      tombstone: {
        version: 1,
        serverUrl: "https://removed-before-reconcile.test",
        bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        revokeProof: "c".repeat(64),
        createdAt: "2026-08-05T00:00:00.000Z",
      },
      onRegister: () => { current = false; },
    });
    const result = await testHarness.reconciler.trigger();

    expect(result.tombstones).toEqual({ attempted: 1, cleared: 1, retained: 0 });
    expect(testHarness.revokeCalls).toEqual([{
      serverUrl: "https://removed-before-reconcile.test",
      input: {
        version: 1,
        bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        revokeProof: "c".repeat(64),
      },
    }]);
    expect(result.servers.get(removed.id)).toBe("removed");
    expect(testHarness.bindings.get(removed.id)?.lastAcknowledged).toBeNull();
  });

  test("fails closed instead of reusing an earlier Human's same-server binding", async () => {
    const shared = server("srv_shared");
    const testHarness = harness({
      servers: [shared],
      ownerByServer: () => "human-b",
    });
    const a = binding(shared.id, "human-a");
    testHarness.bindings.set(shared.id, a);

    const result = await testHarness.reconciler.trigger();

    expect(result.servers.get(shared.id)).toBe("identity_mismatch");
    expect(testHarness.registerCalls).toEqual([]);
    expect(testHarness.disableCalls).toEqual([]);
    expect(testHarness.bindings.get(shared.id)).toEqual(a);
  });

  test("start/stop are idempotent and token rotation only retriggers the coordinator", async () => {
    const testHarness = harness({ servers: [] });
    testHarness.reconciler.start();
    testHarness.reconciler.start();
    expect(testHarness.rotation.subscribeCount).toBe(1);
    testHarness.rotation.listener?.();
    testHarness.reconciler.stop();
    testHarness.reconciler.stop();
    expect(testHarness.rotation.removeCount).toBe(1);
  });

  test("reports native token acquisition failure without inventing server results", async () => {
    const one = server("srv_native_unavailable");
    const unavailable = createMobilePushReconciler({
      loadRegistry: async () => ({ servers: [one], activeId: one.id }),
      drainTombstones: async () => ({ attempted: 0, cleared: 0, retained: 0 }),
      refreshInstallation: async () => { throw new Error("native credentials unavailable"); },
    });

    const result = await unavailable.trigger();

    expect(result.native).toBe("unavailable");
    expect(result.servers).toEqual(new Map());
  });

  test("turns a stalled registration into actionable unavailable and fences its late completion", async () => {
    const one = server("srv_stalled_register");
    const clock = deadlineClock();
    const lateRegister = deferred<void>();
    const testHarness = harness({
      servers: [one],
      waitForRegister: () => lateRegister.promise,
      reconciliationDeadlineMs: 1,
      scheduleRunDeadline: clock.schedule,
      clearRunDeadline: clock.clear,
    });

    const pending = testHarness.reconciler.trigger();
    await flushAsyncWork();
    expect(testHarness.registerCalls).toHaveLength(1);
    clock.fireNext();

    expect(await pending).toMatchObject({
      native: "ready",
      servers: new Map([[one.id, "unavailable"]]),
    });
    expect(testHarness.acknowledgeCalls).toBe(0);
    expect(clock.activeCount()).toBe(0);

    lateRegister.resolve();
    await flushAsyncWork();
    expect(testHarness.acknowledgeCalls).toBe(0);
    expect(testHarness.bindings.get(one.id)?.lastAcknowledged).toBeNull();
  });

  test("preserves a coalesced requested rerun after the first deadline and clears both timers", async () => {
    const one = server("srv_retry_after_deadline");
    const clock = deadlineClock();
    const lateRegister = deferred<void>();
    let registrationAttempt = 0;
    const testHarness = harness({
      servers: [one],
      waitForRegister: async () => {
        registrationAttempt += 1;
        if (registrationAttempt === 1) await lateRegister.promise;
      },
      reconciliationDeadlineMs: 1,
      scheduleRunDeadline: clock.schedule,
      clearRunDeadline: clock.clear,
    });

    const first = testHarness.reconciler.trigger();
    await flushAsyncWork();
    expect(testHarness.registerCalls).toHaveLength(1);
    const duplicate = testHarness.reconciler.trigger();
    expect(duplicate).toBe(first);
    clock.fireNext();

    expect(await first).toMatchObject({
      native: "ready",
      servers: new Map([[one.id, "registered"]]),
    });
    expect(testHarness.registerCalls).toHaveLength(2);
    expect(testHarness.acknowledgeCalls).toBe(1);
    expect(clock.activeCount()).toBe(0);

    lateRegister.resolve();
    await flushAsyncWork();
    expect(testHarness.acknowledgeCalls).toBe(1);
  });

  test("deadline fences late native and auth completion before either can register", async () => {
    const one = server("srv_late_native");
    const nativeClock = deadlineClock();
    const lateNative = deferred<PushInstallationState>();
    const nativeHarness = harness({
      servers: [one],
      refreshInstallation: () => lateNative.promise,
      reconciliationDeadlineMs: 1,
      scheduleRunDeadline: nativeClock.schedule,
      clearRunDeadline: nativeClock.clear,
    });

    const nativeRun = nativeHarness.reconciler.trigger();
    await flushAsyncWork();
    nativeClock.fireNext();
    expect(await nativeRun).toMatchObject({ native: "unavailable", servers: new Map() });
    lateNative.resolve(native());
    await flushAsyncWork();
    expect(nativeHarness.registerCalls).toEqual([]);
    expect(nativeClock.activeCount()).toBe(0);

    const authClock = deadlineClock();
    const lateToken = deferred<string | null>();
    const authHarness = harness({
      servers: [one],
      waitForToken: () => lateToken.promise,
      reconciliationDeadlineMs: 1,
      scheduleRunDeadline: authClock.schedule,
      clearRunDeadline: authClock.clear,
    });

    const authRun = authHarness.reconciler.trigger();
    await flushAsyncWork();
    authClock.fireNext();
    expect(await authRun).toMatchObject({
      native: "ready",
      servers: new Map([[one.id, "unavailable"]]),
    });
    lateToken.resolve("late-token");
    await flushAsyncWork();
    expect(authHarness.registerCalls).toEqual([]);
    expect(authHarness.acknowledgeCalls).toBe(0);
    expect(authClock.activeCount()).toBe(0);
  });

  test("stop cancels a pending run without leaking its deadline or accepting a late registration", async () => {
    const one = server("srv_stopped");
    const clock = deadlineClock();
    const lateRegister = deferred<void>();
    const testHarness = harness({
      servers: [one],
      waitForRegister: () => lateRegister.promise,
      reconciliationDeadlineMs: 1,
      scheduleRunDeadline: clock.schedule,
      clearRunDeadline: clock.clear,
    });

    const pending = testHarness.reconciler.trigger();
    await flushAsyncWork();
    expect(testHarness.registerCalls).toHaveLength(1);
    testHarness.reconciler.stop();

    expect(await pending).toMatchObject({
      native: "ready",
      servers: new Map([[one.id, "cancelled"]]),
    });
    expect(clock.activeCount()).toBe(0);
    lateRegister.resolve();
    await flushAsyncWork();
    expect(testHarness.acknowledgeCalls).toBe(0);
  });
});
