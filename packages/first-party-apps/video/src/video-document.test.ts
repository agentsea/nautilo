import { describe, expect, test } from "bun:test";
import {
  createDefaultManifest,
  createEmptyVideoHtml,
  parseVideoHtml,
  serializeVideoHtml,
  NAUTILO_DOCUMENT_MANIFEST_TYPE,
  NAUTILO_VIDEO_EDL_TYPE,
} from "./video-document";
import {
  createEmptyProject,
  createDefaultSequence,
  type Clip,
  type VideoManifest,
} from "./edl";
import { appendGenerationShot, createEmptyGenerationBrief, deleteGenerationDirectionBlock, effectiveGenerationDirectionBlocks, materializeGenerationDirectionBlocks, updateGenerationBrief } from "./generation-brief";
import type { GeneratedTake } from "./generation-takes";

function sampleGeneratedTake(): GeneratedTake {
  return {
    id: "take_abcdefghijklmnop",
    briefRevision: 4,
    shotId: "shot-opening",
    shotLabel: "Opening move",
    mediaKind: "video",
    modelId: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    artifact: {
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "generated-media/take-opening.mp4",
      zone: "workspace",
      mime: "video/mp4",
      bytes: 1_024,
    },
  };
}

function sampleClip(overrides: Partial<Clip> & Pick<Clip, "id">): Clip {
  return {
    kind: "video",
    trackId: "track-video",
    timelineStartSec: 0,
    durationSec: 2,
    props: {},
    ...overrides,
  } as Clip;
}

function sampleProjectHtml(): string {
  const project = createEmptyProject();
  const seq = project.sequences[0]!;
  const videoTrack = seq.tracks.find((t) => t.kind === "video")!;
  videoTrack.clips.push(sampleClip({ id: "clip-1", timelineStartSec: 0, durationSec: 4 }));
  const captionTrack = seq.tracks.find((t) => t.kind === "caption")!;
  captionTrack.clips.push({
    kind: "caption",
    id: "caption-1",
    trackId: captionTrack.id,
    timelineStartSec: 0,
    durationSec: 2,
    props: { text: "Welcome" },
  });
  project.media.push({ id: "media-1", kind: "video", ref: "assets/intro.mp4", durationSec: 4, label: "Intro" });
  return serializeVideoHtml(createDefaultManifest(), project);
}

describe("video-document parse/serialize", () => {
  test("createEmptyVideoHtml round-trips through parseVideoHtml", () => {
    const html = createEmptyVideoHtml();
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.manifest.documentType).toBe("video");
    expect(parsed.document.manifest.editor).toBe("nautilo-video");
    expect(parsed.document.manifest.payloadFormat).toBe(NAUTILO_VIDEO_EDL_TYPE);
    expect(parsed.document.project.version).toBe(1);
    expect(parsed.document.project.sequences).toHaveLength(1);
    expect(parsed.document.project.sequences[0]!.tracks).toHaveLength(5);
    expect(parsed.document.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
  });

  test("sample project round-trips and preserves clips/media", () => {
    const html = sampleProjectHtml();
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const seq = parsed.document.project.sequences[0]!;
    const videoTrack = seq.tracks.find((t) => t.kind === "video")!;
    expect(videoTrack.clips).toHaveLength(1);
    expect(videoTrack.clips[0]).toMatchObject({ id: "clip-1", durationSec: 4 });
    const captionTrack = seq.tracks.find((t) => t.kind === "caption")!;
    expect(captionTrack.clips[0]!.props).toEqual({ text: "Welcome" });
    expect(parsed.document.project.media).toHaveLength(1);
    expect(parsed.document.project.media[0]).toMatchObject({ id: "media-1", ref: "assets/intro.mp4" });
  });

  test("round-trips an optional canonical generation brief while legacy projects remain valid", () => {
    const project = createEmptyProject();
    project.generationBrief = appendGenerationShot(
      { ...createEmptyGenerationBrief(), goal: "Create a calm opening." },
      { title: "Opening", description: "A slow walk through morning light." },
      () => "shot-opening",
    );
    const parsed = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), project));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.project.generationBrief).toMatchObject({
      version: 1,
      goal: "Create a calm opening.",
      shots: [{ id: "shot-opening", title: "Opening" }],
    });
  });

  test("does not resurrect deleted materialized legacy direction after serialize and parse", () => {
    const legacy = updateGenerationBrief(createEmptyGenerationBrief(), {
      quickBrief: "Legacy quick brief",
      goal: "Legacy goal",
      references: [{ id: "ref-legacy", name: "Legacy reference" }],
      continuity: "Legacy continuity",
      audio: "Legacy audio",
      exclusions: "Legacy exclusions",
    });
    const materialized = materializeGenerationDirectionBlocks(legacy);
    const withoutReferences = deleteGenerationDirectionBlock(materialized, "legacy-references");
    const withoutGoal = deleteGenerationDirectionBlock(withoutReferences, "legacy-goal");
    const withoutGlobal = ["legacy-continuity", "legacy-audio", "legacy-exclusions"].reduce((brief, id) => deleteGenerationDirectionBlock(brief, id), withoutGoal);
    const project = { ...createEmptyProject(), generationBrief: withoutGlobal };
    const parsed = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), project));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(effectiveGenerationDirectionBlocks(parsed.document.project.generationBrief!)).toEqual([]);
    expect(parsed.document.project.generationBrief).toMatchObject({ quickBrief: "", goal: "", references: [], continuity: "", audio: "", exclusions: "", blocks: [] });
  });

  test("round-trips safe completed take lineage and a durable Workspace artifact media source", () => {
    const take = sampleGeneratedTake();
    const project = createEmptyProject();
    project.generatedTakes = [take];
    project.media.push({
      id: "media-generated-opening",
      kind: "video",
      ref: take.artifact.path,
      lifecycle: "durable",
      source: { kind: "workspace-artifact", artifactId: take.artifact.artifactId, path: take.artifact.path },
      ...(take.settings.durationSeconds === undefined ? {} : { durationSec: take.settings.durationSeconds }),
      ...(take.shotLabel === undefined ? {} : { label: take.shotLabel }),
    });
    const parsed = parseVideoHtml(serializeVideoHtml(createDefaultManifest(), project));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.project.generatedTakes).toEqual([take]);
    expect(parsed.document.project.media[0]?.source).toEqual({
      kind: "workspace-artifact",
      artifactId: take.artifact.artifactId,
      path: take.artifact.path,
    });
  });

  test("rejects unsafe generated take fields and durable source mismatch", () => {
    const take = { ...sampleGeneratedTake(), receiptId: "mg_abcdefghijklmnop" };
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(project)}</script>
    </head><body></body></html>`;
    expect(parseVideoHtml(html)).toMatchObject({ ok: false });

    const mismatchedSource = {
      ...createEmptyProject(),
      media: [{
        id: "media-1",
        kind: "video",
        ref: "generated-media/one.mp4",
        lifecycle: "durable",
        source: {
          kind: "workspace-artifact",
          artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
          path: "generated-media/two.mp4",
        },
      }],
    };
    const mismatchedHtml = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(mismatchedSource)}</script>
    </head><body></body></html>`;
    expect(parseVideoHtml(mismatchedHtml)).toMatchObject({ ok: false });
  });

  test("rejects malformed generation brief payloads without changing legacy absence semantics", () => {
    const project = { ...createEmptyProject(), generationBrief: { version: 1, quickBrief: "", goal: "", references: [], continuity: "", shots: [], audio: "", exclusions: "", extra: true } };
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(project)}</script>
    </head><body></body></html>`;
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("generationBrief.extra is not supported");
  });

  test("round-trips real project content above the removed 200 KiB quota", () => {
    const project = createEmptyProject();
    const text = "Large project caption. ".repeat(12000);
    const track = project.sequences[0]!.tracks[0]!;
    track.clips = [{ id: "long-caption", trackId: track.id, kind: "caption", timelineStartSec: 0, durationSec: 3, props: { text } }];
    const html = serializeVideoHtml(createDefaultManifest(), project);
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(200 * 1024);
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.project.sequences[0]!.tracks[0]!.clips[0]!.props["text"]).toBe(text);
  });

  test("rejects executable script tags", () => {
    const html = createEmptyVideoHtml().replace(
      "</head>",
      `<script type="text/javascript">window.pwn=function(){return 1}</script></head>`,
    );
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("executable");
  });

  test("rejects module script tags", () => {
    const html = createEmptyVideoHtml().replace(
      "</head>",
      `<script type="module">import "x"</script></head>`,
    );
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("executable");
  });

  test("rejects missing payload block", () => {
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
    </head><body></body></html>`;
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("nautilo-video-edl");
  });

  test("rejects invalid payload (wrong version)", () => {
    const manifest: VideoManifest = createDefaultManifest();
    const badProject = { ...createEmptyProject(), version: 999 };
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(manifest)}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(badProject)}</script>
    </head><body></body></html>`;
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("version");
  });

  test("upgrades a legacy seconds-only sequence to the explicit 30/1 frame rate without mutating the input", () => {
    const legacy = createEmptyProject();
    const sequence = legacy.sequences[0]!;
    const { frameRate: _frameRate, ...legacySequence } = sequence;
    const legacyPayload = { ...legacy, sequences: [legacySequence] };
    const before = JSON.stringify(legacyPayload);
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(legacyPayload)}</script>
    </head><body></body></html>`;

    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.project.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(JSON.stringify(legacyPayload)).toBe(before);
  });

  test("rejects non-integer rational frame-rate components", () => {
    const project = createEmptyProject();
    project.sequences[0]!.frameRate = { numerator: 30.5, denominator: 1 };
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(project)}</script>
    </head><body></body></html>`;
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("frameRate");
  });

  test("round-trips video on a lane with a legacy audio role", () => {
    const project = createEmptyProject();
    const seq = project.sequences[0]!;
    const audioTrack = seq.tracks.find((t) => t.id === "track-voice")!;
    audioTrack.clips.push({
      kind: "video",
      id: "bad",
      trackId: audioTrack.id,
      timelineStartSec: 0,
      durationSec: 1,
      props: {},
    });
    // Existing role labels do not limit the clip types a lane can hold.
    const html = `<!DOCTYPE html><html><head>
      <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
      <script type="${NAUTILO_VIDEO_EDL_TYPE}" id="nautilo-video-edl">${JSON.stringify(project)}</script>
    </head><body></body></html>`;
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    expect(parseVideoHtml(serializeVideoHtml(createDefaultManifest(), project)).ok).toBe(true);
  });

  test("template (empty-video.html fixture) parses", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const html = await readFile(join(import.meta.dirname, "..", "templates", "empty-video.html"), "utf8");
    const parsed = parseVideoHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const seq = parsed.document.project.sequences[0]!;
    const trackKinds = seq.tracks.map((t) => t.kind);
    expect(trackKinds).toEqual(["video", "overlay", "caption", "audio", "music"]);
  });
});

describe("createDefaultSequence", () => {
  test("has the standard V1 track roster", () => {
    const seq = createDefaultSequence();
    expect(seq.id).toBe("sequence-1");
    expect(seq.tracks.map((t) => t.kind)).toEqual(["video", "overlay", "caption", "audio", "music"]);
  });
});
