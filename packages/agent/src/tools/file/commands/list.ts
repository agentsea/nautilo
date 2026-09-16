/** Unified directory discovery: bounded result pages with stable continuation.
 * Symlinks are listed, never followed. Explicit depth limits disclose each
 * omitted subtree; no implicit depth or total-entry ceiling ends discovery.
 */
import * as path from "node:path";
import { createDiscoveryPage } from "@nautilo/relay/native-search";
import type { FileBackend } from "../backend";
import type { CommandHandler } from "./_shared";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";

const DEFAULT_LIMIT_NON_RECURSIVE = 1000;
const DEFAULT_LIMIT_RECURSIVE = 5000;

interface ListEntry {
  name: string;
  path: string;
  /** "file" | "directory" | "symlink" | "other" */
  type: string;
  /** Present for files; absent for directories. */
  size?: number;
  descendants?: "depth_limit" | "symlink";
}

function resolveEntryLimit(
  recursive: boolean,
  requested: number | undefined,
): number {
  const defaultLimit = recursive
    ? DEFAULT_LIMIT_RECURSIVE
    : DEFAULT_LIMIT_NON_RECURSIVE;
  const raw = requested ?? defaultLimit;
  return raw;
}

export const handleList: CommandHandler<"list"> = async (
  args,
  resolution,
  ctx,
) => {
  const recursive = args.recursive === true;
  const depth = args.depth;
  const glob = args.glob;
  const entryLimit = resolveEntryLimit(recursive, args.limit);
  const backend = getFileBackend(ctx);

  try {
    const page = createDiscoveryPage<ListEntry>({ path: resolution.resolved, zone: resolution.resolvedZone, recursive, depth: depth ?? null, glob: glob ?? null }, entryLimit, args.discoveryCursor);
    const omitted = { depth_limit: 0, symlink: 0 };
    const visit = async (dir: string, level: number): Promise<void> => {
      ctx.signal?.throwIfAborted();
      const dirents = await backend.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const d of dirents) {
        ctx.signal?.throwIfAborted();
        const full = path.join(dir, d.name);
        const entry = await entryFromDirent(d, full, backend);
        if (recursive && d.isSymbolicLink()) { entry.descendants = "symlink"; omitted.symlink += 1; }
        if (recursive && d.isDirectory() && depth !== undefined && level >= depth) {
          entry.descendants = "depth_limit"; omitted.depth_limit += 1;
        }
        if (!glob || (d.isFile() && matchesGlob(d.name, glob)) || entry.descendants) page.accept(entry);
        if (recursive && d.isDirectory() && !d.isSymbolicLink() && !entry.descendants) await visit(full, level + 1);
      }
    };
    await visit(resolution.resolved, 0);
    const pagination = page.finish();
    const incompleteReasons = Object.entries(omitted).filter(([, count]) => count > 0).map(([reason, count]) => ({ reason, count }));

    return JSON.stringify(
      {
        path: resolution.resolved,
        zone: resolution.resolvedZone,
        recursive,
        glob: glob ?? null,
        limit: entryLimit,
        ...pagination,
        complete: pagination.complete && incompleteReasons.length === 0,
        incompleteReasons,
        sourceVersionScope: "Ordered discovery entries, not an atomic file-content snapshot",
        ...(pagination.nextCursor ? { recovery: "Echo nextCursor as discoveryCursor with this same path and filters until null." } : {}),
        ...(incompleteReasons.length ? { exclusionsRecovery: "Entries with descendants identify unsearched subtrees. Inspect relevant depth-limited directories separately; symlinks are not followed." } : {}),
      },
      null,
      2,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return fileToolError(`Error: directory not found: ${resolution.resolved}`);
    }
    if (msg.includes("ENOTDIR")) {
      return fileToolError(`Error: not a directory: ${resolution.resolved}. Use 'read' for files.`);
    }
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied: ${resolution.resolved}`);
    }
    return fileToolError(`Error listing directory: ${msg}`);
  }
};

async function entryFromDirent(
  d: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
  fullPath: string,
  backend: FileBackend,
): Promise<ListEntry> {
  const type = d.isDirectory()
    ? "directory"
    : d.isFile()
      ? "file"
      : d.isSymbolicLink()
        ? "symlink"
        : "other";
  const entry: ListEntry = { name: d.name, path: fullPath, type };
  if (d.isFile()) {
    try {
      const st = await backend.stat(fullPath);
      entry.size = st.size;
    } catch {
      // Stat failure on a listed entry is odd but non-fatal — omit size.
    }
  }
  return entry;
}

/**
 * Minimal glob matcher supporting `*` (any chars within a segment)
 * and `**` (any chars including path separators). Intentionally
 * simple — we don't pull in `minimatch` or `picomatch` for this
 * one use. When the complexity escalates (negation, brace expansion,
 * character classes), swap in a real lib. Today: names are
 * filtered during the walk so the match surface is single-entry names.
 *
 * For the command's `glob` arg, matching runs against entry NAMES
 * by default (no path components), since the walk is already
 * bounded to the zone root. Agents wanting recursive pattern
 * matches can pass `glob: "**\/*.ts"`.
 */
function matchesGlob(name: string, glob: string): boolean {
  // Translate glob to regex: `**` → `.*`, `*` → `[^/]*`, escape
  // other regex chars. Use a normal sentinel string (not null
  // bytes — eslint rightly flags control chars in regex patterns
  // even when they're clearly used as a placeholder).
  const SENTINEL = "\uFFF0DOUBLESTAR\uFFF0"; // private-use chars; won't collide with real glob input
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(SENTINEL, "g"), ".*");
  const re = new RegExp(`^${pattern}$`);
  return re.test(name);
}
