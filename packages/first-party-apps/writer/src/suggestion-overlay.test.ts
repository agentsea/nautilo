import { expect, test } from "bun:test";
import type { Document, DocumentLayout, LayoutLine, LayoutRun, PaginatedLayout } from "@nautilo/office-docs/node";
import {
  activeChangeAfterProposalTransition, adjacentChangeId, computeOverlayLayout, hitTestOverlay,
  observeOverlayResize, overlayChangesForSuggestion, paintSuggestionOverlay, type OverlayPublicApi,
} from "./suggestion-overlay";
import type { StructuralChange } from "./structural-diff";

const base: Document = {
  blocks: [
    { id: "first", type: "paragraph", inlines: [{ text: "A deliberately long paragraph keeps wrapping across several measured public layout runs.", style: {} }] },
    { id: "second", type: "paragraph", inlines: [{ text: "Second page base content.", style: {} }] },
  ],
};
const proposed: Document = {
  blocks: [
    { id: "first", type: "heading", inlines: [{ text: "A deliberately improved paragraph keeps wrapping across several measured public layout runs.", style: {} }] },
    { id: "inserted", type: "paragraph", inlines: [{ text: "A new body block.", style: {} }] },
    { id: "second", type: "paragraph", inlines: [{ text: "Second page base content.", style: {} }] },
  ],
};
const changes: StructuralChange[] = [
  { id: "delete", kind: "inline-delete", blockId: "first", start: 5, end: 55, before: "deliberately long paragraph keeps wrapping across several", after: "", operationIndexes: [0] },
  { id: "insert", kind: "inline-insert", blockId: "first", start: 14, end: 14, before: "", after: "improved ", operationIndexes: [0] },
  { id: "format", kind: "block-type", blockId: "first", before: { type: "paragraph" }, after: { type: "heading" }, operationIndexes: [1] },
  { id: "move", kind: "move", blockId: "second", from: 1, to: 0, operationIndexes: [2] },
  { id: "block-insert", kind: "block-insert", blockId: "inserted", index: 1, operationIndexes: [3] },
];

function layoutFor(document: Document, wrapAt: number): { layout: DocumentLayout; paginated: PaginatedLayout } {
  const blocks = document.blocks.map((block, blockIndex) => {
    const text = block.inlines.map((inline) => inline.text).join("");
    const lines: LayoutLine[] = [];
    for (let start = 0; start < text.length; start += wrapAt) {
      const runText = text.slice(start, start + wrapAt);
      const run: LayoutRun = {
        inline: block.inlines[0]!, text: runText, x: 0, width: runText.length * 7,
        inlineIndex: 0, charStart: start, charEnd: start + runText.length,
        charOffsets: Array.from({ length: runText.length }, (_, index) => (index + 1) * 7),
      };
      lines.push({ runs: [run], y: lines.length * 20, height: 20, width: run.width });
    }
    return { block, x: 0, y: blockIndex * 100, width: wrapAt * 7, height: Math.max(20, lines.length * 20), lines };
  });
  const layout = { blocks, totalHeight: blocks.length * 100, blockParentMap: new Map() } as DocumentLayout;
  const pages = [0, 1].map((pageIndex) => ({
    pageIndex, width: 600, height: 800,
    lines: blocks.flatMap((block, blockIndex) => (blockIndex === 1) === (pageIndex === 1)
      ? block.lines.map((line, lineIndex) => ({ blockIndex, lineIndex, line, x: 40, y: 60 + lineIndex * 20, pageIndex: pageIndex + 1 }))
      : []),
  }));
  return { layout, paginated: { pages, pageSetup: {} } as PaginatedLayout };
}

function publicApi(wrapAt: number): OverlayPublicApi {
  return {
    measureText: (text) => text.length * 7,
    computeLayout: (document) => layoutFor(document, wrapAt).layout,
    paginate: (layout, document) => layoutFor(document, wrapAt).paginated,
    pageX: () => 25,
    pageY: (_layout, page) => page * 900,
    totalHeight: () => 1700,
    scale: (width) => width / 1000,
    pageWidth: () => 1000,
    contentWidth: () => 500,
  };
}

test("renders wrapped deletion spans and synthetic inserts without changing canonical documents", () => {
  const before = JSON.stringify(base);
  const computed = computeOverlayLayout(publicApi(18), base, proposed, changes, 500);
  const deleted = computed.layout.rects.filter((rect) => rect.changeId === "delete");
  const inserted = computed.layout.rects.find((rect) => rect.changeId === "insert");

  expect(deleted.length).toBeGreaterThan(1);
  expect(new Set(deleted.map((rect) => rect.y)).size).toBeGreaterThan(1);
  expect(inserted?.text).toBe("improved ");
  expect(computed.layout.pageCount).toBe(2);
  expect(JSON.stringify(base)).toBe(before);
});

test("keeps move source/destination identity and format labels non-color semantic", () => {
  const overlayChanges = overlayChangesForSuggestion(base, proposed, changes);
  const move = overlayChanges.filter((change) => change.id === "move");
  expect(move.map((change) => change.moveRole).sort()).toEqual(["destination", "source"]);
  expect(overlayChanges.find((change) => change.id === "format")?.label).toBe("Block type changed");
  expect(overlayChanges.find((change) => change.id === "block-insert")?.text).toBe("A new body block.");
});

test("hit testing and cyclic navigation are stable across responsive scale changes", () => {
  const narrow = computeOverlayLayout(publicApi(14), base, proposed, changes, 500);
  const wide = computeOverlayLayout(publicApi(40), base, proposed, changes, 900);
  const rect = narrow.layout.rects.find((candidate) => candidate.changeId === "delete")!;

  expect(narrow.scale).toBe(0.5);
  expect(wide.scale).toBe(0.9);
  expect(narrow.layout.rects.length).toBeGreaterThan(wide.layout.rects.length);
  expect(hitTestOverlay(narrow.layout, rect.x + 1, rect.y + 1)).toBe("delete");
  expect(adjacentChangeId(narrow.changes, "format", 1)).toBe("move");
  expect(adjacentChangeId(narrow.changes, "delete", -1)).toBe("block-insert");
});

test("paints insertion text in an offset callout with background and connector", () => {
  const computed = computeOverlayLayout(publicApi(18), base, proposed, changes, 500);
  const insertion = computed.layout.rects.find((rect) => rect.changeId === "insert")!;
  const calls: Array<{ name: string; args: number[] | [string, number, number] }> = [];
  const context = {
    canvas: {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    save: () => calls.push({ name: "save", args: [] }),
    restore: () => calls.push({ name: "restore", args: [] }),
    scale: (x: number, y: number) => calls.push({ name: "scale", args: [x, y] }),
    beginPath: () => calls.push({ name: "beginPath", args: [] }),
    moveTo: (x: number, y: number) => calls.push({ name: "moveTo", args: [x, y] }),
    lineTo: (x: number, y: number) => calls.push({ name: "lineTo", args: [x, y] }),
    stroke: () => calls.push({ name: "stroke", args: [] }),
    fillRect: (x: number, y: number, width: number, height: number) => calls.push({ name: "fillRect", args: [x, y, width, height] }),
    strokeRect: (x: number, y: number, width: number, height: number) => calls.push({ name: "strokeRect", args: [x, y, width, height] }),
    fillText: (text: string, x: number, y: number) => calls.push({ name: "fillText", args: [text, x, y] }),
  } as unknown as CanvasRenderingContext2D;

  paintSuggestionOverlay(context, { ...computed.layout, rects: [insertion] }, null, 1, {
    delete: "#b42318", insert: "#067647", format: "#175cd3", move: "#6d28d9",
  });

  const text = calls.find((call) => call.name === "fillText")!;
  const background = calls.find((call) => call.name === "fillRect")!;
  expect(text.args[0]).toBe("Inserted: improved ");
  expect(text.args[2]).toBeLessThan(insertion.y);
  expect(background.args[1]).toBeLessThan(insertion.y);
  expect(calls.some((call) => call.name === "strokeRect")).toBe(true);
  expect(calls.some((call) => call.name === "moveTo" && call.args[1] === insertion.y + insertion.height / 2)).toBe(true);
  expect(calls.some((call) => call.name === "lineTo")).toBe(true);
});

test("clears active navigation when proposal identity changes or leaves pending", () => {
  expect(activeChangeAfterProposalTransition("change-1", "proposal-a", "proposal-a")).toBe("change-1");
  expect(activeChangeAfterProposalTransition("change-1", "proposal-a", "proposal-b")).toBeNull();
  expect(activeChangeAfterProposalTransition("change-1", "proposal-a", null)).toBeNull();
});

test("disconnects its ResizeObserver during overlay cleanup", () => {
  let disconnected = 0;
  class FakeResizeObserver {
    constructor(_: ResizeObserverCallback) {}
    observe(_: Element) {}
    disconnect() { disconnected += 1; }
  }
  const cleanup = observeOverlayResize({} as Element, () => {}, FakeResizeObserver as unknown as typeof ResizeObserver);
  cleanup();
  expect(disconnected).toBe(1);
});
