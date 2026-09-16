/**
 * Bounded retention for the local revision journal.
 *
 * Prunes unpinned entries by per-path count, age, and total-byte budget while
 * removing dependent undo/redo chains coherently.
 */

import type { LocalRevisionEntry, RetentionConfig } from "./types.ts";

export interface RetentionPruneResult {
  removedIds: string[];
  removedBytes: number;
}

function collectDependentIds(
  rootId: string,
  entriesById: Map<string, LocalRevisionEntry>,
): Set<string> {
  const dependents = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const entry of entriesById.values()) {
      if (entry.restoreFromRevisionId === id && !dependents.has(entry.id)) {
        dependents.add(entry.id);
        queue.push(entry.id);
      }
    }
  }
  return dependents;
}

function expandRemovalSet(
  initial: Set<string>,
  entriesById: Map<string, LocalRevisionEntry>,
): Set<string> {
  const expanded = new Set(initial);
  for (const id of initial) {
    for (const dep of collectDependentIds(id, entriesById)) {
      expanded.add(dep);
    }
  }
  return expanded;
}

export function pruneManifestEntries(
  entries: LocalRevisionEntry[],
  config: RetentionConfig,
  nowMs: number = Date.now(),
): RetentionPruneResult {
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const toRemove = new Set<string>();

  const byPath = new Map<string, LocalRevisionEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.canonicalPath) ?? [];
    list.push(entry);
    byPath.set(entry.canonicalPath, list);
  }

  for (const pathEntries of byPath.values()) {
    const sorted = [...pathEntries].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const keepIds = new Set<string>();
    let unpinnedKept = 0;
    for (const entry of sorted) {
      if (entry.pinned) {
        keepIds.add(entry.id);
        continue;
      }
      if (unpinnedKept < config.maxEntriesPerPath) {
        keepIds.add(entry.id);
        unpinnedKept += 1;
      }
    }
    for (const entry of pathEntries) {
      if (!keepIds.has(entry.id) && !entry.pinned) {
        toRemove.add(entry.id);
      }
    }
  }

  for (const entry of entries) {
    if (entry.pinned || toRemove.has(entry.id)) continue;
    if (nowMs - Date.parse(entry.createdAt) > config.maxAgeMs) {
      toRemove.add(entry.id);
    }
  }

  const surviving = entries.filter((e) => !toRemove.has(e.id));
  let totalBytes = surviving.reduce((sum, e) => sum + e.payloadBytes, 0);

  if (totalBytes > config.maxTotalBytes) {
    const candidates = surviving
      .filter((e) => !e.pinned)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    for (const entry of candidates) {
      if (totalBytes <= config.maxTotalBytes) break;
      toRemove.add(entry.id);
      totalBytes -= entry.payloadBytes;
    }
  }

  const expanded = expandRemovalSet(toRemove, entriesById);

  let removedBytes = 0;
  for (const id of expanded) {
    const entry = entriesById.get(id);
    if (entry) removedBytes += entry.payloadBytes;
  }

  return {
    removedIds: [...expanded],
    removedBytes,
  };
}

export function applyPruneToEntries(
  entries: LocalRevisionEntry[],
  prune: RetentionPruneResult,
): LocalRevisionEntry[] {
  const removed = new Set(prune.removedIds);
  return entries.filter((e) => !removed.has(e.id));
}
