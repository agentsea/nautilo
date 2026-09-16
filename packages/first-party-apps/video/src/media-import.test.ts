import { describe, expect, test } from "bun:test";
import { videoPreviewRequestForAsset, videoPreviewSourceTime } from "./app";
import { addImportedMedia, addImportedVideo, admitImportedMedia, requiresFirstSourceRateDecision } from "./commands";
import { createEmptyProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

const RATE_24 = { numerator: 24, denominator: 1 } as const;

describe("Current Folder MP4 import transaction", () => {
  test("requires an explicit rate choice only for a differing first source in a truly empty project", () => {
    const empty = createEmptyProject();
    expect(requiresFirstSourceRateDecision(empty, RATE_24)).toBe(true);

    const rejected = addImportedVideo(empty, {
      ref: "rushes/opening.mp4",
      label: "Opening",
      durationSec: 12.5,
      frameRate: RATE_24,
    });
    expect(rejected).toEqual({ ok: false, error: "Choose whether to keep the project rate or adopt this first source rate." });

    const adopted = addImportedVideo(empty, {
      ref: "rushes/opening.mp4",
      label: "Opening",
      durationSec: 12.5,
      frameRate: RATE_24,
      rateDecision: "adopt-source-rate",
      mediaId: "media-opening",
      clipId: "clip-opening",
    });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.project.sequences[0]!.frameRate).toEqual(RATE_24);
    expect(adopted.project.media[0]).toMatchObject({
      id: "media-opening",
      kind: "video",
      ref: "rushes/opening.mp4",
      lifecycle: "local-working",
      durationSec: 12.5,
      frameRate: RATE_24,
    });
    expect(adopted.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips[0]).toMatchObject({
      id: "clip-opening",
      mediaId: "media-opening",
      sourceInSec: 0,
      sourceOutSec: 12.5,
    });
  });

  test("never silently changes an established rate", () => {
    const first = addImportedVideo(createEmptyProject(), {
      ref: "rushes/one.mp4",
      label: "One",
      durationSec: 5,
      frameRate: { numerator: 30, denominator: 1 },
      mediaId: "media-one",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(requiresFirstSourceRateDecision(first.project, RATE_24)).toBe(false);

    const second = addImportedVideo(first.project, {
      ref: "rushes/two.mp4",
      label: "Two",
      durationSec: 7,
      frameRate: RATE_24,
      mediaId: "media-two",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(second.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips.map((clip) => clip.timelineStartSec)).toEqual([0, 5]);
  });

  test("persists only bounded reference metadata and rejects bytes, URLs, raw paths, and traversal", () => {
    const imported = addImportedVideo(createEmptyProject(), {
      ref: "media/source.mp4",
      label: "Source",
      durationSec: 3,
      frameRate: { numerator: 30, denominator: 1 },
      mediaId: "media-source",
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const html = serializeVideoHtml(createDefaultManifest(), imported.project);
    expect(html).toContain('"ref": "media/source.mp4"');
    expect(html).not.toContain("data:video");
    expect(html).not.toContain("blob:");
    expect(parseVideoHtml(html)).toMatchObject({ ok: true });

    for (const ref of ["/Users/tester/source.mp4", "file:///tmp/source.mp4", "https://example.test/video.mp4", "../source.mp4", "media\\source.mp4"]) {
      expect(addImportedVideo(createEmptyProject(), {
        ref,
        label: "Bad ref",
        durationSec: 1,
        frameRate: { numerator: 30, denominator: 1 },
      })).toMatchObject({ ok: false });
    }
  });

  test("uses only an opaque persisted media id for durable Workspace preview after reopen", () => {
    const openedProject = createEmptyProject();
    openedProject.media.push({
      id: "media-generated-opening",
      kind: "video",
      ref: "generated/opening.mp4",
      lifecycle: "durable",
      source: {
        kind: "workspace-artifact",
        artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
        path: "generated/opening.mp4",
      },
      durationSec: 8,
    });

    const reloaded = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), openedProject));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    const workspaceAsset = reloaded.document.project.media[0]!;
    expect(videoPreviewRequestForAsset(workspaceAsset)).toEqual({ mediaId: "media-generated-opening" });
    expect(JSON.stringify(videoPreviewRequestForAsset(workspaceAsset))).not.toContain("artifactId");
    expect(JSON.stringify(videoPreviewRequestForAsset(workspaceAsset))).not.toContain("generated/opening.mp4");

    expect(videoPreviewRequestForAsset({
      id: "media-current-folder",
      ref: "rushes/opening.mp4",
      lifecycle: "local-working",
    })).toEqual({ ref: "rushes/opening.mp4" });
  });

  test("persists a Desktop Workspace import as public durable artifact lineage", () => {
    const imported = addImportedVideo(createEmptyProject(), {
      ref: "media/workspace-opening.mp4",
      label: "Workspace opening",
      durationSec: 4,
      frameRate: { numerator: 30, denominator: 1 },
      lifecycle: "durable",
      source: {
        kind: "workspace-artifact",
        artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
        path: "media/workspace-opening.mp4",
      },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const asset = imported.project.media[0]!;
    expect(asset).toMatchObject({ lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53" } });
    expect(videoPreviewRequestForAsset(asset)).toEqual({ mediaId: asset.id });
  });

  test("maps a promoted clip's timeline playhead into its retained source offset", () => {
    const clip = {
      timelineStartSec: 12,
      durationSec: 4,
      sourceInSec: 3,
      sourceOutSec: 7,
    };
    expect(videoPreviewSourceTime(clip, 10)).toBe(3);
    expect(videoPreviewSourceTime(clip, 13.5)).toBe(4.5);
    expect(videoPreviewSourceTime(clip, 20)).toBe(7);
  });
});

describe("mixed-media admission", () => {
  test("admits audio and images without an FPS decision or implicit timeline placement", () => {
    const empty = createEmptyProject();
    const audio = admitImportedMedia(empty, {
      mediaKind: "audio",
      ref: "audio/interview.wav",
      label: "Interview",
      durationSec: 42,
      mediaId: "media-interview",
    });
    expect(audio.ok).toBe(true);
    if (!audio.ok) return;
    expect(audio.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(audio.project.sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(0);
    expect(audio.project.media[0]).toMatchObject({ kind: "audio", durationSec: 42 });
    expect(audio.project.media[0]).not.toHaveProperty("frameRate");

    const image = admitImportedMedia(audio.project, {
      mediaKind: "image",
      ref: "stills/title.webp",
      label: "Title still",
      mediaId: "media-title",
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(image.project.media[1]).toMatchObject({ kind: "image", ref: "stills/title.webp" });
    expect(image.project.media[1]).not.toHaveProperty("durationSec");
    expect(image.project.media[1]).not.toHaveProperty("frameRate");
  });

  test("rejects missing or kind-inappropriate measured metadata", () => {
    const project = createEmptyProject();
    const admit = (input: Record<string, unknown>) => admitImportedMedia(project, input as never);
    expect(admit({ mediaKind: "audio", ref: "audio/a.mp3", label: "A" })).toMatchObject({ ok: false });
    expect(admit({ mediaKind: "audio", ref: "audio/a.mp3", label: "A", durationSec: 0 })).toMatchObject({ ok: false });
    expect(admit({ mediaKind: "audio", ref: "audio/a.mp3", label: "A", durationSec: 2, frameRate: RATE_24 })).toMatchObject({ ok: false });
    expect(admit({ mediaKind: "image", ref: "stills/a.png", label: "A", durationSec: 5 })).toMatchObject({ ok: false });
    expect(admit({ mediaKind: "video", ref: "video/a.mp4", label: "A", durationSec: 2 })).toMatchObject({ ok: false });
  });

  test("persists durable audio and places audio/image only through the compatibility compound command", () => {
    const audio = addImportedMedia(createEmptyProject(), {
      mediaKind: "audio",
      ref: "media/interview.mp3",
      label: "Interview",
      durationSec: 9,
      lifecycle: "durable",
      source: { kind: "workspace-artifact", artifactId: "artifact-audio", path: "media/interview.mp3" },
      mediaId: "media-audio",
      clipId: "clip-audio",
    });
    expect(audio.ok).toBe(true);
    if (!audio.ok) return;
    expect(audio.project.media[0]).toMatchObject({ kind: "audio", lifecycle: "durable", source: { artifactId: "artifact-audio" } });
    expect(audio.project.sequences[0]!.tracks.find((track) => track.kind === "audio")!.clips[0]).toMatchObject({ kind: "audio", durationSec: 9 });

    const image = addImportedMedia(audio.project, {
      mediaKind: "image",
      ref: "stills/cover.png",
      label: "Cover",
      mediaId: "media-image",
      clipId: "clip-image",
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.project.sequences[0]!.tracks.find((track) => track.kind === "video")!.clips[0]).toMatchObject({ kind: "image", durationSec: 5 });
    expect(image.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
  });
});
