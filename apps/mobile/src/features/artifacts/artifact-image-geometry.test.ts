import { describe, expect, test } from "bun:test";
import { clampImageTransform, FIT_TRANSFORM, fitImageSize, zoomImageTransform } from "./artifact-image-geometry";

describe("artifact image geometry", () => {
  test("fits each natural aspect ratio inside the viewport", () => {
    expect(fitImageSize({ width: 400, height: 100 }, { width: 200, height: 300 })).toEqual({ width: 200, height: 50 });
    expect(fitImageSize({ width: 100, height: 400 }, { width: 200, height: 300 })).toEqual({ width: 75, height: 300 });
  });

  test("keeps fit as the minimum and clamps pan to scaled rendered overflow", () => {
    expect(clampImageTransform({ scale: 0.5, x: 20, y: -20 }, { width: 200, height: 100 }, { width: 200, height: 100 })).toEqual(FIT_TRANSFORM);
    expect(clampImageTransform({ scale: 2, x: 1000, y: -1000 }, { width: 200, height: 100 }, { width: 200, height: 100 })).toEqual({ scale: 2, x: 100, y: -50 });
  });

  test("does not impose an arbitrary maximum zoom", () => {
    expect(zoomImageTransform({ scale: 100, x: 0, y: 0 }, 2, { width: 100, height: 100 }, { width: 100, height: 100 }).scale).toBe(200);
  });

  test("reclamps existing pan when rotation changes the viewport", () => {
    expect(clampImageTransform({ scale: 2, x: 90, y: 40 }, { width: 200, height: 100 }, { width: 300, height: 100 })).toEqual({ scale: 2, x: 50, y: 40 });
  });

  test("resets invalid dimensions and transforms instead of emitting non-finite layout", () => {
    expect(fitImageSize({ width: Number.NaN, height: 100 }, { width: 100, height: 100 })).toEqual({ width: 0, height: 0 });
    expect(clampImageTransform({ scale: Infinity, x: 0, y: 0 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toEqual(FIT_TRANSFORM);
  });
});
