import { describe, expect, test } from "bun:test";
import { createNode } from "./scene-graph";
import {
  DEFAULT_FRAME_FILL,
  DEFAULT_FRAME_STROKE,
  DEFAULT_RECTANGLE_FILL,
  DEFAULT_VECTOR_STROKE,
  nodePaint,
} from "./render-style";

describe("shared render paint semantics", () => {
  test("uses conventional live-visible defaults only when paint is absent", () => {
    expect(nodePaint(createNode({ id: "frame", type: "frame", parentId: null }))).toEqual({
      fill: DEFAULT_FRAME_FILL,
      stroke: DEFAULT_FRAME_STROKE,
    });
    expect(nodePaint(createNode({ id: "rect", type: "rectangle", parentId: null }))).toEqual({
      fill: DEFAULT_RECTANGLE_FILL,
      stroke: undefined,
    });
    expect(nodePaint(createNode({ id: "vector", type: "vector", parentId: null }))).toEqual({
      fill: null,
      stroke: DEFAULT_VECTOR_STROKE,
    });
  });

  test("preserves an explicit empty fills array as intentional no fill", () => {
    expect(nodePaint(createNode({ id: "empty", type: "rectangle", parentId: null, fills: [] }))).toEqual({
      fill: null,
      stroke: undefined,
    });
  });

  test("treats an absent connector stroke as an explicit visible-off state without changing legacy vector defaults", () => {
    const connector = createNode({
      id: "connector",
      type: "vector",
      parentId: null,
      connector: { route: "straight", start: { x: 0, y: 0 }, end: { x: 40, y: 20 } },
    });
    expect(nodePaint(connector)).toEqual({ fill: null, stroke: undefined });
    expect(nodePaint(createNode({ id: "legacy-vector", type: "vector", parentId: null }))).toEqual({
      fill: null,
      stroke: DEFAULT_VECTOR_STROKE,
    });
  });

  test("keeps an explicit stroke Off state invisible despite conventional defaults", () => {
    expect(nodePaint(createNode({
      id: "line-off",
      type: "vector",
      parentId: null,
      strokeDisabled: true,
    }))).toEqual({ fill: null, stroke: undefined });
    expect(nodePaint(createNode({
      id: "frame-off",
      type: "frame",
      parentId: null,
      strokeDisabled: true,
    }))).toEqual({ fill: DEFAULT_FRAME_FILL, stroke: undefined });
  });
});
