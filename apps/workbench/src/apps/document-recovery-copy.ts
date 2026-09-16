/** The host owns the filename and download surface. An iframe receives neither
 * filesystem authority nor a new canonical document binding for this action. */
export function recoveryCopyFilename(path: string): string {
  const basename = path.split(/[\\/]/).pop()?.split("").filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("") || "document.html";
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? `${basename.slice(0, dot)}-copy${basename.slice(dot)}` : `${basename}-copy`;
}
export function downloadDocumentCopy(content: string, path: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = recoveryCopyFilename(path);
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Release after the browser has consumed this task's navigation request.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
