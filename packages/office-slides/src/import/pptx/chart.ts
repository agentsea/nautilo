import type { SlideParseContext } from "./shape";
import {
  attr,
  attrInt,
  child,
  children,
  descendant,
  NS,
  parseXml,
} from "./xml";
import { parseXfrm } from "./geometry";
import { resolveRelsTarget } from "./rels";
import { readAltText } from "./effects";
import { generateId } from "../../model/element";
import type {
  ChartElement,
  ChartGrouping,
  ChartSeries,
  ChartValueAxis,
  Element as SlideElement,
} from "../../model/element";
import type { ThemeColor } from "../../model/theme";
import { chartValueAxisError } from "../../model/chart";

export const CHART_URI =
  "http://schemas.openxmlformats.org/drawingml/2006/chart";

const GROUPINGS: ReadonlySet<string> = new Set([
  "clustered",
  "stacked",
  "percentStacked",
  "standard",
]);

// c:pt@idx is xsd:unsignedInt (OOXML CT_NumVal / CT_StrVal).
// https://www.w3.org/TR/xmlschema-2/#unsignedInt
const MAX_POINT_INDEX = 4_294_967_295;

/**
 * Read a `<c:*Cache>` / `<c:*Lit>` into a sparse map keyed by `<c:pt idx>`.
 * OOXML defines `idx` as an unsigned point index and `ptCount` as the number
 * of cached values, not the greatest permitted index. Keeping the source
 * coordinate sparse avoids allocating or iterating up to an untrusted index.
 */
function readPoints(cacheParent: Element | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!cacheParent) return out;
  const pts = children(cacheParent, "pt");
  for (const pt of pts) {
    const idx = attrInt(pt, "idx");
    // CT_NumVal / CT_StrVal require an unsignedInt idx. Surface malformed
    // chart data so parseChartFrame takes its reported placeholder path;
    // silently discarding a point would make the import look complete.
    const lexical = attr(pt, "idx")?.trim() ?? "";
    if (
      !/^[+-]?\d+$/u.test(lexical) ||
      idx === undefined ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx > MAX_POINT_INDEX
    ) {
      throw new RangeError(
        "Cannot import chart cache point: c:pt@idx must be an unsigned integer.",
      );
    }
    if (out.has(idx))
      throw new Error(
        `Cannot import chart cache: duplicate point index ${idx}.`,
      );
    const v = child(pt, "v")?.textContent ?? "";
    out.set(idx, v);
  }
  return out;
}

/** A `<c:tx>`/`<c:cat>`/`<c:val>` wrapper → cached or literal points. */
function pointStrings(ref: Element | undefined): Map<number, string> {
  if (!ref) return new Map();
  const points =
    descendant(ref, "strCache") ??
    descendant(ref, "numCache") ??
    descendant(ref, "strLit") ??
    descendant(ref, "numLit");
  return readPoints(points);
}

/**
 * Series name from `<c:tx>`. Usually a `<c:strRef>`/`<c:strCache>` (or
 * `<c:numCache>`) wrapper, but a series title can also be a literal
 * `<c:tx><c:v>Revenue</c:v></c:tx>` with no cache wrapper at all — fall
 * back to that direct `<c:v>` text so the legend doesn't show "Series 1".
 */
function seriesName(tx: Element | undefined): string | undefined {
  if (!tx) return undefined;
  const cached = [...pointStrings(tx).entries()].sort(
    (a, b) => a[0] - b[0],
  )[0]?.[1];
  if (cached) return cached;
  return child(tx, "v")?.textContent?.trim() || undefined;
}

/** Series solid-fill color → ThemeColor, or undefined for the accent cycle. */
function seriesColor(ser: Element): ThemeColor | undefined {
  const spPr = child(ser, "spPr");
  const solid = spPr ? child(spPr, "solidFill") : undefined;
  const srgb = solid ? child(solid, "srgbClr") : undefined;
  const val = srgb ? attr(srgb, "val") : undefined;
  if (val) return { kind: "srgb", value: `#${val.toUpperCase()}` };
  // schemeClr resolution (theme reference) is a Phase-2 refinement; the
  // painter's accent cycle covers the common "no explicit color" case.
  return undefined;
}

type SparseSeries = {
  name?: string;
  values: Map<number, string>;
  color?: ThemeColor;
};

function parseSparseSeries(ser: Element): SparseSeries {
  const name = seriesName(child(ser, "tx"));
  const values = pointStrings(child(ser, "val"));
  const color = seriesColor(ser);
  return color ? { name, values, color } : { name, values };
}

/**
 * Convert sparse OOXML coordinates into the native chart's dense positional
 * arrays. The sorted union retains every represented point and keeps category
 * and series values aligned by their original idx. Unrepresented gaps create
 * no array slots, so even an adversarially large idx remains bounded by the
 * number of `<c:pt>` elements in the input.
 */
function materializeSeries(
  categoriesByIndex: Map<number, string>,
  sparseSeries: SparseSeries[],
): Pick<ChartElement["data"], "categories" | "categoryIndices" | "series"> {
  const indices = new Set(categoriesByIndex.keys());
  for (const series of sparseSeries) {
    for (const idx of series.values.keys()) indices.add(idx);
  }
  const ordered = [...indices].sort((a, b) => a - b);
  const categories = ordered.map((idx) => categoriesByIndex.get(idx) ?? "");
  const series: ChartSeries[] = sparseSeries.map((source) => {
    const values = ordered.map((idx) => {
      const raw = source.values.get(idx);
      if (raw == null || raw === "") return null;
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    });
    return source.color
      ? { name: source.name, values, color: source.color }
      : { name: source.name, values };
  });
  const dense = ordered.every((idx, position) => idx === position);
  return dense
    ? { categories, series }
    : { categories, categoryIndices: ordered, series };
}

function parseBarChart(plot: Element): ChartElement["data"] {
  const barDir = child(plot, "barDir");
  const dir = (barDir ? attr(barDir, "val") : undefined) ?? "col";
  const kind = dir === "bar" ? "bar" : "column";
  const groupingEl = child(plot, "grouping");
  const groupingRaw = groupingEl ? attr(groupingEl, "val") : undefined;
  const grouping: ChartGrouping | undefined =
    groupingRaw && GROUPINGS.has(groupingRaw)
      ? (groupingRaw as ChartGrouping)
      : undefined;
  const sers = children(plot, "ser");
  const sparseSeries = sers.map(parseSparseSeries);
  // Guard child(sers[0], ...) since child does not accept undefined.
  const categoriesByIndex = pointStrings(
    sers[0] ? child(sers[0], "cat") : undefined,
  );
  const materialized = materializeSeries(categoriesByIndex, sparseSeries);
  return { kind, grouping, ...materialized };
}

const LEGEND_POS: Record<string, ChartElement["data"]["legend"]> = {
  t: "top",
  b: "bottom",
  l: "left",
  r: "right",
  // PowerPoint's default legend position is top-right; our model has no
  // corner positions, so map the corner to its closest edge.
  tr: "right",
};

function parseCartesian(
  plot: Element,
  kind: "line" | "area",
): ChartElement["data"] {
  const groupingEl = child(plot, "grouping");
  const groupingRaw = groupingEl ? attr(groupingEl, "val") : undefined;
  const grouping =
    groupingRaw && GROUPINGS.has(groupingRaw)
      ? (groupingRaw as ChartGrouping)
      : undefined;
  const sers = children(plot, "ser");
  const sparseSeries = sers.map(parseSparseSeries);
  // Guard child(sers[0], ...) since child does not accept undefined.
  const categoriesByIndex = pointStrings(
    sers[0] ? child(sers[0], "cat") : undefined,
  );
  const materialized = materializeSeries(categoriesByIndex, sparseSeries);
  return { kind, grouping, ...materialized };
}

function parsePieChart(plot: Element): ChartElement["data"] {
  const sers = children(plot, "ser");
  const sparseSeries = sers.map(parseSparseSeries);
  const categoriesByIndex = pointStrings(
    sers[0] ? child(sers[0], "cat") : undefined,
  );
  const materialized = materializeSeries(categoriesByIndex, sparseSeries);
  return { kind: "pie", ...materialized };
}

/**
 * Concatenate `<a:t>` runs under `<c:title>`. Walks via the local-name
 * `children`/`descendant` helpers (not raw `getElementsByTagName('a:t')`)
 * so the lookup stays namespace-agnostic, matching every other traversal
 * in this module.
 */
function parseTitle(chart: Element): string | undefined {
  const title = child(chart, "title");
  if (!title) return undefined;
  const rich = descendant(title, "rich") ?? descendant(title, "tx");
  if (!rich) return undefined;
  const all = rich.getElementsByTagName("*");
  let text = "";
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === "t") text += all[i].textContent ?? "";
  }
  return text.trim() || undefined;
}

/**
 * Map a parsed `chartN.xml` Document to `ChartElement['data']`, or
 * `undefined` when the first plot family is not supported in Phase 1
 * (the caller then inserts a placeholder + bumps the report).
 * Frame/position is owned by the host `<p:graphicFrame>`, not here.
 */
export function parseChartXml(
  chartDoc: Document,
  ctx: SlideParseContext,
): ChartElement["data"] | undefined {
  void ctx; // reserved for schemeClr/theme resolution in Phase 2
  const chart = descendant(chartDoc, "chart");
  const plotArea = chart ? child(chart, "plotArea") : undefined;
  if (!chart || !plotArea) return undefined;

  let data: ChartElement["data"] | undefined;
  const bar = child(plotArea, "barChart");
  const line = child(plotArea, "lineChart");
  const area = child(plotArea, "areaChart");
  const pie = child(plotArea, "pieChart");
  if (bar) data = parseBarChart(bar);
  else if (line) data = parseCartesian(line, "line");
  else if (area) data = parseCartesian(area, "area");
  else if (pie) data = parsePieChart(pie);
  if (!data) return undefined; // unsupported family → caller placeholders

  const title = parseTitle(chart);
  if (title) data.title = title;

  const legendPosEl = descendant(chart, "legendPos");
  const legendPos = legendPosEl ? attr(legendPosEl, "val") : undefined;
  if (child(chart, "legend")) {
    data.legend = (legendPos && LEGEND_POS[legendPos]) || "bottom";
  }

  const valAx = descendant(plotArea, "valAx");
  if (valAx && child(valAx, "majorGridlines")) data.showGridlines = true;
  if (valAx) {
    const scaling = child(valAx, "scaling");
    const minEl = scaling ? child(scaling, "min") : undefined;
    const maxEl = scaling ? child(scaling, "max") : undefined;
    const minRaw = minEl ? attr(minEl, "val") : undefined;
    const maxRaw = maxEl ? attr(maxEl, "val") : undefined;
    const min = minRaw === undefined ? Number.NaN : Number(minRaw);
    const max = maxRaw === undefined ? Number.NaN : Number(maxRaw);
    const crossAxEl = child(valAx, "crossAx");
    const categoryAxisId = crossAxEl ? attr(crossAxEl, "val") : undefined;
    const categoryAxes = children(plotArea, "catAx");
    const catAx = categoryAxes.find((candidate) => {
      const id = child(candidate, "axId");
      return (
        categoryAxisId === undefined ||
        (id && attr(id, "val") === categoryAxisId)
      );
    });
    const crossesEl = catAx ? child(catAx, "crosses") : undefined;
    const crossAtEl = catAx ? child(catAx, "crossesAt") : undefined;
    const crossesRaw = crossesEl ? attr(crossesEl, "val") : undefined;
    const crossAtRaw = crossAtEl ? attr(crossAtEl, "val") : undefined;
    const crossAt = crossAtRaw === undefined ? Number.NaN : Number(crossAtRaw);
    const crosses: ChartValueAxis["crosses"] =
      crossesRaw === "autoZero" || crossesRaw === "min" || crossesRaw === "max"
        ? crossesRaw
        : undefined;
    if (
      Number.isFinite(min) ||
      Number.isFinite(max) ||
      crosses ||
      Number.isFinite(crossAt)
    ) {
      const valueAxis = {
        ...(Number.isFinite(min) ? { min } : {}),
        ...(Number.isFinite(max) ? { max } : {}),
        ...(crosses ? { crosses } : {}),
        ...(Number.isFinite(crossAt) ? { crossAt } : {}),
      };
      const error = chartValueAxisError(valueAxis);
      if (error) throw new RangeError(`Cannot import chart: ${error}.`);
      data.valueAxis = valueAxis;
    }
  }

  return data;
}

/**
 * Grey placeholder rect for a `<p:graphicFrame>` this importer can't
 * paint natively — an unsupported chart plot family, a missing/malformed
 * chart part, or (via `shape.ts`'s dispatcher) a non-chart, non-table
 * graphicData kind such as chartex, a diagram/SmartArt, or an OLE object.
 * Exported so `shape.ts` can reuse the exact same rect rather than
 * duplicating the literal.
 */
export function graphicFramePlaceholder(
  graphicFrame: Element,
  ctx: SlideParseContext,
): SlideElement {
  const xfrm = parseXfrm(child(graphicFrame, "xfrm"), ctx.scale);
  return {
    id: generateId(),
    type: "shape",
    frame: xfrm,
    data: {
      kind: "rect",
      fill: { kind: "srgb", value: "#E6E6E6" },
      stroke: { color: { kind: "srgb", value: "#B0B0B0" }, width: 1 },
    },
  };
}

/**
 * Parse a `<p:graphicFrame>` whose `graphicData@uri` is the chart URI.
 * Resolves `<c:chart r:id>` → `ppt/charts/chartN.xml`, maps it, and
 * positions the resulting ChartElement with the frame's xfrm. Falls back
 * to a reported placeholder when the part is missing or the plot family
 * is unsupported.
 */
export async function parseChartFrame(
  graphicFrame: Element,
  ctx: SlideParseContext,
): Promise<SlideElement[]> {
  const chartRef = descendant(graphicFrame, "chart");
  // Match image.ts's `parseBlipFill` technique: try the namespace-aware
  // lookup first so a deck that binds the relationships namespace to a
  // prefix other than the conventional `r:` still resolves, then fall
  // back to the literal `r:id` (and bare `id`) attribute names.
  const rid = chartRef
    ? chartRef.getAttributeNS(NS.R, "id") ||
      attr(chartRef, "r:id") ||
      attr(chartRef, "id") ||
      undefined
    : undefined;
  const rel = rid ? ctx.rels.get(rid) : undefined;
  if (!rel) {
    ctx.report.unsupportedCharts++;
    return [graphicFramePlaceholder(graphicFrame, ctx)];
  }
  const partPath = resolveRelsTarget(ctx.slidePartPath, rel.target);
  // A missing part, malformed XML (parseXml throws on `<parsererror>`),
  // or any other unexpected failure while reading/mapping the chart part
  // must not abort the whole import — fall back to the same placeholder
  // path used for a missing/unsupported part.
  let data: ChartElement["data"] | undefined;
  try {
    const xml = await ctx.archive.readText(partPath);
    data = xml ? parseChartXml(parseXml(xml), ctx) : undefined;
  } catch {
    data = undefined;
  }
  if (!data) {
    ctx.report.unsupportedCharts++;
    return [graphicFramePlaceholder(graphicFrame, ctx)];
  }
  const xfrm = parseXfrm(child(graphicFrame, "xfrm"), ctx.scale);
  const alt = readAltText(graphicFrame);
  if (alt) data.alt = alt;
  ctx.report.importedCharts++;
  return [{ id: generateId(), type: "chart", frame: xfrm, data }];
}
