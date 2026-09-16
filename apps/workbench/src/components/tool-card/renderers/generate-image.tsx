/**
 * D113 + M088B — `generate_image` tool card.
 *
 * Pre-M088B this rendered a thumbnail grid + lightbox by directly reading a
 * server-side absolute path. M088B removed `absolutePath` and `workspaceRoot`
 * from the tool envelope:
 * bytes now live under the server-owned artifact root and are
 * addressed by `artifactId` + logical workspace `path`.
 *
 * M088C provides the authenticated artifact-bytes route. Resolve each
 * external artifact id to its internal row id before loading thumbnails;
 * never return to filesystem paths. Live UI is verified in Electron;
 * pure parsers/layout helpers below are unit-tested.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { ToolCardState } from "../tool-card-helpers";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { looksLikeToolError } from "./shared";
import { apiClient } from "../../../lib/api";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { useToast } from "../../toast";
import { requestOpenFile } from "../../../adapters/open-file-ref";
import { artifactOpenFileTarget } from "../../browser-column/open-file-target";
import { ImageLightbox, Thumbnail, type LightboxImageRef } from "./image-lightbox";
import { GeneratedMediaAmbientFeedback } from "./generated-media-ambient";

export type GenerateImageEnvelope = {
  images: Array<{
    artifactId: string;
    path: string;
    zone: "workspace";
    mime: string;
    bytes: number;
  }>;
  model: string;
  provider: string;
  prompt: string;
};

/**
 * Parse the M088B JSON envelope; return null on malformed/missing/
 * legacy shape. Strict — every image must have artifactId, path, zone,
 * mime, bytes. Pre-M088B envelopes (which had `workspaceRoot` +
 * per-image `absolutePath` and no `artifactId`) intentionally fall
 * through to null so the card degrades to raw JSON instead of
 * silently mis-rendering.
 */
export function parseEnvelope(raw: string | undefined): GenerateImageEnvelope | null {
  if (!raw?.trim()) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (!Array.isArray(o["images"])) return null;
    if (typeof o["model"] !== "string") return null;
    if (typeof o["provider"] !== "string") return null;
    if (typeof o["prompt"] !== "string") return null;
    for (const img of o["images"] as unknown[]) {
      if (!img || typeof img !== "object") return null;
      const i = img as Record<string, unknown>;
      if (typeof i["artifactId"] !== "string" || i["artifactId"].length === 0) return null;
      if (typeof i["path"] !== "string") return null;
      if (i["zone"] !== "workspace") return null;
      if (typeof i["mime"] !== "string") return null;
      if (typeof i["bytes"] !== "number") return null;
    }
    return obj as GenerateImageEnvelope;
  } catch {
    return null;
  }
}

/** Footer text: "<n> image[s] saved to workspace/<subdir>/" */
export function formatFooterText(env: GenerateImageEnvelope): string {
  const n = env.images.length;
  const first = env.images[0];
  const subdir = first ? first.path.split("/").slice(0, -1).join("/") : "";
  const zone = first?.zone ?? "workspace";
  return `${n} image${n === 1 ? "" : "s"} saved to ${zone}/${subdir}/`;
}

/** Pretty-print byte count: "1.4 MB", "697 KB", "204 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type WorkspaceArtifactSummary = {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
};

export type ResolvedGeneratedImage = GenerateImageEnvelope["images"][number] & {
  internalId: string | null;
  resolvedPath: string;
  resolvedMime: string;
};

/**
 * The tool result carries the agent-visible external artifact id, while byte
 * and Work-surface APIs require the internal row id. Prefer external-id
 * matching; path is only a compatibility fallback for older envelopes.
 */
export function resolveGeneratedImages(
  images: GenerateImageEnvelope["images"],
  artifacts: readonly WorkspaceArtifactSummary[],
): ResolvedGeneratedImage[] {
  return images.map((image) => {
    const artifact =
      artifacts.find((candidate) => candidate.artifactId === image.artifactId) ??
      artifacts.find((candidate) => candidate.path === image.path);
    return {
      ...image,
      internalId: artifact?.id ?? null,
      resolvedPath: artifact?.path ?? image.path,
      resolvedMime: artifact?.mimeType || image.mime,
    };
  });
}

function directoryFor(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
}

function GeneratedImageGallery({
  images,
}: {
  images: GenerateImageEnvelope["images"];
}): ReactElement {
  const roomNav = useRoomNavigation();
  const toast = useToast();
  const roomId = roomNav.activeRoomId ?? undefined;
  const lookupKey = images.map((image) => `${image.artifactId}:${image.path}`).join("|");
  const firstImage = images[0];
  const pathPrefix = firstImage && images.every((image) => directoryFor(image.path) === directoryFor(firstImage.path))
    ? directoryFor(firstImage.path)
    : "";
  const [artifacts, setArtifacts] = useState<WorkspaceArtifactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void apiClient
      .listWorkspaceArtifacts({
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(roomId ? { roomId } : {}),
      })
      .then((response) => {
        if (cancelled) return;
        setArtifacts(response.artifacts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setArtifacts([]);
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lookupKey, pathPrefix, roomId]);

  const resolved = useMemo(() => resolveGeneratedImages(images, artifacts), [artifacts, images]);
  const lightboxImages = useMemo(
    () =>
      resolved.flatMap((image): LightboxImageRef[] =>
        image.internalId
          ? [{
              kind: "artifact",
              id: image.internalId,
              mime: image.resolvedMime,
              ...(roomId ? { roomId } : {}),
            }]
          : [],
      ),
    [resolved, roomId],
  );

  const openInWork = useCallback(
    (image: ResolvedGeneratedImage) => {
      if (!image.internalId) return;
      const ok = requestOpenFile(
        artifactOpenFileTarget({
          id: image.internalId,
          path: image.resolvedPath,
          mimeType: image.resolvedMime,
          ...(roomId ? { roomId } : {}),
        }),
      );
      if (!ok) {
        toast.show({
          variant: "warning",
          message: "Could not open the Work surface (not ready). Try again from the Workspace tab.",
        });
      }
    },
    [roomId, toast],
  );

  return (
    <section aria-label="generated images" className="space-y-2">
      {loadError && (
        <p className="text-xs text-tool-error" data-testid="generate-image-artifact-error">
          Could not load generated image previews: {loadError}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {resolved.map((image, index) => {
          const imageRef: LightboxImageRef | null = image.internalId
            ? {
                kind: "artifact",
                id: image.internalId,
                mime: image.resolvedMime,
                ...(roomId ? { roomId } : {}),
              }
            : null;
          const resolvedLightboxIndex = resolved
            .slice(0, index)
            .filter((candidate) => candidate.internalId !== null).length;

          return (
            <article
              key={image.artifactId}
              className="rounded border border-border p-2 space-y-2"
              data-testid={`generate-image-${image.artifactId}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="aspect-square w-full overflow-hidden rounded bg-background-element/30">
                {imageRef ? (
                  <Thumbnail
                    image={imageRef}
                    size="large"
                    onOpen={() => setLightboxIndex(resolvedLightboxIndex)}
                    ariaLabel={`open generated image ${index + 1}`}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-3 text-center text-xs text-foreground-dim">
                    {loading ? "Loading preview…" : "Preview unavailable"}
                  </div>
                )}
              </div>
              <div className="space-y-0.5">
                <div className="font-mono text-xs text-foreground break-all">{image.resolvedPath}</div>
                <div className="flex flex-wrap gap-x-2 text-[0.65rem] text-foreground-dim">
                  <span>{image.resolvedMime}</span>
                  <span>{formatBytes(image.bytes)}</span>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!image.internalId}
                  onClick={() => openInWork(image)}
                  className="rounded border border-border px-2 py-1 text-[0.7rem] font-medium text-foreground-muted hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Open
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onStep={(delta) => {
            setLightboxIndex((current) => {
              if (current === null || lightboxImages.length === 0) return null;
              return (current + delta + lightboxImages.length) % lightboxImages.length;
            });
          }}
        />
      )}
    </section>
  );
}

function GenerateImageExpanded(props: ToolRendererProps): ReactElement {
  const { resultText, state, event } = props;
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const env = toolError ? null : parseEnvelope(resultText);

  if (toolError) {
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
          Tool error
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{toolError}</pre>
      </div>
    );
  }

  if (!env) {
    const ambientState = state === "running" ? "generating" : null;
    return (
      <div className="border-t border-border px-3 py-2 space-y-2">
        {ambientState && <GeneratedMediaAmbientFeedback mediaKind="image" state={ambientState} />}
        {resultText && <pre className="whitespace-pre-wrap break-words text-xs">{resultText}</pre>}
        {state === "error" && event?.error && (
          <pre className="text-xs text-tool-error whitespace-pre-wrap">{event.error}</pre>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2 space-y-3">
      <section aria-label="prompt">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
          Prompt
        </div>
        <p className="text-xs text-foreground whitespace-pre-wrap break-words line-clamp-4">{env.prompt}</p>
      </section>
      <GeneratedImageGallery images={env.images} />
      <p className="text-[0.65rem] text-foreground-dim">
        Model {env.model} · provider {env.provider} · {formatFooterText(env)}
      </p>
    </div>
  );
}

function collapsedSummary(input: {
  args: Record<string, unknown>;
  result: unknown;
  state: ToolCardState;
  resultText: string | undefined;
}): string {
  const env = parseEnvelope(input.resultText);
  const n = env?.images?.length ?? 0;
  const model = env?.model ?? "";
  if (n === 0) return "generate_image";
  return `Generate image · ${model} · ${n} image${n === 1 ? "" : "s"}`;
}

export const generateImageRenderer: ToolRenderer = {
  collapsedSummary,
  autoExpandOnResult: true,
  autoExpandWhileRunning: true,
  ExpandedBody: GenerateImageExpanded,
};
