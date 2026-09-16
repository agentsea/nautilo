/**
 * Disconnect-cache adapter (ISSUE-D145).
 *
 * Mirrors the most-recently-seen frame for the user's ACTIVE room to
 * a sync KV backend (localStorage today). Used solely so a logged-in
 * user whose server is mid-restart still sees their own work
 * instead of the generic guest welcome screen.
 *
 * --------------------------------------------------------------------
 *   Invariants — DO NOT BREAK without re-reading ISSUE-D145.
 * --------------------------------------------------------------------
 *
 *   1. Cache reads may synchronously project the exact active Room's
 *      stale frame while the authoritative rehydrate is in flight.
 *      The server remains ground truth: cache data never suppresses,
 *      merges into, or wins over the server snapshot.
 *
 *   2. Cache writes are debounced 1s per room and only fire on
 *      finalized events: rehydrate-success, message.tokens with
 *      done:true, tool.end, message.new. Never during streaming
 *      (mid-`message.tokens`); writing every token-frame would burn
 *      localStorage IO and persist half-rendered prose.
 *
 *   3. On reconnect-rehydrate-success, the cache is OVERWRITTEN
 *      with the server response. No merging, no diffing — the
 *      server is ground truth always; the cache is never a merge
 *      candidate.
 *
 *   4. Every read, write, and invalidation is fenced by the
 *      exact server origin, stable viewer key, and Room id. The runtime
 *      independently fences each cache projection by its ephemeral viewer
 *      generation; generation is deliberately not durable-key material. A
 *      sign-out/viewer-switch purge is deliberately viewer-wide, but still
 *      exact to the active origin + stable viewer.
 *
 *   5. Only a selected Room's frame is written. A cache miss during
 *      initial hydration is unresolved, not an empty conversation;
 *      the renderer shows its honest loading treatment until the
 *      server result is terminal.
 *
 *   The cache is best-effort. Backend write failures (quota, etc.)
 *   degrade silently to "no cache available" — the runtime treats
 *   misses as "honest empty placeholder" and life goes on.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";
import type {
  CachedRoomFrame,
  DisconnectCache,
  DisconnectCacheBackend,
  DisconnectCacheScope,
  DisconnectCacheViewerScope,
} from "./types";

/**
 * Versioned key prefix. Bumping `v1` invalidates every existing
 * cached frame in one shot if we ever change the on-disk shape.
 */
const KEY_PREFIX = "nautilo.disconnect-cache.v2";

/**
 * Encode a key segment before joining it with `/`. `encodeURIComponent`
 * encodes `/`, so one scope cannot become a prefix of a sibling scope even
 * when an identifier itself contains punctuation.
 */
function keySegment(value: string): string {
  return encodeURIComponent(value);
}

function isUsableScope(scope: DisconnectCacheScope): boolean {
  return (
    Boolean(scope.serverOrigin) &&
    Boolean(scope.viewerKey) &&
    Boolean(scope.roomId)
  );
}

function isUsableViewerScope(scope: DisconnectCacheViewerScope): boolean {
  return Boolean(scope.serverOrigin) && Boolean(scope.viewerKey);
}

function viewerPrefix(scope: DisconnectCacheViewerScope): string {
  return `${KEY_PREFIX}/origin/${keySegment(scope.serverOrigin)}/viewer/${keySegment(scope.viewerKey)}/`;
}

function scopePrefix(scope: DisconnectCacheScope): string {
  return `${viewerPrefix(scope)}room/${keySegment(scope.roomId)}/`;
}

function activeRoomKey(scope: DisconnectCacheScope): string {
  return `${scopePrefix(scope)}messages`;
}

interface StoredRoomFrame {
  v: 1;
  messages: ThreadMessageLike[];
  cachedAt: number;
}

function isRenderableCachedMessage(value: unknown): value is ThreadMessageLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  // localStorage is an untyped persistence boundary. Protected structural
  // rows must never be replayed into Assistant UI before authenticated
  // history reconciliation supplies content.
  return typeof candidate["id"] === "string"
    && Array.isArray(candidate["content"])
    && candidate["content"].every((part) => {
      if (part === null || typeof part !== "object") return false;
      const contentPart = part as Readonly<Record<string, unknown>>;
      return contentPart["type"] !== "text"
        || typeof contentPart["text"] === "string";
    });
}

export function createDisconnectCache(
  backend: DisconnectCacheBackend,
): DisconnectCache {
  return {
    writeActiveRoom(
      scope: DisconnectCacheScope,
      messageSnapshot: readonly ThreadMessageLike[],
    ): void {
      if (!isUsableScope(scope)) return;
      const payload: StoredRoomFrame = {
        v: 1,
        // Copy the captured array so a caller cannot mutate the stored frame
        // after a delayed write has been scheduled.
        messages: [...messageSnapshot],
        cachedAt: Date.now(),
      };
      backend.write<StoredRoomFrame>(activeRoomKey(scope), payload);
    },

    readActiveRoom(scope: DisconnectCacheScope): CachedRoomFrame | null {
      if (!isUsableScope(scope)) return null;
      const raw = backend.read<StoredRoomFrame>(activeRoomKey(scope));
      if (
        !raw
        || raw.v !== 1
        || !Array.isArray(raw.messages)
        || !raw.messages.every(isRenderableCachedMessage)
      ) return null;
      return { messages: raw.messages, cachedAt: raw.cachedAt };
    },

    invalidateActiveRoom(scope: DisconnectCacheScope): void {
      if (!isUsableScope(scope)) return;
      backend.delete(activeRoomKey(scope));
    },

    clearForViewer(scope: DisconnectCacheViewerScope): void {
      if (!isUsableViewerScope(scope)) return;
      backend.clearPrefix(viewerPrefix(scope));
    },
  };
}

export type {
  CachedRoomFrame,
  DisconnectCache,
  DisconnectCacheBackend,
  DisconnectCacheScope,
  DisconnectCacheViewerScope,
} from "./types";
export { createLocalStorageBackend } from "./local-storage-backend";
