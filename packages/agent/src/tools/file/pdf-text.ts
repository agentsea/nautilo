import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { ATTACHMENT_POLICY } from "@nautilo/attachments";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export interface PdfTextPage {
  page: number;
  text: string;
}

export interface PdfTextResult {
  pages: PdfTextPage[];
  totalPages: number;
  nextPage: number | null;
  /** False when a page has no extractable text, or the requested window ends early. */
  complete: boolean;
  emptyPages: number[];
}

/** Extract inert text locally. Never run PDF actions, fetch URLs, or invoke a model. */
export async function extractPdfText(
  bytes: Uint8Array,
  options: { fromPage?: number; pageCount?: number; signal?: AbortSignal } = {},
): Promise<PdfTextResult> {
  options.signal?.throwIfAborted();
  if (bytes.byteLength > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) {
    throw new Error("PDF exceeds the attachment processing byte budget. Split the document before text conversion.");
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  const abort = () => { void task.destroy().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const document = await task.promise;
    const from = options.fromPage ?? 1;
    if (!Number.isSafeInteger(from) || from < 1 || from > document.numPages) {
      throw new Error(`PDF page offset must be between 1 and ${document.numPages}.`);
    }
    if (options.pageCount !== undefined && (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1)) {
      throw new Error("PDF page limit must be a positive integer.");
    }
    const end = Math.min(document.numPages, from + (options.pageCount ?? document.numPages) - 1);
    const pages: PdfTextPage[] = [];
    const emptyPages: number[] = [];
    let textBytes = 0;
    for (let pageNumber = from; pageNumber <= end; pageNumber++) {
      // The server's in-process PDF worker can otherwise starve cancellation events.
      await yieldToEventLoop();
      options.signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader();
      let text = "";
      let pageBytes = 0;
      let pageOverBudget = false;
      let windowOverBudget = false;
      try {
        for (;;) {
          await yieldToEventLoop();
          options.signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            const part = item.str + (item.hasEOL ? "\n" : "");
            pageBytes += Buffer.byteLength(part, "utf8");
            pageOverBudget ||= pageBytes > ATTACHMENT_POLICY.maxTextBytes;
            windowOverBudget ||= textBytes + pageBytes > ATTACHMENT_POLICY.maxTextBytes;
            // Drain this page without retaining more text. Cancelling an already-closing
            // PDF.js stream races its close message under Bun.
            if (!windowOverBudget) text += part;
          }
        }
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
      if (pageOverBudget) {
        throw new Error(`PDF page ${pageNumber} exceeds the text extraction budget; use a PDF-capable reader for this page.`);
      }
      if (windowOverBudget) {
        return { pages, totalPages: document.numPages, nextPage: pageNumber, complete: false, emptyPages };
      }
      textBytes += pageBytes;
      text = text.trim();
      pages.push({ page: pageNumber, text });
      if (!text) emptyPages.push(pageNumber);
    }
    const nextPage = end < document.numPages ? end + 1 : null;
    return { pages, totalPages: document.numPages, nextPage,
      complete: from === 1 && nextPage === null && emptyPages.length === 0, emptyPages };
  } catch (error) {
    options.signal?.throwIfAborted();
    // Parser diagnostics can contain document data. Only our recovery messages leave this seam.
    if (error instanceof Error && /^PDF page (?:offset|limit|\d+ exceeds)/.test(error.message)) throw error;
    throw new Error("PDF text could not be extracted. The file may be damaged or password protected; use an unlocked PDF or a PDF-capable reader.");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await task.destroy().catch(() => {});
  }
}

export function pdfTextContent(result: PdfTextResult): string {
  return result.pages.map(({ page, text }) => `[Page ${page}]\n${text}`).join("\n\n");
}
