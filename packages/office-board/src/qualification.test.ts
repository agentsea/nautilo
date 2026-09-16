import { describe, expect, it } from "vitest";
import { MemSlidesStore } from "@nautilo/office-slides/node";
import {
  boardToSlidesDocument,
  DEFAULT_VIEWPORT,
  mapMiroItems,
  panBy,
  screenToWorld,
  zoomAt,
} from "./index";
import { miroHtmlToBlocks } from "./import/miro/text";

describe("owned Board compatibility", () => {
  it("preserves content through the emitted Slides store and JSON roundtrip", () => {
    const store = new MemSlidesStore(
      boardToSlidesDocument({
        meta: { title: "Board", unit: "cm", recentColors: ["#abcdef"] },
        elements: [],
      }),
    );
    store.batch(() =>
      store.addElement("board", {
        type: "shape",
        frame: { x: -10000, y: 20000, w: 160, h: 100, rotation: 0 },
        data: { kind: "rect", fill: { kind: "srgb", value: "#abcdef" } },
      }),
    );
    const saved = store.read();
    expect(saved.slides[0].elements).toHaveLength(1);
    expect(
      new MemSlidesStore(
        JSON.parse(JSON.stringify(saved)) as typeof saved,
      ).read(),
    ).toEqual(saved);
    store.undo();
    expect(store.read().slides[0].elements).toHaveLength(0);
    store.redo();
    expect(store.read().slides[0].elements[0].frame.x).toBe(-10000);
  });
  it("does not silently constrain an infinite scene to 10%–800%", () => {
    for (const factor of [0.0001, 1000]) {
      const anchor = { x: 350, y: 220 };
      const next = zoomAt(DEFAULT_VIEWPORT, anchor, factor);
      expect(next.zoom).toBe(factor);
      expect(screenToWorld(next, anchor).x).toBeCloseTo(anchor.x);
    }
  });
  it("rejects invalid transforms before changing caller state", () => {
    for (const factor of [0, -1, NaN, Infinity])
      expect(() => zoomAt(DEFAULT_VIEWPORT, { x: 0, y: 0 }, factor)).toThrow(
        RangeError,
      );
    expect(() => zoomAt(DEFAULT_VIEWPORT, { x: 0, y: 0 }, 2, 3, 1)).toThrow(
      RangeError,
    );
    expect(() => panBy(DEFAULT_VIEWPORT, Infinity, 0)).toThrow(RangeError);
    expect(DEFAULT_VIEWPORT).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });
  it("parses HTML entities, Unicode and nested marks without a DOM", () => {
    expect(typeof globalThis.DOMParser).toBe("undefined");
    const blocks = miroHtmlToBlocks(
      "<p>世界 &amp; <b>bold <i>both</i></b></p><p>Next</p>",
    );
    expect(blocks.map((b) => b.inlines.map((i) => i.text).join(""))).toEqual([
      "世界 & bold both",
      "Next",
    ]);
    expect(blocks[0].inlines.at(-1)?.style).toMatchObject({
      bold: true,
      italic: true,
    });
  });
  it("reports unfamiliar types even when their names match Object properties", () => {
    const result = mapMiroItems({
      items: ["__proto__", "constructor"].map((type) => ({ id: type, type })),
      connectors: [],
      resolveImageUrl: (url) => url,
    });
    expect(Object.entries(result.skipped)).toEqual([
      ["__proto__", 1],
      ["constructor", 1],
    ]);
    expect(JSON.parse(JSON.stringify(result.skipped))).toEqual(result.skipped);
  });
  it("rejects duplicate handles before image resolution or connector mapping", () => {
    let resolutions = 0;
    expect(() =>
      mapMiroItems({
        items: [
          { id: "a", type: "image", data: { imageUrl: "/image" } },
          { id: "a", type: "text" },
        ],
        connectors: [],
        resolveImageUrl: (url) => {
          resolutions++;
          return url;
        },
      }),
    ).toThrow("duplicate Miro item id");
    expect(resolutions).toBe(0);
  });
  it("maps every item beyond the upstream service ceiling without truncation", () => {
    // Regression against the excluded upstream service's 10,000-item cutoff.
    const items = Array.from({ length: 10001 }, (_, i) => ({
      id: String(i),
      type: "shape",
      data: { shape: "rectangle" },
    }));
    const mapped = mapMiroItems({
      items,
      connectors: [],
      resolveImageUrl: (url) => url,
    });
    expect(mapped.inits).toHaveLength(items.length);
    expect(new Set(mapped.inits.map((i) => i.__id)).size).toBe(items.length);
    expect(mapped.skipped).toEqual({});
  });
});
