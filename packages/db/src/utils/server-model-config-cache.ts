import { eq } from "drizzle-orm";
import { db } from "../config/database";
import {
  serverModelConfig,
  type ServerModelConfigRow,
} from "../schema/server-model-config";

/**
 * D281 — write-through in-memory cache of the server model config row.
 *
 * Why a cache: the consumers (`getDefaultModel`, the Conductor invoker,
 * `resolveFallbackPolicy`) are sync / hot-path. Making them DB-aware without an
 * async refactor of every call site means reading a process-local snapshot of
 * the singleton row. Liveness comes from three triggers:
 *   1. boot prime (`refreshServerModelConfigCache(true)` at server start),
 *   2. write-through on the admin POST (`primeServerModelConfigCache(row)`),
 *   3. a TTL backstop so a second instance picks up changes eventually.
 *
 * Stores the RAW row (nullable fields), NOT the resolved config — consumers
 * apply their own fallback, which avoids the circular dependency where the
 * "default" would otherwise come from `getDefaultModel` itself.
 */

let cachedRow: ServerModelConfigRow | null = null;
let lastLoadMs = 0;
let inFlight: Promise<ServerModelConfigRow | null> | null = null;

/** TTL backstop for multi-instance freshness. One-server-per-DB today. */
const TTL_MS = 5_000;

/** Sync snapshot read. `null` until the cache is primed (consumers fall back). */
export function getCachedServerModelConfigRow(): ServerModelConfigRow | null {
  return cachedRow;
}

/** Write-through: callers that just upserted the row prime the cache directly. */
export function primeServerModelConfigCache(
  row: ServerModelConfigRow | null,
): void {
  cachedRow = row;
  lastLoadMs = Date.now();
}

/**
 * Refresh from the DB. Coalesces concurrent calls. Pass `force` at boot or when
 * you must bypass the TTL. Swallows errors (returns the stale snapshot) — a
 * transient DB blip should never break model resolution.
 */
export async function refreshServerModelConfigCache(
  force = false,
): Promise<ServerModelConfigRow | null> {
  if (!force && Date.now() - lastLoadMs < TTL_MS) return cachedRow;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [row] = await db
        .select()
        .from(serverModelConfig)
        .where(eq(serverModelConfig.id, "server"))
        .limit(1);
      primeServerModelConfigCache(row ?? null);
    } catch {
      // Keep the stale snapshot; do not clobber on transient failure.
    } finally {
      inFlight = null;
    }
    return cachedRow;
  })();
  return inFlight;
}

/**
 * Fire-and-forget liveness kick for sync consumers: if the TTL has lapsed,
 * trigger a background refresh and return immediately. The current read still
 * uses the (possibly slightly stale) snapshot; the next read sees fresh data.
 */
export function kickServerModelConfigRefresh(): void {
  if (Date.now() - lastLoadMs < TTL_MS) return;
  void refreshServerModelConfigCache(false);
}

/** Test-only reset. */
export function __resetServerModelConfigCache(): void {
  cachedRow = null;
  lastLoadMs = 0;
  inFlight = null;
}
