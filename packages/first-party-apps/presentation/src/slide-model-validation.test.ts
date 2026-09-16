/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { importPptx } from "../engine/node.js";
import { createSlideDocument } from "./slide-document";
import {
  assertNativeSlideModel,
  NativeSlideModelValidationFailure,
  nativeSlideModelSchemaDescriptor,
  validateNativeSlideModel,
} from "./slide-model-validation";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function completeDeck() {
  const document = createSlideDocument();
  const slide = document.slides[0]!;
  slide.elements.push(
    {
      id: "shape", type: "shape", frame: { x: 10, y: 10, w: 100, h: 80, rotation: 0 },
      data: { kind: "rect", fill: { kind: "srgb", value: "#112233" } },
    },
    {
      id: "image", type: "image", frame: { x: 120, y: 10, w: 100, h: 80, rotation: 0 },
      data: { src: png, crop: { x: 0, y: 0, w: 1, h: 1 }, alt: "Pixel" },
    },
    {
      id: "table", type: "table", frame: { x: 10, y: 100, w: 200, h: 60, rotation: 0 },
      data: {
        columnWidths: [100, 100],
        rows: [
          { height: 30, cells: [
            { body: { blocks: [] }, style: {}, gridSpan: 2 },
            { body: { blocks: [] }, style: {}, gridSpan: 0 },
          ] },
          { height: 30, cells: [
            { body: { blocks: [] }, style: {} },
            { body: { blocks: [] }, style: {} },
          ] },
        ],
      },
    },
    {
      id: "group", type: "group", frame: { x: 240, y: 100, w: 120, h: 80, rotation: 0 },
      data: {
        refSize: { w: 120, h: 80 },
        children: [{
          id: "group-shape", type: "shape", frame: { x: 0, y: 0, w: 120, h: 80, rotation: 0 },
          data: { kind: "ellipse", fill: { kind: "role", role: "accent1" } },
        }],
      },
    },
    {
      id: "connector", type: "connector", frame: { x: 110, y: 50, w: 130, h: 90, rotation: 0 },
      routing: "straight", start: { kind: "attached", elementId: "shape", siteIndex: 1 },
      end: { kind: "free", x: 240, y: 140 }, arrowheads: {},
    },
    {
      id: "chart", type: "chart", frame: { x: 400, y: 100, w: 400, h: 240, rotation: 0 },
      data: {
        kind: "column", categories: ["A", "B"], categoryIndices: [0, 2],
        series: [{ name: "Series", values: [1, null] }], valueAxis: { min: 0, max: 2 },
      },
    },
  );
  slide.animations = [{
    id: "animation", elementId: "shape", category: "entrance", effect: "fadeIn",
    start: "onClick", durationMs: 300,
  }];
  slide.transition = { type: "fade", durationMs: 250 };
  return document;
}

describe("generated native Slides model schema", () => {
  test("accepts a fresh native deck and exposes the machine-readable schema", () => {
    const deck = createSlideDocument();
    expect(() => assertNativeSlideModel(deck)).not.toThrow();
    const descriptor = nativeSlideModelSchemaDescriptor();
    expect(descriptor.version).toBe(1);
    expect(descriptor.schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
  });

  test("accepts every native element discriminator and sparse note styles", () => {
    const deck = completeDeck();
    deck.slides[0]!.notes = [{
      id: "note", type: "paragraph", inlines: [{ text: "Speaker note", style: {} }], style: {},
    }] as typeof deck.slides[0]["notes"];
    expect(validateNativeSlideModel(deck)).toEqual([]);
  });

  test("accepts a real imported PPTX fixture", async () => {
    const bytes = await readFile("apps/workbench/tests/fixtures/ooxml/pptx/rich.pptx");
    const imported = await importPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(validateNativeSlideModel(imported.document)).toEqual([]);
  });

  test("preserves unknown fields and reports exact schema paths without coercion", () => {
    const deck = completeDeck() as ReturnType<typeof completeDeck> & { future: { retained: boolean } };
    deck.future = { retained: true };
    expect(() => assertNativeSlideModel(deck)).not.toThrow();
    expect(deck.future).toEqual({ retained: true });

    const invalid = structuredClone(deck) as unknown as { slides: Array<{ elements: Array<{ frame: { x: unknown } }> }> };
    invalid.slides[0]!.elements[0]!.frame.x = "10";
    const errors = validateNativeSlideModel(invalid);
    expect(errors.some((error) => error.instancePath.includes("/frame/x") && error.keyword === "type")).toBe(true);
    expect(invalid.slides[0]!.elements[0]!.frame.x).toBe("10");
    try {
      assertNativeSlideModel(invalid);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeSlideModelValidationFailure);
      const failure = error as NativeSlideModelValidationFailure;
      expect(failure.errorCount).toBe(failure.errors.length);
      expect(failure.affectedPaths).toContain("/slides/0/elements/0/frame/x");
    }
  });

  test("rejects broken table, chart, connector, scale and animation invariants", () => {
    const table = completeDeck();
    const tableElement = table.slides[0]!.elements.find((element) => element.type === "table")!;
    tableElement.data.rows[0]!.cells.pop();
    expect(validateNativeSlideModel(table).some((error) => error.keyword === "table-grid")).toBe(true);

    const chart = completeDeck();
    const chartElement = chart.slides[0]!.elements.find((element) => element.type === "chart")!;
    chartElement.data.series[0]!.values.pop();
    expect(validateNativeSlideModel(chart).some((error) => error.keyword === "chart-points")).toBe(true);

    const connector = completeDeck();
    const connectorElement = connector.slides[0]!.elements.find((element) => element.type === "connector")!;
    if (connectorElement.start.kind === "attached") connectorElement.start.siteIndex = -1;
    expect(validateNativeSlideModel(connector).some((error) => error.keyword === "connector-endpoint")).toBe(true);

    const scale = completeDeck();
    scale.meta.pxPerPt = 0;
    expect(validateNativeSlideModel(scale).some((error) => error.keyword === "deck-scale")).toBe(true);

    const animation = completeDeck();
    animation.slides[0]!.animations![0]!.elementId = "missing";
    expect(validateNativeSlideModel(animation).some((error) => error.keyword === "animation-target")).toBe(true);
  });
});
