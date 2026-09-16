import { useEffect, useState } from "react";
import { apiClient } from "../../lib/api";
import { loadArtifactViewerArrayBuffer } from "../artifact-byte-source";
import { desktopAPI } from "../../lib/desktop";
import { loadBinaryPreview } from "../../lib/binary-preview-source";
import { imageMimeForPath, isImageMime, isImagePath } from "../file-kind";
import type { ViewerAdapter } from "../types";

const MAX_IMAGE_VIEWER_BYTES = 25 * 1024 * 1024;

function ImageViewer({ data }: { data: unknown }) {
  const typed = data as { blob: Blob; alt: string };
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(typed.blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [typed.blob]);
  return (
    <div className="flex min-h-full items-start justify-center">
      <img
        src={src ?? undefined}
        alt={typed.alt}
        className="max-h-full max-w-full rounded-md border border-border bg-background-panel object-contain"
      />
    </div>
  );
}

export const imageViewerAdapter: ViewerAdapter = {
  kind: "image",
  canView(file) {
    return file.kind === "fs" ? isImagePath(file.path) : isImageMime(file.mimeType);
  },
  async load(file, ctx) {
    const mime = file.kind === "artifact" && file.mimeType.startsWith("image/")
      ? file.mimeType
      : imageMimeForPath(file.path);
    if (!mime) return { kind: "unsupported", ext: null };
    const result = await loadBinaryPreview(file, {
      getWorkspaceArtifactBytesArrayBuffer: (id, options) =>
        file.kind === "artifact" && ctx.artifactBytes !== undefined
          ? loadArtifactViewerArrayBuffer(file, ctx, options?.maxBytes ?? MAX_IMAGE_VIEWER_BYTES)
          : apiClient.getWorkspaceArtifactBytesArrayBuffer(id, options),
      desktopAPI,
    }, {
      maxBytes: MAX_IMAGE_VIEWER_BYTES,
      signal: ctx.signal ?? new AbortController().signal,
      timeoutMs: Math.max(1, (ctx.deadlineAt ?? Date.now() + 35_000) - Date.now()),
      ...(ctx.deadlineAt !== undefined ? { deadlineAt: ctx.deadlineAt } : {}),
    });
    if (result.kind !== "ready") return result;
    const name = file.path.split(/[/\\]/).pop() ?? file.path;
    return {
      kind: "ready",
      data: {
        blob: new Blob([result.bytes], { type: file.kind === "artifact" && file.mimeType.startsWith("image/") ? file.mimeType : mime }),
        alt: name,
      },
    };
  },
  Component: ImageViewer,
};
