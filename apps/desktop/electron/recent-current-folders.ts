/**
 * Recent-current-folders registry (D079 Phase 1 rename of
 * recent-workspaces.ts; D075 chunk 2 for the original design).
 *
 * A small JSON file at `~/.nautilo/recent-current-folders.json` holding
 * the last N task-scoped folders the user pointed Nautilo at, most-
 * recent first. Feeds two surfaces in lockstep:
 *
 *   1. The CurrentFolderHeader dropdown (renderer) — RECENT section
 *      below CURRENT.
 *   2. The native macOS menu's `File → Recent Folders ▸` submenu —
 *      rebuilt on every commit so it stays live.
 *
 * Keeping this outside `current-folder.json` (which is Electron-managed,
 * per-app) because `~/.nautilo/` is the shared Nautilo home across
 * desktop, CLI, and server — recent folders should survive if the user
 * wipes the Electron userData directory to reset the app but wants to
 * keep their project history.
 *
 * Migration note: prior versions of this module stored at
 * `~/.nautilo/recent-workspaces.json`. On first boot post-D079 Phase 1,
 * if the legacy file exists and the new one doesn't, we migrate.
 *
 * Cap is low (5) because beyond that users just use "Open folder…"
 * again. This isn't a comprehensive history; it's a recency aid.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import log from "electron-log/main";
import {
  recentFoldersFilePath,
  legacyRecentFoldersFilePath,
} from "./paths";
import {
  RECENT_FOLDERS_CAP,
  RECENT_FOLDERS_SCHEMA_VERSION,
} from "./constants";

interface StoredState {
  v: number;
  paths: string[];
}

/**
 * One-shot migration from `~/.nautilo/recent-workspaces.json` →
 * `~/.nautilo/recent-current-folders.json`. Safe to call on every boot:
 * no-op if the new file exists OR the legacy file doesn't.
 *
 * Called from main.ts boot flow BEFORE any readRaw() / listRecent() /
 * pushRecent() / pruneMissing() call so the migration completes
 * transparently.
 */
export function migrateLegacyFile(): void {
  const newPath = recentFoldersFilePath();
  const oldPath = legacyRecentFoldersFilePath();

  let newExists = false;
  try {
    newExists = fs.statSync(newPath).isFile();
  } catch {
    newExists = false;
  }
  if (newExists) return;

  let oldExists = false;
  try {
    oldExists = fs.statSync(oldPath).isFile();
  } catch {
    oldExists = false;
  }
  if (!oldExists) return;

  try {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    log.info(
      `[desktop] migrated recent-workspaces.json → recent-current-folders.json (D079 Phase 1)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop] recent-workspaces migration failed: ${msg}`);
  }
}

function readRaw(): StoredState {
  try {
    const raw = fs.readFileSync(recentFoldersFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (parsed.v !== RECENT_FOLDERS_SCHEMA_VERSION) return { v: RECENT_FOLDERS_SCHEMA_VERSION, paths: [] };
    if (!Array.isArray(parsed.paths)) return { v: RECENT_FOLDERS_SCHEMA_VERSION, paths: [] };
    const paths = parsed.paths.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return { v: RECENT_FOLDERS_SCHEMA_VERSION, paths };
  } catch {
    return { v: RECENT_FOLDERS_SCHEMA_VERSION, paths: [] };
  }
}

function writeRaw(state: StoredState): void {
  try {
    const dir = path.dirname(recentFoldersFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(recentFoldersFilePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    // Non-fatal. Recent-folder failures should never break a commit.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop] recent-current-folders write failed: ${msg}`);
  }
}

/**
 * Return the current recent-current-folders list (most recent first).
 * Does NOT filter for existence — that's the UI's job via a separate
 * existence check if it wants. Keeping the raw list here means
 * temporarily-offline external drives don't get silently evicted.
 */
export function listRecent(): string[] {
  return readRaw().paths;
}

/**
 * Push a path onto the recent list. Dedupes (moves existing entries to
 * the front) and caps at RECENT_FOLDERS_CAP.
 */
export function pushRecent(p: string): void {
  const current = readRaw();
  const filtered = current.paths.filter((existing) => existing !== p);
  const next = [p, ...filtered].slice(0, RECENT_FOLDERS_CAP);
  writeRaw({ v: RECENT_FOLDERS_SCHEMA_VERSION, paths: next });
}

/**
 * Drop any entries that no longer exist on disk. Called on boot so a
 * user who deleted a folder doesn't see it lingering in the dropdown /
 * native menu. Runs synchronously — the list is tiny.
 */
export function pruneMissing(): void {
  const current = readRaw();
  const existing = current.paths.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  if (existing.length !== current.paths.length) {
    writeRaw({ v: RECENT_FOLDERS_SCHEMA_VERSION, paths: existing });
  }
}
