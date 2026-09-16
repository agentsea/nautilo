import type { MemoryAccessEntry, MemoryListItem, MemoryMode } from "../../lib/memory-api";

export type MemoryRowKind = "namespace" | "scope" | "scope-seed";

export interface MemoryRowAffordances {
  badge: string;
  canEdit: boolean;
  canArchive: boolean;
  canDelete: boolean;
  isReadOnly: boolean;
}

export type MemoryKindFilter = "all" | "namespace" | "scope";

export interface MemoryListFilters {
  query: string;
  kind: MemoryKindFilter;
  namespaceId: string;
}

function scopeOriginOf(item: Pick<MemoryListItem, "scopeOrigin" | "origin">): "seed" | "scope" | null {
  return item.scopeOrigin ?? item.origin ?? null;
}

export function rowKind(
  item: Pick<MemoryListItem, "namespaceIds" | "scopeOrigin" | "origin">,
  memoryMode: MemoryMode,
): MemoryRowKind {
  const origin = scopeOriginOf(item);
  if (memoryMode === "scope") {
    return origin === "seed" ? "scope-seed" : "scope";
  }
  if (origin === "seed") return "scope-seed";
  if (origin === "scope" || item.namespaceIds.length === 0) return "scope";
  return "namespace";
}

export function rowAffordances(kind: MemoryRowKind): MemoryRowAffordances {
  switch (kind) {
    case "namespace":
      return {
        badge: "⌂ ns",
        canEdit: true,
        canArchive: true,
        canDelete: true,
        isReadOnly: false,
      };
    case "scope":
      return {
        badge: "◇ scope",
        canEdit: true,
        canArchive: true,
        canDelete: true,
        isReadOnly: false,
      };
    case "scope-seed":
      return {
        badge: "◇ scope",
        canEdit: false,
        canArchive: false,
        canDelete: false,
        isReadOnly: true,
      };
  }
}

export function formatImportanceStars(importance: number): string {
  const stars = Math.min(3, Math.max(1, Math.round(importance * 3)));
  return "⭐".repeat(stars);
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Math.max(0, now - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins || 1}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function filterMemories(
  items: MemoryListItem[],
  memoryMode: MemoryMode,
  filters: MemoryListFilters,
): MemoryListItem[] {
  return items.filter((item) => {
    const kind = rowKind(item, memoryMode);
    if (filters.kind === "namespace" && kind !== "namespace") return false;
    if (filters.kind === "scope" && kind === "namespace") return false;
    if (
      filters.namespaceId !== "all" &&
      !item.namespaceIds.includes(filters.namespaceId)
    ) {
      return false;
    }
    const q = filters.query.trim().toLowerCase();
    if (!q) return true;
    return (
      item.content.toLowerCase().includes(q) ||
      item.type.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q)
    );
  });
}

export function memorySummaryLine(
  items: MemoryListItem[],
  memoryMode: MemoryMode,
): { namespaceCount: number; scopeCount: number } {
  let namespaceCount = 0;
  let scopeCount = 0;
  for (const item of items) {
    const kind = rowKind(item, memoryMode);
    if (kind === "namespace") namespaceCount += 1;
    else scopeCount += 1;
  }
  return { namespaceCount, scopeCount };
}

export function truncateContent(content: string, max = 120): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export type MemoryAudienceState = "private" | "shared";

/** Coarse audience state for a LIST row (the list endpoint returns no accessList,
 *  only namespaceIds). 1 namespace = private; >1 = shared. */
export function audienceState(item: Pick<MemoryListItem, "namespaceIds">): MemoryAudienceState {
  return item.namespaceIds.length > 1 ? "shared" : "private";
}

/** Audience state derived from a DETAIL accessList (the people who can see it).
 *  <=1 person (just you) = private; >1 = shared. */
export function audienceStateFromAccessList(
  accessList: MemoryAccessEntry[] | undefined,
): MemoryAudienceState {
  return accessList && accessList.length > 1 ? "shared" : "private";
}

/** Short badge label for a row / headline. */
export function audienceBadgeLabel(state: MemoryAudienceState): string {
  return state === "shared" ? "👥 Shared" : "🔒 Private";
}

/**
 * Compact people summary for a list row: up to `max` names, then `+N`.
 * Empty/undefined → "". Used when the server supplies a per-row `accessList`.
 */
export function formatAudienceFaces(
  accessList: MemoryAccessEntry[] | undefined,
  max = 2,
): string {
  if (!accessList || accessList.length === 0) return "";
  const names = accessList.map(
    (a) => a.displayName?.trim() || (a.userHandle ? `@${a.userHandle}` : "unknown"),
  );
  if (names.length <= max) return names.join(" · ");
  return `${names.slice(0, max).join(" · ")} +${names.length - max}`;
}

/** Whether to show the access-management controls (grant/revoke/make-private).
 *  Server enforces `manage_memories`; this only hides controls (M129 advisory). */
export function canManageAccess(canEdit: boolean): boolean {
  return canEdit;
}

/** Human-readable "Visible to" summary. Empty list → "Only you". */
export function formatAccessList(accessList: MemoryAccessEntry[] | undefined): string {
  if (!accessList || accessList.length === 0) return "Only you";
  return accessList
    .map((a) => a.displayName?.trim() || (a.userHandle ? `@${a.userHandle}` : "unknown"))
    .join(", ");
}
