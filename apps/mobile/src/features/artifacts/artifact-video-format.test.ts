import { expect, test } from "bun:test";
import { hasLocalVideoContainer, isVideoCandidate } from "./artifact-video-format";

test("video candidates do not promise container or codec support", () => {
  expect(isVideoCandidate("clip.MP4", "application/octet-stream")).toBe(true);
  expect(isVideoCandidate("clip", "Video/QuickTime; codecs=hvc1")).toBe(true);
  expect(isVideoCandidate("clip.webm", "application/octet-stream")).toBe(true);
  expect(isVideoCandidate("live.m3u8", "application/vnd.apple.mpegurl")).toBe(false);
  expect(isVideoCandidate("notes.md", "text/markdown")).toBe(false);
});

test("only binary container signatures enter the local decoder; manifests and spoofed MIME do not", () => {
  expect(hasLocalVideoContainer(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109]))).toBe(true);
  expect(hasLocalVideoContainer(Uint8Array.from([0x1a,0x45,0xdf,0xa3]))).toBe(true);
  for (const source of ["#EXTM3U\nhttps://remote.invalid/video.ts", "<MPD><BaseURL>https://remote.invalid</BaseURL></MPD>", "", "not a movie"]) {
    expect(hasLocalVideoContainer(new TextEncoder().encode(source))).toBe(false);
  }
  expect(hasLocalVideoContainer(Uint8Array.from([0,0,0,4,102,116,121,112,0,0,0,0]))).toBe(false);
});
