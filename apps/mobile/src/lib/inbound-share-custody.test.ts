import { describe, expect, test } from "bun:test";

import {
  claimInboundShareReceipt,
  clearInboundShareReceiptForServer,
  clearInboundShareReceiptForScope,
  INBOUND_SHARE_CUSTODY_DEVICE_KEY,
  INBOUND_SHARE_MAX_AGE_MS,
  INBOUND_SHARE_MAX_BYTES,
  saveInboundShareReceipt,
  stageNativeInboundFileReceipt,
  type InboundShareCustodyStore,
} from "./inbound-share-custody";

class MemoryStore implements InboundShareCustodyStore {
  readonly values = new Map<string, string>();
  async getItemAsync(key: string) { return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { this.values.set(key, value); }
  async deleteItemAsync(key: string) { this.values.delete(key); }
}

const scopeA = { serverId: "server-a", viewerId: "viewer-a" };
const scopeB = { serverId: "server-b", viewerId: "viewer-b" };
const receipt = {
  id: "share-12345678",
  nativeReceiptId: "native-12345678",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 42,
  createdAt: new Date(100).toISOString(),
};

describe("inbound file custody", () => {
  test("persists only opaque metadata and binds an unclaimed receipt exactly once", async () => {
    const store = new MemoryStore();
    await saveInboundShareReceipt(receipt, null, store, 100);
    const serialized = store.values.get(INBOUND_SHARE_CUSTODY_DEVICE_KEY)!;
    expect(serialized).toContain(receipt.nativeReceiptId);
    expect(serialized).not.toMatch(/uri|path|base64/i);
    expect(await claimInboundShareReceipt(scopeA, store, 101)).toEqual(receipt);
    const stored = JSON.parse(store.values.get(INBOUND_SHARE_CUSTODY_DEVICE_KEY)!) as { scope: unknown };
    expect(stored.scope).toEqual({ server: "server-a", viewer: "viewer-a" });
    expect(await claimInboundShareReceipt(scopeB, store, 102)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  test("rejects raw locations, corrupt entries, oversized files, and expired receipts", async () => {
    const store = new MemoryStore();
    let failure: unknown;
    try { await saveInboundShareReceipt({ ...receipt, sizeBytes: INBOUND_SHARE_MAX_BYTES + 1 }, null, store, 100); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(RangeError);
    failure = undefined;
    try { await saveInboundShareReceipt({ ...receipt, uri: "file:///private/x" } as unknown as typeof receipt, null, store, 100); } catch (caught) { failure = caught; }
    expect(failure).toBeInstanceOf(RangeError);
    store.values.set(INBOUND_SHARE_CUSTODY_DEVICE_KEY, JSON.stringify({ ...receipt, version: 1, savedAt: 100, path: "/private/x" }));
    expect(await claimInboundShareReceipt(scopeA, store, 101)).toBeNull();
    await saveInboundShareReceipt(receipt, null, store, 100);
    expect(await claimInboundShareReceipt(scopeA, store, 101 + INBOUND_SHARE_MAX_AGE_MS)).toBeNull();
  });

  test("cleans only the matching bound scope or removed server", async () => {
    const store = new MemoryStore();
    await saveInboundShareReceipt(receipt, scopeA, store, 100);
    await clearInboundShareReceiptForScope(scopeB, store, 101);
    expect(await claimInboundShareReceipt(scopeA, store, 102)).toEqual(receipt);
    await clearInboundShareReceiptForServer("server-a", store, 103);
    expect(await claimInboundShareReceipt(scopeA, store, 104)).toBeNull();
  });

  test("acks native inbox only after metadata custody commits", async () => {
    const calls: string[] = [];
    const native = {
      peekAsync: async () => receipt,
      ackAsync: async () => { calls.push("ack"); return true; },
      clearAsync: async () => { calls.push("clear"); },
    };
    let failure: unknown;
    try { await stageNativeInboundFileReceipt(async () => { calls.push("save"); throw new Error("locked"); }, 100, native); } catch (caught) { failure = caught; }
    expect((failure as Error).message).toBe("locked");
    expect(calls).toEqual(["save"]);
    calls.length = 0;
    expect(await stageNativeInboundFileReceipt(async () => { calls.push("save"); }, 100, native)).toEqual(receipt);
    expect(calls).toEqual(["save", "ack"]);
  });
});
