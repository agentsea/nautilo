/** Closed, resolution-relative typography shared by browser preview and native
 * rasterization. Text is data, never HTML, CSS, a URL, or an FFmpeg expression.
 * Captions are burned in; this contract does not imply an editable subtitle stream.
 */
export type TextCompositionKind = "text" | "caption" | "callout";

export function isTextCompositionKind(kind: string): kind is TextCompositionKind {
  return kind === "text" || kind === "caption" || kind === "callout";
}

function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function renderTextCompositionMarkup(kind: TextCompositionKind, text: string): string {
  const align = kind === "caption" ? "flex-end" : "center";
  const background = kind === "text" ? "transparent" : "#000b";
  return `<div style="position:absolute;inset:0;container-type:size;pointer-events:none"><div data-text-safe-area style="position:absolute;inset:5%;display:flex;align-items:${align};justify-content:center"><span data-text-content style="display:block;flex-shrink:0;max-width:100%;box-sizing:border-box;font-family:Arial,sans-serif;font-size:3cqw;font-weight:400;font-style:normal;line-height:1.25;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;color:white;background:${background};padding:0.3em">${escapeText(text)}</span></div></div>`;
}

export function renderTextCompositionHtml(kind: TextCompositionKind, text: string, width: number, height: number): string {
  if (!isTextCompositionKind(kind) || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new Error("invalid_text_composition");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"></head><body style="margin:0;background:transparent"><div style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${renderTextCompositionMarkup(kind, text)}</div></body></html>`;
}
