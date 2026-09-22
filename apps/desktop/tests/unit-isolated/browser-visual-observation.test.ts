import { describe, expect, test } from "bun:test";
import {
  BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES,
  parseBrowserVisualTargetBinding,
  parseBrowserVisualGroundingOutput,
  resolveBrowserVisualGroundingHelper,
} from "../../electron/browser-visual-observation.ts";

function helperOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    imagePath: "/owned/capture.png",
    recognitionMode: "hybrid",
    width: 1000,
    height: 600,
    durationMs: 12,
    globalDurationMs: 8,
    cropDurationMs: 4,
    cropRequestCount: 1,
    text: [{ text: "Canvas choice", confidence: 0.9, box: { x: 100, y: 80, width: 120, height: 30 } }],
    rectangles: [{ x: 90, y: 70, width: 160, height: 60 }],
    contours: [{ x: 110, y: 90, width: 20, height: 20 }],
    contourCount: 3,
    ...overrides,
  });
}

describe("browser visual observation helper boundary", () => {
  test("resolves only the exact packaged or source-owned macOS helper", () => {
    const exists = () => true;
    expect(resolveBrowserVisualGroundingHelper({
      platform: "darwin", isPackaged: false, resourcesPath: null,
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBe("/repo/apps/desktop/vendor/browser-visual-grounding/nautilo-browser-visual-grounding");
    expect(resolveBrowserVisualGroundingHelper({
      platform: "darwin", isPackaged: true,
      resourcesPath: "/Applications/Nautilo.app/Contents/Resources",
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBe("/Applications/Nautilo.app/Contents/Resources/tools-browser-vision/nautilo-browser-visual-grounding");
    expect(resolveBrowserVisualGroundingHelper({
      platform: "linux", isPackaged: false, resourcesPath: null,
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBeNull();
  });

  test("strictly parses bounded hybrid output and omits the input path", () => {
    const parsed = parseBrowserVisualGroundingOutput(
      helperOutput(),
      "/owned/capture.png",
      { width: 1000, height: 600 },
    );
    expect(parsed).toMatchObject({
      recognitionMode: "hybrid",
      cropRequestCount: 1,
      text: [{ text: "Canvas choice", box: { x: 100, y: 80, width: 120, height: 30 } }],
    });
    expect(parsed).not.toHaveProperty("imagePath");
  });

  test("rejects extra keys, mismatched dimensions and output beyond the documented 1 MiB cap", () => {
    expect(() => parseBrowserVisualGroundingOutput(
      helperOutput({ extra: true }), "/owned/capture.png", { width: 1000, height: 600 },
    )).toThrow(/keys/);
    expect(() => parseBrowserVisualGroundingOutput(
      helperOutput({ width: 999 }), "/owned/capture.png", { width: 1000, height: 600 },
    )).toThrow(/dimensions/);
    expect(() => parseBrowserVisualGroundingOutput(
      " ".repeat(BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES + 1),
      "/owned/capture.png",
      { width: 1000, height: 600 },
    )).toThrow(/1 MiB/);
  });

  test("strictly validates the relay-only semantic target binding", () => {
    const target = {
      version: 1,
      visualRef: "v3",
      role: "visible text",
      name: "Continue",
      interaction: "unknown",
      context: "center area",
      sources: ["ocr"],
      confidence: 0.9,
      point: { x: 250, y: 100 },
      box: { x: 200, y: 80, width: 100, height: 40 },
    };
    expect(parseBrowserVisualTargetBinding(target, { width: 1000, height: 600 }))
      .toMatchObject(target);
    expect(() => parseBrowserVisualTargetBinding(
      { ...target, leakedCoordinate: 42 },
      { width: 1000, height: 600 },
    )).toThrow(/keys/);
    expect(() => parseBrowserVisualTargetBinding(
      { ...target, point: { x: 1000, y: 100 } },
      { width: 1000, height: 600 },
    )).toThrow(/out-of-image point/);
  });
});
