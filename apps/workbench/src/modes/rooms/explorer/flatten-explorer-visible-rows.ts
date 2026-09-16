import type {
  ExplorerRow,
  ExplorerRowKind,
  ExplorerSection,
  ExplorerSectionKind,
} from "./explorer-grouping.types";

export type FlatExplorerRow =
  | {
      type: "section-header";
      id: string;
      title: string;
      collapsible: boolean;
      defaultCollapsed: boolean;
      sectionKind: ExplorerSectionKind;
    }
  | {
      type: "row";
      id: string;
      row: ExplorerRow;
      sectionKind: ExplorerSectionKind;
    };

export function isExplorerRowExpandable(kind: ExplorerRowKind): boolean {
  return (
    kind === "entity-human" ||
    kind === "entity-agent" ||
    kind === "threads" ||
    // Room leaves are expandable only when they carry a nested Threads
    // container; the flatten walk + render gate both check `children.length`,
    // so a childless room leaf never shows a chevron.
    kind === "direct-room" ||
    kind === "private-room"
  );
}

const L2_STRUCTURAL_ORDER: Partial<Record<ExplorerRowKind, number>> = {
  "direct-room": 0,
  "private-room": 0,
  threads: 2,
};

/** Pin L2 category order under entities; leaf lists keep data-layer sort. */
export function orderEntityChildren(children: ExplorerRow[]): ExplorerRow[] {
  return [...children].sort((a, b) => {
    const oa = L2_STRUCTURAL_ORDER[a.kind] ?? 99;
    const ob = L2_STRUCTURAL_ORDER[b.kind] ?? 99;
    return oa - ob;
  });
}

export function sectionHeaderId(kind: ExplorerSectionKind): string {
  return `section:${kind}`;
}

export function isSectionOpen(
  section: ExplorerSection,
  isExpanded: (rowId: string) => boolean,
): boolean {
  if (!section.defaultCollapsed) return true;
  return isExpanded(sectionHeaderId(section.kind));
}

export function flattenExplorerVisibleRows(
  sections: ExplorerSection[],
  isExpanded: (rowId: string) => boolean,
): FlatExplorerRow[] {
  const out: FlatExplorerRow[] = [];

  const walk = (row: ExplorerRow, sectionKind: ExplorerSectionKind) => {
    out.push({ type: "row", id: row.id, row, sectionKind });

    if (!row.children?.length) return;
    if (!isExplorerRowExpandable(row.kind)) return;
    if (!isExpanded(row.id)) return;

    const children =
      row.kind === "entity-human" || row.kind === "entity-agent"
        ? orderEntityChildren(row.children)
        : row.children;

    for (const child of children) {
      walk(child, sectionKind);
    }
  };

  for (const section of sections) {
    const headerId = sectionHeaderId(section.kind);
    out.push({
      type: "section-header",
      id: headerId,
      title: section.title,
      collapsible: section.defaultCollapsed,
      defaultCollapsed: section.defaultCollapsed,
      sectionKind: section.kind,
    });

    if (!isSectionOpen(section, isExpanded)) continue;

    for (const row of section.rows) {
      walk(row, section.kind);
    }
  }

  return out;
}
