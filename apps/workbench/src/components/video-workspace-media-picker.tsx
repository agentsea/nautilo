import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceMediaArtifact } from "@nautilo/types";

export type WorkspaceMediaPickerArtifact = WorkspaceMediaArtifact & { updatedAt?: string };
export type WorkspaceMediaPreview = Readonly<{ url: string; mediaKind: "image" | "video"; sha256?: string; release: () => void }>;

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

function friendlyType(artifact: WorkspaceMediaPickerArtifact): string {
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

function hasProjectLabel(artifact: WorkspaceMediaPickerArtifact, labels: Readonly<Record<string, string>>): boolean {
  return Boolean(labels[`${artifact.artifactId}\0${artifact.path}`]?.trim());
}

function hasMeaningfulFilename(artifact: WorkspaceMediaPickerArtifact, labels: Readonly<Record<string, string>>): boolean {
  return !hasProjectLabel(artifact, labels) && workspaceMediaPickerName(artifact, labels) !== friendlyType(artifact);
}

export type WorkspaceMediaPickerGroup = Readonly<{ representative: WorkspaceMediaPickerArtifact; artifacts: readonly WorkspaceMediaPickerArtifact[] }>;

export function groupWorkspaceMediaPickerArtifacts(artifacts: readonly WorkspaceMediaPickerArtifact[], labels: Readonly<Record<string, string>>, digests: ReadonlyMap<string, string>): readonly WorkspaceMediaPickerGroup[] {
  const groups = new Map<string, Array<{ artifact: WorkspaceMediaPickerArtifact; index: number }>>();
  for (const [index, artifact] of artifacts.entries()) {
    const digest = digests.get(workspaceMediaPickerRowKey(artifact));
    const key = digest && /^[0-9a-f]{64}$/u.test(digest) ? `${digest}\0${artifact.size}\0${mediaKind(artifact)}` : `row\0${workspaceMediaPickerRowKey(artifact)}`;
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

function ArtifactPreview({ artifact, loadPreview, onDigest }: { artifact: WorkspaceMediaPickerArtifact; loadPreview?: ((artifact: WorkspaceMediaArtifact, signal: AbortSignal) => Promise<WorkspaceMediaPreview | null>) | undefined; onDigest: (artifact: WorkspaceMediaPickerArtifact, digest: string) => void }) {
  const row = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<WorkspaceMediaPreview | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "unavailable">("idle");
  const releasePreview = useRef<(() => void) | null>(null);
  const mediaKind = artifact.mimeType.startsWith("video/") ? "video" : "image";

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
      if (!active || controller.signal.aborted || !next || next.mediaKind !== mediaKind) {
        release();
        if (active && !controller.signal.aborted) setState("unavailable");
        return;
      }
      releasePreview.current = release;
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
  }, [artifact, loadPreview, mediaKind, onDigest, visible]);

  const previewFailed = () => {
    releasePreview.current?.();
    releasePreview.current = null;
    setPreview(null);
    setState("unavailable");
  };

  return <span ref={row} className="relative grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded border border-border bg-background-element text-center text-[10px] text-foreground-muted">
    {preview ? mediaKind === "image"
      ? <img src={preview.url} alt="" onError={previewFailed} className="absolute inset-0 h-full w-full object-contain" />
      : <video src={preview.url} muted playsInline preload="metadata" aria-hidden="true" onError={previewFailed} className="absolute inset-0 h-full w-full object-contain" />
      : state === "loading" ? <span role="status">Loading</span>
        : state === "unavailable" ? <span>Preview unavailable</span>
          : <span aria-hidden="true">▧</span>}
  </span>;
}

export function VideoWorkspaceMediaPicker({ artifacts, labels, loading, error, onSelect, onUpload, onCancel, loadPreview }: {
  artifacts: readonly WorkspaceMediaPickerArtifact[]; labels: Readonly<Record<string, string>>; loading: boolean; error: string | null;
  onSelect: (artifact: WorkspaceMediaArtifact) => void; onUpload: () => void; onCancel: () => void;
  loadPreview?: (artifact: WorkspaceMediaArtifact, signal: AbortSignal) => Promise<WorkspaceMediaPreview | null>;
}) {
  const [query, setQuery] = useState("");
  const [digests, setDigests] = useState<ReadonlyMap<string, string>>(() => new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const current = new Set(artifacts.map(workspaceMediaPickerRowKey));
    setDigests((previous) => {
      const next = new Map([...previous].filter(([key]) => current.has(key)));
      return next.size === previous.size && [...next.keys()].every((key) => previous.has(key)) ? previous : next;
    });
  }, [artifacts]);
  const recordDigest = useCallback((artifact: WorkspaceMediaPickerArtifact, digest: string) => {
    const key = workspaceMediaPickerRowKey(artifact);
    setDigests((previous) => previous.get(key) === digest ? previous : new Map(previous).set(key, digest));
  }, []);
  const groups = useMemo(() => groupWorkspaceMediaPickerArtifacts(artifacts, labels, digests), [artifacts, digests, labels]);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return groups;
    return groups.filter((group) => group.artifacts.some((artifact) => `${workspaceMediaPickerName(artifact, labels)} ${artifact.path}`.toLocaleLowerCase().includes(needle)));
  }, [groups, labels, query]);
  return <div className="absolute inset-0 z-40 flex min-h-0 items-center justify-center overflow-hidden bg-black/55 p-2 sm:p-4" role="presentation">
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="workspace-media-picker-title" className="flex h-[min(40rem,calc(100%_-_1rem))] max-h-[calc(100%_-_1rem)] min-h-0 min-w-0 w-[calc(100%_-_1rem)] max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl sm:h-[min(40rem,calc(100%_-_2rem))] sm:max-h-[calc(100%_-_2rem)]" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary') ?? []).filter((element) => element.tagName === "SUMMARY" || !element.closest("details:not([open])"));
      const [first] = focusable;
      if (!first) return;
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <header className="relative shrink-0 border-b border-border px-4 py-3 pr-12"><h2 id="workspace-media-picker-title" className="text-base font-semibold text-foreground">Import media</h2><p className="mt-0.5 text-sm text-foreground-muted">Choose media already in this Workspace, or upload from your computer.</p><button type="button" aria-label="Close media picker" onClick={onCancel} className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md border border-border text-xl leading-none text-foreground hover:bg-background-element">×</button></header>
      <div className="shrink-0 px-4 pt-3"><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Workspace media" aria-label="Search Workspace media" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading ? <p role="status" className="p-3 text-sm text-foreground-muted">Loading Workspace media…</p> : null}
        {error ? <p role="alert" className="p-3 text-sm text-[var(--error)]">{error}</p> : null}
        {!loading && !error && shown.length === 0 ? <p className="p-3 text-sm text-foreground-muted">No matching media.</p> : null}
        <ul aria-label="Workspace media">{shown.map((group) => {
          const artifact = group.representative;
          const kind = friendlyType(artifact);
          const primary = workspaceMediaPickerName(artifact, labels);
          const parsedDate = artifact.updatedAt ? new Date(artifact.updatedAt) : null;
          const date = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toLocaleDateString() : null;
          const previewable = mediaKind(artifact) !== "audio";
          const aliases = group.artifacts.filter((candidate) => candidate !== artifact);
          return <li key={workspaceMediaPickerRowKey(artifact)} className="rounded-md hover:bg-background-element"><button type="button" title={artifact.path} onClick={() => onSelect(artifact)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
            {previewable ? <ArtifactPreview artifact={artifact} loadPreview={loadPreview} onDigest={recordDigest} /> : <span aria-hidden="true" className="grid h-16 w-24 shrink-0 place-items-center rounded border border-border bg-background-element text-lg text-foreground-muted">♪</span>}
            <span className="min-w-0"><span className="block truncate text-sm font-medium text-foreground">{primary}</span><span className="block truncate text-xs text-foreground-muted">{kind}{date ? ` · ${date}` : ""}</span></span>
          </button>{aliases.length ? <details className="px-3 pb-2 text-xs text-foreground-muted"><summary className="cursor-pointer">{group.artifacts.length} copies</summary><ul className="mt-1 space-y-1">{aliases.map((alias) => <li key={workspaceMediaPickerRowKey(alias)}><button type="button" title={alias.path} onClick={() => onSelect(alias)} className="block max-w-full truncate text-left underline-offset-2 hover:underline"><span>{workspaceMediaPickerName(alias, labels)}</span><span className="block text-[10px]">{alias.path}</span></button></li>)}</ul></details> : null}</li>;
        })}</ul>
      </div>
      <footer className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2 border-t border-border px-3 py-3 sm:px-4"><button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-sm">Cancel</button><button type="button" onClick={onUpload} className="max-w-full whitespace-normal rounded-md border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)]">Upload from computer</button></footer>
    </section>
  </div>;
}
