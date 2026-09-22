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
    const first = browserVisualObservationFromRelay(relayObservation);
    const second = browserVisualObservationFromRelay(relayObservation);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      pageUrl: "https://gym.example/room",
      browserSessionId: "browser-1",
      observationId: "visual-1",
      visual: { viewport: { imageWidth: 800, imageHeight: 600, cssWidth: 400, cssHeight: 300, dpr: 2 } },
    });
    expect(first.snapshot).toContain('visible_text "Apple"');
    expect(first.snapshot).toContain("visual_ref=v1");
    expect(first.visual.targets.some((target) => target.name === "Apple")).toBe(true);
  });

  test("rejects observations and target registries outside their exact image", () => {
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
});
