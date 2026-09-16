import { describe, expect, test } from "bun:test";

import {
  claimPendingShare,
  clearPendingShare,
  clearPendingShareForScope,
  clearPendingShareForServer,
  loadPendingShare,
  PENDING_SHARE_MAX_AGE_MS,
  PENDING_SHARE_DEVICE_KEY,
  savePendingShare,
  type PendingShareStore,
} from "./pending-share";

class MemoryStore implements PendingShareStore {
  readonly values = new Map<string, string>();
  async getItemAsync(key: string) { return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { this.values.set(key, value); }
  async deleteItemAsync(key: string) { this.values.delete(key); }
}

const intent = { id: "share-12345678", kind: "url" as const, value: "https://example.com", createdAt: "2026-08-09T00:00:00.000Z" };

describe("pending share custody", () => {
  test("uses one device-only encrypted staging slot before server selection", async () => {
    const store = new MemoryStore();
    await savePendingShare(intent, store, 100);
    expect(await loadPendingShare(store, 101)).toEqual(intent);
    expect(PENDING_SHARE_DEVICE_KEY).not.toContain("server-a");
    expect(PENDING_SHARE_DEVICE_KEY).not.toContain("human-a");
  });

  test("clears expired and corrupt records", async () => {
    const store = new MemoryStore();
    await savePendingShare(intent, store, 100);
    expect(await loadPendingShare(store, 100 + PENDING_SHARE_MAX_AGE_MS)).toEqual(intent);
    expect(await loadPendingShare(store, 101 + PENDING_SHARE_MAX_AGE_MS)).toBeNull();
    expect(store.values.size).toBe(0);
    store.values.set(PENDING_SHARE_DEVICE_KEY, "{");
    expect(await loadPendingShare(store, 103)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("enforces the same 1 KiB handoff boundary before write and while loading", async () => {
    const store = new MemoryStore();
    const tooLarge = { ...intent, value: "a".repeat(1025) };
    let failure: unknown;
    try {
      await savePendingShare(tooLarge, store, 100);
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(RangeError);
    expect(store.values.size).toBe(0);

    store.values.set(PENDING_SHARE_DEVICE_KEY, JSON.stringify({ ...tooLarge, version: 1, savedAt: 100 }));
    expect(await loadPendingShare(store, 101)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("rejects malformed identity and timestamp fields instead of replaying a corrupt record", async () => {
    const store = new MemoryStore();
    store.values.set(PENDING_SHARE_DEVICE_KEY, JSON.stringify({
      ...intent,
      id: "not a share id",
      createdAt: "not-a-date",
      version: 1,
      savedAt: 100,
    }));
    expect(await loadPendingShare(store, 101)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("explicit cancel deletes the pending record", async () => {
    const store = new MemoryStore();
    await savePendingShare(intent, store, 100);
    await clearPendingShare(store);
    expect(await loadPendingShare(store, 101)).toBeNull();
  });

  test("keeps a signed-out receipt unclaimed until the first verified identity, then fences it", async () => {
    const store = new MemoryStore();
    const ownerA = { serverId: "server-a", viewerId: "viewer-a" };
    const ownerB = { serverId: "server-b", viewerId: "viewer-b" };
    await savePendingShare(intent, store, 100);
    expect(await claimPendingShare(ownerA, store, 101)).toEqual(intent);
    const stored = JSON.parse(store.values.get(PENDING_SHARE_DEVICE_KEY)!) as { scope: unknown };
    expect(stored.scope).toEqual({ server: "server-a", viewer: "viewer-a" });
    expect(await claimPendingShare(ownerB, store, 102)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("logout/server cleanup deletes only a receipt bound to that scope", async () => {
    const store = new MemoryStore();
    const ownerA = { serverId: "server-a", viewerId: "viewer-a" };
    const ownerB = { serverId: "server-b", viewerId: "viewer-b" };
    await savePendingShare(intent, store, 100, ownerA);
    await clearPendingShareForScope(ownerB, store, 101);
    expect(await claimPendingShare(ownerA, store, 102)).toEqual(intent);
    await clearPendingShareForServer("server-a", store, 103);
    expect(await loadPendingShare(store, 104)).toBeNull();
  });
});
