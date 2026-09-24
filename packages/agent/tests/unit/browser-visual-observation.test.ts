import { describe, expect, test } from "bun:test";
import {
  browserVisualObservationFromRelay,
  browserVisualObservationSchema,
} from "../../src/graph/browser-visual-observation";

const relayObservation = {
  version: 1 as const,
  pageUrl: "https://gym.example/room",
  browserSessionId: "browser-1",
  observationId: "visual-1",
  image: { width: 800, height: 600 },
  viewport: { cssWidth: 400, cssHeight: 300, dpr: 2 },
  extraction: {
    recognitionMode: "hybrid" as const,
    durationMs: 95,
    globalDurationMs: 60,
    cropDurationMs: 35,
    cropRequestCount: 1,
    text: [{ text: "Apple", box: { x: 110, y: 210, width: 80, height: 30 }, confidence: 0.91 }],
    rectangles: [{ x: 100, y: 200, width: 120, height: 60 }],
    contours: [{ x: 101, y: 201, width: 119, height: 59 }],
    contourCount: 1,
  },
};

describe("browser visual observation", () => {
  test("deterministically turns local OCR and borders into validated targets and snapshot text", () => {
    const first = browserVisualObservationFromRelay({ ...relayObservation, keyboardFocus: "page" });
    const second = browserVisualObservationFromRelay({ ...relayObservation, keyboardFocus: "page" });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      pageUrl: "https://gym.example/room",
      browserSessionId: "browser-1",
      observationId: "visual-1",
      visual: { viewport: { imageWidth: 800, imageHeight: 600, cssWidth: 400, cssHeight: 300, dpr: 2 }, keyboardFocus: "page" },
    });
    expect(first.snapshot).toContain('keyboard_focus "page"');
    expect(first.snapshot).toContain('visible_text "Apple"');
    expect(first.snapshot).toContain("visual_ref=v1");
    expect(first.snapshot).toContain("middle-left area");
    expect(first.snapshot).not.toContain("image_width");
    expect(first.snapshot).not.toContain("image_height");
    expect(first.snapshot).not.toContain("image_x");
    expect(first.snapshot).not.toContain("image_y");
    expect(first.snapshot).not.toContain("image_box");
    expect(first.snapshot).not.toMatch(/\d+% from (?:left|top)/);
    expect(first.visual.targets.some((target) => target.name === "Apple")).toBe(true);
  });

  test("rejects observations and target registries outside their exact image", () => {
    expect(() => browserVisualObservationFromRelay({ ...relayObservation, keyboardFocus: "typing-secret" }))
      .toThrow();
    expect(() => browserVisualObservationFromRelay({
      ...relayObservation,
      extraction: { ...relayObservation.extraction,
        text: [{ text: "Outside", box: { x: 790, y: 210, width: 80, height: 30 }, confidence: 1 }] },
    })).toThrow();
    expect(browserVisualObservationSchema.safeParse({
      viewport: { imageWidth: 100, imageHeight: 100, cssWidth: 50, cssHeight: 50, dpr: 2 },
      targets: [{ visualRef: "v1", role: "visible text", name: "Outside", interaction: "unknown",
        x: 100, y: 50, context: "" }],
    }).success).toBe(false);
  });

  test("renders coordinate-free relative structure for repeated visual regions", () => {
    const boxes = [
      { x: 100, y: 100, width: 80, height: 60 },
      { x: 200, y: 100, width: 80, height: 60 },
      { x: 300, y: 100, width: 80, height: 60 },
      { x: 100, y: 180, width: 80, height: 60 },
      { x: 200, y: 180, width: 80, height: 60 },
      { x: 300, y: 180, width: 80, height: 60 },
    ];
    const observation = browserVisualObservationFromRelay({
      ...relayObservation,
      extraction: {
        ...relayObservation.extraction,
        text: [{ text: "7", box: { x: 325, y: 195, width: 20, height: 24 }, confidence: 0.98 }],
        rectangles: boxes,
        appearances: boxes.map((box) => ({ box, flatFill: true })),
        contours: [],
        contourCount: 0,
        layouts: boxes.map((box, index) => ({
          groupId: "grid-1",
          kind: "grid" as const,
          box,
          ordinal: index + 1,
          itemCount: 6,
          row: Math.floor(index / 3) + 1,
          column: index % 3 + 1,
          rows: 2,
          columns: 3,
        })),
      },
    });
    expect(observation.snapshot).toContain('visual_group "grid-1" [kind=grid, rows=2, columns=3, items=6]');
    expect(observation.snapshot).toContain('grid item "visually blank"');
    expect(observation.visual.targets.find(({ name }) => name === "visually blank")?.sources)
      .toContain("flat-fill");
    expect(observation.snapshot).toContain("group=grid-1, row=2, column=3");
    expect(observation.visual.targets.find(({ name }) => name === "7")).toMatchObject({
      role: "grid item",
      layout: { groupId: "grid-1", row: 2, column: 3, rows: 2, columns: 3 },
    });
    expect(observation.snapshot).not.toContain("x: 300");
    expect(observation.snapshot).not.toContain("y: 180");
  });
});
