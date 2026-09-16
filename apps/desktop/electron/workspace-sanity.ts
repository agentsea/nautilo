/**
 * Current-folder sanity predicate (D075 Phase 1 / D077 chunk 2, renamed
 * by D079 Phase 1).
 *
 * Pure function: takes a proposed current-folder path + the user's
 * home dir and returns either `{ ok: true }` or `{ ok: false, reason }`.
 * No fs access, no electron imports — callable from both main-process
 * (boot-time / commit-time gating) and unit tests.
 *
 * The goal is to reject paths that we can statically tell will produce
 * a disastrous Files-tab experience (rendering /tmp's UUID zoo, the
 * user's entire home dir, /System, etc.). This runs BEFORE fs access
 * so it's fast and safe on suspicious paths.
 *
 * Fs-level checks (path exists, is a directory, is readable) stay in
 * main.ts because they need real I/O. This predicate is the first
 * line of defense — cheapest, runs always.
 *
 * Flagged in D075 after 2026-04-20 debugging session revealed
 * `workspace.json = {"path":"/tmp"}` had been persisted from an
 * earlier test and was silently rendering thousands of tmp files
 * into the Files tab.
 *
 * D079 Phase 3 will add a companion `checkGenieWorkspaceSanity` with
 * a LOOSER policy: `~/Documents/Nautilo` (and siblings) ARE allowed
 * as Workspace roots because that's the default Workspace location,
 * whereas they'd normally be rejected as "too close to home" for a
 * current folder. Keep this function as the strict variant.
 */

export type FolderSanity =
  | { ok: true }
  | { ok: false; reason: string };

// Canonical system paths we never allow as a workspace root.
// Normalized to forward-slash form; the predicate compares after
// normalizing the input. Case-insensitive comparison covers case-
// insensitive filesystems (macOS HFS+/APFS, Windows NTFS).
const UNIX_SYSTEM_ROOTS = [
  "/",
  "/tmp",
  "/private/tmp",
  "/private/var",
  "/var",
  "/usr",
  "/etc",
  "/opt",
  "/bin",
  "/sbin",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
  "/Network",
];

const WINDOWS_SYSTEM_ROOTS = [
  "c:",
  "c:/",
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
  "c:/users",
  "d:",
  "d:/",
];

/**
 * Normalize a path for comparison. Accepts POSIX or Windows paths,
 * returns a canonical lowercase forward-slash form without trailing
 * slash.
 */
function normalize(p: string): string {
  let out = p.trim();
  if (out.length === 0) return "";

  // Windows → forward slashes, lowercase drive letter.
  out = out.replace(/\\/g, "/");
  if (/^[a-z]:/i.test(out)) out = out.toLowerCase();

  // Strip trailing slash unless this IS the root.
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);

  return out;
}

/**
 * Is `candidate` exactly the user's home directory? Returns false for
 * subdirectories (we want to allow ~/Documents/Nautilo but reject
 * raw ~). Accepts either the raw "~" marker or an expanded absolute
 * path, compared against the `homeDir` argument.
 */
function isExactlyHome(candidate: string, homeDir: string): boolean {
  if (candidate === "~") return true;
  const n = normalize(candidate);
  const h = normalize(homeDir);
  return n.length > 0 && n === h;
}

/**
 * D079 Phase 3 — Genie's Workspace sanity predicate. LOOSER than
 * `checkCurrentFolderSanity`:
 *   - Allows `~/Documents/*` (the DEFAULT Workspace location lives
 *     at `~/Documents/Nautilo`, so rejecting it wholesale would
 *     reject the default root).
 *   - Still blocks raw `~` (home-dir root; same reasoning as current
 *     folder), `/`, `/tmp`, `/System`, `/Library`, `/etc`, `/usr`,
 *     `/bin`, `/sbin`, `/var`, and Windows system paths.
 *   - Still rejects relative paths.
 *
 * Pure function; callers pass `homeDir` (derivable from `os.homedir()`
 * in main). Kept separate from `checkCurrentFolderSanity` so nobody
 * accidentally relaxes the current-folder policy by editing the wrong
 * function — tests pin BOTH policies to avoid drift.
 */
export function checkGenieWorkspaceSanity(
  path: string | null | undefined,
  homeDir: string,
): FolderSanity {
  if (path == null) return { ok: false, reason: "no workspace path set" };
  const trimmed = path.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty workspace path" };
  if (trimmed === "~" || trimmed === "~/") {
    return { ok: false, reason: "raw home-directory marker not allowed" };
  }

  const normalized = normalize(trimmed);
  const isAbsolutePosix = normalized.startsWith("/");
  const isAbsoluteWindows = /^[a-z]:/i.test(normalized);
  if (!isAbsolutePosix && !isAbsoluteWindows) {
    return { ok: false, reason: "workspace path must be absolute" };
  }

  if (isExactlyHome(trimmed, homeDir)) {
    return {
      ok: false,
      reason: "cannot use your home directory as Workspace — pick a subfolder like ~/Documents/Nautilo",
    };
  }

  const normalizedLower = normalized.toLowerCase();
  for (const root of UNIX_SYSTEM_ROOTS) {
    if (normalizedLower === root.toLowerCase()) {
      return { ok: false, reason: `cannot use system path ${root} as Workspace` };
    }
  }
  for (const root of WINDOWS_SYSTEM_ROOTS) {
    if (normalizedLower === root) {
      return { ok: false, reason: `cannot use system path ${root} as Workspace` };
    }
  }

  return { ok: true };
}

/**
 * Main predicate. Callers pass the user's home directory (derivable
 * from `os.homedir()` in main, passed explicitly here so the predicate
 * stays pure and testable).
 */
export function checkCurrentFolderSanity(
  path: string | null | undefined,
  homeDir: string,
): FolderSanity {
  if (path == null) {
    return { ok: false, reason: "no folder path set" };
  }

  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty folder path" };
  }

  // Reject the literal "~" marker. Callers should have expanded this
  // before committing, but be defensive.
  if (trimmed === "~" || trimmed === "~/") {
    return { ok: false, reason: "raw home-directory marker not allowed" };
  }

  const normalized = normalize(trimmed);

  // Reject relative paths — a folder path must be absolute.
  const isAbsolutePosix = normalized.startsWith("/");
  const isAbsoluteWindows = /^[a-z]:/i.test(normalized);
  if (!isAbsolutePosix && !isAbsoluteWindows) {
    return {
      ok: false,
      reason: "folder path must be absolute",
    };
  }

  // Reject exact home-dir match.
  if (isExactlyHome(trimmed, homeDir)) {
    return {
      ok: false,
      reason: "cannot use your home directory as a folder — pick a subfolder like ~/Documents/Nautilo",
    };
  }

  // Reject known system roots. Case-insensitive comparison against
  // the known-bad list — POSIX filesystems can be case-sensitive
  // (/system in theory lives alongside /System) but we want to
  // reject either, and macOS is case-insensitive anyway.
  const normalizedLower = normalized.toLowerCase();
  for (const root of UNIX_SYSTEM_ROOTS) {
    if (normalizedLower === root.toLowerCase()) {
      return {
        ok: false,
        reason: `cannot use system path ${root} as a folder`,
      };
    }
  }
  for (const root of WINDOWS_SYSTEM_ROOTS) {
    if (normalizedLower === root) {
      return {
        ok: false,
        reason: `cannot use system path ${root} as a folder`,
      };
    }
  }

  return { ok: true };
}
