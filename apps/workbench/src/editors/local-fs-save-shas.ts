/**
 * M181 — discriminate the editor's own local-file saves from external
 * (agent / other-process) writes.
 *
 * This registry is compatibility-only for the legacy directory watcher, whose
 * events have no actor or client mutation id. Exact coordinator batches are
 * classified by actor/correlation and must never consult this SHA heuristic.
 *
 * Keep a short, bounded history rather than only the latest SHA. Autosaves are
 * serialized, but watcher callbacks are not: an event for save A can finish
 * reading after save B has already registered its SHA. A last-write-wins map
 * misclassifies A as external and unnecessarily resyncs/remounts the editor.
 *
 * Entries are intentionally not one-shot because one legacy atomic write can surface
 * multiple watcher events. The short TTL bounds the window in which a genuine
 * external revert to recently saved bytes would be treated as our own event.
 */
export const LOCAL_FS_SAVE_SHA_TTL_MS = 5_000;
const MAX_RECENT_SHAS_PER_PATH = 8;

type RecentSaveSha = {
  sha: string;
  registeredAt: number;
};

const ownShasByPath = new Map<string, RecentSaveSha[]>();

function recentEntries(path: string, now: number): RecentSaveSha[] {
  const entries = ownShasByPath.get(path);
  if (!entries) return [];

  const recent = entries.filter(
    (entry) => now - entry.registeredAt <= LOCAL_FS_SAVE_SHA_TTL_MS,
  );
  if (recent.length === 0) {
    ownShasByPath.delete(path);
  } else if (recent.length !== entries.length) {
    ownShasByPath.set(path, recent);
  }
  return recent;
}

export function registerLocalFsSaveSha(
  path: string,
  sha: string,
  now = Date.now(),
): void {
  const entries = recentEntries(path, now).filter((entry) => entry.sha !== sha);
  entries.push({ sha, registeredAt: now });
  ownShasByPath.set(path, entries.slice(-MAX_RECENT_SHAS_PER_PATH));
}

export function isLocalFsSaveSha(
  path: string,
  sha: string | null,
  now = Date.now(),
): boolean {
  if (!sha) return false;
  return recentEntries(path, now).some((entry) => entry.sha === sha);
}

/** Test-only helper to avoid cross-test SHA registry bleed. */
export function clearLocalFsSaveShasForTests(): void {
  ownShasByPath.clear();
}
