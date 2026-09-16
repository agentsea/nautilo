import { useEffect, useRef, useState, type ReactElement } from "react";
import { getNautiloApp } from "../bridge";
import type { Clip, MediaAsset } from "../edl";

type Wave = { peaks: Float32Array; samplesPerSecond: number };
type Resource = { url: string; wave?: Wave; release: () => void };
type Entry = { users: number; controller: AbortController; ready: Promise<Resource> };
// Only visible clips retain resources; split clips share the same source decode.
const resources = new Map<string, Entry>();

export function audioPeaks(channels: readonly Float32Array[], sampleRate: number, framesPerSecond: number): Wave {
  const length = channels[0]?.length ?? 0;
  const peaks = new Float32Array(Math.ceil(length / sampleRate * framesPerSecond));
  for (let frame = 0; frame < peaks.length; frame += 1) {
    const start = Math.floor(frame * sampleRate / framesPerSecond);
    const end = Math.min(length, Math.ceil((frame + 1) * sampleRate / framesPerSecond));
    let peak = 0;
    for (const channel of channels) for (let sample = start; sample < end; sample += 1) peak = Math.max(peak, Math.abs(channel[sample] ?? 0));
    peaks[frame] = peak;
  }
  return { peaks, samplesPerSecond: framesPerSecond };
}

async function openResource(asset: MediaAsset, audio: boolean, signal: AbortSignal): Promise<Resource> {
  const bridge = getNautiloApp();
  if (!bridge?.media) throw new Error("Preview unavailable");
  const result = await bridge.media.openPreview(asset.lifecycle === "durable" && asset.source?.kind === "workspace-artifact" ? { mediaId: asset.id } : { ref: asset.ref }, { signal });
  if (result.kind !== "ready") throw new Error("Preview unavailable");
  const release = () => { void Promise.resolve(bridge.media!.closePreview(result.revokeToken)).catch(() => undefined); };
  try {
    signal.throwIfAborted();
    if (!audio) return { url: result.url, release };
    // The host streams the decode and sends only display peaks, not encoded
    // media or full PCM. Large files never enter Web Audio's whole-file path.
    if (!result.waveform) throw new Error("Waveform unavailable");
    return { url: result.url, wave: { peaks: Float32Array.from(result.waveform.peaks), samplesPerSecond: result.waveform.samplesPerSecond }, release };
  } catch (error) { release(); throw error; }
}

function retain(asset: MediaAsset, audio: boolean, rate: number): { ready: Promise<Resource>; release: () => void } {
  const key = JSON.stringify([asset, audio, rate]);
  let entry = resources.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { users: 0, controller, ready: openResource(asset, audio, controller.signal) };
    resources.set(key, entry);
  }
  entry.users += 1;
  const retained = entry;
  return { ready: retained.ready, release: () => {
    retained.users -= 1;
    if (retained.users === 0) {
      retained.controller.abort();
      resources.delete(key);
      void retained.ready.then((resource) => resource.release(), () => undefined);
    }
  } };
}

export function ClipMediaVisual({ clip, asset, framesPerSecond }: { clip: Clip; asset: MediaAsset | undefined; framesPerSecond: number }): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [resource, setResource] = useState<Resource | null>(null);
  const [failed, setFailed] = useState(false);
  const audio = clip.kind === "audio";
  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting === true), { root: element.closest(".video-timeline__scroller") });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setResource(null); setFailed(false);
    if (!visible || !asset || (clip.kind !== "video" && !audio)) return;
    let active = true;
    const lease = retain(asset, audio, framesPerSecond);
    void lease.ready.then((value) => { if (active) setResource(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; lease.release(); };
  // Stable identity includes the source provenance, not just a reused media id.
  }, [asset, audio, clip.kind, framesPerSecond, visible]);
  useEffect(() => {
    const element = video.current;
    if (element && element.readyState >= 1) element.currentTime = clip.sourceInSec ?? 0;
  }, [clip.sourceInSec, resource]);
  useEffect(() => {
    const element = canvas.current;
    const wave = resource?.wave;
    if (!element || !wave) return;
    const viewport = element.closest<HTMLElement>(".video-timeline__scroller");
    const strip = element.parentElement!;
    const paint = () => {
      const bounds = strip.getBoundingClientRect();
      const viewportBounds = viewport?.getBoundingClientRect() ?? bounds;
      const headerWidth = Number.parseFloat(getComputedStyle(strip.closest(".video-timeline")!).getPropertyValue("--track-header-width")) || 0;
      const left = Math.max(bounds.left, viewportBounds.left + headerWidth);
      const offset = Math.max(0, left - bounds.left);
      const width = Math.max(0, Math.ceil(Math.min(bounds.right, viewportBounds.right) - left));
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (!width || !height) return;
      // A zoomed clip may span hours. Allocate only the visible viewport, not
      // an enormous off-screen canvas that exceeds the browser's dimensions.
      element.style.width = `${width}px`;
      element.style.transform = `translateX(${offset}px)`;
      element.width = width; element.height = height;
      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = getComputedStyle(element).color;
      const start = clip.sourceInSec ?? 0;
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor((start + (offset + x) / bounds.width * clip.durationSec) * wave.samplesPerSecond);
        const to = Math.ceil((start + (offset + x + 1) / bounds.width * clip.durationSec) * wave.samplesPerSecond);
        let peak = 0;
        for (let frame = from; frame < to; frame += 1) peak = Math.max(peak, wave.peaks[frame] ?? 0);
        ctx.fillRect(x, (height - Math.max(1, peak * height)) / 2, 1, Math.max(1, peak * height));
      }
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(strip);
    viewport?.addEventListener("scroll", paint, { passive: true });
    return () => { observer?.disconnect(); viewport?.removeEventListener("scroll", paint); };
  }, [resource, clip.sourceInSec, clip.durationSec]);
  return <div ref={container} className={`video-clip__media video-clip__media--${audio ? "audio" : "video"}`}>
    {audio && resource?.wave ? <canvas ref={canvas} aria-label="Audio waveform" /> : !audio && resource ? <video ref={video} aria-label="Video thumbnail" src={resource.url} muted playsInline preload="metadata" onLoadedMetadata={(event) => { event.currentTarget.currentTime = clip.sourceInSec ?? 0; }} onError={() => setFailed(true)} /> : null}
    {(!resource || failed) ? <span>{audio ? "♫" : "▣"} {failed ? `${audio ? "Waveform" : "Thumbnail"} unavailable` : audio ? "Audio" : "Video"}</span> : null}
  </div>;
}
