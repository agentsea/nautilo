import { stat, rename, symlink, writeFile, readdir, lstat, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log, warn } from "@nautilo/logger";
import type { NautiloRuntimePaths } from "./runtime-paths";

/**
 * One-time migration from pre-D049 filesystem layouts to the four-zone
 * layout defined in D049 (artifact-centric pivot, Apr 17 2026).
 *
 * Old layout pieces this migration handles:
 *   ~/.nautilo/home/scratch/     → ~/.nautilo/scratch/
 *   ~/.nautilo/voice-previews/   → ~/.nautilo/data/voice-previews/
 *   ~/.nautilo/audio/            → ~/.nautilo/data/audio/
 *
 * Legacy `inbox/` directories from installs that ran the pre-pivot
 * D049 (the five-zone layout, Apr 17 morning) are LEFT ALONE. The
 * pivot removed the zone from the spec but any user data in that
 * directory must not be destroyed. A one-shot warning fires if
 * `inbox/` is detected. Its contents remain outside the managed layout.
 *
 * Guarantees:
 * - Idempotent: runs at most once per install via
 *   `{dataDir}/.migrated-v049`.
 * - Non-destructive: uses `rename()` (same-filesystem, atomic). If
 *   the destination has content, the pair is skipped and the source
 *   is left untouched — operator resolves.
 * - home/scratch: after a successful move, a compatibility symlink
 *   `home/scratch → scratch` is created so stale readers keep working
 *   for one release cycle.
 * - Logs every decision via `@nautilo/logger`.
 */

const MIGRATION_MARKER_FILENAME = ".migrated-v049";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * Rename `source` → `destination` if source has content and
 * destination is empty. Returns `true` if the move happened, `false`
 * if skipped.
 */
async function moveIfSafe(
  source: string,
  destination: string,
  label: string,
): Promise<boolean> {
  if (!(await pathExists(source))) {
    return false;
  }

  // Don't migrate a symlink we may have created on a prior run.
  if (await isSymlink(source)) {
    return false;
  }

  // If destination exists:
  //   - empty directory → rmdir first so rename(2) has a clean target
  //     (macOS rename onto an existing dir isn't reliable)
  //   - non-empty → skip with warning
  if (await pathExists(destination)) {
    if (await isEmptyDirectory(destination)) {
      try {
        await rmdir(destination);
      } catch (err) {
        warn(
          `[storage] migrate ${label} — could not clear empty destination ${destination}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    } else {
      warn(
        `[storage] migrate ${label} skipped — destination ${destination} already has content; manual review required`,
      );
      return false;
    }
  }

  try {
    await rename(source, destination);
    log(`[storage] migrate ${label}: ${source} → ${destination}`);
    return true;
  } catch (err) {
    warn(
      `[storage] migrate ${label} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Best-effort backward-compatibility symlink so stale callers still
 * reading the old path continue to work for one release cycle.
 */
async function createBackCompatSymlink(
  oldPath: string,
  newPath: string,
  label: string,
): Promise<void> {
  if (await pathExists(oldPath)) return;
  try {
    await symlink(newPath, oldPath);
    log(`[storage] compat symlink ${label}: ${oldPath} → ${newPath}`);
  } catch (err) {
    warn(
      `[storage] compat symlink ${label} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Single-fire warning for legacy pre-pivot inbox directories. The
 * pivot removed the zone from D049's spec; D068 will re-introduce an
 * ingestion zone when real adapters exist. Any on-disk `inbox/` is
 * left alone but the operator should know it's no longer managed.
 */
async function warnLegacyInbox(rootDir: string): Promise<void> {
  const legacyInbox = join(rootDir, "inbox");
  if (await pathExists(legacyInbox)) {
    warn(
      `[storage] Legacy inbox/ directory detected at ${legacyInbox} — outside the managed storage layout. User data is preserved; review this directory before moving or removing its contents.`,
    );
  }
}

/**
 * CONCURRENCY NOTE (PR-003 M-2): safe to call from multiple processes
 * simultaneously (e.g., Electron relay + nautilo-server starting at
 * the same time). The marker is written with the `wx` flag so only
 * one process plants it — EEXIST is swallowed in the loser. Individual
 * `moveIfSafe` operations use `rename(2)` which is atomic; at worst
 * one process logs a benign rename-race warning before the winner
 * plants the marker. No data is lost and no duplicate moves occur.
 */
export async function migrateStorageLayout(
  paths: NautiloRuntimePaths,
): Promise<void> {
  const markerPath = join(paths.dataDir, MIGRATION_MARKER_FILENAME);

  if (await pathExists(markerPath)) {
    return;
  }

  // Derive old paths from the current rootDir so tests with a custom
  // user home (paths.rootDir) work cleanly.
  const oldScratch = join(paths.rootDir, "home", "scratch");
  const oldVoicePreviews = join(paths.rootDir, "voice-previews");
  const oldAudio = join(paths.rootDir, "audio");

  const movedScratch = await moveIfSafe(oldScratch, paths.scratchDir, "scratch");
  await moveIfSafe(oldVoicePreviews, paths.voiceCacheDir, "voice-previews");
  await moveIfSafe(oldAudio, paths.audioCacheDir, "audio");

  if (movedScratch) {
    await createBackCompatSymlink(oldScratch, paths.scratchDir, "home/scratch");
  }

  // Non-destructive handling of legacy pre-pivot inbox (from the
  // Apr 17 morning ship of D049 Phase 1).
  await warnLegacyInbox(paths.rootDir);

  try {
    await writeFile(
      markerPath,
      JSON.stringify(
        { migration: "D049", completedAt: new Date().toISOString() },
        null,
        2,
      ),
      { flag: "wx" },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return; // benign race
    warn(
      `[storage] failed to write migration marker ${markerPath} in ${dirname(
        markerPath,
      )}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
