import { expect, test } from "bun:test";
import { createEmptyProject } from "../edl";
import { fitTimelineScale, timelineDisplayDurationSec } from "./Timeline";
import { audioPeaks } from "./ClipMediaVisual";
import { formatFrameRate } from "../FrameRateDialog";

test("zoom fit is derived from available timeline width and real duration", () => {
  expect(fitTimelineScale(800, 200, 60)).toBe(10);
  expect(fitTimelineScale(1400, 200, 60)).toBe(20);
  expect(fitTimelineScale(800, 200, 120)).toBe(5);
});

test("waveforms measure actual audio across channels on the sequence frame grid", () => {
  const wave = audioPeaks([new Float32Array([0, -.5, 0, 0]), new Float32Array([0, .25, 0, 1])], 4, 2);
  expect([...wave.peaks]).toEqual([.5, 1]);
  expect(wave.samplesPerSecond).toBe(2);
  expect([...audioPeaks([new Float32Array(4)], 4, 2).peaks]).toEqual([0, 0]);
});

test("frame-rate labels are human readable while rational values remain unchanged", () => {
  expect(formatFrameRate({ numerator: 60, denominator: 1 })).toBe("60 fps");
  expect(formatFrameRate({ numerator: 30000, denominator: 1001 })).toBe("29.97 fps");
});

test("an empty timeline displays zero duration even when its ruler reserves visual width", () => {
  const sequence = createEmptyProject().sequences[0]!;
  expect(timelineDisplayDurationSec(sequence)).toBe(0);
  expect(timelineDisplayDurationSec({ ...sequence, durationSec: 4.25 })).toBe(4.25);
});

test("timeline track state is persisted and locked gestures remain selectable", async () => {
  const timelineSource = await Bun.file(`${import.meta.dir}/Timeline.tsx`).text();
  const trackSource = await Bun.file(`${import.meta.dir}/TimelineTrack.tsx`).text();
  const clipSource = await Bun.file(`${import.meta.dir}/ClipBlock.tsx`).text();

  expect(timelineSource).not.toContain("lockedTrackIds");
  expect(timelineSource).toContain("onUpdateTrack={onUpdateTrack}");
  expect(timelineSource).toContain("locked={track.locked === true}");
  expect(trackSource).toContain('onUpdateTrack?.(track.id, { locked: !locked })');
  expect(trackSource).toContain('onUpdateTrack?.(track.id, { muted: !track.muted })');
  expect(trackSource).toContain('onUpdateTrack?.(track.id, { hidden: !track.hidden })');
  expect(trackSource).toContain("if (!locked && name");
  expect(clipSource.indexOf("onSelect(clip.id")).toBeLessThan(clipSource.indexOf("if (locked) return;"));
  expect(clipSource).toContain("if (locked) return;");
});
