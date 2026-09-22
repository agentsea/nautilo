import { describe, expect, test } from "bun:test";
import {
  BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES,
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
});
