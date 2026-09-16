/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

const secureValues = new Map<string, string>();
let blockedKey: string | null = null;
let releaseBlockedSet: (() => void) | null = null;
let blockedSetStarted: (() => void) | null = null;

mock.module("expo-secure-store", () => ({
  getItemAsync: mock(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: mock(async (key: string, value: string) => {
    if (blockedKey === key) {
      blockedSetStarted?.();
      await new Promise<void>((resolve) => { releaseBlockedSet = resolve; });
      blockedKey = null;
    }
    secureValues.set(key, value);
  }),
  deleteItemAsync: mock(async (key: string) => { secureValues.delete(key); }),
}));
mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (size: number) => new Uint8Array(size),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

const registryValues = new Map<string, string>();
let blockedRegistryKey: string | null = null;
let releaseBlockedRegistrySet: (() => void) | null = null;
let blockedRegistrySetStarted: (() => void) | null = null;
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: mock(async (key: string) => registryValues.get(key) ?? null),
    setItem: mock(async (key: string, value: string) => {
      if (blockedRegistryKey === key) {
        blockedRegistrySetStarted?.();
        await new Promise<void>((resolve) => { releaseBlockedRegistrySet = resolve; });
        blockedRegistryKey = null;
      }
      registryValues.set(key, value);
    }),
    removeItem: mock(async (key: string) => { registryValues.delete(key); }),
  },
}));

const {
  clearTokens,
  createVerifiedTokenOwnerConfirmer,
  loadRegistry,
  loadTokenSnapshot,
  loadTokens,
  removeServer,
  saveTokens,
  saveTokensIfRevision,
  setActiveServer,
  upsertServer,
} = await import("./server-store");
const { listPushRevokeTombstones } = await import("./push-binding-store");
const { clearViewerCache, readViewerCache, writeViewerCache } = await import("./viewer-cache");

function bundle(label: string) {
  return {
    accessToken: `${label}-access`,
    refreshToken: `${label}-refresh`,
    expiresAt: 123,
  };
}

describe("per-server token mutation fencing", () => {
  test("a sign-out queued during a refresh commit wins and leaves no credentials", async () => {
    const id = "race-sign-out-during-save";
    await saveTokens(id, bundle("old"));
    const snapshot = await loadTokenSnapshot(id);
    blockedKey = `nautilo.tokens.${id}`;
    const setStarted = new Promise<void>((resolve) => { blockedSetStarted = resolve; });

    const refreshCommit = saveTokensIfRevision(id, bundle("refresh"), snapshot.revision);
    await setStarted;
    const signOut = clearTokens(id);
    releaseBlockedSet?.();

    expect(await refreshCommit).toBe(false);
    await signOut;
    expect(await loadTokens(id)).toBeNull();
  });

  test("a refresh that finishes after sign-out cannot resurrect credentials", async () => {
    const id = "race-late-refresh";
    await saveTokens(id, bundle("old"));
    const snapshot = await loadTokenSnapshot(id);

    await clearTokens(id);

    expect(await saveTokensIfRevision(id, bundle("late"), snapshot.revision)).toBe(false);
    expect(await loadTokens(id)).toBeNull();
  });

  test("a newer interactive sign-in beats an older refresh generation", async () => {
    const id = "race-new-sign-in";
    await saveTokens(id, bundle("old"));
    const snapshot = await loadTokenSnapshot(id);
    blockedKey = `nautilo.tokens.${id}`;
    const setStarted = new Promise<void>((resolve) => { blockedSetStarted = resolve; });

    const refreshCommit = saveTokensIfRevision(id, bundle("old-refresh"), snapshot.revision);
    await setStarted;
    const interactiveCommit = saveTokens(id, bundle("new-sign-in"));
    releaseBlockedSet?.();

    expect(await refreshCommit).toBe(false);
    await interactiveCommit;
    expect(await loadTokens(id)).toEqual(bundle("new-sign-in"));
  });

  test("a lost owner compare-and-swap never publishes a stale verified Human after refresh", async () => {
    const old = { tokens: bundle("old"), revision: 1 };
    const refreshed = { tokens: bundle("refreshed"), revision: 2 };
    const snapshots = [old, refreshed];
    const confirmer = createVerifiedTokenOwnerConfirmer({
      loadSnapshot: async () => snapshots.shift() ?? refreshed,
      saveIfRevision: async () => false,
    });

    // A refresh wins the revision fence and replaces the bearer. The reload
    // must reject the old Human, so Auth refuses to publish verified state.
    expect(await confirmer.confirm("race-owner-after-refresh", "old-access", "human-a")).toBe(false);
  });

  test("a lost owner compare-and-swap accepts an equivalent concurrent owner confirmation", async () => {
    const sameOwner = { tokens: { ...bundle("same"), userId: "human-a" }, revision: 2 };
    const confirmer = createVerifiedTokenOwnerConfirmer({
      loadSnapshot: async () => sameOwner,
      saveIfRevision: async () => false,
    });

    expect(await confirmer.confirm("race-owner-equivalent-confirmation", "same-access", "human-a")).toBe(true);
  });
});

describe("per-server viewer-cache ordering", () => {
  test("logout clear waits behind an in-flight advisory cache write", async () => {
    const id = "viewer-cache-clear";
    blockedRegistryKey = `nautilo.viewer.v1.${id}`;
    const setStarted = new Promise<void>((resolve) => { blockedRegistrySetStarted = resolve; });
    const write = writeViewerCache(id, {
      userId: "user",
      actorId: "actor",
      capabilities: [],
    });
    await setStarted;

    const clear = clearViewerCache(id);
    releaseBlockedRegistrySet?.();
    await Promise.all([write, clear]);

    expect(await readViewerCache(id)).toBeNull();
  });
});

describe("server-registry mutation ordering", () => {
  test("concurrent registry updates do not lose a server or revive a removed active server", async () => {
    registryValues.clear();
    const [first, second] = await Promise.all([
      upsertServer({ serverUrl: "https://first.test", displayName: "First" }),
      upsertServer({ serverUrl: "https://second.test", displayName: "Second" }),
    ]);
    expect((await loadRegistry()).servers.map((server) => server.id)).toEqual([
      first.id,
      second.id,
    ]);

    await Promise.all([setActiveServer(first.id), removeServer(first.id)]);
    const final = await loadRegistry();
    expect(final.servers.map((server) => server.id)).toEqual([second.id]);
    expect(final.activeId).toBe(second.id);
  });

  test("server removal durably queues proof-only push cleanup before clearing credentials", async () => {
    registryValues.clear();
    secureValues.clear();
    const server = await upsertServer({
      serverUrl: "https://remove-with-push.test",
      displayName: "Remove with push",
    });
    await saveTokens(server.id, bundle("remove"));
    const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const revokeProof = "a".repeat(64);
    secureValues.set(
      `nautilo.push.binding.v1.${server.id}`,
      JSON.stringify({
        version: 1,
        ownerUserId: "human-remove",
        bindingId,
        revokeProof,
        lastAcknowledged: null,
      }),
    );

    await removeServer(server.id);

    expect((await loadRegistry()).servers).toEqual([]);
    expect(await loadTokens(server.id)).toBeNull();
    expect(secureValues.has(`nautilo.push.binding.v1.${server.id}`)).toBe(false);
    const tombstones = await listPushRevokeTombstones();
    expect(tombstones.some((entry) => (
      entry.serverUrl === "https://remove-with-push.test"
      && entry.bindingId === bindingId
      && entry.revokeProof === revokeProof
    ))).toBe(true);
  });
});
