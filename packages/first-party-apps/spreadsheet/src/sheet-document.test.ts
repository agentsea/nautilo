import { describe, expect, test } from "bun:test";
import { getWorksheetCell, writeWorksheetCell } from "../engine/node.js";
import {
  addSheet,
  createSheetDocument,
  parseSheetHtml,
  renameSheet,
  serializeSheetHtml,
  validateSheetDocument,
} from "./sheet-document";

describe("sheet document container", () => {
  test("round-trips the workbook and preserves unknown JSON fields", () => {
    const document = createSheetDocument();
    writeWorksheetCell(document.sheets["tab-1"], { r: 2, c: 3 }, { v: "</script><b>safe</b>" });
    (document as unknown as Record<string, unknown>)["futureRoot"] = { token: "keep" };
    (document.sheets["tab-1"] as unknown as Record<string, unknown>)["futureSheet"] = [1, 2, 3];

    const html = serializeSheetHtml(document);
    expect(html).toContain('id="manifest" type="application/vnd.nautilo.document+json"');
    expect(html).toContain('id="wafflebase-spreadsheet"');
    expect(html).not.toContain("</script><b>safe</b>");
    expect(parseSheetHtml(html)).toEqual(document);
  });

  test("serializes a semantic preview of the first editable sheet with formatted formula results", () => {
    const document = addSheet(createSheetDocument(), "Report & <Plan>").document;
    document.tabs["tab-1"].type = "datasource";
    const reportId = document.tabOrder[1];
    const report = document.sheets[reportId];
    report.colStyles["2"] = { nf: "number", dp: 2 };
    writeWorksheetCell(report, { r: 2, c: 1 }, { v: "Revenue <script>alert(1)</script>" });
    writeWorksheetCell(report, { r: 2, c: 2 }, { f: "=1+2", v: "3" });

    const html = serializeSheetHtml(document);
    expect(html).toContain("<table>");
    expect(html).toContain("<h1>Report &amp; &lt;Plan&gt;</h1>");
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<th scope="col">B</th>');
    expect(html).toContain('<th scope="row">2</th>');
    expect(html).toContain("Revenue &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<td>3.00</td>");
    expect(html).not.toContain("<td>=1+2</td>");
    expect(parseSheetHtml(html)).toEqual(document);
  });

  test("serializes an explicit empty-sheet preview", () => {
    const html = serializeSheetHtml(createSheetDocument());
    expect(html).toContain("<h1>Sheet1</h1>");
    expect(html).toContain("Empty spreadsheet. Open with Sheets to edit.");
    expect(html).not.toContain("<table>");
  });

  test("bounds the preview to 50 rows and 20 columns and discloses truncation", () => {
    const document = createSheetDocument();
    const sheet = document.sheets["tab-1"];
    writeWorksheetCell(sheet, { r: 1, c: 1 }, { v: "start" });
    writeWorksheetCell(sheet, { r: 51, c: 21 }, { v: "outside-preview" });

    const html = serializeSheetHtml(document);
    const preview = html.slice(html.indexOf("<body>"));
    expect(preview).toContain('<th scope="col">T</th>');
    expect(preview).not.toContain('<th scope="col">U</th>');
    expect(preview).toContain('<th scope="row">50</th>');
    expect(preview).not.toContain('<th scope="row">51</th>');
    expect(preview).not.toContain("outside-preview");
    expect(preview).toContain(
      "Preview truncated: showing 50 of 51 rows and 20 of 21 columns in the used range.",
    );
    expect(parseSheetHtml(html)).toEqual(document);
  });

  test("adds uniquely named sheets and renames cross-sheet formulas quote-safely", () => {
    const initial = createSheetDocument();
    const added = addSheet(initial, "Results 2026");
    const third = addSheet(added.document, "Results 2026");
    expect(added.document.tabs[added.tabId].name).toBe("Results 2026");
    expect(third.document.tabs[third.tabId].name).not.toBe("Results 2026");

    writeWorksheetCell(third.document.sheets[third.tabId], { r: 1, c: 1 }, {
      f: '=Sheet1!A1+SUM(Sheet1!B2:C3)+"Sheet1!D4"',
    });
    const renamed = renameSheet(third.document, "tab-1", "Raw Data");
    expect(getWorksheetCell(renamed.sheets[third.tabId], { r: 1, c: 1 })?.f)
      .toBe('=\'Raw Data\'!A1+SUM(\'Raw Data\'!B2:C3)+"Sheet1!D4"');
    expect(initial.tabs["tab-1"].name).toBe("Sheet1");
  });

  test("rejects unsafe names, executable scripts, malformed axes, and pollution keys", () => {
    expect(() => renameSheet(createSheetDocument(), "tab-1", "Bad'Name")).toThrow("unsupported");

    const html = serializeSheetHtml(createSheetDocument());
    expect(() => parseSheetHtml(html.replace("</body>", "<script>alert(1)</script></body>")))
      .toThrow("exactly two");

    const malformed = createSheetDocument();
    malformed.sheets["tab-1"].cells["missing|axes"] = { v: "1" };
    expect(() => validateSheetDocument(malformed)).toThrow("unknown axis ID");

    const polluted = html.replace(
      '"tabs":',
      '"__proto__":{"polluted":true},"tabs":',
    );
    expect(() => parseSheetHtml(polluted)).toThrow("forbidden");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("rejects non-canonical worksheet metadata indices", () => {
    const leadingZero = createSheetDocument();
    leadingZero.sheets["tab-1"].rowHeights["01"] = 24;
    expect(() => validateSheetDocument(leadingZero)).toThrow(
      "rowHeights must use canonical positive 1-based integer keys",
    );

    const zero = createSheetDocument();
    zero.sheets["tab-1"].colStyles["0"] = { b: true };
    expect(() => validateSheetDocument(zero)).toThrow(
      "colStyles must use canonical positive 1-based integer keys",
    );

    const unsafe = createSheetDocument();
    unsafe.sheets["tab-1"].rowStyles[String(Number.MAX_SAFE_INTEGER + 1)] = { i: true };
    expect(() => validateSheetDocument(unsafe)).toThrow(
      "rowStyles must use canonical positive 1-based integer keys",
    );
  });

  test("validates known cell fields while preserving unknown fields", () => {
    const valid = createSheetDocument();
    writeWorksheetCell(valid.sheets["tab-1"], { r: 1, c: 1 }, {
      v: "1",
      f: "=1",
      spillRows: 1,
      spillCols: 1,
      spillBlocked: false,
      spillAnchor: "B1",
      s: { b: true },
      futureCell: { keep: true },
    } as never);
    expect(validateSheetDocument(valid)).toBe(valid);

    const badFormula = structuredClone(valid) as unknown as Record<string, unknown>;
    const badFormulaSheet = (badFormula["sheets"] as Record<string, Record<string, unknown>>)["tab-1"];
    const badFormulaCells = badFormulaSheet["cells"] as Record<string, Record<string, unknown>>;
    badFormulaCells[Object.keys(badFormulaCells)[0]]["f"] = 42;
    expect(() => validateSheetDocument(badFormula)).toThrow(".f must be a string when present");

    const badSpill = structuredClone(valid) as unknown as Record<string, unknown>;
    const badSpillSheet = (badSpill["sheets"] as Record<string, Record<string, unknown>>)["tab-1"];
    const badSpillCells = badSpillSheet["cells"] as Record<string, Record<string, unknown>>;
    badSpillCells[Object.keys(badSpillCells)[0]]["spillRows"] = 0;
    expect(() => validateSheetDocument(badSpill)).toThrow(
      ".spillRows must be a positive integer when present",
    );

    const badStyle = structuredClone(valid) as unknown as Record<string, unknown>;
    const badStyleSheet = (badStyle["sheets"] as Record<string, Record<string, unknown>>)["tab-1"];
    const badStyleCells = badStyleSheet["cells"] as Record<string, Record<string, unknown>>;
    badStyleCells[Object.keys(badStyleCells)[0]]["s"] = [];
    expect(() => validateSheetDocument(badStyle)).toThrow(".s must be an object when present");

    for (const [field, value, message] of [
      ["v", 1, ".v must be a string when present"],
      ["spillAnchor", false, ".spillAnchor must be a string when present"],
      ["spillCols", 1.5, ".spillCols must be a positive integer when present"],
      ["spillBlocked", "false", ".spillBlocked must be a boolean when present"],
    ] as const) {
      const malformed = structuredClone(valid) as unknown as Record<string, unknown>;
      const sheet = (malformed["sheets"] as Record<string, Record<string, unknown>>)["tab-1"];
      const cells = sheet["cells"] as Record<string, Record<string, unknown>>;
      cells[Object.keys(cells)[0]][field] = value;
      expect(() => validateSheetDocument(malformed)).toThrow(message);
    }
  });
});
