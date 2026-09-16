import { PDFDocument } from 'pdf-lib';

/** Inspect without rewriting bytes. Browser-prepared output must be a readable
 * PDF with one page per slide and positive page dimensions before canonical file creation. */
export async function validateSlidesPdf(bytes: Uint8Array, expectedPages: number): Promise<void> {
  const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
  const pages = pdf.getPages();
  if (!pages.length || pages.length !== expectedPages) throw new Error('PDF page count does not match the presentation.');
  for (const page of pages) {
    const { width, height } = page.getSize();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('PDF contains an invalid page size.');
    }
  }
}
