// V1 EDL model for the Nautilo video timeline mini-app.
//
// Scope is deliberately creator/timeline-class: projects, media assets, one
// sequence (V1), tracks, clips, linked clips, captions, overlays, and render
// metadata. Nested sequences, effects stacks, color grading, multicam,
// proxies, and audio mixing are OUT of scope for V1.
//
// This module is pure TypeScript with no React/DOM dependency so it can run
// both in the mini-app iframe and in server-side agent tool handlers.

export const EDL_VERSION = 1 as const;

// Project capacity is owned by the document host, not per-track or asset quotas.

/**
 * The sequence display/snap rate. Timeline times remain canonical seconds;
 * frames are derived only where a frame-domain interaction needs them.
 */
export type FrameRate = {
  numerator: number;
  denominator: number;
};

/** The visible, stable default for new and legacy seconds-only projects. */
export const DEFAULT_FRAME_RATE: Readonly<FrameRate> = Object.freeze({ numerator: 30, denominator: 1 });

export type MediaKind = "video" | "audio" | "image";

/**
 * The durability of a reference, not a filesystem location. A local-working
 * ref is valid only while its bound Current Folder authority remains present;
 * a future host promotion may change it to durable without serializing a
 * path, byte payload, URL, or process detail into the document.
 */
export type MediaReferenceLifecycle = "local-working" | "durable";


/**
 * A durable Workspace artifact source. `artifactId` is its public external
 * identity, never the server's internal artifact row id. The host still
 * authorizes and resolves it at preview/promotion time; this document field is
 * lineage, not a byte capability.
 */
export type WorkspaceArtifactMediaSource = {
  kind: "workspace-artifact";
  artifactId: string;
  path: string;
};

export type MediaAsset = {
  /** Stable id referenced by clips via `mediaId`. */
  id: string;
  kind: MediaKind;
  /**
   * Project-relative display reference. It is never authority by itself: the
   * host resolves it relative to the bound project under a separately issued
   * capability. URLs and raw filesystem paths are not executable media refs.
   */
  ref: string;
  /** Defaults to local-working for legacy V1 documents. */
  lifecycle?: MediaReferenceLifecycle;
  /**
   * Present only for a durable Workspace artifact source. Existing Current
   * Folder and legacy media keep their project-relative `ref` unchanged.
   */
  source?: WorkspaceArtifactMediaSource;
  /** Optional known duration in seconds. */
  durationSec?: number;
  /** Optional measured source rate; the sequence remains the display grid. */
  frameRate?: FrameRate;
  /** Optional human label. */
  label?: string;
};

export type TrackKind = "video" | "overlay" | "caption" | "audio" | "music";

export type ClipKind = "video" | "audio" | "image" | "text" | "caption" | "callout";

/**
 * Tracks are compositing lanes, not media-type silos. Their legacy kind is
 * an organizational/default-placement hint; clip kind controls rendering.
 * Keep the same serialized kinds so existing projects need no migration.
 */
const TIMELINE_LANE_KINDS: readonly TrackKind[] = ["video", "overlay", "caption", "audio", "music"];
export const COMPATIBLE_TRACK_BY_CLIP_KIND: Readonly<Record<ClipKind, readonly TrackKind[]>> = {
  video: TIMELINE_LANE_KINDS,
  audio: TIMELINE_LANE_KINDS,
  image: TIMELINE_LANE_KINDS,
  text: TIMELINE_LANE_KINDS,
  caption: TIMELINE_LANE_KINDS,
  callout: TIMELINE_LANE_KINDS,
};

export type ClipBase = {
  /** Stable clip id unique within the sequence. */
  id: string;
  /** Owning track id. */
  trackId: string;
  /** Optional reference to a MediaAsset. */
  mediaId?: string;
  /** Timeline position in seconds (non-negative). */
  timelineStartSec: number;
  /** Clip duration on the timeline in seconds (positive). */
  durationSec: number;
  /** Source in-point in seconds (media-local). Optional for generated clips. */
  sourceInSec?: number;
  /** Source out-point in seconds (media-local). Optional. */
  sourceOutSec?: number;
  /** Linked clip ids (e.g. detached audio <-> video). */
  linkedClipIds?: string[];
  /** Free-form per-kind properties (text content, crop, volume, etc.). */
  props: Record<string, unknown>;
};

export type VideoClip = ClipBase & { kind: "video" };
export type AudioClip = ClipBase & { kind: "audio" };
export type ImageClip = ClipBase & { kind: "image" };
export type TextClip = ClipBase & { kind: "text" };
export type CaptionClip = ClipBase & { kind: "caption" };
export type CalloutClip = ClipBase & { kind: "callout" };

export type Clip =
  | VideoClip
  | AudioClip
  | ImageClip
  | TextClip
  | CaptionClip
  | CalloutClip;

export type Track = {
  id: string;
  kind: TrackKind;
  /** Optional human label; omitted legacy tracks retain their existing presentation. */
  name?: string;
  /** Locked tracks refuse timeline, source, property, link, and ordering edits. */
  locked?: boolean;
  /** Presentation-only audio state. */
  muted?: boolean;
  /** Presentation-only visibility state. */
  hidden?: boolean;
  /** Stable sort key; lower numbers appear above higher ones. */
  order: number;
  clips: Clip[];
};

export type Sequence = {
  id: string;
  /**
   * Rational frame rate used for timeline display, snapping, and gestures.
   * Parsers normalize omitted legacy values to 30/1 before use.
   */
  frameRate: FrameRate;
  /** Total sequence duration in seconds (>= max clip end). */
  durationSec: number;
  tracks: Track[];
  /** Optional sequence-level timeline annotations. */
  markers?: TimelineMarker[];
};

export type TimelineMarker = {
  id: string;
  /** Position in the canonical seconds domain. */
  timeSec: number;
  label?: string;
};

export type ProjectMetadata = {
  createdBy?: string;
  updatedAt?: string;
  /** Optional project title. */
  title?: string;
};

export type VideoProject = {
  version: typeof EDL_VERSION;
  /** V1 supports a single active sequence; this is an array for forward-compat. */
  sequences: Sequence[];
  media: MediaAsset[];
  /** Optional so legacy artifacts do not acquire a new payload on read. */
  generationBrief?: import("./generation-brief").GenerationBrief;
  /** Completed outputs only; no receipt, provider state, or bytes are stored. */
  generatedTakes?: import("./generation-takes").GeneratedTake[];
  metadata?: ProjectMetadata;
};

export type VideoManifest = {
  documentType: "video";
  editor: "nautilo-video";
  payloadId: string;
  payloadFormat: "application/vnd.nautilo.video-edl+json";
  version: "1.0" | "1.1" | "1.2";
  metadata?: {
    createdBy?: string;
    updatedAt?: string;
  };
};

export type VideoDocument = {
  manifest: VideoManifest;
  project: VideoProject;
};

/**
 * Project media references are a small project-relative identifier grammar.
 * They are not URLs or filesystem paths and must never carry a traversal
 * segment. The host independently resolves this under a granted scope.
 */
export function isProjectRelativeMediaRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.includes(":")) return false;
  if (/\p{Cc}/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isFrameRate(value: unknown): value is FrameRate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rate = value as Record<string, unknown>;
  const numerator = rate["numerator"];
  const denominator = rate["denominator"];
  return (
    typeof numerator === "number" &&
    typeof denominator === "number" &&
    Number.isSafeInteger(numerator) &&
    Number.isSafeInteger(denominator) &&
    numerator > 0 &&
    denominator > 0
  );
}

// ---- Helpers ----

export function isClipKindAllowedOnTrack(clipKind: ClipKind, trackKind: TrackKind): boolean {
  return COMPATIBLE_TRACK_BY_CLIP_KIND[clipKind].includes(trackKind);
}

export function findTrack(sequence: Sequence, trackId: string): Track | undefined {
  return sequence.tracks.find((track) => track.id === trackId);
}

export function findClip(sequence: Sequence, clipId: string): { clip: Clip; track: Track } | undefined {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

export function listOrderedTracks(sequence: Sequence): Track[] {
  return [...sequence.tracks].sort((a, b) => a.order - b.order);
}

export function listAllClips(sequence: Sequence): Clip[] {
  const out: Clip[] = [];
  for (const track of sequence.tracks) {
    for (const clip of track.clips) out.push(clip);
  }
  return out;
}

// ---- Defaults ----

/** Standard V1 track roster mirroring the issue's ASCII sketch. */
export const DEFAULT_TRACK_ROSTER: ReadonlyArray<{ id: string; kind: TrackKind; order: number }> = [
  // Top-to-bottom paint order: new captions/overlays must sit above video.
  // Existing documents retain their explicit order; this is not a migration.
  { id: "track-video", kind: "video", order: 2 },
  { id: "track-overlay", kind: "overlay", order: 1 },
  { id: "track-captions", kind: "caption", order: 0 },
  { id: "track-voice", kind: "audio", order: 3 },
  { id: "track-music", kind: "music", order: 4 },
];

export function createDefaultSequence(): Sequence {
  return {
    id: "sequence-1",
    frameRate: { ...DEFAULT_FRAME_RATE },
    durationSec: 0,
    tracks: DEFAULT_TRACK_ROSTER.map((entry) => ({ id: entry.id, kind: entry.kind, order: entry.order, clips: [] })),
  };
}

export function createEmptyProject(): VideoProject {
  return {
    version: EDL_VERSION,
    sequences: [createDefaultSequence()],
    media: [],
    metadata: {
      createdBy: "nautilo",
      updatedAt: new Date().toISOString(),
    },
  };
}
