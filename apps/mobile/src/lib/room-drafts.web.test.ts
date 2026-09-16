import { describe, expect, test } from "bun:test";

import {
  consumeRoomDraft,
  createBrowserRoomDraftStore,
  ROOM_DRAFT_LIMITS,
  saveRoomDraft,
} from "./room-drafts.web";
import {
  createBrowserScopedStore,
  type BrowserStorageArea,
} from "@/platform/browser-storage.web";

class MemoryStorage implements BrowserStorageArea {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const scope = { serverId: "server-a", viewerId: "human-a", roomId: "room-a" };

function drafts(storage: BrowserStorageArea | null, origin = "https://one.example") {
  return createBrowserRoomDraftStore({ origin, storage });
}

describe("browser room drafts", () => {
  test("isolates text by exact origin, Human, server, and Room", async () => {
    const storage = new MemoryStorage();
    const one = drafts(storage);
    const otherOrigin = drafts(storage, "https://two.example");
    const otherHuman = { ...scope, viewerId: "human-b" };
    const otherRoom = { ...scope, roomId: "room-b" };
    const otherServer = { ...scope, serverId: "server-b" };

    expect(await one.save(scope, "hello", 100)).toBe("saved");
    expect(await one.consume(scope, 101)).toBe("hello");
    expect(await one.consume(otherHuman, 101)).toBe("");
    expect(await one.consume(otherRoom, 101)).toBe("");
    expect(await one.consume(otherServer, 101)).toBe("");
    expect(await otherOrigin.consume(scope, 101)).toBe("");
  });

  test("drops every attachment from snapshots while retaining supported text", async () => {
    const storage = new MemoryStorage();
    const store = drafts(storage);
    const opaqueNativeValue = "must-not-persist";

    expect(await store.saveSnapshot(scope, {
      text: "review this",
      attachments: [{ id: opaqueNativeValue, filename: "photo.png" }],
    }, 100)).toBe("saved");
    expect(await store.consumeSnapshot(scope, 101)).toEqual({ text: "review this", attachments: [] });
    expect([...storage.values.values()].join(" ")).not.toContain(opaqueNativeValue);
    expect(await store.saveSnapshot(scope, { text: "", attachments: [{ id: "only-file" }] }, 102)).toBe("discarded");
    expect(await store.consumeSnapshot(scope, 103)).toEqual({ text: "", attachments: [] });
  });

  test("cleans corrupt, expired, and future records", async () => {
    const storage = new MemoryStorage();
    const store = drafts(storage);
    await store.save(scope, "valid", 100);
    const [key] = storage.values.keys();
    if (!key) throw new Error("Expected saved browser draft key.");
    storage.values.set(key, "not-json");
    expect(await store.consume(scope, 101)).toBe("");
    expect(storage.values.size).toBe(0);

    await store.save(scope, "strict", 100);
    const [strictKey] = storage.values.keys();
    if (!strictKey) throw new Error("Expected saved browser draft key.");
    const envelope = JSON.parse(storage.values.get(strictKey) ?? "{}") as {
      value?: Record<string, unknown>;
    };
    storage.values.set(strictKey, JSON.stringify({
      ...envelope,
      value: { ...envelope.value, attachments: [{ id: "native-shaped" }] },
    }));
    expect(await store.consume(scope, 101)).toBe("");
    expect(storage.values.size).toBe(0);

    await store.save(scope, "old", 100);
    expect(await store.consume(scope, 100 + ROOM_DRAFT_LIMITS.MAX_AGE_MS + 1)).toBe("");
    expect(storage.values.size).toBe(0);

    await store.save(scope, "future", 100 + 60_001);
    expect(await store.consume(scope, 100)).toBe("");
    expect(storage.values.size).toBe(0);
  });

  test("enforces the one KiB bound and explicit discard", async () => {
    const storage = new MemoryStorage();
    const store = drafts(storage);
    expect(await store.save(scope, "a".repeat(ROOM_DRAFT_LIMITS.MAX_BYTES), 100)).toBe("saved");
    expect(await store.save(scope, "a".repeat(ROOM_DRAFT_LIMITS.MAX_BYTES + 1), 101)).toBe("too-large");
    expect(await store.consume(scope, 102)).toBe("");
    expect(await store.save(scope, "again", 103)).toBe("saved");
    expect(await store.save(scope, "", 104)).toBe("discarded");
    expect(await store.consume(scope, 105)).toBe("");
  });

  test("fails writes closed when ordinary browser storage is unavailable", async () => {
    const store = drafts(null);
    expect(await store.consume(scope, 100)).toBe("");
    let failure: unknown;
    try {
      await store.save(scope, "hello", 100);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("could not save");
  });

  test("revision fencing preserves a newer draft against stale cleanup", async () => {
    const storage = new MemoryStorage();
    const scoped = createBrowserScopedStore({
      namespace: "room-draft.fence",
      scope: { origin: "https://one.example", humanId: scope.viewerId },
      storage,
      validate: (value: unknown): value is { readonly text: string; readonly savedAt: number; readonly version: 1 } =>
        !!value && typeof value === "object" && (value as { version?: unknown }).version === 1,
    });
    await scoped.replace({ version: 1, text: "old", savedAt: 100 }, 0);
    const stale = await scoped.read();
    expect(await scoped.replace({ version: 1, text: "new", savedAt: 200 }, stale.revision)).toBe(true);
    expect(await scoped.clear(stale.revision)).toBe(false);
    expect((await scoped.read()).value?.text).toBe("new");
  });

  test("direct draft discard cannot erase a newer cross-tab write", async () => {
    const storage = new MemoryStorage();
    const store = drafts(storage);
    await store.save(scope, "old", 100);
    const [key] = storage.values.keys();
    if (!key) throw new Error("Expected saved browser draft key.");
    const original = JSON.parse(storage.values.get(key) ?? "{}") as { revision: number; value: unknown };
    let raceArmed = true;
    const originalGet = storage.getItem.bind(storage);
    storage.getItem = (requestedKey) => {
      const raw = originalGet(requestedKey);
      if (raceArmed && requestedKey === key) {
        raceArmed = false;
        storage.values.set(key, JSON.stringify({
          ...original,
          revision: original.revision + 1,
          value: { version: 1, text: "new", savedAt: 101 },
        }));
      }
      return raw;
    };

    let failure: unknown;
    try {
      await store.save(scope, "", 102);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(await store.consume(scope, 103)).toBe("new");
  });

  test("normalizes equivalent HTTP(S) origins before deriving the storage key", async () => {
    const storage = new MemoryStorage();
    const withPath = drafts(storage, "https://one.example/mobile?theme=dark");
    const plainOrigin = drafts(storage, "https://one.example");
    expect(await withPath.save(scope, "same origin", 100)).toBe("saved");
    expect(await plainOrigin.consume(scope, 101)).toBe("same origin");
  });

  test("SSR facade reads empty and never invents a persistence fallback", async () => {
    expect(await consumeRoomDraft(scope, undefined, 100)).toBe("");
    expect(saveRoomDraft(scope, "server render", undefined, 100)).rejects.toThrow(
      "Browser draft storage is unavailable",
    );
  });
});
