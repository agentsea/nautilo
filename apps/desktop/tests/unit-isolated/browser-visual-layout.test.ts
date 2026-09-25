import { describe, expect, test } from "bun:test";

import {
  inferBrowserVisualLayouts,
  type BrowserVisualLayoutBox,
} from "../../electron/browser-visual-layout.ts";

function grid(options: {
  readonly rows: number;
  readonly columns: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly horizontalGap?: number;
  readonly verticalGap?: number;
  readonly jitter?: number;
}): BrowserVisualLayoutBox[] {
  const width = options.width ?? 80;
  const height = options.height ?? 60;
  const horizontalGap = options.horizontalGap ?? 16;
  const verticalGap = options.verticalGap ?? 14;
  const jitter = options.jitter ?? 0;
  return Array.from({ length: options.rows * options.columns }, (_, index) => {
    const row = Math.floor(index / options.columns);
    const column = index % options.columns;
    const delta = jitter === 0 ? 0 : ((index * 7) % (jitter * 2 + 1)) - jitter;
    return {
      x: (options.x ?? 100) + column * (width + horizontalGap) + delta,
      y: (options.y ?? 100) + row * (height + verticalGap) - delta,
      width: width + delta,
      height: height - delta,
    };
  });
}

describe("browser visual layout inference", () => {
  test("infers a noisy non-square grid without page or task semantics", () => {
    const cells = grid({ rows: 3, columns: 5, width: 92, height: 76, jitter: 4 });
    const layouts = inferBrowserVisualLayouts({
      image: { width: 1_200, height: 800 },
      rectangles: [
        { x: 10, y: 10, width: 1_100, height: 40 },
        ...cells,
        { x: 840, y: 650, width: 210, height: 90 },
      ],
    });
    const inferred = layouts.filter(({ groupId }) => groupId === "grid-1");
    expect(inferred).toHaveLength(15);
    expect(inferred.every(({ rows, columns, itemCount }) =>
      rows === 3 && columns === 5 && itemCount === 15)).toBe(true);
    expect(inferred.find(({ row, column }) => row === 3 && column === 5)).toBeDefined();
  });

  test("infers horizontal and vertical repeated controls independently", () => {
    const horizontal = grid({ rows: 1, columns: 5, x: 60, y: 70, width: 70, height: 44 });
    const vertical = grid({ rows: 4, columns: 1, x: 850, y: 220, width: 130, height: 56 });
    const layouts = inferBrowserVisualLayouts({
      image: { width: 1_200, height: 800 },
      rectangles: [...horizontal, ...vertical],
    });
    expect(layouts.filter(({ kind }) => kind === "row")).toHaveLength(5);
    expect(layouts.filter(({ kind }) => kind === "column")).toHaveLength(4);
  });

  test("keeps relative identities when a grid is shifted and scaled", () => {
    const first = inferBrowserVisualLayouts({
      image: { width: 800, height: 600 },
      rectangles: grid({ rows: 2, columns: 3, width: 70, height: 54 }),
    });
    const second = inferBrowserVisualLayouts({
      image: { width: 1_600, height: 1_200 },
      rectangles: grid({
        rows: 2,
        columns: 3,
        x: 420,
        y: 280,
        width: 140,
        height: 108,
        horizontalGap: 32,
        verticalGap: 28,
      }),
    });
    expect(second.map(({ kind, row, column, rows, columns }) => ({ kind, row, column, rows, columns })))
      .toEqual(first.map(({ kind, row, column, rows, columns }) => ({ kind, row, column, rows, columns })));
  });

  test("does not invent a group from unrelated rectangles", () => {
    const layouts = inferBrowserVisualLayouts({
      image: { width: 1_000, height: 700 },
      rectangles: [
        { x: 30, y: 40, width: 70, height: 40 },
        { x: 410, y: 90, width: 180, height: 45 },
        { x: 170, y: 430, width: 95, height: 130 },
        { x: 760, y: 500, width: 210, height: 80 },
      ],
    });
    expect(layouts).toEqual([]);
  });
});
