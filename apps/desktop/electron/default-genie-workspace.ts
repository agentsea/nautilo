/**
 * D079 Phase 3 — default Genie's Workspace setup.
 *
 * The Workspace is the Agent's persistent drawer (Surface A in D079).
 * It lives on disk in Finder-visible territory (`~/Documents/Nautilo/`
 * by default) so the user can navigate it with any file manager, share
 * its files, and trust that it survives app uninstalls.
 *
 * `ensureDefaultGenieWorkspace()` runs once at boot BEFORE the
 * workbench renderer mounts, so the Workspace root is always set by
 * the time the renderer queries it via `useWorkspace().root`.
 *
 * Contract:
 *   - If `~/.nautilo/state/genie-workspace.json` exists AND points at
 *     a still-usable path, honor it verbatim and return.
 *   - Otherwise, create `~/Documents/Nautilo/` (plus the three
 *     starter subdirs `drafts/`, `research/`, `from-user/`) and
 *     write the persistence file.
 *   - Never overwrite an existing root pointer silently — the user
 *     may have changed it via Settings; that change wins.
 *   - Never mutate contents of an existing root — subdirs are
 *     created only when absent (idempotent, safe on every boot).
 *
 * All fs errors are logged and degrade gracefully: if we can't
 * create the default root (disk full, permission denied), the
 * Workspace tab will render an empty state and Settings will offer
 * a "Pick folder…" affordance — not shipping will break everything.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import log from "electron-log/main";
import { checkGenieWorkspaceSanity } from "./workspace-sanity";
import {
  DEFAULT_GENIE_WORKSPACE_ROOT,
  genieWorkspaceStateFilePath,
} from "./paths";
import { STARTER_WORKSPACE_SUBDIRS } from "./constants";

const GENIE_WORKSPACE_STATE_FILE = genieWorkspaceStateFilePath();

interface WorkspaceStateFile {
  /** Absolute path to the Genie's Workspace root. */
  root: string;
}

function readStateFile(): WorkspaceStateFile | null {
  try {
    const raw = fs.readFileSync(GENIE_WORKSPACE_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "root" in parsed &&
      typeof (parsed as { root: unknown }).root === "string"
    ) {
      const root = (parsed as { root: string }).root;
      if (root.trim().length > 0) return { root };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStateFile(state: WorkspaceStateFile): void {
  try {
    fs.mkdirSync(path.dirname(GENIE_WORKSPACE_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      GENIE_WORKSPACE_STATE_FILE,
      JSON.stringify(state, null, 2) + "\n",
      "utf-8",
    );
  } catch (err) {
    log.error(
      "[default-genie-workspace] Failed to write state file:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Create `root` + its starter subdirs if absent. No-op on existing
 * dirs. Returns `true` on success, `false` if we couldn't create the
 * root itself (disk full / permission denied / name conflict with a
 * regular file).
 */
function ensureRootAndSubdirs(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    log.error(
      `[default-genie-workspace] Failed to create root ${root}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }

  // Verify it's actually a directory — `mkdirSync(recursive: true)`
  // succeeds if the path already exists, but it could exist as a file.
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) {
      log.error(`[default-genie-workspace] Root ${root} exists but is not a directory`);
      return false;
    }
  } catch (err) {
    log.error(
      `[default-genie-workspace] Failed to stat root ${root}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }

  for (const sub of STARTER_WORKSPACE_SUBDIRS) {
    const subPath = path.join(root, sub);
    try {
      fs.mkdirSync(subPath, { recursive: true });
    } catch (err) {
      // Non-fatal — starter subdirs are conveniences, not required
      // for Workspace to function. Log and continue.
      log.warn(
        `[default-genie-workspace] Failed to create starter subdir ${subPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return true;
}

/**
 * Ensure the Genie's Workspace root exists on disk and return it.
 * Called at boot before the renderer mounts. Idempotent.
 *
 * Resolution order:
 *   1. If state file exists AND its `root` passes sanity check AND
 *      the path exists as a directory, return it verbatim. (Honor
 *      user's prior choice.)
 *   2. If state file exists but the root is gone (user deleted it),
 *      fall through to the default-root path and recreate.
 *   3. No state file → create default root + starter subdirs, write
 *      state file.
 *
 * On total failure (can't create even the default), returns the
 * default path anyway so the renderer can display its "pick folder"
 * empty state against SOMETHING — better than null which would
 * trigger the "no workspace" code path.
 */
export function ensureDefaultGenieWorkspace(): string {
  const stored = readStateFile();

  if (stored) {
    const sanity = checkGenieWorkspaceSanity(stored.root, os.homedir());
    if (sanity.ok) {
      // Honor the stored root. Verify the directory exists; if not,
      // recreate it (with its starter subdirs only if it's the
      // default root — we don't impose our conventions on user-chosen
      // roots).
      const exists = (() => {
        try {
          return fs.statSync(stored.root).isDirectory();
        } catch {
          return false;
        }
      })();
      if (exists) return stored.root;

      // Stored root gone — recreate if it's the default path,
      // otherwise leave as stored (user may have it on a disconnected
      // drive; reconnect should restore). Log either way.
      log.warn(
        `[default-genie-workspace] Stored root ${stored.root} no longer exists; will recreate if default`,
      );
      if (stored.root === DEFAULT_GENIE_WORKSPACE_ROOT) {
        ensureRootAndSubdirs(stored.root);
      }
      return stored.root;
    }
    log.warn(
      `[default-genie-workspace] Stored root failed sanity check (${sanity.reason}); falling back to default`,
    );
  }

  // No valid stored root — create the default and persist it.
  const ok = ensureRootAndSubdirs(DEFAULT_GENIE_WORKSPACE_ROOT);
  if (ok) {
    writeStateFile({ root: DEFAULT_GENIE_WORKSPACE_ROOT });
    log.info(
      `[default-genie-workspace] Created default workspace at ${DEFAULT_GENIE_WORKSPACE_ROOT}`,
    );
  } else {
    log.error(
      `[default-genie-workspace] Failed to create default workspace at ${DEFAULT_GENIE_WORKSPACE_ROOT}; returning path anyway so renderer can show empty state`,
    );
  }
  return DEFAULT_GENIE_WORKSPACE_ROOT;
}
