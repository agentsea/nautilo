import { PDFDocument } from 'pdf-lib';
export async function buildPdfFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return pdf.save();
}
