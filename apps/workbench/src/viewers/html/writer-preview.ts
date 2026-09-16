import { parseWriterHtml } from "@nautilo/writer-proposal-core";
import { serializeWriterHtml } from "../../../../../packages/first-party-apps/writer/src/office-document";
import { writerPreviewHydrationScriptSource } from "../../../../../packages/first-party-apps/writer/src/writer-preview-hydration";

/** Whether trusted host should inject Writer preview image hydration. */
export function shouldInjectWriterPreviewHydration(htmlContent: string): boolean {
  const parsed = parseWriterHtml(htmlContent);
  return parsed.ok;
}

/** Trusted inline script that hydrates indexed Writer preview image slots. */
export function writerPreviewHydrationScript(): string {
  return writerPreviewHydrationScriptSource();
}


/** Render from canonical payload; accepted proposals need not persist a static body. */
export function renderWriterPreview(htmlContent: string): string {
  const parsed = parseWriterHtml(htmlContent);
  return parsed.ok
    ? serializeWriterHtml(parsed.document.manifest, parsed.document.document)
    : htmlContent;
}
