import { describe, expect, test } from "bun:test";
import { googleWorkspaceArgv, isGoogleWorkspaceTool } from "./google-workspace";

describe("D138 googleWorkspaceArgv", () => {
  test("docs.cat is readonly json wrapped", () => {
    expect(googleWorkspaceArgv({
      command: "docs.cat",
      account: "alex@example.com",
      docId: "doc123",
    })).toEqual([
      "--readonly",
      "--account",
      "alex@example.com",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "cat",
      "doc123",
    ]);
  });

  test("docs.writeAppend supports dry-run and does not add readonly", () => {
    expect(googleWorkspaceArgv({
      command: "docs.writeAppend",
      docId: "doc123",
      text: "hello",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "write",
      "doc123",
      "--append",
      "--text",
      "hello",
      "--dry-run",
    ]);
  });

  test("docs.findReplace supports first + dry-run", () => {
    expect(googleWorkspaceArgv({
      command: "docs.findReplace",
      docId: "doc123",
      find: "old",
      replace: "new",
      first: true,
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "find-replace",
      "doc123",
      "old",
      "new",
      "--first",
      "--dry-run",
    ]);
  });

  test("docs.format supports matched text formatting", () => {
    expect(googleWorkspaceArgv({
      command: "docs.format",
      docId: "doc123",
      match: "Coda: After the Future",
      bold: true,
      headingLevel: "HEADING_2",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "format",
      "doc123",
      "--match",
      "Coda: After the Future",
      "--bold",
      "--heading-level",
      "HEADING_2",
      "--dry-run",
    ]);
  });

  test("docs.findRange/export/list commands map to readonly commands", () => {
    expect(googleWorkspaceArgv({ command: "docs.findRange", docId: "doc123", text: "needle", all: true })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "find-range",
      "doc123",
      "needle",
      "--all",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.export", docId: "doc123", format: "md", out: "/tmp/doc.md" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "export",
      "doc123",
      "--format",
      "md",
      "--out",
      "/tmp/doc.md",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.listTabs", docId: "doc123" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "list-tabs",
      "doc123",
    ]);
  });

  test("docs.update supports anchored and range edits", () => {
    expect(googleWorkspaceArgv({
      command: "docs.update",
      docId: "doc123",
      text: "replacement",
      at: "old text",
      occurrence: 2,
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "docs",
      "update",
      "doc123",
      "--text",
      "replacement",
      "--at",
      "old text",
      "--occurrence",
      "2",
      "--dry-run",
    ]);
  });

  test("docs file and tab commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "docs.info", docId: "doc123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "info", "doc123",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.create", title: "Plan", parent: "folder1", pageless: true, dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "create", "Plan", "--parent", "folder1", "--pageless", "--dry-run",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.addTab", docId: "doc123", title: "Appendix", tabIndex: 0, iconEmoji: "📄", dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "add-tab", "doc123", "--title", "Appendix", "--index", "0", "--icon-emoji", "📄", "--dry-run",
    ]);
  });

  test("docs structural insert and layout commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "docs.insert", docId: "doc123", content: "Hello", at: "anchor", dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "insert", "doc123", "Hello", "--at", "anchor", "--dry-run",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.insertTable", docId: "doc123", rows: 2, cols: 3, valuesJson: "[[\"A\"]]", atEnd: true, dryRun: true })).toContain("insert-table");
    expect(googleWorkspaceArgv({ command: "docs.insertImage", docId: "doc123", url: "https://example.com/a.png", after: "Logo", width: 300, dryRun: true })).toContain("insert-image");
    expect(googleWorkspaceArgv({ command: "docs.insertPerson", docId: "doc123", email: "ada@example.com", atEnd: true, dryRun: true })).toContain("insert-person");
    expect(googleWorkspaceArgv({ command: "docs.pageLayout", docId: "doc123", layout: "pageless", dryRun: true })).toContain("page-layout");
    expect(() => googleWorkspaceArgv({ command: "docs.delete", docId: "doc123" })).toThrow(/start\/end or at/);
  });

  test("docs comments, named ranges, and native tables map to gog", () => {
    expect(googleWorkspaceArgv({ command: "docs.commentsList", docId: "doc123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "comments", "list", "doc123",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.commentsPoll", docId: "doc123", stateFile: "/tmp/comments.json", interval: "30s", maxIterations: 1 })).toContain("poll");
    expect(googleWorkspaceArgv({ command: "docs.commentsAdd", docId: "doc123", content: "Please review", quoted: "text", dryRun: true })).toContain("comments");
    expect(googleWorkspaceArgv({ command: "docs.namedRangesCreate", docId: "doc123", name: "Intro", at: "Introduction", dryRun: true })).toContain("named-range");
    expect(() => googleWorkspaceArgv({ command: "docs.namedRangesReplace", docId: "doc123", nameOrId: "Intro" })).toThrow(/text or file/);
    expect(googleWorkspaceArgv({ command: "docs.cellUpdate", docId: "doc123", row: 1, col: 2, content: "Cell", dryRun: true })).toContain("cell-update");
    expect(googleWorkspaceArgv({ command: "docs.tableRowInsert", docId: "doc123", table: "1", at: "end", valuesJson: "[\"A\"]", dryRun: true })).toContain("table-row");
    expect(googleWorkspaceArgv({ command: "docs.tableRowStyle", docId: "doc123", row: 1, minHeight: "24pt", preventOverflow: false, dryRun: true })).toContain("style");
    expect(googleWorkspaceArgv({ command: "docs.tableRowPinHeader", docId: "doc123", rows: 1, dryRun: true })).toContain("pin-header");
    expect(googleWorkspaceArgv({ command: "docs.tableMerge", docId: "doc123", range: "1,1:1,2", dryRun: true })).toContain("table-merge");
  });

  test("docs headers and footers map to gog", () => {
    expect(googleWorkspaceArgv({ command: "docs.headersList", docId: "doc123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "header", "list", "doc123",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.footersCreate", docId: "doc123", text: "Confidential", dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "docs", "footer", "create", "doc123", "--text", "Confidential", "--dry-run",
    ]);
    expect(googleWorkspaceArgv({ command: "docs.headersDelete", docId: "doc123", segmentId: "h1", dryRun: true })).toContain("h1");
  });

  test("drive, gmail, calendar, sheets, and slides read paths map to readonly commands", () => {
    expect(googleWorkspaceArgv({ command: "drive.ls", max: 5 })).toContain("--readonly");
    expect(googleWorkspaceArgv({ command: "drive.search", query: "budget", max: 3 })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "drive",
      "search",
      "budget",
      "--max",
      "3",
    ]);
    expect(googleWorkspaceArgv({ command: "drive.fileInfo", fileId: "abc123" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "drive",
      "get",
      "abc123",
    ]);
    expect(googleWorkspaceArgv({ command: "gmail.search", query: "newer_than:7d", max: 2 })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "gmail",
      "search",
      "newer_than:7d",
      "--max",
      "2",
    ]);
    expect(googleWorkspaceArgv({ command: "gmail.get", messageId: "msg1" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "gmail",
      "get",
      "msg1",
      "--format",
      "full",
      "--sanitize-content",
    ]);
    expect(googleWorkspaceArgv({ command: "gmail.threadGet", threadId: "thr1" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "gmail",
      "thread",
      "get",
      "thr1",
      "--sanitize-content",
    ]);
    expect(googleWorkspaceArgv({ command: "calendar.eventsToday" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "calendar",
      "events",
      "--today",
    ]);
    expect(googleWorkspaceArgv({
      command: "sheets.get",
      spreadsheetId: "sheet123",
      range: "Sheet1!A1:B2",
      render: "FORMULA",
    })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "get",
      "sheet123",
      "Sheet1!A1:B2",
      "--render",
      "FORMULA",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.metadata", spreadsheetId: "sheet123" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "metadata",
      "sheet123",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.raw", spreadsheetId: "sheet123" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "raw",
      "sheet123",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.export", spreadsheetId: "sheet123", format: "csv", out: "/tmp/sheet.csv", overwrite: true })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "export",
      "sheet123",
      "--format",
      "csv",
      "--out",
      "/tmp/sheet.csv",
      "--overwrite",
    ]);
    expect(googleWorkspaceArgv({ command: "slides.info", presentationId: "pres1" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "slides",
      "info",
      "pres1",
    ]);
    expect(googleWorkspaceArgv({ command: "slides.listSlides", presentationId: "pres1" })).toEqual([
      "--readonly",
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "slides",
      "list-slides",
      "pres1",
    ]);
  });

  test("calendar.createDryRun requires dryRun and maps to gog create --dry-run", () => {
    expect(() => googleWorkspaceArgv({
      command: "calendar.createDryRun",
      calendarId: "primary",
      summary: "Sync",
      from: "2026-06-25T10:00:00-07:00",
      to: "2026-06-25T10:30:00-07:00",
    })).toThrow(/dryRun:true/);
    expect(googleWorkspaceArgv({
      command: "calendar.createDryRun",
      dryRun: true,
      calendarId: "primary",
      summary: "Sync",
      from: "2026-06-25T10:00:00-07:00",
      to: "2026-06-25T10:30:00-07:00",
      timezone: "America/Los_Angeles",
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "calendar",
      "create",
      "primary",
      "--summary",
      "Sync",
      "--from",
      "2026-06-25T10:00:00-07:00",
      "--to",
      "2026-06-25T10:30:00-07:00",
      "--timezone",
      "America/Los_Angeles",
      "--dry-run",
    ]);
  });

  test("sheets write commands map to gog with dry-run support", () => {
    expect(googleWorkspaceArgv({
      command: "sheets.create",
      title: "Q4 Budget",
      sheets: ["Summary", "Data"],
      parent: "folder123",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "create",
      "Q4 Budget",
      "--sheets",
      "Summary,Data",
      "--parent",
      "folder123",
      "--dry-run",
    ]);

    expect(googleWorkspaceArgv({
      command: "sheets.update",
      spreadsheetId: "sheet123",
      range: "Sheet1!A1:B2",
      valuesJson: "[[\"Name\",\"Score\"],[\"Ada\",\"99\"]]",
      input: "USER_ENTERED",
      failOnFormulaError: true,
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "update",
      "sheet123",
      "Sheet1!A1:B2",
      "--values-json",
      "[[\"Name\",\"Score\"],[\"Ada\",\"99\"]]",
      "--input",
      "USER_ENTERED",
      "--fail-on-formula-error",
      "--dry-run",
    ]);

    expect(googleWorkspaceArgv({
      command: "sheets.append",
      spreadsheetId: "sheet123",
      range: "Sheet1!A:C",
      values: ["Ada,99,true"],
      insert: "INSERT_ROWS",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "append",
      "sheet123",
      "Sheet1!A:C",
      "Ada,99,true",
      "--insert",
      "INSERT_ROWS",
      "--dry-run",
    ]);

    expect(googleWorkspaceArgv({
      command: "sheets.clear",
      spreadsheetId: "sheet123",
      range: "Sheet1!A1:B2",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "clear",
      "sheet123",
      "Sheet1!A1:B2",
      "--dry-run",
    ]);
  });

  test("sheets tab commands map to gog", () => {
    expect(googleWorkspaceArgv({
      command: "sheets.addTab",
      spreadsheetId: "sheet123",
      tabName: "Forecast",
      tabIndex: 0,
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "add-tab",
      "sheet123",
      "Forecast",
      "--index",
      "0",
      "--dry-run",
    ]);

    expect(googleWorkspaceArgv({
      command: "sheets.renameTab",
      spreadsheetId: "sheet123",
      oldName: "Sheet1",
      newName: "Actuals",
      dryRun: true,
    })).toEqual([
      "--account",
      "auto",
      "--json",
      "--no-input",
      "--wrap-untrusted",
      "sheets",
      "rename-tab",
      "sheet123",
      "Sheet1",
      "Actuals",
      "--dry-run",
    ]);
  });

  test("sheets write commands require values payloads", () => {
    expect(() => googleWorkspaceArgv({
      command: "sheets.update",
      spreadsheetId: "sheet123",
      range: "Sheet1!A1:B2",
    })).toThrow(/values or valuesJson/);
    expect(() => googleWorkspaceArgv({
      command: "sheets.append",
      spreadsheetId: "sheet123",
      range: "Sheet1!A:C",
    })).toThrow(/values or valuesJson/);
  });

  test("sheets chart commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "sheets.chartList", spreadsheetId: "sheet123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "chart", "list", "sheet123",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.chartGet", spreadsheetId: "sheet123", chartId: "99" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "chart", "get", "sheet123", "99",
    ]);
    expect(googleWorkspaceArgv({
      command: "sheets.chartCreate",
      spreadsheetId: "sheet123",
      specJson: "{\"basicChart\":{}}",
      sheet: "Sheet1",
      anchor: "E10",
      width: 640,
      height: 360,
      dryRun: true,
    })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "chart", "create", "sheet123",
      "--spec-json", "{\"basicChart\":{}}",
      "--sheet", "Sheet1",
      "--anchor", "E10",
      "--width", "640",
      "--height", "360",
      "--dry-run",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.chartDelete", spreadsheetId: "sheet123", chartId: "99", dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "chart", "delete", "sheet123", "99", "--dry-run",
    ]);
  });

  test("sheets table commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "sheets.tableList", spreadsheetId: "sheet123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "table", "list", "sheet123",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.tableGet", spreadsheetId: "sheet123", tableId: "tbl1" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "table", "get", "sheet123", "tbl1",
    ]);
    expect(googleWorkspaceArgv({
      command: "sheets.tableCreate",
      spreadsheetId: "sheet123",
      range: "Sheet1!A1:C10",
      name: "Pipeline",
      columnsJson: "[{\"columnName\":\"Name\"}]",
      dryRun: true,
    })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "table", "create", "sheet123", "Sheet1!A1:C10",
      "--name", "Pipeline",
      "--columns-json", "[{\"columnName\":\"Name\"}]",
      "--dry-run",
    ]);
    expect(googleWorkspaceArgv({
      command: "sheets.tableAppend",
      spreadsheetId: "sheet123",
      tableId: "Pipeline",
      valuesJson: "[[\"Ada\",99]]",
      input: "USER_ENTERED",
      dryRun: true,
    })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "table", "append", "sheet123", "Pipeline",
      "--values-json", "[[\"Ada\",99]]",
      "--input", "USER_ENTERED",
      "--dry-run",
    ]);
    expect(() => googleWorkspaceArgv({ command: "sheets.tableDelete", spreadsheetId: "sheet123", tableId: "tbl1" })).toThrow(/discardData:true/);
  });

  test("sheets conditional formatting and validation commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "sheets.conditionalFormatList", spreadsheetId: "sheet123", sheet: "Sheet1" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "conditional-format", "list", "sheet123", "--sheet", "Sheet1",
    ]);
    expect(googleWorkspaceArgv({
      command: "sheets.conditionalFormatAdd",
      spreadsheetId: "sheet123",
      range: "Sheet1!A2:A",
      ruleType: "number-gt",
      expr: "10",
      formatJson: "{\"textFormat\":{\"bold\":true}}",
      ruleIndex: 0,
      dryRun: true,
    })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "conditional-format", "add", "sheet123", "Sheet1!A2:A",
      "--type", "number-gt",
      "--format-json", "{\"textFormat\":{\"bold\":true}}",
      "--expr", "10",
      "--index", "0",
      "--dry-run",
    ]);
    expect(() => googleWorkspaceArgv({ command: "sheets.conditionalFormatClear", spreadsheetId: "sheet123", sheet: "Sheet1" })).toThrow(/ruleIndex or all:true/);
    expect(googleWorkspaceArgv({ command: "sheets.validationGet", spreadsheetId: "sheet123", range: "Sheet1!A2:A" })).toContain("validation");
    expect(googleWorkspaceArgv({
      command: "sheets.validationSet",
      spreadsheetId: "sheet123",
      range: "Sheet1!A2:A",
      validationType: "ONE_OF_LIST",
      validationValues: ["Open", "Closed"],
      strict: false,
      showCustomUi: false,
      inputMessage: "Pick a status",
      filteredRowsIncluded: true,
      dryRun: true,
    })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "validation", "set", "sheet123", "Sheet1!A2:A",
      "--type", "ONE_OF_LIST",
      "--value", "Open",
      "--value", "Closed",
      "--no-strict",
      "--no-show-custom-ui",
      "--input-message", "Pick a status",
      "--filtered-rows-included",
      "--dry-run",
    ]);
  });

  test("sheets named range and hyperlink commands map to gog", () => {
    expect(googleWorkspaceArgv({ command: "sheets.namedRangesList", spreadsheetId: "sheet123" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "named-ranges", "list", "sheet123",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.namedRangesGet", spreadsheetId: "sheet123", nameOrId: "Totals" })).toContain("Totals");
    expect(googleWorkspaceArgv({ command: "sheets.namedRangesAdd", spreadsheetId: "sheet123", name: "Totals", range: "Sheet1!A1:B2", dryRun: true })).toContain("add");
    expect(() => googleWorkspaceArgv({ command: "sheets.namedRangesUpdate", spreadsheetId: "sheet123", nameOrId: "Totals" })).toThrow(/name or range/);
    expect(googleWorkspaceArgv({ command: "sheets.linksGet", spreadsheetId: "sheet123", range: "Sheet1!B2:B" })).toEqual([
      "--readonly", "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "links", "get", "sheet123", "Sheet1!B2:B",
    ]);
    expect(googleWorkspaceArgv({ command: "sheets.linksSet", spreadsheetId: "sheet123", cell: "Sheet1!B2", url: "https://example.com", linkText: "Example", dryRun: true })).toEqual([
      "--account", "auto", "--json", "--no-input", "--wrap-untrusted",
      "sheets", "links", "set", "sheet123", "Sheet1!B2", "https://example.com", "Example", "--dry-run",
    ]);
    expect(() => googleWorkspaceArgv({ command: "sheets.linksSet", spreadsheetId: "sheet123" })).toThrow(/cellsJson, runsJson, or cell\+url/);
  });

  test("validates required args and tool name", () => {
    expect(isGoogleWorkspaceTool("google_workspace")).toBe(true);
    expect(isGoogleWorkspaceTool("browser_snapshot")).toBe(false);
    expect(() => googleWorkspaceArgv({ command: "docs.cat" })).toThrow(/docId/);
    expect(() => googleWorkspaceArgv({ command: "nope" })).toThrow(/must be one of/);
  });
});
