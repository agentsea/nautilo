import { describe, expect, test } from "bun:test";
import { buildContextSummary, buildDesignSummary } from "./context-summary";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "./scene-graph";

function docWithFrame(): DesignDocument {
  const base = createEmptyDocument();
  const frame = createNode({
    id: "node-1",
    type: "frame",
    parentId: null,
    name: "Hero",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  const withNode: DesignDocument = {
    ...base,
    nodes: { ...base.nodes, "node-1": frame },
  };
  return appendChild(withNode, null, "node-1", "page-1");
}

describe("context-summary", () => {
  test("buildDesignSummary describes pages, nodes, and frames", () => {
    const doc = docWithFrame();
    const summary = buildDesignSummary(doc, null);
    expect(summary).toContain("1 page(s)");
    expect(summary).toContain('active "Page 1"');
    expect(summary).toContain("1 node(s)");
    expect(summary).toContain("1 top-level frame(s)");
  });

  test("buildContextSummary reports saved state and page metadata", () => {
    const doc = docWithFrame();
    const summary = buildContextSummary({
      document: doc,
      activePageId: "page-1",
      dirty: false,
      lastSavedAt: new Date("2026-07-06T12:00:00.000Z"),
    });
    expect(summary.title).toBe("Page 1");
    expect(summary.summary?.state).toBe("saved at 2026-07-06T12:00:00.000Z");
    expect(summary.summary?.design.topLevelFrames).toEqual([
      { handle: "node:node-1", name: "Hero" },
    ]);
    expect(summary.summary?.design.pageHandle).toBe("page:page-1");
    expect(summary.summary?.openDocumentWorkflow).toContain("inspect-open-design");
  });

  test("buildContextSummary marks dirty state", () => {
    const doc = docWithFrame();
    const summary = buildContextSummary({
      document: doc,
      activePageId: "page-1",
      dirty: true,
    });
    expect(summary.summary?.state).toBe("unsaved changes");
    expect(summary.summary?.dirty).toBe(true);
  });

  test("buildContextSummary includes selection passthrough when ids provided", () => {
    const doc = docWithFrame();
    const summary = buildContextSummary({
      document: doc,
      activePageId: "page-1",
      selectionNodeIds: ["node-1"],
      dirty: false,
    });
    expect(summary.selection?.nodeHandles).toEqual(["node:node-1"]);
    expect(summary.selection?.pageHandle).toBe("page:page-1");
    expect(summary.selection?.label).toContain("1 selected");
  });

  test("preserves every selected object and reports the exact total", () => {
    const doc = docWithFrame();
    const selectionNodeIds = Array.from({ length: 20 }, (_, index) => `node-${index + 1}`);
    const summary = buildContextSummary({
      document: doc,
      activePageId: "page-1",
      selectionNodeIds,
      dirty: false,
    });
    expect(summary.selection?.nodeHandles).toEqual(selectionNodeIds.map((id) => `node:${id}`));
    expect(summary.selection?.nodeCount).toBe(20);
    expect(summary.selection?.label).toContain("20 selected");
  });

  test("preserves every top-level frame and reports the exact total", () => {
    let doc = createEmptyDocument();
    for (let index = 0; index < 15; index += 1) {
      const id = `frame-${index + 1}`;
      const frame = createNode({ id, type: "frame", parentId: null, name: `Frame ${index + 1}` });
      doc = appendChild({ ...doc, nodes: { ...doc.nodes, [id]: frame } }, null, id, "page-1");
    }
    const summary = buildContextSummary({ document: doc, activePageId: "page-1", dirty: false });
    expect(summary.summary?.topLevelFrameCount).toBe(15);
    expect(summary.summary?.design.topLevelFrames).toHaveLength(15);
    expect(summary.summary?.design.topLevelFrames.at(-1)).toEqual({
      handle: "node:frame-15",
      name: "Frame 15",
    });
  });

  test("buildContextSummary uses documentPath basename as title", () => {
    const doc = docWithFrame();
    const summary = buildContextSummary({
      document: doc,
      documentPath: "workspace/Hero.design.html",
      activePageId: "page-1",
      dirty: false,
    });
    expect(summary.title).toBe("Hero.design.html");
    expect(summary.documentPath).toBe("workspace/Hero.design.html");
  });
});
