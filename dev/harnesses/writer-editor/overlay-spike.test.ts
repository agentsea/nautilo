import { expect, test } from "bun:test";
import type {
  Document,
  DocumentLayout,
  LayoutLine,
  LayoutRun,
  PaginatedLayout,
} from "@nautilo/office-docs/node";
import {
  fixture,
  geometryForChanges,
  hitTestChange,
  nextChange,
} from "./overlay-spike";

function publicLayoutFixture(document: Document, wrapAt: number) {
  const layoutBlocks = document.blocks.map((block, blockIndex) => {
    const text = block.inlines.map((inline) => inline.text).join("");
    const lines: LayoutLine[] = [];
    for (let start = 0; start < text.length; start += wrapAt) {
      const runText = text.slice(start, start + wrapAt);
      const run: LayoutRun = {
        inline: block.inlines[0]!,
        text: runText,
        x: 0,
        width: runText.length * 7,
        inlineIndex: 0,
        charStart: start,
        charEnd: start + runText.length,
        charOffsets: Array.from({ length: runText.length }, (_, index) => (index + 1) * 7),
      };
      lines.push({ runs: [run], y: lines.length * 20, height: 20, width: run.width });
    }
    return {
      block,
      x: 0,
      y: blockIndex * 100,
      width: wrapAt * 7,
      height: Math.max(20, lines.length * 20),
      lines,
    };
  });
  const layout = {
    blocks: layoutBlocks,
    totalHeight: layoutBlocks.length * 100,
    blockParentMap: new Map(),
  } as DocumentLayout;
  const pages = [0, 1].map((pageIndex) => ({
    pageIndex,
    width: 600,
    height: 900,
    lines: layoutBlocks.flatMap((block, blockIndex) => {
      const onSecondPage = document.blocks[blockIndex]?.id === "second-page";
      if ((pageIndex === 1) !== onSecondPage) return [];
      return block.lines.map((line, lineIndex) => ({
        blockIndex,
        lineIndex,
        line,
        x: 40,
        y: 60 + lineIndex * 20,
        pageIndex: pageIndex + 1,
      }));
    }),
  }));
  return {
    layout,
    paginated: { pages, pageSetup: document.pageSetup! } as PaginatedLayout,
  };
}

function geometry(document: Document, wrapAt: number) {
  const { changes } = fixture();
  const { layout, paginated } = publicLayoutFixture(document, wrapAt);
  return geometryForChanges(
    document,
    changes,
    layout,
    paginated,
    25,
    (pageIndex) => pageIndex * 1000,
    (text) => text.length * 7,
  );
}

test("splits a wrapped deletion into stable public run geometry", () => {
  const { document, changes } = fixture();
  const baseline = JSON.stringify(document);
  const { layout: publicLayout, paginated } = publicLayoutFixture(document, 30);
  const layout = geometryForChanges(document, changes, publicLayout, paginated, 25, (page) => page * 1000, (text) => text.length * 7);
  const deletion = layout.rects.filter((rect) => rect.changeId === "delete-wrap");

  expect(deletion.length).toBeGreaterThan(1);
  expect(new Set(deletion.map((rect) => rect.y)).size).toBeGreaterThan(1);
  expect(deletion.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
  expect(JSON.stringify(document)).toBe(baseline);
});

test("keeps canonical fixture immutable across resize and zoom geometry", () => {
  const { document } = fixture();
  const baseline = JSON.stringify(document);
  const narrow = geometry(document, 30);
  const wide = geometry(document, 70);

  expect(narrow.pageCount).toBeGreaterThanOrEqual(2);
  expect(wide.pageCount).toBeGreaterThanOrEqual(2);
  expect(narrow.rects.length).toBeGreaterThan(wide.rects.length);
  expect(JSON.stringify(document)).toBe(baseline);
});

test("exposes hit testing and cyclic navigation metadata", () => {
  const { document, changes } = fixture();
  const layout = geometry(document, 30);
  const rect = layout.rects.find((candidate) => candidate.changeId === "format-body");
  expect(rect).toBeDefined();
  expect(hitTestChange(layout, rect!.x + 1, rect!.y + 1, rect!.pageIndex)).toBe("format-body");
  expect(nextChange(changes, "format-body")?.id).toBe("move-page-two");
  expect(nextChange(changes, "move-page-two")?.id).toBe("insert-page-two");
  expect(nextChange(changes, "insert-page-two")?.id).toBe("delete-wrap");
});
