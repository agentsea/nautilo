import { expect, test } from "bun:test";
import { recoveryCopyFilename } from "../../src/apps/document-recovery-copy";
test("recovery filename uses host-bound basename and preserves extension", () => {
  expect(recoveryCopyFilename("private/folder/budget.document.html")).toBe("budget.document-copy.html");
  expect(recoveryCopyFilename("C:\\private\\budget.html")).toBe("budget-copy.html");
  expect(recoveryCopyFilename("/../../\u0000report.html")).toBe("report-copy.html");
  expect(recoveryCopyFilename("")).toBe("document-copy.html");
});
