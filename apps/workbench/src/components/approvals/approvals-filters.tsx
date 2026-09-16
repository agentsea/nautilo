import type { CommandApprovalRow } from "@nautilo/api-client";
import {
  extractRoomFilterOptions,
  type ApprovalFilters,
  type RoomFilterOption,
  roomFilterLabel,
  type ScopeFilter,
} from "./filter-approvals";
import {
  countByToolFamily,
  TOOL_FAMILY_CHIP_ORDER,
  TOOL_FAMILY_LABELS,
  type ToolFamilyChip,
} from "./tool-display";

const SELECT_CLASS =
  "rounded-md border border-border bg-background-element px-3 py-1.5 text-sm text-foreground focus:border-border-interactive focus:outline-none";

const SEARCH_INPUT_CLASS =
  "w-full rounded-md border border-border bg-background-element px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function scopeFilterValue(scope: ScopeFilter): string {
  if (scope === "all") return "all";
  if (scope === "server") return "server";
  return scope.roomId;
}

function parseScopeFilter(value: string, roomOptions: readonly RoomFilterOption[]): ScopeFilter {
  if (value === "all" || value === "server") return value;
  const match = roomOptions.find((r) => r.roomId === value);
  return match ? { roomId: match.roomId } : "all";
}

export function ApprovalsFilters({
  allRows,
  filters,
  onChange,
}: {
  allRows: readonly CommandApprovalRow[];
  filters: ApprovalFilters;
  onChange: (next: ApprovalFilters) => void;
}) {
  const roomOptions = extractRoomFilterOptions(allRows);
  const familyCounts = countByToolFamily(allRows);

  return (
    <div
      data-testid="approvals-filters"
      className="flex flex-col gap-3 rounded-lg border border-border bg-background-panel px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-foreground-muted">
          <span>Show:</span>
          <select
            data-testid="approvals-scope-filter"
            aria-label="Filter approvals by scope"
            value={scopeFilterValue(filters.scope)}
            onChange={(e) =>
              onChange({
                ...filters,
                scope: parseScopeFilter(e.target.value, roomOptions),
              })
            }
            className={SELECT_CLASS}
          >
            <option value="all">All scopes</option>
            <option value="server">Server-wide only</option>
            {roomOptions.map((room) => (
              <option key={room.roomId} value={room.roomId}>
                {roomFilterLabel(room)}
              </option>
            ))}
          </select>
        </label>

        <div className="min-w-[12rem] flex-1">
          <input
            id="approvals-search"
            type="text"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder="Search approvals…"
            aria-label="Search approvals"
            className={SEARCH_INPUT_CLASS}
          />
        </div>
      </div>

      <div
        data-testid="approvals-family-chips"
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter by tool family"
      >
        {(["all", ...TOOL_FAMILY_CHIP_ORDER] as ToolFamilyChip[]).map((family) => {
          const active = filters.family === family;
          const count = familyCounts[family];
          return (
            <button
              key={family}
              type="button"
              data-testid={`approvals-family-chip-${family}`}
              aria-pressed={active}
              onClick={() => onChange({ ...filters, family })}
              className={[
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-primary/15 text-primary"
                  : "bg-background-element text-foreground-muted hover:text-foreground",
              ].join(" ")}
            >
              <span>{TOOL_FAMILY_LABELS[family]}</span>
              <span className="tabular-nums opacity-80">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
