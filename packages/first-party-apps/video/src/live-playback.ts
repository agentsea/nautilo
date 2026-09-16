/** Transient editor commands. These never modify the saved project. */
export type PlaybackCommand =
  | { action: "inspect" | "play" | "pause" | "clear-range" }
  | { action: "seek"; seconds: number }
  | { action: "preview-range"; inSec: number; outSec: number };

export type PlaybackState = {
  playheadSec: number;
  durationSec: number;
  playing: boolean;
  range: { inSec: number; outSec: number };
};

export type PlaybackResult =
  | { status: "unknown"; stateChanged: "unknown"; retrySafe: false }
  | { status: "ready"; state: PlaybackState; documentChanged: false; playbackConfirmed: false }
  | { status: "rejected"; code: "dirty_document" | "stale_document" | "invalid_command" | "out_of_range" | "session_closed"; stateChanged: false; retrySafe: false };

export function parsePlaybackResult(value: unknown): PlaybackResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { status?: unknown; stateChanged?: unknown; retrySafe?: unknown; code?: unknown; documentChanged?: unknown; playbackConfirmed?: unknown; state?: unknown };
  if (v.status === "unknown" && v.stateChanged === "unknown" && v.retrySafe === false &&
      Object.keys(v).every((key) => ["status", "stateChanged", "retrySafe"].includes(key))) return v as PlaybackResult;
  if (v.status === "rejected" && v.stateChanged === false && v.retrySafe === false &&
      ["dirty_document", "stale_document", "invalid_command", "out_of_range", "session_closed"].includes(String(v.code)) &&
      Object.keys(v).every((key) => ["status", "code", "stateChanged", "retrySafe"].includes(key))) return v as PlaybackResult;
  if (v.status !== "ready" || v.documentChanged !== false || v.playbackConfirmed !== false ||
      !v.state || typeof v.state !== "object" || Array.isArray(v.state) ||
      !Object.keys(v).every((key) => ["status", "state", "documentChanged", "playbackConfirmed"].includes(key))) return null;
  const state = v.state as PlaybackState;
  if (!state.range || typeof state.range !== "object" || Array.isArray(state.range) ||
      !Object.keys(state).every((key) => ["playheadSec", "durationSec", "playing", "range"].includes(key)) ||
      !Object.keys(state.range).every((key) => ["inSec", "outSec"].includes(key)) ||
      typeof state.playing !== "boolean" ||
      ![state.playheadSec, state.durationSec, state.range.inSec, state.range.outSec].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
      state.playheadSec > state.durationSec || state.range.inSec > state.durationSec || state.range.outSec > state.durationSec) return null;
  return v as PlaybackResult;
}

export function parsePlaybackCommand(value: unknown): PlaybackCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { action?: unknown; seconds?: unknown; inSec?: unknown; outSec?: unknown };
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const only = (...keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
  if (typeof v.action === "string" && ["inspect", "play", "pause", "clear-range"].includes(v.action) && only("action")) return v as PlaybackCommand;
  if (v.action === "seek" && finite(v.seconds) && only("action", "seconds")) return v as PlaybackCommand;
  if (v.action === "preview-range" && finite(v.inSec) && finite(v.outSec) && v.outSec > v.inSec && only("action", "inSec", "outSec")) return v as PlaybackCommand;
  return null;
}

/** Pure planner shared by the live command receiver and transport tests. */
export function planPlaybackCommand(state: PlaybackState, command: PlaybackCommand): PlaybackState | null {
  if (command.action === "inspect") return state;
  if (command.action === "pause") return { ...state, playing: false };
  if (command.action === "clear-range") return { ...state, playing: false, range: { inSec: state.playheadSec, outSec: state.playheadSec } };
  if (state.durationSec <= 0) return null;
  if (command.action === "preview-range") {
    if (command.outSec > state.durationSec) return null;
    return { ...state, playing: true, playheadSec: command.inSec, range: { inSec: command.inSec, outSec: command.outSec } };
  }
  const start = Math.min(state.range.inSec, state.range.outSec);
  const end = Math.max(state.range.inSec, state.range.outSec);
  const ranged = end > start;
  if (command.action === "seek") {
    if (command.seconds > state.durationSec || (ranged && (command.seconds < start || command.seconds > end))) return null;
    return { ...state, playing: false, playheadSec: command.seconds };
  }
  return { ...state, playing: true, playheadSec: ranged ? start : state.playheadSec >= state.durationSec ? 0 : state.playheadSec };
}
