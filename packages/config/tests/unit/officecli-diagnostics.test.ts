import { describe, expect, test } from "bun:test";
import {
  formatOfficeHelpFailure,
  OFFICE_HELP_FORMAT_ERROR,
  resolveOfficeHelpFormat,
} from "../../src/officecli/diagnostics";

describe("OfficeCLI help diagnostics", () => {
  test("resolves explicit format, then legacy type, then each recognized path extension", () => {
    const cases: Array<{
      input: Parameters<typeof resolveOfficeHelpFormat>[0];
      expected: ReturnType<typeof resolveOfficeHelpFormat>;
    }> = [
      { input: { format: "pptx", type: "docx", path: "report.xlsx" }, expected: "pptx" },
      { input: { type: "xlsx", path: "report.docx" }, expected: "xlsx" },
      { input: { path: "reports/brief.docx" }, expected: "docx" },
      { input: { path: "reports/brief.XLSX" }, expected: "xlsx" },
      { input: { path: "reports/brief.pptx" }, expected: "pptx" },
      { input: { path: "reports/brief.md" }, expected: undefined },
      { input: {}, expected: undefined },
    ];

    for (const { input, expected } of cases) {
      expect(resolveOfficeHelpFormat(input)).toBe(expected);
    }
    expect(OFFICE_HELP_FORMAT_ERROR).toContain(".docx/.xlsx/.pptx");
  });

  test("prefers a bounded structured stdout message over stderr and exit code", () => {
    expect(formatOfficeHelpFailure({
      stdout: JSON.stringify({
        success: false,
        error: {
          error: "error: unknown element 'create' for format 'docx'.\nUse: officecli help docx",
          code: "internal_error",
        },
      }),
      stderr: "generic process failure",
      exitCode: 1,
    })).toBe("officecli help failed: error: unknown element 'create' for format 'docx'. Use: officecli help docx");
  });

  test("falls back from structured stdout to stderr and then the exit code", () => {
    expect(formatOfficeHelpFailure({ stdout: "not-json", stderr: "binary says no", exitCode: 2 }))
      .toBe("officecli help failed: binary says no");
    expect(formatOfficeHelpFailure({ stdout: "", stderr: "", exitCode: 3 }))
      .toBe("officecli help failed: exit 3");
  });

  test("does not echo an unbounded message payload", () => {
    const message = "x".repeat(900);
    const formatted = formatOfficeHelpFailure({
      stdout: JSON.stringify({ error: { message } }),
      stderr: "",
      exitCode: 1,
    });

    expect(formatted.length).toBeLessThan(700);
    expect(formatted).toContain("...");
  });
});
