import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from "react";
import type { Clip } from "./edl";
import { clipFades, FADE_KEYS, FADE_LABELS, fadeSupported, type FadeEdit, type FadeKey } from "./fades";

export const FADE_DRAG_TYPE = "application/x-nautilo-video-fade";
export const FadeContext = createContext<{
  selected: { clipId: string; key: FadeKey } | null;
  select: (clipId: string, key: FadeKey) => void;
  drop: (clipId: string, key: FadeKey) => void;
  edit: (input: FadeEdit) => void;
} | null>(null);

export function FadeLibrary({ channel, clip }: { channel: "video" | "audio"; clip: Clip | null }): ReactElement {
  const context = useContext(FadeContext);
  return <section className="video-toolbox-choices" aria-label={`${channel} fades`}>
    <p className="video-toolbox-note">Drop a fade onto a clip to apply it. Drag its timeline handle to resize. Properties offers optional exact settings.</p>
    {FADE_KEYS.filter((key) => key.startsWith(channel)).map((key) => <button key={key} type="button" className="video-toolbox-tile" draggable
      onDragStart={(event) => { event.dataTransfer.setData(FADE_DRAG_TYPE, key); event.dataTransfer.effectAllowed = "copy"; }}
      onClick={() => { if (clip && fadeSupported(clip, key)) context?.select(clip.id, key); }}
      aria-label={`Choose ${FADE_LABELS[key]}`} aria-disabled={!clip || !fadeSupported(clip, key)}>
      <span className={`video-fade-sample${key.endsWith("Out") ? " video-fade-sample--out" : ""}`} aria-hidden="true" />
      <strong>{FADE_LABELS[key]}</strong><small>Drop to apply · drag handle to resize</small>
    </button>)}
    {channel === "audio" ? <p className="video-toolbox-note">Independent audio crossfade is not available yet. These fades do not change video opacity.</p> : null}
  </section>;
}

export function FadeInspector({ clip }: { clip: Clip }): ReactElement | null {
  const context = useContext(FadeContext);
  const key = context?.selected?.clipId === clip.id ? context.selected.key : null;
  return <section className="video-fade-inspector" aria-label="Clip fades">
    <strong>Fades</strong>
    <div className="video-fade-list">{FADE_KEYS.filter((entry) => fadeSupported(clip, entry)).map((entry) => <button type="button" key={entry} aria-pressed={key === entry} onClick={() => context?.select(clip.id, entry)}>{FADE_LABELS[entry]}{clipFades(clip)[entry] ? " · Applied" : ""}</button>)}</div>
    {key ? <FadeEditor key={`${clip.id}:${key}`} clip={clip} fadeKey={key} /> : <small>Select a fade to adjust its duration.</small>}
  </section>;
}

function FadeEditor({ clip, fadeKey }: { clip: Clip; fadeKey: FadeKey }): ReactElement {
  const context = useContext(FadeContext)!;
  const fade = clipFades(clip)[fadeKey];
  // One second is an editable starting suggestion, bounded by this clip only.
  const [duration, setDuration] = useState(String(fade?.durationSec ?? Math.min(1, clip.durationSec)));
  const [linked, setLinked] = useState(true);
  const durationInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Library selection can close the narrow library drawer. Move keyboard
    // focus with it, but never steal focus from a timeline fade gesture.
    if (document.activeElement?.closest(".video-toolbox-choices")) durationInput.current?.focus();
  }, []);
  useEffect(() => setDuration(String(fade?.durationSec ?? Math.min(1, clip.durationSec))), [fade?.durationSec, clip.durationSec]);
  const value = Number(duration);
  return <div className="video-fade-editor">
    <strong>{FADE_LABELS[fadeKey]}</strong>
    <label>Duration (seconds)<input ref={durationInput} aria-label="Fade duration in seconds" type="number" min="0" max={clip.durationSec} step="any" value={duration} onChange={(event) => setDuration(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDuration(String(fade?.durationSec ?? Math.min(1, clip.durationSec))); } }} /></label>
    {fadeKey.startsWith("video") ? <label><input type="checkbox" checked={linked} onChange={(event) => setLinked(event.currentTarget.checked)} />Also fade this clip’s audio and linked audio</label> : null}
    <small>{fadeKey.startsWith("video") ? "Reveals lower layers, or black if none. Clip positions stay unchanged." : "Changes loudness only. Clip positions stay unchanged."} Timeline handles resize or delete one fade at a time. Existing ramps stay attached to source footage when trimmed or split.</small>
    <div><button type="button" disabled={!duration.trim() || !Number.isFinite(value) || value <= 0 || value > clip.durationSec} onClick={() => context.edit({ clipId: clip.id, key: fadeKey, durationSec: value, linkedAudio: linked })}>{fade ? "Update fade" : "Apply fade"}</button>
    {fade ? <button type="button" onClick={() => context.edit({ clipId: clip.id, key: fadeKey, durationSec: 0, linkedAudio: linked })}>Remove fade</button> : null}</div>
  </div>;
}

export function ClipFadeHandles({ clip, pixelsPerSecond, frameSec, locked }: { clip: Clip; pixelsPerSecond: number; frameSec: number; locked: boolean }): ReactElement {
  return <>{FADE_KEYS.filter((key) => clipFades(clip)[key]).map((key) => <FadeHandle key={key} clip={clip} fadeKey={key} pixelsPerSecond={pixelsPerSecond} frameSec={frameSec} locked={locked} />)}</>;
}

function FadeHandle({ clip, fadeKey, pixelsPerSecond, frameSec, locked }: { clip: Clip; fadeKey: FadeKey; pixelsPerSecond: number; frameSec: number; locked: boolean }): ReactElement {
  const context = useContext(FadeContext);
  const fade = clipFades(clip)[fadeKey]!;
  const [draft, setDraft] = useState<number | null>(null);
  const gesture = useRef<{ x: number; duration: number; next: number; moved: boolean } | null>(null);
  const out = fadeKey.endsWith("Out");
  const offset = fade.startSec - (clip.sourceInSec ?? 0);
  const start = draft === null ? offset : out ? clip.durationSec - draft : 0;
  const end = draft === null ? offset + fade.durationSec : out ? clip.durationSec : draft;
  const left = Math.max(0, Math.min(clip.durationSec, start));
  const right = Math.max(left, Math.min(clip.durationSec, end));
  const selected = context?.selected?.clipId === clip.id && context.selected.key === fadeKey;
  const cancel = () => { gesture.current = null; setDraft(null); };
  return <div className={`video-fade-handle${selected ? " is-selected" : ""}${out ? " is-out" : ""}`} data-fade-key={fadeKey}
    style={{ left: left * pixelsPerSecond, width: Math.max(16, (right - left) * pixelsPerSecond), bottom: fadeKey.startsWith("audio") ? 1 : 11 }}
    role="slider" tabIndex={locked ? -1 : 0} aria-label={FADE_LABELS[fadeKey]} aria-disabled={locked} aria-valuemin={0} aria-valuemax={clip.durationSec} aria-valuenow={draft ?? fade.durationSec}
    title={`${FADE_LABELS[fadeKey]} · ${fade.durationSec.toFixed(2)}s · Drag to resize; Delete removes fade`}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => { event.stopPropagation(); if (locked) return; event.currentTarget.focus(); context?.select(clip.id, fadeKey); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { x: event.clientX, duration: Math.min(clip.durationSec, fade.durationSec), next: fade.durationSec, moved: false }; }}
    onPointerMove={(event) => { event.stopPropagation(); const current = gesture.current; if (!current) return; if (Math.abs(event.clientX - current.x) < 3 && !current.moved) return; current.moved = true; current.next = Math.max(frameSec, Math.min(clip.durationSec, Math.round((current.duration + (event.clientX - current.x) / pixelsPerSecond * (out ? -1 : 1)) / frameSec) * frameSec)); setDraft(current.next); }}
    onPointerUp={(event) => { event.stopPropagation(); const current = gesture.current; cancel(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (current?.moved) context?.edit({ clipId: clip.id, key: fadeKey, durationSec: current.next }); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={(event) => {
      event.stopPropagation(); if (locked) return;
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); context?.select(clip.id, fadeKey); }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); context?.edit({ clipId: clip.id, key: fadeKey, durationSec: 0 }); }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); context?.edit({ clipId: clip.id, key: fadeKey, durationSec: Math.max(frameSec, Math.min(clip.durationSec, fade.durationSec + (event.key === "ArrowRight" ? frameSec : -frameSec))) }); }
    }}><span aria-hidden="true">{out ? "↘" : "↗"}</span></div>;
}
