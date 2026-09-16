import type { CommandApprovalRow } from "@nautilo/api-client";
import { classifyToolFamily, type ToolFamilyChip } from "./tool-display";

export type ScopeFilter = "all" | "server" | { roomId: string };

export interface ApprovalFilters {
  scope: ScopeFilter;
  search: string;
  family: ToolFamilyChip;
}

export interface RoomFilterOption {
  roomId: string;
  roomLabel: string | null;
}

export function roomFilterLabel(option: RoomFilterOption): string {
  return `Room: ${option.roomLabel ?? "(unknown)"}`;
}

/** Unique room-scoped entries from loaded rows, first-seen order preserved. */
export function extractRoomFilterOptions(
  rows: readonly CommandApprovalRow[],
): RoomFilterOption[] {
  const seen = new Set<string>();
  const options: RoomFilterOption[] = [];
  for (const row of rows) {
    if (row.scope !== "room" || !row.roomId || seen.has(row.roomId)) continue;
    seen.add(row.roomId);
    options.push({ roomId: row.roomId, roomLabel: row.roomLabel });
  }
  return options;
}

export function filterApprovals(
  rows: readonly CommandApprovalRow[],
  filters: ApprovalFilters,
): CommandApprovalRow[] {
  const search = filters.search.trim().toLowerCase();

  return rows.filter((row) => {
    if (filters.scope === "server" && row.scope !== "server") return false;
    if (
      typeof filters.scope === "object" &&
      (row.scope !== "room" || row.roomId !== filters.scope.roomId)
    ) {
      return false;
    }

    if (search.length > 0) {
      const haystack = `${row.label}\u0000${row.toolPattern}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    if (filters.family !== "all" && classifyToolFamily(row) !== filters.family) {
      return false;
    }

    return true;
  });
}
