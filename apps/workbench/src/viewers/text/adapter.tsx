import { desktopAPI } from "../../lib/desktop";
import { loadArtifactViewerBlob } from "../artifact-byte-source";
import { previewKindForPath } from "../../lib/file-preview";
import { CodeBlock } from "./code-block";
import type { ViewerAdapter } from "../types";

function TextViewerBody({ data }: { data: unknown }) {
  const typed = data as { content: string; language: string | null };
  return <CodeBlock code={typed.content} language={typed.language} />;
}

export const textViewerAdapter: ViewerAdapter = {
  kind: "text",
  canView(file) {
    if (file.kind === "artifact") return file.mimeType.startsWith("text/");
    return previewKindForPath(file.path).kind === "text";
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
      const preview = previewKindForPath(file.path);
      const language = preview.kind === "text" ? preview.language : null;
      const content = await blob.text();
      return { kind: "ready", data: { content, language } };
    }
    if (!desktopAPI) return { kind: "error", message: "Desktop file bridge unavailable." };
    const preview = previewKindForPath(file.path);
    if (preview.kind !== "text") return { kind: "unsupported", ext: null };
    const stat = await desktopAPI.fs.stat(file.path);
    if (!stat.exists) return { kind: "error", message: "File no longer exists." };
    if (stat.size > ctx.maxTextBytes) {
      return { kind: "too_large", sizeBytes: stat.size, maxBytes: ctx.maxTextBytes };
    }
    const content = await desktopAPI.fs.readFile(file.path);
    return { kind: "ready", data: { content, language: preview.language } };
  },
  Component: TextViewerBody,
};
