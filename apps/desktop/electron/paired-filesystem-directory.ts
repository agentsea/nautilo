/**
 * D319 — phone-paired directory selection across the local Mac.
 *
 * This is deliberately a directory-only surface.  The phone receives opaque
 * location ids, never host paths; this Electron-local authority owns the map
 * back to canonical paths and rejects symlinks at every traversed segment.
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const PAIRED_FILESYSTEM_MAX_PAGE_SIZE = 100;

export type PairedFilesystemDirectoryEntry = {
  readonly name: string;
  /** Opaque path relative to this phone's exact relay, never a host path. */
  readonly path: string;
  readonly isDirectory: true;
  readonly isFile: false;
  readonly isSymbolicLink: false;
};

export type PairedFilesystemDirectoryResult =
  | { readonly ok: true; readonly entries: readonly PairedFilesystemDirectoryEntry[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly code: string };

type ProtectedPathPolicy = { readonly check: (candidate: string) => { readonly allowed: boolean } };
type SanityCheck = (candidate: string) => { readonly ok: boolean };

export interface PairedFilesystemDirectoryAuthorityOptions {
  readonly getHomeDirectory: () => string;
  readonly protectedPathPolicy: ProtectedPathPolicy;
  readonly checkCurrentFolderSanity: SanityCheck;
  /** Test seam; production discovers the Mac's safe mounted/data locations. */
  readonly getLocationCandidates?: () => readonly { readonly label: string; readonly path: string }[] | Promise<readonly { readonly label: string; readonly path: string }[]>;
  readonly createLocationId?: () => string;
}

type Location = { readonly id: string; readonly label: string; readonly canonicalPath: string; readonly isDataVolume: boolean };

const DATA_VOLUME = "/System/Volumes/Data";
const MAX_LOCATIONS = 128;
const DATA_SYSTEM_CHILDREN = new Set([
  "Applications",
  "Library",
  "MobileSoftwareUpdate",
  "System",
  "Users",
  "Volumes",
  "bin",
  "cores",
  "dev",
  "etc",
  "home",
  "mnt",
  "private",
  "proc",
  "sbin",
  "sys",
  "tmp",
  "usr",
  "var",
]);

function validRelative(value: string): string | null {
  if (value.length > 1024 || value.includes("\0") || path.isAbsolute(value) || path.posix.isAbsolute(value)) return null;
  const parts = value === "" ? [] : value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeLabel(input: string): string {
  return [...input].filter((character) => character.codePointAt(0)! >= 0x20).join("").trim().slice(0, 120) || "This Mac";
}

function safeEntryName(input: string): boolean {
  return input.length > 0 && input.length <= 255 && !input.includes("/") && !input.includes("\\") &&
    [...input].every((character) => character.codePointAt(0)! >= 0x20);
}

/**
 * Includes the actual APFS Data volume as an explicit safe source.  It is
 * intentionally listed separately from `/System`: system paths stay blocked,
 * while user-created data trees reached through Finder's Data mount remain
 * selectable. `/Volumes/*` covers conventional mounted external volumes.
 * We deliberately do not enumerate `/` itself: APFS mirrors writable data
 * below the explicit Data location, while root enumeration would duplicate
 * those locations and surface OS-owned entries such as `cores`.
 */
async function defaultCandidates(home: string): Promise<readonly { readonly label: string; readonly path: string }[]> {
  const candidates: Array<{ label: string; path: string }> = [{ label: "Home", path: home }, { label: "Macintosh HD — Data", path: DATA_VOLUME }];
  for (const parent of ["/Volumes"]) {
    try {
      const entries = await fsp.readdir(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        candidates.push({ label: safeLabel(entry.name), path: path.join(parent, entry.name) });
      }
    } catch {
      // One unavailable mount must not prevent safe locations from being used.
    }
  }
  return candidates;
}

export function createPairedFilesystemDirectoryAuthority(options: PairedFilesystemDirectoryAuthorityOptions) {
  const locations = new Map<string, Location>();
  const locationIdsByCanonicalPath = new Map<string, string>();
  const createLocationId = options.createLocationId ?? (() => `loc_${randomUUID().replace(/-/g, "")}`);

  async function canonicalDirectory(candidate: string): Promise<string | null> {
    try {
      const link = await fsp.lstat(candidate);
      if (!link.isDirectory() || link.isSymbolicLink()) return null;
      const canonical = await fsp.realpath(candidate);
      const stat = await fsp.stat(canonical);
      return stat.isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }

  async function rootEntries(): Promise<PairedFilesystemDirectoryEntry[]> {
    const raw = await (options.getLocationCandidates?.() ?? defaultCandidates(options.getHomeDirectory()));
    const entries: PairedFilesystemDirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const source of raw) {
      const canonical = await canonicalDirectory(source.path);
      if (!canonical || seen.has(canonical)) continue;
      // The policy rejects protected roots and descendants. It must not be
      // applied to broad source roots such as Home/Data because they can
      // *contain* protected children; final selection is checked below.
      seen.add(canonical);
      let id = locationIdsByCanonicalPath.get(canonical);
      if (!id) {
        // A phone cannot force Electron to retain unlimited opaque references.
        // Clearing merely makes old ids stale; the next root page refreshes.
        if (locations.size >= MAX_LOCATIONS) {
          locations.clear();
          locationIdsByCanonicalPath.clear();
        }
        id = createLocationId();
        const label = safeLabel(source.label);
        locations.set(id, { id, label, canonicalPath: canonical, isDataVolume: canonical === DATA_VOLUME || label === "Macintosh HD — Data" });
        locationIdsByCanonicalPath.set(canonical, id);
      }
      entries.push({ name: safeLabel(source.label), path: id, isDirectory: true, isFile: false, isSymbolicLink: false });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  function visibleDirectory(candidate: string, location?: Location): boolean {
    // Do not show a hierarchy the phone can never use.  This intentionally
    // leaves the APFS Data mount itself usable, while filtering true system
    // and private targets plus Nautilo-owned protected roots beneath it.
    if (location?.isDataVolume && isContained(location.canonicalPath, candidate)) {
      const firstChild = path.relative(location.canonicalPath, candidate).split(path.sep)[0];
      // Finder's Data volume contains a few OS-owned mirror trees alongside
      // real data (including the user's requested `Data/Data`).  Hide only
      // those OS-owned subtrees, not the data volume as a whole.
      if (firstChild && DATA_SYSTEM_CHILDREN.has(firstChild)) return false;
    }
    if (
      candidate === "/System" || candidate.startsWith("/System/") && !isContained(DATA_VOLUME, candidate) ||
      candidate === "/Library" || candidate.startsWith("/Library/") ||
      candidate === "/private" || candidate.startsWith("/private/") ||
      candidate === "/usr" || candidate.startsWith("/usr/") ||
      candidate === "/etc" || candidate.startsWith("/etc/") ||
      candidate === "/bin" || candidate.startsWith("/bin/") ||
      candidate === "/sbin" || candidate.startsWith("/sbin/") ||
      candidate === "/var" || candidate.startsWith("/var/") ||
      candidate === "/dev" || candidate.startsWith("/dev/") ||
      candidate === "/proc" || candidate.startsWith("/proc/") ||
      candidate === "/sys" || candidate.startsWith("/sys/") ||
      candidate === "/root" || candidate.startsWith("/root/")
    ) return false;
    return options.protectedPathPolicy.check(candidate).allowed;
  }

  async function resolve(relativePath: string): Promise<{ location: Location; canonical: string } | null> {
    const valid = validRelative(relativePath);
    if (valid === null || valid === "") return null;
    const [locationId, ...segments] = valid.split("/");
    const location = locations.get(locationId!);
    if (!location) return null;
    const currentRoot = await canonicalDirectory(location.canonicalPath);
    if (!currentRoot || currentRoot !== location.canonicalPath) return null;
    let candidate = currentRoot;
    for (const segment of segments) {
      candidate = path.join(candidate, segment);
      try {
        const link = await fsp.lstat(candidate);
        if (!link.isDirectory() || link.isSymbolicLink()) return null;
      } catch {
        return null;
      }
    }
    const canonical = await canonicalDirectory(candidate);
    return canonical && isContained(currentRoot, canonical) ? { location, canonical } : null;
  }

  async function list(input: { readonly relativePath: string; readonly afterName?: string; readonly limit: number; readonly includeHidden: boolean; readonly query: string }): Promise<PairedFilesystemDirectoryResult> {
    const limit = Math.min(Math.max(1, input.limit), PAIRED_FILESYSTEM_MAX_PAGE_SIZE);
    if (input.relativePath === "") {
      const roots = await rootEntries();
      const filtered = roots.filter((entry) =>
        (input.includeHidden || !entry.name.startsWith(".")) &&
        (!input.query || entry.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) &&
        (input.afterName === undefined || entry.name.localeCompare(input.afterName) > 0),
      );
      const page = filtered.slice(0, limit);
      return { ok: true, entries: page, nextCursor: filtered.length > page.length ? page.at(-1)?.name ?? null : null };
    }
    const target = await resolve(input.relativePath);
    if (!target) return { ok: false, code: "not_found" };
    try {
      const rows = await fsp.readdir(target.canonical, { withFileTypes: true });
      const entries = rows
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .filter((entry) => safeEntryName(entry.name))
        .filter((entry) => visibleDirectory(path.join(target.canonical, entry.name), target.location))
        .filter((entry) => input.includeHidden || !entry.name.startsWith("."))
        .filter((entry) => !input.query || entry.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))
        .filter((entry) => input.afterName === undefined || entry.name.localeCompare(input.afterName) > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      const page = entries.slice(0, limit).map((entry) => ({ name: entry.name, path: `${input.relativePath}/${entry.name}`, isDirectory: true as const, isFile: false as const, isSymbolicLink: false as const }));
      return { ok: true, entries: page, nextCursor: entries.length > page.length ? page.at(-1)?.name ?? null : null };
    } catch {
      return { ok: false, code: "inaccessible" };
    }
  }

  async function select(relativePath: string): Promise<{ readonly ok: true; readonly label: string; readonly canonicalPath: string } | { readonly ok: false; readonly error: string }> {
    const target = await resolve(relativePath);
    if (!target) return { ok: false, error: "That folder is no longer available." };
    // A source root itself is browseable but is never silently adopted: Home
    // and all other broad roots need an explicit subdirectory selection.
    if (relativePath === target.location.id) return { ok: false, error: "Choose a folder inside this location." };
    if (!visibleDirectory(target.canonical, target.location)) return { ok: false, error: "That folder is protected." };
    if (!options.protectedPathPolicy.check(target.canonical).allowed) return { ok: false, error: "That folder is protected." };
    const sanity = options.checkCurrentFolderSanity(target.canonical);
    if (!sanity.ok) return { ok: false, error: "That folder cannot be used as the Current Folder." };
    return { ok: true, label: path.basename(target.canonical), canonicalPath: target.canonical };
  }

  return { list, select };
}
