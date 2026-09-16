import type { ChartElement } from "../../model/element";
import type { ColorRole, Theme } from "../../model/theme";
import { resolveColor } from "../../model/theme";
import { chartValueAxisError } from "../../model/chart";

const ACCENT_ROLES: readonly ColorRole[] = [
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
];

function seriesColorAt(
  data: ChartElement["data"],
  i: number,
  theme: Theme,
): string {
  const explicit = data.series[i]?.color;
  if (explicit) return resolveColor(explicit, theme);
  return resolveColor(
    { kind: "role", role: ACCENT_ROLES[i % ACCENT_ROLES.length] },
    theme,
  );
}

/** Round a value-axis max up to a "nice" 1/2/5×10ⁿ step. */
export function niceTicks(
  max: number,
  count = 5,
): { max: number; step: number } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, step: 1 };
  const rough = max / count;
  // Division can underflow for the smallest finite IEEE-754 values. The
  // input itself is then the smallest representable positive tick step.
  if (rough === 0) return { max, step: max };
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  if (mag === 0) return { max, step: max };
  const norm = rough / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  const roundedMax = Math.ceil(max / step) * step;
  return { max: Number.isFinite(roundedMax) ? roundedMax : max, step };
}

const PAD = 8;
const MIN_LEFT_MARGIN = 24;
const VALUE_TICK_FONT = "10px sans-serif";
const CATEGORY_LABEL_FONT = "10px sans-serif";

/** Sparse imported points retain their original category-axis coordinates.
 * Iterate stored points, never the (potentially very large) empty gaps.
 */
function categoryAxis(data: ChartElement["data"]) {
  const count = data.series.reduce(
    (n, series) => Math.max(n, series.values.length),
    data.categories.length,
  );
  const indices = data.categoryIndices;
  const sparse =
    indices?.length === count &&
    indices.every(
      (index, i) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        (i === 0 || index > indices[i - 1]),
    );
  return {
    count,
    extent: count === 0 ? 1 : sparse ? indices[count - 1] + 1 : count,
    indexAt: (position: number) => (sparse ? indices[position] : position),
  };
}

/** Format a value-axis tick as a clean string (no floating-point noise). */
function formatTick(v: number, isPercent: boolean, scale = 1): string {
  if (isPercent) return `${Math.round(v * scale * 100)}%`;
  const value = v * scale;
  // Significant digits preserve tiny values without multiplying large values
  // beyond IEEE-754 range. A stacked total may itself exceed that range;
  // retain its normalized product instead of inventing an Infinity label.
  if (!Number.isFinite(value))
    return `${Number(v.toPrecision(6))} × ${scale.toExponential(5)}`;
  return String(Number(value.toPrecision(6)));
}

/**
 * Measure the widest value-axis tick label so the left plot margin can
 * fit it. Returns the reserved left margin in px (min `MIN_LEFT_MARGIN`).
 */
function measureLeftMargin(
  ctx: CanvasRenderingContext2D,
  domain: ScaledValueDomain,
  isPercent: boolean,
): number {
  ctx.font = VALUE_TICK_FONT;
  let widest = 0;
  for (const v of domainTicks(domain)) {
    const label = formatTick(v, isPercent, domain.scale);
    widest = Math.max(widest, ctx.measureText(label).width);
  }
  return Math.max(MIN_LEFT_MARGIN, widest + 12);
}

function measureCategoryMargin(
  ctx: CanvasRenderingContext2D,
  data: ChartElement["data"],
): number {
  ctx.font = CATEGORY_LABEL_FONT;
  let widest = 0;
  for (const label of data.categories)
    widest = Math.max(widest, ctx.measureText(label).width);
  return Math.max(MIN_LEFT_MARGIN, widest + 12);
}

/**
 * Draw a chart element into element-local coordinates (top-left at
 * 0,0). Mirrors `drawTable` — the frame transform belongs to the
 * element-renderer; this function only knows about `(w, h)` and the
 * chart data.
 *
 * Phase 1 paints `column`/`bar` bars, `line`/`area` polylines, and
 * `pie` slices, plus an optional value-axis gridline pass, legend,
 * and title.
 */
export function drawChart(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  data: ChartElement["data"],
  theme: Theme,
  opts?: { fontScale?: number },
): void {
  const axisError = chartValueAxisError(data.valueAxis);
  if (axisError) throw new RangeError(`Cannot render chart: ${axisError}.`);
  const axisColor = resolveColor(
    { kind: "role", role: "textSecondary" },
    theme,
  );
  const gridColor = resolveColor(
    { kind: "role", role: "backgroundAlt" },
    theme,
  );

  const showLegend =
    data.legend !== undefined ? data.legend !== "none" : data.series.length > 1;
  const showTitle = Boolean(data.title);

  // A value axis (and its tick labels) exists for every kind except pie.
  const hasValueAxis =
    data.kind === "column" ||
    data.kind === "bar" ||
    data.kind === "line" ||
    data.kind === "area";
  const { domain, isPercent } = hasValueAxis
    ? chartDomain(data)
    : { domain: { min: 0, max: 1, step: 1, scale: 1 }, isPercent: false };
  const hasCategoryAxis = hasValueAxis && data.categories.length > 0;

  // Plot rectangle (leave room for value labels on the left, categories
  // below, a title band on top, and a legend band on the bottom). The
  // left margin is measured to fit the widest value-axis tick label.
  const left =
    data.kind === "bar"
      ? measureCategoryMargin(ctx, data)
      : hasValueAxis
        ? measureLeftMargin(ctx, domain, isPercent)
        : 36;
  const top = PAD + (showTitle ? 18 : 0);
  const bottom = 20 + (hasCategoryAxis ? 14 : 0) + (showLegend ? 20 : 0);
  const plot = {
    x: left,
    y: top,
    w: Math.max(0, size.w - left - PAD),
    h: Math.max(0, size.h - top - bottom),
  };
  if (plot.w <= 0 || plot.h <= 0 || data.series.length === 0) return;

  if (data.kind === "column" || data.kind === "bar") {
    drawBars(ctx, plot, data, theme, { axisColor, gridColor }, domain);
  } else if (data.kind === "line" || data.kind === "area") {
    drawLines(ctx, plot, data, theme, { axisColor, gridColor }, domain);
  } else if (data.kind === "pie") {
    drawPie(ctx, plot, data, theme);
  }

  if (hasValueAxis) {
    drawValueAxisTicks(
      ctx,
      plot,
      domain,
      isPercent,
      axisColor,
      data.kind === "bar",
    );
  }
  if (hasCategoryAxis) {
    drawCategoryLabels(ctx, plot, data, axisColor);
  }

  if (showTitle) drawTitle(ctx, size, data.title!, theme, opts?.fontScale);
  if (showLegend) drawLegend(ctx, size, data, theme);
}

type ValueDomain = { min: number; max: number; step: number };

function finiteValue(value: number | null | undefined): number {
  return Number.isFinite(value) ? value! : 0;
}

type ScaledValueDomain = ValueDomain & { scale: number };

function domainTicks(domain: ValueDomain): number[] {
  const count = Math.round((domain.max - domain.min) / domain.step);
  return Array.from({ length: count + 1 }, (_, i) => {
    if (i === 0) return domain.min;
    if (i === count) return domain.max;
    const value = domain.min + i * domain.step;
    return Math.abs(value) < domain.step * 1e-9 ? 0 : value;
  });
}

function niceDomain(
  normalizedMin: number,
  normalizedMax: number,
  scale: number,
  count = 5,
): ScaledValueDomain {
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { min: 0, max: 1, step: 1, scale: 1 };
  }
  const spanTicks = niceTicks(normalizedMax - normalizedMin, count);
  const step = spanTicks.step;
  return {
    min: Math.min(0, Math.floor(normalizedMin / step) * step),
    max: Math.max(0, Math.ceil(normalizedMax / step) * step),
    step,
    scale,
  };
}

/** Compute the value-axis domain (and whether it's percent-normalized)
 * for the value-axis chart kinds (`column`/`bar`/`line`/`area`). */
function chartDomain(data: ChartElement["data"]): {
  domain: ScaledValueDomain;
  isPercent: boolean;
} {
  const isPercent = data.grouping === "percentStacked";
  return { domain: seriesDomain(data), isPercent };
}

function seriesDomain(data: ChartElement["data"]): ScaledValueDomain {
  const stacked =
    data.grouping === "stacked" || data.grouping === "percentStacked";
  const cumulative = data.kind === "line" || data.kind === "area";
  const n = categoryAxis(data).count;
  let scale = 0;
  for (const series of data.series) {
    for (const raw of series.values)
      scale = Math.max(scale, Math.abs(finiteValue(raw)));
  }
  const hasNonzeroData = scale > 0;
  const explicitScale = Math.max(
    Math.abs(data.valueAxis?.min ?? 0),
    Math.abs(data.valueAxis?.max ?? 0),
  );
  const hasExplicitRange =
    data.valueAxis?.min !== undefined && data.valueAxis.max !== undefined;
  if (data.grouping !== "percentStacked")
    scale = hasExplicitRange ? explicitScale : Math.max(scale, explicitScale);
  if (!hasNonzeroData && !data.valueAxis)
    return { min: 0, max: 1, step: 1, scale: 1 };
  if (!(scale > 0)) scale = 1;
  let min = 0;
  let max = 0;
  for (let c = 0; c < n; c++) {
    if (stacked && cumulative) {
      // Line/area stacks use running totals, unlike diverging bar stacks.
      // Percent stacks retain signs over the total magnitude, as in PowerPoint.
      let total = 0;
      for (const series of data.series) {
        const raw = finiteValue(series.values[c]);
        total += data.grouping === "percentStacked"
          ? percentValue(data, c, raw)
          : raw / scale;
        min = Math.min(min, total);
        max = Math.max(max, total);
      }
    } else if (stacked) {
      let positive = 0;
      let negative = 0;
      for (const s of data.series) {
        const raw = finiteValue(s.values[c]);
        if (data.grouping === "percentStacked") {
          // Sign domains are independent, even when their magnitudes differ
          // by more than IEEE-754 can represent as a ratio.
          if (raw > 0) positive = 1;
          if (raw < 0) negative = -1;
        } else {
          const value = raw / scale;
          if (value >= 0) positive += value;
          else negative += value;
        }
      }
      if (data.grouping === "percentStacked") {
        positive = positive > 0 ? 1 : 0;
        negative = negative < 0 ? -1 : 0;
      }
      min = Math.min(min, negative);
      max = Math.max(max, positive);
    } else {
      for (const s of data.series) {
        const value = finiteValue(s.values[c]) / scale;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  const domainScale =
    data.grouping === "percentStacked"
      ? Math.max(1, explicitScale)
      : scale || 1;
  if (data.grouping === "percentStacked" && domainScale !== 1) {
    min /= domainScale;
    max /= domainScale;
  }
  const explicitMin = data.valueAxis?.min;
  const explicitMax = data.valueAxis?.max;
  if (explicitMin === undefined && explicitMax === undefined && min === max)
    return { min: 0, max: 1, step: 1, scale: domainScale };
  if (explicitMin !== undefined) min = explicitMin / domainScale;
  if (explicitMax !== undefined) max = explicitMax / domainScale;
  if (min >= max) {
    if (explicitMin !== undefined && explicitMax === undefined) max = min + 1;
    else if (explicitMax !== undefined && explicitMin === undefined)
      min = max - 1;
  }
  if (explicitMin !== undefined || explicitMax !== undefined) {
    const automatic = niceDomain(min, max, domainScale);
    return {
      min: explicitMin !== undefined ? min : automatic.min,
      max: explicitMax !== undefined ? max : automatic.max,
      step: niceTicks(max - min).step,
      scale: domainScale,
    };
  }
  return niceDomain(min, max, domainScale);
}

function crossingValue(
  data: ChartElement["data"],
  domain: ScaledValueDomain,
): number {
  const axis = data.valueAxis;
  let raw = 0;
  if (axis?.crossAt !== undefined) raw = axis.crossAt / domain.scale;
  else if (axis?.crosses === "min") raw = domain.min;
  else if (axis?.crosses === "max") raw = domain.max;
  return Math.max(domain.min, Math.min(domain.max, raw));
}

function percentValue(
  data: ChartElement["data"],
  category: number,
  raw: number,
): number {
  const cumulative = data.kind === "line" || data.kind === "area";
  let signScale = 0;
  for (const series of data.series) {
    const value = finiteValue(series.values[category]);
    if (cumulative || (raw < 0 ? value < 0 : value >= 0))
      signScale = Math.max(signScale, Math.abs(value));
  }
  if (!(signScale > 0)) return 0;
  let total = 0;
  for (const series of data.series) {
    const value = finiteValue(series.values[category]);
    if (cumulative || (raw < 0 ? value < 0 : value >= 0)) total += Math.abs(value) / signScale;
  }
  return total > 0 ? raw / signScale / total : 0;
}

/** Paint vertical columns or horizontal bars. */
function drawBars(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  data: ChartElement["data"],
  theme: Theme,
  colors: { axisColor: string; gridColor: string },
  domain: ScaledValueDomain,
): void {
  const isPercent = data.grouping === "percentStacked";
  const isStacked = data.grouping === "stacked" || isPercent;
  const axis = categoryAxis(data);
  const cats = axis.count;

  if (data.kind === "bar") {
    drawHorizontalBars(ctx, plot, data, theme, colors, domain);
    return;
  }

  if (data.showGridlines) drawGridlines(ctx, plot, domain, colors.gridColor);

  // Axis line.
  ctx.strokeStyle = colors.axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x, plot.y + plot.h);
  const yOf = (v: number) => yOfNormalized(v / domain.scale);
  const yOfNormalized = (v: number) =>
    plot.y +
    ((domain.max - Math.max(domain.min, Math.min(domain.max, v))) /
      (domain.max - domain.min)) *
      plot.h;
  const zeroY = yOfNormalized(Math.max(domain.min, Math.min(domain.max, 0)));
  const crossingY = yOfNormalized(crossingValue(data, domain));
  ctx.moveTo(plot.x, crossingY);
  ctx.lineTo(plot.x + plot.w, crossingY);
  ctx.stroke();

  const slot = plot.w / axis.extent;
  const groupPad = slot * 0.15;
  for (let c = 0; c < cats; c++) {
    const x0 = plot.x + axis.indexAt(c) * slot + groupPad;
    const groupW = slot - groupPad * 2;
    if (isStacked) {
      let positiveAcc = 0;
      let negativeAcc = 0;
      for (let s = 0; s < data.series.length; s++) {
        const raw = finiteValue(data.series[s].values[c]);
        const v = isPercent
          ? percentValue(data, c, raw) / domain.scale
          : raw / domain.scale;
        const start = v < 0 ? negativeAcc : positiveAcc;
        const end = start + v;
        const yStart = yOfNormalized(start);
        const yEnd = yOfNormalized(end);
        ctx.fillStyle = seriesColorAt(data, s, theme);
        ctx.fillRect(
          x0,
          Math.min(yStart, yEnd),
          groupW,
          Math.abs(yEnd - yStart),
        );
        if (v < 0) negativeAcc = end;
        else positiveAcc = end;
      }
    } else {
      const barW = groupW / data.series.length;
      for (let s = 0; s < data.series.length; s++) {
        const v = finiteValue(data.series[s].values[c]);
        const valueY = yOf(v);
        ctx.fillStyle = seriesColorAt(data, s, theme);
        ctx.fillRect(
          x0 + s * barW,
          Math.min(valueY, zeroY),
          barW,
          Math.abs(zeroY - valueY),
        );
      }
    }
  }
}

function drawHorizontalBars(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  data: ChartElement["data"],
  theme: Theme,
  colors: { axisColor: string; gridColor: string },
  domain: ScaledValueDomain,
): void {
  const isPercent = data.grouping === "percentStacked";
  const isStacked = data.grouping === "stacked" || isPercent;
  const axis = categoryAxis(data);
  if (data.showGridlines)
    drawGridlines(ctx, plot, domain, colors.gridColor, true);
  const xOf = (value: number) =>
    plot.x +
    ((Math.max(domain.min, Math.min(domain.max, value)) - domain.min) /
      (domain.max - domain.min)) *
      plot.w;
  const zeroX = xOf(Math.max(domain.min, Math.min(domain.max, 0)));
  const crossingX = xOf(crossingValue(data, domain));
  ctx.strokeStyle = colors.axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y + plot.h);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
  ctx.moveTo(crossingX, plot.y);
  ctx.lineTo(crossingX, plot.y + plot.h);
  ctx.stroke();
  const slot = plot.h / axis.extent;
  const pad = slot * 0.15;
  for (let c = 0; c < axis.count; c++) {
    const y0 = plot.y + axis.indexAt(c) * slot + pad;
    const groupH = slot - pad * 2;
    if (isStacked) {
      let positive = 0;
      let negative = 0;
      for (let s = 0; s < data.series.length; s++) {
        const raw = finiteValue(data.series[s].values[c]);
        const value = isPercent
          ? percentValue(data, c, raw) / domain.scale
          : raw / domain.scale;
        const start = value < 0 ? negative : positive;
        const end = start + value;
        const x0 = xOf(start);
        const x1 = xOf(end);
        ctx.fillStyle = seriesColorAt(data, s, theme);
        ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), groupH);
        if (value < 0) negative = end;
        else positive = end;
      }
    } else {
      const barH = groupH / data.series.length;
      for (let s = 0; s < data.series.length; s++) {
        const valueX = xOf(
          finiteValue(data.series[s].values[c]) / domain.scale,
        );
        ctx.fillStyle = seriesColorAt(data, s, theme);
        ctx.fillRect(
          Math.min(valueX, zeroX),
          y0 + s * barH,
          Math.abs(zeroX - valueX),
          barH,
        );
      }
    }
  }
}

type PlotRect = { x: number; y: number; w: number; h: number };

/** Draw horizontal value-axis gridlines at each `niceTicks` step. */
function drawGridlines(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  domain: ScaledValueDomain,
  color: string,
  horizontalValueAxis = false,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const v of domainTicks(domain)) {
    if (Math.abs(v) < domain.step * 1e-9) continue;
    const ratio = (v - domain.min) / (domain.max - domain.min);
    ctx.beginPath();
    if (horizontalValueAxis) {
      const x = plot.x + ratio * plot.w;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    } else {
      const y = plot.y + (1 - ratio) * plot.h;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();
  }
}

/**
 * Draw numeric value-axis tick labels to the left of the plot, one per
 * the domain's nice step from its minimum through maximum. Independent of
 * `showGridlines` —
 * PowerPoint always shows axis numbers even without gridlines.
 */
function drawValueAxisTicks(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  domain: ScaledValueDomain,
  isPercent: boolean,
  color: string,
  horizontal = false,
): void {
  ctx.fillStyle = color;
  ctx.font = VALUE_TICK_FONT;
  ctx.textAlign = horizontal ? "center" : "right";
  ctx.textBaseline = horizontal ? "top" : "middle";
  for (const v of domainTicks(domain)) {
    if (horizontal) {
      const x =
        plot.x + ((v - domain.min) / (domain.max - domain.min)) * plot.w;
      ctx.fillText(
        formatTick(v, isPercent, domain.scale),
        x,
        plot.y + plot.h + 4,
      );
    } else {
      const y =
        plot.y + ((domain.max - v) / (domain.max - domain.min)) * plot.h;
      ctx.fillText(formatTick(v, isPercent, domain.scale), plot.x - 6, y);
    }
  }
}

/**
 * Draw category-axis labels centered under each bar-group slot
 * (column/bar) or data point (line/area), just below the plot's bottom
 * edge. Only draws labels present in `data.categories`; skips a label
 * that would visibly overflow into its neighbor's slot.
 */
function drawCategoryLabels(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  data: ChartElement["data"],
  color: string,
): void {
  const cats = data.categories.length;
  if (cats === 0) return;
  ctx.fillStyle = color;
  ctx.font = CATEGORY_LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const y = plot.y + plot.h + 4;
  if (data.kind === "bar") {
    const axis = categoryAxis(data);
    const slot = plot.h / axis.extent;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let c = 0; c < cats; c++) {
      ctx.fillText(
        data.categories[c],
        plot.x - 6,
        plot.y + axis.indexAt(c) * slot + slot / 2,
      );
    }
    return;
  }
  const isPointBased = data.kind === "line" || data.kind === "area";
  const axis = categoryAxis(data);
  const slot = plot.w / axis.extent;
  for (let c = 0; c < cats; c++) {
    const label = data.categories[c];
    const x = isPointBased
      ? plot.x +
        (axis.extent <= 1
          ? plot.w / 2
          : (axis.indexAt(c) / (axis.extent - 1)) * plot.w)
      : plot.x + axis.indexAt(c) * slot + slot / 2;
    if (ctx.measureText(label).width > slot - 2) continue;
    ctx.fillText(label, x, y);
  }
}

type ValuePoint = { x: number; value: number };

function finiteSum(a: number, b: number): number {
  const sum = a + b;
  return Number.isFinite(sum) ? sum : Math.sign(sum) * Number.MAX_VALUE;
}

function finiteProduct(a: number, b: number): number {
  const product = a * b;
  return Number.isFinite(product)
    ? product
    : Math.sign(a) * Math.sign(b) * Number.MAX_VALUE;
}

function intersectValue(
  a: ValuePoint,
  b: ValuePoint,
  boundary: number,
): ValuePoint {
  const scale = Math.max(
    Math.abs(a.value),
    Math.abs(b.value),
    Math.abs(boundary),
  );
  const start = scale > 0 ? a.value / scale : 0;
  const delta = scale > 0 ? b.value / scale - start : 0;
  const fraction = delta === 0 ? 0 : (boundary / scale - start) / delta;
  const t = Math.max(0, Math.min(1, fraction));
  return { x: a.x + (b.x - a.x) * t, value: boundary };
}

function clipPolygonAt(
  points: ValuePoint[],
  boundary: number,
  inside: (value: number, boundary: number) => boolean,
): ValuePoint[] {
  const result: ValuePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const previous = points[(i + points.length - 1) % points.length];
    const currentInside = inside(current.value, boundary);
    const previousInside = inside(previous.value, boundary);
    if (currentInside !== previousInside)
      result.push(intersectValue(previous, current, boundary));
    if (currentInside) result.push(current);
  }
  return result;
}

function clipValuePolygon(
  points: ValuePoint[],
  min: number,
  max: number,
): ValuePoint[] {
  return clipPolygonAt(
    clipPolygonAt(points, min, (value, boundary) => value >= boundary),
    max,
    (value, boundary) => value <= boundary,
  );
}

function clipValueSegment(
  a: ValuePoint,
  b: ValuePoint,
  min: number,
  max: number,
): [ValuePoint, ValuePoint] | undefined {
  if ((a.value < min && b.value < min) || (a.value > max && b.value > max))
    return undefined;
  const start =
    a.value < min
      ? intersectValue(a, b, min)
      : a.value > max
        ? intersectValue(a, b, max)
        : a;
  const end =
    b.value < min
      ? intersectValue(a, b, min)
      : b.value > max
        ? intersectValue(a, b, max)
        : b;
  return [start, end];
}

function valueRatio(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const scale = Math.max(Math.abs(value), Math.abs(min), Math.abs(max));
  const lo = min / scale;
  return (value / scale - lo) / (max / scale - lo);
}

/** Paint line and area charts, clipping raw values before pixel projection. */
function drawLines(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  data: ChartElement["data"],
  theme: Theme,
  colors: { axisColor: string; gridColor: string },
  domain: ScaledValueDomain,
): void {
  const axis = categoryAxis(data);
  const cats = axis.count;
  if (cats === 0) return;
  if (data.showGridlines) drawGridlines(ctx, plot, domain, colors.gridColor);

  // Axis line.
  ctx.strokeStyle = colors.axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x, plot.y + plot.h);
  const usesRawAxis =
    data.valueAxis?.min !== undefined || data.valueAxis?.max !== undefined;
  const rawMin =
    data.valueAxis?.min ??
    (usesRawAxis ? finiteProduct(domain.min, domain.scale) : domain.min);
  const rawMax =
    data.valueAxis?.max ??
    (usesRawAxis ? finiteProduct(domain.max, domain.scale) : domain.max);
  const yOfRaw = (value: number) =>
    plot.y + (1 - valueRatio(value, rawMin, rawMax)) * plot.h;
  const crossingY = yOfRaw(
    crossingValue(data, domain) * (usesRawAxis ? domain.scale : 1),
  );
  ctx.moveTo(plot.x, crossingY);
  ctx.lineTo(plot.x + plot.w, crossingY);
  ctx.stroke();

  const xOf = (index: number) =>
    plot.x +
    (axis.extent <= 1 ? plot.w / 2 : (index / (axis.extent - 1)) * plot.w);

  const isPercent = data.grouping === "percentStacked";
  const isStacked = data.grouping === "stacked" || isPercent;
  const cumulative = Array(cats).fill(0) as number[];
  for (let s = 0; s < data.series.length; s++) {
    const col = seriesColorAt(data, s, theme);
    const vals = data.series[s].values;

    // Missing cache coordinates have the same zero baseline as nulls in a
    // dense chart. Two endpoints represent an entire empty interval exactly.
    const points: Array<{ index: number; start: number; end: number }> = [];
    let previous = -1;
    for (let c = 0; c < cats; c++) {
      const index = axis.indexAt(c);
      if (index > previous + 1) {
        points.push({ index: previous + 1, start: 0, end: 0 });
        if (index > previous + 2)
          points.push({ index: index - 1, start: 0, end: 0 });
      }
      const raw = finiteValue(vals[c]);
      const value = isPercent
        ? percentValue(data, c, raw)
        : usesRawAxis
          ? raw
          : raw / domain.scale;
      const start = isStacked ? cumulative[c] : 0;
      const end = finiteSum(start, value);
      points.push({ index, start, end });
      if (isStacked) cumulative[c] = end;
      previous = index;
    }
    const endPoints = points.map((point) => ({
      x: xOf(point.index),
      value: point.end,
    }));

    if (data.kind === "area") {
      const polygon = clipValuePolygon(
        [
          ...endPoints,
          ...points
            .slice()
            .reverse()
            .map((point) => ({ x: xOf(point.index), value: point.start })),
        ],
        rawMin,
        rawMax,
      );
      ctx.beginPath();
      polygon.forEach((point, i) => {
        if (i === 0) ctx.moveTo(point.x, yOfRaw(point.value));
        else ctx.lineTo(point.x, yOfRaw(point.value));
      });
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    for (let i = 1; i < endPoints.length; i++) {
      const segment = clipValueSegment(
        endPoints[i - 1],
        endPoints[i],
        rawMin,
        rawMax,
      );
      if (!segment) continue;
      ctx.moveTo(segment[0].x, yOfRaw(segment[0].value));
      ctx.lineTo(segment[1].x, yOfRaw(segment[1].value));
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** Paint a `pie` chart from the first series only, skipping axis/gridlines. */
function drawPie(
  ctx: CanvasRenderingContext2D,
  plot: PlotRect,
  data: ChartElement["data"],
  theme: Theme,
): void {
  const vals = (data.series[0]?.values ?? []).map((v) => Math.max(0, v ?? 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const r = Math.min(plot.w, plot.h) / 2;
  let a0 = -Math.PI / 2;
  const axis = categoryAxis(data);
  for (let i = 0; i < vals.length; i++) {
    const a1 = a0 + (vals[i] / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = seriesColorAt(data, axis.indexAt(i), theme);
    ctx.fill();
    a0 = a1;
  }
}

/** Draw a centered chart title in the reserved top band. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  title: string,
  theme: Theme,
  fontScale?: number,
): void {
  ctx.fillStyle = resolveColor({ kind: "role", role: "text" }, theme);
  ctx.font = `${14 * (fontScale ?? 1)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(title, size.w / 2, 2);
}

/**
 * Draw a left-aligned swatch + label legend in the reserved bottom band.
 *
 * Swatches are small filled squares (`fillRect`), matching PowerPoint/
 * Google Sheets legend styling. A pie has one (usually unnamed) series, so
 * its legend lists the *categories* (one per slice) instead of the series.
 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  data: ChartElement["data"],
  theme: Theme,
): void {
  const axis = categoryAxis(data);
  const items =
    data.kind === "pie"
      ? data.categories.map((label, i) => ({
          label: label || `Slice ${axis.indexAt(i) + 1}`,
          i: axis.indexAt(i),
        }))
      : data.series.map((s, i) => ({ label: s.name ?? `Series ${i + 1}`, i }));
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let x = 40;
  const y = size.h - 8;
  const swatch = 10;
  for (const it of items) {
    ctx.fillStyle = seriesColorAt(data, it.i, theme);
    ctx.fillRect(x, y - 5, swatch, swatch);
    ctx.fillStyle = resolveColor({ kind: "role", role: "text" }, theme);
    ctx.fillText(it.label, x + swatch + 4, y);
    x += swatch + 4 + ctx.measureText(it.label).width + 16;
  }
}
