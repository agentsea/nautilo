/**
 * localStorage-backed `DisconnectCacheBackend` implementation.
 *
 * Best-effort: storage quota exhaustion / private-window denial /
 * JSON shape errors are swallowed (one console.warn the first time
 * a write fails so the operator has a bread crumb) so a full disk
 * never crashes the renderer.
 */

import type { DisconnectCacheBackend } from "./types";

export function createLocalStorageBackend(): DisconnectCacheBackend {
  let quotaWarned = false;

  const storage = (): Storage | null => {
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      // Some sandboxed contexts throw on access (e.g. cookies
      // disabled). Treat as no-storage.
      return null;
    }
  };

  return {
    read<T>(key: string): T | null {
      const ls = storage();
      if (!ls) return null;
      try {
        const raw = ls.getItem(key);
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    write<T>(key: string, value: T): void {
      const ls = storage();
      if (!ls) return;
      try {
        ls.setItem(key, JSON.stringify(value));
      } catch (err) {
        if (!quotaWarned) {
          quotaWarned = true;
          console.warn(
            "[disconnect-cache] localStorage write failed (likely quota); cache disabled for the rest of this session",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    },
    delete(key: string): void {
      const ls = storage();
      if (!ls) return;
      try {
        ls.removeItem(key);
      } catch {
        /* swallow */
      }
    },
    clearPrefix(prefix: string): void {
      const ls = storage();
      if (!ls) return;
      try {
        const victims: string[] = [];
        for (let i = 0; i < ls.length; i += 1) {
          const k = ls.key(i);
          if (k && k.startsWith(prefix)) victims.push(k);
        }
        for (const k of victims) ls.removeItem(k);
      } catch {
        /* swallow */
      }
    },
  };
}
