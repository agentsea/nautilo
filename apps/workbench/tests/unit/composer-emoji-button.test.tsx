import { describe, expect, test } from "bun:test";
import {
  computeComposerEmojiPopoverPosition,
  type ComposerEmojiPopoverViewport,
} from "../../src/components/composer/ComposerEmojiButton";

function viewport(
  innerWidth: number,
  innerHeight: number,
  rootFontPx = 16,
): ComposerEmojiPopoverViewport {
  return { innerWidth, innerHeight, rootFontPx };
}

function rect(left: number, top: number, width = 32, height = 32): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("computeComposerEmojiPopoverPosition", () => {
  test("anchors bottom-left above the button when there is room", () => {
    const vp = viewport(1200, 800);
    const pos = computeComposerEmojiPopoverPosition(rect(200, 600), vp);
    expect(pos.left).toBe(200);
    expect(pos.bottom).toBe(800 - 600 + 8);
  });

  test("flips and clamps when the picker would overflow the right edge", () => {
    const vp = viewport(400, 800);

    // 20rem @ 16px = 320px wide; button near the right rail at x=350.
    const pos = computeComposerEmojiPopoverPosition(rect(350, 600, 32, 32), vp);
    const pickerWidth = 320;
    const maxLeft = 400 - pickerWidth - 8;

    expect(pos.left).toBeLessThanOrEqual(maxLeft);
    expect(pos.left + pickerWidth).toBeLessThanOrEqual(400 - 8);
    // Right-align flip: 382 - 320 = 62
    expect(pos.left).toBe(62);
  });

  test("clamps to the left viewport margin when flipped position still overflows", () => {
    const vp = viewport(300, 800);
    const pos = computeComposerEmojiPopoverPosition(rect(250, 600, 32, 32), vp);
    expect(pos.left).toBe(8);
  });
});
