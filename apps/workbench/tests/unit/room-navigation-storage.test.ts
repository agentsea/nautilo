import { describe, expect, test } from "bun:test";
import {
  buildRoomNavStorageKey,
  createRoomNavigationStorage,
  ROOM_NAV_STORAGE_VERSION,
  stableViewerKeyForStorage,
} from "../../src/rooms/room-navigation-storage";

function memoryStorage(): {
  store: Map<string, string>;
  port: import("../../src/rooms/room-navigation-storage").RoomNavigationStoragePort;
} {
  const store = new Map<string, string>();
  return {
    store,
    port: {
      getItem(k) {
        return store.get(k) ?? null;
      },
      setItem(k, v) {
        store.set(k, v);
      },
      removeItem(k) {
        store.delete(k);
      },
    },
  };
}

describe("room-navigation-storage", () => {
  test("stableViewerKeyForStorage keeps an authenticated Guest isolated by user", () => {
    expect(
      stableViewerKeyForStorage({
        isVerified: false,
        sessionUserId: "u1",
        userIdentity: "id",
      }),
    ).toBe("u1");
  });

  test("stableViewerKeyForStorage prefers sessionUserId", () => {
    expect(
      stableViewerKeyForStorage({
        isVerified: true,
        sessionUserId: "uuid-1",
        userIdentity: "legacy",
      }),
    ).toBe("uuid-1");
  });

  test("cross-viewer isolation via distinct keys", () => {
    const { store, port } = memoryStorage();
    const a = createRoomNavigationStorage({
      storage: port,
      origin: "http://localhost:5173",
      viewerKey: "alice",
    });
    const b = createRoomNavigationStorage({
      storage: port,
      origin: "http://localhost:5173",
      viewerKey: "bob",
    });
    a.save({
      version: ROOM_NAV_STORAGE_VERSION,
      lastActiveRoomId: "r1",
      rooms: {},
    });
    expect(b.load().lastActiveRoomId).toBeUndefined();
    expect(a.load().lastActiveRoomId).toBe("r1");
    expect(store.size).toBe(1);
    b.save({ version: ROOM_NAV_STORAGE_VERSION, lastActiveRoomId: "r2", rooms: {} });
    expect(store.size).toBe(2);
  });

  test("cross-origin isolation", () => {
    const { store, port } = memoryStorage();
    const x = createRoomNavigationStorage({
      storage: port,
      origin: "http://a.example",
      viewerKey: "u",
    });
    const y = createRoomNavigationStorage({
      storage: port,
      origin: "http://b.example",
      viewerKey: "u",
    });
    x.save({ version: ROOM_NAV_STORAGE_VERSION, rooms: { r: { pinned: true } } });
    expect(y.load().rooms.r).toBeUndefined();
    expect(x.load().rooms.r?.pinned).toBe(true);
    expect(store.size).toBe(1);
  });

  test("two distinct keys both persist in the same store", () => {
    const { store, port } = memoryStorage();
    createRoomNavigationStorage({
      storage: port,
      origin: "http://a.example",
      viewerKey: "u",
    }).save({ version: ROOM_NAV_STORAGE_VERSION, rooms: { r1: { pinned: true } } });
    createRoomNavigationStorage({
      storage: port,
      origin: "http://b.example",
      viewerKey: "u",
    }).save({ version: ROOM_NAV_STORAGE_VERSION, rooms: { r2: { pinned: false } } });
    expect(store.size).toBe(2);
  });

  test("corrupt JSON clears only this key", () => {
    const { store, port } = memoryStorage();
    const key = buildRoomNavStorageKey("http://localhost", "u1");
    store.set(key, "{not-json");
    const sut = createRoomNavigationStorage({
      storage: port,
      origin: "http://localhost",
      viewerKey: "u1",
    });
    expect(sut.load().rooms).toEqual({});
    expect(store.has(key)).toBe(false);
  });

  test("unknown fields ignored; known fields round-trip", () => {
    const { port } = memoryStorage();
    const sut = createRoomNavigationStorage({
      storage: port,
      origin: "http://localhost",
      viewerKey: "u1",
    });
    port.setItem(
      buildRoomNavStorageKey("http://localhost", "u1"),
      JSON.stringify({
        version: ROOM_NAV_STORAGE_VERSION,
        lastActiveRoomId: "room-z",
        rooms: {
          r1: {
            pinned: true,
            tabOpen: true,
            closedTab: false,
            lastOpenedAt: 42,
            tabOrder: 2,
            extra: "x",
          },
        },
        surprise: true,
      }),
    );
    const loaded = sut.load();
    expect(loaded.lastActiveRoomId).toBe("room-z");
    expect(loaded.rooms.r1).toEqual({
      pinned: true,
      tabOpen: true,
      closedTab: false,
      lastOpenedAt: 42,
      tabOrder: 2,
    });
  });

  test("no viewer key — persistence disabled, load is empty", () => {
    const { store, port } = memoryStorage();
    const sut = createRoomNavigationStorage({
      storage: port,
      origin: "http://localhost",
      viewerKey: null,
    });
    sut.save({
      version: ROOM_NAV_STORAGE_VERSION,
      lastActiveRoomId: "x",
      rooms: {},
    });
    expect(store.size).toBe(0);
    expect(sut.load().lastActiveRoomId).toBeUndefined();
    expect(sut.persistenceDisabled).toBe(true);
  });
});
