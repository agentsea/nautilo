import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Repo-root `apps/workbench/dist` if it contains a built `index.html`,
 * else null. Used to auto-serve the Workbench SPA single-origin from the
 * foreground `bun run server` without requiring NAUTILO_WORKBENCH_DIST to be
 * set by hand. Container + dev-stack set the env explicitly and never reach
 * this fallback.
 *
 * `repoRootHint` lets callers pass a known root; defaults to walking up from
 * this module's location (packages/config/src -> repo root).
 */
export function resolveDefaultWorkbenchDist(repoRootHint?: string): string | null {
  const repoRoot = repoRootHint ?? resolve(import.meta.dirname, "../../..");
  const dist = join(repoRoot, "apps/workbench/dist");
  return existsSync(join(dist, "index.html")) ? dist : null;
}
