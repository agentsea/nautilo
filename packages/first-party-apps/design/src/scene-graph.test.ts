import { describe, expect, test } from "bun:test";
import {
  appendChild,
  assertSafeObjectKeys,
  collectiveBounds,
  countNodes,
  createEmptyDocument,
  createNode,
  DESIGN_DOCUMENT_VERSION,
  findNode,
  findPage,
  insertChild,
  isDesignBooleanOp,
  isDesignNodeKind,
  iterateNodes,
  nextNodeId,
  parseDesignDocument,
  removeNode,
  reorderChildren,
  setNodeZOrder,
  topLevelFrames,
  validateDesignDocument,
  type DesignDocument,
} from "./scene-graph";
import type { VectorNetwork } from "./vector";

function sampleNetwork(): VectorNetwork {
  return {
    vertices: [
      { id: "v1", x: 0, y: 0 },
      { id: "v2", x: 10, y: 0 },
      { id: "v3", x: 10, y: 10 },
    ],
    segments: [
      { id: "s1", startVertexId: "v1", endVertexId: "v2" },
      {
        id: "s2",
        startVertexId: "v2",
        endVertexId: "v3",
        startHandle: { x: 12, y: 2 },
        endHandle: { x: 12, y: 8 },
      },
      { id: "s3", startVertexId: "v3", endVertexId: "v1" },
    ],
    regions: [{ id: "r1", vertexIds: ["v1", "v2", "v3"], fill: "#f00" }],
  };
}

function docWithTwoNodes(): DesignDocument {
  const base = createEmptyDocument();
  const a = createNode({ id: "node-1", type: "frame", parentId: null, name: "A", x: 10, y: 20, width: 100, height: 80 });
  const b = createNode({ id: "node-2", type: "rectangle", parentId: "node-1", name: "B", x: 5, y: 5, width: 40, height: 40 });
  const withNodes: DesignDocument = {
    ...base,
    nodes: { "node-1": a, "node-2": b },
  };
  const withFrame = appendChild(withNodes, null, "node-1", "page-1");
  return appendChild(withFrame, "node-1", "node-2");
}

describe("scene-graph", () => {
  test("createEmptyDocument has one page and no nodes", () => {
    const doc = createEmptyDocument();
    expect(doc.version).toBe(DESIGN_DOCUMENT_VERSION);
    expect(doc.pages).toEqual([{ id: "page-1", name: "Page 1", children: [] }]);
    expect(countNodes(doc)).toBe(0);
  });

  test("createNode applies defaults per type and only sets provided optional fields", () => {
    const node = createNode({ id: "n", type: "frame", parentId: null });
    expect(node.name).toBe("Frame");
    expect(node.width).toBe(400);
    expect(node.height).toBe(300);
    expect(node.childIds).toEqual([]);
    expect("rotation" in node).toBe(false);
    const rotated = createNode({ id: "n", type: "rectangle", parentId: null, rotation: 45 });
    expect(rotated.rotation).toBe(45);
  });

  test("appendChild appends to page when parentId is null and to parent otherwise", () => {
    const doc = docWithTwoNodes();
    const page = findPage(doc, "page-1")!;
    expect(page.children).toEqual(["node-1"]);
    const parent = findNode(doc, "node-1")!;
    expect(parent.childIds).toEqual(["node-2"]);
  });

  test("removeNode removes the subtree and detaches from parent", () => {
    const doc = docWithTwoNodes();
    const next = removeNode(doc, "node-1");
    expect(findNode(next, "node-1")).toBeNull();
    expect(findNode(next, "node-2")).toBeNull();
    const page = findPage(next, "page-1")!;
    expect(page.children).toEqual([]);
  });

  test("insertChild inserts at the requested index", () => {
    const base = createEmptyDocument();
    const withA = appendChild(
      { ...base, nodes: { ...base.nodes, "node-1": createNode({ id: "node-1", type: "frame", parentId: null }) } },
      null,
      "node-1",
      "page-1",
    );
    const withB = appendChild(
      { ...withA, nodes: { ...withA.nodes, "node-2": createNode({ id: "node-2", type: "frame", parentId: null }) } },
      null,
      "node-2",
      "page-1",
    );
    const reordered = insertChild(withB, null, "node-2", 0, "page-1");
    expect(findPage(reordered, "page-1")!.children).toEqual(["node-2", "node-1"]);
  });

  test("reorderChildren requires an exact set match", () => {
    const doc = docWithTwoNodes();
    const ok = reorderChildren(doc, "node-1", ["node-2"]);
    expect(findNode(ok, "node-1")!.childIds).toEqual(["node-2"]);
    expect(() => reorderChildren(doc, "node-1", ["missing"])).toThrow();
  });

  test("setNodeZOrder moves a node within its parent's childIds", () => {
    const base = createEmptyDocument();
    const doc = ["node-a", "node-b", "node-c"].reduce(
      (acc, id) =>
        appendChild(
          {
            ...acc,
            nodes: {
              ...acc.nodes,
              [id]: createNode({ id, type: "frame", parentId: null }),
            },
          },
          null,
          id,
          "page-1",
        ),
      base,
    );
    const moved = setNodeZOrder(doc, "node-a", 2);
    expect(findPage(moved, "page-1")!.children).toEqual(["node-b", "node-c", "node-a"]);
  });

  test("nextNodeId scans existing numeric suffixes deterministically", () => {
    const doc = docWithTwoNodes();
    expect(nextNodeId(doc)).toBe("node-3");
    const withNamed: DesignDocument = {
      ...doc,
      nodes: { ...doc.nodes, "frame-7": createNode({ id: "frame-7", type: "frame", parentId: null }) },
    };
    expect(nextNodeId(withNamed, "frame")).toBe("frame-8");
  });

  test("collectiveBounds returns the union of node bounds", () => {
    const doc = docWithTwoNodes();
    const bounds = collectiveBounds(doc, ["node-1"])!;
    expect(bounds.minX).toBe(10);
    expect(bounds.minY).toBe(20);
    expect(bounds.maxX).toBe(110);
    expect(bounds.maxY).toBe(100);
  });

  test("iterateNodes walks children in pre-order", () => {
    const doc = docWithTwoNodes();
    const ids = Array.from(iterateNodes(doc, ["node-1"])).map((n) => n.id);
    expect(ids).toEqual(["node-1", "node-2"]);
  });

  test("topLevelFrames returns only top-level frames on a page", () => {
    const doc = docWithTwoNodes();
    const frames = topLevelFrames(doc, "page-1");
    expect(frames.map((f) => f.id)).toEqual(["node-1"]);
  });

  test("isDesignNodeKind narrows known kinds", () => {
    expect(isDesignNodeKind("frame")).toBe(true);
    expect(isDesignNodeKind("vector")).toBe(true);
    expect(isDesignNodeKind("blob")).toBe(false);
  });

  test("assertSafeObjectKeys rejects prototype-pollution keys", () => {
    expect(assertSafeObjectKeys({ constructor: 1 }, "x")).toContain("Unsafe key");
    expect(assertSafeObjectKeys({ ok: true }, "x")).toBeNull();
  });

  test("parseDesignDocument round-trips a validated document", () => {
    const doc = docWithTwoNodes();
    const raw = JSON.stringify(doc);
    const parsed = parseDesignDocument(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.nodes["node-1"]!.name).toBe("A");
  });

  test("validateDesignDocument rejects prototype-pollution keys", () => {
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "p", name: "P", children: [] }],
        nodes: { n: { __proto__: {} } },
      }),
    ).toThrow();
  });

  test("isDesignBooleanOp narrows the four boolean ops", () => {
    expect(isDesignBooleanOp("union")).toBe(true);
    expect(isDesignBooleanOp("subtract")).toBe(true);
    expect(isDesignBooleanOp("intersect")).toBe(true);
    expect(isDesignBooleanOp("exclude")).toBe(true);
    expect(isDesignBooleanOp("xor")).toBe(false);
    expect(isDesignBooleanOp(1)).toBe(false);
  });

  test("createNode threads vectorNetwork and booleanOp only when provided", () => {
    const plain = createNode({ id: "n", type: "vector", parentId: null });
    expect("vectorNetwork" in plain).toBe(false);
    expect("booleanOp" in plain).toBe(false);
    const vec = createNode({
      id: "n",
      type: "vector",
      parentId: null,
      vectorNetwork: sampleNetwork(),
    });
    expect(vec.vectorNetwork?.vertices.length).toBe(3);
    const bool = createNode({
      id: "n",
      type: "group",
      parentId: null,
      booleanOp: "subtract",
    });
    expect(bool.type).toBe("group");
    expect(bool.booleanOp).toBe("subtract");
  });

  test("validateNode round-trips vectorNetwork, booleanOp and rich strokes", () => {
    const node = createNode({
      id: "node-1",
      type: "group",
      parentId: null,
      booleanOp: "exclude",
      vectorNetwork: sampleNetwork(),
      stroke: { color: "#000", width: 2, cap: "round", join: "bevel", dash: [4, 2] },
    });
    const doc: DesignDocument = {
      version: DESIGN_DOCUMENT_VERSION,
      pages: [{ id: "page-1", name: "P", children: ["node-1"] }],
      nodes: { "node-1": node },
    };
    const validated = validateDesignDocument(JSON.parse(JSON.stringify(doc)));
    const out = validated.nodes["node-1"]!;
    expect(out.booleanOp).toBe("exclude");
    expect(out.vectorNetwork?.segments[1]!.startHandle).toEqual({ x: 12, y: 2 });
    expect(out.vectorNetwork?.regions[0]!.fill).toBe("#f00");
    expect(out.stroke).toEqual({ color: "#000", width: 2, cap: "round", join: "bevel", dash: [4, 2] });
  });

  test("validateDesignDocument rejects an unknown booleanOp", () => {
    const node = { ...createNode({ id: "node-1", type: "group", parentId: null }), booleanOp: "xor" };
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "page-1", name: "P", children: ["node-1"] }],
        nodes: { "node-1": node },
      }),
    ).toThrow();
  });

  test("validateDesignDocument rejects non-finite vector coords and negative dash", () => {
    const badVec = {
      ...createNode({ id: "node-1", type: "vector", parentId: null }),
      vectorNetwork: { vertices: [{ id: "v1", x: Number.POSITIVE_INFINITY, y: 0 }], segments: [], regions: [] },
    };
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "page-1", name: "P", children: ["node-1"] }],
        nodes: { "node-1": badVec },
      }),
    ).toThrow();
    const badDash = {
      ...createNode({ id: "node-1", type: "rectangle", parentId: null }),
      stroke: { color: "#000", width: 1, dash: [1, -2] },
    };
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "page-1", name: "P", children: ["node-1"] }],
        nodes: { "node-1": badDash },
      }),
    ).toThrow();
  });

  test("validateVectorNetwork rejects prototype-pollution keys inside the network", () => {
    const node = createNode({ id: "node-1", type: "vector", parentId: null });
    const raw = JSON.stringify({
      version: DESIGN_DOCUMENT_VERSION,
      pages: [{ id: "page-1", name: "P", children: ["node-1"] }],
      nodes: { "node-1": { ...node, vectorNetwork: { vertices: [], segments: [], regions: [] } } },
    }).replace(
      '"regions":[]}',
      '"regions":[],"__proto__":{"polluted":true}}',
    );
    expect(() => validateDesignDocument(JSON.parse(raw))).toThrow();
  });

  test("validateDesignDocument rejects dangling child references", () => {
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "p", name: "P", children: ["missing"] }],
        nodes: {},
      }),
    ).toThrow();
  });

  test("validateDesignDocument rejects non-finite scalar values and negative dimensions", () => {
    const source = docWithTwoNodes();
    const cases: Array<[string, unknown]> = [
      ["opacity", Number.NaN],
      ["radius", Number.POSITIVE_INFINITY],
      ["fontSize", Number.NaN],
      ["fontWeight", Number.NEGATIVE_INFINITY],
      ["width", -1],
      ["height", -1],
    ];
    for (const [field, value] of cases) {
      expect(() =>
        validateDesignDocument({
          ...source,
          nodes: {
            ...source.nodes,
            "node-1": { ...source.nodes["node-1"]!, [field]: value },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      validateDesignDocument({
        ...source,
        nodes: {
          ...source.nodes,
          "node-1": {
            ...source.nodes["node-1"]!,
            fills: [{ kind: "solid", color: "#000", opacity: Number.NaN }],
          },
        },
      }),
    ).toThrow();
  });

  test("validateDesignDocument clones page and node child arrays", () => {
    const source = docWithTwoNodes();
    const validated = validateDesignDocument(source);

    source.pages[0]!.children.push("changed-after-validation");
    source.nodes["node-1"]!.childIds.push("changed-after-validation");

    expect(validated.pages[0]!.children).toEqual(["node-1"]);
    expect(validated.nodes["node-1"]!.childIds).toEqual(["node-2"]);
  });

  test("validateDesignDocument rejects malformed clipboard topology", () => {
    const root = createNode({ id: "root", type: "frame", parentId: null });

    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [
          { id: "page", name: "One", children: ["root"] },
          { id: "page", name: "Two", children: [] },
        ],
        nodes: { root },
      }),
    ).toThrow();

    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [
          { id: "page-1", name: "One", children: ["root"] },
          { id: "page-2", name: "Two", children: ["root"] },
        ],
        nodes: { root },
      }),
    ).toThrow();

    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "page", name: "P", children: [] }],
        nodes: { root },
      }),
    ).toThrow();

    const cycleA = { ...createNode({ id: "a", type: "group", parentId: "b" }), childIds: ["b"] };
    const cycleB = { ...createNode({ id: "b", type: "group", parentId: "a" }), childIds: ["a"] };
    expect(() =>
      validateDesignDocument({
        version: DESIGN_DOCUMENT_VERSION,
        pages: [{ id: "page", name: "P", children: [] }],
        nodes: { a: cycleA, b: cycleB },
      }),
    ).toThrow();
  });
});
