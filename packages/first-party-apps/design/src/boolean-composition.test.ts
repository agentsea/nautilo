import { describe, expect, test } from "bun:test";
import {
  booleanOperandUnsupportedReason,
  buildBooleanComposition,
  buildExactBooleanComposition,
  operandPathData,
  sanitizeId,
} from "./boolean-composition";
import { appendChild, createEmptyDocument, createNode, type DesignBooleanOp, type DesignDocument, type DesignNode } from "./scene-graph";
import { parsePathData, type VectorNetwork } from "./vector";

function boolNode(op: DesignBooleanOp): DesignNode {
  return {
    ...createNode({ id: "node-1", type: "group", parentId: null, booleanOp: op }),
    childIds: ["a", "b"],
  };
}

const OPS = new Map<string, string>([
  ["a", "M 0 0 L 80 0 L 80 80 L 0 80 Z"],
  ["b", "M 40 0 L 120 0 L 120 80 L 40 80 Z"],
]);
const resolve = (id: string): string | null => OPS.get(id) ?? null;

describe("buildBooleanComposition legacy primitive descriptor", () => {
  test("keeps existing primitive callers working", () => {
    expect(buildBooleanComposition(boolNode("union"), resolve)?.fillRule).toBe("nonzero");
    expect(buildBooleanComposition(boolNode("exclude"), resolve)?.fillRule).toBe("evenodd");
    expect(buildBooleanComposition(boolNode("subtract"), resolve)?.maskId).toBe("mask-node-1");
    expect(buildBooleanComposition(boolNode("intersect"), resolve)?.clipIds).toEqual(["clip-node-1-0"]);
  });
});

describe("operandPathData", () => {
  const triangle: VectorNetwork = {
    vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 20, y: 0 }, { id: "c", x: 10, y: 20 }],
    segments: [{ id: "ab", startVertexId: "a", endVertexId: "b" }, { id: "bc", startVertexId: "b", endVertexId: "c" }, { id: "ca", startVertexId: "c", endVertexId: "a" }],
    regions: [{ id: "face", vertexIds: ["a", "b", "c"] }],
  };

  test("emits exact primitive geometry including rotation", () => {
    const rect = createNode({ id: "r", type: "rectangle", parentId: null, width: 100, height: 20, rotation: 90 });
    const commands = parsePathData(operandPathData(rect, 0, 0)!);
    expect(commands).not.toBeNull();
    const corners = commands?.filter((command) => command.kind === "M" || command.kind === "L");
    expect(corners).toHaveLength(4);
    const expected = [[60, -40], [60, 60], [40, 60], [40, -40]];
    corners?.forEach((corner, index) => {
      expect(corner.x).toBeCloseTo(expected[index]![0]!, 12);
      expect(corner.y).toBeCloseTo(expected[index]![1]!, 12);
    });
    const vector = createNode({ id: "v", type: "vector", parentId: null, x: 5, y: 5, width: 20, height: 20, vectorNetwork: triangle });
    expect(operandPathData(vector, 5, 5)).toBe("M 5 5 L 25 5 L 15 25 Z");
  });

  test("preserves rounded corners", () => {
    const rect = createNode({ id: "r", type: "rectangle", parentId: null, width: 80, height: 40, radius: 10 });
    expect(operandPathData(rect, 0, 0)).toContain("C");
  });

  test("preserves independently scaled horizontal and vertical corner radii", () => {
    const rect = createNode({ id: "r", type: "rectangle", parentId: null, width: 80, height: 40, radius: 10, radiusY: 5 });
    const commands = parsePathData(operandPathData(rect, 0, 0)!);
    const corner = commands?.find((command) => command.kind === "C");
    expect(corner?.kind).toBe("C");
    if (corner?.kind !== "C") return;
    const kappa = (4 / 3) * Math.tan(Math.PI / 8);
    expect(corner.c1x).toBeCloseTo(70 + 10 * kappa, 12);
    expect(corner.c2y).toBeCloseTo(5 - 5 * kappa, 12);
    expect(corner.x).toBeCloseTo(80, 12);
    expect(corner.y).toBeCloseTo(5, 12);
  });

  test("rejects invalid and unsupported geometry instead of substituting a box", () => {
    const vector = createNode({ id: "v", type: "vector", parentId: null, vectorPath: "not a path" });
    const text = createNode({ id: "t", type: "text", parentId: null, text: "No" });
    expect(operandPathData(vector, 0, 0)).toBeNull();
    expect(booleanOperandUnsupportedReason(text)).toContain("unsupported text geometry");
  });
});

describe("buildExactBooleanComposition", () => {
  function nestedDocument(): { doc: DesignDocument; outer: DesignNode } {
    let doc = createEmptyDocument();
    const outer = { ...createNode({ id: "outer", type: "group", parentId: null, booleanOp: "subtract" }), childIds: ["inner", "cut"] };
    const inner = { ...createNode({ id: "inner", type: "group", parentId: "outer", booleanOp: "intersect" }), childIds: ["a", "b"] };
    const a = createNode({ id: "a", type: "rectangle", parentId: "inner", x: 0, y: 0, width: 80, height: 50, rotation: 30 });
    const b = createNode({ id: "b", type: "rectangle", parentId: "inner", x: 20, y: 0, width: 80, height: 50 });
    const cut = createNode({ id: "cut", type: "rectangle", parentId: "outer", x: 30, y: 10, width: 20, height: 20 });
    doc = { ...doc, nodes: { outer, inner, a, b, cut } };
    doc = appendChild(doc, null, "outer", "page-1");
    return { doc, outer };
  }

  test("represents nested intersect inside subtract with masks and rotated paths", () => {
    const { doc, outer } = nestedDocument();
    const result = buildExactBooleanComposition(doc, outer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.composition.defs.filter((def) => def.kind === "mask").map((def) => def.id)).toEqual([
      "boolean-inner-intersect-0",
      "boolean-outer-subtract",
    ]);
    const shape = result.composition.defs.find((def) => def.kind === "shape" && def.id === "boolean-shape-a");
    expect(shape?.kind).toBe("shape");
    if (shape?.kind !== "shape" || shape.content.kind !== "path") return;
    const first = parsePathData(shape.content.pathData)?.[0];
    expect(first?.kind).toBe("M");
    if (first?.kind !== "M") return;
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    expect(first.x).toBeCloseTo(40 - 40 * cos + 25 * sin, 12);
    expect(first.y).toBeCloseTo(25 - 40 * sin - 25 * cos, 12);
  });

  test("has no nesting depth cutoff", () => {
    let doc = createEmptyDocument();
    const nodes: Record<string, DesignNode> = {};
    nodes["leaf"] = createNode({ id: "leaf", type: "rectangle", parentId: "b11", width: 10, height: 10 });
    for (let index = 11; index >= 0; index -= 1) {
      const id = `b${index}`;
      const child = index === 11 ? "leaf" : `b${index + 1}`;
      nodes[id] = { ...createNode({ id, type: "group", parentId: index === 0 ? null : `b${index - 1}`, booleanOp: "union" }), childIds: [child] };
    }
    doc = appendChild({ ...doc, nodes }, null, "b0", "page-1");
    expect(buildExactBooleanComposition(doc, nodes["b0"]!).ok).toBe(true);
  });

  test("grows linearly for deeply nested subtraction", () => {
    const build = (depth: number): number => {
      let doc = createEmptyDocument();
      const nodes: Record<string, DesignNode> = {};
      nodes[`leaf-${depth}`] = createNode({ id: `leaf-${depth}`, type: "rectangle", parentId: `b-${depth - 1}`, width: 10, height: 10 });
      for (let index = depth - 1; index >= 0; index -= 1) {
        const id = `b-${index}`;
        const child = index === depth - 1 ? `leaf-${depth}` : `b-${index + 1}`;
        const cutId = `cut-${index}`;
        nodes[cutId] = createNode({ id: cutId, type: "rectangle", parentId: id, x: 2, y: 2, width: 2, height: 2 });
        nodes[id] = { ...createNode({ id, type: "group", parentId: index === 0 ? null : `b-${index - 1}`, booleanOp: "subtract" }), childIds: [child, cutId] };
      }
      doc = appendChild({ ...doc, nodes }, null, "b-0", "page-1");
      const result = buildExactBooleanComposition(doc, nodes["b-0"]!);
      expect(result.ok).toBe(true);
      return JSON.stringify(result).length;
    };
    expect(build(24)).toBeLessThan(build(12) * 3);
  });
});

test("sanitizeId replaces def-unsafe characters", () => {
  expect(sanitizeId("node:1/a b")).toBe("node_u3a_1_u2f_a_u20_b");
  expect(sanitizeId("node:1")).not.toBe(sanitizeId("node_u3a_1"));
});

test("empty and fully hidden Boolean operands produce editable empty geometry", () => {
  const doc = createEmptyDocument();
  const node: DesignNode = { ...boolNode("subtract"), childIds: [] };
  doc.nodes[node.id] = node;
  const empty = buildExactBooleanComposition(doc, node);
  expect(empty).toMatchObject({ ok: true, composition: { body: { kind: "group", children: [] } } });
  const child = createNode({ id: "hidden", type: "rectangle", parentId: node.id, hidden: true });
  doc.nodes[child.id] = child;
  node.childIds.push(child.id);
  expect(buildExactBooleanComposition(doc, node)).toEqual(empty);
});
