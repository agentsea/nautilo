// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseChartXml } from "../../../src/import/pptx/chart";
import { ImportReport } from "../../../src/import/pptx/report";
import {
  DEFAULT_WIDESCREEN_EMU,
  emuScale,
} from "../../../src/import/pptx/geometry";
import { parseXml } from "../../../src/import/pptx/xml";
import type { SlideParseContext } from "../../../src/import/pptx/shape";

const SCALE = emuScale(DEFAULT_WIDESCREEN_EMU);

function ctx(report = new ImportReport()): SlideParseContext {
  return {
    archive: {
      readText: async () => undefined,
      readBytes: async () => undefined,
      list: () => [],
    },
    slidePartPath: "ppt/slides/slide1.xml",
    rels: new Map(),
    scale: SCALE,
    report,
    idMap: new Map(),
    shapeKindByPptxId: new Map(),
    placeholderSizes: new Map(),
    clrMap: new Map(),
  };
}

const CHART_NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const COLUMN_CLUSTERED = `<c:chartSpace ${CHART_NS}>
  <c:chart><c:plotArea>
    <c:barChart>
      <c:barDir val="col"/>
      <c:grouping val="clustered"/>
      <c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Alpha</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></c:spPr>
        <c:cat><c:strRef><c:strCache>
          <c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt>
        </c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache>
          <c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>
        </c:numCache></c:numRef></c:val>
      </c:ser>
    </c:barChart>
  </c:plotArea></c:chart>
</c:chartSpace>`;

describe("parseChartXml — barChart", () => {
  it("maps a clustered column chart with cached values and color", () => {
    const data = parseChartXml(parseXml(COLUMN_CLUSTERED), ctx());
    expect(data).toBeDefined();
    expect(data!.kind).toBe("column");
    expect(data!.grouping).toBe("clustered");
    expect(data!.categories).toEqual(["Q1", "Q2"]);
    expect(data!.series).toHaveLength(1);
    expect(data!.series[0].name).toBe("Alpha");
    expect(data!.series[0].values).toEqual([10, 20]);
    expect(data!.series[0].color).toEqual({ kind: "srgb", value: "#3366CC" });
  });

  it('maps barDir="bar" to kind "bar"', () => {
    const xml = COLUMN_CLUSTERED.replace('val="col"', 'val="bar"');
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.kind).toBe("bar");
  });

  it('reads grouping="stacked"', () => {
    const xml = COLUMN_CLUSTERED.replace('val="clustered"', 'val="stacked"');
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.grouping).toBe("stacked");
  });
});

const PIE = `<c:chartSpace ${CHART_NS}>
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Share</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:pieChart>
        <c:ser>
          <c:cat><c:strRef><c:strCache>
            <c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt>
          </c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache>
            <c:pt idx="0"><c:v>60</c:v></c:pt><c:pt idx="1"><c:v>40</c:v></c:pt>
          </c:numCache></c:numRef></c:val>
        </c:ser>
      </c:pieChart>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
  </c:chart>
</c:chartSpace>`;

describe("parseChartXml — line/area/pie + chart chrome", () => {
  it("maps a lineChart", () => {
    const xml = COLUMN_CLUSTERED.replace("<c:barChart>", "<c:lineChart>")
      .replace("</c:barChart>", "</c:lineChart>")
      .replace('<c:barDir val="col"/>', "");
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.kind).toBe("line");
    expect(data!.series[0].values).toEqual([10, 20]);
  });

  it("maps an areaChart", () => {
    const xml = COLUMN_CLUSTERED.replace("<c:barChart>", "<c:areaChart>")
      .replace("</c:barChart>", "</c:areaChart>")
      .replace('<c:barDir val="col"/>', "");
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.kind).toBe("area");
  });

  it("maps a pieChart with title and legend position", () => {
    const data = parseChartXml(parseXml(PIE), ctx());
    expect(data!.kind).toBe("pie");
    expect(data!.title).toBe("Share");
    expect(data!.legend).toBe("right");
    expect(data!.series[0].values).toEqual([60, 40]);
    expect(data!.categories).toEqual(["A", "B"]);
  });

  it("detects value-axis gridlines", () => {
    const xml = COLUMN_CLUSTERED.replace(
      "</c:plotArea>",
      "<c:valAx><c:majorGridlines/></c:valAx></c:plotArea>",
    );
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.showGridlines).toBe(true);
  });

  it("preserves explicit value-axis bounds and category-axis crossing", () => {
    const xml = COLUMN_CLUSTERED.replace(
      "</c:plotArea>",
      '<c:catAx><c:crossesAt val="-2.5"/></c:catAx>' +
        '<c:valAx><c:scaling><c:min val="-10"/><c:max val="40"/></c:scaling></c:valAx>' +
        "</c:plotArea>",
    );
    expect(parseChartXml(parseXml(xml), ctx())!.valueAxis).toEqual({
      min: -10,
      max: 40,
      crossAt: -2.5,
    });
  });

  it.each(["autoZero", "min", "max"] as const)(
    "preserves value-axis crossing mode %s",
    (crosses) => {
      const xml = COLUMN_CLUSTERED.replace(
        "</c:plotArea>",
        `<c:catAx><c:crosses val="${crosses}"/></c:catAx><c:valAx/></c:plotArea>`,
      );
      expect(parseChartXml(parseXml(xml), ctx())!.valueAxis).toEqual({
        crosses,
      });
    },
  );

  it("reads crossing from the category axis paired to the value axis", () => {
    const xml = COLUMN_CLUSTERED.replace(
      "</c:plotArea>",
      '<c:catAx><c:axId val="10"/><c:crosses val="min"/></c:catAx>' +
        '<c:catAx><c:axId val="20"/><c:crosses val="max"/></c:catAx>' +
        '<c:valAx><c:crossAx val="20"/></c:valAx></c:plotArea>',
    );
    expect(parseChartXml(parseXml(xml), ctx())!.valueAxis).toEqual({
      crosses: "max",
    });
  });

  it("rejects contradictory explicit bounds instead of rewriting them", () => {
    const xml = COLUMN_CLUSTERED.replace(
      "</c:plotArea>",
      '<c:valAx><c:scaling><c:min val="5"/><c:max val="5"/></c:scaling></c:valAx>' +
        "</c:plotArea>",
    );
    expect(() => parseChartXml(parseXml(xml), ctx())).toThrow(
      "value-axis minimum must be less than maximum",
    );
  });

  it.each([
    ["minimum", `<c:min val="${Number.MAX_VALUE}"/>`],
    ["maximum", `<c:max val="${-Number.MAX_VALUE}"/>`],
  ])(
    "rejects a one-sided finite-extreme %s with no distinct automatic partner",
    (_name, bound) => {
      const xml = COLUMN_CLUSTERED.replace(
        "</c:plotArea>",
        `<c:valAx><c:scaling>${bound}</c:scaling></c:valAx></c:plotArea>`,
      );
      expect(() => parseChartXml(parseXml(xml), ctx())).toThrow(
        "no distinct finite automatic",
      );
    },
  );

  it('maps legendPos="tr" (PowerPoint default) to legend "right"', () => {
    const xml = PIE.replace('val="r"', 'val="tr"');
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.legend).toBe("right");
  });

  it("falls back to a literal <c:tx><c:v> series name when there is no strRef/strCache", () => {
    const xml = COLUMN_CLUSTERED.replace(
      '<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Alpha</c:v></c:pt></c:strCache></c:strRef></c:tx>',
      "<c:tx><c:v>Revenue</c:v></c:tx>",
    );
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.series[0].name).toBe("Revenue");
  });
});

describe("parseChartXml — sparse point indices", () => {
  it("preserves and aligns valid sparse points beyond index 4096", () => {
    const xml = COLUMN_CLUSTERED.replace(
      '<c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt>',
      '<c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt>' +
        '<c:pt idx="5000"><c:v>Q5001</c:v></c:pt>',
    ).replace(
      '<c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>',
      '<c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt>' +
        '<c:pt idx="5000"><c:v>20</c:v></c:pt>',
    );
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.categories).toEqual(["Q1", "Q5001"]);
    expect(data!.categoryIndices).toEqual([0, 5000]);
    expect(data!.series[0].values).toEqual([10, 20]);
  });

  it("retains an adversarially large represented point without allocating its gap", () => {
    const xml = COLUMN_CLUSTERED.replace(
      '<c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>',
      '<c:pt idx="0"><c:v>10</c:v></c:pt>' +
        '<c:pt idx="1"><c:v>20</c:v></c:pt>' +
        '<c:pt idx="999999999"><c:v>5</c:v></c:pt>',
    );
    const start = Date.now();
    const data = parseChartXml(parseXml(xml), ctx());
    expect(Date.now() - start).toBeLessThan(1000);
    expect(data!.series[0].values).toEqual([10, 20, 5]);
    expect(data!.categories).toEqual(["Q1", "Q2", ""]);
    expect(data!.categoryIndices).toEqual([0, 1, 999999999]);
  });

  it("aligns missing values across series by original point index", () => {
    const secondSeries = `<c:ser>
      <c:tx><c:v>Beta</c:v></c:tx>
      <c:val><c:numLit><c:ptCount val="2"/>
        <c:pt idx="1"><c:v>30</c:v></c:pt>
        <c:pt idx="5000"><c:v>50</c:v></c:pt>
      </c:numLit></c:val>
    </c:ser>`;
    const xml = COLUMN_CLUSTERED.replace(
      '<c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt>',
      '<c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="5000"><c:v>Q5001</c:v></c:pt>',
    ).replace("</c:barChart>", `${secondSeries}</c:barChart>`);
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.categories).toEqual(["Q1", "", "Q5001"]);
    expect(data!.categoryIndices).toEqual([0, 1, 5000]);
    expect(data!.series[0].values).toEqual([10, 20, null]);
    expect(data!.series[1].values).toEqual([null, 30, 50]);
  });

  it("omits categoryIndices for an already-dense cache", () => {
    const data = parseChartXml(parseXml(COLUMN_CLUSTERED), ctx());
    expect(data!.categoryIndices).toBeUndefined();
  });

  it("reads inline strLit and numLit point collections", () => {
    const xml = COLUMN_CLUSTERED.replace(
      "<c:cat><c:strRef><c:strCache>",
      "<c:cat><c:strLit>",
    )
      .replace("</c:strCache></c:strRef></c:cat>", "</c:strLit></c:cat>")
      .replace("<c:val><c:numRef><c:numCache>", "<c:val><c:numLit>")
      .replace("</c:numCache></c:numRef></c:val>", "</c:numLit></c:val>");
    const data = parseChartXml(parseXml(xml), ctx());
    expect(data!.categories).toEqual(["Q1", "Q2"]);
    expect(data!.series[0].values).toEqual([10, 20]);
  });

  it.each(["-1", "1.5", "", "1e3", "4294967296", "9007199254740992"])(
    "rejects malformed point index %s instead of silently losing its value",
    (index) => {
      const xml = COLUMN_CLUSTERED.replace(
        'idx="1"><c:v>20',
        `idx="${index}"><c:v>20`,
      );
      expect(() => parseChartXml(parseXml(xml), ctx())).toThrow(
        "c:pt@idx must be an unsigned integer",
      );
    },
  );

  it("retains the greatest unsignedInt index without dense allocation", () => {
    const xml = COLUMN_CLUSTERED.replace(
      'idx="1"><c:v>20',
      'idx="4294967295"><c:v>20',
    );
    const data = parseChartXml(parseXml(xml), ctx())!;
    expect(data.categoryIndices).toEqual([0, 1, 4294967295]);
    expect(data.series[0].values).toEqual([10, null, 20]);
  });

  it("rejects duplicate indices rather than overwriting one represented value", () => {
    const xml = COLUMN_CLUSTERED.replace('idx="1"><c:v>20', 'idx="0"><c:v>20');
    expect(() => parseChartXml(parseXml(xml), ctx())).toThrow(
      "duplicate point index 0",
    );
  });
});
