import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from "react";
import type { Clip, VideoProject } from "./edl";
import { clipTransition, transitionTarget, SWIPE_DIRECTIONS, type SwipeDirection, type TransitionKind } from "./transitions";

export const TRANSITION_DRAG_TYPE = "application/x-nautilo-cut-transition";
export type TransitionEdit = { clipId: string; kind: TransitionKind; durationSec: number; direction: SwipeDirection };
export const TransitionContext = createContext<{
  project: VideoProject;
  selected: { clipId: string; kind: TransitionKind } | null;
  select: (clipId: string, kind: TransitionKind) => void;
  drop: (clipId: string, kind: TransitionKind) => void;
  edit: (input: TransitionEdit) => void;
  reject: (message: string) => void;
} | null>(null);
const label = (kind: TransitionKind) => kind === "crossfade" ? "Crossfade" : "Swipe";

export function TransitionLibrary({ clip }: { clip: Clip | null }): ReactElement {
  const context = useContext(TransitionContext);
  return <section className="video-toolbox-choices" aria-label="Cut transitions">
    <p className="video-toolbox-note">Drop a transition at a cut to apply it. Drag its ends to resize. Properties offers optional exact settings.</p>
    {(["crossfade", "swipe"] as const).map((kind) => <button type="button" key={kind} className="video-toolbox-tile" draggable
      aria-label={`Choose ${label(kind)}`} aria-disabled={!clip || clip.kind !== "video"}
      onClick={() => { if (clip?.kind === "video") context?.select(clip.id, kind); }}
      onDragStart={(event) => { event.dataTransfer.setData(TRANSITION_DRAG_TYPE, kind); event.dataTransfer.effectAllowed = "copy"; }}>
      <strong>{label(kind)}</strong><small>{kind === "crossfade" ? "Blend two shots, without fading through black" : "Reveal the next shot in one direction"}</small>
    </button>)}
  </section>;
}

export function TransitionInspector({ clip }: { clip: Clip }): ReactElement | null {
  const context = useContext(TransitionContext);
  if (!context || clip.kind !== "video") return null;
  const effect = clipTransition(clip);
  const selected = context.selected?.clipId === clip.id ? context.selected : null;
  if (!selected) return effect ? <section><button type="button" onClick={() => context.select(clip.id, effect.kind)}>Edit {label(effect.kind)} at start · {effect.durationSec.toFixed(2)}s</button></section> : null;
  return <TransitionEditor key={`${clip.id}:${selected.kind}`} clip={clip} kind={selected.kind} />;
}

function TransitionEditor({ clip, kind }: { clip: Clip; kind: TransitionKind }): ReactElement {
  const context = useContext(TransitionContext)!;
  const effect = clipTransition(clip);
  const target = transitionTarget(context.project, clip.id);
  const max = "error" in target ? 0 : target.maxDurationSec;
  const initial = effect?.durationSec ?? Math.min(1, max);
  const [duration, setDuration] = useState(String(initial));
  const [direction, setDirection] = useState<SwipeDirection>(effect?.direction ?? "left");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (document.activeElement?.closest(".video-toolbox-choices")) input.current?.focus(); }, []);
  useEffect(() => setDuration(String(initial)), [initial]);
  const seconds = Number(duration);
  return <section className="video-fade-editor" aria-label="Transition settings">
    <strong>{label(kind)} at clip start</strong>
    {"error" in target ? <p role="status">{target.error}</p> : <>
      <p>Maximum {max.toFixed(3)}s from available source footage. The cut stays at {clip.timelineStartSec.toFixed(2)}s.</p>
      {max === 0 ? <p>No spare footage at this cut. Trim the sources to leave handles, then bring the clips together again.</p> : null}
      <label>Duration (seconds)<input ref={input} type="number" aria-label="Transition duration in seconds" min="0" max={max} step="any" value={duration}
        onChange={(event) => setDuration(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDuration(String(initial)); setDirection(effect?.direction ?? "left"); } }} /></label>
      {kind === "swipe" ? <label>Direction<select aria-label="Swipe direction" value={direction} onChange={(event) => setDirection(event.currentTarget.value as SwipeDirection)}>{SWIPE_DIRECTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : null}
      <small>Blends these clips’ embedded audio too. Separate audio tracks stay unchanged. Clip positions and project length stay unchanged.</small>
      <button type="button" disabled={!duration.trim() || !Number.isFinite(seconds) || seconds <= 0 || seconds > max} onClick={() => context.edit({ clipId: clip.id, kind, direction, durationSec: seconds })}>{effect ? "Update transition" : "Apply transition"}</button>
    </>}
    {effect ? <button type="button" onClick={() => context.edit({ clipId: clip.id, kind, direction, durationSec: 0 })}>Remove transition</button> : null}
  </section>;
}

/** A single badge spans the cut; each end resizes symmetrically without trimming. */
export function TransitionBadge({ clip, pixelsPerSecond, frameSec, locked }: { clip: Clip; pixelsPerSecond: number; frameSec: number; locked: boolean }): ReactElement | null {
  const context = useContext(TransitionContext);
  const effect = clipTransition(clip);
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{ x: number; sign: number; next: number; moved: boolean } | null>(null);
  if (!effect || !context) return null;
  const target = transitionTarget(context.project, clip.id);
  const max = "error" in target ? 0 : target.maxDurationSec;
  const duration = draft ?? effect.durationSec;
  const cancel = () => { drag.current = null; setDraft(null); };
  const edit = (value: number) => context.edit({ clipId: clip.id, ...effect, durationSec: value });
  return <div className="video-transition-badge" role="group" aria-label={`${label(effect.kind)} at ${clip.timelineStartSec.toFixed(2)}s`}
    style={{ left: (clip.timelineStartSec - duration / 2) * pixelsPerSecond, width: Math.max(24, duration * pixelsPerSecond) }}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); cancel(); } if (!locked && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); edit(0); } }}>
    <button type="button" disabled={locked} aria-label={`Edit ${label(effect.kind)} transition`} onClick={() => context.select(clip.id, effect.kind)} title={`${label(effect.kind)} · ${duration.toFixed(2)}s · Delete removes only transition`}>{effect.kind === "crossfade" ? "◇" : "→"}</button>
    {([-1, 1] as const).map((sign) => <span key={sign} className={`video-transition-grip${sign < 0 ? " is-left" : " is-right"}`} role="slider" tabIndex={locked ? -1 : 0}
      aria-label={`${label(effect.kind)} ${sign < 0 ? "start" : "end"} handle`} aria-valuemin={0} aria-valuemax={max} aria-valuenow={duration} aria-disabled={locked}
      onPointerDown={(event) => { event.stopPropagation(); if (locked) return; event.currentTarget.focus(); context.select(clip.id, effect.kind); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, sign, next: effect.durationSec, moved: false }; }}
      onPointerMove={(event) => { const d = drag.current; if (!d || locked) return; if (!d.moved && Math.abs(event.clientX - d.x) < 3) return; d.moved = true; d.next = Math.min(max, Math.max(frameSec, Math.round((effect.durationSec + 2 * d.sign * (event.clientX - d.x) / pixelsPerSecond) / frameSec) * frameSec)); setDraft(d.next); }}
      onPointerUp={(event) => { const d = drag.current; cancel(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (d?.moved) edit(d.next); }} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onKeyDown={(event) => { if (!locked && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); event.stopPropagation(); edit(Math.min(max, Math.max(frameSec, effect.durationSec + (event.key === "ArrowRight" ? sign : -sign) * frameSec * 2))); } }} />)}
  </div>;
}
