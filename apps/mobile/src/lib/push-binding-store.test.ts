/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";

// Keep this SecureStore unit test in Bun; native availability belongs to the
// development-build acceptance gate, not this persistence contract.
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

// `mock.module` is process-scoped in Bun. A static ESM import is hoisted ahead
// of those mocks and would load Expo SecureStore → react-native's Flow entry in
// a fresh Bun process. Keep this dynamic import after native seams are mocked.
const {
  MAX_PUSH_REVOKE_TOMBSTONES,
  createPushBindingStore,
} = await import("./push-binding-store");

function harness() {
  const values = new Map<string, string>();
  let now = new Date("2026-08-05T00:00:00.000Z");
  let uuidIndex = 0;
  let byte = 0;
  const secureStore = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
  const store = createPushBindingStore({
    secureStore,
    randomUuid: () => {
      const hex = (++uuidIndex).toString(16).padStart(12, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex}`;
    },
    randomBytes: async (length) => new Uint8Array(Array.from({ length }, () => ++byte)),
    now: () => now,
  });
  return {
    store,
    values,
    secureStore,
    setNow(value: Date) { now = value; },
  };
}

describe("D468 SecureStore push binding material", () => {
  test("creates stable Human-scoped server bindings and fences an older acknowledgement", async () => {
    const { store } = harness();
    const [left, right] = await Promise.all([
      store.loadOrCreateBinding("srv_left", "human-left"),
      store.loadOrCreateBinding("srv_right", "human-right"),
    ]);
    expect(left.bindingId).not.toBe(right.bindingId);
    expect(left.ownerUserId).toBe("human-left");
    expect(left.revokeProof).toHaveLength(64);
    expect((await store.loadOrCreateBinding("srv_left", "human-left")).bindingId).toBe(left.bindingId);

    expect(await store.acknowledgeBinding({
      serverId: "srv_left",
      ownerUserId: "human-left",
      bindingId: left.bindingId,
      acknowledgement: { tokenGeneration: 2, permission: "granted" },
    })).toBe(true);
    expect(await store.acknowledgeBinding({
      serverId: "srv_left",
      ownerUserId: "human-left",
      bindingId: left.bindingId,
      acknowledgement: { tokenGeneration: 1, permission: "granted" },
    })).toBe(false);
    expect((await store.loadBinding("srv_left"))?.lastAcknowledged).toEqual({
      tokenGeneration: 2,
      permission: "granted",
    });
  });

  test("persists proof-only tombstone before deleting binding material", async () => {
    const { store, values, secureStore } = harness();
    const binding = await store.loadOrCreateBinding("srv_remove", "human-remove");
    const originalSet = secureStore.setItemAsync;
    secureStore.setItemAsync = async (key: string, value: string) => {
      if (key === "nautilo.push.revoke-tombstones.v1") throw new Error("disk full");
      await originalSet(key, value);
    };

    let writeFailure: unknown;
    try {
      await store.queueRevokeAndClearBinding({
        serverId: "srv_remove",
        serverUrl: "https://remove.test",
      });
    } catch (error) {
      writeFailure = error;
    }
    expect(writeFailure).toBeInstanceOf(Error);
    expect((writeFailure as Error).message).toBe("disk full");
    expect((await store.loadBinding("srv_remove"))?.bindingId).toBe(binding.bindingId);

    secureStore.setItemAsync = originalSet;
    expect(await store.queueRevokeAndClearBinding({
      serverId: "srv_remove",
      serverUrl: "https://remove.test",
    })).toBe(true);
    expect(await store.loadBinding("srv_remove")).toBeNull();
    const tombstones = await store.listRevokeTombstones();
    expect(tombstones).toEqual([expect.objectContaining({
      serverUrl: "https://remove.test",
      bindingId: binding.bindingId,
      revokeProof: binding.revokeProof,
    })]);
    expect(JSON.stringify(tombstones)).not.toContain("accessToken");
    expect(values.has("nautilo.push.revoke-tombstones.v1")).toBe(true);
  });

  test("bounds offline tombstones and retains retryable cleanup without bearer data", async () => {
    const { store, setNow } = harness();
    for (let index = 0; index < MAX_PUSH_REVOKE_TOMBSTONES + 3; index += 1) {
      const id = `srv_${index}`;
      await store.loadOrCreateBinding(id, `human_${index}`);
      setNow(new Date(Date.UTC(2026, 7, 5, 0, index)));
      await store.queueRevokeAndClearBinding({ serverId: id, serverUrl: `https://${id}.test` });
    }
    const bounded = await store.listRevokeTombstones();
    expect(bounded).toHaveLength(MAX_PUSH_REVOKE_TOMBSTONES);
    expect(bounded.every((entry) => Object.keys(entry).sort().join(",") === "bindingId,createdAt,revokeProof,serverUrl,version")).toBe(true);

    const result = await store.drainRevokeTombstones(async (_entry) => "retry");
    expect(result).toEqual({ attempted: MAX_PUSH_REVOKE_TOMBSTONES, cleared: 0, retained: MAX_PUSH_REVOKE_TOMBSTONES });
    const drained = await store.drainRevokeTombstones(async (_entry) => "terminal");
    expect(drained).toEqual({ attempted: MAX_PUSH_REVOKE_TOMBSTONES, cleared: MAX_PUSH_REVOKE_TOMBSTONES, retained: 0 });
  });

  test("never lets a new Human reuse or overwrite another Human's binding", async () => {
    const { store } = harness();
    const original = await store.loadOrCreateBinding("srv_shared", "human-a");

    let ownerMismatch: unknown = null;
    try {
      await store.loadOrCreateBinding("srv_shared", "human-b");
    } catch (error) {
      ownerMismatch = error;
    }
    expect(ownerMismatch).toBeInstanceOf(Error);
    expect((ownerMismatch as Error).message).toContain("belongs to a different Human");
    expect((await store.loadBinding("srv_shared"))?.bindingId).toBe(original.bindingId);

    expect(await store.clearBinding({
      serverId: "srv_shared",
      bindingId: original.bindingId,
    })).toBe(true);
    const replacement = await store.loadOrCreateBinding("srv_shared", "human-b");
    expect(replacement.ownerUserId).toBe("human-b");
    expect(replacement.bindingId).not.toBe(original.bindingId);
  });

  test("fails closed on pre-release ownerless binding state instead of discarding its proof", async () => {
    const { store, values } = harness();
    const key = "nautilo.push.binding.v1.srv_legacy";
    values.set(key, JSON.stringify({
      version: 1,
      bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revokeProof: "a".repeat(64),
      lastAcknowledged: null,
    }));

    let failure: unknown = null;
    try {
      await store.queueRevokeAndClearBinding({
        serverId: "srv_legacy",
        serverUrl: "https://legacy.test",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("explicit reset");
    expect(values.has(key)).toBe(true);
  });
});
