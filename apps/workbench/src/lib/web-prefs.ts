export const DEFAULT_HOME = "https://duckduckgo.com";

export interface PinnedSite {
  appId: string;
  displayName: string;
  url: string;
  mode?: "app" | "browser";
}

export interface HistoryEntry {
  url: string;
  title?: string;
  at: number;
}

// Pinned sites are the user's own browser bookmarks and start EMPTY — the
// curated Google Suite accordion (app-mode SaaS integrations with skills) is a
// separate concept owned by the Web rail, not seeded here. Users add pins via
// the address-bar ⭐. The export is retained for API stability / future seeding.
export const DEFAULT_PINNED_SITES: readonly PinnedSite[] = [];

export const HISTORY_CAP = 20;

type StorageLeaf = "home" | "pinned" | "history";

function keyFor(viewerKey: string, leaf: StorageLeaf): string {
  return `nautilo.web.${viewerKey}.v1.${leaf}`;
}

// Same-document localStorage writes do not fire the native `storage` event
// (that is cross-tab only), so components that need to react to pin/unpin or
// history changes made elsewhere in this window subscribe here.
type WebPrefsListener = () => void;
const listeners = new Set<WebPrefsListener>();

export function subscribeWebPrefs(listener: WebPrefsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyWebPrefs(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a listener throwing must not break other listeners or the writer */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readRaw(viewerKey: string, leaf: StorageLeaf): string | null {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    return ls.getItem(keyFor(viewerKey, leaf));
  } catch {
    return null;
  }
}

function writeRaw(viewerKey: string, leaf: StorageLeaf, value: string): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(keyFor(viewerKey, leaf), value);
  } catch {
    /* quota / private mode */
  }
}

function removeRaw(viewerKey: string, leaf: StorageLeaf): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(keyFor(viewerKey, leaf));
  } catch {
    /* swallow */
  }
}

function isPinnedSite(value: unknown): value is PinnedSite {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.appId !== "string") return false;
  if (typeof obj.displayName !== "string") return false;
  if (typeof obj.url !== "string") return false;
  if (obj.mode !== undefined && obj.mode !== "app" && obj.mode !== "browser") {
    return false;
  }
  return true;
}

function copyPinnedSite(site: PinnedSite): PinnedSite {
  return site.mode === undefined
    ? { appId: site.appId, displayName: site.displayName, url: site.url }
    : {
        appId: site.appId,
        displayName: site.displayName,
        url: site.url,
        mode: site.mode,
      };
}

function copyHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return entry.title === undefined
    ? { url: entry.url, at: entry.at }
    : { url: entry.url, title: entry.title, at: entry.at };
}

function defaultPinnedSitesCopy(): PinnedSite[] {
  return DEFAULT_PINNED_SITES.map(copyPinnedSite);
}

function parseHome(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

function parsePinnedSites(raw: string | null): PinnedSite[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const sites: PinnedSite[] = [];
    for (const item of parsed) {
      if (!isPinnedSite(item)) return null;
      sites.push(copyPinnedSite(item));
    }
    return sites;
  } catch {
    return null;
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.url !== "string") return false;
  if (typeof obj.at !== "number" || !Number.isFinite(obj.at)) return false;
  if (obj.title !== undefined && typeof obj.title !== "string") return false;
  return true;
}

function parseHistory(raw: string | null): HistoryEntry[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries: HistoryEntry[] = [];
    for (const item of parsed) {
      if (!isHistoryEntry(item)) return null;
      entries.push(copyHistoryEntry(item));
    }
    return entries;
  } catch {
    return null;
  }
}

export function getHome(viewerKey: string | null): string {
  if (!viewerKey) return DEFAULT_HOME;
  const parsed = parseHome(readRaw(viewerKey, "home"));
  return parsed ?? DEFAULT_HOME;
}

export function setHome(viewerKey: string | null, url: string): void {
  if (!viewerKey) return;
  writeRaw(viewerKey, "home", JSON.stringify(url));
  notifyWebPrefs();
}

export function getPinnedSites(viewerKey: string | null): PinnedSite[] {
  if (!viewerKey) return defaultPinnedSitesCopy();
  const parsed = parsePinnedSites(readRaw(viewerKey, "pinned"));
  return parsed ?? defaultPinnedSitesCopy();
}

export function setPinnedSites(viewerKey: string | null, sites: PinnedSite[]): void {
  if (!viewerKey) return;
  const copy = sites.map(copyPinnedSite);
  writeRaw(viewerKey, "pinned", JSON.stringify(copy));
  notifyWebPrefs();
}

export function addPinnedSite(viewerKey: string | null, site: PinnedSite): PinnedSite[] {
  const siteCopy = copyPinnedSite(site);
  const current = getPinnedSites(viewerKey);
  const normalizedUrl = siteCopy.url.toLowerCase();
  const next = [...current.filter((s) => s.url.toLowerCase() !== normalizedUrl), siteCopy];
  setPinnedSites(viewerKey, next);
  return next.map(copyPinnedSite);
}

export function removePinnedSite(viewerKey: string | null, url: string): PinnedSite[] {
  const normalizedUrl = url.toLowerCase();
  const next = getPinnedSites(viewerKey).filter(
    (s) => s.url.toLowerCase() !== normalizedUrl,
  );
  setPinnedSites(viewerKey, next);
  return next.map(copyPinnedSite);
}

export function isPinned(viewerKey: string | null, url: string): boolean {
  const normalizedUrl = url.toLowerCase();
  return getPinnedSites(viewerKey).some((s) => s.url.toLowerCase() === normalizedUrl);
}

export function getHistory(viewerKey: string | null): HistoryEntry[] {
  if (!viewerKey) return [];
  const parsed = parseHistory(readRaw(viewerKey, "history"));
  return parsed ?? [];
}

export function pushHistory(viewerKey: string | null, entry: HistoryEntry): HistoryEntry[] {
  const entryCopy = copyHistoryEntry(entry);
  const current = getHistory(viewerKey);
  let next: HistoryEntry[];
  if (current.length > 0 && current[0].url === entryCopy.url) {
    next = [entryCopy, ...current.slice(1).map(copyHistoryEntry)];
  } else {
    next = [entryCopy, ...current.map(copyHistoryEntry)];
  }
  if (next.length > HISTORY_CAP) {
    next = next.slice(0, HISTORY_CAP);
  }
  if (viewerKey) {
    writeRaw(viewerKey, "history", JSON.stringify(next));
    notifyWebPrefs();
  }
  return next.map(copyHistoryEntry);
}

export function clearHistory(viewerKey: string | null): void {
  if (!viewerKey) return;
  removeRaw(viewerKey, "history");
  notifyWebPrefs();
}
