/** Render an existing Writer container for download without rewriting its stored source. */
export async function prepareArtifactDownload(blob: Blob, filename: string): Promise<Blob> {
  if (!/\.html?$/i.test(filename)) return blob;
  const content = await blob.text();
  if (!content.includes("application/vnd.wafflebase.document+json")) return blob;
  const { parseWriterHtml, serializeWriterHtml } = await import(
    "../../../../packages/first-party-apps/writer/src/office-document"
  );
  const parsed = parseWriterHtml(content);
  if (!parsed.ok) return blob;
  return new Blob([serializeWriterHtml(parsed.document.manifest, parsed.document.document)], {
    type: blob.type || "text/html",
  });
}
