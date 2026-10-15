import { describe, expect, test } from "bun:test";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { extractPdfText } from "../../src/tools/file/pdf-text";
import { convertPdfText } from "../../src/tools/convert/pdf-to-text";
import { syntheticPdf } from "../helpers/synthetic-pdf";

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "unexpected success"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

describe("local PDF text reading and conversion", () => {
  test("reads every page locally and preserves literal text in DOCX", async () => {
    const bytes = syntheticPdf(["Synthetic contract: amount 123.45", "Literal *stars* and <brackets>"]);
    const result = await extractPdfText(bytes);
    expect(result.complete).toBe(true);
    expect(result.totalPages).toBe(2);
    expect(result.pages.map((page) => page.text)).toEqual(["Synthetic contract: amount 123.45", "Literal *stars* and <brackets>"]);
    const docx = await convertPdfText(bytes, "docx");
    const { unzipSync, strFromU8 } = await import("fflate");
    const xml = strFromU8(unzipSync(docx)["word/document.xml"]!);
    expect(xml).toContain("Synthetic contract: amount 123.45");
    expect(xml).toContain("Literal *stars* and &lt;brackets&gt;");
    expect(xml).toContain("pageBreakBefore");
  });

  test("page windows have explicit continuation", async () => {
    const bytes = syntheticPdf(["First page", "Second page"]);
    expect(await extractPdfText(bytes, { pageCount: 1 })).toMatchObject({
      pages: [{ page: 1, text: "First page" }], nextPage: 2, complete: false,
    });
    expect(await extractPdfText(bytes, { fromPage: 2 })).toMatchObject({
      pages: [{ page: 2, text: "Second page" }], nextPage: null, complete: false,
    });
  });

  test("scanned or empty pages cannot silently produce a complete conversion", async () => {
    const bytes = syntheticPdf(["Readable page", ""]);
    expect(await extractPdfText(bytes)).toMatchObject({ emptyPages: [2], complete: false });
    expect(await rejectionMessage(convertPdfText(bytes, "docx"))).toContain("No output was created");
  });

  test("damaged page operators cannot be silently discarded as a complete read", async () => {
    const bytes = syntheticPdf(["Readable paragraph before a broken object"], " /Missing Do");
    expect(await rejectionMessage(extractPdfText(bytes))).toContain("PDF text could not be extracted");
    expect(await rejectionMessage(convertPdfText(bytes, "docx"))).toContain("PDF text could not be extracted");
  });

  test("text budget ends at a page boundary and refuses partial conversion", async () => {
    const line = "A".repeat(Math.floor(ATTACHMENT_POLICY.maxTextBytes / 2) + 1);
    const bytes = syntheticPdf([line, line, "Last page"]);
    const result = await extractPdfText(bytes);
    expect(result.complete).toBe(false);
    expect(result.nextPage).not.toBeNull();
    expect(await rejectionMessage(convertPdfText(bytes, "txt"))).toContain("No output was created");
  });

  test("bad PDFs and cancellation fail without a document-content diagnostic", async () => {
    expect(await rejectionMessage(extractPdfText(Buffer.from("%PDF-1.4\nprivate-payload")))).toContain("PDF text could not be extracted");
    const controller = new AbortController();
    controller.abort();
    expect(await rejectionMessage(extractPdfText(syntheticPdf(["Text"]), { signal: controller.signal }))).not.toBe("unexpected success");
  });

  test("in-flight extraction yields so cancellation can interrupt before completion", async () => {
    const controller = new AbortController();
    const extraction = extractPdfText(syntheticPdf(Array.from({ length: 64 }, () => "Synthetic page")), { signal: controller.signal });
    const scheduledAbort = setImmediate(() => controller.abort(new Error("Synthetic cancellation")));
    try {
      expect(await rejectionMessage(extraction)).toBe("Synthetic cancellation");
    } finally {
      clearImmediate(scheduledAbort);
    }
  });
});
