// Representative structural content for the cutting-room shell.
//
// This is deliberately an EDL-only fixture: no media references, bytes,
// decoded metadata, playback assumptions, or durable interaction state.

import { EDL_VERSION, type Clip, type ClipKind, type Track, type TrackKind, type VideoProject } from "./edl";

type FixtureClip = {
  id: string;
  kind: ClipKind;
  start: number;
  duration: number;
  label: string;
  text?: string;
};

function clip(trackId: string, input: FixtureClip): Clip {
  return {
    id: input.id,
    kind: input.kind,
    trackId,
    timelineStartSec: input.start,
    durationSec: input.duration,
    props: {
      label: input.label,
      ...(input.text ? { text: input.text } : {}),
    },
  } as Clip;
}

function track(id: string, kind: TrackKind, order: number, clips: readonly FixtureClip[]): Track {
  return { id, kind, order, clips: clips.map((entry) => clip(id, entry)) };
}

/**
 * A deterministic, fresh 20-clip/6-track project for structural UI and pure
 * interaction tests. Timeline positions are canonical seconds at rest.
 */
export function createCuttingRoomFixtureProject(): VideoProject {
  return {
    version: EDL_VERSION,
    metadata: {
      createdBy: "nautilo-cutting-room-fixture",
      title: "A Quiet Morning",
    },
    media: [],
    sequences: [
      {
        id: "sequence-cutting-room-fixture",
        frameRate: { numerator: 30, denominator: 1 },
        durationSec: 75,
        tracks: [
          track("track-picture", "video", 0, [
            { id: "picture-dawn", kind: "video", start: 0, duration: 12, label: "Dawn over the studio" },
            { id: "picture-coffee", kind: "video", start: 12, duration: 11, label: "Coffee at the window" },
            { id: "picture-notebook", kind: "video", start: 23, duration: 13, label: "Notebook close-up" },
            { id: "picture-walk", kind: "video", start: 36, duration: 14, label: "Walk to the workshop" },
            { id: "picture-door", kind: "video", start: 50, duration: 12, label: "Workshop door" },
            { id: "picture-finish", kind: "video", start: 62, duration: 10, label: "Finished work" },
          ]),
          track("track-b-roll", "video", 1, [
            { id: "broll-hands", kind: "image", start: 4, duration: 7, label: "Hands arranging tools" },
            { id: "broll-light", kind: "image", start: 18, duration: 6, label: "Light on the table" },
            { id: "broll-sketch", kind: "image", start: 31, duration: 8, label: "Sketch detail" },
            { id: "broll-shelf", kind: "image", start: 53, duration: 9, label: "Finished pieces on shelf" },
          ]),
          track("track-overlays", "overlay", 2, [
            { id: "title-morning", kind: "text", start: 0, duration: 5, label: "Opening title", text: "A Quiet Morning" },
            { id: "callout-routine", kind: "callout", start: 25, duration: 6, label: "Routine callout", text: "Make room to notice." },
            { id: "title-credit", kind: "text", start: 64, duration: 7, label: "Closing credit", text: "Made in the workshop" },
          ]),
          track("track-captions", "caption", 3, [
            { id: "caption-1", kind: "caption", start: 2, duration: 9, label: "Opening narration", text: "The day starts before the noise arrives." },
            { id: "caption-2", kind: "caption", start: 26, duration: 10, label: "Workshop narration", text: "A small ritual clears the way for work." },
            { id: "caption-3", kind: "caption", start: 54, duration: 11, label: "Closing narration", text: "Leave something kind behind." },
          ]),
          track("track-voice", "audio", 4, [
            { id: "voice-opening", kind: "audio", start: 0, duration: 35, label: "Narration: opening reflection" },
            { id: "voice-closing", kind: "audio", start: 35, duration: 35, label: "Narration: closing reflection" },
          ]),
          track("track-music", "music", 5, [
            { id: "music-intro", kind: "audio", start: 0, duration: 30, label: "Music: soft piano introduction" },
            { id: "music-outro", kind: "audio", start: 30, duration: 42, label: "Music: warm piano outro" },
          ]),
        ],
      },
    ],
  };
}
