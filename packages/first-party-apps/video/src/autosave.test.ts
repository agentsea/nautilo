import { describe, expect, test } from "bun:test";
import { bridgeWriteResult, VideoAutosave } from "./autosave";
import { createEmptyProject } from "./edl";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";

function videoContent(title: string, markerLabel?: string): string {
  const project = createEmptyProject();
  project.metadata = { title };
  if (markerLabel) project.sequences[0]!.markers = [{ id: "marker-1", timeSec: 0, label: markerLabel }];
  return serializeVideoHtml(createDefaultManifest(), project);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("VideoAutosave", () => {
  test("maps saved bridge responses", () => {
    expect(
      bridgeWriteResult({
        kind: "saved",
        sha256: "sha-1",
        revision: 2,
        path: "Project.video.html",
        persistedContent: "persisted",
      }),
    ).toEqual({
      kind: "saved",
      sha256: "sha-1",
      revision: 2,
      path: "Project.video.html",
      persistedContent: "persisted",
    });
  });

  test("does not save before initial load", async () => {
    let writes = 0;
    const autosave = new VideoAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: "next" };
    });

    autosave.notifyChange('{"changed":true}');
    await sleep(800);
    expect(writes).toBe(0);
    autosave.destroy();
  });

  test("debounces full-document writes", async () => {
    let writes = 0;
    let written = "";
    const autosave = new VideoAutosave(async (content) => {
      writes += 1;
      written = content;
      return { kind: "saved", sha256: `sha-${writes}`, persistedContent: content };
    });

    autosave.markInitialLoad("{}", null, null);
    autosave.notifyChange('{"a":1}');
    autosave.notifyChange('{"a":2}');
    await sleep(800);

    expect(writes).toBe(1);
    expect(written).toBe('{"a":2}');
    expect(autosave.getState().status).toBe("saved");
    autosave.destroy();
  });

  test("saveNow passes base sha and revision", async () => {
    let writeBase: { sha256: string | null; revision: number | null } = { sha256: null, revision: null };
    const autosave = new VideoAutosave(async (_content, base) => {
      writeBase = base;
      return { kind: "saved", sha256: "next", revision: 4 };
    });

    autosave.markInitialLoad("{}", "base", 3);
    autosave.notifyChange('{"a":1}');
    await autosave.saveNow();

    expect(writeBase).toEqual({ sha256: "base", revision: 3 });
    expect(autosave.getState().dirty).toBe(false);
    autosave.destroy();
  });

  test("exposes an identity only for the clean saved document", async () => {
    const autosave = new VideoAutosave(async () => ({ kind: "saved", sha256: "next", revision: 4 }));
    autosave.markInitialLoad("{}", "base", 3);
    expect(autosave.getSavedDocumentIdentity()).toEqual({ sha256: "base", revision: 3 });
    autosave.notifyChange('{"a":1}');
    expect(autosave.getSavedDocumentIdentity()).toBeNull();
    await autosave.saveNow();
    expect(autosave.getSavedDocumentIdentity()).toEqual({ sha256: "next", revision: 4 });
    autosave.destroy();
  });

  test("conflict exposes latest and reloadLatest replaces draft", async () => {
    const autosave = new VideoAutosave(
      async () => ({ kind: "conflict", currentSha256: "remote" }),
      async () => ({ content: '{"remote":true}', baseSha256: "remote", baseRevision: 2 }),
    );

    autosave.markInitialLoad("{}", "base", 1);
    autosave.notifyChange('{"mine":true}');
    await autosave.saveNow();

    expect(autosave.getState().status).toBe("conflict");
    expect(autosave.getState().conflictLatestContent).toBe('{"remote":true}');
    const latest = await autosave.reloadLatest();
    expect(latest?.content).toBe('{"remote":true}');
    expect(autosave.getState().dirty).toBe(false);
    autosave.destroy();
  });

  test("remote change while dirty marks conflict without overwriting draft", () => {
    const autosave = new VideoAutosave(async () => ({ kind: "saved", sha256: "next" }));
    autosave.markInitialLoad("{}", "base", 1);
    autosave.notifyChange('{"mine":true}');
    const content = autosave.applyRemoteEnvelope({
      content: '{"remote":true}',
      baseSha256: "remote",
      baseRevision: 2,
    });

    expect(content).toBe('{"mine":true}');
    expect(autosave.getState().status).toBe("conflict");
    expect(autosave.getState().conflictLatestContent).toBe('{"remote":true}');
    autosave.destroy();
  });

  test("race matrix: a clean agent write reloads, while a disjoint human draft is preserved as a conflict", async () => {
    let cleanWriteBase: { sha256: string | null; revision: number | null } | undefined;
    const clean = new VideoAutosave(async (_content, base) => {
      cleanWriteBase = base;
      return { kind: "saved", sha256: "next" };
    });
    clean.markInitialLoad('{"base":true}', "base", 1);
    expect(
      clean.applyRemoteEnvelope({
        content: '{"agent":"disjoint timeline edit"}',
        baseSha256: "agent-sha",
        baseRevision: 2,
      }),
    ).toBe('{"agent":"disjoint timeline edit"}');
    expect(clean.getState()).toMatchObject({ status: "idle", dirty: false });
    clean.notifyChange('{"human":"next edit"}');
    await clean.saveNow();
    expect(cleanWriteBase).toEqual({ sha256: "agent-sha", revision: 2 });
    clean.destroy();

    const dirty = new VideoAutosave(async () => ({ kind: "saved", sha256: "next" }));
    dirty.markInitialLoad('{"base":true}', "base", 1);
    dirty.notifyChange('{"human":"caption edit"}');
    expect(
      dirty.applyRemoteEnvelope({
        content: '{"agent":"different clip edit"}',
        baseSha256: "agent-sha",
        baseRevision: 2,
      }),
    ).toBe('{"human":"caption edit"}');
    expect(dirty.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: '{"agent":"different clip edit"}',
    });
    dirty.destroy();
  });

  test("race matrix: a same-target human draft also conflicts with an agent write, and reloadLatest discards that draft", async () => {
    const latest = '{"caption":"agent replacement"}';
    const autosave = new VideoAutosave(
      async () => ({ kind: "saved", sha256: "next" }),
      async () => ({ content: latest, baseSha256: "agent-sha", baseRevision: 2 }),
    );
    autosave.markInitialLoad('{"caption":"base"}', "base", 1);
    autosave.notifyChange('{"caption":"human replacement"}');
    autosave.applyRemoteEnvelope({ content: latest, baseSha256: "agent-sha", baseRevision: 2 });

    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: latest,
    });
    const reloaded = await autosave.reloadLatest();
    expect(reloaded?.content).toBe(latest);
    expect(autosave.getState()).toMatchObject({ status: "idle", dirty: false });
    autosave.destroy();
  });

  test("merges a dirty human draft with a disjoint external document and saves against the external identity", async () => {
    const base = videoContent("Base");
    const human = videoContent("Human title");
    const external = videoContent("Base", "External marker");
    let written = "";
    let writeBase: { sha256: string | null; revision: number | null } | null = null;
    const autosave = new VideoAutosave(async (content, identity) => {
      written = content;
      writeBase = identity;
      return { kind: "saved", sha256: "merged-sha", revision: 3, persistedContent: content };
    });
    autosave.markInitialLoad(base, "base-sha", 1);
    autosave.notifyChange(human);

    const mergedContent = autosave.applyRemoteEnvelope({ content: external, baseSha256: "external-sha", baseRevision: 2 });
    await autosave.saveNow();

    expect(writeBase as { sha256: string | null; revision: number | null } | null).toEqual({ sha256: "external-sha", revision: 2 });
    expect(written).toBe(mergedContent);
    const parsed = parseVideoHtml(written);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.project.metadata?.title).toBe("Human title");
      expect(parsed.document.project.sequences[0]!.markers?.[0]?.label).toBe("External marker");
    }
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });

  test("keeps a same-target draft recoverable with a readable merge fence", () => {
    const base = videoContent("Base");
    const human = videoContent("Human title");
    const external = videoContent("External title");
    const autosave = new VideoAutosave(async () => ({ kind: "saved", sha256: "unused" }));
    autosave.markInitialLoad(base, "base-sha", 1);
    autosave.notifyChange(human);

    const retained = autosave.applyRemoteEnvelope({ content: external, baseSha256: "external-sha", baseRevision: 2 });

    expect(retained).toBe(human);
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: external,
      errorMessage: "The project title changed elsewhere. Nothing was overwritten.",
    });
    autosave.destroy();
  });

  test("a successful in-flight write advances the base without overwriting a newer draft", async () => {
    const first = deferred<{ kind: "saved"; sha256: string; revision: number; persistedContent: string }>();
    const writes: Array<{ content: string; base: { sha256: string | null; revision: number | null } }> = [];
    const autosave = new VideoAutosave(async (content, base) => {
      writes.push({ content, base });
      if (writes.length === 1) return first.promise;
      return { kind: "saved", sha256: "sha-2", revision: 3, persistedContent: content };
    });
    autosave.markInitialLoad("base", "sha-0", 1);
    autosave.notifyChange("first");
    const firstSave = autosave.saveNow();
    autosave.notifyChange("second");
    first.resolve({ kind: "saved", sha256: "sha-1", revision: 2, persistedContent: "first" });
    await firstSave;
    expect(autosave.getState()).toMatchObject({ status: "unsaved", dirty: true });

    await autosave.saveNow();
    expect(writes[1]).toEqual({ content: "second", base: { sha256: "sha-1", revision: 2 } });
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });

  test("serializes repeated Save requests and writes the queued latest draft against the first success", async () => {
    const pending = deferred<{ kind: "saved"; sha256: string; revision: number; persistedContent: string }>();
    const writes: Array<{ content: string; base: { sha256: string | null; revision: number | null } }> = [];
    const autosave = new VideoAutosave(async (content, base) => {
      writes.push({ content, base });
      if (writes.length === 1) return pending.promise;
      return { kind: "saved", sha256: "sha-latest", revision: 3, persistedContent: content };
    });
    autosave.markInitialLoad("base", "sha-base", 1);
    autosave.notifyChange("first");
    const firstSave = autosave.saveNow();
    autosave.notifyChange("latest");
    const queuedSave = autosave.saveNow();
    expect(writes).toHaveLength(1);

    pending.resolve({ kind: "saved", sha256: "sha-first", revision: 2, persistedContent: "first" });
    await Promise.all([firstSave, queuedSave]);

    expect(writes).toEqual([
      { content: "first", base: { sha256: "sha-base", revision: 1 } },
      { content: "latest", base: { sha256: "sha-first", revision: 2 } },
    ]);
    expect(autosave.getDraftContent()).toBe("latest");
    expect(autosave.getSavedDocumentIdentity()).toEqual({ sha256: "sha-latest", revision: 3 });
    autosave.destroy();
  });

  test("a remote envelope rebases the dirty draft and invalidates an older in-flight response", async () => {
    const pending = deferred<{ kind: "saved"; sha256: string; revision: number; persistedContent: string }>();
    let writes = 0;
    const base = videoContent("Base");
    const human = videoContent("Human");
    const external = videoContent("Base", "External");
    const autosave = new VideoAutosave(async (content) => {
      writes += 1;
      if (writes === 1) return pending.promise;
      return { kind: "saved", sha256: "merged", revision: 3, persistedContent: content };
    });
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(human);
    const oldSave = autosave.saveNow();
    const merged = autosave.applyRemoteEnvelope({ content: external, baseSha256: "external", baseRevision: 2 });
    pending.resolve({ kind: "saved", sha256: "stale", revision: 2, persistedContent: human });
    await oldSave;
    await autosave.saveNow();

    expect(autosave.getSavedDocumentIdentity()).toEqual({ sha256: "merged", revision: 3 });
    expect(parseVideoHtml(merged).ok).toBe(true);
    autosave.destroy();
  });

  test("ignores project updatedAt churn while retaining real same-field overlap detection", () => {
    const baseProject = createEmptyProject();
    baseProject.metadata = { title: "Base", updatedAt: "2026-01-01T00:00:00.000Z" };
    const base = serializeVideoHtml(createDefaultManifest(), baseProject);
    const humanProject = structuredClone(baseProject);
    humanProject.metadata = { title: "Human", updatedAt: "2026-01-02T00:00:00.000Z" };
    const human = serializeVideoHtml(createDefaultManifest(), humanProject);
    const timestampOnly = structuredClone(baseProject);
    timestampOnly.metadata!.updatedAt = "2026-01-03T00:00:00.000Z";
    const autosave = new VideoAutosave(async () => ({ kind: "saved", sha256: "next" }));
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(human);

    const merged = autosave.applyRemoteEnvelope({
      content: serializeVideoHtml(createDefaultManifest(), timestampOnly),
      baseSha256: "external",
      baseRevision: 2,
    });
    const parsed = parseVideoHtml(merged);
    expect(parsed.ok && parsed.document.project.metadata).toMatchObject({
      title: "Human",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    autosave.destroy();
  });

  test("projects an automatic write-conflict merge through getDraftContent", async () => {
    const base = videoContent("Base");
    const human = videoContent("Human");
    const external = videoContent("Base", "External marker");
    let writes = 0;
    const autosave = new VideoAutosave(
      async (content) => {
        writes += 1;
        return writes === 1
          ? { kind: "conflict", currentSha256: "external" }
          : { kind: "saved", sha256: "merged", revision: 3, persistedContent: content };
      },
      async () => ({ content: external, baseSha256: "external", baseRevision: 2 }),
    );
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(human);

    await autosave.saveNow();

    const projected = parseVideoHtml(autosave.getDraftContent());
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(projected.document.project.metadata?.title).toBe("Human");
      expect(projected.document.project.sequences[0]!.markers?.[0]?.label).toBe("External marker");
    }
    autosave.destroy();
  });
});
