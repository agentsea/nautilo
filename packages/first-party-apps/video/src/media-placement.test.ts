import { expect, test } from "bun:test";
import { mediaPlacementDurationSec } from "./app";

test("placement never invents a video/audio duration; still images use a display default", () => {
  expect(mediaPlacementDurationSec({ kind: "video" })).toBeUndefined();
  expect(mediaPlacementDurationSec({ kind: "audio" })).toBeUndefined();
  expect(mediaPlacementDurationSec({ kind: "image" })).toBe(5);
  expect(mediaPlacementDurationSec({ kind: "video", durationSec: 12.5 })).toBe(12.5);
});
