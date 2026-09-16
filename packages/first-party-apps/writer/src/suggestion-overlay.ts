import type {
  Document, DocumentLayout, LayoutLine, LayoutRun, PaginatedLayout,
} from "@nautilo/office-docs/node";
import type { StructuralChange } from "./structural-diff";

export type OverlayKind = "insert" | "delete" | "format" | "move";

export interface OverlayChange {
  id: string;
  kind: OverlayKind;
  blockId: string;
  start: number;
  end: number;
  text?: string;
  label: string;
  moveRole?: "source" | "destination";
}

export interface OverlayRect {
  changeId: string;
  kind: OverlayKind;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  label: string;
  moveRole?: "source" | "destination";
}

export interface OverlayLayout {
  rects: OverlayRect[];
  pageCount: number;
  totalHeight: number;
}

export interface OverlayPublicApi {
  measureText(text: string): number;
  computeLayout(document: Document, contentWidth: number): DocumentLayout;
  paginate(layout: DocumentLayout, document: Document): PaginatedLayout;
  pageX(layout: PaginatedLayout, canvasWidth: number): number;
  pageY(layout: PaginatedLayout, pageIndex: number): number;
  totalHeight(layout: PaginatedLayout): number;
  scale(containerWidth: number, pageWidth: number): number;
  pageWidth(document: Document): number;
  contentWidth(document: Document): number;
}

interface PageLineRef {
  pageIndex: number;
  x: number;
  y: number;
  line: LayoutLine;
}

const CHANGE_LABEL: Record<OverlayKind, string> = {
  delete: "Deleted text",
  insert: "Inserted text",
  format: "Formatting change",
  move: "Moved content",
};

function textOf(document: Document, blockId: string): string {
  const block = document.blocks.find((candidate) => candidate.id === blockId);
  return block?.inlines?.map((inline) => inline.text).join("") ?? "";
}

function widthBefore(run: LayoutRun, character: number): number {
  return character <= 0 ? 0 : run.charOffsets[character - 1] ?? run.width;
}

function pageLines(paginated: PaginatedLayout): Map<string, PageLineRef> {
  const lines = new Map<string, PageLineRef>();
  for (const page of paginated.pages) {
    for (const pageLine of page.lines) {
      lines.set(`${pageLine.blockIndex}:${pageLine.lineIndex}`, {
        pageIndex: page.pageIndex,
        x: pageLine.x,
        y: pageLine.y,
        line: pageLine.line,
      });
    }
  }
  return lines;
}

function anchorForProposedBlock(base: Document, proposed: Document, index: number): { blockId: string; offset: number } | null {
  for (let cursor = Math.min(index - 1, proposed.blocks.length - 1); cursor >= 0; cursor -= 1) {
    const candidate = proposed.blocks[cursor];
    if (candidate && base.blocks.some((block) => block.id === candidate.id)) {
      return { blockId: candidate.id, offset: textOf(base, candidate.id).length };
    }
  }
  const first = base.blocks[0];
  return first ? { blockId: first.id, offset: 0 } : null;
}

/** Maps P2's structural changes to view-only markers over the base document. */
export function overlayChangesForSuggestion(
  base: Document,
  proposed: Document,
  changes: readonly StructuralChange[],
): OverlayChange[] {
  const result: OverlayChange[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "inline-delete":
        result.push({ id: change.id, kind: "delete", blockId: change.blockId, start: change.start, end: change.end, label: CHANGE_LABEL.delete });
        break;
      case "inline-insert":
        result.push({ id: change.id, kind: "insert", blockId: change.blockId, start: change.start, end: change.start, text: change.after, label: CHANGE_LABEL.insert });
        break;
      case "inline-replace":
        result.push({ id: change.id, kind: "delete", blockId: change.blockId, start: change.start, end: change.end, label: "Replaced text: removed" });
        result.push({ id: change.id, kind: "insert", blockId: change.blockId, start: change.start, end: change.start, text: change.after, label: "Replaced text: inserted" });
        break;
      case "block-delete":
        result.push({ id: change.id, kind: "delete", blockId: change.blockId, start: 0, end: textOf(base, change.blockId).length, label: "Deleted block" });
        break;
      case "block-insert": {
        const anchor = anchorForProposedBlock(base, proposed, change.index);
        if (anchor) result.push({
          id: change.id, kind: "insert", blockId: anchor.blockId, start: anchor.offset, end: anchor.offset,
          text: textOf(proposed, change.blockId), label: "Inserted block",
        });
        break;
      }
      case "inline-style":
      case "block-style":
      case "block-type":
        result.push({
          id: change.id, kind: "format", blockId: change.blockId, start: 0,
          end: Math.max(1, textOf(base, change.blockId).length), label: change.kind === "block-type" ? "Block type changed" : CHANGE_LABEL.format,
        });
        break;
      case "move": {
        const sourceText = textOf(base, change.blockId);
        result.push({
          id: change.id, kind: "move", blockId: change.blockId, start: 0, end: Math.max(1, sourceText.length),
          label: `Move ${change.id.slice(-5)}: source`, moveRole: "source",
        });
        const destination = anchorForProposedBlock(base, proposed, change.to);
        if (destination) result.push({
          id: change.id, kind: "move", blockId: destination.blockId, start: destination.offset, end: destination.offset,
          label: `Move ${change.id.slice(-5)}: destination`, moveRole: "destination",
        });
        break;
      }
    }
  }
  return result;
}

/** Splits ranges at public LayoutRun boundaries, including wrapped page lines. */
export function geometryForOverlayChanges(
  document: Document,
  changes: readonly OverlayChange[],
  layout: DocumentLayout,
  paginated: PaginatedLayout,
  pageX: number,
  pageY: (pageIndex: number) => number,
  measureInsertion: (text: string) => number,
  totalHeight: number,
): OverlayLayout {
  const lines = pageLines(paginated);
  const rects: OverlayRect[] = [];
  for (const change of changes) {
    const blockIndex = document.blocks.findIndex((block) => block.id === change.blockId);
    const layoutBlock = blockIndex < 0 ? undefined : layout.blocks[blockIndex];
    if (!layoutBlock) continue;
    for (let lineIndex = 0; lineIndex < layoutBlock.lines.length; lineIndex += 1) {
      const pageLine = lines.get(`${blockIndex}:${lineIndex}`);
      if (!pageLine) continue;
      for (const run of pageLine.line.runs) {
        const point = change.start === change.end;
        const from = Math.max(change.start, run.charStart);
        const to = Math.min(change.end, run.charEnd);
        if ((!point && from >= to) || (point && (change.start < run.charStart || change.start > run.charEnd))) continue;
        const localStart = point ? Math.max(0, Math.min(change.start - run.charStart, run.text.length)) : from - run.charStart;
        const localEnd = point ? localStart : to - run.charStart;
        rects.push({
          changeId: change.id, kind: change.kind, pageIndex: pageLine.pageIndex,
          x: pageX + pageLine.x + run.x + widthBefore(run, localStart),
          y: pageY(pageLine.pageIndex) + pageLine.y,
          width: point ? Math.max(6, measureInsertion(change.text ?? "")) : Math.max(1, widthBefore(run, localEnd) - widthBefore(run, localStart)),
          height: pageLine.line.height, text: point ? change.text ?? "" : run.text.slice(localStart, localEnd),
          label: change.label, moveRole: change.moveRole,
        });
        if (point) break;
      }
    }
  }
  return { rects, pageCount: paginated.pages.length, totalHeight };
}

export function computeOverlayLayout(
  api: OverlayPublicApi, base: Document, proposed: Document, changes: readonly StructuralChange[], containerWidth: number,
): { layout: OverlayLayout; changes: OverlayChange[]; scale: number } {
  const scale = api.scale(containerWidth, api.pageWidth(base));
  const documentLayout = api.computeLayout(base, api.contentWidth(base));
  const paginated = api.paginate(documentLayout, base);
  const overlayChanges = overlayChangesForSuggestion(base, proposed, changes);
  return {
    changes: overlayChanges,
    scale,
    layout: geometryForOverlayChanges(
      base, overlayChanges, documentLayout, paginated, api.pageX(paginated, containerWidth / scale),
      (pageIndex) => api.pageY(paginated, pageIndex), (...args) => api.measureText(...args), api.totalHeight(paginated),
    ),
  };
}

export function hitTestOverlay(layout: OverlayLayout, x: number, y: number): string | null {
  return layout.rects.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)?.changeId ?? null;
}

export function adjacentChangeId(changes: readonly OverlayChange[], currentId: string | null, direction: 1 | -1): string | null {
  const ids = [...new Set(changes.map((change) => change.id))];
  if (ids.length === 0) return null;
  const current = currentId ? ids.indexOf(currentId) : direction === 1 ? -1 : 0;
  return ids[(current + direction + ids.length) % ids.length] ?? null;
}

/** Keeps review selection only while the same pending proposal remains active. */
export function activeChangeAfterProposalTransition(
  activeChangeId: string | null,
  previousProposalId: string | null,
  nextProposalId: string | null,
): string | null {
  return previousProposalId === nextProposalId ? activeChangeId : null;
}

export interface OverlayPalette {
  delete: string;
  insert: string;
  format: string;
  move: string;
}

export function paintSuggestionOverlay(
  context: CanvasRenderingContext2D, layout: OverlayLayout, activeChangeId: string | null, scale: number,
  palette?: OverlayPalette,
): void {
  context.save();
  context.scale(scale, scale);
  context.font = "12px -apple-system, system-ui, sans-serif";
  context.textBaseline = "alphabetic";
  const labeled = new Set<string>();
  for (const rect of layout.rects) {
    const active = rect.changeId === activeChangeId;
    const variable = rect.kind === "delete" ? "--wr-redline-delete" : rect.kind === "insert" ? "--wr-redline-insert" : rect.kind === "move" ? "--wr-redline-move" : "--wr-redline-format";
    const color = palette?.[rect.kind] ?? (getComputedStyle(context.canvas).getPropertyValue(variable).trim() || "#475569");
    context.strokeStyle = color;
    context.lineWidth = active ? 2 : 1;
    if (rect.kind === "delete") {
      context.fillStyle = `${color}${active ? "40" : "24"}`;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.beginPath();
      context.moveTo(rect.x, rect.y + rect.height / 2);
      context.lineTo(rect.x + rect.width, rect.y + rect.height / 2);
      context.stroke();
    } else if (rect.kind === "insert") {
      const paddingX = 6;
      const calloutHeight = Math.max(18, rect.height);
      const calloutWidth = Math.max(18, rect.width + paddingX * 2 + 50);
      const calloutY = rect.y >= calloutHeight + 6
        ? rect.y - calloutHeight - 6
        : rect.y + rect.height + 6;
      const anchorY = rect.y + rect.height / 2;
      const connectorY = calloutY < rect.y ? calloutY + calloutHeight : calloutY;
      // The insertion remains view-only and never occupies the canonical glyph
      // baseline: a connector ties its tinted annotation to the measured anchor.
      context.beginPath();
      context.moveTo(rect.x, anchorY);
      context.lineTo(rect.x, connectorY);
      context.stroke();
      context.fillStyle = `${color}${active ? "40" : "24"}`;
      context.fillRect(rect.x, calloutY, calloutWidth, calloutHeight);
      context.strokeRect(rect.x, calloutY, calloutWidth, calloutHeight);
      context.fillStyle = color;
      context.fillText(`Inserted: ${rect.text}`, rect.x + paddingX, calloutY + Math.min(calloutHeight - 4, 13));
    } else if (!labeled.has(`${rect.changeId}:${rect.moveRole ?? ""}`)) {
      context.fillStyle = `${color}${active ? "40" : "24"}`;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.fillStyle = color;
      context.fillText(rect.label, rect.x, Math.max(12, rect.y - 3));
      labeled.add(`${rect.changeId}:${rect.moveRole ?? ""}`);
    }
  }
  context.restore();
}

/** Coalesces bursts (ResizeObserver can emit several records per layout). */
export function createBoundedScheduler(callback: () => void): { schedule: () => void; cancel: () => void } {
  let frame: number | null = null;
  return {
    schedule: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; callback(); });
    },
    cancel: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

export function observeOverlayResize(
  element: Element, callback: () => void,
  Observer: typeof ResizeObserver = ResizeObserver,
): () => void {
  const scheduler = createBoundedScheduler(callback);
  const observer = new Observer(() => scheduler.schedule());
  observer.observe(element);
  return () => { observer.disconnect(); scheduler.cancel(); };
}
