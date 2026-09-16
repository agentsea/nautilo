import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactElement } from "react";
import type { ArtifactDto } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { hasFocusedTurnDispatcher, requestFocusedTurn } from "../../../adapters/tool-invoke-ref";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { generatedMediaRenderer } from "./generated-media";

const GeneratedMediaExpandedBody = generatedMediaRenderer.ExpandedBody;

const MAX_REFERENCE_IMAGES = 30;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_QUEUE_JSON_BYTES = 35 * 1024 * 1024;

type VideoBriefEnvelope = {
  kind: "video_generation_brief";
  version: 1;
  mode: "reference";
  model: "seedance-2-5-reference-to-video-basic";
  prompt: string;
  settings: {
    durationSeconds: number;
    aspectRatio: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
    resolution: "480p" | "720p" | "1080p";
    audio: boolean;
  };
  filename?: string;
};

type ReferenceImage = Pick<ArtifactDto, "id" | "artifactId" | "path" | "mimeType" | "size">;
type StoredDraft = {
  prompt: string;
  settings: VideoBriefEnvelope["settings"];
  filename?: string;
  references: ReferenceImage[];
};

const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVideoBriefEnvelope(raw: string | undefined): VideoBriefEnvelope | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || Object.keys(value).some((key) =>
      !["kind", "version", "mode", "model", "prompt", "settings", "filename"].includes(key))) return null;
    if (value.kind !== "video_generation_brief" || value.version !== 1 || value.mode !== "reference" ||
      value.model !== "seedance-2-5-reference-to-video-basic" ||
      typeof value.prompt !== "string" || value.prompt.trim().length === 0 || value.prompt.length > 15_000 ||
      !isRecord(value.settings)) return null;
    const settings = value.settings;
    if (Object.keys(settings).some((key) =>
      !["durationSeconds", "aspectRatio", "resolution", "audio"].includes(key)) ||
      !Number.isInteger(settings.durationSeconds) || Number(settings.durationSeconds) < 4 || Number(settings.durationSeconds) > 30 ||
      !RATIOS.includes(settings.aspectRatio as (typeof RATIOS)[number]) ||
      (settings.resolution !== "480p" && settings.resolution !== "720p" && settings.resolution !== "1080p") ||
      typeof settings.audio !== "boolean") return null;
    if (value.filename !== undefined && (typeof value.filename !== "string" || value.filename.length > 180 || /[\\/\0\r\n]/u.test(value.filename))) return null;
    return value as VideoBriefEnvelope;
  } catch {
    return null;
  }
}

function sanitizeFilename(name: string): string {
  const clean = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.slice(0, 120) || "reference-image";
}

function uniqueToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function estimatedEncodedBytes(references: readonly ReferenceImage[], prompt: string): number {
  return references.reduce((sum, image) => sum + Math.ceil(image.size / 3) * 4, 0) +
    new TextEncoder().encode(prompt).byteLength + 4_096;
}

function prettyBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReferencePreview({ image, roomId }: { image: ReferenceImage; roomId: string | undefined }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let objectUrl: string | null = null;
    void apiClient.getWorkspaceArtifactBytes(image.id, roomId ? { roomId } : undefined).then((blob) => {
      if (stopped) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => undefined);
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.id, roomId]);
  return src ? <img src={src} alt="" className="h-16 w-20 rounded object-cover" /> :
    <div className="h-16 w-20 rounded bg-foreground/5" aria-hidden="true" />;
}

function storageKey(toolCallId: string | undefined): string | null {
  return toolCallId ? `nautilo:advanced-video-brief:${toolCallId}` : null;
}

function readStoredDraft(key: string | null, initial: VideoBriefEnvelope): StoredDraft {
  if (!key) return { prompt: initial.prompt, settings: initial.settings, ...(initial.filename ? { filename: initial.filename } : {}), references: [] };
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) throw new Error("missing");
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!Array.isArray(parsed.references) || parsed.references.length > MAX_REFERENCE_IMAGES || typeof parsed.prompt !== "string") throw new Error("invalid");
    return parsed;
  } catch {
    return { prompt: initial.prompt, settings: initial.settings, ...(initial.filename ? { filename: initial.filename } : {}), references: [] };
  }
}

function AdvancedVideoBrief({ envelope, toolCallId }: { envelope: VideoBriefEnvelope; toolCallId?: string }): ReactElement {
  const roomId = useRoomNavigation().activeRoomId ?? undefined;
  const key = storageKey(toolCallId);
  const [draft, setDraft] = useState<StoredDraft>(() => readStoredDraft(key, envelope));
  const [durationInput, setDurationInput] = useState(() => String(draft.settings.durationSeconds));
  const [workspaceImages, setWorkspaceImages] = useState<ReferenceImage[]>([]);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encodedBytes = useMemo(() => estimatedEncodedBytes(draft.references, draft.prompt), [draft.references, draft.prompt]);
  const parsedDuration = Number(durationInput);
  const durationValid = /^\d{1,2}$/u.test(durationInput) && Number.isInteger(parsedDuration) && parsedDuration >= 4 && parsedDuration <= 30;
  const valid = draft.references.length > 0 && draft.prompt.trim().length > 0 && draft.prompt.length <= 15_000 && durationValid &&
    encodedBytes < MAX_QUEUE_JSON_BYTES && hasFocusedTurnDispatcher();

  useLayoutEffect(() => {
    if (!key) return;
    try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* best-effort reload recovery */ }
  }, [draft, key]);

  const updateDuration = (value: string) => {
    setDurationInput(value);
    if (!/^\d{1,2}$/u.test(value)) return;
    const durationSeconds = Number(value);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) return;
    setDraft((current) => ({ ...current, settings: { ...current.settings, durationSeconds } }));
  };

  const normalizeDuration = () => {
    const numeric = Number(durationInput);
    const durationSeconds = durationInput.trim().length === 0 || !Number.isFinite(numeric)
      ? draft.settings.durationSeconds
      : Math.max(4, Math.min(30, Math.round(numeric)));
    setDurationInput(String(durationSeconds));
    setDraft((current) => ({ ...current, settings: { ...current.settings, durationSeconds } }));
  };

  const refreshWorkspace = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.listWorkspaceArtifacts(roomId ? { roomId } : undefined);
      setWorkspaceImages(result.artifacts.filter((artifact) => artifact.mimeType.startsWith("image/") && artifact.size <= MAX_IMAGE_BYTES));
      setShowWorkspace(true);
    } catch {
      setError("Workspace images could not be loaded. Try again.");
    } finally {
      setBusy(false);
    }
  }, [roomId]);

  const addReference = useCallback((image: ReferenceImage) => {
    setDraft((current) => {
      if (current.references.some((item) => item.artifactId === image.artifactId) || current.references.length >= MAX_REFERENCE_IMAGES) return current;
      return { ...current, references: [...current.references, image] };
    });
  }, []);

  const upload = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const selected = Array.from(files);
    if (draft.references.length + selected.length > MAX_REFERENCE_IMAGES) {
      setError(`Seedance accepts at most ${MAX_REFERENCE_IMAGES} image references.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const file of selected) {
        if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 30 MB.`);
        const created = await apiClient.createWorkspaceArtifact(file, {
          path: `video-references/${toolCallId ?? "advanced"}/${uniqueToken()}-${sanitizeFilename(file.name)}`,
          mimeType: file.type,
          ...(roomId ? { roomId } : {}),
        });
        addReference(created);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The images could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }, [addReference, draft.references.length, roomId, toolCallId]);

  const move = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= current.references.length) return current;
      const references = [...current.references];
      const [item] = references.splice(index, 1);
      if (!item) return current;
      references.splice(nextIndex, 0, item);
      return { ...current, references };
    });
  };

  const continueToQuote = () => {
    setError(null);
    const filename = draft.filename?.trim();
    const instruction = [
      "Continue the Advanced Seedance reference-to-video brief from the workcard and request its exact quote now.",
      `Invoke generate_video with model ${JSON.stringify(envelope.model)}.`,
      `Use this exact edited prompt: ${JSON.stringify(draft.prompt.trim())}`,
      `Settings: durationSeconds=${draft.settings.durationSeconds}, aspectRatio=${draft.settings.aspectRatio}, resolution=${draft.settings.resolution}, audio=${String(draft.settings.audio)}.`,
      `There are ${draft.references.length} focused Workspace images in the exact intended order. Set referenceImages to their authoritative Workspace paths in that same order; <Image 1> maps to the first, and so on. Never invent or ask me to type paths.`,
      ...(filename ? [`Use filename ${JSON.stringify(filename)}.`] : []),
      "Do not ask for another conversational confirmation; show the exact Once/Deny spend approval.",
    ].join("\n");
    const sent = requestFocusedTurn(instruction, draft.references.map((image) => ({
      kind: "workspace-artifact" as const,
      artifactId: image.artifactId,
    })), "advanced_video");
    if (!sent) setError("The Room is not ready to continue. Wait a moment and try again.");
  };

  return (
    <section className="border-t border-border p-3 space-y-4" data-testid="advanced-video-workcard">
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Advanced reference video</h3>
          <span className="rounded-full border border-primary/30 px-2 py-0.5 text-[0.65rem] text-primary">No spend yet</span>
        </div>
        <p className="text-xs text-foreground-muted">Build the brief here. Images stay in Workspace; Genie receives ordered references, not their bytes.</p>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-medium text-foreground" htmlFor={`advanced-video-files-${toolCallId ?? "card"}`}>Reference images</label>
          <span className="text-[0.65rem] text-foreground-dim">{draft.references.length}/{MAX_REFERENCE_IMAGES} · est. {prettyBytes(encodedBytes)} / 35 MB request</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="cursor-pointer rounded border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/15">
            Add images
            <input id={`advanced-video-files-${toolCallId ?? "card"}`} className="sr-only" type="file" accept="image/*" multiple disabled={busy} onChange={(event) => { void upload(event.currentTarget.files); event.currentTarget.value = ""; }} />
          </label>
          <button type="button" className="rounded border border-border px-3 py-2 text-xs text-foreground-muted hover:text-foreground" disabled={busy} onClick={() => { void refreshWorkspace(); }}>
            Choose from Workspace
          </button>
        </div>
        {showWorkspace && (
          <div className="max-h-40 overflow-auto rounded border border-border p-2 space-y-1" aria-label="Workspace images">
            {workspaceImages.length === 0 ? <p className="text-xs text-foreground-dim">No eligible Workspace images found.</p> : workspaceImages.map((image) => (
              <button key={image.artifactId} type="button" className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-foreground/5 disabled:opacity-50" disabled={draft.references.some((item) => item.artifactId === image.artifactId)} onClick={() => addReference(image)}>
                <span className="truncate">{image.path}</span><span className="shrink-0 text-foreground-dim">{prettyBytes(image.size)}</span>
              </button>
            ))}
          </div>
        )}
        <ol className="grid gap-2 sm:grid-cols-2" aria-label="Ordered image references">
          {draft.references.map((image, index) => (
            <li key={image.artifactId} className="flex items-center gap-2 rounded border border-border p-2">
              <ReferencePreview image={image} roomId={roomId} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">Image {index + 1}</p>
                <p className="truncate text-[0.65rem] text-foreground-dim">{image.path}</p>
                <div className="mt-1 flex gap-1">
                  <button type="button" aria-label={`Move Image ${index + 1} earlier`} disabled={index === 0} className="rounded border border-border px-1.5 disabled:opacity-30" onClick={() => move(index, -1)}>←</button>
                  <button type="button" aria-label={`Move Image ${index + 1} later`} disabled={index === draft.references.length - 1} className="rounded border border-border px-1.5 disabled:opacity-30" onClick={() => move(index, 1)}>→</button>
                  <button type="button" className="rounded border border-border px-1.5 text-tool-error" onClick={() => setDraft((current) => ({ ...current, references: current.references.filter((item) => item.artifactId !== image.artifactId) }))}>Remove</button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground" htmlFor={`advanced-video-prompt-${toolCallId ?? "card"}`}>Creative brief</label>
        <textarea id={`advanced-video-prompt-${toolCallId ?? "card"}`} value={draft.prompt} rows={10} maxLength={15_000} className="w-full resize-y rounded border border-border bg-background/40 p-3 font-mono text-xs text-foreground outline-none focus:border-primary/50" onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} />
        <p className="text-right text-[0.65rem] text-foreground-dim">{draft.prompt.length.toLocaleString()} / 15,000</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="space-y-1 text-[0.65rem] text-foreground-muted">Duration · 4–30 sec
          <input type="number" min={4} max={30} step={1} inputMode="numeric" value={durationInput} aria-invalid={!durationValid} className="w-full rounded border border-border bg-background/40 px-2 py-1.5 text-xs" onChange={(event) => updateDuration(event.target.value)} onBlur={normalizeDuration} />
        </label>
        <label className="space-y-1 text-[0.65rem] text-foreground-muted">Frame
          <select value={draft.settings.aspectRatio} className="w-full rounded border border-border bg-background/40 px-2 py-1.5 text-xs" onChange={(event) => setDraft((current) => ({ ...current, settings: { ...current.settings, aspectRatio: event.target.value as VideoBriefEnvelope["settings"]["aspectRatio"] } }))}>{RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}</select>
        </label>
        <label className="space-y-1 text-[0.65rem] text-foreground-muted">Resolution
          <select value={draft.settings.resolution} className="w-full rounded border border-border bg-background/40 px-2 py-1.5 text-xs" onChange={(event) => setDraft((current) => ({ ...current, settings: { ...current.settings, resolution: event.target.value as VideoBriefEnvelope["settings"]["resolution"] } }))}><option>480p</option><option>720p</option><option>1080p</option></select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-foreground-muted"><input type="checkbox" checked={draft.settings.audio} onChange={(event) => setDraft((current) => ({ ...current, settings: { ...current.settings, audio: event.target.checked } }))} /> Audio</label>
      </div>

      {encodedBytes >= MAX_QUEUE_JSON_BYTES && <p role="alert" className="text-xs text-tool-error">These references exceed Venice’s 35 MB encoded request limit. Remove or compress images.</p>}
      {error && <p role="alert" className="text-xs text-tool-error">{error}</p>}
      <button type="button" disabled={!valid || busy} className="w-full rounded bg-primary px-4 py-2.5 text-sm font-semibold text-[var(--on-primary)] disabled:cursor-not-allowed disabled:opacity-40" onClick={continueToQuote}>
        {busy ? "Working…" : "Get exact quote"}
      </button>
      <p className="text-center text-[0.65rem] text-foreground-dim">The next screen is the paid Once/Deny approval. Nothing is queued from this card.</p>
    </section>
  );
}

function VideoGenerationExpanded(props: ToolRendererProps): ReactElement {
  const { resultText, event } = props;
  const envelope = useMemo(() => parseVideoBriefEnvelope(resultText), [resultText]);
  if (!envelope) return <GeneratedMediaExpandedBody {...props} />;
  return <AdvancedVideoBrief envelope={envelope} toolCallId={event?.toolCallId} />;
}

export const videoGenerationRenderer: ToolRenderer = {
  displayName: "Generate video",
  autoExpandOnResult: true,
  collapsedSummary: (input) => parseVideoBriefEnvelope(
    typeof input.result === "string" ? input.result : undefined,
  ) ? "Reference-to-video workshop" : generatedMediaRenderer.collapsedSummary?.(input) ?? "Generate video",
  ExpandedBody: VideoGenerationExpanded,
};
