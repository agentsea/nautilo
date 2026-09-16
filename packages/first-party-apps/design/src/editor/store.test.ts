import { describe, expect, test } from "bun:test";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "../scene-graph";
import { applyDesignTransaction } from "../transactions";
import { DesignStore, type ChangeReason, type EditorState } from "./store";

function newStore(): DesignStore {
  return new DesignStore(createEmptyDocument(), "page-1");
}

function twoNodeDocument(): DesignDocument {
  const base = createEmptyDocument();
  const human = createNode({ id: "human", type: "rectangle", parentId: null, x: 0, y: 0 });
  const agent = createNode({ id: "agent", type: "rectangle", parentId: null, x: 10, y: 0 });
  return appendChild(
    appendChild({ ...base, nodes: { human, agent } }, null, "human", "page-1"),
    null,
    "agent",
    "page-1",
  );
}

describe("DesignStore selection", () => {
  test("select replaces and toggles against existing nodes", () => {
    const store = newStore();
    const a = store.addNode("rectangle", { x: 0, y: 0 });
    const b = store.addNode("rectangle", { x: 10, y: 10 });
    store.select(a, "replace");
    expect(store.getState().selection).toEqual([a]);
    store.select(b, "toggle");
    expect(store.getState().selection).toEqual([a, b]);
    store.select(a, "toggle");
    expect(store.getState().selection).toEqual([b]);
  });

  test("setSelection filters ids that are not in the document", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    store.setSelection([a, "ghost"]);
    expect(store.getState().selection).toEqual([a]);
  });
});

describe("DesignStore mutations", () => {
  test("addNode creates a node, links it to the page, and selects it", () => {
    const store = newStore();
    const id = store.addNode("frame", { x: 5, y: 6, width: 120, height: 80 });
    const doc = store.getDocument();
    expect(doc.nodes[id]).toMatchObject({ type: "frame", x: 5, y: 6, width: 120, height: 80 });
    expect(doc.pages[0]?.children).toContain(id);
    expect(store.getState().selection).toEqual([id]);
  });

  test("addNode as a child links under the parent, not the page", () => {
    const store = newStore();
    const parent = store.addNode("frame", {});
    const child = store.addNode("rectangle", { parentId: parent });
    expect(store.getDocument().nodes[parent]?.childIds).toContain(child);
    expect(store.getDocument().pages[0]?.children).not.toContain(child);
  });

  test("updateNode merges only provided fields", () => {
    const store = newStore();
    const id = store.addNode("text", { text: "hi" });
    store.updateNode(id, { text: "hello", fontSize: 24, x: 40 });
    const node = store.getDocument().nodes[id]!;
    expect(node.text).toBe("hello");
    expect(node.fontSize).toBe(24);
    expect(node.x).toBe(40);
    // untouched default preserved
    expect(node.type).toBe("text");
  });

  test("deleteNodes removes nodes and prunes selection", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    const b = store.addNode("rectangle", {});
    store.setSelection([a, b]);
    store.deleteNodes([a]);
    expect(store.getDocument().nodes[a]).toBeUndefined();
    expect(store.getState().selection).toEqual([b]);
  });
});

describe("DesignStore multi-node edit", () => {
  test("updateNodes applies a patch to every id in a single undo entry", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    const b = store.addNode("rectangle", {});
    store.updateNodes([a, b], { opacity: 0.5, fills: [{ kind: "solid", color: "#ff0000" }] });
    expect(store.getDocument().nodes[a]?.opacity).toBe(0.5);
    expect(store.getDocument().nodes[b]?.opacity).toBe(0.5);
    expect(store.getDocument().nodes[a]?.fills?.[0]).toEqual({ kind: "solid", color: "#ff0000" });
    // A single undo reverts both edits.
    store.undo();
    expect(store.getDocument().nodes[a]?.opacity).toBeUndefined();
    expect(store.getDocument().nodes[b]?.opacity).toBeUndefined();
  });

  test("updateNodes removes multi-selected strokes through one undoable style transaction", () => {
    const store = newStore();
    const first = store.addNode("rectangle", { stroke: { color: "#000000", width: 2 } });
    const second = store.addNode("rectangle", { stroke: { color: "#000000", width: 2 } });
    store.updateNodes([first, second], { stroke: null });
    expect(store.getDocument().nodes[first]?.stroke).toBeUndefined();
    expect(store.getDocument().nodes[second]?.stroke).toBeUndefined();
    store.undo();
    expect(store.getDocument().nodes[first]?.stroke).toEqual({ color: "#000000", width: 2 });
    expect(store.getDocument().nodes[second]?.stroke).toEqual({ color: "#000000", width: 2 });
  });

  test("updateNodes skips missing ids", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    store.updateNodes([a, "ghost"], { opacity: 0.25 });
    expect(store.getDocument().nodes[a]?.opacity).toBe(0.25);
  });

  test("updateNode remains equivalent to a single-id updateNodes", () => {
    const store = newStore();
    const a = store.addNode("rectangle", { x: 0 });
    store.updateNode(a, { x: 42 });
    expect(store.getDocument().nodes[a]?.x).toBe(42);
  });

  test("updateNodes lowers a mixed durable patch into one undoable kernel commit", () => {
    const store = newStore();
    const id = store.addNode("text", { text: "Before" });
    store.updateNodes([id], { name: "Heading", x: 12, rotation: 30, opacity: 0.5, text: "After" });
    expect(store.getDocument().nodes[id]).toMatchObject({ name: "Heading", x: 12, rotation: 30, opacity: 0.5, text: "After" });
    store.undo();
    expect(store.getDocument().nodes[id]).toMatchObject({ x: 0, text: "Before" });
    expect(store.getDocument().nodes[id]?.rotation).toBeUndefined();
  });

  test("nudgeNodes uses a transform while preserving a single undo step", () => {
    const store = newStore();
    const id = store.addNode("rectangle", { x: 4, y: 8 });
    store.nudgeNodes([id], 10, -2);
    expect(store.getDocument().nodes[id]).toMatchObject({ x: 14, y: 6 });
    store.undo();
    expect(store.getDocument().nodes[id]).toMatchObject({ x: 4, y: 8 });
  });

  test("layout intent delegates to the kernel and rejects an invalid mixed-parent selection", () => {
    const store = newStore();
    const first = store.addNode("rectangle", { x: 0, y: 0, width: 20, height: 20 });
    const second = store.addNode("rectangle", { x: 100, y: 40, width: 20, height: 20 });
    expect(store.alignNodes([first, second], "vertical", "start")).toBe(true);
    expect(store.getDocument().nodes[second]?.y).toBe(0);
    store.undo();
    expect(store.getDocument().nodes[second]?.y).toBe(40);
    const frame = store.addNode("frame", {});
    const child = store.addNode("rectangle", { parentId: frame });
    expect(store.alignNodes([first, child], "horizontal", "start")).toBe(false);
  });
});

describe("DesignStore pages", () => {
  test("addPage appends an empty page and switches to it", () => {
    const store = newStore();
    const id = store.addPage();
    const doc = store.getDocument();
    expect(doc.pages.map((p) => p.id)).toEqual(["page-1", id]);
    expect(doc.pages[1]).toEqual({ id: "page-2", name: "Page 2", children: [] });
    expect(store.getState().activePageId).toBe(id);
    expect(store.getState().selection).toEqual([]);
  });

  test("addPage is undoable and re-clamps the active page", () => {
    const store = newStore();
    store.addPage();
    expect(store.getState().activePageId).toBe("page-2");
    store.undo();
    expect(store.getDocument().pages.map((p) => p.id)).toEqual(["page-1"]);
    // Active page falls back to a surviving page instead of the removed one.
    expect(store.getState().activePageId).toBe("page-1");
    store.redo();
    expect(store.getDocument().pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
    // Redo restores the document; the active page is only re-clamped when it no
    // longer exists, so the still-valid page-1 stays active.
    expect(store.getState().activePageId).toBe("page-1");
  });

  test("addPage accepts an explicit name", () => {
    const store = newStore();
    const id = store.addPage("Cover");
    expect(store.getDocument().pages.find((p) => p.id === id)?.name).toBe("Cover");
  });
});

describe("DesignStore reorderPageChild", () => {
  test("reorders top-level page children and records an undo entry", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    const b = store.addNode("rectangle", {});
    const c = store.addNode("rectangle", {});
    expect(store.getDocument().pages[0]?.children).toEqual([a, b, c]);
    store.reorderPageChild([c, a, b]);
    expect(store.getDocument().pages[0]?.children).toEqual([c, a, b]);
    store.undo();
    expect(store.getDocument().pages[0]?.children).toEqual([a, b, c]);
  });

  test("moves one or more selected objects through the stack in one undoable step", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    const b = store.addNode("rectangle", {});
    const c = store.addNode("rectangle", {});
    const d = store.addNode("rectangle", {});
    expect(store.reorderNodes([b, c], "forward")).toBe(true);
    expect(store.getDocument().pages[0]?.children).toEqual([a, d, b, c]);
    store.undo();
    expect(store.getDocument().pages[0]?.children).toEqual([a, b, c, d]);
    expect(store.reorderNodes([c], "back")).toBe(true);
    expect(store.getDocument().pages[0]?.children).toEqual([c, a, b, d]);
    expect(store.reorderNodes([c], "backward")).toBe(false);
    expect(store.reorderNodes([c], "front")).toBe(true);
    expect(store.getDocument().pages[0]?.children).toEqual([a, b, d, c]);
  });
});

describe("DesignStore undo/redo", () => {
  test("undo restores the prior document; redo reapplies", () => {
    const store = newStore();
    const id = store.addNode("rectangle", { x: 0, y: 0 });
    store.updateNode(id, { x: 100 });
    expect(store.getDocument().nodes[id]?.x).toBe(100);
    store.undo();
    expect(store.getDocument().nodes[id]?.x).toBe(0);
    store.redo();
    expect(store.getDocument().nodes[id]?.x).toBe(100);
  });

  test("undo of a create removes the node", () => {
    const store = newStore();
    const id = store.addNode("rectangle", {});
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.getDocument().nodes[id]).toBeUndefined();
    expect(store.canRedo()).toBe(true);
  });

  test("a new mutation clears the redo stack", () => {
    const store = newStore();
    const id = store.addNode("rectangle", {});
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.addNode("frame", {});
    expect(store.canRedo()).toBe(false);
    void id;
  });

  test("rebases local undo and redo snapshots through a disjoint remote agent edit", () => {
    const store = new DesignStore(twoNodeDocument(), "page-1");
    store.updateNode("human", { x: 30 });
    const incoming = applyDesignTransaction(store.getDocument(), {
      kind: "transform",
      updates: [{ nodeId: "agent", x: 60 }],
    });
    if (!incoming.ok) throw new Error(incoming.error.message);
    store.replaceDocument(incoming.document, { keepSelection: true });

    store.undo();
    expect(store.getDocument().nodes["human"]?.x).toBe(0);
    expect(store.getDocument().nodes["agent"]?.x).toBe(60);
    store.redo();
    expect(store.getDocument().nodes["human"]?.x).toBe(30);
    expect(store.getDocument().nodes["agent"]?.x).toBe(60);
  });

  test("receipt Revert is a kernel mutation without consuming local undo history", () => {
    const beforeAgent = twoNodeDocument();
    const store = new DesignStore(beforeAgent, "page-1");
    store.updateNode("human", { x: 30 });
    const beforeAgentChange = store.getDocument();
    const incoming = applyDesignTransaction(beforeAgentChange, {
      kind: "transform",
      updates: [{ nodeId: "agent", x: 60 }],
    });
    if (!incoming.ok) throw new Error(incoming.error.message);
    store.replaceDocument(incoming.document, { keepSelection: true });
    const reverted = store.applyEphemeralRevert({
      kind: "revert",
      changes: [{
        nodeId: "agent",
        expected: incoming.document.nodes["agent"]!,
        restore: beforeAgentChange.nodes["agent"]!,
      }],
    });
    expect(reverted).toMatchObject({ ok: true, receipt: { outcome: "applied" } });
    expect(store.canUndo()).toBe(true);
    expect(store.getDocument().nodes["human"]?.x).toBe(30);
    expect(store.getDocument().nodes["agent"]?.x).toBe(10);
    store.undo();
    expect(store.getDocument().nodes["human"]?.x).toBe(0);
    expect(store.getDocument().nodes["agent"]?.x).toBe(10);
    store.redo();
    expect(store.getDocument().nodes["human"]?.x).toBe(30);
    expect(store.getDocument().nodes["agent"]?.x).toBe(10);
  });

  test("fences both undo and redo when a same-target remote replacement cannot be rebased", () => {
    const store = new DesignStore(twoNodeDocument(), "page-1");
    store.updateNode("human", { x: 20 });
    store.updateNode("human", { x: 30 });
    store.undo();
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(true);
    const incoming = applyDesignTransaction(store.getDocument(), {
      kind: "transform",
      updates: [{ nodeId: "human", x: 60 }],
    });
    if (!incoming.ok) throw new Error(incoming.error.message);
    store.replaceDocument(incoming.document, { keepSelection: true });

    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    store.undo();
    store.redo();
    expect(store.getDocument().nodes["human"]?.x).toBe(60);
  });

  test("refuses Revert atomically when rebasing local history would overlap it", () => {
    const store = new DesignStore(twoNodeDocument(), "page-1");
    store.updateNode("human", { x: 30 });
    const beforeAgent = store.getDocument();
    const incoming = applyDesignTransaction(beforeAgent, {
      kind: "transform",
      updates: [{ nodeId: "agent", x: 60 }],
    });
    if (!incoming.ok) throw new Error(incoming.error.message);
    store.replaceDocument(incoming.document, { keepSelection: true });
    store.updateNode("agent", { x: 80 });
    store.updateNode("agent", { x: 60 });

    const result = store.applyEphemeralRevert({
      kind: "revert",
      changes: [{
        nodeId: "agent",
        expected: incoming.document.nodes["agent"]!,
        restore: beforeAgent.nodes["agent"]!,
      }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "stale_revert", path: "history" } });
    expect(store.getDocument().nodes["agent"]?.x).toBe(60);
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.getDocument().nodes["agent"]?.x).toBe(80);
  });
});

describe("DesignStore transient interactions", () => {
  test("transient node updates commit a single undo entry on release", () => {
    const store = newStore();
    const id = store.addNode("rectangle", { x: 0, y: 0, width: 50, height: 50 });

    store.beginTransient();
    store.updateTransientNodes(new Map([[id, { x: 10, y: 0, width: 50, height: 50 }]]));
    store.updateTransientNodes(new Map([[id, { x: 30, y: 20, width: 50, height: 50 }]]));
    store.endTransient();

    expect(store.getDocument().nodes[id]).toMatchObject({ x: 30, y: 20 });
    // A single undo reverts the entire drag back to the created position.
    store.undo();
    expect(store.getDocument().nodes[id]).toMatchObject({ x: 0, y: 0 });
    // A second undo removes the created node.
    store.undo();
    expect(store.getDocument().nodes[id]).toBeUndefined();
  });

  test("endTransient with no change records no undo entry", () => {
    const store = newStore();
    store.addNode("rectangle", {});
    const before = store.canUndo();
    store.beginTransient();
    store.endTransient();
    expect(store.canUndo()).toBe(before);
  });
});

describe("DesignStore vector nodes", () => {
  const built = () => ({
    network: {
      vertices: [
        { id: "v0", x: 0, y: 0 },
        { id: "v1", x: 40, y: 0 },
        { id: "v2", x: 40, y: 30 },
      ],
      segments: [
        { id: "s0", startVertexId: "v0", endVertexId: "v1" },
        { id: "s1", startVertexId: "v1", endVertexId: "v2" },
      ],
      regions: [],
    },
    x: 100,
    y: 100,
    width: 40,
    height: 30,
  });

  test("addVectorNode creates through the canonical kernel with one undo step", () => {
    const store = newStore();
    const id = store.addVectorNode(built());
    const node = store.getDocument().nodes[id]!;
    expect(node.type).toBe("vector");
    expect(node.vectorNetwork?.vertices).toHaveLength(3);
    expect(node.stroke).toEqual({ color: "#0f172a", width: 2 });
    expect(store.getState().selection).toEqual([id]);
    expect(store.getDocument().pages[0]?.children).toContain(id);
    store.undo();
    expect(store.getDocument().nodes[id]).toBeUndefined();
  });

  test("resizing a vector node scales its network and a single undo reverts it", () => {
    const store = newStore();
    const id = store.addVectorNode(built());
    store.beginTransient();
    store.updateTransientNodes(new Map([[id, { x: 100, y: 100, width: 80, height: 30 }]]));
    store.endTransient();
    const node = store.getDocument().nodes[id]!;
    expect(node.width).toBe(80);
    // x-coords doubled, y unchanged
    expect(node.vectorNetwork?.vertices[1]).toMatchObject({ x: 80, y: 0 });
    store.undo();
    expect(store.getDocument().nodes[id]?.vectorNetwork?.vertices[1]).toMatchObject({ x: 40, y: 0 });
  });

  test("updateTransientVector commits a single undo entry via begin/endTransient", () => {
    const store = newStore();
    const id = store.addVectorNode(built());
    store.beginTransient();
    const net = store.getDocument().nodes[id]!.vectorNetwork!;
    const moved = { ...net, vertices: net.vertices.map((v) => (v.id === "v2" ? { ...v, x: 60 } : v)) };
    store.updateTransientVector(id, moved, { x: 100, y: 100, width: 60, height: 30 });
    store.endTransient();
    expect(store.getDocument().nodes[id]?.vectorNetwork?.vertices[2]).toMatchObject({ x: 60 });
    store.undo();
    expect(store.getDocument().nodes[id]?.vectorNetwork?.vertices[2]).toMatchObject({ x: 40 });
  });

  test("updateTransientVector refuses invalid geometry through the kernel without emitting", () => {
    const store = newStore();
    const id = store.addVectorNode(built());
    let interactions = 0;
    store.subscribe((reason) => { if (reason === "interaction") interactions++; });
    const before = store.getDocument();
    store.updateTransientVector(id, { vertices: [{ id: "v1", x: Number.NaN, y: 0 }], segments: [], regions: [] }, { x: 0, y: 0, width: 10, height: 10 });
    expect(store.getDocument()).toBe(before);
    expect(interactions).toBe(0);
  });
});

describe("DesignStore groupAsBoolean", () => {
  test("wraps selected nodes in a boolean group, preserving z-order and position", () => {
    const store = newStore();
    const a = store.addNode("rectangle", { x: 0, y: 0, width: 50, height: 50 });
    const b = store.addNode("rectangle", { x: 30, y: 30, width: 50, height: 50 });
    const c = store.addNode("rectangle", { x: 200, y: 0, width: 10, height: 10 });
    const groupId = store.groupAsBoolean([a, b], "subtract");
    expect(groupId).not.toBeNull();
    if (groupId === null) throw new Error("expected a group id");
    const doc = store.getDocument();
    const group = doc.nodes[groupId]!;
    expect(group.type).toBe("group");
    expect(group.booleanOp).toBe("subtract");
    expect(group.name).toBe("Subtract");
    expect(group.childIds).toEqual([a, b]);
    expect(doc.nodes[a]?.parentId).toBe(groupId);
    expect(doc.nodes[b]?.parentId).toBe(groupId);
    // group takes the topmost operand's slot; c (added after) stays on top
    expect(doc.pages[0]?.children).toEqual([groupId, c]);
    // group bounds are the collective bounds of its operands
    expect(group).toMatchObject({ x: 0, y: 0, width: 80, height: 80 });
    expect(store.getState().selection).toEqual([groupId]);
  });

  test("groupAsBoolean is a single undo entry", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    const b = store.addNode("rectangle", {});
    const groupId = store.groupAsBoolean([a, b], "union")!;
    store.undo();
    expect(store.getDocument().nodes[groupId]).toBeUndefined();
    expect(store.getDocument().nodes[a]?.parentId).toBeNull();
    expect(store.getDocument().pages[0]?.children).toEqual([a, b]);
  });

  test("groupAsBoolean returns null for fewer than two nodes or mixed parents", () => {
    const store = newStore();
    const a = store.addNode("rectangle", {});
    expect(store.groupAsBoolean([a], "union")).toBeNull();
    const frame = store.addNode("frame", {});
    const child = store.addNode("rectangle", { parentId: frame });
    // a is top-level, child is parented under frame -> mixed parents
    expect(store.groupAsBoolean([a, child], "union")).toBeNull();
  });
});

describe("DesignStore remote replacement", () => {
  test("replaceDocument swaps the document without an undo entry and clears selection", () => {
    const store = newStore();
    const id = store.addNode("rectangle", {});
    store.setSelection([id]);
    const remote: DesignDocument = createEmptyDocument();
    store.replaceDocument(remote);
    expect(store.getDocument()).toBe(remote);
    expect(store.getState().selection).toEqual([]);
    // remote replacement is not undoable back into the local doc via redo semantics
  });

  test("emits a remote reason on replaceDocument", () => {
    const store = newStore();
    const reasons: ChangeReason[] = [];
    store.subscribe((reason: ChangeReason, _state: EditorState) => reasons.push(reason));
    store.replaceDocument(createEmptyDocument());
    expect(reasons).toContain("remote");
  });
});
