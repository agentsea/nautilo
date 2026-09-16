// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { exportPptx } from "../../../src/export/pptx/index.js";
import {
  chartFrameToXml,
  chartToXml,
  chartWorkbook,
} from "../../../src/export/pptx/chart.js";
import { importPptx } from "../../../src/import/pptx/index.js";
import { buildMinimalPptx } from "../../import/pptx/__fixtures__/build-minimal-pptx.js";
import type { ChartElement } from "../../../src/model/element.js";

describe("PPTX chart export", () => {
  it.each([
    ["column", "stacked"],
    ["bar", "percentStacked"],
    ["line", "standard"],
    ["area", "stacked"],
    ["pie", undefined],
  ] as const)("round-trips editable %s chart data", async (kind, grouping) => {
    const { document } = await importPptx(await buildMinimalPptx());
    const chart: ChartElement = {
      id: `chart-${kind}`,
      type: "chart",
      frame: { x: 120, y: 140, w: 900, h: 520, rotation: 0 },
      data: {
        kind,
        ...(grouping ? { grouping } : {}),
        title: "Quarterly <mix>",
        categories: ["Q1", "Q2", "Q3"],
        series: [
          {
            name: "North & West",
            values: [12, null, 24],
            color: { kind: "srgb", value: "#C45A35" },
          },
          { name: "South", values: [9, 13, 21] },
        ],
        legend: "right",
        ...(kind === "pie" ? {} : { showGridlines: true }),
        ...(kind === "pie"
          ? {}
          : { valueAxis: { min: -5, max: 30, crossAt: 2.5 } }),
        alt: "Quarterly regional units",
      },
    };
    document.slides[0].elements.push(chart);
    const bytes = await exportPptx(document);
    const zip = await JSZip.loadAsync(bytes);
    const chartXml = await zip.file("ppt/charts/chart1.xml")!.async("string");
    expect(chartXml).toContain("North &amp; West");
    expect(chartXml).toContain("Quarterly &lt;mix&gt;");
    expect(chartXml).toContain('externalData r:id="rId1"');
    expect(chartXml).not.toMatch(/<c:f>[^<]*(?:\[|https?:|file:)/u);
    const workbookBytes = await zip
      .file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")!
      .async("uint8array");
    const workbook = await JSZip.loadAsync(workbookBytes);
    expect(workbook.file("xl/worksheets/sheet1.xml")).not.toBeNull();

    const reimported = await importPptx(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const result = reimported.document.slides[0].elements.find(
      (element) => element.type === "chart",
    );
    expect(result?.type).toBe("chart");
    if (result?.type !== "chart") return;
    expect(result.data).toMatchObject({
      kind,
      title: "Quarterly <mix>",
      categories: ["Q1", "Q2", "Q3"],
      series: [
        { name: "North & West", values: [12, null, 24] },
        { name: "South", values: [9, 13, 21] },
      ],
      legend: "right",
      alt: "Quarterly regional units",
    });
    if (kind !== "pie") expect(result.data.showGridlines).toBe(true);
    if (kind !== "pie")
      expect(result.data.valueAxis).toEqual({ min: -5, max: 30, crossAt: 2.5 });
    if (grouping) expect(result.data.grouping).toBe(grouping);
  });

  it("refuses malformed parallel chart arrays before writing a package", async () => {
    const { document } = await importPptx(await buildMinimalPptx());
    document.slides[0].elements.push({
      id: "bad-chart",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["Q1"],
        series: [{ values: [1, 2] }],
      },
    });
    await expect(exportPptx(document)).rejects.toThrow(
      "series lengths must match categories",
    );
  });

  it.each([
    [
      "unknown kind",
      (chart: ChartElement) => {
        (chart.data as { kind: string }).kind = "radar";
      },
      "unsupported chart kind",
    ],
    [
      "non-finite values",
      (chart: ChartElement) => {
        chart.data.series[0].values[0] = Number.NaN;
      },
      "finite numbers or null",
    ],
    [
      "rotated frame",
      (chart: ChartElement) => {
        chart.frame.rotation = 15;
      },
      "rotated or flipped",
    ],
    [
      "pie-only invalid options",
      (chart: ChartElement) => {
        chart.data.kind = "pie";
        chart.data.showGridlines = true;
      },
      "pie charts do not support",
    ],
    [
      "out-of-sheet category index",
      (chart: ChartElement) => {
        chart.data.categoryIndices = [1_048_575];
      },
      "worksheet row limit",
    ],
  ])(
    "refuses %s instead of emitting a lossy chart",
    async (_label, mutate, message) => {
      const { document } = await importPptx(await buildMinimalPptx());
      const chart: ChartElement = {
        id: "unsupported-chart",
        type: "chart",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        data: { kind: "column", categories: ["Q1"], series: [{ values: [1] }] },
      };
      mutate(chart);
      document.slides[0].elements.push(chart);
      await expect(exportPptx(document)).rejects.toThrow(message);
    },
  );

  it("serializes a theme series color without flattening it to a default", async () => {
    const { document } = await importPptx(await buildMinimalPptx());
    document.slides[0].elements.push({
      id: "role-color-chart",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["A"],
        series: [
          { values: [3], color: { kind: "role", role: "accent3", tint: 0.2 } },
        ],
      },
    });
    const zip = await JSZip.loadAsync(await exportPptx(document));
    const xml = await zip.file("ppt/charts/chart1.xml")!.async("string");
    expect(xml).toContain(
      '<a:schemeClr val="accent3"><a:tint val="20000"/></a:schemeClr>',
    );
  });

  it.each([
    ["column", "standard"],
    ["column", "clustered"],
    ["column", "stacked"],
    ["column", "percentStacked"],
    ["bar", "standard"],
    ["bar", "clustered"],
    ["bar", "stacked"],
    ["bar", "percentStacked"],
  ] as const)(
    "preserves signed sparse %s data for %s grouping without viewer inversion",
    async (kind, grouping) => {
      const { document } = await importPptx(await buildMinimalPptx());
      document.slides[0].elements.push({
        id: `signed-${kind}-${grouping}`,
        type: "chart",
        frame: { x: 0, y: 0, w: 400, h: 300, rotation: 0 },
        data: {
          kind,
          grouping,
          categories: ["A", "D", "F"],
          categoryIndices: [0, 3, 5],
          series: [
            {
              name: "Signed",
              values: [-5, null, -3],
              color: { kind: "srgb", value: "#C45A35" },
            },
          ],
        },
      });

      const bytes = await exportPptx(document);
      const zip = await JSZip.loadAsync(bytes);
      const chartXml = await zip.file("ppt/charts/chart1.xml")!.async("string");
      expect(chartXml).toContain(`<c:grouping val="${grouping}"/>`);
      expect(chartXml).toContain(
        '<c:spPr><a:solidFill><a:srgbClr val="C45A35"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat>',
      );
      expect(chartXml.match(/<c:invertIfNegative val="0"\/>/gu)).toHaveLength(
        1,
      );
      expect(chartXml).toContain(
        '<c:ptCount val="6"/><c:pt idx="0"><c:v>-5</c:v></c:pt><c:pt idx="5"><c:v>-3</c:v></c:pt>',
      );

      const workbookBytes = await zip
        .file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")!
        .async("uint8array");
      const workbook = await JSZip.loadAsync(workbookBytes);
      const sheetXml = await workbook
        .file("xl/worksheets/sheet1.xml")!
        .async("string");
      expect(sheetXml).toContain('<c r="B2"><v>-5</v></c>');
      expect(sheetXml).not.toContain('r="B5"');
      expect(sheetXml).toContain('<c r="B7"><v>-3</v></c>');

      const reimported = await importPptx(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
      const result = reimported.document.slides[0].elements.find(
        (element) => element.type === "chart",
      );
      expect(result?.type).toBe("chart");
      if (result?.type !== "chart") return;
      expect(result.data.categoryIndices).toEqual([0, 3, 5]);
      expect(result.data.series[0]?.values).toEqual([-5, null, -3]);
    },
  );

  it.each(["line", "area", "pie"] as const)(
    "does not emit bar-series inversion metadata for %s charts",
    (kind) => {
      const chart: ChartElement = {
        id: `${kind}-no-inversion`,
        type: "chart",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        data: {
          kind,
          categories: ["A"],
          series: [{ values: [-1] }],
        },
      };
      expect(chartToXml(chart, "rId1", 1)).not.toContain("<c:invertIfNegative");
    },
  );

  it("serializes a chart larger than the JavaScript call argument limit", () => {
    const count = 100_000;
    const chart: ChartElement = {
      id: "large-chart",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "line",
        categories: Array.from({ length: count }, (_, i) => `C${i}`),
        series: [{ values: Array.from({ length: count }, (_, i) => i) }],
      },
    };
    const xml = chartToXml(chart, "rId1", 1);
    expect(xml).toContain('<c:ptCount val="100000"/>');
    expect(xml).toContain("Sheet1!$B$2:$B$100001");
  });

  it("includes sparse coordinate gaps in cache point count for Office consumers", () => {
    const chart: ChartElement = {
      id: "sparse-chart",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["A", "K"],
        categoryIndices: [0, 10],
        series: [{ values: [1, 11] }],
      },
    };
    const xml = chartToXml(chart, "rId1", 1);
    expect(xml).toContain(
      '<c:ptCount val="11"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="10"><c:v>K</c:v></c:pt>',
    );
    expect(xml).toContain("Sheet1!$A$2:$A$12");
  });

  it("uses the final editable worksheet row and refuses the next category index", async () => {
    const chart: ChartElement = {
      id: "last-row",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["last"],
        categoryIndices: [1_048_574],
        series: [{ values: [1] }],
      },
    };
    expect(chartToXml(chart, "rId1", 1)).toContain("Sheet1!$A$2:$A$1048576");
    const workbook = await JSZip.loadAsync(await chartWorkbook(chart));
    const sheet = await workbook
      .file("xl/worksheets/sheet1.xml")!
      .async("string");
    expect(sheet).toContain('<row r="1048576">');

    chart.data.categoryIndices = [1_048_575];
    expect(() => chartToXml(chart, "rId1", 1)).toThrow("worksheet row limit");
  });

  it("uses every editable worksheet series column through XFD and refuses one more", () => {
    const series = Array.from({ length: 16_383 }, (_, index) => ({
      name: `S${index}`,
      values: [index],
    }));
    const chart: ChartElement = {
      id: "last-column",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: { kind: "column", categories: ["only"], series },
    };
    expect(chartToXml(chart, "rId1", 1)).toContain("Sheet1!$XFD$2:$XFD$2");
    chart.data.series.push({ name: "overflow", values: [1] });
    expect(() => chartToXml(chart, "rId1", 1)).toThrow("too many series");
  });

  it("refuses a chart point index beyond the OOXML unsigned-integer domain", () => {
    const chart: ChartElement = {
      id: "point-index-overflow",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["x"],
        categoryIndices: [4_294_967_296],
        series: [{ values: [1] }],
      },
    };
    expect(() => chartToXml(chart, "rId1", 1)).toThrow(
      "unique unsigned integers",
    );
  });

  it.each([
    ["column", "b", "l"],
    ["bar", "l", "b"],
  ] as const)(
    "positions %s category and value axes correctly",
    (kind, categoryPosition, valuePosition) => {
      const chart: ChartElement = {
        id: `${kind}-axes`,
        type: "chart",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        data: { kind, categories: ["A"], series: [{ values: [1] }] },
      };
      const xml = chartToXml(chart, "rId1", 1);
      expect(xml).toMatch(
        new RegExp(`<c:catAx>.*?<c:axPos val="${categoryPosition}"`, "u"),
      );
      expect(xml).toMatch(
        new RegExp(`<c:valAx>.*?<c:axPos val="${valuePosition}"`, "u"),
      );
    },
  );

  it.each([
    [
      "non-finite rotation",
      () =>
        chartFrameToXml(
          {
            id: "nan-rotation",
            type: "chart",
            frame: { x: 0, y: 0, w: 1, h: 1, rotation: Number.NaN },
            data: { kind: "pie", categories: [], series: [] },
          },
          "rId1",
        ),
    ],
    [
      "overflowing units",
      () =>
        chartFrameToXml(
          {
            id: "overflow-frame",
            type: "chart",
            frame: { x: Number.MAX_VALUE, y: 0, w: 1, h: 1, rotation: 0 },
            data: { kind: "pie", categories: [], series: [] },
          },
          "rId1",
        ),
    ],
    [
      "non-finite frame",
      () =>
        chartFrameToXml(
          {
            id: "bad-frame",
            type: "chart",
            frame: { x: Number.NaN, y: 0, w: 1, h: 1, rotation: 0 },
            data: { kind: "pie", categories: [], series: [] },
          },
          "rId1",
        ),
    ],
    [
      "negative frame extent",
      () =>
        chartFrameToXml(
          {
            id: "negative-frame",
            type: "chart",
            frame: { x: -10, y: -5, w: -1, h: 1, rotation: 0 },
            data: { kind: "pie", categories: [], series: [] },
          },
          "rId1",
        ),
    ],
  ])("refuses %s", (_label, serialize) => {
    expect(serialize).toThrow();
  });

  it("emits standard bar grouping accepted by the OOXML bar grouping type", () => {
    const xml = chartToXml(
      {
        id: "standard-bar",
        type: "chart",
        frame: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
        data: { kind: "bar", grouping: "standard", categories: [], series: [] },
      },
      "rId1",
      1,
    );
    expect(xml).toContain('<c:barDir val="bar"/><c:grouping val="standard"/>');
  });

  it("emits explicit value-axis bounds and crossing without rewriting them", () => {
    const xml = chartToXml(
      {
        id: "explicit-axis",
        type: "chart",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        data: {
          kind: "column",
          categories: ["A"],
          series: [{ values: [1] }],
          valueAxis: { min: -10, max: 40, crossAt: -2.5 },
        },
      },
      "rId1",
      1,
    );
    expect(xml).toContain('<c:max val="40"/><c:min val="-10"/>');
    expect(xml).toContain('<c:crossesAt val="-2.5"/>');
  });

  it("rejects invalid explicit axis ranges before serialization", () => {
    const chart: ChartElement = {
      id: "bad-axis",
      type: "chart",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: {
        kind: "column",
        categories: ["A"],
        series: [{ values: [1] }],
        valueAxis: { min: 5, max: 5 },
      },
    };
    expect(() => chartToXml(chart, "rId1", 1)).toThrow(
      "minimum must be less than maximum",
    );
  });

  it.each([
    ["minimum", { min: Number.MAX_VALUE }],
    ["maximum", { max: -Number.MAX_VALUE }],
  ] as const)(
    "rejects a one-sided finite-extreme %s axis",
    (_name, valueAxis) => {
      const chart: ChartElement = {
        id: "unrepresentable-axis",
        type: "chart",
        frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        data: {
          kind: "column",
          categories: ["A"],
          series: [{ values: [1] }],
          valueAxis,
        },
      };
      expect(() => chartToXml(chart, "rId1", 1)).toThrow(
        "no distinct finite automatic",
      );
    },
  );
});
