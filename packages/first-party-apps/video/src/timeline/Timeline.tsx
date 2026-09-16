import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { MediaAsset, Sequence, Track, TrackKind } from "../edl";
import { listOrderedTracks } from "../edl";
import { computeSequenceDurationSec } from "../timing";
import { type ClipGesturePreview, type ClipMoveRequest, type ClipTrimLeftRequest, type ClipTrimRightRequest } from "./ClipBlock";
import { Ruler, type TimelineRange } from "./Ruler";
import { TimelineTrack } from "./TimelineTrack";
import { sequenceFrameRate } from "./timing";
import { secondsToPixels } from "./timeline-utils";
import { TimelineMenu } from "./TimelineMenu";

export type TimelineClipboardAction = "copy" | "cut" | "paste" | "delete";

export function fitTimelineScale(viewportWidth: number, headerWidth: number, durationSec: number): number {
  return Math.max(1, viewportWidth - headerWidth) / Math.max(1, durationSec);
}

export type TimelineProps = {
  sequence: Sequence;
  media?: readonly MediaAsset[] | undefined;
  selectedClipId: string | null;
  selectedClipIds?: ReadonlySet<string> | undefined;
  playheadSec: number;
  range?: TimelineRange;
  onRangeChange?: (range: TimelineRange) => void;
  /** Empty projects are deliberately inert: there is no range or edit target. */
  interactive?: boolean | undefined;
  onSelectClip: (clipId: string | null, additive?: boolean, preserveSelection?: boolean) => void;
  onScrub: (seconds: number) => void;
  onMoveClip: (request: ClipMoveRequest) => void;
  onTrimLeft: (request: ClipTrimLeftRequest) => void;
  onTrimRight: (request: ClipTrimRightRequest) => void;
  onPlaceMedia?: ((request: { mediaId: string; trackId: string; timelineStartSec: number }) => void) | undefined;
  onAddTrack?: ((kind: TrackKind) => void) | undefined;
  onDeleteTrack?: ((trackId: string) => void) | undefined;
  onReorderTrack?: ((trackId: string, destinationIndex: number) => void) | undefined;
  onUpdateTrack?: ((trackId: string, patch: Partial<Pick<Track, "name" | "locked" | "muted" | "hidden">>) => void) | undefined;
  /** Parent-owned validated split command; Timeline remains its sole UI home. */
  onSplitSelected?: (() => void) | undefined;
  onSeparateAudio?: ((clipId: string) => void) | undefined;
  onDeleteClip?: ((clipId: string) => void) | undefined;
  onClipboardAction?: ((action: TimelineClipboardAction, range: TimelineRange) => boolean) | undefined;
  clipboardLabel?: string | undefined;
};

export function invokeSplitSelected(selectedClipId: string | null, onSplitSelected: (() => void) | undefined): boolean {
  if (!selectedClipId || !onSplitSelected) return false;
  onSplitSelected();
  return true;
}

/** The actual edit duration never inherits the ruler's visual minimum. */
export function timelineDisplayDurationSec(sequence: Sequence): number {
  return Math.max(sequence.durationSec, computeSequenceDurationSec(sequence));
}

function trackLabel(track: { id: string; kind: string; name?: string }): string {
  return track.name?.trim() || track.id.replace(/^track-/, "") || track.kind;
}

/**
 * Structural timeline fixture. Durable track state comes from the EDL; clip
 * edits still use the existing parent callbacks exactly once on pointer-up.
 */
export function Timeline({
  sequence,
  media,
  selectedClipId,
  selectedClipIds,
  playheadSec,
  range: controlledRange,
  onRangeChange,
  interactive = true,
  onSelectClip,
  onScrub,
  onMoveClip,
  onTrimLeft,
  onTrimRight,
  onPlaceMedia,
  onAddTrack,
  onDeleteTrack,
  onReorderTrack,
  onUpdateTrack,
  onSplitSelected,
  onSeparateAudio,
  onDeleteClip,
  onClipboardAction,
  clipboardLabel,
}: TimelineProps): ReactElement {
  const orderedTracks = listOrderedTracks(sequence);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(48);
  const [headerWidth, setHeaderWidth] = useState(200);
  const [viewportWidth, setViewportWidth] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);
  const priorScale = useRef(pixelsPerSecond);
  const resizing = useRef<{ x: number; width: number } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [localRange, setLocalRange] = useState<TimelineRange>({ inSec: playheadSec, outSec: playheadSec });
  const range = controlledRange ?? localRange;
  const setRange = useCallback((next: TimelineRange) => {
    if (range.inSec === next.inSec && range.outSec === next.outSec) return;
    if (controlledRange) onRangeChange?.(next);
    else setLocalRange(next);
  }, [controlledRange, onRangeChange, range]);
  const [editMenu, setEditMenu] = useState<{ x: number; y: number } | null>(null);
  const closeEditMenu = useCallback(() => setEditMenu(null), []);
  const [activePreview, setActivePreview] = useState<ClipGesturePreview | null>(null);
  const frameRate = sequenceFrameRate(sequence);
  const sequenceDurationSec = timelineDisplayDurationSec(sequence);
  const durationSec = interactive ? Math.max(sequenceDurationSec, playheadSec, range.outSec, 1) : 10;
  const fitScale = fitTimelineScale(viewportWidth, headerWidth, durationSec + 2);
  const minScale = Math.min(48, fitScale);
  const maxScale = Math.max(72, frameRate.numerator / frameRate.denominator * 12, fitScale);
  const contentWidth = headerWidth + secondsToPixels(durationSec + 2, pixelsPerSecond);
  const resizeHeader = (width: number) => setHeaderWidth(Math.max(160, Math.min(width, Math.max(200, viewportWidth / 2))));
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setViewportWidth(element.clientWidth); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && priorScale.current !== pixelsPerSecond) {
      // Zoom around the playhead when visible, otherwise preserve the left edge.
      const anchor = playheadSec * priorScale.current >= element.scrollLeft && playheadSec * priorScale.current <= element.scrollLeft + viewportWidth - headerWidth ? playheadSec : element.scrollLeft / priorScale.current;
      element.scrollLeft += anchor * (pixelsPerSecond - priorScale.current);
    }
    priorScale.current = pixelsPerSecond;
  }, [pixelsPerSecond, playheadSec, viewportWidth, headerWidth]);
  const rangeStart = Math.min(range.inSec, range.outSec);
  const rangeEnd = Math.max(range.inSec, range.outSec);
  const trackIntersectsRange = (track: (typeof orderedTracks)[number]) => rangeEnd > rangeStart && track.clips.some(
    (clip) => clip.timelineStartSec < rangeEnd && clip.timelineStartSec + clip.durationSec > rangeStart,
  );
  const unlockedTrackLabels = orderedTracks.filter((track) => !track.locked && !track.hidden && trackIntersectsRange(track)).map(trackLabel);
  const lockedTrackLabels = orderedTracks.filter((track) => track.locked && trackIntersectsRange(track)).map(trackLabel);
  const hiddenTrackLabels = orderedTracks.filter((track) => track.hidden && trackIntersectsRange(track)).map(trackLabel);
  const hasSelection = rangeEnd > rangeStart ? unlockedTrackLabels.length > 0 : Boolean(selectedClipId || selectedClipIds?.size);
  const actOnClipboard = useCallback((action: TimelineClipboardAction) => {
    const done = onClipboardAction?.(action, range);
    if (done && action !== "copy") setRange({ inSec: playheadSec, outSec: playheadSec });
  }, [onClipboardAction, range, playheadSec, setRange]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !onClipboardAction) return;
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu]")) return;
      const key = event.key.toLowerCase();
      const action = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        ? ({ c: "copy", x: "cut", v: "paste" } as const)[key as "c" | "x" | "v"]
        : !event.metaKey && !event.ctrlKey && !event.altKey && (key === "delete" || key === "backspace") ? "delete" : undefined;
      if (!action) return;
      event.preventDefault();
      actOnClipboard(action);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [actOnClipboard, onClipboardAction]);

  useEffect(() => {
    if (!interactive) {
      setRange({ inSec: 0, outSec: 0 });
      return;
    }
    // Keep joined wings attached to a newly scrubbed playhead without moving a separated range.
    if (range.inSec === range.outSec) setRange({ inSec: playheadSec, outSec: playheadSec });
  }, [interactive, playheadSec, range, setRange]);

  return (
    <section className="video-timeline" aria-label="Video timeline" style={{ "--track-header-width": `${headerWidth}px` } as CSSProperties}>
      <div className="video-timeline__toolbar" role="toolbar" aria-label="Timeline tools">
        <div style={{ marginRight: "auto" }}>
          <strong>Timeline</strong>
          <span>{sequenceDurationSec.toFixed(2)}s · {frameRate.numerator}/{frameRate.denominator} fps</span>
        </div>
        <button type="button" disabled={!interactive} aria-pressed title={interactive ? "Select clips and trim handles" : "Add or generate media to begin editing."} onClick={() => onSelectClip(selectedClipId)}>
          Select
        </button>
        {onClipboardAction ? <button type="button" aria-label="Timeline Edit menu" aria-haspopup="menu" aria-expanded={Boolean(editMenu)} title="Copy, Cut (leave gap), Paste at playhead, Delete (leave gap)" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setEditMenu({ x: rect.left, y: rect.bottom }); }}>Edit ▾</button> : null}
        {editMenu ? <TimelineMenu {...editMenu} onClose={closeEditMenu} items={[
          { label: "Copy · ⌘/Ctrl C", disabled: !hasSelection, run: () => actOnClipboard("copy") },
          { label: "Cut (leave gap) · ⌘/Ctrl X", disabled: !hasSelection, run: () => actOnClipboard("cut") },
          { label: "Paste at playhead · ⌘/Ctrl V", disabled: !clipboardLabel, run: () => actOnClipboard("paste") },
          { label: "Delete (leave gap) · Delete", disabled: !hasSelection, run: () => actOnClipboard("delete") },
        ]} /> : null}
        <button
          type="button"
          disabled={!interactive || !selectedClipId || !onSplitSelected}
          title={!interactive ? "Add or generate media to begin editing." : selectedClipId && onSplitSelected ? "Split selected clip at the playhead" : "Select a clip and connect the validated split command to enable Split."}
          onClick={() => invokeSplitSelected(selectedClipId, onSplitSelected)}
        >
          Split
        </button>
        <button type="button" disabled={!interactive} aria-pressed={snapEnabled} title={interactive ? "Snap to frame grid, cuts, playhead, markers, and caption boundaries. Hold Alt/Option while dragging to disable temporarily." : "Add or generate media to begin editing."} onClick={() => setSnapEnabled((enabled) => !enabled)}>
          Snap {snapEnabled ? "on" : "off"}
        </button>
        {onAddTrack ? <button type="button" aria-label="Add track" title="Add a track for any clip type" onClick={() => onAddTrack("video")}>+ Track</button> : null}
        <button type="button" disabled={pixelsPerSecond <= minScale} title="Zoom out" onClick={() => setPixelsPerSecond((value) => Math.max(minScale, value / 1.5))}>
          −
        </button>
        <input className="video-timeline__zoom" type="range" aria-label="Timeline zoom" aria-valuetext={`${pixelsPerSecond.toFixed(1)} pixels per second`} min={Math.log(Math.min(minScale, pixelsPerSecond))} max={Math.log(Math.max(maxScale, pixelsPerSecond))} step="any" value={Math.log(pixelsPerSecond)} onChange={(event) => setPixelsPerSecond(Math.exp(Number(event.currentTarget.value)))} />
        <button type="button" disabled={pixelsPerSecond >= maxScale} title="Zoom in" onClick={() => setPixelsPerSecond((value) => Math.min(maxScale, value * 1.5))}>
          +
        </button>
        <button type="button" title="Fit the entire timeline" onClick={() => { priorScale.current = fitScale; setPixelsPerSecond(fitScale); if (scroller.current) scroller.current.scrollLeft = 0; }}>
          Fit
        </button>
      </div>
      <div className="video-timeline__scope">
        <strong className="video-timeline__range-readout" style={{ inlineSize: `${2 * Math.max(4, durationSec.toFixed(2).length) + 10}ch` }}>
          {interactive ? `Range ${rangeStart.toFixed(2)}–${rangeEnd.toFixed(2)}s:` : "Nothing to cut yet."}
        </strong>
        <div className="video-timeline__scope-help" aria-live="polite">
        {!interactive ? <span>Add or generate media to begin editing.</span> : <>
          {rangeStart === rangeEnd ? "joined wings — drag IN or OUT." : `affects ${unlockedTrackLabels.join(", ") || "no unlocked tracks"}. Play runs IN to OUT. Tap the playhead handle to clear the selection.`}{" "}
          {lockedTrackLabels.length > 0 ? `Excludes locked: ${lockedTrackLabels.join(", ")}.` : ""}{" "}
          {hiddenTrackLabels.length > 0 ? `Excludes hidden: ${hiddenTrackLabels.join(", ")}.` : ""}{" "}
          <span>{onClipboardAction ? "Edit menu: Copy / Cut / Paste. Cut and Delete leave a gap; paste never overwrites. " : ""}Alt/Option bypasses Snap · Shift+trim previews ripple only.</span></>}
        {onClipboardAction && !hasSelection ? <span> Select clips or drag IN/OUT to copy or cut.</span> : null}
        {clipboardLabel ? <span className="video-timeline__clipboard"> Clipboard: {clipboardLabel}. Paste at the playhead on these original tracks.</span> : null}
        </div>
      </div>
      <div className="video-timeline__scroller" ref={scroller}>
        <div className="video-timeline__content" style={{ width: contentWidth }}>
          <div className="video-timeline__ruler-row">
            <div className="video-track__label video-track__label--ruler">Tracks<button type="button" role="separator" aria-orientation="vertical" aria-label="Resize track headers" aria-valuenow={headerWidth} aria-valuemin={160} className="video-timeline__header-resize" onPointerDown={(event) => { resizing.current = { x: event.clientX, width: headerWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (resizing.current) resizeHeader(resizing.current.width + event.clientX - resizing.current.x); }} onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeHeader(headerWidth + (event.key === "ArrowLeft" ? -10 : 10)); } }} /></div>
            <Ruler
              sequence={sequence}
              durationSec={durationSec}
              pixelsPerSecond={pixelsPerSecond}
              playheadSec={playheadSec}
              range={interactive ? range : undefined}
              snapEnabled={snapEnabled}
              interactive={interactive}
              onRangeChange={interactive ? setRange : undefined}
              onScrub={interactive ? onScrub : () => undefined}
            />
          </div>
          <div className="video-timeline__tracks">
            <div
              className="video-timeline__playhead"
              aria-label="Playback cursor"
              style={{ left: `calc(var(--track-header-width) + ${secondsToPixels(playheadSec, pixelsPerSecond)}px)` }}
            />
            {interactive && rangeEnd > rangeStart ? (
              <>
                <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `calc(var(--track-header-width) + ${secondsToPixels(rangeStart, pixelsPerSecond)}px)`, borderLeft: "1px solid #2ecf97", pointerEvents: "none", zIndex: 2 }} />
                <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `calc(var(--track-header-width) + ${secondsToPixels(rangeEnd, pixelsPerSecond)}px)`, borderLeft: "1px dashed #eeb546", pointerEvents: "none", zIndex: 2 }} />
              </>
            ) : null}
            {activePreview?.snapTarget || activePreview?.snapDisabledByModifier || activePreview?.ripplePreview ? (
              <div
                role="status"
                aria-live="polite"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `calc(var(--track-header-width) + ${secondsToPixels(activePreview.snapTarget?.seconds ?? activePreview.timelineStartSec, pixelsPerSecond)}px)`,
                  zIndex: 7,
                  borderLeft: activePreview.ripplePreview || activePreview.snapDisabledByModifier ? "2px dashed var(--video-muted)" : "2px solid #27c3d9",
                  pointerEvents: "none",
                }}
              >
                <span style={{ position: "absolute", top: 2, left: 4, padding: "2px 4px", border: `1px ${activePreview.ripplePreview || activePreview.snapDisabledByModifier ? "dashed var(--video-muted)" : "solid #27c3d9"}`, borderRadius: 4, background: "var(--video-panel)", color: activePreview.ripplePreview || activePreview.snapDisabledByModifier ? "var(--video-muted)" : "#27c3d9", fontSize: "0.65rem", fontWeight: 700, whiteSpace: "nowrap" }}>
                  {activePreview.ripplePreview
                    ? "RIPPLE PREVIEW · no neighboring clips changed"
                    : activePreview.snapDisabledByModifier
                      ? "SNAP OFF · Alt/Option"
                      : `SNAP · ${activePreview.snapTarget?.label}`}
                </span>
              </div>
            ) : null}
            {orderedTracks.map((track, trackIndex) => (
              <TimelineTrack
                key={track.id}
                track={track}
                sequence={sequence}
                orderedTracks={orderedTracks}
                selectedClipId={selectedClipId}
                selectedClipIds={selectedClipIds}
                pixelsPerSecond={pixelsPerSecond}
                playheadSec={playheadSec}
                locked={track.locked === true}
                range={interactive ? range : undefined}
                snapEnabled={snapEnabled}
                onUpdateTrack={onUpdateTrack}
                onPreviewChange={setActivePreview}
                onPlaceMedia={onPlaceMedia}
                onDeleteTrack={onDeleteTrack}
                onMoveTrack={onReorderTrack ? (trackId, direction) => onReorderTrack(trackId, trackIndex + direction) : undefined}
                canMoveUp={trackIndex > 0 && !track.locked && !track.hidden && !orderedTracks[trackIndex - 1]?.locked && !orderedTracks[trackIndex - 1]?.hidden}
                canMoveDown={trackIndex < orderedTracks.length - 1 && !track.locked && !track.hidden && !orderedTracks[trackIndex + 1]?.locked && !orderedTracks[trackIndex + 1]?.hidden}
                onSelectClip={(clipId, additive, preserveSelection) => onSelectClip(clipId || null, additive, preserveSelection)}
                onMoveClip={onMoveClip}
                onTrimLeft={onTrimLeft}
                onTrimRight={onTrimRight}
                onSeparateAudio={onSeparateAudio}
                onDeleteClip={onDeleteClip}
                media={media}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
