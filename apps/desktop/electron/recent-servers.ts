/**
 * Recent-servers registry (M123 Phase 2 / Stack 39 Phase 3C).
 *
 * JSON file at `~/.nautilo/recent-servers.json` (Family C — operator-
 * shared) holding the Nautilo servers the user connected to, most-recent
 * first. This is durable switcher membership: entries remain until the
 * human explicitly forgets them.
 *
 * Per-server auth bundles live in instance-scoped family B; this list
 * belongs to the human operating the machine regardless of which server
 * they are pointed at now.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import log from "electron-log/main";
import { RECENT_SERVERS_SCHEMA_VERSION } from "./constants";
import { recentServersFilePath } from "./paths";
import {
  canonicalizeRecentServerUrl,
  parseRecentServersFile,
  recentServerDedupeKey,
  type RecentServerEntry,
  type RecentServersFile,
} from "./recent-servers-schema";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import { loopbackDedupeKey } from "./url-canonical";
import type { ActiveAuthority } from "./pending-connection";

export type { RecentServerEntry } from "./recent-servers-schema";

function safeRecentServerDedupeKey(url: string): string | null {
  try {
    return recentServerDedupeKey(url);
  } catch {
    return null;
  }
}

function safeLoopbackDedupeKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return isLoopbackHostname(parsed.hostname) ? loopbackDedupeKey(url) : null;
  } catch {
    return null;
  }
}

/**
 * M161 Phase 6.6 (Stack 198) — same-protocol+port loopback aliases form a
 * limited identity group for trusted fingerprint lookup/store and preflight
 * ONLY. Returns the recent entries that belong to `serverUrl`'s identity
 * group: the exact-match entry first (when present), then every loopback
 * alias sharing its protocol and port, sorted by `lastUsedAt` desc.
 *
 * Never merges non-loopback URLs or cross-port/protocol aliases — those have
 * a `null` loopback dedupe key and only the exact match (if any) is returned.
 * Read-only: never mutates disk, token filenames, or partition identities.
 * Non-loopback raw/canonical authority is preserved (the exact match keeps
 * its own URL string).
 */
export function findRecentServerIdentityGroup(serverUrl: string): RecentServerEntry[] {
  const canonicalUrl = safeRecentServerDedupeKey(serverUrl);
  if (!canonicalUrl) return [];
  const loopback = safeLoopbackDedupeKey(serverUrl);
  const exact: RecentServerEntry[] = [];
  const aliases: RecentServerEntry[] = [];
  for (const entry of readRaw().servers) {
    const entryExact = safeRecentServerDedupeKey(entry.url);
    if (!entryExact) continue;
    if (entryExact === canonicalUrl) {
      exact.push(entry);
    } else if (loopback !== null && safeLoopbackDedupeKey(entry.url) === loopback) {
      aliases.push(entry);
    }
  }
  aliases.sort((a, b) => {
    const at = Date.parse(a.lastUsedAt);
    const bt = Date.parse(b.lastUsedAt);
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
  return [...exact, ...aliases];
}

/**
 * Return every persisted URL belonging to a Forget target. A nonempty trusted
 * fingerprint is authoritative; without one, only same-protocol/port loopback
 * aliases may match. The target itself is always included so a malformed or
 * stale recent entry can still be removed idempotently.
 */
export function findRecentServerAliases(
  serverUrl: string,
  options: { fingerprint?: string } = {},
): string[] {
  const exact = safeRecentServerDedupeKey(serverUrl);
  if (!exact) return [];
  const fingerprint = options.fingerprint?.trim();
  const loopback = safeLoopbackDedupeKey(serverUrl);
  const aliases = new Set<string>([exact]);
  for (const entry of readRaw().servers) {
    const entryExact = safeRecentServerDedupeKey(entry.url);
    if (!entryExact) continue;
    if (fingerprint) {
      if (entry.fingerprint === fingerprint) aliases.add(entryExact);
      continue;
    }
    if (loopback !== null && safeLoopbackDedupeKey(entry.url) === loopback) {
      aliases.add(entryExact);
    }
  }
  return [...aliases];
}

function readRaw(): RecentServersFile {
  try {
    const raw = fs.readFileSync(recentServersFilePath(), "utf-8");
    const parsed = parseRecentServersFile(JSON.parse(raw) as unknown);
    return { v: RECENT_SERVERS_SCHEMA_VERSION, servers: parsed.servers };
  } catch {
    return { v: RECENT_SERVERS_SCHEMA_VERSION, servers: [] };
  }
}

function writeRaw(state: RecentServersFile): boolean {
  try {
    const filePath = recentServersFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop] recent-servers write failed: ${msg}`);
    return false;
  }
}

function sortByLastUsedDesc(servers: RecentServerEntry[]): RecentServerEntry[] {
  return [...servers].sort((a, b) => {
    const at = Date.parse(a.lastUsedAt);
    const bt = Date.parse(b.lastUsedAt);
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

/**
 * Return recent servers sorted by `lastUsedAt` descending (most recent
 * first). Missing/malformed/schema-mismatch files yield an empty list.
 */
export function listRecentServers(): RecentServerEntry[] {
  return sortByLastUsedDesc(readRaw().servers);
}

/** Return the expected fingerprint for a canonical server URL, if known. */
export function getRecentServerFingerprint(serverUrl: string): string | null {
  const group = findRecentServerIdentityGroup(serverUrl);
  if (group.length === 0) return null;
  // The exact-match entry's own trusted fingerprint is the most specific
  // authority and wins outright — distinct nonempty fingerprints never
  // merge through the loopback alias group.
  const exact = group[0];
  const canonicalUrl = safeRecentServerDedupeKey(serverUrl);
  if (
    exact &&
    safeRecentServerDedupeKey(exact.url) === canonicalUrl &&
    exact.fingerprint &&
    exact.fingerprint.length > 0
  ) {
    return exact.fingerprint;
  }
  // No exact-match trusted fingerprint: fall back to the first nonempty
  // trusted fingerprint among same-protocol+port loopback aliases (the
  // limited identity group). The probe must still match it — mismatched
  // nonempty fingerprints keep failing closed at the caller.
  for (const entry of group) {
    if (entry.fingerprint && entry.fingerprint.length > 0) return entry.fingerprint;
  }
  return null;
}

/**
 * Record a server URL at the front of the server list. Dedupes by canonical
 * URL (trailing slash stripped, host lowercased). Connected servers are
 * never silently pruned; explicit Forget is the only removal path.
 */
export function pushRecentServer(entry: { url: string; displayName?: string }): void {
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeRecentServerUrl(entry.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop] pushRecentServer skipped invalid url: ${msg}`);
    return;
  }

  const key = recentServerDedupeKey(canonicalUrl);
  const now = new Date().toISOString();
  const current = readRaw();
  const matching = current.servers.find(
    (existing) => safeRecentServerDedupeKey(existing.url) === key,
  );
  const filtered = current.servers.filter(
    (existing) => safeRecentServerDedupeKey(existing.url) !== key,
  );
  const nextEntry: RecentServerEntry = {
    url: canonicalUrl,
    lastUsedAt: now,
  };
  if (entry.displayName !== undefined && entry.displayName.length > 0) {
    nextEntry.displayName = entry.displayName;
  } else if (matching?.displayName) {
    nextEntry.displayName = matching.displayName;
  }
  // Moving an entry to the front must never erase its schema-v2
  // fingerprint; that is the authority used by switch preflight.
  if (matching?.fingerprint) {
    nextEntry.fingerprint = matching.fingerprint;
  }
  const next = [nextEntry, ...filtered];
  writeRaw({ v: RECENT_SERVERS_SCHEMA_VERSION, servers: next });
}

/**
 * M161 Phase 6.5 — remove a Forget target and all of its trusted aliases.
 * Idempotent: invalid/missing entries leave unrelated recents untouched.
 * Returns the canonical aliases that were selected before mutation so callers
 * can sweep their corresponding token and partition scopes first.
 */
export function removeRecentServer(
  serverUrl: string,
  options: { fingerprint?: string } = {},
): string[] {
  const aliases = findRecentServerAliases(serverUrl, options);
  if (aliases.length === 0) return [];
  const aliasSet = new Set(aliases);
  const current = readRaw();
  const servers = current.servers.filter((entry) => {
    const key = safeRecentServerDedupeKey(entry.url);
    return key === null || !aliasSet.has(key);
  });
  if (servers.length !== current.servers.length) {
    writeRaw({ v: RECENT_SERVERS_SCHEMA_VERSION, servers });
  }
  return aliases;
}

/**
 * M161 Phase 3.2 — set a per-server fingerprint on the recent entry
 * matching `serverUrl` (canonicalized). Only sets when the entry has
 * NO fingerprint yet (idempotent + non-destructive: a re-run never
 * overwrites a fingerprint already folded from a prior migration, and
 * entries that don't match the active URL are never touched). Returns
 * `true` when the file was written OR the trust is already established
 * (a matching trusted fingerprint already exists on the identity group),
 * `false` when no matching entry exists and no alias can receive it.
 *
 * M161 Phase 6.6 (Stack 198) — when no exact-match recent entry exists
 * but a same-protocol+port loopback alias does, the first trust is
 * persisted on that matching loopback recent entry (the limited identity
 * group). This handles the live-regression where a loopback alias is
 * represented only by a live session: the trust lands on its matching
 * loopback recent, never on a new entry, token filename, or Electron
 * partition identity. Non-loopback URLs and cross-port/protocol aliases
 * are never written through this fallback. A mismatched existing trusted
 * fingerprint is never overwritten (fail-closed authority preserved).
 */
export function setRecentServerFingerprint(serverUrl: string, fingerprint: string): boolean {
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return false;
  const canonicalUrl = safeRecentServerDedupeKey(serverUrl);
  if (!canonicalUrl) return false;
  const group = findRecentServerIdentityGroup(serverUrl);
  if (group.length === 0) return false;

  // Choose the single target entry: exact match preferred; otherwise the
  // most-recent loopback alias (same protocol+port) with no trusted
  // fingerprint yet. Aliases are sorted by lastUsedAt desc inside the
  // identity group, so the first untrusted alias is the most-recent one.
  let targetKey: string | null = null;
  let alreadyTrusted = false;
  const exact = group[0];
  if (exact && safeRecentServerDedupeKey(exact.url) === canonicalUrl) {
    if (exact.fingerprint && exact.fingerprint.length > 0) {
      alreadyTrusted = exact.fingerprint === fingerprint;
    } else {
      targetKey = canonicalUrl;
    }
  } else {
    for (const entry of group) {
      if (entry.fingerprint && entry.fingerprint.length > 0) {
        if (entry.fingerprint === fingerprint) alreadyTrusted = true;
        continue;
      }
      targetKey = safeRecentServerDedupeKey(entry.url);
      break;
    }
  }

  if (targetKey === null) return alreadyTrusted;

  const current = readRaw();
  let changed = false;
  const servers = current.servers.map((entry) => {
    if (safeRecentServerDedupeKey(entry.url) !== targetKey) return entry;
    if (entry.fingerprint !== undefined && entry.fingerprint.length > 0) return entry;
    changed = true;
    return { ...entry, fingerprint };
  });
  if (!changed) return alreadyTrusted;
  return writeRaw({ v: RECENT_SERVERS_SCHEMA_VERSION, servers });
}

/**
 * Explicitly replace the matching entry's fingerprint. Used only by the
 * legacy "Use this server anyway" recovery action, where the human has
 * confirmed that the newly observed server should become authoritative.
 */
export function replaceRecentServerFingerprint(
  serverUrl: string,
  fingerprint: string,
): boolean {
  if (!fingerprint) return false;
  const key = safeRecentServerDedupeKey(serverUrl);
  if (!key) return false;
  const current = readRaw();
  let changed = false;
  const servers = current.servers.map((entry) => {
    if (safeRecentServerDedupeKey(entry.url) !== key) return entry;
    if (entry.fingerprint === fingerprint) return entry;
    changed = true;
    return { ...entry, fingerprint };
  });
  if (!changed) return false;
  return writeRaw({ v: RECENT_SERVERS_SCHEMA_VERSION, servers });
}

/**
 * Finish metadata for an already committed connection, including an explicitly
 * accepted identity replacement. The active authority owns trust; this recent
 * entry is its projection. Never use an observed candidate alone to replace it.
 * Both live handoff and restart recovery may replay this step.
 */
export function setCommittedRecentServerFingerprint(
  serverUrl: string,
  fingerprint: string,
  authority: ActiveAuthority,
): boolean {
  let origin: string;
  try { origin = new URL(serverUrl).origin; } catch { return false; }
  if (!fingerprint || authority.scope !== origin || !authority.revision ||
      !authority.connectionAttemptId || authority.serverFingerprint !== fingerprint) {
    return false;
  }
  return setRecentServerFingerprint(serverUrl, fingerprint) ||
    replaceRecentServerFingerprint(serverUrl, fingerprint);
}

/**
 * M161 Phase 3.2 — one-time boot migrator. Reads the legacy
 * `paired-server-identity.json` (via `deps.readIdentity`), folds its
 * fingerprint onto the recent entry matching the active server URL
 * (only if that entry has no fingerprint yet), then unlinks the legacy
 * file (via `deps.unlink`). Idempotent: once the legacy file is gone,
 * `readIdentity` returns `null` and this is a no-op. Non-destructive:
 * never overwrites an existing fingerprint and never touches
 * non-matching entries. Returns `true` when a migration was performed.
 *
 * `deps` is injected so the unit test can mock the legacy file read +
 * unlink without an Electron `app.getPath` runtime; main.ts wires the
 * real `readPairedServerIdentity` / `pairedServerIdentityPath` + `fs.unlinkSync`.
 */
export function migratePairedServerIdentityToFingerprint(
  activeServerUrl: string,
  deps: { readIdentity: () => string | null; unlink: () => void },
): boolean {
  const identity = deps.readIdentity();
  if (!identity || identity.length === 0) return false;
  const existing = getRecentServerFingerprint(activeServerUrl);
  const stored = existing !== null ||
    setRecentServerFingerprint(activeServerUrl, identity);
  // If no matching recent entry exists, retain the legacy file for old
  // boot compatibility. Deleting it here would lose the only expected
  // identity without establishing the schema-v2 authority.
  if (!stored) return false;
  try {
    deps.unlink();
  } catch {
    /* legacy file already gone or unreadable — migration is still done */
  }
  return true;
}
