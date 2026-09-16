/**
 * D384 Phase 3 §3.0/§3.1 — process-global handle to the live
 * `McpClientManager` so the `/api/mcp-servers` mutation route can
 * trigger a hot-reload (`reconcile`) after a config write without
 * the manager having to be threaded through every dep-injection
 * seam.
 *
 * Mirrors `packages/catalog/src/singleton.ts` in style: a let-bound
 * slot + `set`/`get` pair. The manager is installed by `createApp`
 * immediately after `startMcpHost` returns and cleared in the
 * `onClose` hook alongside `mcpManager.stopAll()`.
 *
 * The slot is nullable so a route handler can best-effort skip the
 * reconcile when the host is not running (e.g. the test app-fixture
 * installs no catalog, or the host failed to boot non-fatally).
 */

import type { McpClientManager } from "@nautilo/mcp-client";

let _mgr: McpClientManager | null = null;

export function setMcpClientManager(m: McpClientManager | null): void {
  _mgr = m;
}

export function getMcpClientManager(): McpClientManager | null {
  return _mgr;
}
