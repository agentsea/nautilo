import { desktopAPI } from "../../lib/desktop";
import { loadArtifactViewerBlob } from "../artifact-byte-source";
import { previewKindForPath } from "../../lib/file-preview";
import { ReaderMarkdown } from "./markdown-viewer";
import type { ViewerAdapter } from "../types";

function MarkdownViewerBody({ data }: { data: unknown }) {
  const typed = data as { content: string };
  return <ReaderMarkdown content={typed.content} />;
}

export const markdownViewerAdapter: ViewerAdapter = {
  kind: "markdown",
  canView(file) {
    if (file.kind === "artifact") {
      return file.mimeType === "text/markdown" || file.path.toLowerCase().endsWith(".md");
    }
    return previewKindForPath(file.path).kind === "markdown";
  },
  async load(file, ctx) {
    if (file.kind === "artifact") {
      if (file.sizeBytes !== undefined && file.sizeBytes > ctx.maxTextBytes) {
        return { kind: "too_large", sizeBytes: file.sizeBytes, maxBytes: ctx.maxTextBytes };
      }
      const blob = await loadArtifactViewerBlob(file, ctx, ctx.maxTextBytes);
      if (blob.size > ctx.maxTextBytes) {
        return { kind: "too_large", sizeBytes: blob.size, maxBytes: ctx.maxTextBytes };
      }
      const content = await blob.text();
      return { kind: "ready", data: { content } };
    }
    if (!desktopAPI) return { kind: "error", message: "Desktop file bridge unavailable." };
    const stat = await desktopAPI.fs.stat(file.path);
    if (!stat.exists) return { kind: "error", message: "File no longer exists." };
    if (stat.size > ctx.maxTextBytes) {
      return { kind: "too_large", sizeBytes: stat.size, maxBytes: ctx.maxTextBytes };
    }
    const content = await desktopAPI.fs.readFile(file.path);
    return { kind: "ready", data: { content } };
  },
  Component: MarkdownViewerBody,
};
