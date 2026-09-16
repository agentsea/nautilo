/**
 * D386 option 2 feasibility spike. This module deliberately consumes only
 * public @nautilo/office-docs layout APIs. It does not receive, write, or retain a
 * DocStore: callers supply a document snapshot and paint to a sibling canvas.
 */
import type {
  Document,
  DocumentLayout,
  LayoutLine,
  LayoutRun,
  PaginatedLayout,
} from "@nautilo/office-docs/node";

export type ChangeKind = "delete" | "insert" | "format" | "move";

export interface OverlayChange {
  id: string;
  kind: ChangeKind;
  blockId: string;
  start: number;
  end: number;
  text?: string;
  label: string;
}

export interface OverlayRect {
  changeId: string;
  kind: ChangeKind;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface OverlayLayout {
  rects: OverlayRect[];
  pageCount: number;
}

interface PageLineRef {
  pageIndex: number;
  x: number;
  y: number;
  line: LayoutLine;
}

const COLORS: Record<ChangeKind, string> = {
  delete: "#b42318",
  insert: "#067647",
  format: "#175cd3",
  move: "#7a5af8",
};

function widthBefore(run: LayoutRun, character: number): number {
  return character <= 0 ? 0 : run.charOffsets[character - 1] ?? run.width;
}

function pageLines(paginated: PaginatedLayout): Map<string, PageLineRef> {
  const refs = new Map<string, PageLineRef>();
  for (const page of paginated.pages) {
    for (const pageLine of page.lines) {
      refs.set(`${pageLine.blockIndex}:${pageLine.lineIndex}`, {
        pageIndex: page.pageIndex,
        x: pageLine.x,
        y: pageLine.y,
        line: pageLine.line,
      });
    }
  }
  return refs;
}

/**
 * Splits a document range at every public LayoutRun boundary, including wraps.
 * Coordinates use the same paginated canvas-paint space as DocCanvas. Runtime
 * layout and offset functions are injected by the browser harness so Bun tests
 * can exercise this pure adapter despite the package's conditional Node export.
 */
export function geometryForChanges(
  document: Document,
  changes: readonly OverlayChange[],
  layout: DocumentLayout,
  paginated: PaginatedLayout,
  pageX: number,
  pageY: (pageIndex: number) => number,
  measureInsertion: (text: string) => number,
): OverlayLayout {
  const lines = pageLines(paginated);
  const rects: OverlayRect[] = [];

  for (const change of changes) {
    const blockIndex = document.blocks.findIndex((block) => block.id === change.blockId);
    if (blockIndex < 0) continue;
    const layoutBlock = layout.blocks[blockIndex];
    if (!layoutBlock) continue;

    for (let lineIndex = 0; lineIndex < layoutBlock.lines.length; lineIndex += 1) {
      const pageLine = lines.get(`${blockIndex}:${lineIndex}`);
      if (!pageLine) continue;
      for (const run of pageLine.line.runs) {
        const from = Math.max(change.start, run.charStart);
        const to = Math.min(change.end, run.charEnd);
        // Inserts are point anchors; all other changes need an overlapping run.
        const isPoint = change.kind === "insert" && change.start === change.end;
        if ((!isPoint && from >= to) || (isPoint && (change.start < run.charStart || change.start > run.charEnd))) continue;

        const localStart = isPoint ? Math.max(0, Math.min(change.start - run.charStart, run.text.length)) : from - run.charStart;
        const localEnd = isPoint ? localStart : to - run.charStart;
        const x = pageX + pageLine.x + run.x + widthBefore(run, localStart);
        const width = isPoint
          ? Math.max(6, measureInsertion(change.text ?? ""))
          : Math.max(1, widthBefore(run, localEnd) - widthBefore(run, localStart));
        rects.push({
          changeId: change.id,
          kind: change.kind,
          pageIndex: pageLine.pageIndex,
          x,
          y: pageY(pageLine.pageIndex) + pageLine.y,
          width,
          height: pageLine.line.height,
          text: isPoint ? change.text ?? "" : run.text.slice(localStart, localEnd),
        });
        // A point anchor belongs to exactly one run, even on a wrap boundary.
        if (isPoint) break;
      }
    }
  }

  return { rects, pageCount: paginated.pages.length };
}

export function hitTestChange(layout: OverlayLayout, x: number, y: number, pageIndex?: number): string | null {
  return layout.rects.find((rect) =>
    (pageIndex === undefined || rect.pageIndex === pageIndex) &&
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height,
  )?.changeId ?? null;
}

export function nextChange(changes: readonly OverlayChange[], currentId: string | null): OverlayChange | null {
  if (!changes.length) return null;
  const current = currentId ? changes.findIndex((change) => change.id === currentId) : -1;
  return changes[(current + 1) % changes.length] ?? null;
}

/**
 * Paints to an independent canvas. `scale` is intentionally explicit so the
 * host can use its current editor zoom without inspecting private editor state.
 */
export function paintOverlay(
  ctx: CanvasRenderingContext2D,
  layout: OverlayLayout,
  changes: readonly OverlayChange[],
  scale = 1,
): void {
  const byId = new Map(changes.map((change) => [change.id, change]));
  ctx.save();
  ctx.scale(scale, scale);
  ctx.font = "12px Arial";
  ctx.textBaseline = "alphabetic";
  const labeled = new Set<string>();
  for (const rect of layout.rects) {
    const change = byId.get(rect.changeId);
    if (!change) continue;
    const color = COLORS[rect.kind];
    ctx.fillStyle = `${color}24`;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = color;
    if (rect.kind === "delete") {
      const strikeY = rect.y + rect.height / 2;
      ctx.beginPath();
      ctx.moveTo(rect.x, strikeY);
      ctx.lineTo(rect.x + rect.width, strikeY);
      ctx.stroke();
    } else if (rect.kind === "insert") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y);
      ctx.lineTo(rect.x, rect.y + rect.height);
      ctx.stroke();
      ctx.fillText(rect.text, rect.x + 3, Math.max(12, rect.y - 3));
    } else {
      if (!labeled.has(change.id)) {
        ctx.fillStyle = color;
        ctx.fillText(change.label, rect.x, Math.max(12, rect.y - 3));
        labeled.add(change.id);
      }
    }
  }
  ctx.restore();
}

export function fixture(): { document: Document; changes: OverlayChange[] } {
  const wrapped = "This deliberately long base paragraph wraps across several measured lines so a deletion span crosses run and line boundaries. ";
  const style = {
    alignment: "left" as const,
    lineHeight: 1.5,
    marginTop: 0,
    marginBottom: 8,
    textIndent: 0,
    marginLeft: 0,
  };
  return {
    document: {
      blocks: [
        { id: "intro", type: "paragraph", inlines: [{ text: `${wrapped}${wrapped}`, style: {} }], style },
        { id: "body", type: "paragraph", inlines: [{ text: `${wrapped}${wrapped}${wrapped}`, style: {} }], style },
        { id: "break", type: "page-break", inlines: [], style },
        { id: "second-page", type: "paragraph", inlines: [{ text: "Second-page baseline content retains canonical text.", style: {} }], style },
      ],
    },
    changes: [
      { id: "delete-wrap", kind: "delete", blockId: "intro", start: 18, end: 138, label: "Delete wording" },
      { id: "insert-after-delete", kind: "insert", blockId: "intro", start: 138, end: 138, text: " concise replacement", label: "Insert wording" },
      { id: "delete-body", kind: "delete", blockId: "body", start: 145, end: 205, label: "Delete repeated clause" },
      { id: "format-body", kind: "format", blockId: "body", start: 8, end: 40, label: "Format: emphasis" },
      { id: "move-page-two", kind: "move", blockId: "second-page", start: 0, end: 12, label: "Move from introduction" },
      { id: "insert-page-two", kind: "insert", blockId: "second-page", start: 12, end: 12, text: " revised", label: "Insert on page two" },
    ],
  };
}
