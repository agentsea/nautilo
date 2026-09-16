/**
 * Pure schema + URL canonicalization for `~/.nautilo/recent-servers.json`
 * (M123 Phase 2 / Stack 39 Phase 3C).
 *
 * Kept dependency-free so tests can exercise parse/canonicalize without
 * booting Electron or touching the filesystem.
 */

import {
  RECENT_SERVERS_SCHEMA_VERSION,
} from "./constants";
import { canonicalServerScope } from "./url-canonical";

export type RecentServerEntry = {
  url: string;
  displayName?: string;
  lastUsedAt: string;
  /**
   * M161 Phase 3.2 — per-server fingerprint from the server's `/health`
   * identity (`serverIdentity`, with Logto app/resource fallback), or
   * the legacy `paired-server-identity.json` value migrated once at boot.
   * Optional: v1 entries on disk have
   * none until the boot migrator folds the legacy identity onto the
   * matching active entry. Used by each view to validate it landed on
   * the server it paired with (wrong-server shell state on mismatch).
   */
  fingerprint?: string;
};

export type RecentServersFile = {
  v: typeof RECENT_SERVERS_SCHEMA_VERSION;
  servers: RecentServerEntry[];
};

export type ParsedRecentServers = {
  v: typeof RECENT_SERVERS_SCHEMA_VERSION;
  servers: RecentServerEntry[];
};

/**
 * Canonical persisted URL: trim, parse, lowercase host (via URL parser),
 * strip trailing slash. Protocol/path/query/hash casing is preserved
 * except host, which URL normalization lowercases.
 *
 * M161 Phase 1 — delegates to the shared `canonicalServerScope` so
 * recents, token filenames, partitions, and registry scopes all agree
 * on one canonicalization policy.
 */
export function canonicalizeRecentServerUrl(input: string): string {
  return canonicalServerScope(input);
}

/** Dedupe key — same rules as canonicalizeRecentServerUrl. */
export function recentServerDedupeKey(url: string): string {
  return canonicalizeRecentServerUrl(url);
}

function parseEntry(raw: unknown): RecentServerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const url = obj["url"];
  if (typeof url !== "string" || url.length === 0) return null;
  const lastUsedAt = obj["lastUsedAt"];
  if (typeof lastUsedAt !== "string" || lastUsedAt.length === 0) return null;
  const entry: RecentServerEntry = { url, lastUsedAt };
  const displayName = obj["displayName"];
  if (typeof displayName === "string" && displayName.length > 0) {
    entry.displayName = displayName;
  }
  // M161 Phase 3.2 — fingerprint is optional. A non-string or empty
  // value is dropped (never persisted) so a malformed v2 entry can't
  // smuggle a bogus fingerprint into the wrong-server check.
  const fingerprint = obj["fingerprint"];
  if (typeof fingerprint === "string" && fingerprint.length > 0) {
    entry.fingerprint = fingerprint;
  }
  return entry;
}

/**
 * Narrow unknown JSON into a parsed file or an empty list on mismatch.
 * Never throws — malformed disk state should not break the picker.
 *
 * M161 Phase 3.2 — accepts both v1 (no `fingerprint` on entries) and v2
 * (optional `fingerprint`) on disk, and always returns the current
 * schema version (v2) so callers write forward-migrated state. v1
 * entries pass through unchanged (no fingerprint); the boot migrator
 * folds the legacy `paired-server-identity.json` value onto the
 * matching active entry once.
 */
export function parseRecentServersFile(raw: unknown): ParsedRecentServers {
  const empty: ParsedRecentServers = {
    v: RECENT_SERVERS_SCHEMA_VERSION,
    servers: [],
  };
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  if (obj["v"] !== 1 && obj["v"] !== RECENT_SERVERS_SCHEMA_VERSION) return empty;
  if (!Array.isArray(obj["servers"])) return empty;
  const servers = obj["servers"]
    .map(parseEntry)
    .filter((e): e is RecentServerEntry => e !== null);
  return { v: RECENT_SERVERS_SCHEMA_VERSION, servers };
}
