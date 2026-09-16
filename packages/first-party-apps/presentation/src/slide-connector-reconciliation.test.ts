import { expect, test } from "bun:test";
import {
  buildElementWorldLookup,
  computeConnectorFrame,
  type Element,
  type SlidesDocument,
} from "../engine/node.js";
import { createSlideDocument } from "./slide-document";
import { reconcileAuthoredConnectors, SlideConnectorReconciliationError } from "./slide-connector-reconciliation";

const frame = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const shape = (id: string, x: number, y: number): Element => ({
  id, type: "shape", frame: frame(x, y, 40, 30), data: { kind: "rect" },
});
const connector = (id: string, start: unknown, end: unknown): Element => ({
  id, type: "connector", frame: frame(9, 8, 7, 6), routing: "straight",
  start, end,
} as Element);

function deck(elements: Element[]): SlidesDocument {
  const document = createSlideDocument();
  document.slides[0].elements = elements;
  return document;
}

test("reconciles free and attached connectors in their rotated scaled parent space", () => {
  const innerConnector = connector(
    "nested-connector",
    { kind: "free", x: 10, y: 15 },
    { kind: "attached", elementId: "nested-target", siteIndex: 1 },
  );
  const inner: Element = {
    id: "inner", type: "group", frame: frame(25, 30, 150, 90, -Math.PI / 7),
    data: { refSize: { w: 75, h: 180 }, children: [shape("nested-target", 70, 90), innerConnector] },
  };
  const group: Element = {
    id: "outer", type: "group", frame: frame(300, 180, 360, 120, Math.PI / 5),
    data: { refSize: { w: 180, h: 240 }, children: [inner] },
  };
  const source = deck([structuredClone(group)]);
  const document = structuredClone(source);
  const currentGroup = document.slides[0].elements[0];
  if (currentGroup.type !== "group") throw new Error("group fixture missing");
  const currentInner = currentGroup.data.children[0];
  if (currentInner.type !== "group") throw new Error("inner group fixture missing");
  const target = currentInner.data.children[0];
  target.frame.x += 25;

  expect(reconcileAuthoredConnectors(source, document)).toEqual([
    "/slides/0/elements/0/data/children/0/data/children/1/frame",
  ]);
  const saved = currentInner.data.children[1];
  if (saved.type !== "connector") throw new Error("connector fixture missing");
  const localLookup = new Map(currentInner.data.children.map((element) => [element.id, element]));
  expect(saved.frame).toEqual(computeConnectorFrame(saved, localLookup));
  expect(saved.frame.x).toBeLessThan(100);
});

test("resolves a top-level connector attached to a shape inside nested rotated groups", () => {
  const nested: Element = {
    id: "outer", type: "group", frame: frame(250, 120, 420, 260, -0.3),
    data: { refSize: { w: 210, h: 130 }, children: [{
      id: "inner", type: "group", frame: frame(30, 20, 140, 80, 0.55),
      data: { refSize: { w: 280, h: 40 }, children: [shape("deep-target", 170, 5)] },
    }] },
  };
  const topConnector = connector(
    "top-connector",
    { kind: "free", x: 40, y: 50 },
    { kind: "attached", elementId: "deep-target", siteIndex: 2 },
  );
  const source = deck([structuredClone(nested), structuredClone(topConnector)]);
  const document = structuredClone(source);
  const outer = document.slides[0].elements[0];
  if (outer.type !== "group") throw new Error("outer group fixture missing");
  outer.frame.rotation += 0.2;

  expect(reconcileAuthoredConnectors(source, document)).toEqual(["/slides/0/elements/1/frame"]);
  const saved = document.slides[0].elements[1];
  if (saved.type !== "connector") throw new Error("connector fixture missing");
  expect(saved.frame).toEqual(computeConnectorFrame(saved, buildElementWorldLookup(document.slides[0].elements)));
});

test("preserves an unchanged connector cache even when it was historically stale", () => {
  const stale = connector("stale", { kind: "free", x: 10, y: 10 }, { kind: "free", x: 90, y: 70 });
  const source = deck([stale]);
  const document = structuredClone(source);
  expect(reconcileAuthoredConnectors(source, document)).toEqual([]);
  expect(document.slides[0].elements[0].frame).toEqual(frame(9, 8, 7, 6));
});

test("a singular connector parent preserves unchanged geometry through unrelated edits", () => {
  const nestedConnector = connector("singular-link", { kind: "free", x: 5, y: 8 }, { kind: "free", x: 60, y: 45 });
  const singular: Element = {
    id: "singular", type: "group", frame: frame(100, 100, 0, 200, 0.4),
    data: { refSize: { w: 100, h: 100 }, children: [nestedConnector] },
  };
  const source = deck([singular, shape("unrelated", 600, 300)]);
  const document = structuredClone(source);
  document.meta.title = "An unrelated authored title";
  document.slides[0].elements[1].frame.x += 20;

  expect(reconcileAuthoredConnectors(source, document)).toEqual([]);
  const group = document.slides[0].elements[0];
  if (group.type !== "group") throw new Error("singular group fixture missing");
  expect(group.data.children[0].frame).toEqual(frame(9, 8, 7, 6));

  const changed = structuredClone(document);
  const changedGroup = changed.slides[0].elements[0];
  if (changedGroup.type !== "group" || changedGroup.data.children[0].type !== "connector") throw new Error("connector fixture missing");
  changedGroup.data.children[0].end = { kind: "free", x: 80, y: 45 };
  expect(() => reconcileAuthoredConnectors(source, changed)).toThrow(SlideConnectorReconciliationError);
  try { reconcileAuthoredConnectors(source, changed); } catch (error) {
    expect(error).toMatchObject({ code: "singular_connector_parent", phase: "reconcile_derived_geometry", stateChanged: false, retrySafe: false });
  }
});


test("tiny invertible groups remain editable without a fixed determinant cutoff", () => {
  const link = connector("tiny-link", { kind: "free", x: 5, y: 8 }, { kind: "free", x: 60, y: 45 });
  const source = deck([{ id: "tiny", type: "group", frame: frame(0, 0, 0.000001, 0.000001), data: { refSize: { w: 100, h: 100 }, children: [link] } }]);
  const document = structuredClone(source);
  const group = document.slides[0].elements[0];
  if (group.type !== "group" || group.data.children[0].type !== "connector") throw new Error("connector fixture missing");
  group.data.children[0].end = { kind: "free", x: 80, y: 45 };
  expect(reconcileAuthoredConnectors(source, document)).toEqual(["/slides/0/elements/0/data/children/0/frame"]);
  expect(Object.values(group.data.children[0].frame).every(Number.isFinite)).toBe(true);
});
