import { LocalStorageProvider } from "./local-storage-provider";
import type { NautiloRuntimePaths } from "./runtime-paths";
import type { RelayStorageZones, StorageZones } from "./storage-provider";

/**
 * Construct the full zone bundle the server and agent share.
 *
 * Four zones post-pivot:
 *   - home     → ~/.nautilo/home/
 *   - scratch  → ~/.nautilo/scratch/  (SIBLING of home/)
 *   - data     → ~/.nautilo/data/
 *   - vault    → ~/.nautilo/vault/
 *
 * Pre-conditions: `ensureDirectoryTree(paths)` has already run, so
 * every zone root exists on disk. Providers construct cheaply
 * (no I/O in the ctor beyond the `realpathSync` on the root).
 *
 * Callers should prefer `toRelayStorageZones(zones)` when handing
 * zones to relay code — it drops `data` and `vault` at the type
 * level, making key-isolation (v8 §9.1) structural.
 */
export function createStorageZones(paths: NautiloRuntimePaths): StorageZones {
  return {
    home: new LocalStorageProvider("home", paths.homeRootDir),
    scratch: new LocalStorageProvider("scratch", paths.scratchDir),
    data: new LocalStorageProvider("data", paths.dataDir),
    vault: new LocalStorageProvider("vault", paths.vaultDir),
  };
}

/**
 * Narrow `StorageZones` to the relay-safe subset.
 *
 * v8 §9.1 key isolation: relay adapters never get providers for
 * `data/` (app internals) or `vault/` (credential store). Making the
 * narrowing explicit at the type level means a mis-wired relay route
 * fails at compile time, not runtime.
 */
export function toRelayStorageZones(zones: StorageZones): RelayStorageZones {
  return { home: zones.home, scratch: zones.scratch };
}
