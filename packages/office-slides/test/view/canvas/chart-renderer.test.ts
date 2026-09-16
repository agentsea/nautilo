import { describe, it, expect } from "vitest";
import "../../../src/view/canvas/test-canvas-env";
import { asCtx, createCtxSpy } from "../../../src/view/canvas/ctx-spy";
import { drawChart, niceTicks } from "../../../src/view/canvas/chart-renderer";
import type { ChartElement } from "../../../src/model/element";
import type { Theme } from "../../../src/model/theme";

const THEME: Theme = {
  id: "t",
  name: "t",
  colors: {
    text: "#000",
    background: "#fff",
    textSecondary: "#444",
    backgroundAlt: "#f3f3f3",
    accent1: "#3366cc",
    accent2: "#dc3912",
    accent3: "#ff9900",
    accent4: "#109618",
    accent5: "#990099",
    accent6: "#0099c6",
    hyperlink: "#11c",
    visitedHyperlink: "#71a",
  },
  fonts: { heading: "Inter", body: "Inter" },
};

const size = { w: 400, h: 300 };

const columnData = (): ChartElement["data"] => ({
  kind: "column",
  grouping: "clustered",
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { name: "A", values: [1, 2, 3] },
    { name: "B", values: [3, 2, 1] },
  ],
});

describe("sparse category coordinates", () => {
  it("places each stored bar at the same coordinate as its dense equivalent", () => {
    const sparse = createCtxSpy();
    const dense = createCtxSpy();
    const data: ChartElement["data"] = {
      kind: "column",
      legend: "none",
      categories: ["A", "D", "F"],
      categoryIndices: [0, 3, 5],
      series: [{ values: [2, 3, 4] }],
    };
    drawChart(asCtx(sparse), size, data, THEME);
    drawChart(
      asCtx(dense),
      size,
      {
        ...data,
        categoryIndices: undefined,
        categories: ["A", "", "", "D", "", "F"],
        series: [{ values: [2, null, null, 3, null, 4] }],
      },
      THEME,
    );
    expect(sparse.fillRect.mock.calls).toEqual(
      dense.fillRect.mock.calls.filter(([, , , h]) => h > 0),
    );
  });

  it.each(["line", "area"] as const)(
    "preserves empty category gaps for %s charts",
    (kind) => {
      const sparse = createCtxSpy();
      const dense = createCtxSpy();
      const data: ChartElement["data"] = {
        kind,
        legend: "none",
        categories: ["A", "D", "F"],
        categoryIndices: [0, 3, 5],
        series: [{ values: [2, 3, 4] }],
      };
      drawChart(asCtx(sparse), size, data, THEME);
      drawChart(
        asCtx(dense),
        size,
        {
          ...data,
          categoryIndices: undefined,
          categories: ["A", "", "", "D", "", "F"],
          series: [{ values: [2, null, null, 3, null, 4] }],
        },
        THEME,
      );
      expect(sparse.moveTo.mock.calls).toEqual(dense.moveTo.mock.calls);
      expect(sparse.lineTo.mock.calls).toEqual(dense.lineTo.mock.calls);
    },
  );

  it("draws distant points without iterating or allocating missing categories", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "line",
        legend: "none",
        categories: ["First", "Last"],
        categoryIndices: [0, 999999999],
        series: [{ values: [2, 4] }],
      },
      THEME,
    );
    // Four axis vertices plus three bounded line segments, independent of gap size.
    expect(ctx.moveTo.mock.calls.length + ctx.lineTo.mock.calls.length).toBe(
      10,
    );
    for (const coordinates of [
      ...ctx.moveTo.mock.calls,
      ...ctx.lineTo.mock.calls,
    ]) {
      expect(coordinates.every(Number.isFinite)).toBe(true);
    }
  });
});

describe("niceTicks", () => {
  it("rounds the axis max up to a nice step", () => {
    expect(niceTicks(23).max).toBeGreaterThanOrEqual(23);
    expect(niceTicks(23).step).toBeGreaterThan(0);
  });
  it("handles an all-zero domain without NaN", () => {
    const t = niceTicks(0);
    expect(Number.isFinite(t.max)).toBe(true);
    expect(Number.isFinite(t.step)).toBe(true);
  });
  it.each([Number.MIN_VALUE, 2e-323])(
    "keeps subnormal nice tick arithmetic finite for %s",
    (value) => {
      const result = niceTicks(value);
      expect(Number.isFinite(result.max)).toBe(true);
      expect(result.step).toBeGreaterThan(0);
    },
  );
  it("keeps a positive step when division of a subnormal value underflows", () => {
    expect(niceTicks(Number.MIN_VALUE)).toEqual({
      max: Number.MIN_VALUE,
      step: Number.MIN_VALUE,
    });
  });
});

describe("drawChart — column", () => {
  it("draws one filled rect per (series × category) bar", () => {
    const ctx = createCtxSpy();
    // legend: 'none' isolates bar fillRect calls from the legend's own
    // fillRect swatches, so this measures bar count exactly.
    drawChart(asCtx(ctx), size, { ...columnData(), legend: "none" }, THEME);
    // 2 series × 3 categories = 6 bars.
    expect(ctx.fillRect).toHaveBeenCalledTimes(6);
  });

  it("does not throw on empty series", () => {
    const ctx = createCtxSpy();
    expect(() =>
      drawChart(
        asCtx(ctx),
        size,
        { kind: "column", categories: [], series: [] },
        THEME,
      ),
    ).not.toThrow();
  });

  it.each([
    { name: "positive", values: [10, 30] },
    { name: "all-negative", values: [-10, -30] },
    { name: "mixed", values: [-10, 30] },
    { name: "zero", values: [0, 0] },
  ])("draws finite $name bars from the zero baseline", ({ values }) => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        categories: ["A", "B"],
        series: [{ values }],
        legend: "none",
      },
      THEME,
    );

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
    for (const geometry of ctx.fillRect.mock.calls) {
      expect(geometry.every(Number.isFinite)).toBe(true);
      expect(geometry[2]).toBeGreaterThan(0);
      expect(geometry[3]).toBeGreaterThanOrEqual(0);
    }
    const zeroTickY = ctx.fillText.mock.calls.find(
      ([text]) => text === "0",
    )?.[2] as number;
    expect(Number.isFinite(zeroTickY)).toBe(true);
    for (const [, y, , height] of ctx.fillRect.mock.calls) {
      expect(y === zeroTickY || y + height === zeroTickY).toBe(true);
    }
  });

  it("stacks positive and negative values independently around zero", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        grouping: "stacked",
        categories: ["A"],
        series: [
          { values: [10] },
          { values: [-4] },
          { values: [-6] },
          { values: [5] },
        ],
        legend: "none",
      },
      THEME,
    );

    const zeroTickY = ctx.fillText.mock.calls.find(
      ([text]) => text === "0",
    )?.[2] as number;
    const bars = ctx.fillRect.mock.calls;
    expect(bars).toHaveLength(4);
    expect(Number(bars[0][1]) + Number(bars[0][3])).toBeCloseTo(zeroTickY);
    expect(Number(bars[1][1])).toBeCloseTo(zeroTickY);
    expect(Number(bars[2][1])).toBeCloseTo(
      Number(bars[1][1]) + Number(bars[1][3]),
    );
    expect(Number(bars[3][1]) + Number(bars[3][3])).toBeCloseTo(
      Number(bars[0][1]),
    );
  });

  it("normalizes mixed-sign percent stacks on each side of zero", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "bar",
        grouping: "percentStacked",
        categories: ["A"],
        series: [{ values: [2] }, { values: [-1] }, { values: [-3] }],
        legend: "none",
      },
      THEME,
    );

    const ticks = ctx.fillText.mock.calls.map(([text]) => String(text));
    expect(ticks).toContain("-100%");
    expect(ticks).toContain("100%");
    expect(ctx.fillRect.mock.calls.flat().every(Number.isFinite)).toBe(true);
  });

  it.each([
    {
      name: "opposite finite extremes",
      values: [-Number.MAX_VALUE, Number.MAX_VALUE],
    },
    {
      name: "positive subnormals",
      values: [Number.MIN_VALUE, Number.MIN_VALUE * 2],
    },
    { name: "negative subnormal", values: [-Number.MIN_VALUE, 0] },
  ])("keeps $name as finite canvas geometry", ({ values }) => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        categories: ["A", "B"],
        series: [{ values }],
        legend: "none",
        showGridlines: true,
      },
      THEME,
    );

    const recordedCalls = [
      ...ctx.fillRect.mock.calls,
      ...ctx.moveTo.mock.calls,
      ...ctx.lineTo.mock.calls,
    ];
    expect(
      recordedCalls.every((call) =>
        call.every((value) => Number.isFinite(Number(value))),
      ),
    ).toBe(true);
    expect(
      ctx.fillText.mock.calls.every(
        ([, x, y]) => Number.isFinite(Number(x)) && Number.isFinite(Number(y)),
      ),
    ).toBe(true);
    expect(ctx.fillRect.mock.calls.some(([, , , height]) => height > 0)).toBe(
      true,
    );
    const ticks = ctx.fillText.mock.calls.map(([text]) => String(text));
    expect(ticks.some((text) => /Infinity|NaN/.test(text))).toBe(false);
    expect(ticks.some((text) => /[1-9]/.test(text))).toBe(true);
  });

  it("retains both sides of percent stacks when sign magnitudes have no representable ratio", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        grouping: "percentStacked",
        categories: ["A"],
        series: [
          { values: [Number.MAX_VALUE] },
          { values: [-Number.MIN_VALUE] },
        ],
        legend: "none",
      },
      THEME,
    );
    const bars = ctx.fillRect.mock.calls;
    expect(bars).toHaveLength(2);
    expect(Number(bars[0][3])).toBeGreaterThan(0);
    expect(Number(bars[0][3])).toBeCloseTo(Number(bars[1][3]));
    const ticks = ctx.fillText.mock.calls.map(([text]) => String(text));
    expect(ticks).toContain("-100%");
    expect(ticks).toContain("100%");
  });
});

describe("drawChart — horizontal bar", () => {
  it("maps values to width and categories to vertical slots", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "bar",
        categories: ["A", "B"],
        series: [{ values: [10, 20] }],
        legend: "none",
      },
      THEME,
    );
    const bars = ctx.fillRect.mock.calls;
    expect(bars).toHaveLength(2);
    expect(Number(bars[1][2])).toBeGreaterThan(Number(bars[0][2]));
    expect(Number(bars[0][3])).toBeCloseTo(Number(bars[1][3]));
    expect(Number(bars[1][1])).toBeGreaterThan(Number(bars[0][1]));
  });

  it("stacks mixed signs independently along the horizontal value axis", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "bar",
        grouping: "stacked",
        categories: ["A"],
        series: [
          { values: [10] },
          { values: [-4] },
          { values: [-6] },
          { values: [5] },
        ],
        legend: "none",
      },
      THEME,
    );
    const bars = ctx.fillRect.mock.calls;
    expect(bars).toHaveLength(4);
    expect(Number(bars[2][0]) + Number(bars[2][2])).toBeCloseTo(
      Number(bars[1][0]),
    );
    expect(Number(bars[3][0])).toBeCloseTo(
      Number(bars[0][0]) + Number(bars[0][2]),
    );
    expect(bars.flat().every(Number.isFinite)).toBe(true);
  });
});

describe("drawChart — legend", () => {
  it("draws a square swatch per series via fillRect when the legend is on", () => {
    const off = createCtxSpy();
    drawChart(asCtx(off), size, { ...columnData(), legend: "none" }, THEME);
    const on = createCtxSpy();
    drawChart(asCtx(on), size, columnData(), THEME);
    // 2 series → 2 extra fillRect calls (bars: 6, bars + legend: 8).
    expect(on.fillRect).toHaveBeenCalledTimes(
      off.fillRect.mock.calls.length + 2,
    );
    // Each swatch is a 10x10 square.
    const swatchCalls = on.fillRect.mock.calls.slice(-2);
    for (const [, , w, h] of swatchCalls) {
      expect(w).toBe(10);
      expect(h).toBe(10);
    }
  });
});

describe("drawChart — line/area/pie", () => {
  const line = (kind: "line" | "area"): ChartElement["data"] => ({
    kind,
    categories: ["a", "b", "c"],
    series: [{ name: "S", values: [1, 3, 2] }],
  });

  it("strokes a polyline for a line chart", () => {
    const ctx = createCtxSpy();
    drawChart(asCtx(ctx), size, line("line"), THEME);
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
  });

  it("fills an area chart", () => {
    const ctx = createCtxSpy();
    drawChart(asCtx(ctx), size, line("area"), THEME);
    expect(ctx.fill).toHaveBeenCalled();
  });

  it.each(["line", "area"] as const)(
    "stacks signed %s series as running totals",
    (kind) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind,
          grouping: "stacked",
          categories: ["a", "b"],
          series: [{ values: [10, -10] }, { values: [5, -5] }],
          legend: "none",
        },
        THEME,
      );
      const coordinates = [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls];
      expect(coordinates.flat().every(Number.isFinite)).toBe(true);
      const strokes = ctx.stroke.mock.calls.length;
      expect(strokes).toBeGreaterThanOrEqual(3);
      const finalLines = ctx.lineTo.mock.calls.slice(-1);
      expect(Number(finalLines[0][1])).toBeGreaterThan(8);
    },
  );

  it.each(["line", "area"] as const)(
    "places mixed-sign %s stack endpoints at their algebraic totals",
    (kind) => {
      const ctx = createCtxSpy();
      const data: ChartElement["data"] = {
        kind, grouping: "stacked", categories: ["A", "B"], legend: "none",
        valueAxis: { min: -10, max: 30 },
        series: [{ values: [10, 20] }, { values: [-5, -10] }, { values: [-10, -5] }],
      };
      const before = structuredClone(data);
      drawChart(asCtx(ctx), size, data, THEME);
      const top = Number(ctx.moveTo.mock.calls[0][1]);
      const bottom = Number(ctx.lineTo.mock.calls[0][1]);
      // Last category ends at 20 - 10 - 5 = 5, rather than a -15 sign stack.
      expect(Number(ctx.lineTo.mock.calls.at(-1)![1])).toBeCloseTo(top + (bottom - top) * 25 / 40);
      expect(data).toEqual(before);
    },
  );

  it.each(["line", "area"] as const)(
    "preserves signed shares over total magnitude for percent-stacked %s",
    (kind) => {
      const ctx = createCtxSpy();
      const data: ChartElement["data"] = {
        kind, grouping: "percentStacked", categories: ["A", "B"], legend: "none",
        valueAxis: { min: 0, max: 1 },
        series: [{ values: [10, 20] }, { values: [-5, -10] }],
      };
      const before = structuredClone(data);
      drawChart(asCtx(ctx), size, data, THEME);
      const top = Number(ctx.moveTo.mock.calls[0][1]);
      const bottom = Number(ctx.lineTo.mock.calls[0][1]);
      const seriesEnds = ctx.lineTo.mock.calls.filter(([x]) => x === 392).map(([, y]) => Number(y));
      expect(seriesEnds.some((y) => Math.abs(y - (top + (bottom - top) / 3)) < 1e-8)).toBe(true);
      expect(Number(ctx.lineTo.mock.calls.at(-1)![1])).toBeCloseTo(top + (bottom - top) * 2 / 3);
      expect(data).toEqual(before);
    },
  );

  it.each(["line", "area"] as const)(
    "normalizes signed percent-stacked %s series",
    (kind) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind,
          grouping: "percentStacked",
          categories: ["a"],
          series: [
            { values: [Number.MAX_VALUE] },
            { values: [-Number.MIN_VALUE] },
          ],
          legend: "none",
        },
        THEME,
      );
      const ticks = ctx.fillText.mock.calls.map(([text]) => String(text));
      expect(ticks).not.toContain("-100%");
      expect(ticks).toContain("100%");
      expect(
        [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]
          .flat()
          .every(Number.isFinite),
      ).toBe(true);
    },
  );

  it.each(["line", "area"] as const)(
    "keeps mixed-sign %s points inside the plot",
    (kind) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind,
          categories: ["negative", "zero", "positive"],
          series: [{ values: [-10, 0, 30] }],
          legend: "none",
        },
        THEME,
      );

      const zeroTickY = ctx.fillText.mock.calls.find(
        ([text]) => text === "0",
      )?.[2] as number;
      const seriesMove = ctx.moveTo.mock.calls.at(-1)!;
      const seriesLines = ctx.lineTo.mock.calls;
      expect(
        [...ctx.moveTo.mock.calls, ...seriesLines].some(
          ([, y]) => Math.abs(Number(y) - zeroTickY) < 1e-9,
        ),
      ).toBe(true);
      expect(
        [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]
          .flat()
          .every(Number.isFinite),
      ).toBe(true);
      for (const [, y] of [seriesMove, ...seriesLines]) {
        expect(y).toBeGreaterThanOrEqual(8);
        expect(y).toBeLessThanOrEqual(266);
      }
      if (kind === "area") {
        const zeroBaselineVertices = ctx.lineTo.mock.calls.filter(
          ([, y]) => Math.abs(Number(y) - zeroTickY) < 1e-9,
        );
        // One zero-valued data point plus both area-closing baseline corners.
        expect(zeroBaselineVertices.length).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(["line", "area"] as const)(
    "clips extreme %s values against a tiny explicit range before projection",
    (kind) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind,
          categories: ["low", "high"],
          series: [{ values: [-Number.MAX_VALUE, Number.MAX_VALUE / 2] }],
          valueAxis: { min: -Number.MIN_VALUE, max: Number.MIN_VALUE },
          legend: "none",
        },
        THEME,
      );
      const coordinates = [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls];
      expect(coordinates.flat().every(Number.isFinite)).toBe(true);
      expect(coordinates.some(([, y]) => Number(y) === 8)).toBe(true);
      expect(coordinates.some(([, y]) => Number(y) === 266)).toBe(true);
    },
  );

  it.each(["line", "area"] as const)(
    "keeps automatic stacked %s geometry finite when totals exceed IEEE range",
    (kind) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind,
          grouping: "stacked",
          categories: ["A", "B"],
          series: [
            { values: [Number.MAX_VALUE, -Number.MAX_VALUE] },
            { values: [Number.MAX_VALUE, -Number.MAX_VALUE] },
          ],
          legend: "none",
        },
        THEME,
      );
      expect(
        [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]
          .flat()
          .every(Number.isFinite),
      ).toBe(true);
    },
  );

  it("draws pie slices with arc()", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "pie",
        categories: ["A", "B"],
        series: [{ values: [60, 40] }],
      },
      THEME,
    );
    expect(ctx.arc).toHaveBeenCalledTimes(2);
  });

  it("draws gridlines when showGridlines is set", () => {
    const plain = createCtxSpy();
    drawChart(asCtx(plain), size, columnData(), THEME);
    const grid = createCtxSpy();
    drawChart(
      asCtx(grid),
      size,
      { ...columnData(), showGridlines: true },
      THEME,
    );
    expect(grid.stroke.mock.calls.length).toBeGreaterThan(
      plain.stroke.mock.calls.length,
    );
  });
});

describe("drawChart — category-axis labels", () => {
  it("draws each category name under the plot for a column chart", () => {
    const ctx = createCtxSpy();
    drawChart(asCtx(ctx), size, { ...columnData(), legend: "none" }, THEME);
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).toContain("Q1");
    expect(texts).toContain("Q2");
    expect(texts).toContain("Q3");
  });

  it("draws each category name for a line chart data point", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "line",
        categories: ["a", "b", "c"],
        series: [{ name: "S", values: [1, 3, 2] }],
        legend: "none",
      },
      THEME,
    );
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).toContain("a");
    expect(texts).toContain("b");
    expect(texts).toContain("c");
  });

  it("does not draw category labels for a pie chart", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "pie",
        categories: ["A", "B"],
        series: [{ values: [60, 40] }],
        legend: "none",
      },
      THEME,
    );
    // Pie has no category-axis band; category names only appear via the
    // legend, which is off here.
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).not.toContain("A");
    expect(texts).not.toContain("B");
  });
});

describe("drawChart — value-axis tick labels", () => {
  it("labels the 0 tick and the domain max even without showGridlines", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        categories: ["Q1", "Q2"],
        series: [{ name: "A", values: [10, 30] }],
        legend: "none",
      },
      THEME,
    );
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    // domainMax for 30 rounds up to a nice tick of 30 (niceTicks(30,5) step 10).
    expect(texts).toContain("0");
    expect(texts).toContain("30");
  });

  it("formats percentStacked ticks as percentages", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        grouping: "percentStacked",
        categories: ["Q1", "Q2"],
        series: [
          { name: "A", values: [10, 30] },
          { name: "B", values: [10, 30] },
        ],
        legend: "none",
      },
      THEME,
    );
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).toContain("0%");
    expect(texts).toContain("100%");
  });

  it("does not draw value-axis ticks for a pie chart", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "pie",
        categories: ["A", "B"],
        series: [{ values: [60, 40] }],
        legend: "none",
      },
      THEME,
    );
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).not.toContain("0");
  });

  it("uses explicit bounds and crossing in rendered axis geometry", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "column",
        categories: ["A"],
        series: [{ values: [10] }],
        legend: "none",
        valueAxis: { min: -10, max: 40, crossAt: 20 },
      },
      THEME,
    );
    const texts = ctx.fillText.mock.calls.map(([text]) => String(text));
    expect(texts).toContain("-10");
    expect(texts).toContain("40");
    const expectedY = 8 + ((40 - 20) / 50) * 258;
    const crossing = ctx.moveTo.mock.calls.find(
      ([, y]) => Math.abs(Number(y) - expectedY) < 1e-9,
    );
    expect(crossing).toBeDefined();
    expect(crossing![1]).toBeCloseTo(expectedY);
  });

  it.each([
    ["minimum above all data", { min: 100 }],
    ["maximum below all data", { max: -100 }],
    ["subnormal range", { min: Number.MIN_VALUE, max: Number.MIN_VALUE * 2 }],
  ] as const)(
    "keeps a finite domain for an explicit %s",
    (_name, valueAxis) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind: "column",
          categories: ["A"],
          series: [{ values: [1] }],
          legend: "none",
          valueAxis,
        },
        THEME,
      );
      expect(
        [
          ...ctx.fillRect.mock.calls,
          ...ctx.moveTo.mock.calls,
          ...ctx.lineTo.mock.calls,
        ]
          .flat()
          .every(Number.isFinite),
      ).toBe(true);
    },
  );

  it.each([
    ["equal bounds", { min: 5, max: 5 }],
    ["inverted bounds", { min: 6, max: 5 }],
    ["finite-extreme minimum", { min: Number.MAX_VALUE }],
    ["finite-extreme maximum", { max: -Number.MAX_VALUE }],
  ] as const)(
    "refuses an unrepresentable explicit axis with %s",
    (_name, valueAxis) => {
      const ctx = createCtxSpy();
      expect(() =>
        drawChart(
          asCtx(ctx),
          size,
          {
            kind: "column",
            categories: ["A"],
            series: [{ values: [1] }],
            valueAxis,
            legend: "none",
          },
          THEME,
        ),
      ).toThrow(/Cannot render chart: value-axis/u);
      expect(ctx.fillRect).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { crossAt: 0 }] as const)(
    "renders all-zero data with axis metadata %#",
    (valueAxis) => {
      const ctx = createCtxSpy();
      drawChart(
        asCtx(ctx),
        size,
        {
          kind: "column",
          categories: ["A"],
          series: [{ values: [0] }],
          valueAxis,
          legend: "none",
        },
        THEME,
      );
      expect(
        [
          ...ctx.fillRect.mock.calls,
          ...ctx.moveTo.mock.calls,
          ...ctx.lineTo.mock.calls,
        ]
          .flat()
          .every(Number.isFinite),
      ).toBe(true);
    },
  );
});

describe("drawChart — pie legend", () => {
  it("lists categories (not series) with per-slice colors", () => {
    const ctx = createCtxSpy();
    drawChart(
      asCtx(ctx),
      size,
      {
        kind: "pie",
        categories: ["A", "B", "C"],
        series: [{ values: [50, 30, 20] }],
        legend: "right",
      },
      THEME,
    );
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).toContain("A");
    expect(texts).toContain("B");
    expect(texts).toContain("C");
    expect(texts).not.toContain("Series 1");
  });

  it("keeps series-based legend for non-pie charts", () => {
    const ctx = createCtxSpy();
    drawChart(asCtx(ctx), size, columnData(), THEME);
    const texts: unknown[] = ctx.fillText.mock.calls.map(([t]) => t as unknown);
    expect(texts).toContain("A");
    expect(texts).toContain("B");
  });
});
