import { useEffect, useRef, useState, type ReactElement } from "react";
import { getNautiloApp } from "./bridge";
import type { MediaAsset } from "./edl";
import type { GenerationReference } from "./generation-brief";
import { AudioWaveform } from "./AudioWaveform";

/** Source inspection only: never creates a clip or changes the timeline clock. */
export function MediaBinPreview({ asset, reference, enabled, active, timelinePlaying, onPlay }: ({ asset: MediaAsset; reference?: never } | { reference: GenerationReference; asset?: never }) & {
  enabled: boolean; active: boolean; timelinePlaying: boolean; onPlay: () => void;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<readonly number[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const label = asset ? asset.label ?? asset.id : reference.name;
  const kind = asset?.kind ?? reference?.mediaKind ?? "image";
  // Autosave replaces parsed objects even when the source is unchanged.
  // Keep the playback lease stable through prompt/scene edits.
  const sourceIdentity = JSON.stringify(asset ? [asset.id, asset.kind, asset.ref, asset.lifecycle, asset.source] : [reference.id, reference.mediaKind, reference.source]);
  useEffect(() => {
    if (!enabled) { setVisible(false); return; }
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting === true));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    setUrl(null); setPeaks(null); setFailed(false);
    if (!enabled || !visible) return;
    const bridge = getNautiloApp()?.media;
    if (!bridge) { setFailed(true); return; }
    const controller = new AbortController();
    let disposed = false;
    let token: string | undefined;
    const release = (value: string) => { void Promise.resolve(bridge.closePreview(value)).catch(() => undefined); };
    const request = reference ? { referenceId: reference.id } : asset.lifecycle === "durable" && asset.source?.kind === "workspace-artifact" ? { mediaId: asset.id } : { ref: asset.ref };
    void bridge.openPreview(request, { signal: controller.signal }).then((result) => {
      if (result.kind !== "ready") { if (!disposed) setFailed(true); return; }
      if (disposed) { release(result.revokeToken); return; }
      token = result.revokeToken;
      setPeaks(result.waveform?.peaks ?? null);
      setUrl(result.url);
    }, () => { if (!disposed) setFailed(true); });
    return () => { disposed = true; controller.abort(); if (token) release(token); };
  }, [sourceIdentity, enabled, visible, retry]);
  useEffect(() => {
    if (!active || timelinePlaying || !enabled || !visible) {
      video.current?.pause();
      audio.current?.pause();
    }
  }, [active, timelinePlaying, enabled, visible]);
  return <div ref={container} className={`video-media-bin-preview${kind === "audio" ? " video-media-bin-preview--audio" : ""}`} role="group" aria-label={`Source preview: ${label}`}
    onKeyDown={(event) => event.stopPropagation()}>
    {url && !failed && kind === "image" ? <img src={url} alt={label} draggable={false} onError={() => setFailed(true)} /> : url && !failed && kind === "audio" ? <>
      {peaks?.length ? <AudioWaveform peaks={peaks} /> : <span>Waveform unavailable</span>}
      <audio ref={audio} src={url} aria-label={`Preview ${label}`} controls preload="metadata" onPlay={onPlay} onError={() => setFailed(true)} />
    </> : url && !failed ? <>
      <video ref={video} src={url} aria-label={`Preview ${label}`} muted playsInline preload="metadata" controls={active} draggable={false}
        onPlay={onPlay} onError={() => setFailed(true)} />
      {!active ? <button type="button" className="video-media-bin-preview__play" aria-label={`Play source preview: ${label}`}
        onClick={() => { onPlay(); void video.current?.play().catch(() => setFailed(true)); }}>▶<span>Preview</span></button> : null}
    </> : <span>{failed ? "Preview unavailable" : `${kind === "image" ? "Image" : kind === "audio" ? "Audio" : "Video"} preview`}</span>}
    {failed ? <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry preview</button> : null}
  </div>;
}
