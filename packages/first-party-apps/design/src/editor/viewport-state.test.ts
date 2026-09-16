import { describe, expect, test } from "bun:test";
import {
  emptyViewportState,
  isViewportStranded,
  parseViewportState,
  saveViewportForPage,
  viewportStateWriteDisposition,
} from "./viewport-state";

describe("viewport presentation state", () => {
  test("drops malformed and unknown page entries", () => {
    expect(
      parseViewportState(
        { version: 1, pages: { page: { scale: 1, tx: 2, ty: 3 }, stale: { scale: 1, tx: 0, ty: 0 }, bad: { scale: "1", tx: 0, ty: 0 } } },
        ["page"],
      ),
    ).toEqual({ version: 1, pages: { page: { scale: 1, tx: 2, ty: 3 } } });
  });

  test("retains presentation state for every known page", () => {
    let state = emptyViewportState();
    for (let index = 0; index < 40; index += 1) {
      state = saveViewportForPage(state, `page-${index}`, { scale: 1, tx: index, ty: 0 });
    }
    expect(Object.keys(state.pages)).toHaveLength(40);
    expect(state.pages["page-0"]).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(state.pages["page-39"]).toEqual({ scale: 1, tx: 39, ty: 0 });
  });

  test("recognizes a finite transform that has stranded the current page offscreen", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(isViewportStranded({ scale: 1, tx: -1000, ty: 0 }, bounds, { width: 500, height: 400 })).toBe(true);
    expect(isViewportStranded({ scale: 1, tx: 20, ty: 20 }, bounds, { width: 500, height: 400 })).toBe(false);
  });

  test("a transient state read failure leaves persistence in probe mode, never write mode", () => {
    expect(viewportStateWriteDisposition(true, false, false)).toBe("probe");
    expect(viewportStateWriteDisposition(true, true, false)).toBe("write");
    expect(viewportStateWriteDisposition(true, false, true)).toBe("none");
  });
});
