import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { getNautiloApp } from "./bridge";
import { compileSequence, evaluateSequence, type ActiveSequenceEntry, type SequenceEntry } from "./sequence-evaluation";
import type { VideoProject } from "./edl";
import { renderTextCompositionMarkup, type TextCompositionKind } from "./text-composition";

type LoadState = { key: string; status: "loading" | "ready" | "failed"; message?: string };
type Props = {
  project: VideoProject;
  timeSec: number;
  playing: boolean;
  onReadyChange: (ready: boolean) => void;
  clockRef?: { current: (() => number | null) | null };
};

function sameEdge(a: number, b: number): boolean {
  // Only arithmetic roundoff is equal. A real one-frame gap is never bridged.
  return Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(1, Math.abs(a), Math.abs(b));
}

function resourceKey(entry: SequenceEntry, anchor = entry.clip.id): string {
  return JSON.stringify([entry.track.id, anchor, entry.media?.id, entry.media?.ref, entry.media?.lifecycle, entry.media?.source]);
}

function isMediaEntry(entry: SequenceEntry): boolean {
  return entry.clip.kind === "video" || entry.clip.kind === "audio" || entry.clip.kind === "image";
}

/** Adjacent splits with continuous source time share one native decoder. */
function continuityKeys(entries: readonly SequenceEntry[]): Map<string, string> {
  const keys = new Map<string, string>();
  const previous = new Map<string, SequenceEntry>();
  for (const entry of [...entries].sort((a, b) => a.clip.timelineStartSec - b.clip.timelineStartSec)) {
    const prior = previous.get(entry.track.id);
    const continuous = prior && isMediaEntry(entry) && entry.clip.kind === prior.clip.kind
      && entry.media?.id === prior.media?.id
      && sameEdge(prior.clip.timelineStartSec + prior.clip.durationSec, entry.clip.timelineStartSec)
      && sameEdge((prior.clip.sourceInSec ?? 0) + prior.clip.durationSec, entry.clip.sourceInSec ?? 0);
    keys.set(entry.clip.id, continuous ? keys.get(prior.clip.id)! : resourceKey(entry));
    previous.set(entry.track.id, entry);
  }
  return keys;
}

function MediaLayer({ entry, attemptKey, playing, frameDurationSec, report, register }: {
  entry: ActiveSequenceEntry; attemptKey: string; playing: boolean; frameDurationSec: number; report: (key: string, state: LoadState) => void;
  register: (key: string, element: HTMLVideoElement | null) => void;
}): ReactElement {
  const { clip, media, sourceTimeSec, visual, gain } = entry;
  const key = attemptKey;
  const retired = useRef(false);
  const mediaElement = useRef<HTMLVideoElement | null>(null);
  const currentTime = useRef(sourceTimeSec);
  currentTime.current = sourceTimeSec;
  const sourceOffset = (clip.sourceInSec ?? 0) - clip.timelineStartSec;
  const lastSourceOffset = useRef(sourceOffset);
  const [url, setUrl] = useState<string | null>(null);
  const image = clip.kind === "image";
  const mediaId = media?.id;
  const mediaRef = media?.ref;
  const durableWorkspace = media?.lifecycle === "durable" && media.source?.kind === "workspace-artifact";
  useLayoutEffect(() => {
    register(key, mediaElement.current);
    return () => register(key, null);
  }, [key, register]);
  useEffect(() => {
    retired.current = false;
    const controller = new AbortController();
    const bridge = getNautiloApp();
    let cleanup: (() => void) | undefined;
    setUrl(null);
    report(key, { key, status: "loading" });
    const fail = (message: string) => { if (!controller.signal.aborted) report(key, { key, status: "failed", message }); };
    const resolve = async () => {
      if (!mediaId || !mediaRef) { fail("Source media is missing. Restore or replace it in the Media Bin."); return; }
      if (image && !durableWorkspace) {
        if (!bridge?.asset) { fail("Image preview is unavailable in this host."); return; }
        const result = await bridge.asset.read({ ref: mediaRef }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.kind !== "ready") { fail(`Cannot open this image (${result.code}).`); return; }
        const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }));
        cleanup = () => URL.revokeObjectURL(objectUrl);
        setUrl(objectUrl);
      } else {
        if (!bridge?.media) { fail("Media preview requires a supported Desktop host."); return; }
        const request = durableWorkspace ? { mediaId } : { ref: mediaRef };
        const result = await bridge.media.openPreview(request, { signal: controller.signal });
        if (result.kind !== "ready") { fail(`Cannot open this media (${result.code}).`); return; }
        cleanup = () => { void Promise.resolve(bridge.media!.closePreview(result.revokeToken)).catch(() => undefined); };
        if (controller.signal.aborted) { cleanup(); cleanup = undefined; return; }
        setUrl(result.url);
      }
    };
    void resolve().catch(() => fail("Media could not be opened. Your edit is preserved."));
    return () => { retired.current = true; controller.abort(); cleanup?.(); };
  }, [durableWorkspace, image, key, mediaId, mediaRef, report]);

  const wasPlaying = useRef(false);
  useLayoutEffect(() => {
    const element = mediaElement.current;
    if (!element || !url) return;
    const startingPlayback = playing && !wasPlaying.current;
    wasPlaying.current = playing;
    const mappingChanged = lastSourceOffset.current !== sourceOffset;
    lastSourceOffset.current = sourceOffset;
    element.volume = gain;
    element.muted = gain === 0;
    // Native media drives the playback clock. Seeking on each clock render
    // creates a seek -> loading -> pause -> restart feedback loop. Align only
    // while paused/buffering; explicit scrub actions pause before changing time.
    if ((!playing || startingPlayback || mappingChanged) && element.readyState >= 1 && Math.abs(element.currentTime - sourceTimeSec) > frameDurationSec) {
      // Stop the shared clock before assigning currentTime. The asynchronous
      // DOM seeking event is too late to guard a same-resource user seek.
      report(key, { key, status: "loading" });
      element.currentTime = sourceTimeSec;
    }
  }, [sourceTimeSec, sourceOffset, gain, url, frameDurationSec, key, report, playing]);
  useEffect(() => {
    const element = mediaElement.current;
    if (!element || !url) return;
    if (!playing) { element.pause(); return; }
    let disposed = false;
    void element.play().catch(() => { if (!disposed) report(key, { key, status: "failed", message: "Playback was blocked or the media cannot be decoded." }); });
    return () => { disposed = true; element.pause(); };
  }, [playing, url, key, report]);
  const style: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: entry.opacity ?? 1, clipPath: entry.clipPath, background: entry.track.kind === "overlay" ? "transparent" : "black", visibility: visual ? "visible" : "hidden" };
  const reportReady = (element: HTMLVideoElement) => {
    if (!retired.current && !element.seeking && (playing || Math.abs(element.currentTime - currentTime.current) <= frameDurationSec)) report(key, { key, status: "ready" });
  };
  if (image) return url ? <img style={style} src={url} alt={media?.label ?? "Timeline image"} onLoad={() => { if (!retired.current) report(key, { key, status: "ready" }); }} onError={() => { if (!retired.current) report(key, { key, status: "failed", message: "This image could not be decoded." }); }} /> : <></>;
  return <video ref={mediaElement} style={style} src={url ?? undefined} preload="auto" playsInline
    aria-label={media?.label ?? "Timeline media"}
    onLoadedMetadata={(event) => { if (!retired.current) { report(key, { key, status: "loading" }); event.currentTarget.currentTime = currentTime.current; } }}
    onCanPlay={(event) => reportReady(event.currentTarget)}
    onSeeking={() => { if (!retired.current) report(key, { key, status: "loading" }); }}
    onSeeked={(event) => { if (event.currentTarget.readyState >= 2) reportReady(event.currentTarget); }}
    onWaiting={() => { if (!retired.current) report(key, { key, status: "loading" }); }}
    onError={() => { if (!retired.current) report(key, { key, status: "failed", message: "This media could not be decoded. Your edit is preserved." }); }}
  />;
}

function TextLayer({ kind, text, clipId }: { kind: TextCompositionKind; text: string; clipId: string }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let retired = false;
    const measure = () => {
      if (retired) return;
      const contentElement = element.querySelector("[data-text-content]");
      const content = contentElement?.getBoundingClientRect();
      const safe = element.querySelector("[data-text-safe-area]")?.getBoundingClientRect();
      if (content && safe && contentElement) setOverflow(content.top < safe.top - 0.5 || content.bottom > safe.bottom + 0.5 || content.left < safe.left - 0.5 || content.right > safe.right + 0.5 || contentElement.scrollHeight > contentElement.clientHeight || contentElement.scrollWidth > contentElement.clientWidth);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    measure();
    void document.fonts?.ready.then(measure);
    return () => { retired = true; observer?.disconnect(); };
  }, [text, kind]);
  return <div data-clip-id={clipId} style={{ position: "absolute", inset: 0 }}>
    <div ref={root} style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: renderTextCompositionMarkup(kind, text) }} />
    {overflow ? <div role="alert" style={{ position: "absolute", top: 0, insetInline: 0, padding: "0.75rem", background: "#111e", color: "white" }}>Text does not fit in the frame. Shorten it or split it into more clips before exporting.</div> : null}
  </div>;
}

export function ProgramPreview({ project, timeSec, playing, onReadyChange, clockRef }: Props): ReactElement {
  const compiled = useMemo(() => compileSequence(project), [project]);
  const resourceKeys = useMemo(() => continuityKeys(compiled.entries), [compiled]);
  const active = evaluateSequence(compiled, timeSec);
  const [loads, setLoads] = useState<Record<string, LoadState>>({});
  const [retry, setRetry] = useState(0);
  const elements = useRef(new Map<string, HTMLVideoElement>());
  const register = useMemo(() => (key: string, element: HTMLVideoElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  }, []);
  const readyCallback = useRef(onReadyChange);
  const activeKeySet = useRef(new Set<string>());
  const lastPresented = useRef<ActiveSequenceEntry[]>([]);
  useLayoutEffect(() => { readyCallback.current = onReadyChange; }, [onReadyChange]);
  const report = useMemo(() => (key: string, state: LoadState) => {
    if (state.status !== "ready" && activeKeySet.current.has(key)) readyCallback.current(false);
    setLoads((prior) => prior[key]?.status === state.status && prior[key]?.message === state.message ? prior : { ...prior, [key]: state });
  }, []);
  const mediaEntries = active.filter(isMediaEntry);
  const attemptKey = (entry: SequenceEntry) => `${resourceKeys.get(entry.clip.id) ?? resourceKey(entry)}:${retry}`;
  activeKeySet.current = new Set(mediaEntries.map(attemptKey));
  // Prepare only the immediate adjoining successor per active lane. Standby
  // media is silent/invisible and cannot stall the current playback clock.
  const standby = mediaEntries.flatMap((entry): ActiveSequenceEntry[] => {
    const next = compiled.entries.find((candidate) => candidate.track.id === entry.track.id
      && candidate.clip.id !== entry.clip.id && isMediaEntry(candidate) && (candidate.visual || candidate.gain > 0)
      && candidate.clip.timelineStartSec > timeSec
      && (sameEdge(entry.clip.timelineStartSec + entry.clip.durationSec, candidate.clip.timelineStartSec)
        || (candidate.transitionIn !== undefined && candidate.clip.timelineStartSec < entry.clip.timelineStartSec + entry.clip.durationSec)));
    return next && attemptKey(next) !== attemptKey(entry) ? [{ ...next, sourceTimeSec: next.clip.sourceInSec ?? 0 }] : [];
  });
  // If decoding is late at a touching edge, retain the outgoing frame while
  // the shared clock waits. Never retain it across a gap or an explicit seek.
  const held = playing ? lastPresented.current.filter((prior) => mediaEntries.some((entry) => entry.track.id === prior.track.id
    && entry.clip.id !== prior.clip.id && attemptKey(entry) !== attemptKey(prior) && loads[attemptKey(entry)]?.status !== "ready"
    && sameEdge(timeSec, entry.clip.timelineStartSec)
    && sameEdge(prior.clip.timelineStartSec + prior.clip.durationSec, entry.clip.timelineStartSec))) : [];
  const mountedMedia = [...mediaEntries, ...standby, ...held];
  const activeKeys = JSON.stringify(mountedMedia.map(attemptKey));
  useLayoutEffect(() => {
    const keys = new Set<string>(JSON.parse(activeKeys) as string[]);
    setLoads((prior) => Object.keys(prior).every((key) => keys.has(key)) ? prior : Object.fromEntries(Object.entries(prior).filter(([key]) => keys.has(key))));
  }, [activeKeys]);
  const ready = mediaEntries.every((entry) => loads[attemptKey(entry)]?.status === "ready");
  useLayoutEffect(() => {
    if (ready) lastPresented.current = mediaEntries;
    else if (!playing) lastPresented.current = [];
  });
  useLayoutEffect(() => {
    if (!clockRef) return;
    // Prefer audible media as the clock. Stop at the next composition boundary
    // so a delayed animation frame cannot skip a cut or a short overlay.
    const leader = mediaEntries.find((entry) => entry.gain > 0) ?? mediaEntries.find((entry) => entry.clip.kind === "video");
    let boundary = compiled.durationSec;
    for (const { clip } of compiled.entries) {
      for (const edge of [clip.timelineStartSec, clip.timelineStartSec + clip.durationSec]) {
        if (edge > timeSec) boundary = Math.min(boundary, edge);
      }
    }
    clockRef.current = () => {
      if (!leader || !ready) return null;
      const element = elements.current.get(attemptKey(leader));
      if (!element || element.seeking || element.readyState < 2) return null;
      const sourceTime = element.ended ? (leader.clip.sourceInSec ?? 0) + leader.clip.durationSec : element.currentTime;
      return Math.min(boundary, Math.max(timeSec, leader.clip.timelineStartSec + sourceTime - (leader.clip.sourceInSec ?? 0)));
    };
    return () => { clockRef.current = null; };
  });
  useLayoutEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  const failed = mediaEntries.some((entry) => loads[attemptKey(entry)]?.status === "failed");
  const messages = mediaEntries.filter((entry) => loads[attemptKey(entry)]?.status !== "ready").map((entry) =>
    loads[attemptKey(entry)]?.message ?? `Loading ${entry.media?.label ?? entry.clip.kind}…`,
  );
  return <div className="video-program" aria-label="Assembled sequence preview" style={{ display: "grid", placeItems: "center", containerType: "size", width: "100%", height: "100%", background: "#000", overflow: "hidden" }}>
    <div style={{ position: "relative", width: "min(100cqw, 177.777778cqh)", height: "min(56.25cqw, 100cqh)", overflow: "hidden" }}>
    {[...active, ...standby, ...held].map((entry) => {
      if (isMediaEntry(entry)) {
        const isStandby = standby.includes(entry);
        const isHeld = held.includes(entry);
        const waitingForHandoff = held.some((prior) => prior.track.id === entry.track.id) && !isHeld;
        const renderedEntry = isStandby || waitingForHandoff ? { ...entry, visual: false, gain: 0 } : isHeld ? { ...entry, gain: 0 } : entry;
        return <MediaLayer key={attemptKey(entry)} attemptKey={attemptKey(entry)} entry={renderedEntry} frameDurationSec={compiled.frameDurationSec} playing={!isStandby && !isHeld && playing && ready} report={report} register={register} />;
      }
      const text = typeof entry.clip.props["text"] === "string" ? entry.clip.props["text"] : "";
      return <TextLayer key={entry.clip.id} clipId={entry.clip.id} kind={entry.clip.kind as TextCompositionKind} text={text} />;
    })}
    {messages.length > 0 && (!held.length || failed) ? <div role="status" className="video-program__status" style={{ position: "absolute", bottom: 0, insetInline: 0, padding: "0.75rem", background: "#111e", color: "white" }}>{[...new Set(messages)].join(" ")}{failed ? <button type="button" onClick={() => { setLoads({}); setRetry((value) => value + 1); }}>Retry preview</button> : null}</div> : null}
    {compiled.entries.length === 0 ? <div className="video-program__empty">Add media to the timeline to begin.</div> : null}
    </div>
  </div>;
}
