import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaPickerWaveform } from "./media-picker-waveform";
import { workspaceMediaMimeMatchesKind, type WorkspaceMediaArtifact } from "@nautilo/types";

export type WorkspaceMediaPickerArtifact = WorkspaceMediaArtifact & { updatedAt?: string };
export type WorkspaceMediaPreview = Readonly<{ url: string; mediaKind: "image" | "video" | "audio"; waveform?: { peaks: number[]; samplesPerSecond: number }; sha256?: string; release: () => void }>;

function storageLikeName(path: string): boolean {
  const stem = (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/u, "");
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(stem) || /^(?:mg_|take_)?[0-9a-f]{24,}$/iu.test(stem);
}

function withoutUuidPrefix(filename: string): string {
  const extension = filename.match(/(\.[^.]+)$/u)?.[1] ?? "";
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const prefix = /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{32}|(?:mg_|take_)?[0-9a-f]{24})[-_ ]+(.+)$/iu.exec(stem)?.[1]?.trim();
  return prefix && /[a-z]/iu.test(prefix) && !/^[0-9a-f-]+$/iu.test(prefix) ? `${prefix}${extension}` : filename;
}

function friendlyType(artifact: WorkspaceMediaPickerArtifact, inspected?: WorkspaceMediaPreview["mediaKind"]): string {
  if (inspected === "audio") return "Audio";
  if (inspected === "video") return artifact.path.startsWith("generated-media/") ? "Generated video" : "Video";
  if (!inspected && ["video/mp4", "audio/mp4"].includes(artifact.mimeType)) return "MP4 media";
  if (artifact.mimeType.startsWith("video/")) return artifact.path.startsWith("generated-media/") ? "Generated video" : "Video";
  if (artifact.mimeType.startsWith("image/")) return artifact.path.startsWith("video-references/") ? "Reference image" : "Image";
  return "Audio";
}

export function workspaceMediaPickerName(artifact: WorkspaceMediaPickerArtifact, labels: Readonly<Record<string, string>>): string {
  const label = labels[`${artifact.artifactId}\0${artifact.path}`]?.trim();
  if (label) return label;
  const filename = artifact.path.split("/").at(-1) ?? artifact.path;
  if (storageLikeName(artifact.path)) return friendlyType(artifact);
  return withoutUuidPrefix(filename);
}

export function workspaceMediaPickerRowKey(artifact: WorkspaceMediaPickerArtifact): string {
  return [artifact.id, artifact.artifactId, artifact.path, artifact.revision, artifact.mimeType, artifact.size].join("\0");
}

function mediaKind(artifact: WorkspaceMediaPickerArtifact): "image" | "video" | "audio" {
  return artifact.mimeType.startsWith("video/") ? "video" : artifact.mimeType.startsWith("image/") ? "image" : "audio";
}

function previewMatchesArtifact(kind: WorkspaceMediaPreview["mediaKind"], mimeType: string): boolean {
  // The picker may preview library audio that Seedance cannot transport. Keep
  // it visible and playable while the reference admission path remains strict.
  const transportCompatible: boolean = workspaceMediaMimeMatchesKind(kind, mimeType);
  return transportCompatible || (kind === "audio" && mimeType.startsWith("audio/"));
}

function isSeedanceAudioReferenceMimeType(mimeType: string): boolean {
  return mimeType === "audio/mpeg" || mimeType === "audio/wav" || mimeType === "audio/x-wav";
}

function hasProjectLabel(artifact: WorkspaceMediaPickerArtifact, labels: Readonly<Record<string, string>>): boolean {
  return Boolean(labels[`${artifact.artifactId}\0${artifact.path}`]?.trim());
}

function hasMeaningfulFilename(artifact: WorkspaceMediaPickerArtifact, labels: Readonly<Record<string, string>>): boolean {
  return !hasProjectLabel(artifact, labels) && workspaceMediaPickerName(artifact, labels) !== friendlyType(artifact);
}

export type WorkspaceMediaPickerGroup = Readonly<{ representative: WorkspaceMediaPickerArtifact; artifacts: readonly WorkspaceMediaPickerArtifact[] }>;

export function groupWorkspaceMediaPickerArtifacts(artifacts: readonly WorkspaceMediaPickerArtifact[], labels: Readonly<Record<string, string>>, digests: ReadonlyMap<string, string>, kinds: ReadonlyMap<string, WorkspaceMediaPreview["mediaKind"]> = new Map()): readonly WorkspaceMediaPickerGroup[] {
  const groups = new Map<string, Array<{ artifact: WorkspaceMediaPickerArtifact; index: number }>>();
  for (const [index, artifact] of artifacts.entries()) {
    const digest = digests.get(workspaceMediaPickerRowKey(artifact));
    const key = digest && /^[0-9a-f]{64}$/u.test(digest) ? `${digest}\0${artifact.size}\0${kinds.get(workspaceMediaPickerRowKey(artifact)) ?? mediaKind(artifact)}` : `row\0${workspaceMediaPickerRowKey(artifact)}`;
    const group = groups.get(key) ?? [];
    group.push({ artifact, index });
    groups.set(key, group);
  }
  return [...groups.values()].map((members) => {
    const representative = [...members].sort((left, right) => {
      const label = Number(hasProjectLabel(right.artifact, labels)) - Number(hasProjectLabel(left.artifact, labels));
      if (label) return label;
      const name = Number(hasMeaningfulFilename(right.artifact, labels)) - Number(hasMeaningfulFilename(left.artifact, labels));
      return name || left.index - right.index;
    })[0];
    return { representative: representative.artifact, artifacts: members.map(({ artifact }) => artifact) };
  });
}

function ArtifactPreview({ artifact, loadPreview, onDigest, onKind, large = false, playback = false }: { artifact: WorkspaceMediaPickerArtifact; loadPreview?: ((artifact: WorkspaceMediaArtifact, signal: AbortSignal) => Promise<WorkspaceMediaPreview | null>) | undefined; onDigest: (artifact: WorkspaceMediaPickerArtifact, digest: string) => void; onKind: (artifact: WorkspaceMediaPickerArtifact, kind: WorkspaceMediaPreview["mediaKind"]) => void; large?: boolean; playback?: boolean }) {
  const row = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<WorkspaceMediaPreview | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "unavailable">("idle");
  const releasePreview = useRef<(() => void) | null>(null);
  const kind = preview?.mediaKind ?? mediaKind(artifact);

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.target === element && entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !loadPreview) return;
    const controller = new AbortController();
    let active = true;
    let lease: WorkspaceMediaPreview | null = null;
    let released = false;
    const release = () => {
      if (!released && lease) { released = true; lease.release(); }
    };
    setState("loading");
    setPreview(null);
    void loadPreview(artifact, controller.signal).then((next) => {
      lease = next;
      if (!active || controller.signal.aborted || !next || !previewMatchesArtifact(next.mediaKind, artifact.mimeType)) {
        release();
        if (active && !controller.signal.aborted) setState("unavailable");
        return;
      }
      releasePreview.current = release;
      onKind(artifact, next.mediaKind);
      if (next.sha256 && /^[0-9a-f]{64}$/u.test(next.sha256)) onDigest(artifact, next.sha256);
      setPreview(next);
      setState("idle");
    }).catch(() => {
      if (active && !controller.signal.aborted) setState("unavailable");
    });
    return () => {
      if (active) { setPreview(null); setState("idle"); }
      active = false;
      controller.abort();
      release();
      if (releasePreview.current === release) releasePreview.current = null;
    };
  }, [artifact, loadPreview, onKind, onDigest, visible]);

  const previewFailed = () => {
    releasePreview.current?.();
    releasePreview.current = null;
    setPreview(null);
    setState("unavailable");
  };

  return <span ref={row} className={`relative grid ${large ? "h-32 w-full" : "h-16 w-24 shrink-0"} place-items-center overflow-hidden rounded border border-border bg-background-element text-center text-xs text-foreground-muted`}>
    {preview ? kind === "audio"
      ? <span className="flex w-full min-w-0 flex-col items-center gap-2 px-2">{preview.waveform?.peaks.length ? <MediaPickerWaveform peaks={preview.waveform.peaks} /> : <span>Waveform unavailable</span>}{playback ? <audio src={preview.url} controls preload="metadata" aria-label="Audio preview" onError={previewFailed} className="h-10 w-full" /> : null}</span>
      : kind === "image"
      ? <img src={preview.url} alt="" onError={previewFailed} className="absolute inset-0 h-full w-full object-contain" />
      : <video src={preview.url} muted={!playback} controls={playback} playsInline preload="metadata" aria-label={playback ? "Media preview" : undefined} aria-hidden={!playback} onError={previewFailed} className="absolute inset-0 h-full w-full object-contain" />
      : state === "loading" ? <span role="status">Loading</span>
        : state === "unavailable" ? <span>Preview unavailable</span>
          : <span aria-hidden="true">▧</span>}
  </span>;
}

export type VideoPickerProjectMedia = { id: string; label: string; kind: "image" | "video" | "audio"; artifactId?: string; path: string };
export type VideoPickerSelection = { artifacts: WorkspaceMediaArtifact[]; mediaIds: string[]; fromComputer?: true };
export type VideoWorkspaceMediaPickerProps = {
  artifacts: readonly WorkspaceMediaPickerArtifact[]; labels: Readonly<Record<string, string>>; loading: boolean; error: string | null;
  onSelect: (artifact: WorkspaceMediaArtifact) => void; onUpload: (selection?: VideoPickerSelection) => void; onCancel: () => void;
  loadPreview?: (artifact: WorkspaceMediaArtifact, signal: AbortSignal) => Promise<WorkspaceMediaPreview | null>;
  purpose?: "media" | "references";
  multiple?: boolean;
  projectMedia?: readonly VideoPickerProjectMedia[];
  onConfirm?: (selection: VideoPickerSelection) => void;
};

export function VideoWorkspaceMediaPicker({ artifacts, labels, loading, error, onSelect, onUpload, onCancel, loadPreview, purpose = "media", multiple = false, projectMedia = [], onConfirm }: VideoWorkspaceMediaPickerProps) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"artifacts" | "bin" | "computer">("artifacts");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [previewing, setPreviewing] = useState<WorkspaceMediaPickerArtifact | null>(null);
  const [kinds, setKinds] = useState<ReadonlyMap<string, WorkspaceMediaPreview["mediaKind"]>>(() => new Map());
  const [digests, setDigests] = useState<ReadonlyMap<string, string>>(() => new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const current = new Set(artifacts.map(workspaceMediaPickerRowKey));
    setDigests(previous => new Map([...previous].filter(([key]) => current.has(key))));
    setKinds(previous => new Map([...previous].filter(([key]) => current.has(key))));
    setSelected(previous => new Set([...previous].filter(key => current.has(key))));
  }, [artifacts]);
  const recordDigest = useCallback((artifact: WorkspaceMediaPickerArtifact, digest: string) => {
    const key = workspaceMediaPickerRowKey(artifact);
    setDigests(previous => previous.get(key) === digest ? previous : new Map(previous).set(key, digest));
  }, []);
  const recordKind = useCallback((artifact: WorkspaceMediaPickerArtifact, kind: WorkspaceMediaPreview["mediaKind"]) => {
    const key = workspaceMediaPickerRowKey(artifact);
    setKinds(previous => previous.get(key) === kind ? previous : new Map(previous).set(key, kind));
  }, []);
  const resolvedKind = (artifact: WorkspaceMediaPickerArtifact) => kinds.get(workspaceMediaPickerRowKey(artifact)) ?? mediaKind(artifact);
  const matchesFilter = (artifact: WorkspaceMediaPickerArtifact) => filter === "all" || resolvedKind(artifact) === filter ||
    // Uninspected MP4s remain discoverable in either stream filter until Desktop resolves them.
    (!kinds.has(workspaceMediaPickerRowKey(artifact)) && ["audio", "video"].includes(filter) && ["video/mp4", "audio/mp4"].includes(artifact.mimeType));
  const groups = useMemo(() => groupWorkspaceMediaPickerArtifacts(artifacts, labels, digests, kinds), [artifacts, digests, kinds, labels]);
  const inBin = (artifact: WorkspaceMediaArtifact) => projectMedia.find(media => media.artifactId === artifact.artifactId && media.path === artifact.path);
  // Selection is keyed to the exact row revision; late preview grouping cannot
  // silently replace a selected original with a different artifact.
  const chosen = artifacts.filter(artifact => selected.has(workspaceMediaPickerRowKey(artifact)));
  const shown = groups.filter(group => group.artifacts.some(artifact => (source !== "bin" || inBin(artifact)) && matchesFilter(artifact) && `${workspaceMediaPickerName(artifact, labels)} ${artifact.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const select = (artifact: WorkspaceMediaPickerArtifact) => {
    if (!onConfirm) { onSelect(artifact); return; }
    const key = workspaceMediaPickerRowKey(artifact);
    setSelected(previous => {
      const next = new Set(multiple ? previous : []);
      if (previous.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const button = "rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-background-element";
  const confirmLabel = purpose === "references" ? multiple ? `Add ${chosen.length || ""} references`.replace("  ", " ") : "Use reference" : `Add ${chosen.length || ""} to Media Bin`.replace("  ", " ");
  return <div className="absolute inset-0 z-40 flex min-h-0 items-center justify-center overflow-hidden bg-black/55 p-2 sm:p-4" role="presentation">
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="workspace-media-picker-title" className="flex h-[min(44rem,calc(100%_-_1rem))] max-h-[calc(100%_-_1rem)] min-h-0 min-w-0 w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); if (previewing) setPreviewing(null); else onCancel(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, video[controls], audio[controls]') ?? []).filter(element => !element.closest('[hidden]') && (element.tagName === "SUMMARY" || !element.closest('details:not([open])')));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="relative shrink-0 border-b border-border px-5 py-4 pr-14"><h2 id="workspace-media-picker-title" className="text-lg font-semibold text-foreground">{purpose === "references" ? multiple ? "Add references" : "Replace reference" : "Add media"}</h2><p className="mt-1 text-sm text-foreground-muted">{purpose === "references" ? "Choose images, videos, and audio to guide this scene." : "Choose files to add to this project’s Media Bin."}</p>{purpose === "references" ? <p className="mt-1 text-xs text-foreground-muted">Seedance audio references use MP3 or WAV, 2–30 sec and up to 15 MB each, with at most 10 files and 30 sec combined. You can attach audio now; generation also needs an image or video.</p> : null}<button type="button" aria-label="Close media picker" onClick={onCancel} className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-md border border-border text-xl text-foreground hover:bg-background-element">×</button></header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Media source" className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2 sm:w-40 sm:flex-col sm:justify-start sm:border-b-0 sm:border-r sm:p-3">{([["artifacts", "Artifacts"], ["bin", "Media Bin"], ["computer", "Computer"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={source === value} onClick={() => { setSource(value); setPreviewing(null); }} className={`${button} ${source === value ? "bg-background-element font-semibold" : "border-transparent"}`}>{label}</button>)}</nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {source === "computer" ? <div className="min-h-0 flex-1 overflow-y-auto p-6"><h3 className="font-semibold">Choose files from your computer</h3><p className="my-3 text-sm text-foreground-muted">{multiple ? "Select multiple files in the file chooser." : "Select one file."} Files are saved in Workspace and added here.{purpose === "references" ? " Audio references must be MP3 or WAV for Seedance." : ""}</p><button type="button" onClick={() => onUpload(onConfirm ? { artifacts: multiple ? chosen.filter(a => purpose !== "references" || !inBin(a)) : [], mediaIds: multiple && purpose === "references" ? chosen.flatMap(a => inBin(a)?.id ? [inBin(a)!.id] : []) : [], fromComputer: true } : undefined)} className={button}>Choose files…</button>{multiple && chosen.length ? <p className="mt-3 text-sm">{chosen.length} selected from your library. These will be kept when you choose files.</p> : null}</div> : previewing ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><button type="button" className={button} onClick={() => setPreviewing(null)}>Back to media</button><h3 className="my-3 font-semibold">{workspaceMediaPickerName(previewing, labels)}</h3><ArtifactPreview key={`detail-${workspaceMediaPickerRowKey(previewing)}`} artifact={previewing} loadPreview={loadPreview} onDigest={recordDigest} onKind={recordKind} large playback /><p className="mt-3 break-all text-sm text-foreground-muted">{previewing.path}</p>{purpose === "references" && resolvedKind(previewing) === "audio" ? <p className="mt-2 text-xs text-foreground-muted">{isSeedanceAudioReferenceMimeType(previewing.mimeType) ? "Seedance audio reference · 2–30 sec · max 15 MB" : "This audio stays visible in your library, but Seedance accepts only MP3 or WAV references."}</p> : null}</div> : <>
            <div className="shrink-0 space-y-3 p-4"><div className="flex gap-2"><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search names or folders" aria-label="Search media" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" /><button type="button" aria-label="Thumbnail view" aria-pressed={view === "grid"} onClick={() => setView("grid")} className={button}>▦</button><button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")} className={button}>☰</button></div><div className="flex flex-wrap gap-1" role="group" aria-label="Media type">{["all", "image", "video", "audio"].map(kind => <button key={kind} type="button" aria-pressed={filter === kind} className={`${button} ${filter === kind ? "bg-background-element" : "border-transparent"}`} onClick={() => setFilter(kind)}>{kind === "all" ? "All media" : kind === "image" ? "Images" : kind === "video" ? "Videos" : "Audio"}</button>)}</div><p className="text-xs text-foreground-muted">{source === "bin" ? "This project’s Media Bin" : "Workspace artifacts"}{!loading && !error ? ` · ${shown.length} items` : ""}</p></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {loading ? <p role="status">Loading media…</p> : null}{error ? <p role="alert">{error}</p> : null}
              {!loading && !error && shown.length === 0 ? <p className="p-3 text-sm text-foreground-muted">No matching media.</p> : null}
              <ul aria-label="Workspace media" className={view === "grid" ? "grid grid-cols-2 gap-3 lg:grid-cols-3" : "space-y-2"}>{shown.map(group => {
                const artifact = (source === "bin" ? group.artifacts.find(a => inBin(a)) : undefined) ?? group.representative;
                const key = workspaceMediaPickerRowKey(artifact), already = !!onConfirm && purpose === "media" && !!inBin(artifact);
                const primary = workspaceMediaPickerName(artifact, labels);
                const aliases = group.artifacts.filter(a => a !== artifact);
                return <li key={key} className={`min-w-0 overflow-hidden rounded-lg border ${selected.has(key) ? "border-primary bg-background-element" : "border-border"}`}>
                  <button type="button" title={artifact.path} disabled={already} aria-pressed={selected.has(key)} onClick={() => select(artifact)} className={`w-full text-left ${view === "grid" ? "block" : "flex items-center gap-3 p-2"}`}>
                    <ArtifactPreview artifact={artifact} loadPreview={loadPreview} onDigest={recordDigest} onKind={recordKind} large={view === "grid"} />
                    <span className="block min-w-0 p-3"><span className="block break-words text-sm font-medium text-foreground">{selected.has(key) ? "✓ " : ""}{primary}</span><span className="mt-1 block text-xs text-foreground-muted">{friendlyType(artifact, kinds.get(key))}</span>{purpose === "references" && resolvedKind(artifact) === "audio" ? <span className="block text-xs text-foreground-muted">{isSeedanceAudioReferenceMimeType(artifact.mimeType) ? "MP3/WAV · 2–30 sec · max 15 MB" : "Seedance needs MP3 or WAV"}</span> : null}{already ? <span className="block text-xs text-foreground-muted">In Media Bin</span> : null}</span>
                  </button><button type="button" aria-label={`Preview ${primary}`} className="mx-3 mb-2 text-xs underline" onClick={() => setPreviewing(artifact)}>Preview</button>
                  {aliases.length ? <details className="px-3 pb-2 text-xs text-foreground-muted"><summary className="cursor-pointer">{group.artifacts.length} copies</summary>{aliases.map(alias => <button key={workspaceMediaPickerRowKey(alias)} type="button" title={alias.path} disabled={!!onConfirm && purpose === "media" && !!inBin(alias)} aria-pressed={selected.has(workspaceMediaPickerRowKey(alias))} onClick={() => select(alias)} className="mt-2 block max-w-full break-all text-left">{selected.has(workspaceMediaPickerRowKey(alias)) ? "✓ " : ""}{workspaceMediaPickerName(alias, labels)}<span className="block">{alias.path}</span></button>)}</details> : null}
                </li>;
              })}</ul>
            </div>
          </>}
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3"><span role="status" className="mr-auto text-sm">{chosen.length ? `${chosen.length} selected` : "Select media to add"}</span><button type="button" onClick={onCancel} className={button}>Cancel</button>{onConfirm ? <button type="button" disabled={!chosen.length} onClick={() => onConfirm({ artifacts: chosen.filter(a => purpose !== "references" || !inBin(a)), mediaIds: purpose === "references" ? chosen.flatMap(a => inBin(a)?.id ? [inBin(a)!.id] : []) : [] })} className="rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-[var(--on-primary)] disabled:opacity-50">{confirmLabel}</button> : <button type="button" onClick={() => onUpload(onConfirm ? { artifacts: multiple ? chosen.filter(a => purpose !== "references" || !inBin(a)) : [], mediaIds: multiple && purpose === "references" ? chosen.flatMap(a => inBin(a)?.id ? [inBin(a)!.id] : []) : [], fromComputer: true } : undefined)} className={button}>Choose files…</button>}</footer>
    </section>
  </div>;
}
