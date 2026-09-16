import { describe, expect, test } from "bun:test";
import { parsePlaybackCommand, parsePlaybackResult, planPlaybackCommand, type PlaybackState } from "./live-playback";

const state: PlaybackState = { durationSec: 10, playheadSec: 5, playing: false, range: { inSec: 0, outSec: 0 } };
describe("live Video transport", () => {
  test("plays selected range from IN, pauses, clears and seeks full sequence without saved edits", () => {
    const selected = planPlaybackCommand(state, { action: "preview-range", inSec: 2, outSec: 4 })!;
    expect(selected).toEqual({ ...state, playheadSec: 2, playing: true, range: { inSec: 2, outSec: 4 } });
    expect(planPlaybackCommand(selected, { action: "seek", seconds: 5 })).toBeNull();
    expect(planPlaybackCommand(selected, { action: "pause" })?.playing).toBe(false);
    const cleared = planPlaybackCommand(selected, { action: "clear-range" })!;
    expect(planPlaybackCommand(cleared, { action: "seek", seconds: 9 })?.playheadSec).toBe(9);
    expect(state.playheadSec).toBe(5);
    expect(planPlaybackCommand(state, { action: "inspect" })).toBe(state);
  });
  test("empty sequence cannot play, no silent clamp or invented duration", () => {
    expect(planPlaybackCommand({ ...state, durationSec: 0, playheadSec: 0 }, { action: "play" })).toBeNull();
    expect(planPlaybackCommand(state, { action: "seek", seconds: 11 })).toBeNull();
    expect(planPlaybackCommand(state, { action: "preview-range", inSec: 1, outSec: 11 })).toBeNull();
    expect(planPlaybackCommand({ ...state, playheadSec: 10 }, { action: "play" })?.playheadSec).toBe(0);
  });
  test.each([null, [], {}, { action: "seek" }, { action: "seek", seconds: NaN }, { action: "seek", seconds: Infinity }, { action: "seek", seconds: -1 }, { action: "play", path: "other.video.html" }, { action: "preview-range", inSec: 3, outSec: 2 }, { action: "play", inSec: 0 }].map((value) => ({ value })))("rejects invalid/extra authority %j", ({ value }) => {
    expect(parsePlaybackCommand(value)).toBeNull();
  });
  test("receipt is strictly bounded to transport facts, not URLs or claims of decoded playback", () => {
    const ready = { status: "ready", state, documentChanged: false, playbackConfirmed: false } as const;
    expect(parsePlaybackResult(ready)).toEqual(ready);
    expect(parsePlaybackResult({ ...ready, playbackConfirmed: true })).toBeNull();
    expect(parsePlaybackResult({ ...ready, url: "file:///private" })).toBeNull();
    expect(parsePlaybackResult({ ...ready, state: { ...state, durationSec: Infinity } })).toBeNull();
  });
});
