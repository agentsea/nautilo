/**
 * Centralized non-path constants for the Electron main process.
 *
 * Before this module:
 *   App name, dev URLs, timeouts, caps, the server-ready sentinel,
 *   and starter workspace subdirs were all inlined at their use
 *   sites across 6+ files. Some had comments linking their value
 *   to specific behavior; others were magic numbers with no
 *   explanation. Renaming the app, changing the default dev
 *   server port, or tuning a timeout required hunting.
 *
 * After:
 *   One module owns every non-path configuration value used by
 *   the Electron shell. Each export has a comment explaining
 *   what drives the value (when tunable) or what the downstream
 *   contract is (when it's a shared sentinel).
 *
 * For filesystem paths, see `paths.ts` (split because path
 * resolvers are lazy — they need `app.whenReady` — while these
 * constants are eager).
 */

import { resolveEffectiveServerUrl, resolveInstance } from "@nautilo/config";

// ===========================================================================
// App identity
// ===========================================================================

/**
 * Application name. MUST match:
 *   1. `productName` in electron-builder config
 *   2. `app.setName()` call at top of main.ts (normalizes dev +
 *      packaged runs to the same userData / logs / crashDumps
 *      paths — without this, dev runs use "@nautilo/desktop" from
 *      package.json while packaged builds use this name)
 *   3. `crashReporter.start({ productName })` below
 */
export const APP_NAME = "Nautilo";

/**
 * Crash dump upload endpoint. Placeholder until Phase 2b.6 wires
 * a real endpoint; uploadToServer stays false regardless until
 * then. Dumps still land in app.getPath("crashDumps") for local
 * triage.
 */
export const APP_CRASH_REPORTER_URL = "https://crashes.example.invalid";

// ===========================================================================
// Dev-mode URLs
// ===========================================================================

/**
 * Nautilo server URL in dev-from-source mode from `resolveInstance()` (M071).
 * Post-M167 this is the single origin Electron connects to in dev (the server
 * serves the built SPA at `/`); there is no separate Vite workbench URL.
 */
export function resolveDevServerUrl(): string {
  return resolveEffectiveServerUrl(resolveInstance());
}

// ===========================================================================
// Preflight
// ===========================================================================

/**
 * Max wait time for `probeUrl()` to resolve. URLs that don't
 * respond within this window are treated as unreachable.
 */
export const URL_PROBE_TIMEOUT_MS = 5_000;

// ===========================================================================
// Window state
// ===========================================================================

/** Fallback window size when no persisted state exists. */
export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 } as const;

/**
 * Debounce window for writing window-state.json. Rapid
 * resize/move events coalesce to one disk write at the end of a
 * drag instead of flooding I/O.
 */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

// ===========================================================================
// Logging
// ===========================================================================

/**
 * electron-log's rolling-file cap. When the primary log file
 * exceeds this, electron-log renames it to `main.old.log` and
 * starts a fresh primary file. 5MB keeps a meaningful window of
 * history without eating arbitrary disk.
 */
export const LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Log levels the renderer is allowed to forward via
 * `nautiloDesktop.logger.{level}`. Intentionally excludes
 * "debug" (renderer dev tools already have console logging) and
 * tighter than what electron-log's runtime accepts, so a hostile
 * renderer can't e.g. flip levels at runtime. Readonly — callers
 * shouldn't mutate.
 */
export const RENDERER_ALLOWED_LOG_LEVELS = new Set(["info", "warn", "error"]);

// ===========================================================================
// Workspace defaults (D079)
// ===========================================================================

/**
 * Starter subdirectories created when the default workspace root
 * is first created. Names match the agent's mental model for
 * `zone="workspace"` usage that the D079 Phase 4 system prompt
 * teaches (drafts / research / files-the-user-sent).
 */
export const STARTER_WORKSPACE_SUBDIRS = ["drafts", "research", "from-user"] as const;

// ===========================================================================
// Recent folders (D075 chunk 2 / D079 Phase 1)
// ===========================================================================

/**
 * Max entries kept in the recent-current-folders list. Low cap
 * because beyond ~5 users just re-open via the File menu. This is
 * a recency aid, not a comprehensive history.
 */
export const RECENT_FOLDERS_CAP = 5;

/** Schema version for the recent-folders state file. */
export const RECENT_FOLDERS_SCHEMA_VERSION = 1;

// ===========================================================================
// Recent servers (M123 Phase 2 / Stack 39 Phase 3C)
// ===========================================================================

/** Schema version for the recent-servers state file. */
export const RECENT_SERVERS_SCHEMA_VERSION = 2;
