import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDefaultManifest, serializeVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { createEmptyProject } from "../../../../packages/first-party-apps/video/src/edl";
import { exportWorkspaceSequence, type WorkspaceSequenceSourceBinding } from "../../electron/workspace-sequence-export";
import { testFfmpegPath, testH264EncoderArgs } from "../helpers/test-ffmpeg";

const roots: string[] = [];
const exec = promisify(execFile);
const ffmpeg = testFfmpegPath();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))); });
const roomId = "123e4567-e89b-42d3-a456-426614174000";
const source: WorkspaceSequenceSourceBinding = {
  mediaId: "media", artifactRowId: "123e4567-e89b-42d3-a456-426614174001", artifactId: "123e4567-e89b-42d3-a456-426614174002",
  path: "video-imports/source.mp4", mimeType: "video/mp4", sizeBytes: 24,
};
const mediaBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
function document(overrides: Partial<WorkspaceSequenceSourceBinding> = {}, kind: "video" | "audio" = "video") {
  const bound = { ...source, ...overrides };
  const project = createEmptyProject(); const track = project.sequences[0]!.tracks[0]!;
  project.media.push({ id: "media", kind, ref: bound.path, lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: bound.artifactId, path: bound.path } });
  track.clips.push({ id: "clip", trackId: track.id, kind, mediaId: "media", timelineStartSec: 0, durationSec: 1, props: {} });
  const content = serializeVideoHtml(createDefaultManifest(), project);
  return { content, sha: createHash("sha256").update(content).digest("hex") };
}
function response(chunks: Uint8Array[], headers: Record<string, string> = { "content-type": "video/mp4", "content-length": "24" }) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { status: 200, headers });
}
async function sourceRoot() { const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workspace-export-test-")); roots.push(root); return root; }
const inspected = async () => ({ mediaKind: "video" as const, mimeType: "video/mp4" as const, extension: "mp4" as const, durationSec: 1, frameRate: { numerator: 30, denominator: 1 } });
const probed = async () => ({ hasVideo: true, hasAudio: false });

describe("Workspace sequence export", () => {
  test("forwards export settings and rejects malformed settings before fetching media", async () => {
    const doc = document(); let fetches = 0;
    const exportSettings = { resolution: "4k" as const, quality: "custom" as const, videoBitrateKbps: 18000, audioBitrateKbps: 320 as const };
    const deps = { ffmpegPath: "/managed/ffmpeg", fetchSource: async () => { fetches++; return response([mediaBytes]); }, chooseOutput: async () => "/chosen.mp4",
      inspectSource: inspected, probeSource: probed, makeSourceTempDir: sourceRoot,
      publish: async (input: Parameters<NonNullable<Parameters<typeof exportWorkspaceSequence>[1]["publish"]>>[0]) => {
        expect(input.plan).toMatchObject({ width: 3840, height: 2160, exportSettings });
        return { status: "cancelled" as const };
      } };
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source], exportSettings }, deps)).toEqual({ status: "cancelled" });
    expect(fetches).toBe(1);
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source], exportSettings: { ...exportSettings, videoBitrateKbps: -1 } }, deps)).toEqual({ status: "failed", code: "invalid_settings" });
    expect(fetches).toBe(1);
  });

  test("streams an exact durable source into a private snapshot and publishes through the shared renderer", async () => {
    const doc = document(); let snapshot = ""; let removed = "";
    const result = await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
      ffmpegPath: "/managed/ffmpeg", fetchSource: async () => response([mediaBytes.subarray(0, 7), mediaBytes.subarray(7)]), chooseOutput: async () => "/chosen.mp4",
      inspectSource: inspected, probeSource: probed, makeSourceTempDir: sourceRoot, removeSourceTempDir: async (root) => { removed = root; await fsp.rm(root, { recursive: true, force: true }); },
      publish: async (deps) => { snapshot = deps.sources.get("media")!.canonicalPath; expect(await fsp.readFile(snapshot)).toEqual(mediaBytes); expect(deps.suggestedName).toBe("video.mp4"); return { status: "succeeded", label: "chosen.mp4", sizeBytes: 99, warnings: [] }; },
    });
    expect(result).toEqual({ status: "succeeded", label: "chosen.mp4", sizeBytes: 99, warnings: [] });
    expect(snapshot.startsWith(removed)).toBe(true); expect(await fsp.access(snapshot).then(() => true, () => false)).toBe(false);
  });

  test("exports audio-only MP4 with a video/mp4 transport label without weakening stream checks", async () => {
    const doc = document({}, "audio");
    for (const actualKind of ["audio", "video"] as const) {
      let published = false;
      const result = await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
        ffmpegPath: "/ffmpeg", fetchSource: async () => response([mediaBytes]), chooseOutput: async () => "/audio.mp4",
        inspectSource: async () => actualKind === "audio" ? { mediaKind: "audio", mimeType: "audio/mp4", extension: "m4a", durationSec: 1 } : inspected(),
        probeSource: async () => ({ hasVideo: false, hasAudio: true }), makeSourceTempDir: sourceRoot,
        publish: async () => { published = true; return { status: "succeeded", label: "audio.mp4", sizeBytes: 99, warnings: [] }; },
      });
      expect(published).toBe(actualKind === "audio");
      expect(result.status).toBe(actualKind === "audio" ? "succeeded" : "failed");
    }
  });

  test("rejects truncated, oversized, redirected, and wrong-MIME responses without publishing", async () => {
    const doc = document(); let publishes = 0;
    const redirected = response([mediaBytes]); Object.defineProperty(redirected, "redirected", { value: true });
    const cases = [response([mediaBytes.subarray(0, 10)]), response([Buffer.concat([mediaBytes, Buffer.from([1])])]), redirected,
      response([mediaBytes], { "content-type": "audio/mp4", "content-length": "24" })];
    for (const candidate of cases) {
      const result = await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
        ffmpegPath: "/ffmpeg", fetchSource: async () => candidate, chooseOutput: async () => "/never.mp4", inspectSource: inspected, probeSource: probed,
        makeSourceTempDir: sourceRoot, publish: async () => (publishes++, { status: "cancelled" }),
      });
      expect(result).toEqual({ status: "failed", code: "source_unavailable" });
    }
    expect(publishes).toBe(0);
  });

  test("fails closed on changed documents, local-working media, missing/duplicate bindings, and provenance mismatch", async () => {
    const doc = document(); const base = { ffmpegPath: "/ffmpeg", fetchSource: async () => response([mediaBytes]), chooseOutput: async () => "/never.mp4", inspectSource: inspected, probeSource: probed };
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: "a".repeat(64), roomId, sources: [source] }, base)).toEqual({ status: "failed", code: "document_changed" });
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [] }, base)).toEqual({ status: "failed", code: "invalid_source_binding" });
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source, source] }, base)).toEqual({ status: "failed", code: "invalid_source_binding" });
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [{ ...source, artifactId: "123e4567-e89b-42d3-a456-426614174099" }] }, base)).toEqual({ status: "failed", code: "invalid_source_binding" });
    const local = createEmptyProject(); const track = local.sequences[0]!.tracks[0]!; local.media.push({ id: "media", kind: "video", ref: source.path }); track.clips.push({ id: "clip", trackId: track.id, kind: "video", mediaId: "media", timelineStartSec: 0, durationSec: 1, props: {} });
    const localContent = serializeVideoHtml(createDefaultManifest(), local);
    expect(await exportWorkspaceSequence({ documentContent: localContent, expectedSha256: createHash("sha256").update(localContent).digest("hex"), roomId, sources: [source] }, base)).toEqual({ status: "failed", code: "invalid_source_binding" });
  });

  test("abort cancels the response stream, removes the partial snapshot, and never publishes", async () => {
    const doc = document(); const controller = new AbortController(); let cancelled = false; let partialRoot = "";
    let fetched!: () => void;
    const responseOwned = new Promise<void>((resolve) => { fetched = resolve; });
    const pendingResponse = new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(mediaBytes.subarray(0, 8)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4", "content-length": "24" } });
    const pending = exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
      ffmpegPath: "/ffmpeg", fetchSource: async () => { fetched(); return pendingResponse; }, chooseOutput: async () => "/never.mp4", signal: controller.signal,
      inspectSource: inspected, probeSource: probed, makeSourceTempDir: async () => (partialRoot = await sourceRoot()), publish: async () => { throw new Error("must not publish"); },
    });
    await responseOwned; controller.abort();
    expect(await pending).toEqual({ status: "cancelled" }); expect(cancelled).toBe(true);
    expect(await fsp.access(partialRoot).then(() => true, () => false)).toBe(false);
  });

  test("validates declared completeness and rejects media shortened since admission", async () => {
    const doc = document();
    for (const length of ["23", "twenty-four", "9007199254740992"]) {
      expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
        ffmpegPath: "/ffmpeg", fetchSource: async () => response([mediaBytes], { "content-type": "video/mp4", "content-length": length }),
        chooseOutput: async () => { throw new Error("must not publish"); }, inspectSource: inspected, probeSource: probed,
      })).toEqual({ status: "failed", code: "source_unavailable" });
    }
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
      ffmpegPath: "/ffmpeg", fetchSource: async () => response([mediaBytes]), chooseOutput: async () => { throw new Error("must not publish"); },
      inspectSource: async () => ({ ...await inspected(), durationSec: 0.5 }), probeSource: probed,
    })).toEqual({ status: "failed", code: "source_changed" });
  });

  test("authority drift after download prevents the save dialog and cleans its snapshot", async () => {
    const doc = document(); let current = true; let root = "";
    expect(await exportWorkspaceSequence({ documentContent: doc.content, expectedSha256: doc.sha, roomId, sources: [source] }, {
      ffmpegPath: "/ffmpeg", isAuthorityCurrent: () => current,
      fetchSource: async () => { current = false; return response([mediaBytes]); },
      chooseOutput: async () => { throw new Error("must not publish"); }, inspectSource: inspected, probeSource: probed,
      makeSourceTempDir: async () => (root = await sourceRoot()),
    })).toEqual({ status: "cancelled" });
    expect(await fsp.access(root).then(() => true, () => false)).toBe(false);
  });

  test("downloads real Workspace media, renders the source trim, and exclusively saves a playable MP4", async () => {
    const root = await sourceRoot();
    const original = path.join(root, "input.mp4"); const output = path.join(root, "cut.mp4");
    await exec(ffmpeg, ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=0.3", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=0.3", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", ...testH264EncoderArgs, "-pix_fmt", "yuv420p", original]);
    const project = createEmptyProject(); const track = project.sequences[0]!.tracks[0]!;
    project.media.push({ id: "media", kind: "video", ref: source.path, durationSec: 0.6, lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: source.artifactId, path: source.path } });
    track.clips.push({ id: "clip", trackId: track.id, kind: "video", mediaId: "media", timelineStartSec: 0, sourceInSec: 0.3, durationSec: 0.2, props: { muted: true } });
    project.sequences[0]!.durationSec = 0.2;
    const content = serializeVideoHtml(createDefaultManifest(), project);
    const bound = { ...source, sizeBytes: (await fsp.stat(original)).size };
    const progress: string[] = []; let snapshotRoot = "";
    const result = await exportWorkspaceSequence({ documentContent: content, expectedSha256: createHash("sha256").update(content).digest("hex"), roomId, sources: [bound] }, {
      ffmpegPath: ffmpeg,
      fetchSource: async () => new Response(Readable.toWeb(createReadStream(original)) as ReadableStream<Uint8Array>, { headers: { "content-type": "video/mp4", "content-length": String(bound.sizeBytes) } }),
      chooseOutput: async () => output,
      makeSourceTempDir: async () => (snapshotRoot = await sourceRoot()),
      onProgress: (event) => progress.push(event.stage),
    });
    expect(result).toMatchObject({ status: "succeeded", label: "cut.mp4", warnings: [] });
    expect(progress).toContain("preparing"); expect(progress).toContain("rendering"); expect(progress).toContain("saving");
    const decoded = await exec(ffmpeg, ["-hide_banner", "-i", output, "-f", "null", "-"]);
    expect(decoded.stderr).toMatch(/Duration:\s*00:00:00\.20/u);
    const pixelResult = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-frames:v", "1", "-vf", "format=rgb24,crop=1:1:20:20", "-f", "rawvideo", "pipe:1"]);
    expect(pixelResult.status).toBe(0);
    const pixel = pixelResult.stdout as Buffer;
    expect(pixel[2]!).toBeGreaterThan(pixel[0]! + 80);
    expect(await fsp.access(snapshotRoot).then(() => true, () => false)).toBe(false);
  }, 30_000);
});
