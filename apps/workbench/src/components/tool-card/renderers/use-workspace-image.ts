/** Bounded Workspace-image loader. Local and Artifact bytes both become Blob URLs. */
import { useEffect, useState } from "react";
import { apiClient } from "../../../lib/api";
import { loadBinaryPreview } from "../../../lib/binary-preview-source";
import { isDesktop, desktopAPI } from "../../../lib/desktop";

const MAX_WORKSPACE_IMAGE_BYTES = 25 * 1024 * 1024;
const WORKSPACE_IMAGE_LOAD_TIMEOUT_MS = 35_000;
type CachedUrl = { url: string; refs: number };
const imageUrlCache = new Map<string, CachedUrl>();

function cacheKey(args: UseWorkspaceImageArgs): string {
  return args.kind === "fs" ? `fs:${args.absolutePath}` : `art:${args.id}:${args.roomId ?? ""}`;
}
function retainCachedImage(key: string): string | undefined {
  const cached = imageUrlCache.get(key);
  if (!cached) return undefined;
  cached.refs += 1;
  return cached.url;
}
function cacheImage(key: string, blob: Blob): string {
  const existing = retainCachedImage(key);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  imageUrlCache.set(key, { url, refs: 1 });
  return url;
}
function releaseCachedImage(key: string): void {
  const cached = imageUrlCache.get(key);
  if (!cached) return;
  cached.refs -= 1;
  if (cached.refs <= 0) {
    URL.revokeObjectURL(cached.url);
    imageUrlCache.delete(key);
  }
}

export async function loadArtifactWorkspaceImageUrl(
  id: string,
  opts?: { roomId?: string; signal?: AbortSignal },
): Promise<string> {
  const key = `art:${id}:${opts?.roomId ?? ""}`;
  const bytes = await loadBinaryPreview({
    kind: "artifact", id, path: id, mimeType: "image/*", ...(opts?.roomId !== undefined ? { roomId: opts.roomId } : {}),
  }, {
    getWorkspaceArtifactBytesArrayBuffer: (artifactId, options) => apiClient.getWorkspaceArtifactBytesArrayBuffer(artifactId, options),
    desktopAPI,
  }, {
    maxBytes: MAX_WORKSPACE_IMAGE_BYTES,
    signal: opts?.signal ?? new AbortController().signal,
    timeoutMs: WORKSPACE_IMAGE_LOAD_TIMEOUT_MS,
  });
  if (bytes.kind !== "ready") throw new Error(bytes.kind === "error" ? bytes.message : "Image is too large to preview.");
  return cacheImage(key, new Blob([bytes.bytes], { type: "image/*" }));
}

export type ImageLoadState =
  | { kind: "loading" }
  | { kind: "ok"; dataUrl: string }
  | { kind: "error"; message: string };
export type UseWorkspaceImageArgs =
  | { kind: "fs"; absolutePath: string; mime: string }
  | { kind: "artifact"; id: string; mime: string; roomId?: string };

export function describeLoadError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
export function getCachedImage(absolutePath: string): string | undefined {
  return imageUrlCache.get(`fs:${absolutePath}`)?.url;
}
export function _resetWorkspaceImageCache(): void {
  for (const { url } of imageUrlCache.values()) URL.revokeObjectURL(url);
  imageUrlCache.clear();
}

export function useWorkspaceImage(args: UseWorkspaceImageArgs): ImageLoadState {
  const key = cacheKey(args);
  const kind = args.kind;
  const mime = args.mime;
  const absolutePath = args.kind === "fs" ? args.absolutePath : undefined;
  const artifactId = args.kind === "artifact" ? args.id : undefined;
  const roomId = args.kind === "artifact" ? args.roomId : undefined;
  const [state, setState] = useState<ImageLoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let retained = false;
    const cached = retainCachedImage(key);
    if (cached) {
      retained = true;
      setState({ kind: "ok", dataUrl: cached });
      return () => { if (retained) releaseCachedImage(key); };
    }
    if (kind === "fs" && (!isDesktop || !desktopAPI?.binaryRead)) {
      setState({ kind: "error", message: "Workspace images require the desktop app." });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    const target = kind === "fs"
      ? { kind: "fs" as const, path: absolutePath!, rootPath: absolutePath! }
      : { kind: "artifact" as const, id: artifactId!, path: artifactId!, mimeType: mime, ...(roomId !== undefined ? { roomId } : {}) };
    void loadBinaryPreview(target, {
      getWorkspaceArtifactBytesArrayBuffer: (id, options) => apiClient.getWorkspaceArtifactBytesArrayBuffer(id, options),
      desktopAPI,
    }, {
      maxBytes: MAX_WORKSPACE_IMAGE_BYTES,
      signal: controller.signal,
      timeoutMs: WORKSPACE_IMAGE_LOAD_TIMEOUT_MS,
    })
      .then((result) => {
        if (result.kind !== "ready") throw new Error(result.kind === "error" ? result.message : "Image is too large to preview.");
        const url = cacheImage(key, new Blob([result.bytes], { type: mime }));
        retained = true;
        if (cancelled) { releaseCachedImage(key); return; }
        setState({ kind: "ok", dataUrl: url });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: describeLoadError(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (retained) releaseCachedImage(key);
    };
  }, [absolutePath, artifactId, key, kind, mime, roomId]);
  return state;
}
