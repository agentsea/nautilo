/**
 * Minimal `window.localStorage` shim for bun:test.
 *
 * The workbench's bun:test runner has no DOM by default (see
 * `apps/workbench/tests/unit/cited-paths.test.ts:10` — "first
 * bun:test suite for @nautilo/workbench. … no React, no DOM"). For
 * tests that exercise pure modules touching `window.localStorage`
 * (e.g. `persisted-ws-history`, `disconnect-cache` future tests),
 * call `installLocalStorageShim()` in `beforeAll` to provide a
 * Map-backed in-memory localStorage.
 *
 * Idempotent — safe to call from multiple test files in the same
 * worker. Only installs when `window` is undefined.
 *
 * # Storage-failure simulation (Stack 19 Phase 6.9.6 lesson)
 *
 * Tests that simulate `setItem` / `getItem` throwing (e.g.
 * persisted-viewer-cache "tolerates storage failure" cases) MUST use
 * `Object.defineProperty(ls, 'setItem', { value: () => throw, ... })`
 * — direct property assignment (`ls.setItem = () => throw`) is a
 * silent no-op under CI environments where `Storage` is a Proxy that
 * rejects own-property writes. The Storage shim defined HERE is a
 * plain object that accepts direct assignment, so direct assignment
 * works locally on macOS but fails silently on Linux CI where
 * happy-dom / equivalent provides a Proxy-backed Storage. Use
 * `Object.defineProperty` for portable behaviour.
 */

export function installLocalStorageShim(): void {
  if (typeof globalThis.window !== "undefined") return;
  const store = new Map<string, string>();
  const localStorageShim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStorageShim },
    configurable: true,
    writable: true,
  });
}
