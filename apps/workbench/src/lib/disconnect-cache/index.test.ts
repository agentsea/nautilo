import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { createDisconnectCache } from "./index";
import type { DisconnectCacheBackend, DisconnectCacheScope } from "./types";

function scope(
  overrides: Partial<DisconnectCacheScope> = {},
): DisconnectCacheScope {
  return Object.freeze({
    serverOrigin: "https://server-a.example",
    viewerKey: "viewer-a",
    roomId: "room-a",
    ...overrides,
  });
}

function message(id: string): ThreadMessageLike {
  return { id, role: "user", content: [{ type: "text", text: id }] };
}

function createMemoryBackend(): {
  backend: DisconnectCacheBackend;
  keys: () => readonly string[];
} {
  const entries = new Map<string, unknown>();
  return {
    backend: {
      read<T>(key: string): T | null {
        return (entries.get(key) as T | undefined) ?? null;
      },
      write<T>(key: string, value: T): void {
        entries.set(key, value);
      },
      delete(key: string): void {
        entries.delete(key);
      },
      clearPrefix(prefix: string): void {
        for (const key of entries.keys()) {
          if (key.startsWith(prefix)) entries.delete(key);
        }
      },
    },
    keys: () => [...entries.keys()],
  };
}

describe("disconnect cache exact scope", () => {
  test("round-trips only the exact durable origin, viewer, and Room", () => {
    const { backend, keys } = createMemoryBackend();
    const cache = createDisconnectCache(backend);
    const active = scope();
    const frames = [message("message-a")];

    cache.writeActiveRoom(active, frames);

    expect(cache.readActiveRoom(active)?.messages).toEqual(frames);
    expect(cache.readActiveRoom(scope({ serverOrigin: "https://server-b.example" }))).toBeNull();
    expect(cache.readActiveRoom(scope({ viewerKey: "viewer-b" }))).toBeNull();
    expect(cache.readActiveRoom(scope({ roomId: "room-b" }))).toBeNull();
    expect(keys()).toEqual([
      "nautilo.disconnect-cache.v2/origin/https%3A%2F%2Fserver-a.example/viewer/viewer-a/room/room-a/messages",
    ]);
  });

  test("uses a captured readonly snapshot instead of retaining the caller's array", () => {
    const { backend } = createMemoryBackend();
    const cache = createDisconnectCache(backend);
    const snapshot = [message("scheduled")];

    cache.writeActiveRoom(scope(), snapshot);
    snapshot.push(message("later-live-ref-value"));

    expect(cache.readActiveRoom(scope())?.messages).toEqual([message("scheduled")]);
  });

  test("treats a durable empty frame as a cache hit", () => {
    const { backend } = createMemoryBackend();
    const cache = createDisconnectCache(backend);

    cache.writeActiveRoom(scope(), []);

    expect(cache.readActiveRoom(scope())).toMatchObject({ messages: [] });
  });

  test("rejects a protected structural text part before Assistant UI projection", () => {
    const { backend } = createMemoryBackend();
    const cache = createDisconnectCache(backend);
    cache.writeActiveRoom(scope(), [{
      id: "protected-structural",
      role: "user",
      content: [{ type: "text", text: null }],
    } as unknown as ThreadMessageLike]);

    expect(cache.readActiveRoom(scope())).toBeNull();
  });

  test("misses invalid scopes without invoking backend storage", () => {
    const { backend, keys } = createMemoryBackend();
    const cache = createDisconnectCache(backend);

    cache.writeActiveRoom(scope({ serverOrigin: "" }), [message("ignored")]);

    expect(cache.readActiveRoom(scope({ roomId: "missing" }))).toBeNull();
    expect(keys()).toEqual([]);
  });

  test("invalidation removes only the exact Room frame", () => {
    const { backend } = createMemoryBackend();
    const cache = createDisconnectCache(backend);
    const active = scope();
    const siblingRoom = scope({ roomId: "room-b" });
    cache.writeActiveRoom(active, [message("active")]);
    cache.writeActiveRoom(siblingRoom, [message("sibling-room")]);

    cache.invalidateActiveRoom(active);

    expect(cache.readActiveRoom(active)).toBeNull();
    expect(cache.readActiveRoom(siblingRoom)?.messages).toEqual([message("sibling-room")]);
  });

  test("viewer purge clears all its Rooms but cannot cross origin or viewer boundaries", () => {
    const { backend } = createMemoryBackend();
    const cache = createDisconnectCache(backend);
    const active = scope({ viewerKey: "viewer" });
    const otherRoom = scope({ viewerKey: "viewer", roomId: "room-b" });
    const otherViewer = scope({ viewerKey: "viewer/other" });
    const otherOrigin = scope({ serverOrigin: "https://server-b.example" });
    cache.writeActiveRoom(active, [message("active")]);
    cache.writeActiveRoom(otherRoom, [message("other-room")]);
    cache.writeActiveRoom(otherViewer, [message("other-viewer")]);
    cache.writeActiveRoom(otherOrigin, [message("other-origin")]);

    cache.clearForViewer(active);

    expect(cache.readActiveRoom(active)).toBeNull();
    expect(cache.readActiveRoom(otherRoom)).toBeNull();
    expect(cache.readActiveRoom(otherViewer)?.messages).toEqual([message("other-viewer")]);
    expect(cache.readActiveRoom(otherOrigin)?.messages).toEqual([message("other-origin")]);
  });
});
