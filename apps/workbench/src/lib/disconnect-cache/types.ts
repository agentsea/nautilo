/**
 * Disconnect-cache adapter — interface seam.
 *
 * Backend interface is sync to keep the localStorage implementation
 * trivial; the shape (returns `null` for misses, accepts arbitrary
 * JSON-shaped values) is also the natural shape for an async
 * AsyncStorage / electron-store / IndexedDB adapter, so swapping
 * backends later is a wrap-with-Promise change at the call sites.
 *
 * See `./index.ts` for the higher-level `DisconnectCache` API and the
 * cache invariants.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";

/**
 * Sync key/value backend. The localStorage implementation in
 * `local-storage-backend.ts` is the only impl today; the interface
 * exists so a future Electron-side persistent store can drop in
 * without churning callers.
 *
 * Implementations MUST swallow per-call errors (quota, JSON shape,
 * disabled storage) and degrade to "miss" rather than throwing — the
 * cache is best-effort and a storage failure must not crash the app.
 */
export interface DisconnectCacheBackend {
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): void;
  delete(key: string): void;
  /** Remove every key whose name starts with `prefix`. */
  clearPrefix(prefix: string): void;
}

export interface CachedRoomFrame {
  /** Cached message list — mirrors what was last seen via the WS bus. */
  readonly messages: readonly ThreadMessageLike[];
  /** Epoch ms — when the cache entry was last written. */
  cachedAt: number;
}

/**
 * Immutable authority fence for a persisted Room frame.
 *
 * A Room id is not sufficient for durable browser storage: the same browser
 * profile can visit more than one server. Every cache operation takes this
 * whole durable scope so a caller cannot accidentally omit one of those
 * fences. The runtime's ephemeral viewer-generation fence remains separate:
 * placing it in a durable localStorage key would make every reload miss.
 */
export interface DisconnectCacheScope {
  /** Exact active server origin (for example, `https://team.example`). */
  readonly serverOrigin: string;
  /** Stable authenticated session-user storage key. */
  readonly viewerKey: string;
  /** Active Room whose transcript this frame represents. */
  readonly roomId: string;
}

/**
 * Durable owner fence for a sign-out / viewer-switch purge. It intentionally
 * omits Room id because privacy requires removing every Room frame belonging
 * to that viewer on that server.
 */
export interface DisconnectCacheViewerScope {
  readonly serverOrigin: string;
  readonly viewerKey: string;
}

/**
 * Higher-level disconnect-cache API used by the runtime.
 *
 * Scope: ACTIVE ROOM ONLY. Every operation carries an exact immutable
 * server-origin + viewer + Room fence. The runtime owns its separate
 * viewer-generation admission fence. We cache the
 * most-recently-seen frame for the active room so a hard reload can render
 * an honest stale projection while the authoritative server snapshot loads.
 *
 * The cache is NEVER a merge candidate. On a successful rehydrate,
 * the server response atomically replaces the cached frame; we never
 * diff or interleave.
 */
export interface DisconnectCache {
  writeActiveRoom(
    scope: DisconnectCacheScope,
    /**
     * Readonly message array captured when the write is scheduled. Timers
     * must never look through a mutable live `messagesRef` when they fire.
     */
    messageSnapshot: readonly ThreadMessageLike[],
  ): void;
  readActiveRoom(scope: DisconnectCacheScope): CachedRoomFrame | null;
  /** Remove the one exact Room frame after an authorization/not-found result. */
  invalidateActiveRoom(scope: DisconnectCacheScope): void;
  /**
   * Privacy purge for sign-out / viewer switch. Clears every Room for this
   * exact origin + stable viewer, never a different origin or viewer.
   */
  clearForViewer(scope: DisconnectCacheViewerScope): void;
}
