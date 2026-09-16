import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactElement } from "react";
import { TimelineMenu, TrackIcon } from "./TimelineMenu";
import type { Clip, MediaAsset, Sequence, Track } from "../edl";
import {
  ClipBlock,
  type ClipGesturePreview,
  type ClipMoveRequest,
  type ClipTrimLeftRequest,
  type ClipTrimRightRequest,
} from "./ClipBlock";
import type { TimelineRange } from "./Ruler";
import { secondsToPixels, timelineTickStep } from "./timeline-utils";
import { pixelsToSeconds } from "./timeline-utils";
import { buildTimelineSnapIndex, resolveTimelineSnap } from "./snap-index";
import { secondsToFrame } from "./timing";

export const VIDEO_MEDIA_DRAG_TYPE = "application/x-nautilo-video-media-id";

export type TimelineTrackProps = {
  track: Track;
  media?: readonly MediaAsset[] | undefined;
  sequence: Sequence;
  orderedTracks: readonly Track[];
  selectedClipId: string | null;
  selectedClipIds?: ReadonlySet<string> | undefined;
  pixelsPerSecond: number;
  playheadSec: number;
  locked?: boolean | undefined;
  range?: TimelineRange | undefined;
  snapEnabled?: boolean | undefined;
  onSelectClip: (clipId: string, additive?: boolean, preserveSelection?: boolean) => void;
  onUpdateTrack?: ((trackId: string, patch: Partial<Pick<Track, "name" | "locked" | "muted" | "hidden">>) => void) | undefined;
  onPreviewChange?: ((preview: ClipGesturePreview | null) => void) | undefined;
  onMoveClip: (request: ClipMoveRequest) => void;
  onTrimLeft: (request: ClipTrimLeftRequest) => void;
  onTrimRight: (request: ClipTrimRightRequest) => void;
  onPlaceMedia?: ((request: { mediaId: string; trackId: string; timelineStartSec: number }) => void) | undefined;
  onDeleteTrack?: ((trackId: string) => void) | undefined;
  onMoveTrack?: ((trackId: string, direction: -1 | 1) => void) | undefined;
  canMoveUp?: boolean | undefined;
  canMoveDown?: boolean | undefined;
  onSeparateAudio?: ((clipId: string) => void) | undefined;
  onDeleteClip?: ((clipId: string) => void) | undefined;
};

function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
}

function trackName(track: Track): string {
  if (track.name?.trim()) return track.name.trim();
  const explicitName = track.id.replace(/^track-/, "").replaceAll("-", " ").trim();
  if (explicitName && !["video", "overlay", "captions", "voice", "music"].includes(explicitName)) {
    return explicitName.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  switch (track.kind) {
    case "video":
      return "Video";
    case "overlay":
      return "Overlay";
    case "caption":
      return "Captions";
    case "audio":
      return "Voice";
    case "music":
      return "Music";
  }
}

export function TimelineTrack({
  track,
  media,
  sequence,
  orderedTracks,
  selectedClipId,
  selectedClipIds,
  pixelsPerSecond,
  playheadSec,
  locked = false,
  range,
  snapEnabled,
  onSelectClip,
  onUpdateTrack,
  onPreviewChange,
  onMoveClip,
  onTrimLeft,
  onTrimRight,
  onPlaceMedia,
  onDeleteTrack,
  onMoveTrack,
  canMoveUp = false,
  canMoveDown = false,
  onSeparateAudio,
  onDeleteClip,
}: TimelineTrackProps): ReactElement {
  const editProtected = locked || track.hidden === true;
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cancelRename = useRef(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [draftName, setDraftName] = useState(trackName(track));
  useEffect(() => setDraftName(trackName(track)), [track.id, track.name]);
  const commitName = () => {
    setRenaming(false);
    if (cancelRename.current) { cancelRename.current = false; setDraftName(trackName(track)); return; }
    const name = draftName.trim();
    if (!locked && name && name !== trackName(track)) onUpdateTrack?.(track.id, { name });
    else setDraftName(trackName(track));
  };
  const rangeStart = range ? Math.min(range.inSec, range.outSec) : 0;
  const rangeEnd = range ? Math.max(range.inSec, range.outSec) : 0;
  const rangeWidth = Math.max(0, rangeEnd - rangeStart);
  return (
    <div className={`video-track${locked ? " video-track--locked" : ""}${track.hidden ? " video-track--hidden" : ""}`} aria-label={`${trackName(track)} track${locked ? ", locked" : ""}${track.hidden ? ", hidden" : ""}`}>
      <div className="video-track__label">
          {renaming ? <input
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            className="video-track__rename"
            aria-label={`Rename ${trackName(track)} track`}
            disabled={locked}
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelRename.current = true;
                setDraftName(trackName(track));
                event.currentTarget.blur();
              }
            }}
          /> : <button type="button" className="video-track__name" title={`${trackName(track)} · Double-click to rename`} onDoubleClick={() => { if (!locked) setRenaming(true); }} onKeyDown={(event) => { if (event.key === "F2" && !locked) { event.preventDefault(); setRenaming(true); } }}>{trackName(track)}</button>}
        <div className="video-track__controls">
        <button
          type="button"
          aria-pressed={locked}
          aria-label={`${locked ? "Unlock" : "Lock"} ${trackName(track)} track`}
          title={locked ? "Unlock track" : "Lock track to protect its clips"}
          onClick={() => onUpdateTrack?.(track.id, { locked: !locked })}
        >
          <TrackIcon kind="lock" />
        </button>
        <button type="button" disabled={locked} title={track.muted ? "Unmute track" : "Mute track"} aria-pressed={track.muted === true} aria-label={`${track.muted ? "Unmute" : "Mute"} ${trackName(track)} track`} onClick={() => onUpdateTrack?.(track.id, { muted: !track.muted })}>
          <TrackIcon kind="mute" />
        </button>
        <button type="button" className="video-track__visibility" title={track.hidden ? "Show track — enable preview and editing" : "Hide track — exclude from preview and editing"} aria-pressed={track.hidden === true} aria-label={`${track.hidden ? "Show" : "Hide"} ${trackName(track)} track`} onClick={() => onUpdateTrack?.(track.id, { hidden: !track.hidden })}>
          <TrackIcon kind={track.hidden ? "eye-off" : "eye"} />
        </button>
        <button type="button" aria-label={`${trackName(track)} track actions`} title="Track actions" aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom }); }}><TrackIcon kind="more" /></button>
        {menu ? <TimelineMenu {...menu} onClose={closeMenu} items={[
          { label: "Rename track", disabled: locked, run: () => setRenaming(true) },
          { label: "Move up", disabled: !canMoveUp || !onMoveTrack, run: () => onMoveTrack?.(track.id, -1) },
          { label: "Move down", disabled: !canMoveDown || !onMoveTrack, run: () => onMoveTrack?.(track.id, 1) },
          { label: "Delete empty track", disabled: editProtected || track.clips.length > 0 || !onDeleteTrack, run: () => onDeleteTrack?.(track.id) },
        ]} /> : null}
        </div>
      </div>
      <div
        className="video-track__lane"
        aria-label={`${trackName(track)} timeline lane${track.hidden ? "; hidden and excluded from editing" : locked ? "; locked and excluded from range actions" : "; unlocked and included in range actions"}`}
        onPointerDown={() => onSelectClip("")}
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          if (!editProtected && onPlaceMedia) event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          if (editProtected || !onPlaceMedia) return;
          event.preventDefault();
          const mediaId = event.dataTransfer.getData(VIDEO_MEDIA_DRAG_TYPE);
          if (!mediaId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const rawSeconds = pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond);
          const index = buildTimelineSnapIndex(sequence, { playheadSec });
          const snap = resolveTimelineSnap(index, {
            frame: secondsToFrame(rawSeconds, index.frameRate),
            pixelsPerSecond,
            enabled: snapEnabled !== false && !event.altKey,
          });
          onPlaceMedia({ mediaId, trackId: track.id, timelineStartSec: snap.seconds });
        }}
        style={{
          backgroundSize: `${timelineTickStep(pixelsPerSecond) * pixelsPerSecond}px 100%`,
          opacity: locked && !track.hidden ? 0.68 : undefined,
        }}
      >
        {rangeWidth > 0 && !track.hidden ? (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: secondsToPixels(rangeStart, pixelsPerSecond),
              width: secondsToPixels(rangeWidth, pixelsPerSecond),
              background: locked
                ? "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, #eeb546 32%, transparent) 4px 8px)"
                : "repeating-linear-gradient(135deg, color-mix(in srgb, #2ecf97 22%, transparent) 0 4px, transparent 4px 8px)",
              borderInline: `1px ${locked ? "dashed #eeb546" : "solid #2ecf97"}`,
              pointerEvents: "none",
            }}
          />
        ) : null}
        {sortClips(track.clips).map((clip) => (
          <ClipBlock
            clip={clip}
            key={clip.id}
            sequence={sequence}
            orderedTracks={orderedTracks}
            selected={!track.hidden && (selectedClipIds?.has(clip.id) ?? clip.id === selectedClipId)}
            selectedClipIds={selectedClipIds}
            pixelsPerSecond={pixelsPerSecond}
            playheadSec={playheadSec}
            snapEnabled={snapEnabled}
            locked={editProtected}
            protectionReason={track.hidden ? "Show track to edit" : undefined}
            onSelect={onSelectClip}
            onPreviewChange={onPreviewChange}
            onMove={onMoveClip}
            onTrimLeft={onTrimLeft}
            onTrimRight={onTrimRight}
            onSeparateAudio={onSeparateAudio}
            onDeleteClip={onDeleteClip}
            asset={media?.find((asset) => asset.id === clip.mediaId)}
          />
        ))}
      </div>
    </div>
  );
}
