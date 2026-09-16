import { describe, expect, test } from "bun:test";
import {
  addClip,
  addOverlay,
  createFile,
  deleteClip,
  detachAudio,
  exportVideo,
  inspectTimeline,
  moveClip,
  renderPreview,
  replaceCaptionText,
  splitClip,
  trimClip,
  validateAppDocumentTarget,
  validateBasenameFilename,
  type AgentToolContext,
  type AppDocumentTarget,
  type ServerNautiloAppHost,
} from "./agent-tool-handlers";
import { createEmptyVideoHtml } from "./video-document";

function mockHost(overrides?: Partial<ServerNautiloAppHost["document"]>): ServerNautiloAppHost {
  let content = createEmptyVideoHtml();
  let baseSha256: string | null = "abc123";
  let baseRevision: number | null = 1;
  const document: ServerNautiloAppHost["document"] = {
    async createFromAction(actionId, opts) {
      expect(actionId).toBe("new-video");
      const target: AppDocumentTarget =
        opts.targetSurface === "workspace"
          ? { surface: "workspace", path: opts.filename }
          : { surface: "currentFolder", relativePath: opts.filename };
      return {
        target,
        displayPath: opts.targetSurface === "workspace" ? `workspace:${opts.filename}` : opts.filename,
        opened: opts.openAfterCreate ?? false,
      };
    },
    async read(target) {
      return {
        content,
        mimeType: "text/html",
        displayPath: target.surface === "workspace" ? `workspace:${target.path}` : target.relativePath,
        baseSha256,
        baseRevision,
      };
    },
    async write(_target, next, opts) {
      if (opts?.baseSha256 !== undefined && opts.baseSha256 !== baseSha256) {
        return { kind: "conflict" as const, currentSha256: "newer-hash" };
      }
      content = next.content;
      baseSha256 = "saved-hash";
      baseRevision = 2;
      return { kind: "saved" as const, sha256: "saved-hash", revision: 2 };
    },
    ...overrides,
  };
  return { document };
}

const WORKSPACE_TARGET = { surface: "workspace", path: "Launch demo.html" } as const;

describe("agent-tool-handlers", () => {
  test("validateBasenameFilename rejects unsafe names", () => {
    expect(validateBasenameFilename("Launch demo.html")).toBeNull();
    expect(validateBasenameFilename("../evil.html")).toContain("basename");
    expect(validateBasenameFilename("")).toContain("non-empty");
  });

  test("validateAppDocumentTarget rejects unsafe relativePath", () => {
    expect(validateAppDocumentTarget({ surface: "currentFolder", relativePath: "../x" }).ok).toBe(false);
    expect(validateAppDocumentTarget({ surface: "workspace", path: "x.html" })).toEqual({
      ok: true,
      target: { surface: "workspace", path: "x.html" },
    });
  });

  test("createFile validates filename and calls createFromAction('new-video')", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await createFile(
      { targetSurface: "workspace", filename: "Launch demo.html", openAfterCreate: true },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      displayPath: "workspace:Launch demo.html",
      target: { surface: "workspace", path: "Launch demo.html" },
      opened: true,
    });
  });

  test("createFile rejects bad surface", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await createFile(
      { targetSurface: "bogus", filename: "x.html" } as unknown as Parameters<typeof createFile>[0],
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("inspectTimeline returns bounded summary without raw HTML", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await inspectTimeline({ target: WORKSPACE_TARGET }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequenceId).toBe("sequence-1");
    expect(result.trackCount).toBe(5);
    expect(result.clipCount).toBe(0);
    expect(result.tracks.map((t) => t.kind)).toEqual(["caption", "overlay", "video", "audio", "music"]);
    expect(JSON.stringify(result)).not.toContain("<!DOCTYPE html>");
    expect(JSON.stringify(result)).not.toContain("nautilo-video-edl");
  });

  // ---- addClip (real) ----

  test("addClip happy path saves and returns sha256", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addClip(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-video",
        clip: { kind: "video", mediaId: "media-1", timelineStartSec: 0, durationSec: 4 },
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      status: "saved",
      displayPath: "workspace:Launch demo.html",
      sha256: "saved-hash",
      revision: 2,
    });
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!inspect.ok) throw new Error("inspect failed");
    expect(inspect.clipCount).toBe(1);
    expect(inspect.clips?.[0]?.kind).toBe("video");
  });

  test("addClip rejects invalid target before any read", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addClip({ target: { surface: "bogus" }, trackId: "t", clip: { kind: "video", timelineStartSec: 0, durationSec: 1 } } as unknown as Parameters<typeof addClip>[0], ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toBe("not_implemented");
  });

  test("addClip accepts a video on an audio-labeled lane", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addClip(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-voice",
        clip: { kind: "video", timelineStartSec: 0, durationSec: 1 },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
  });

  test("addClip propagates write conflict", async () => {
    const host = mockHost({
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    });
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addClip(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-video",
        clip: { kind: "video", timelineStartSec: 0, durationSec: 1 },
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      status: "conflict",
      displayPath: "workspace:Launch demo.html",
      currentSha256: "newer-hash",
    });
  });

  test("agent mutation forwards the read CAS base and preserves a concurrently changed document", async () => {
    let receivedBase: { baseSha256?: string | null; baseRevision?: number | null } | undefined;
    const host = mockHost({
      async write(_target, _next, opts) {
        receivedBase = opts;
        // This models an authoritative intervening human write.  The mock host
        // deliberately leaves its stored document untouched on conflict.
        return { kind: "conflict", currentSha256: "human-sha" };
      },
    });
    const ctx: AgentToolContext = { nautiloApp: host };

    const result = await addClip(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-video",
        clip: { kind: "video", timelineStartSec: 0, durationSec: 1 },
      },
      ctx,
    );

    expect(receivedBase).toEqual({ baseSha256: "abc123", baseRevision: 1 });
    expect(result).toEqual({
      ok: true,
      status: "conflict",
      displayPath: "workspace:Launch demo.html",
      currentSha256: "human-sha",
    });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    expect(after).toMatchObject({ ok: true, clipCount: 0, clips: [] });
  });

  // ---- moveClip / trimClip / splitClip / deleteClip / detachAudio ----

  test("moveClip moves a clip in time and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!inspect.ok) throw new Error("inspect failed");
    const clipId = inspect.clips![0]!.id;
    const result = await moveClip({ target: WORKSPACE_TARGET, clipId, timelineStartSec: 10 }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved", sha256: "saved-hash" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clips![0]!.timelineStartSec).toBe(10);
  });

  test("moveClip rejects not-found clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await moveClip({ target: WORKSPACE_TARGET, clipId: "no-such-clip" }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Clip not found");
  });

  test("trimClip trims duration and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await trimClip({ target: WORKSPACE_TARGET, clipId, durationSec: 2 }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clips![0]!.durationSec).toBe(2);
  });

  test("splitClip splits into two and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await splitClip({ target: WORKSPACE_TARGET, clipId, atSec: 1.5 }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clipCount).toBe(2);
  });

  test("splitClip rejects atSec outside clip range", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await splitClip({ target: WORKSPACE_TARGET, clipId, atSec: 99 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("atSec");
  });

  test("deleteClip deletes a clip and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await deleteClip({ target: WORKSPACE_TARGET, clipId }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clipCount).toBe(0);
  });

  test("deleteClip rejects not-found clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await deleteClip({ target: WORKSPACE_TARGET, clipId: "ghost" }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Clip not found");
  });

  test("detachAudio creates a linked audio clip and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", mediaId: "media-1", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await detachAudio({ target: WORKSPACE_TARGET, clipId }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clipCount).toBe(2);
    const audio = after.clips!.find((c) => c.kind === "audio");
    expect(audio).toBeDefined();
    expect(audio!.trackId).toMatch(/^track-audio-/);
  });

  test("detachAudio rejects non-video clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-captions", clip: { kind: "caption", timelineStartSec: 0, durationSec: 2 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await detachAudio({ target: WORKSPACE_TARGET, clipId }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("video clip");
  });

  // ---- replaceCaptionText (real) ----

  test("replaceCaptionText updates caption props.text and persists", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-captions",
        clip: { kind: "caption", timelineStartSec: 0, durationSec: 2, props: { text: "old" } },
      },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await replaceCaptionText({ target: WORKSPACE_TARGET, clipId, text: "Hello world" }, ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    // Re-read the document to verify props.text landed.
    const envelope = await host.document.read(WORKSPACE_TARGET);
    expect(envelope.content).toContain("Hello world");
  });

  test("replaceCaptionText rejects non-caption clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const add = await addClip(
      { target: WORKSPACE_TARGET, trackId: "track-video", clip: { kind: "video", timelineStartSec: 0, durationSec: 4 } },
      ctx,
    );
    if (!add.ok) throw new Error("add failed");
    const inspect = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    const clipId = inspect.ok ? inspect.clips![0]!.id : "";
    const result = await replaceCaptionText({ target: WORKSPACE_TARGET, clipId, text: "nope" }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("caption clip");
  });

  test("replaceCaptionText rejects not-found clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await replaceCaptionText({ target: WORKSPACE_TARGET, clipId: "ghost", text: "x" }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Clip not found");
  });

  // ---- addOverlay (real, thin wrapper over addClip) ----

  test("addOverlay happy path adds a text overlay clip", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addOverlay(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-overlay",
        clip: { kind: "text", timelineStartSec: 0, durationSec: 2, props: { content: "Title" } },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const after = await inspectTimeline({ target: WORKSPACE_TARGET, includeClips: true }, ctx);
    if (!after.ok) throw new Error("inspect after failed");
    expect(after.clipCount).toBe(1);
    expect(after.clips![0]!.kind).toBe("text");
    expect(after.clips![0]!.trackId).toBe("track-overlay");
  });

  test("addOverlay accepts text on a video-labeled lane", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await addOverlay(
      {
        target: WORKSPACE_TARGET,
        trackId: "track-video",
        clip: { kind: "text", timelineStartSec: 0, durationSec: 2 },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, status: "saved" });
  });

  // ---- renderPreview / exportVideo (stable placeholders) ----

  test("renderPreview and exportVideo return ok not_implemented status", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const target = { surface: "workspace", path: "x.html" } as const;
    expect(await renderPreview({ target }, ctx)).toEqual({ ok: true, status: "not_implemented" });
    expect(await exportVideo({ target }, ctx)).toEqual({ ok: true, status: "not_implemented" });
  });

  test("renderPreview rejects invalid target", async () => {
    const host = mockHost();
    const ctx: AgentToolContext = { nautiloApp: host };
    const result = await renderPreview({ target: { surface: "bogus" } } as unknown as Parameters<typeof renderPreview>[0], ctx);
    expect(result.ok).toBe(false);
  });
});
