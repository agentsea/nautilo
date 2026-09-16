import type { StorageProvider, StorageZones } from "@nautilo/config";

/**
 * Agent-facing artifact storage registry.
 *
 * The six artifact tools (save, read, edit, list, search, delete) run
 * on the server in the "cloud" executor path — they use an in-process
 * `StorageProvider` rather than dispatching through the relay. The
 * server boot sequence calls `setArtifactStorage(zones)` once,
 * exactly like `setRelayRegistry`. Tools fetch via `getArtifactZone`.
 *
 * Only `home` and `scratch` are exposed here — artifact tools MUST
 * NEVER reach into `data/` (app internals) or `vault/` (credentials).
 * That restriction is enforced in two places: a Zod enum on the tool
 * schema (never accepts "data" / "vault") AND this registry only
 * storing the two allowed providers (defence in depth).
 */

type AgentZoneName = "home" | "scratch";

let _home: StorageProvider | null = null;
let _scratch: StorageProvider | null = null;

/**
 * Install the two agent-visible storage providers. Called once at
 * server boot, right after `createStorageZones(paths)`.
 *
 * Accepts the full `StorageZones` bundle but keeps references to only
 * `home` and `scratch`. No way for the agent to reach `data` / `vault`
 * through this registry.
 */
export function setArtifactStorage(zones: StorageZones): void {
  _home = zones.home;
  _scratch = zones.scratch;
}

/**
 * Clear the registry. Intended for test teardown — tests that spin up
 * a temp zone tree should reset the module-global after each run so
 * no leakage between suites.
 */
export function resetArtifactStorage(): void {
  _home = null;
  _scratch = null;
}

/**
 * Look up the provider for one of the two agent-visible zones.
 *
 * Returns `null` if storage hasn't been wired yet — in that case the
 * tool should surface an informative error to the model rather than
 * crashing. Never throws; callers must handle the null.
 */
export function getArtifactZone(zone: AgentZoneName): StorageProvider | null {
  if (zone === "home") return _home;
  if (zone === "scratch") return _scratch;
  return null;
}
