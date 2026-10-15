import { Document, Packer, Paragraph, TextRun } from "docx";
import { extractPdfText } from "../file/pdf-text";

export const PDF_TEXT_CONVERSION_WARNING =
  "Converted the PDF text layer locally. Images, layout, annotations, signatures, and redline styling are not preserved; review against the original PDF.";

/** Deterministic text conversion. Never invent OCR text or silently publish a partial document. */
export async function convertPdfText(
  bytes: Uint8Array,
  format: "txt" | "md" | "docx",
  signal?: AbortSignal,
): Promise<Buffer> {
  const result = await extractPdfText(bytes, signal ? { signal } : {});
  if (!result.complete) {
    throw new Error("PDF text conversion is incomplete: some pages have no text layer or exceed the extraction budget. No output was created. Use a PDF-capable reader or OCR before conversion.");
  }
  signal?.throwIfAborted();
  if (format === "docx") {
    const paragraphs = result.pages.flatMap(({ text }, pageIndex) =>
      text.split("\n").map((line, lineIndex) => new Paragraph({
        pageBreakBefore: pageIndex > 0 && lineIndex === 0,
        children: [new TextRun(line)],
      })),
    );
    return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
  }
  const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}[\]()#+\-.!<>|~])/g, "\\$1");
  return Buffer.from(result.pages.map(({ page, text }) => format === "md"
    ? `## Page ${page}\n\n${escapeMarkdown(text)}`
    : text).join(format === "md" ? "\n\n" : "\n\f\n"), "utf8");
}
