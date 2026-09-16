import { describe, expect, test } from "bun:test";
import { renderSceneSvg } from "../design-document";
import { appendChild, createEmptyDocument, createNode } from "../scene-graph";
import { pathDataFromVectorNetwork } from "../vector";
import { nodeContainsPoint } from "./selection";
import {
  buildPrimitiveFromDrag,
  COMMON_SHAPE_TOOLS,
  DEFAULT_PRIMITIVE_SIZE,
  inferVectorPrimitive,
  primitiveDisplayName,
} from "./primitives";

describe("vector primitive drag builders", () => {
  test("ellipse is a closed cubic vector that fills its exact drag box", () => {
    const ellipse = buildPrimitiveFromDrag("ellipse", { x: 10, y: 20 }, { x: 110, y: 80 });
    expect(ellipse).toMatchObject({ x: 10, y: 20, width: 100, height: 60 });
    expect(ellipse.network.regions).toHaveLength(1);
    expect(ellipse.network.segments.every((segment) => segment.startHandle && segment.endHandle)).toBe(true);
    expect(pathDataFromVectorNetwork(ellipse.network)).toContain("C");
    expect(pathDataFromVectorNetwork(ellipse.network)).toEndWith("Z");
  });

  test("line preserves drag direction and remains hittable through vector tolerance", () => {
    const line = buildPrimitiveFromDrag("line", { x: 100, y: 20 }, { x: 20, y: 80 });
    expect(line).toMatchObject({ x: 20, y: 20, width: 80, height: 60 });
    expect(line.network.regions).toEqual([]);
    expect(line.network.vertices).toEqual([
      { id: "line-v0", x: 80, y: 0 },
      { id: "line-v1", x: 0, y: 60 },
    ]);
    const node = createNode({
      id: "line", type: "vector", parentId: null,
      x: line.x, y: line.y, width: line.width, height: line.height, vectorNetwork: line.network,
    });
    expect(nodeContainsPoint(node, { x: 60, y: 50 }, 2)).toBe(true);
    expect(nodeContainsPoint(node, { x: 60, y: 20 }, 2)).toBe(false);
  });

  test("the legacy polygon tool remains a deterministic triangle", () => {
    const polygon = buildPrimitiveFromDrag("polygon", { x: 5, y: 7 }, { x: 105, y: 107 });
    expect(polygon.network.vertices).toHaveLength(3);
    expect(polygon.network.segments).toHaveLength(3);
    expect(polygon.network.regions[0]?.vertexIds).toEqual(["polygon-v0", "polygon-v1", "polygon-v2"]);
    expect(pathDataFromVectorNetwork(polygon.network)).toEndWith("Z");
  });

  test("every common shape is a deterministic, closed, exportable vector network", () => {
    for (const tool of COMMON_SHAPE_TOOLS) {
      const shape = buildPrimitiveFromDrag(tool, { x: 10, y: 20 }, { x: 110, y: 80 });
      const vertexIds = shape.network.vertices.map((vertex) => vertex.id);
      expect(shape).toMatchObject({ x: 10, y: 20, width: 100, height: 60 });
      expect(shape.network.segments).toHaveLength(shape.network.vertices.length);
      expect(shape.network.regions).toEqual([{ id: `${tool}-r0`, vertexIds }]);
      expect(pathDataFromVectorNetwork(shape.network)).toEndWith("Z");

      const node = createNode({
        id: tool, type: "vector", parentId: null,
        x: shape.x, y: shape.y, width: shape.width, height: shape.height,
        vectorNetwork: shape.network, fills: [{ kind: "solid", color: "#123456" }],
      });
      expect(nodeContainsPoint(node, { x: 60, y: 50 }, 2)).toBe(true);
      const doc = appendChild({ ...createEmptyDocument(), nodes: { [tool]: node } }, null, tool, "page-1");
      expect(renderSceneSvg(doc, "page-1")).toContain('fill="#123456"');
      expect(primitiveDisplayName(tool)).not.toBe("");
      expect(inferVectorPrimitive(shape.network, shape.width, shape.height)).toBe(tool);
    }
  });

  test("inspection classification distinguishes ellipse, line, and edited vectors", () => {
    const ellipse = buildPrimitiveFromDrag("ellipse", { x: 0, y: 0 }, { x: 80, y: 40 });
    expect(inferVectorPrimitive(ellipse.network, ellipse.width, ellipse.height)).toBe("ellipse");
    const reverseLine = buildPrimitiveFromDrag("line", { x: 100, y: 10 }, { x: 0, y: 10 });
    expect(inferVectorPrimitive(reverseLine.network, reverseLine.width, reverseLine.height)).toBe("line");
    const diamond = buildPrimitiveFromDrag("diamond", { x: 0, y: 0 }, { x: 60, y: 60 });
    diamond.network.vertices[0]!.x += 1;
    expect(inferVectorPrimitive(diamond.network, diamond.width, diamond.height)).toBeNull();
  });

  test("ellipse vector geometry reaches the same SVG export path", () => {
    const ellipse = buildPrimitiveFromDrag("ellipse", { x: 10, y: 20 }, { x: 110, y: 80 });
    const node = createNode({
      id: "ellipse", type: "vector", parentId: null,
      x: ellipse.x, y: ellipse.y, width: ellipse.width, height: ellipse.height,
      vectorNetwork: ellipse.network, fills: [{ kind: "solid", color: "#123456" }],
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { ellipse: node } }, null, "ellipse", "page-1");
    const svg = renderSceneSvg(doc, "page-1");
    expect(svg).toContain("C");
    expect(svg).toContain('fill="#123456"');
  });

  test("click and near-click drags use the conventional vector default, while real drags keep their bounds", () => {
    const point = buildPrimitiveFromDrag("ellipse", { x: 20, y: 30 }, { x: 20, y: 30 });
    expect(point).toMatchObject({ x: 20, y: 30, width: DEFAULT_PRIMITIVE_SIZE, height: DEFAULT_PRIMITIVE_SIZE });
    const near = buildPrimitiveFromDrag("line", { x: 20, y: 30 }, { x: 22, y: 31 });
    expect(near).toMatchObject({ width: DEFAULT_PRIMITIVE_SIZE, height: DEFAULT_PRIMITIVE_SIZE });
    expect(near.network.vertices).toEqual([{ id: "line-v0", x: 0, y: 0 }, { id: "line-v1", x: 100, y: 100 }]);
    const dragged = buildPrimitiveFromDrag("polygon", { x: 20, y: 30 }, { x: 80, y: 50 });
    expect(dragged).toMatchObject({ x: 20, y: 30, width: 60, height: 20 });
  });
});
