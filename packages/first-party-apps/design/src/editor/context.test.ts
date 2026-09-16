import { describe, expect, test } from "bun:test";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "../scene-graph";
import type { NautiloAppBridge } from "../bridge";
import { buildContext, publishContext } from "./context";

function docWithFrame(): DesignDocument {
  const base = createEmptyDocument();
  const frame = createNode({ id: "node-1", type: "frame", parentId: null, name: "Hero" });
  const withNode: DesignDocument = { ...base, nodes: { ...base.nodes, "node-1": frame } };
  return appendChild(withNode, null, "node-1", "page-1");
}

describe("buildContext", () => {
  test("summarizes document, page, and dirty state", () => {
    const summary = buildContext({
      document: docWithFrame(),
      activePageId: "page-1",
      selectionNodeIds: [],
      dirty: true,
    });
    expect(summary.summary?.dirty).toBe(true);
    expect(summary.summary?.design.topLevelFrames).toEqual([
      { handle: "node:node-1", name: "Hero" },
    ]);
  });

  test("passes the selection through to the summary", () => {
    const summary = buildContext({
      document: docWithFrame(),
      activePageId: "page-1",
      selectionNodeIds: ["node-1"],
      dirty: false,
      documentPath: "workspace/Hero.design.html",
    });
    expect(summary.selection?.nodeHandles).toEqual(["node:node-1"]);
    expect(summary.title).toBe("Hero.design.html");
  });

  test("passes complete large selections through to the summary", () => {
    const selectionNodeIds = Array.from({ length: 20 }, (_, index) => `node-${index + 1}`);
    const summary = buildContext({
      document: docWithFrame(),
      activePageId: "page-1",
      selectionNodeIds,
      dirty: false,
    });
    expect(summary.selection?.nodeHandles).toEqual(selectionNodeIds.map((id) => `node:${id}`));
    expect(summary.selection?.nodeCount).toBe(20);
  });
});

describe("publishContext", () => {
  test("pushes the built summary through the bridge", () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = {
      document: {
        read: async () => ({ content: "", baseSha256: null, baseRevision: null }),
        write: async () => ({ kind: "saved" as const }),
      },
      context: { set: (summary: Record<string, unknown>) => calls.push(summary) },
    } satisfies NautiloAppBridge;

    const summary = publishContext(bridge, {
      document: docWithFrame(),
      activePageId: "page-1",
      selectionNodeIds: ["node-1"],
      dirty: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(summary as unknown as Record<string, unknown>);
  });

  test("is a no-op when the bridge is null", () => {
    const summary = publishContext(null, {
      document: docWithFrame(),
      activePageId: "page-1",
      selectionNodeIds: [],
      dirty: false,
    });
    expect(summary.summary?.nodeCount).toBe(1);
  });
});
