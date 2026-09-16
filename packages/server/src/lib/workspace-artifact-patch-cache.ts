/**
 * ISSUE-M193 — bounded in-memory recent patch event cache (same-process catch-up).
 */

import type { DocumentPatchEvent } from "@nautilo/types";

const MAX_EVENTS_PER_ARTIFACT = 64;
const MAX_AGE_MS = 5 * 60 * 1000;

type CachedEntry = DocumentPatchEvent & { cachedAt: number };

const cacheByArtifactId = new Map<string, CachedEntry[]>();

function pruneArtifactEntries(entries: CachedEntry[], now: number): CachedEntry[] {
  const minTime = now - MAX_AGE_MS;
  let next = entries.filter((e) => e.cachedAt >= minTime);
  if (next.length > MAX_EVENTS_PER_ARTIFACT) {
    next = next.slice(next.length - MAX_EVENTS_PER_ARTIFACT);
  }
  return next;
}

export function appendWorkspaceArtifactPatchEvent(
  artifactInternalId: string,
  event: DocumentPatchEvent,
): void {
  const now = Date.now();
  const existing = cacheByArtifactId.get(artifactInternalId) ?? [];
  const entry: CachedEntry = { ...event, cachedAt: now };
  const pruned = pruneArtifactEntries([...existing, entry], now);
  cacheByArtifactId.set(artifactInternalId, pruned);
}

export function getWorkspaceArtifactPatchEventsSince(
  artifactInternalId: string,
  opts: { sinceRevision?: number | undefined; sincePatchId?: string | undefined },
): { ok: true; events: DocumentPatchEvent[] } | { ok: false; reason: "cache_miss" } {
  const now = Date.now();
  const raw = cacheByArtifactId.get(artifactInternalId);
  if (!raw || raw.length === 0) {
    return { ok: false, reason: "cache_miss" };
  }
  const entries = pruneArtifactEntries(raw, now);
  cacheByArtifactId.set(artifactInternalId, entries);
  if (entries.length === 0) {
    return { ok: false, reason: "cache_miss" };
  }

  if (opts.sincePatchId !== undefined && opts.sincePatchId.length > 0) {
    const idx = entries.findIndex((e) => e.patchId === opts.sincePatchId);
    if (idx === -1) {
      return { ok: false, reason: "cache_miss" };
    }
    const slice = entries.slice(idx + 1).map(stripCachedAt);
    if (slice.length === 0) {
      return { ok: true, events: [] };
    }
    return contiguousFromRevision(slice, entries[idx]!.revision) ?? {
      ok: false,
      reason: "cache_miss",
    };
  }

  if (opts.sinceRevision !== undefined) {
    const filtered = entries.filter(
      (e) => e.revision !== null && e.revision > opts.sinceRevision!,
    );
    if (filtered.length === 0) {
      return { ok: true, events: [] };
    }
    const events = filtered.map(stripCachedAt);
    return contiguousFromRevision(events, opts.sinceRevision) ?? {
      ok: false,
      reason: "cache_miss",
    };
  }

  return { ok: false, reason: "cache_miss" };
}

function contiguousFromRevision(
  events: DocumentPatchEvent[],
  sinceRevision: number | null | undefined,
): { ok: true; events: DocumentPatchEvent[] } | null {
  if (events.length === 0) {
    return { ok: true, events: [] };
  }
  let expected =
    sinceRevision === null || sinceRevision === undefined ? null : sinceRevision + 1;
  for (const ev of events) {
    if (expected === null) {
      expected = ev.revision === null ? null : ev.revision + 1;
      continue;
    }
    if (ev.revision !== expected) {
      return null;
    }
    expected = ev.revision === null ? null : ev.revision + 1;
  }
  return { ok: true, events };
}

function stripCachedAt(entry: CachedEntry): DocumentPatchEvent {
  const { cachedAt: _cachedAt, ...event } = entry;
  return event;
}

/** Test-only reset. */
export function clearWorkspaceArtifactPatchCacheForTests(): void {
  cacheByArtifactId.clear();
}
