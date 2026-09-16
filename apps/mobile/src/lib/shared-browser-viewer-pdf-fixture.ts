/**
 * A deterministic, local-only PDF used to exercise the Web qualification
 * renderer. It has one page and only ASCII PDF objects: it is neither a user
 * document nor an acquisition path.
 */
export const SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID =
  "nautilo.shared-browser-viewer.pdf-fixture.v1" as const;
export const SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT = 1 as const;
/** Updated only when the deterministic fixture bytes intentionally change. */
export const SHARED_BROWSER_VIEWER_PDF_FIXTURE_SHA256 =
  "58d37b7283ff7cf7b4ad8c03b3d3c54fba9ec87a1467bccd5192e7c045e49be3" as const;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Creates a valid one-page PDF and computes every cross-reference offset. */
export function buildSharedBrowserViewerPdfFixture(): Uint8Array {
  const content = "BT\n/F1 12 Tf\n72 72 Td\n(Nautilo PDF qualification fixture) Tj\nET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReferenceOffset = byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF\n`;
  return encoder.encode(source);
}
