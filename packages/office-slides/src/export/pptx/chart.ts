import JSZip from "jszip";
import type {
  ChartElement,
  ChartGrouping,
  ChartLegendPos,
} from "../../model/element.js";
import { solidFillXml } from "./color.js";
import { pxToEmuX, pxToEmuY } from "./units.js";
import { escapeXmlAttr, escapeXmlText } from "./xml.js";
import { chartValueAxisError } from "../../model/chart.js";

const CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const MAX_POINT_INDEX = 4_294_967_295;
const MAX_WORKSHEET_ROW = 1_048_576;
const MAX_WORKSHEET_SERIES = 16_383; // XFD minus the category column.
const CHART_KINDS = new Set(["column", "bar", "line", "area", "pie"]);
const CHART_GROUPINGS = new Set([
  "clustered",
  "stacked",
  "percentStacked",
  "standard",
]);
const CHART_LEGENDS = new Set(["none", "top", "bottom", "left", "right"]);

function coordinates(el: ChartElement): number[] {
  if (!CHART_KINDS.has(el.data.kind))
    throw new Error(
      `Cannot export chart "${el.id}": unsupported chart kind "${el.data.kind}".`,
    );
  if (el.data.grouping && !CHART_GROUPINGS.has(el.data.grouping))
    throw new Error(
      `Cannot export chart "${el.id}": unsupported grouping "${el.data.grouping}".`,
    );
  if (el.data.legend && !CHART_LEGENDS.has(el.data.legend))
    throw new Error(
      `Cannot export chart "${el.id}": unsupported legend position "${el.data.legend}".`,
    );
  if (el.data.effects)
    throw new Error(
      `Cannot export chart "${el.id}": chart effects are not supported.`,
    );
  if (el.data.series.length > MAX_WORKSHEET_SERIES)
    throw new Error(
      `Cannot export chart "${el.id}": too many series for an editable worksheet.`,
    );
  if (el.data.kind === "pie" && (el.data.grouping || el.data.showGridlines)) {
    throw new Error(
      `Cannot export chart "${el.id}": pie charts do not support grouping or gridlines.`,
    );
  }
  if (
    (el.data.kind === "line" || el.data.kind === "area") &&
    el.data.grouping === "clustered"
  ) {
    throw new Error(
      `Cannot export chart "${el.id}": ${el.data.kind} charts do not support clustered grouping.`,
    );
  }
  const axis = el.data.valueAxis;
  const axisError = chartValueAxisError(axis);
  if (axisError)
    throw new Error(`Cannot export chart "${el.id}": ${axisError}.`);
  const count = el.data.categories.length;
  for (const series of el.data.series) {
    if (series.values.length !== count)
      throw new Error(
        `Cannot export chart "${el.id}": series lengths must match categories.`,
      );
    if (
      series.values.some((value) => value !== null && !Number.isFinite(value))
    ) {
      throw new Error(
        `Cannot export chart "${el.id}": series values must be finite numbers or null.`,
      );
    }
  }
  const indices =
    el.data.categoryIndices ??
    Array.from({ length: count }, (_, index) => index);
  if (
    indices.length !== count ||
    new Set(indices).size !== indices.length ||
    indices.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index > MAX_POINT_INDEX,
    )
  ) {
    throw new Error(
      `Cannot export chart "${el.id}": category indices must be unique unsigned integers.`,
    );
  }
  if (indices.some((index) => index + 2 > MAX_WORKSHEET_ROW)) {
    throw new Error(
      `Cannot export chart "${el.id}": category index exceeds the editable worksheet row limit.`,
    );
  }
  return indices;
}

function columnName(index: number): string {
  let value = index + 1;
  let out = "";
  while (value > 0) {
    value--;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function strCache(values: string[], indices: number[]): string {
  const pointCount = indices.reduce(
    (count, index) => Math.max(count, index + 1),
    0,
  );
  return `<c:strCache><c:ptCount val="${pointCount}"/>${values
    .map(
      (value, i) =>
        `<c:pt idx="${indices[i]}"><c:v>${escapeXmlText(value)}</c:v></c:pt>`,
    )
    .join("")}</c:strCache>`;
}

function numCache(values: (number | null)[], indices: number[]): string {
  const pointCount = indices.reduce(
    (count, index) => Math.max(count, index + 1),
    0,
  );
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${pointCount}"/>${values
    .map((value, i) =>
      value === null
        ? ""
        : `<c:pt idx="${indices[i]}"><c:v>${value}</c:v></c:pt>`,
    )
    .join("")}</c:numCache>`;
}

const LEGEND: Record<Exclude<ChartLegendPos, "none">, string> = {
  top: "t",
  bottom: "b",
  left: "l",
  right: "r",
};

function seriesXml(el: ChartElement, indices: number[]): string {
  // Avoid spreading document-controlled data into a call. JavaScript engines
  // impose an implementation-specific argument limit well below Excel's row
  // limit, so a valid large chart must be reduced iteratively.
  let maxRow = 2;
  for (const index of indices) maxRow = Math.max(maxRow, index + 2);
  return el.data.series
    .map((series, seriesIndex) => {
      const col = columnName(seriesIndex + 1);
      const name = series.name ?? `Series ${seriesIndex + 1}`;
      const color = series.color
        ? `<c:spPr>${solidFillXml(series.color)}</c:spPr>`
        : "";
      // Do not inherit producer-dependent viewer defaults: LibreOffice can
      // interpret an omitted setting as inverted (positive) negative bars.
      const inversion = el.data.kind === "bar" || el.data.kind === "column"
        ? '<c:invertIfNegative val="0"/>'
        : "";
      return (
        `<c:ser><c:idx val="${seriesIndex}"/><c:order val="${seriesIndex}"/>` +
        `<c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f>${strCache([name], [0])}</c:strRef></c:tx>${color}${inversion}` +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${maxRow}</c:f>${strCache(el.data.categories, indices)}</c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${maxRow}</c:f>${numCache(series.values, indices)}</c:numRef></c:val>` +
        `</c:ser>`
      );
    })
    .join("");
}

export function chartToXml(
  el: ChartElement,
  workbookRId: string,
  chartIndex: number,
): string {
  const indices = coordinates(el);
  const series = seriesXml(el, indices);
  const grouping: ChartGrouping =
    el.data.grouping ??
    (el.data.kind === "line" || el.data.kind === "area"
      ? "standard"
      : "clustered");
  const catAxId = 10_000_000 + chartIndex * 2;
  const valAxId = catAxId + 1;
  let plot: string;
  if (el.data.kind === "pie") {
    plot = `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart>`;
  } else if (el.data.kind === "column" || el.data.kind === "bar") {
    plot = `<c:barChart><c:barDir val="${el.data.kind === "bar" ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:axId val="${catAxId}"/><c:axId val="${valAxId}"/></c:barChart>`;
  } else {
    const tag = el.data.kind === "line" ? "lineChart" : "areaChart";
    plot = `<c:${tag}><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:axId val="${catAxId}"/><c:axId val="${valAxId}"/></c:${tag}>`;
  }
  const catAxisPosition = el.data.kind === "bar" ? "l" : "b";
  const valAxisPosition = el.data.kind === "bar" ? "b" : "l";
  const axis = el.data.valueAxis;
  const scaling = `<c:scaling><c:orientation val="minMax"/>${axis?.max !== undefined ? `<c:max val="${axis.max}"/>` : ""}${axis?.min !== undefined ? `<c:min val="${axis.min}"/>` : ""}</c:scaling>`;
  const crossing =
    axis?.crossAt !== undefined
      ? `<c:crossesAt val="${axis.crossAt}"/>`
      : `<c:crosses val="${axis?.crosses ?? "autoZero"}"/>`;
  const axes =
    el.data.kind === "pie"
      ? ""
      : `<c:catAx><c:axId val="${catAxId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catAxisPosition}"/><c:crossAx val="${valAxId}"/>${crossing}<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>` +
        `<c:valAx><c:axId val="${valAxId}"/>${scaling}<c:delete val="0"/><c:axPos val="${valAxisPosition}"/>${el.data.showGridlines ? "<c:majorGridlines/>" : ""}<c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${catAxId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const title = el.data.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXmlText(el.data.title)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>`
    : "";
  const legend =
    el.data.legend && el.data.legend !== "none"
      ? `<c:legend><c:legendPos val="${LEGEND[el.data.legend]}"/><c:layout/><c:overlay val="0"/></c:legend>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:externalData r:id="${workbookRId}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}

export function chartFrameToXml(el: ChartElement, chartRId: string): string {
  const { frame } = el;
  if (
    ![
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      frame.rotation,
      pxToEmuX(frame.x),
      pxToEmuY(frame.y),
      pxToEmuX(frame.w),
      pxToEmuY(frame.h),
    ].every(Number.isFinite) ||
    frame.w < 0 ||
    frame.h < 0
  ) {
    throw new Error(
      `Cannot export chart "${el.id}": chart frame coordinates must be finite with non-negative dimensions.`,
    );
  }
  if (frame.rotation || frame.flipH || frame.flipV) {
    throw new Error(
      `Cannot export chart "${el.id}": rotated or flipped chart frames are not supported.`,
    );
  }
  const descr = el.data.alt ? ` descr="${escapeXmlAttr(el.data.alt)}"` : "";
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="0" name="${escapeXmlAttr(el.id)}"${descr}/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${pxToEmuX(frame.x)}" y="${pxToEmuY(frame.y)}"/><a:ext cx="${pxToEmuX(frame.w)}" cy="${pxToEmuY(frame.h)}"/></p:xfrm><a:graphic><a:graphicData uri="${CHART_URI}"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${chartRId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

export async function chartWorkbook(el: ChartElement): Promise<Uint8Array> {
  const indices = coordinates(el);
  const rows = new Map<number, string[]>();
  rows.set(1, [
    "",
    ...el.data.series.map((series, i) => series.name ?? `Series ${i + 1}`),
  ]);
  indices.forEach((index, i) =>
    rows.set(index + 2, [
      el.data.categories[i],
      ...el.data.series.map((series) =>
        series.values[i] === null ? "" : String(series.values[i]),
      ),
    ]),
  );
  const sheetRows = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([row, values]) =>
        `<row r="${row}">${values.map((value, col) => (value === "" ? "" : col === 0 || row === 1 ? `<c r="${columnName(col)}${row}" t="inlineStr"><is><t>${escapeXmlText(value)}</t></is></c>` : `<c r="${columnName(col)}${row}"><v>${value}</v></c>`)).join("")}</row>`,
    )
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
}
