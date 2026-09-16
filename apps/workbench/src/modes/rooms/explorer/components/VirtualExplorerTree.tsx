import { useMemo, useRef, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ExplorerSection } from "../explorer-grouping.types";
import {
  flattenExplorerVisibleRows,
  isExplorerRowExpandable,
  isSectionOpen,
  sectionHeaderId,
  type FlatExplorerRow,
} from "../flatten-explorer-visible-rows";
import { useExplorerExpanded } from "../hooks/useExplorerExpanded";
import { ExplorerRow } from "../sections/shared/ExplorerRow";

const EXPLORER_ROW_HEIGHT_PX = 40;
const SECTION_HEADER_HEIGHT_PX = 28;
const VIRTUAL_OVERSCAN = 8;

function estimateRowHeight(flat: FlatExplorerRow): number {
  return flat.type === "section-header" ? SECTION_HEADER_HEIGHT_PX : EXPLORER_ROW_HEIGHT_PX;
}

interface VirtualExplorerTreeProps {
  sections: ExplorerSection[];
  activeRoomId: string | null;
  onActivate: (roomId: string) => void;
}

function SectionHeaderRow(props: {
  flat: Extract<FlatExplorerRow, { type: "section-header" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const { flat, open, onToggle } = props;

  if (!flat.collapsible) {
    return (
      <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
        {flat.title}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 shrink-0 transition-transform ${
          open ? "rotate-90" : "rotate-0"
        }`}
      >
        <svg viewBox="0 0 8 8" fill="currentColor" className="h-2 w-2">
          <path d="M2 0 L6 4 L2 8 Z" />
        </svg>
      </span>
      <span className="select-none">{flat.title}</span>
    </button>
  );
}

export function VirtualExplorerTree({
  sections,
  activeRoomId,
  onActivate,
}: VirtualExplorerTreeProps) {
  const { isExpanded, toggleExpanded } = useExplorerExpanded();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visibleRows = useMemo(
    () => flattenExplorerVisibleRows(sections, isExpanded),
    [sections, isExpanded],
  );

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowHeight(visibleRows[index]),
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => visibleRows[index]?.id ?? index,
  });

  return (
    <VirtualExplorerTreeBody
      scrollRef={scrollRef}
      virtualizer={virtualizer}
      visibleRows={visibleRows}
      activeRoomId={activeRoomId}
      onActivate={onActivate}
      isExpanded={isExpanded}
      toggleExpanded={toggleExpanded}
    />
  );
}

function VirtualExplorerTreeBody(props: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  visibleRows: FlatExplorerRow[];
  activeRoomId: string | null;
  onActivate: (roomId: string) => void;
  isExpanded: (rowId: string) => boolean;
  toggleExpanded: (rowId: string) => void;
}) {
  const {
    scrollRef,
    virtualizer,
    visibleRows,
    activeRoomId,
    onActivate,
    isExpanded,
    toggleExpanded,
  } = props;

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
      role="tree"
      aria-label="Relationship explorer"
    >
      <div className="relative w-full" style={{ height: `${totalSize}px` }}>
        {items.map((v) => {
          const flat = visibleRows[v.index];
          if (!flat) return null;

          return (
            <div
              key={flat.id}
              data-index={v.index}
              data-explorer-row-id={flat.id}
              className="absolute left-0 right-0 top-0"
              style={{
                transform: `translateY(${v.start}px)`,
                height: `${v.size}px`,
              }}
            >
              {flat.type === "section-header" ? (
                <SectionHeaderRow
                  flat={flat}
                  open={isSectionOpen(
                    {
                      kind: flat.sectionKind,
                      title: flat.title,
                      defaultCollapsed: flat.defaultCollapsed,
                      rows: [],
                    },
                    isExpanded,
                  )}
                  onToggle={() => toggleExpanded(sectionHeaderId(flat.sectionKind))}
                />
              ) : (
                <ExplorerRow
                  row={flat.row}
                  isActive={flat.row.roomId.length > 0 && flat.row.roomId === activeRoomId}
                  onActivate={() => onActivate(flat.row.roomId)}
                  expanded={isExpanded(flat.row.id)}
                  onToggleExpand={
                    isExplorerRowExpandable(flat.row.kind) &&
                    (flat.row.children?.length ?? 0) > 0
                      ? () => toggleExpanded(flat.row.id)
                      : undefined
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
