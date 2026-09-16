import { expect, test } from "bun:test";
import { isMediaLibraryCandidate, mediaLibraryLabel } from "./artifact-media-export";

test("library candidates use MIME essence without renaming or converting originals", () => {
  expect(isMediaLibraryCandidate("IMAGE/PNG; charset=binary")).toBe(true);
  expect(isMediaLibraryCandidate("video/mp4")).toBe(true);
  expect(isMediaLibraryCandidate("application/pdf")).toBe(false);
  expect(isMediaLibraryCandidate("image/not valid")).toBe(false);
  expect(mediaLibraryLabel("ios")).toBe("Save to Photos");
  expect(mediaLibraryLabel("android")).toBe("Save to Gallery");
});
