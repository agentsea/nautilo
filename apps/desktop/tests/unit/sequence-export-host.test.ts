import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDefaultManifest, serializeVideoHtml } from "../../../../packages/first-party-apps/video/src/video-document";
import { createEmptyProject } from "../../../../packages/first-party-apps/video/src/edl";
import { exportCurrentFolderSequence } from "../../electron/sequence-export-host";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fsp.rm(value, { recursive: true, force: true }))); });
async function fixture(ref = "media/source.mp4", durable = false) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-export-host-")); roots.push(root);
  const documentPath = path.join(root, "project.video.html"); const sourcePath = path.join(root, ref);
  await fsp.mkdir(path.dirname(sourcePath), { recursive: true }); await fsp.writeFile(sourcePath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]));
  const project = createEmptyProject(); const track = project.sequences[0]!.tracks[0]!;
  project.media.push({ id: "media", kind: "video", ref, ...(durable ? { lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: "00000000-0000-4000-8000-000000000000", path: ref } } : {}) });
  track.clips.push({ id: "clip", trackId: track.id, kind: "video", mediaId: "media", timelineStartSec: 0, durationSec: 1, props: {} });
  const content = serializeVideoHtml(createDefaultManifest(), project); await fsp.writeFile(documentPath, content);
  return { root, documentPath, sourcePath, sha: createHash("sha256").update(content).digest("hex") };
}

describe("Current Folder sequence export host", () => {
  test("forwards the requested quality and rejects invalid settings before source work", async () => {
    const value = await fixture(); let probes = 0;
    const exportSettings = { resolution: "720p" as const, quality: "high" as const, audioBitrateKbps: 128 as const };
    const deps = { activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => path.join(value.root, "export.mp4"),
      probeSource: async () => { probes++; return { hasVideo: true, hasAudio: false }; },
      render: async (plan: Parameters<NonNullable<Parameters<typeof exportCurrentFolderSequence>[0]["render"]>>[0]) => {
        expect(plan).toMatchObject({ width: 1280, height: 720, exportSettings }); return { status: "cancelled" as const };
      } };
    expect(await exportCurrentFolderSequence({ ...deps, exportSettings })).toEqual({ status: "cancelled" });
    expect(probes).toBe(1);
    expect(await exportCurrentFolderSequence({ ...deps, exportSettings: { ...exportSettings, videoBitrateKbps: 42 } })).toEqual({ status: "failed", code: "invalid_settings" });
    expect(probes).toBe(1);
  });

  test("rereads the saved document, resolves its ref canonically, and moves the real rendered file to the chosen path", async () => {
    const value = await fixture("media/a b;$(x).mp4"); const underscored = path.join(value.root, "test_video.html"); await fsp.rename(value.documentPath, underscored); value.documentPath = underscored; const final = path.join(value.root, "chosen final.mp4"); let authorizedPath = "";
    const result = await exportCurrentFolderSequence({ ...value, activeRoot: value.root, expectedSha256: value.sha, ffmpegPath: "/managed/ffmpeg", chooseOutput: async () => final,
      probeSource: async (_ffmpeg, source) => (authorizedPath = source, { hasVideo: true, hasAudio: false }),
      render: async (_plan, deps) => { expect(deps.sources.get("media")?.canonicalPath).toBe(authorizedPath); expect(authorizedPath).not.toBe(await fsp.realpath(value.sourcePath)); expect(path.relative(value.root, deps.outputPath).startsWith("..")).toBe(false); await fsp.writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
    });
    expect(result).toEqual({ status: "succeeded", label: "chosen final.mp4", sizeBytes: 8, warnings: [] });
    expect(await fsp.access(authorizedPath).then(() => true, () => false)).toBe(false); expect(await fsp.readFile(final, "utf8")).toBe("rendered");
  });

  test("refuses changed documents and Workspace-backed media before rendering", async () => {
    // These are admission failures, so keep the fixture entirely document-only:
    // no media file or FFmpeg probe is needed to prove either fence.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-export-host-")); roots.push(root);
    const makeDocument = (durable: boolean) => {
      const project = createEmptyProject(); const track = project.sequences[0]!.tracks[0]!; const ref = "workspace/source.mp4";
      project.media.push({ id: "media", kind: "video", ref, ...(durable ? { lifecycle: "durable", source: { kind: "workspace-artifact", artifactId: "00000000-0000-4000-8000-000000000000", path: ref } } : {}) });
      track.clips.push({ id: "clip", trackId: track.id, kind: "video", mediaId: "media", timelineStartSec: 0, durationSec: 1, props: {} });
      return serializeVideoHtml(createDefaultManifest(), project);
    };
    const changedPath = path.join(root, "changed.video.html"); const changedContent = makeDocument(false);
    const workspacePath = path.join(root, "workspace.video.html"); const workspaceContent = makeDocument(true);
    await Promise.all([fsp.writeFile(changedPath, `${changedContent}changed`), fsp.writeFile(workspacePath, workspaceContent)]);
    let renders = 0;
    expect(await exportCurrentFolderSequence({ activeRoot: root, documentPath: changedPath, expectedSha256: createHash("sha256").update(changedContent).digest("hex"), ffmpegPath: "/ffmpeg", chooseOutput: async () => "never", render: (async () => (renders++, { status: "cancelled" })) as never })).toEqual({ status: "failed", code: "document_changed" });
    expect(await exportCurrentFolderSequence({ activeRoot: root, documentPath: workspacePath, expectedSha256: createHash("sha256").update(workspaceContent).digest("hex"), ffmpegPath: "/ffmpeg", chooseOutput: async () => "never" })).toEqual({ status: "failed", code: "workspace_media_unsupported" });
    expect(renders).toBe(0);
  });

  test("rejects arbitrary HTML natively even when the first-party bridge selected the file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-export-host-")); roots.push(root); const documentPath = path.join(root, "test_video.html"); const content = "<html><body>not a Video document</body></html>"; await fsp.writeFile(documentPath, content);
    expect(await exportCurrentFolderSequence({ activeRoot: root, documentPath, expectedSha256: createHash("sha256").update(content).digest("hex"), ffmpegPath: "/ffmpeg", chooseOutput: async () => path.join(root, "out.mp4") })).toEqual({ status: "failed", code: "invalid_document" });
  });

  test("cancellation never moves a partial render to the selected destination", async () => {
    const value = await fixture(); const final = path.join(value.root, "must-not-exist.mp4"); const controller = new AbortController(); let snapshot = "";
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final, signal: controller.signal,
      probeSource: async (_ffmpeg, source) => (snapshot = source, { hasVideo: true, hasAudio: false }), render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "partial"); controller.abort(); return { status: "cancelled" }; },
    });
    expect(result).toEqual({ status: "cancelled" }); expect(await fsp.access(final).then(() => true, () => false)).toBe(false); expect(await fsp.access(snapshot).then(() => true, () => false)).toBe(false);
  });

  test("renders the immutable media snapshot when the original changes after probing", async () => {
    const value = await fixture();
    const originalBytes = await fsp.readFile(value.sourcePath);
    const final = path.join(value.root, "snapshot.mp4");
    let snapshotPath = "";
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final,
      probeSource: async (_ffmpeg, source) => { snapshotPath = source; await fsp.writeFile(value.sourcePath, "replacement media"); return { hasVideo: true, hasAudio: false }; },
      render: async (_plan, deps) => {
        expect(await fsp.readFile(deps.sources.get("media")!.canonicalPath)).toEqual(originalBytes);
        await fsp.writeFile(deps.outputPath, "rendered snapshot");
        return { status: "succeeded", sizeBytes: 17, warnings: [] };
      },
    });
    expect(result).toEqual({ status: "succeeded", label: "snapshot.mp4", sizeBytes: 17, warnings: [] });
    expect(await fsp.readFile(value.sourcePath, "utf8")).toBe("replacement media");
    expect(await fsp.access(snapshotPath).then(() => true, () => false)).toBe(false);
  });

  test("exclusive link completion is the publication commit point for a late cancellation", async () => {
    const value = await fixture(); const final = path.join(value.root, "late-cancel.mp4"); const controller = new AbortController(); let release!: () => void; let entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const linkEntered = new Promise<void>((resolve) => { entered = resolve; });
    const pending = exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final, signal: controller.signal,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }), render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
      link: async (source, destination) => { entered(); await gate; await fsp.link(source, destination); },
    });
    await linkEntered; controller.abort(); release();
    expect(await pending).toEqual({ status: "succeeded", label: "late-cancel.mp4", sizeBytes: 8, warnings: [] }); expect(await fsp.readFile(final, "utf8")).toBe("rendered");
  });

  test("cancellation at the saving notification still prevents publication", async () => {
    const value = await fixture(); const final = path.join(value.root, "cancelled-save.mp4"); const controller = new AbortController();
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final, signal: controller.signal,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }),
      render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
      onProgress: (progress) => { if (progress.stage === "saving") controller.abort(); },
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(await fsp.access(final).then(() => true, () => false)).toBe(false);
  });

  test("a path change after successful publication cannot turn a completed export into failure", async () => {
    const value = await fixture(); const final = path.join(value.root, "moved-after-save.mp4"); const moved = path.join(value.root, "moved.mp4");
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }),
      render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
      link: async (source, destination) => { await fsp.link(source, destination); await fsp.rename(destination, moved); },
    });
    expect(result).toEqual({ status: "succeeded", label: "moved-after-save.mp4", sizeBytes: 8, warnings: [] });
    expect(await fsp.readFile(moved, "utf8")).toBe("rendered");
  });

  test("exports the immutable saved snapshot even if later edits arrive during rendering", async () => {
    const value = await fixture(); const final = path.join(value.root, "stale.mp4");
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }), render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "stale"); await fsp.appendFile(value.documentPath, "new edit"); return { status: "succeeded", sizeBytes: 5, warnings: [] }; },
    });
    expect(result).toEqual({ status: "succeeded", label: "stale.mp4", sizeBytes: 5, warnings: [] });
    expect(await fsp.readFile(final, "utf8")).toBe("stale");
  });

  test("exclusive publication refuses a destination created after the save choice", async () => {
    const value = await fixture(); const final = path.join(value.root, "claimed.mp4");
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }), render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "rendered"); await fsp.writeFile(final, "other process"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
    });
    expect(result).toEqual({ status: "failed", code: "destination_exists" });
    expect(await fsp.readFile(final, "utf8")).toBe("other process");
  });

  test("reports filesystems without exclusive-link publication explicitly", async () => {
    const value = await fixture(); const final = path.join(value.root, "external.mp4");
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => final,
      probeSource: async () => ({ hasVideo: true, hasAudio: false }), render: async (_plan, deps) => { await fsp.writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
      link: async () => { throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" }); },
    });
    expect(result).toEqual({ status: "failed", code: "destination_filesystem_unsupported" }); expect(await fsp.access(final).then(() => true, () => false)).toBe(false);
  });

  test("refuses a non-MP4 save choice without rewriting it", async () => {
    const value = await fixture(); const chosen = path.join(value.root, "chosen-name"); let rendered = false;
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => chosen, probeSource: async () => ({ hasVideo: true, hasAudio: false }), render: (async () => (rendered = true, { status: "cancelled" })) as never });
    expect(result).toEqual({ status: "failed", code: "destination_must_be_mp4" }); expect(rendered).toBe(false); expect(await fsp.access(chosen).then(() => true, () => false)).toBe(false);
  });

  test("rejects playlist-like local refs before FFmpeg can follow nested inputs", async () => {
    const value = await fixture("media/source.m3u8"); await fsp.writeFile(value.sourcePath, "#EXTM3U\n#EXTINF:1\nhttps://example.test/private.mp4\n"); let probed = false;
    const result = await exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: "/ffmpeg", chooseOutput: async () => path.join(value.root, "out.mp4"), probeSource: async () => (probed = true, { hasVideo: true, hasAudio: false }) });
    expect(result).toEqual({ status: "failed", code: "unsupported_source_format" }); expect(probed).toBe(false);
  });

  test("cancellation owns and terminates the FFmpeg metadata probe", async () => {
    const value = await fixture(); const fake = path.join(value.root, "fake-ffmpeg"); const started = path.join(value.root, "started");
    await fsp.writeFile(fake, `#!/usr/bin/env node\nconst fs=require("fs");const path=require("path");fs.writeFileSync(path.join(__dirname,"started"),String(process.pid));setInterval(()=>{},1000);\n`); await fsp.chmod(fake, 0o755);
    const controller = new AbortController();
    const pending = exportCurrentFolderSequence({ activeRoot: value.root, documentPath: value.documentPath, expectedSha256: value.sha, ffmpegPath: fake, chooseOutput: async () => path.join(value.root, "out.mp4"), signal: controller.signal });
    for (let attempts = 0; attempts < 1_000 && !await fsp.access(started).then(() => true, () => false); attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fsp.access(started).then(() => true, () => false)).toBe(true);
    const pid = Number(await fsp.readFile(started, "utf8")); controller.abort(); expect(await pending).toEqual({ status: "cancelled" });
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let attempts = 0; attempts < 1_000 && alive(); attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(alive()).toBe(false);
  }, 30_000);
});
