import { useEffect, useState, type ReactNode } from "react";
import type { MediaGenerationApproval } from "@nautilo/types";
import { apiClient } from "../lib/api";

type Reference = NonNullable<MediaGenerationApproval["preview"]["referenceImages"]>[number];
export type GenerationReviewPresentation = {
  prompt: string;
  sceneName?: string;
  continuation?: { artifactId: string; sceneName: string };
  referenceNames: Record<string, string>;
};

export function friendlyReferenceName(label: string, fallback: string): string {
  return /^(?:mg_|[a-f0-9]{8}-[a-f0-9]{4}-)/iu.test(label) ? fallback : label;
}

export function generationPrice(approval: MediaGenerationApproval): string {
  // Keep sub-cent quotes exact while avoiding six trailing zeroes.
  return `$${(approval.preview.quote.amountMicros / 1_000_000).toFixed(6).replace(/0{1,4}$/u, "")}`;
}

export async function loadApprovalReference(reference: Reference, roomId: string | undefined, signal: AbortSignal): Promise<Blob> {
  if (!reference.content) throw new Error("This older approval has no verified preview. Request a fresh quote.");
  const { content } = reference;
  const artifact = await apiClient.getWorkspaceArtifactByPublicId(reference.artifactId, { roomId, signal });
  if (signal.aborted) throw new Error("Cancelled");
  if (!artifact || artifact.artifactId !== reference.artifactId || artifact.size !== content.sizeBytes || artifact.mimeType !== content.mimeType) {
    throw new Error("Reference changed or is unavailable. Request a fresh quote.");
  }
  const bytes = await apiClient.getWorkspaceArtifactBytesArrayBuffer(artifact.id, {
    roomId, signal, expectedBytes: content.sizeBytes, maxBytes: content.sizeBytes,
  });
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (signal.aborted || hash !== content.sha256) throw new Error("Reference changed. Request a fresh quote.");
  return new Blob([bytes], { type: content.mimeType });
}

function ReferenceCard({ reference, label, kind, duration, continuation, roomId }: {
  reference: Reference; label: string; kind: "image" | "video" | "audio"; duration?: number; continuation?: boolean; roomId?: string;
}) {
  const [preview, setPreview] = useState<{ key: string; url?: string; failed?: boolean }>();
  const key = `${reference.artifactId}:${reference.content?.sha256 ?? "unbound"}:${roomId ?? ""}`;
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void loadApprovalReference(reference, roomId, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ key, url });
    }).catch(() => { if (!controller.signal.aborted) setPreview({ key, failed: true }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [key, reference, roomId]);
  const current = preview?.key === key ? preview : undefined;
  return <li className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
    <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-black/30">
      {current?.url ? kind === "video"
        ? <video className="h-full w-full object-contain" src={current.url} controls playsInline preload="auto" aria-label={`Preview ${label}`} onError={() => setPreview({ key, failed: true })} />
        : kind === "audio"
          ? <audio className="w-[calc(100%_-_1rem)]" src={current.url} controls preload="metadata" aria-label={`Preview ${label}`} onError={() => setPreview({ key, failed: true })} />
          : <img className="h-full w-full object-contain" src={current.url} alt={label} onError={() => setPreview({ key, failed: true })} />
        : <p role="status" className="p-3 text-center text-xs text-foreground-muted">{current?.failed ? "Preview unavailable · cancel and request a fresh quote" : "Loading reference…"}</p>}
    </div>
    <div className="p-2">
      <div className="break-words text-sm font-medium text-foreground">{label}</div>
      <div className="text-xs text-foreground-muted">{continuation ? "Continue from this take" : kind === "video" ? "Video reference" : kind === "audio" ? "Audio reference" : "Image reference"}{duration !== undefined ? ` · ${Number(duration.toFixed(2))} sec` : ""}</div>
    </div>
  </li>;
}

export function MediaGenerationVisualReview({ approval, presentation, roomId, technicalDetails }: {
  approval: MediaGenerationApproval; presentation?: GenerationReviewPresentation; roomId?: string; technicalDetails: ReactNode;
}) {
  const { preview } = approval;
  const images = preview.referenceImages ?? [];
  const videos = preview.referenceVideos ?? [];
  const audios = preview.referenceAudios ?? [];
  const settings = preview.settings;
  const modelLabel = ({ "seedance-2-5-text-to-video-basic": "Seedance 2.5", "seedance-2-5-reference-to-video-basic": "Seedance 2.5 · References", "minimax-h3-enhanced-text-to-video": "MiniMax H3", "sonilo-v1-1-music": "Sonilo", "minimax-music-v26": "MiniMax Music" } as Record<string, string>)[preview.model] ?? preview.model;
  const summary = [modelLabel, settings.durationSeconds === undefined ? null : `${settings.durationSeconds} sec`, settings.resolution, settings.aspectRatio,
    settings.audio === undefined ? null : settings.audio ? "With audio" : "No audio"].filter(value => value != null).join(" · ");
  return <section className="mt-4 min-w-0 space-y-4" aria-label={`Paid ${preview.mediaKind} generation`} data-testid="media-generation-approval">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-semibold text-foreground">{presentation?.sceneName ?? `New ${preview.mediaKind}`}</h3><p className="text-sm text-foreground-muted">{summary}</p></div>
      <strong className="text-xl tabular-nums text-foreground" data-testid="media-generation-quote">{generationPrice(approval)}</strong>
    </div>
    {images.length + videos.length + audios.length > 0 ? <div>
      <h4 className="mb-2 text-sm font-medium text-foreground">{presentation?.continuation ? `Continuing from ${presentation.continuation.sceneName}` : "Your references"}</h4>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="media-generation-reference-list">
        {videos.map(reference => <ReferenceCard key={`video:${reference.index}`} reference={reference} kind="video" duration={reference.durationSeconds} roomId={roomId}
          continuation={presentation?.continuation?.artifactId === reference.artifactId}
          label={friendlyReferenceName(presentation?.referenceNames[reference.artifactId] ?? reference.label, `Video reference ${reference.index}`)} />)}
        {audios.map(reference => <ReferenceCard key={`audio:${reference.index}`} reference={reference} kind="audio" duration={reference.durationSeconds} roomId={roomId}
          label={friendlyReferenceName(presentation?.referenceNames[reference.artifactId] ?? reference.label, `Audio reference ${reference.index}`)} />)}
        {images.map(reference => <ReferenceCard key={`image:${reference.index}`} reference={reference} kind="image" roomId={roomId}
          label={friendlyReferenceName(presentation?.referenceNames[reference.artifactId] ?? reference.label, `Image reference ${reference.index}`)} />)}
      </ul>
    </div> : null}
    <div><h4 className="mb-1 text-sm font-medium text-foreground">Scene prompt</h4>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{presentation?.prompt ?? preview.prompt.summary}{!presentation && preview.prompt.truncated ? "… (summary)" : ""}</p>
    </div>
    <p className="text-xs text-foreground-muted">One paid generation. No automatic retry. Quote valid until <time dateTime={approval.expiresAt}>{new Date(approval.expiresAt).toLocaleTimeString()}</time>.</p>
    <details className="min-w-0 text-xs text-foreground-muted"><summary className="cursor-pointer">Technical details</summary>{technicalDetails}</details>
  </section>;
}
