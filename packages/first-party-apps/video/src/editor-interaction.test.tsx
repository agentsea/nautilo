test("completed generation enters the bin while editing, saves automatically and preserves multi-selection", async () => {
  const takeId = "take_abcdefghijklmnop";
  const artifact = { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/opening.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 1024 };
  const status = { takeId, revision: 1, mediaKind: "video" as const, state: "ready" as const, modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5 }, artifact };
  let resolve!: (value: { kind: "ready"; status: typeof status }) => void;
  let revalidations = 0;
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, {
    request: async () => { throw new Error("Read-only receipt recovery must never submit generation"); },
    listTakes: async () => ({ kind: "ready", takes: [{ takeId, shotId: "opening", shotLabel: "Opening", documentRevision: 1 }] }),
    getTakeStatus: () => new Promise((done) => { resolve = done; }),
    previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => {
      revalidations++;
      return { status: "ready", durationSec: 5, take: { id: takeId, briefRevision: 1, shotId: "opening", shotLabel: "Opening", mediaKind: "video", modelId: status.modelId, settings: status.settings, artifact } };
    },
  });
  for (const [id, additive] of [["clip-a", false], ["clip-b", true]] as const) {
    await act(async () => {
      const clip = document.querySelector(`[aria-label^="video clip ${id}"]`)!;
      for (const type of ["pointerdown", "pointerup"]) clip.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 10, clientY: 10, shiftKey: additive }) as unknown as Event);
    });
  }
  await act(async () => { resolve({ kind: "ready", status }); await Promise.resolve(); });
  expect(revalidations).toBe(1);
  expect(h.contexts.at(-1)?.selectionScope.clipIds).toEqual(["clip-a", "clip-b"]);
  expect(document.querySelector('[aria-label="Generate video"]')?.hasAttribute("hidden")).toBe(true);
  expect(document.querySelector(".video-media-bin")?.textContent ?? document.body.textContent).toContain("Opening");
  // Exercise the ordinary debounce, with no explicit Save, Refresh or Import.
  await act(async () => { await new Promise((done) => setTimeout(done, VIDEO_AUTOSAVE_DEBOUNCE_MS + 50)); });
  const saved = latestWrittenProject(h.writes);
  expect(saved.media).toHaveLength(1);
  expect(saved.generatedTakes).toHaveLength(1);
  expect(saved.media[0]?.source).toMatchObject({ kind: "workspace-artifact", artifactId: artifact.artifactId });
  expect(saved.sequences).toEqual(fixtureProject.sequences);
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { NautiloAppBridge, NautiloDocumentChangedEvent, NautiloDocumentChangeEvent, NautiloDocumentEnvelope, NautiloDocumentPatchAppliedEvent } from "./bridge";
import { createEmptyProject, type VideoProject } from "./edl";
import { VideoApp } from "./app";
import { VIDEO_AUTOSAVE_DEBOUNCE_MS } from "./autosave";
import { createDefaultManifest, parseVideoHtml, serializeVideoHtml } from "./video-document";
import type { VideoContextSummary } from "./context-summary";
import { appendGenerationShot, createEmptyGenerationBrief } from "./generation-brief";
import { VIDEO_GENERATION_CATALOG_MODELS } from "./generation-plan";
import { parseMediaOperationsResult } from "./media-agent";

const nativeMediaStub = (overrides: Partial<NonNullable<NautiloAppBridge["media"]>> = {}): NonNullable<NautiloAppBridge["media"]> => ({
  getExportCapabilities: async () => ({ workspace: true }),
  importVideo: async () => ({ kind: "unavailable", code: "cancelled" }),
  exportVideo: async () => ({ kind: "cancelled" }),
  openPreview: async () => ({ kind: "unavailable", code: "source_unavailable" }), closePreview: () => {},
  ...overrides,
});

test("Genie native import waits for selection, saves the Media Bin entry and never inserts clips", async () => {
  let selected!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["media"]>["importVideo"]>>) => void;
  let chooserCalls = 0;
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ importVideo: () => { chooserCalls++; return new Promise(resolve => { selected = resolve; }); } }));
  expect(await h.control({ action: "import-media" }, 0)).toMatchObject({ status: "rejected", code: "stale_document" });
  const started = parseMediaOperationsResult(await h.control({ action: "import-media" }))!;
  expect(started.import?.stage).toBe("choosing");
  expect(started.import?.retrySafe).toBe(false);
  expect(await h.control({ action: "import-media" })).toMatchObject({ status: "rejected" });
  expect(chooserCalls).toBe(1);
  expect(h.writes).toHaveLength(0);
  await act(async () => { selected({ kind: "ready", mediaKind: "image", label: "Subject", mediaRef: "subject.png" }); });
  const completed = parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!;
  expect(completed.import).toMatchObject({ id: started.import!.id, stage: "succeeded", stateChanged: true, label: "Subject" });
  const saved = latestWrittenProject(h.writes);
  expect(saved.media.map(item => item.id)).toContain(completed.import!.mediaId!);
  expect(saved.sequences).toEqual(fixtureProject.sequences);
});

test("an imported image gets a Media Bin preview after saving without changing the timeline", async () => {
  const requests: unknown[] = [];
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({
    importVideo: async () => ({ kind: "ready", mediaKind: "image", label: "Subject", mediaRef: "subject.png",
      source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "subject.png" } }),
    openPreview: async (request) => { requests.push(request); return { kind: "ready", url: "https://media.invalid/subject.png", revokeToken: "image-lease", mimeType: "image/png", sizeBytes: 10 }; },
  }));
  await h.control({ action: "import-media" });
  const saved = latestWrittenProject(h.writes);
  const image = document.querySelector<HTMLImageElement>('.video-media-bin img[alt="Subject"]');
  expect(image?.getAttribute("src")).toBe("https://media.invalid/subject.png");
  expect(requests).toContainEqual({ mediaId: saved.media[0]!.id });
  expect(saved.sequences).toEqual(fixtureProject.sequences);
  const before = requests.length;
  await h.emit({ type: "changed", path: "fixture.video.html" });
  expect(document.querySelector('.video-media-bin img[alt="Subject"]')).toBe(image);
  expect(requests).toHaveLength(before);
});

test("native import does not claim success when document save fails", async () => {
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ importVideo: async () => ({ kind: "ready", mediaKind: "image", mediaRef: "subject.png", label: "Subject" }) }));
  h.bridge.document.write = async () => { throw new Error("Offline"); };
  await h.control({ action: "import-media" });
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import).toMatchObject({ stage: "failed", code: "save_required", stateChanged: true, retrySafe: false });
  expect(h.writes).toHaveLength(0);
  expect(await h.control({ action: "import-media" })).toMatchObject({ status: "rejected", code: "dirty_document" });
});

test("a clean external document refresh fences a pending import before late admission", async () => {
  let selected!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["media"]>["importVideo"]>>) => void;
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ importVideo: () => new Promise(resolve => { selected = resolve; }) }));
  await h.control({ action: "import-media" });
  await h.patch(project => { project.sequences[0]!.tracks[0]!.name = "Changed externally"; });
  await act(async () => selected({ kind: "ready", mediaKind: "image", mediaRef: "late.png", label: "Late" }));
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import).toMatchObject({ stage: "unknown", code: "document_changed", stateChanged: "unknown", retrySafe: false });
  expect(h.writes).toHaveLength(0);
});

test("human export choices survive cancellation and reach native export without changing the project", async () => {
  const requests: unknown[] = [];
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ exportVideo: async input => { requests.push(input); return { kind: "cancelled" }; } }));
  const open = async () => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent === "Export video")!.click(); });
  const change = async (element: HTMLSelectElement, value: string) => act(async () => { element.value = value; element.dispatchEvent(new h.window.Event("change", { bubbles: true }) as unknown as Event); });
  await open();
  const selectors = () => document.querySelectorAll<HTMLSelectElement>(".video-export-dialog select");
  await change(selectors()[0]!, "720p");
  await change(selectors()[1]!, "custom");
  await change(selectors()[2]!, "320");
  expect(document.querySelector<HTMLInputElement>('.video-export-dialog input[type="number"]')!.value).toBe("8");
  await act(async () => { document.querySelector<HTMLButtonElement>('.video-export-dialog button[type="button"]')!.click(); });
  expect(requests).toHaveLength(0);
  expect(h.writes).toHaveLength(0);
  await open();
  expect(selectors()[0]!.value).toBe("720p");
  expect(selectors()[1]!.value).toBe("custom");
  expect(selectors()[2]!.value).toBe("320");
  await act(async () => { document.querySelector<HTMLButtonElement>('.video-export-dialog button[type="submit"]')!.click(); });
  expect(requests).toEqual([{ document: { sha256: "base", revision: 1 }, publishToWorkspace: false, exportSettings: { resolution: "720p", quality: "custom", videoBitrateKbps: 8000, audioBitrateKbps: 320 } }]);
  expect(h.writes).toHaveLength(0);
});

test("export bridge failure reports uncertainty rather than a saved file or a safe retry", async () => {
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ exportVideo: async () => { throw new Error("Response lost"); } }));
  await h.control({ action: "export-media", publishToWorkspace: false });
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.export).toMatchObject({ stage: "unknown", code: "export_unconfirmed", stateChanged: "unknown", retrySafe: false });
  expect(h.writes).toHaveLength(0);
});

test("Genie can choose the first-source rate; a cancelled chooser cannot admit late media", async () => {
  let selected!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["media"]>["importVideo"]>>) => void;
  const h = await receiptHarness(undefined, undefined, undefined, createEmptyProject(), undefined, nativeMediaStub({ importVideo: () => new Promise(resolve => { selected = resolve; }) }));
  const first = parseMediaOperationsResult(await h.control({ action: "import-media" }))!;
  await act(async () => selected({ kind: "ready", mediaRef: "source.mp4", label: "Source", durationSec: 4, frameRate: { numerator: 60, denominator: 1 } }));
  const waiting = parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!;
  expect(waiting.import).toMatchObject({ stage: "awaiting-rate", sourceRate: { numerator: 60, denominator: 1 } });
  expect(h.writes).toHaveLength(0);
  await h.control({ action: "choose-import-rate", operationId: first.import!.id, decision: "adopt-source-rate" });
  expect(latestWrittenProject(h.writes).sequences[0]!.frameRate).toEqual({ numerator: 60, denominator: 1 });
  const second = parseMediaOperationsResult(await h.control({ action: "import-media" }))!;
  expect(await h.control({ action: "cancel-import", operationId: first.import!.id })).toMatchObject({ status: "rejected" });
  expect(parseMediaOperationsResult(await h.control({ action: "cancel-import", operationId: second.import!.id }))!.import?.stage).toBe("cancelling");
  await act(async () => selected({ kind: "ready", mediaRef: "late.png", mediaKind: "image", label: "Late" }));
  expect(latestWrittenProject(h.writes).media).toHaveLength(1);
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import?.stage).toBe("cancelled");
});

test("Genie export shares native snapshot, progress, explicit Workspace choice and final saved result", async () => {
  let finish!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["media"]>["exportVideo"]>>) => void;
  let observed: Parameters<NonNullable<NautiloAppBridge["media"]>["exportVideo"]>[0] | undefined;
  let progress: NonNullable<Parameters<NonNullable<NautiloAppBridge["media"]>["exportVideo"]>[1]>["onProgress"];
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ exportVideo: (input, options) => { observed = input; progress = options?.onProgress; return new Promise(resolve => { finish = resolve; }); } }));
  const exportSettings = { resolution: "720p", quality: "custom", videoBitrateKbps: 4500, audioBitrateKbps: 320 } as const;
  const started = parseMediaOperationsResult(await h.control({ action: "export-media", publishToWorkspace: true, exportSettings }))!;
  expect(started.export?.stage).toBe("preparing");
  expect(observed).toEqual({ document: { sha256: "base", revision: 1 }, publishToWorkspace: true, exportSettings });
  expect(started.export?.exportSettings).toEqual(exportSettings);
  expect(await h.control({ action: "export-media", publishToWorkspace: false })).toMatchObject({ status: "rejected" });
  await act(async () => progress?.({ stage: "rendering", processedTimeUs: 1000000 }));
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.export).toMatchObject({ stage: "rendering", processedTimeUs: 1000000 });
  await act(async () => finish({ kind: "succeeded", label: "Export.mp4", sizeBytes: 1024, warnings: [], workspace: { status: "published", path: "exports/Export.mp4", artifactId: "public" } }));
  const result = parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!;
  expect(result.export).toMatchObject({ id: started.export!.id, stage: "succeeded", sizeBytes: 1024, stateChanged: true, workspace: { status: "published" } });
  expect(h.writes).toHaveLength(0);
  expect(document.body.textContent).toContain("Saved Export.mp4");
});

test("export cancellation stays inspectable while dirty, but late native success is never called rollback", async () => {
  let finish!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["media"]>["exportVideo"]>>) => void;
  let signal: AbortSignal | undefined;
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ exportVideo: (_input, options) => { signal = options?.signal; return new Promise(resolve => { finish = resolve; }); } }));
  const first = parseMediaOperationsResult(await h.control({ action: "export-media", publishToWorkspace: false }))!;
  await act(async () => (document.querySelector('.video-track button[aria-label^="Hide "]') as HTMLButtonElement).click());
  expect(await h.control({ action: "import-media" })).toMatchObject({ status: "rejected", code: "dirty_document" });
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.export?.id).toBe(first.export!.id);
  await h.control({ action: "cancel-export", operationId: first.export!.id });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ kind: "succeeded", label: "Retained.mp4", sizeBytes: 42, warnings: [], workspace: { status: "unknown", path: "exports/Retained.mp4" } }));
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.export).toMatchObject({ stage: "succeeded", workspace: { status: "unknown" } });
});

test("Simple duration edits Scene 1 and reaches review after save without changing other scenes", async () => {
  const brief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "Opening", description: "A sphere turns", durationSec: 15 }, () => "opening"), { title: "Next", description: "A second sphere", durationSec: 9 }, () => "next");
  const requests: Parameters<NonNullable<NautiloAppBridge["videoGeneration"]>["request"]>[0][] = [];
  const h = await receiptHarness(undefined, undefined, undefined, { ...fixtureProject, generationBrief: brief }, {
    request: async request => { requests.push(request); return { kind: "cancelled" }; },
    listTakes: async () => ({ kind: "ready", takes: [] }),
    getTakeStatus: async () => { throw new Error("No generation was approved"); },
    previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => { throw new Error("No take exists"); },
  });
  await act(async () => { h.button("Generate").click(); h.button("Simple").click(); });
  const input = document.querySelector<HTMLInputElement>('[aria-label="Generation duration in seconds"]')!;
  expect(input.value).toBe("15");
  await act(async () => { input.value = "6"; input.dispatchEvent(new h.window.Event("input", { bubbles: true }) as unknown as Event); });
  expect(input.value).toBe("6");
  await act(async () => { h.button("Generate video").click(); });
  for (let step = 0; step < 10 && requests.length === 0; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.job).toMatchObject({ source: { kind: "shot", shotId: "opening" }, requestedSettings: { durationSeconds: 6 } });
  expect(latestWrittenProject(h.writes).generationBrief?.shots.map(shot => shot.durationSec)).toEqual([6, 9]);
  await act(async () => { h.button("Advanced").click(); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Duration for Opening"]')!.value).toBe("6");
});

test("Simple without scenes reviews its entered duration without creating a scene", async () => {
  const requests: Parameters<NonNullable<NautiloAppBridge["videoGeneration"]>["request"]>[0][] = [];
  const h = await receiptHarness(undefined, undefined, undefined, { ...fixtureProject, generationBrief: { ...createEmptyGenerationBrief(), quickBrief: "A sphere turns" } }, {
    request: async request => { requests.push(request); return { kind: "cancelled" }; },
    listTakes: async () => ({ kind: "ready", takes: [] }),
    getTakeStatus: async () => { throw new Error("No generation was approved"); },
    previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => { throw new Error("No take exists"); },
  });
  await act(async () => { h.button("Generate").click(); });
  const input = document.querySelector<HTMLInputElement>('[aria-label="Generation duration in seconds"]')!;
  await act(async () => { input.value = "6"; input.dispatchEvent(new h.window.Event("input", { bubbles: true }) as unknown as Event); });
  await act(async () => { h.button("Generate video").click(); });
  for (let step = 0; step < 10 && requests.length === 0; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.job).toMatchObject({ source: { kind: "quick-brief" }, requestedSettings: { durationSeconds: 6 } });
  expect(h.writes).toHaveLength(0);
});

test.each(["queued", "submission-unknown"] as const)("%s opens progress before the take index catches up, with no replay", async (kind) => {
  let submit!: (value: { kind: "queued" | "submission-unknown"; takeId: string }) => void;
  let requests = 0;
  let statusReads = 0;
  const takeId = "take_abcdefghijklmnop";
  const h = await receiptHarness(undefined, undefined, undefined, { ...fixtureProject, generationBrief: { ...createEmptyGenerationBrief(), quickBrief: "A sphere turns" } }, {
    request: () => { requests++; return new Promise(resolve => { submit = resolve; }); },
    listTakes: async () => ({ kind: "ready", takes: [] }),
    getTakeStatus: async () => { statusReads++; return { kind: "unavailable", code: "offline" }; },
    previewTake: async () => ({ kind: "opened" }), revalidateTake: async () => { throw new Error("Not completed"); },
  });
  await act(async () => h.button("Generate").click());
  await act(async () => h.button("Generate video").click());
  for (let step = 0; step < 10 && requests === 0; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests).toBe(1);
  // Cost review alone must not replace the prompt with a running animation.
  expect(document.querySelector('[aria-label="Generation progress"]')).toBeNull();
  await act(async () => { submit({ kind, takeId }); await new Promise(resolve => setTimeout(resolve, 0)); });
  const progress = document.querySelector('[aria-label="Generation progress"]');
  expect(progress).not.toBeNull();
  expect(document.querySelector('.generator-writing textarea')).toBeNull();
  expect(progress!.textContent).toContain(kind === "queued" ? "Status unavailable" : "Submission could not be confirmed");
  expect(statusReads).toBe(kind === "queued" ? 1 : 0);
  await act(async () => h.button("Back to scene design").click());
  expect(document.querySelector('[aria-label="Video prompt"]')).not.toBeNull();
  await act(async () => h.button("View generation progress").click());
  expect(requests).toBe(1);
  expect(h.writes).toHaveLength(0);
});

test("Genie continuation requests the same one-scene review with explicit cheap settings, not payment", async () => {
  const brief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "Opening", description: "A sphere" }, () => "opening"), { title: "Next", description: "Continue rotating", continueFromPrevious: true }, () => "next");
  const requests: Parameters<NonNullable<NautiloAppBridge["videoGeneration"]>["request"]>[0][] = [];
  const takeId = "take_abcdefghijklmnop";
  let cancel!: (value: { kind: "cancelled" }) => void;
  const generation: NonNullable<NautiloAppBridge["videoGeneration"]> = {
    request: request => { requests.push(request); return new Promise(resolve => { cancel = resolve; }); },
    listTakes: async () => ({ kind: "ready", takes: [] }),
    getTakeStatus: async () => { throw new Error("No generation was approved"); },
    previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => ({ status: "ready", durationSec: 4, take: { id: takeId, briefRevision: 1, shotId: "opening", shotLabel: "Opening", mediaKind: "video", modelId: "seedance-2-5-reference-to-video-basic", settings: {}, artifact: { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/opening.mp4", zone: "workspace", mime: "video/mp4", bytes: 1024 } } }),
  };
  const h = await receiptHarness(undefined, undefined, undefined, { ...fixtureProject, generationBrief: brief }, generation);
  const command = { action: "review-generation", shotId: "next", modelId: VIDEO_GENERATION_CATALOG_MODELS.seedanceReference, settings: { durationSeconds: 4, resolution: "480p", aspectRatio: "16:9", audio: false }, continuationTakeId: takeId };
  expect(await h.control(command, 0)).toMatchObject({ status: "rejected", code: "stale_document" });
  expect(requests).toHaveLength(0);
  let first: unknown; let duplicate: unknown;
  await act(async () => { first = h.commandNow(command); duplicate = h.commandNow(command); });
  expect(first).toEqual({ status: "review_requested", paidSubmission: false, documentChanged: false, retrySafe: false });
  expect(duplicate).toMatchObject({ status: "rejected", code: "invalid_command" });
  for (let step = 0; step < 10 && requests.length === 0; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.job).toMatchObject({ source: { kind: "shot", shotId: "next" }, requestedSettings: command.settings, continuationTakeId: takeId });
  expect(requests[0]!.job.prompt).toContain("Continue rotating");
  expect(h.writes).toHaveLength(0);
  expect(await h.control(command)).toMatchObject({ status: "rejected", code: "invalid_command" });
  await act(async () => { cancel({ kind: "cancelled" }); });
  expect(requests).toHaveLength(1);
});

test("Genie continuation refuses a take from the wrong scene before requesting a quote", async () => {
  const brief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "Opening", description: "A sphere" }, () => "opening"), { title: "Next", description: "Continue", continueFromPrevious: true }, () => "next");
  let requests = 0;
  const h = await receiptHarness(undefined, undefined, undefined, { ...fixtureProject, generationBrief: brief }, {
    request: async () => { requests++; return { kind: "cancelled" }; }, listTakes: async () => ({ kind: "ready", takes: [] }),
    getTakeStatus: async () => { throw new Error("Not submitted"); }, previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => ({ status: "ready", durationSec: 4, take: { id: "take_abcdefghijklmnop", briefRevision: 1, shotId: "different", shotLabel: "Unrelated", mediaKind: "video", modelId: "seedance-2-5-reference-to-video-basic", settings: {}, artifact: { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/other.mp4", zone: "workspace", mime: "video/mp4", bytes: 1024 } } }),
  });
  await h.control({ action: "review-generation", shotId: "next", modelId: VIDEO_GENERATION_CATALOG_MODELS.seedanceReference, settings: { durationSeconds: 4, resolution: "480p", audio: false }, continuationTakeId: "take_abcdefghijklmnop" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(requests).toBe(0);
  expect(document.body.textContent).toContain("previous scene's media is unavailable");
});

const fixtureProject: VideoProject = {
  version: 1,
  sequences: [{
    id: "sequence-editor-acceptance",
    frameRate: { numerator: 30, denominator: 1 },
    durationSec: 6,
    tracks: [
      {
        id: "track-video",
        kind: "video",
        order: 0,
        clips: [
          { id: "neighbor", kind: "video", trackId: "track-video", timelineStartSec: 0, durationSec: 2, sourceInSec: 0, sourceOutSec: 2, props: {} },
          { id: "clip-a", kind: "video", trackId: "track-video", timelineStartSec: 2, durationSec: 2, sourceInSec: 0, sourceOutSec: 2, props: {} },
          { id: "following-neighbor", kind: "video", trackId: "track-video", timelineStartSec: 4, durationSec: 2, sourceInSec: 0, sourceOutSec: 2, props: {} },
        ],
      },
      {
        id: "track-video-2",
        kind: "video",
        order: 1,
        clips: [
          { id: "clip-b", kind: "video", trackId: "track-video-2", timelineStartSec: 3, durationSec: 2, sourceInSec: 0, sourceOutSec: 2, props: {} },
        ],
      },
    ],
  }],
  media: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let testWindow: Window | null = null;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): Window {
  const window = new Window();
  for (const key of globalKeys) originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow = window;
  return window;
}

function latestWrittenProject(writes: string[]): VideoProject {
  const parsed = parseVideoHtml(writes.at(-1) ?? "");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document.project;
}

async function save(window: Window): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
  });
}

test("Genie controls the mounted transport without writing and rejects stale/dirty input", async () => {
  const h = await receiptHarness();
  const before = h.current().content;
  expect((await h.control({ action: "inspect" })).status).toBe("ready");
  const selected = await h.control({ action: "preview-range", inSec: 1, outSec: 3 });
  expect(selected.status).toBe("ready");
  expect(document.querySelector('[aria-label="Pause preview"]')).not.toBeNull();
  const playhead = document.querySelector('[aria-label="Timeline playhead"]') as HTMLInputElement;
  expect(playhead.min).toBe("1");
  expect(playhead.max).toBe("3");
  expect((await h.control({ action: "seek", seconds: 5 })).status).toBe("rejected");
  await h.control({ action: "pause" });
  expect(document.querySelector('[aria-label="Play sequence preview"]')).not.toBeNull();
  await h.control({ action: "clear-range" });
  await h.control({ action: "seek", seconds: 5 });
  expect(playhead.value).toBe("5");
  expect(await h.control({ action: "play" }, 0)).toMatchObject({ status: "rejected", code: "stale_document", stateChanged: false });
  expect(h.writes).toEqual([]);
  expect(h.current().content).toBe(before);
  // Normal human edit creates a dirty draft; transport must not claim it is
  // the inspected saved version or implicitly save it to enable a command.
  await act(async () => {
    (document.querySelector('.video-track button[aria-label^="Hide "]') as HTMLButtonElement).click();
  });
  expect(await h.control({ action: "play" })).toMatchObject({ status: "rejected", code: "dirty_document", stateChanged: false });
});

async function dropEffect(window: Window, tileLabel: string, clipId: string, clientX = 0): Promise<void> {
  const values = new Map<string, string>();
  const transfer = { get types() { return [...values.keys()]; }, setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) ?? "", effectAllowed: "", dropEffect: "" };
  const dispatch = (target: Element, type: string) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    target.dispatchEvent(event as unknown as Event);
  };
  await act(async () => {
    dispatch(document.querySelector(`[aria-label="${tileLabel}"]`)!, "dragstart");
    const clip = document.querySelector(`[aria-label*="clip ${clipId}"]`)!;
    dispatch(clip, "dragover");
    dispatch(clip, "drop");
  });
}

async function receiptHarness(preferences?: NautiloAppBridge["preferences"], initialRead?: Promise<NautiloDocumentEnvelope>, authoredChange?: NautiloAppBridge["document"]["authoredChange"], initialProject = fixtureProject, generation?: NautiloAppBridge["videoGeneration"], media?: NautiloAppBridge["media"], setup?: (window: Window) => void) {
  const window = installDom();
  setup?.(window);
  let envelope: NautiloDocumentEnvelope = { content: serializeVideoHtml(createDefaultManifest(), initialProject), path: "fixture.video.html", baseSha256: generation ? "a".repeat(64) : "base", baseRevision: 1 };
  let listener: ((event: NautiloDocumentChangeEvent) => void) | undefined;
  let delayedRead: Promise<NautiloDocumentEnvelope> | null = initialRead ?? null;
  const writes: string[] = [];
  const contexts: VideoContextSummary[] = [];
  let playbackHandler: Parameters<NonNullable<NautiloAppBridge["session"]>["onCommand"]>[0] | undefined;
  const bridge: NautiloAppBridge = {
    ...(media ? { media } : {}),
    ...(generation ? { videoGeneration: generation } : {}),
    session: { onCommand: (handler) => { playbackHandler = handler; return () => { playbackHandler = undefined; }; } },
    ...(preferences ? { preferences } : {}),
    document: {
      ...(authoredChange ? { authoredChange } : {}),
      read: async () => { const pending = delayedRead; delayedRead = null; return pending ?? { ...envelope }; },
      write: async (next, base) => {
        if (base?.baseSha256 !== envelope.baseSha256) return { kind: "conflict", currentSha256: envelope.baseSha256 };
        const content = typeof next === "string" ? next : next.content;
        writes.push(content);
        envelope = { ...envelope, content, baseSha256: generation ? writes.length.toString(16).padStart(64, "0") : `saved-${writes.length}`, baseRevision: (envelope.baseRevision ?? 0) + 1 };
        return { kind: "saved", sha256: envelope.baseSha256!, revision: envelope.baseRevision, persistedContent: content };
      },
      onChange: (handler) => { listener = handler; return () => { listener = undefined; }; },
    },
    context: { set: (value) => { contexts.push(value as VideoContextSummary); } },
  };
  (window as unknown as { nautiloApp: NautiloAppBridge }).nautiloApp = bridge;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root?.render(createElement(VideoApp)); await Promise.resolve(); });
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label) as HTMLButtonElement;
  const emit = async (event: NautiloDocumentChangeEvent) => { await act(async () => { listener?.(event); await Promise.resolve(); }); };
  return {
    window, writes, contexts, bridge, button, emit,
    commandNow: (command: unknown) => playbackHandler?.(command, { kind: "artifact_revision", revision: envelope.baseRevision ?? 0 }),
    control: async (command: unknown, revision = envelope.baseRevision ?? 0) => {
      let result: unknown;
      await act(async () => { result = playbackHandler?.(command, { kind: "artifact_revision", revision }); });
      return result as import("./live-playback").PlaybackResult;
    },
    current: () => ({ ...envelope }),
    delayRead: (pending: Promise<NautiloDocumentEnvelope>) => { delayedRead = pending; },
    patch: async (mutate: (project: VideoProject) => void) => {
      const parsed = parseVideoHtml(envelope.content); if (!parsed.ok) throw new Error(parsed.error);
      mutate(parsed.document.project);
      const previous = envelope;
      envelope = { ...envelope, content: serializeVideoHtml(parsed.document.manifest, parsed.document.project, { touchMetadata: true, updatedAt: "2026-02-01T00:00:00.000Z" }), baseRevision: (envelope.baseRevision ?? 0) + 1, baseSha256: `patch-${(envelope.baseRevision ?? 0) + 1}` };
      const event: NautiloDocumentPatchAppliedEvent = { type: "patch_applied", patchId: envelope.baseSha256!, author: { kind: "app_tool", displayName: "nautilo-video" }, previousSha256: previous.baseSha256!, previousRevision: previous.baseRevision, sha256: envelope.baseSha256!, revision: envelope.baseRevision, envelope: { ...envelope } };
      await emit(event); return event;
    },
    deleteClip: async (id: string) => {
      const clip = document.querySelector(`[aria-label^="video clip ${id}"]`) as HTMLElement;
      await act(async () => {
        clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
        clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      });
    },
  };
}

test("a prolonged read outage pauses honestly and reconnects the same generated take without new spend", async () => {
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let reads = 0;
  let online = false;
  let submits = 0;
  const takeId = "take_abcdefghijklmnop";
  const artifact = { artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "generated-media/opening.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 1024 };
  const take = { id: takeId, briefRevision: 1, shotId: "opening", shotLabel: "Opening", mediaKind: "video" as const, modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5 }, artifact };
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, {
    request: async () => { submits++; throw new Error("Observation must not submit"); },
    listTakes: async () => {
      reads++;
      return online ? { kind: "ready", takes: [{ takeId, shotId: "opening", shotLabel: "Opening", documentRevision: 1 }] }
        : { kind: "unavailable", code: "unavailable" };
    },
    getTakeStatus: async () => ({ kind: "ready", status: { takeId, revision: 1, state: "ready", ...take } }),
    previewTake: async () => ({ kind: "opened" }),
    revalidateTake: async () => ({ status: "ready", durationSec: 5, take }),
  }, undefined, (window) => {
    const originalSet = window.setTimeout.bind(window);
    const originalClear = window.clearTimeout.bind(window);
    window.setTimeout = ((callback: () => void, delay: number) => {
      if (delay !== 5_000) return originalSet(callback, delay);
      const id = --timerId; timers.set(id, callback); return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id: Parameters<typeof window.clearTimeout>[0]) => { if (!timers.delete(id as unknown as number)) originalClear(id); });
  });
  const tick = async () => { const callbacks = [...timers.values()]; timers.clear(); await act(async () => { for (const callback of callbacks) callback(); }); };
  // The editor stays mounted and online/focused; no focus/online event rescues it.
  for (let i = 0; i < 4; i++) await tick();
  expect(reads).toBe(4);
  expect(timers.size).toBe(0);
  expect(document.body.textContent).toContain("Updates paused");
  expect(document.body.textContent).not.toContain("Generated media is reconnecting");
  online = true;
  await act(async () => h.button("Reconnect generated media").click());
  await save(h.window);
  expect(latestWrittenProject(h.writes).media).toHaveLength(1);
  // Repeated observations and Genie-style saved document changes must not duplicate admission.
  await h.patch(project => { project.sequences[0]!.tracks[0]!.name = "Genie renamed track"; });
  await tick(); await tick(); await save(h.window);
  const project = parseVideoHtml(h.current().content);
  if (!project.ok) throw new Error(project.error);
  expect(project.document.project.media).toHaveLength(1);
  expect(project.document.project.generatedTakes?.map(item => item.id)).toEqual([takeId]);
  expect(project.document.project.sequences[0]?.tracks[0]?.name).toBe("Genie renamed track");
  expect(project.document.project.sequences[0]?.tracks[0]?.clips).toEqual(fixtureProject.sequences[0]?.tracks[0]?.clips);
  expect(submits).toBe(0);
  await act(async () => root?.unmount()); root = null;
  expect(timers.size).toBe(0);
  const readsAtUnmount = reads;
  h.window.dispatchEvent(new h.window.Event("online"));
  h.window.dispatchEvent(new h.window.Event("focus"));
  await tick();
  expect(reads).toBe(readsAtUnmount);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  testWindow?.close();
  for (const key of globalKeys) {
    const descriptor = originalGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
  root = null;
  host = null;
  testWindow = null;
});

describe("mounted Video editor interactions", () => {
  test("paused range and additive selection reach Genie context without a document write", async () => {
    const h = await receiptHarness();
    for (const [id, additive] of [["clip-a", false], ["clip-b", true]] as const) {
      await act(async () => {
        const clip = document.querySelector(`[aria-label^="video clip ${id}"]`)!;
        for (const type of ["pointerdown", "pointerup"]) clip.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 10, clientY: 10, shiftKey: additive }) as unknown as Event);
      });
    }
    expect(h.contexts.at(-1)?.selectionScope.clipIds).toEqual(["clip-a", "clip-b"]);
    const ruler = document.querySelector<HTMLElement>(".video-ruler")!;
    Object.defineProperty(ruler, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 500, height: 32 }) });
    await act(async () => {
      const wing = document.querySelector('[aria-label="Range out handle"]')!;
      for (const type of ["pointerdown", "pointerup"]) wing.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 2, clientX: 192, altKey: true }) as unknown as Event);
    });
    expect(h.contexts.at(-1)?.selectionScope).toEqual({ clipIds: ["clip-a", "clip-b"], range: { inSec: 0, outSec: 4 }, precedence: "range" });
    expect(h.contexts.at(-1)?.savedVersion).toEqual({ sha256: "base", revision: 1 });
    expect(h.writes).toHaveLength(0);
  });
  test.each(["videoIn", "videoOut", "audioIn", "audioOut"])("dropping %s applies immediately without selecting or typing; one Undo restores the clip", async (key) => {
    const project = structuredClone(fixtureProject);
    if (key.startsWith("audio")) project.sequences[0]!.tracks[0]!.clips[1]!.kind = "audio";
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const channel = key.startsWith("audio") ? "Audio" : "Transitions";
    const label = `${key.startsWith("audio") ? "Audio" : "Video"} fade ${key.endsWith("Out") ? "out" : "in"}`;
    await act(async () => (document.querySelector(`[aria-label="${channel} library"]`) as HTMLButtonElement).click());
    expect(h.button("Undo").disabled).toBe(true);
    await dropEffect(h.window, `Choose ${label}`, "clip-a");
    expect(document.querySelector(`[data-fade-key="${key}"]`)).not.toBeNull();
    expect(h.button("Update fade")).toBeDefined();
    await save(h.window);
    expect(h.writes).toHaveLength(1);
    const clip = latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!;
    expect(clip.props["fades"]).toMatchObject({ [key]: { durationSec: 1, startSec: key.endsWith("Out") ? 1 : 0 } });
    expect(clip.timelineStartSec).toBe(2);
    await dropEffect(h.window, `Choose ${label}`, "clip-a");
    await save(h.window); expect(h.writes).toHaveLength(1); // re-drop selects, not resets
    await act(async () => h.button("Undo").click());
    expect(document.querySelector(`[data-fade-key="${key}"]`)).toBeNull();
    expect(h.button("Undo").disabled).toBe(true);
  });

  test.each(["Crossfade", "Swipe"])("dropping %s at either side of a cut applies immediately and preserves timing", async (kind) => {
    const project = structuredClone(fixtureProject);
    project.media = [{ id: "source", kind: "video", ref: "fixture.mp4", durationSec: 20 }];
    for (const track of project.sequences[0]!.tracks) for (const clip of track.clips) { clip.mediaId = "source"; clip.sourceInSec = 0.25; clip.sourceOutSec = 2.25; }
    const h = await receiptHarness(undefined, undefined, undefined, project);
    await act(async () => (document.querySelector('[aria-label="Transitions library"]') as HTMLButtonElement).click());
    // Left of incoming, or right of outgoing: both resolve the same cut.
    await dropEffect(h.window, `Choose ${kind}`, kind === "Swipe" ? "neighbor" : "clip-a", kind === "Swipe" ? 1 : 0);
    expect(document.querySelector(`[aria-label="${kind} end handle"]`)).not.toBeNull();
    await save(h.window); expect(h.writes).toHaveLength(1);
    const clips = latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips;
    expect(clips[1]!.props["transition"]).toMatchObject({ kind: kind.toLowerCase(), durationSec: 0.5, fromClipId: "neighbor" });
    expect(clips.map((clip) => [clip.timelineStartSec, clip.durationSec])).toEqual([[0, 2], [2, 2], [4, 2]]);
    await act(async () => h.button("Undo").click());
    expect(document.querySelector(`[aria-label="${kind} end handle"]`)).toBeNull();
    expect(h.button("Undo").disabled).toBe(true);
  });

  test("effect drops refuse missing handles, real gaps and protected lanes without writes", async () => {
    const project = structuredClone(fixtureProject);
    project.media = [{ id: "source", kind: "video", ref: "fixture.mp4", durationSec: 20 }];
    for (const track of project.sequences[0]!.tracks) for (const clip of track.clips) clip.mediaId = "source";
    project.sequences[0]!.tracks[1]!.locked = true;
    const h = await receiptHarness(undefined, undefined, undefined, project);
    await act(async () => (document.querySelector('[aria-label="Transitions library"]') as HTMLButtonElement).click());
    await dropEffect(h.window, "Choose Crossfade", "clip-a");
    expect(document.body.textContent).toContain("No spare footage");
    await dropEffect(h.window, "Choose Crossfade", "following-neighbor", 1);
    expect(document.body.textContent).toContain("No adjoining clip");
    await dropEffect(h.window, "Choose Video fade in", "clip-b");
    await save(h.window); expect(h.writes).toHaveLength(0);
    expect(h.button("Undo").disabled).toBe(true);
  });

  test("a dropped video fade uses the shorter linked audio duration and protects the whole group", async () => {
    const project = structuredClone(fixtureProject);
    project.sequences[0]!.tracks[0]!.clips[1]!.linkedClipIds = ["clip-b"];
    Object.assign(project.sequences[0]!.tracks[1]!.clips[0]!, { kind: "audio", durationSec: 0.25, sourceOutSec: 0.25 });
    const h = await receiptHarness(undefined, undefined, undefined, project);
    await act(async () => (document.querySelector('[aria-label="Transitions library"]') as HTMLButtonElement).click());
    await dropEffect(h.window, "Choose Video fade in", "clip-a");
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!.props["fades"]).toMatchObject({ videoIn: { durationSec: 0.25 } });
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[1]!.clips[0]!.props["fades"]).toMatchObject({ audioIn: { durationSec: 0.25 } });
    await act(async () => h.button("Undo").click());
    await save(h.window);
    await h.patch((current) => { current.sequences[0]!.tracks[1]!.hidden = true; });
    const before = h.writes.length;
    await dropEffect(h.window, "Choose Video fade in", "clip-a");
    expect(document.body.textContent).toContain("hidden or locked");
    await save(h.window); expect(h.writes).toHaveLength(before);
  });

  test("crossfade and swipe reach an editable inspector, save, resize/cancel and remove only the transition", async () => {
    const project = structuredClone(fixtureProject);
    project.media = [{ id: "source", kind: "video", ref: "fixture.mp4", durationSec: 20 }];
    for (const track of project.sequences[0]!.tracks) for (const clip of track.clips) { clip.mediaId = "source"; clip.sourceInSec = 3; clip.sourceOutSec = 5; }
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const clip = document.querySelector('[aria-label^="video clip clip-a"]')!;
    await act(async () => { for (const type of ["pointerdown", "pointerup"]) clip.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event); });
    await act(async () => (document.querySelector('[aria-label="Transitions library"]') as HTMLButtonElement).click());
    await act(async () => { const tile = document.querySelector('[aria-label="Choose Crossfade"]') as HTMLButtonElement; tile.focus(); tile.click(); });
    expect(h.button("Undo").disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Transition duration in seconds"]'));
    await act(async () => h.button("Apply transition").click());
    await save(h.window); expect(h.writes).toHaveLength(1);
    expect(parseVideoHtml(h.writes[0]!)).toMatchObject({ ok: true, document: { manifest: { version: "1.2" } } });
    const handle = document.querySelector('[aria-label="Crossfade end handle"]')!;
    const pointer = (type: string, x: number) => handle.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 8, clientX: x }) as unknown as Event);
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 12); });
    await save(h.window); expect(h.writes).toHaveLength(1);
    await act(async () => handle.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
    await act(async () => pointer("pointerup", 12));
    await save(h.window); expect(h.writes).toHaveLength(1);
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 12); pointer("pointerup", 12); });
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!.props["transition"]).toMatchObject({ durationSec: 1.5 });
    await act(async () => handle.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }) as unknown as Event));
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips).toHaveLength(3);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!.props["transition"]).toBeUndefined();
    await act(async () => h.button("Undo").click());
    expect(document.querySelector('[aria-label="Crossfade end handle"]')).not.toBeNull();
    await act(async () => (document.querySelector('[aria-label="Choose Swipe"]') as HTMLButtonElement).click());
    expect(document.querySelector('[aria-label="Swipe direction"]')).not.toBeNull();
    await act(async () => h.button("Update transition").click());
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!.props["transition"]).toMatchObject({ kind: "swipe", direction: "left" });
  });

  test("range playback starts at IN, stops at OUT, replays, then a playhead tap restores full timeline playback", async () => {
    const project = createEmptyProject();
    project.sequences[0]!.durationSec = 6;
    project.sequences[0]!.tracks[0]!.clips = [
      { id: "title", kind: "text", trackId: project.sequences[0]!.tracks[0]!.id, timelineStartSec: 0, durationSec: 4, props: { text: "Range fixture" } },
      { id: "after", kind: "text", trackId: project.sequences[0]!.tracks[0]!.id, timelineStartSec: 4, durationSec: 2, props: { text: "Outside range" } },
    ];
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    const animationWindow = h.window as unknown as Pick<typeof globalThis.window, "requestAnimationFrame" | "cancelAnimationFrame">;
    animationWindow.requestAnimationFrame = (cb) => { frames.set(++frameId, cb); return frameId; };
    animationWindow.cancelAnimationFrame = (id) => { frames.delete(id); };
    const advance = async (ms: number) => {
      const pending = [...frames.values()]; frames.clear();
      await act(async () => { for (const cb of pending) cb(performance.now() + ms); });
    };
    const ruler = document.querySelector<HTMLElement>(".video-ruler")!;
    Object.defineProperty(ruler, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 500, height: 32 }) });
    const wing = async (side: string, x: number) => act(async () => {
      const el = document.querySelector(`[aria-label="Range ${side} handle"]`)!;
      for (const type of ["pointerdown", "pointerup"]) el.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, altKey: true }) as unknown as Event);
    });
    await wing("out", 192); await wing("in", 96);
    const scrubber = document.querySelector<HTMLInputElement>('[aria-label="Timeline playhead"]')!;
    const play = () => document.querySelector<HTMLButtonElement>('.cutting-room__play')!;
    await act(async () => play().click());
    expect(Number(scrubber.value)).toBe(2);
    await advance(3000);
    expect(Number(scrubber.value)).toBe(4);
    expect(document.querySelector('[data-text-content]')?.textContent).toBe("Range fixture");
    expect(play().getAttribute("aria-label")).toBe("Play sequence preview");
    await act(async () => play().click());
    expect(Number(scrubber.value)).toBe(2);
    await advance(3000);
    expect(Number(scrubber.value)).toBe(4);
    const handle = document.querySelector<HTMLElement>('.video-ruler__playhead-handle')!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) handle.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 2, clientX: 192 }) as unknown as Event);
    });
    expect(document.querySelector('.video-ruler__range')!.getAttribute('aria-label')).toBe('Selected timeline range 4.00 to 4.00 seconds');
    expect(scrubber.min).toBe("0"); expect(scrubber.max).toBe("6");
    expect(document.querySelector('[data-text-content]')?.textContent).toBe("Outside range");
    await act(async () => play().click());
    expect(Number(scrubber.value)).toBe(4);
    await advance(3000);
    expect(Number(scrubber.value)).toBe(6);
    expect(play().getAttribute("aria-label")).toBe("Play sequence preview");
    await save(h.window); expect(h.writes).toHaveLength(0);
    expect(h.button("Undo").disabled).toBe(true);
  });

  test("Genie range playback advances and stops with animation frames suspended, without saving", async () => {
    const project = createEmptyProject();
    project.sequences[0]!.durationSec = 6;
    project.sequences[0]!.tracks[0]!.clips = [
      { id: "title", kind: "text", trackId: project.sequences[0]!.tracks[0]!.id, timelineStartSec: 0, durationSec: 6, props: { text: "Offscreen fixture" } },
    ];
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const scheduler = h.window as unknown as {
      requestAnimationFrame: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame: (id: number) => void;
      setTimeout: (callback: () => void, delay: number) => number;
      clearTimeout: (id: number) => void;
    };
    const timers = new Map<number, () => void>();
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    scheduler.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
    scheduler.cancelAnimationFrame = (key) => { frames.delete(key); };
    scheduler.setTimeout = (callback, delay) => {
      expect(delay).toBeCloseTo(1_000 / 30);
      timers.set(++id, callback as () => void); return id;
    };
    scheduler.clearTimeout = (key) => { timers.delete(key); };
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      expect(await h.control({ action: "preview-range", inSec: 1, outSec: 3 })).toMatchObject({ status: "ready" });
      const advance = async (ms: number) => {
        now += ms;
        const callbacks = [...timers.values()]; timers.clear();
        await act(async () => { callbacks.forEach((callback) => callback()); });
      };
      await advance(500);
      expect(document.querySelector<HTMLInputElement>('[aria-label="Timeline playhead"]')!.value).toBe("1.5");
      // Simulate a delayed timer too: never advance beyond OUT.
      await advance(4_000);
      expect(document.querySelector<HTMLInputElement>('[aria-label="Timeline playhead"]')!.value).toBe("3");
      expect(document.querySelector('[aria-label="Play sequence preview"]')).not.toBeNull();
      expect(frames.size).toBe(0); expect(timers.size).toBe(0);
      expect(h.writes).toHaveLength(0); expect(h.button("Undo").disabled).toBe(true);
    } finally { clock.mockRestore(); }
  });

  test("browsing libraries preserves the inspector draft, selection, playhead, document and history", async () => {
    const h = await receiptHarness();
    const clip = document.querySelector('[aria-label^="video clip clip-a"]')!;
    await act(async () => {
      clip.dispatchEvent(new h.window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new h.window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
    });
    const inspector = document.querySelector(".cutting-room__properties-content")!;
    const start = inspector.querySelector('input[type="number"]') as HTMLInputElement;
    const playhead = (document.querySelector('[aria-label="Timeline playhead"]') as HTMLInputElement).value;
    await act(async () => { start.focus(); start.value = "1.25"; });
    const original = h.current().content;
    for (const name of ["Transitions", "Audio", "Text", "Effects", "Media"]) {
      const button = document.querySelector(`[aria-label="${name} library"]`) as HTMLButtonElement;
      // Real focus transfer exercises the numeric draft's blur boundary.
      await act(async () => { button.focus(); button.click(); });
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelector(".cutting-room__properties-content")).toBe(inspector);
      expect(start.value).toBe("1.25");
      expect(document.querySelector(".video-clip--selected")).toBe(clip);
      expect((document.querySelector('[aria-label="Timeline playhead"]') as HTMLInputElement).value).toBe(playhead);
      expect(h.button("Undo").disabled).toBe(true);
      expect(h.current().content).toBe(original);
      expect(document.querySelectorAll('#video-toolbox-library')).toHaveLength(1);
    }
    await save(h.window);
    expect(h.writes).toHaveLength(0);
  });

  test("Text library inserts a real editable clip; category and selection survive shell round trips", async () => {
    const h = await receiptHarness(undefined, undefined, undefined, createEmptyProject());
    const text = document.querySelector('[aria-label="Text library"]') as HTMLButtonElement;
    await act(async () => text.click());
    await act(async () => (document.querySelector('[aria-label="Add a title clip"]') as HTMLButtonElement).click());
    const editor = document.querySelector('[aria-label="Clip text"]') as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    await act(async () => { editor.value = "An actual title"; editor.dispatchEvent(new h.window.Event("input", { bubbles: true }) as unknown as Event); });
    await save(h.window);
    const project = latestWrittenProject(h.writes);
    expect(project.sequences[0]!.tracks.flatMap((track) => track.clips).some((clip) => clip.props["text"] === "An actual title")).toBe(true);
    const inspector = document.querySelector(".cutting-room__properties-content");
    for (const label of ["Project", "Project", "Full width", "Full width"]) {
      await act(async () => h.button(label).click());
    }
    await act(async () => (document.querySelector('[data-workspace="generate"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[data-workspace="edit"]') as HTMLButtonElement).click());
    expect(text.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".cutting-room__properties-content")).toBe(inspector);
    expect(editor.value).toBe("An actual title");
    for (const name of ["Effects"]) {
      await act(async () => (document.querySelector(`[aria-label="${name} library"]`) as HTMLButtonElement).click());
      const choices = document.querySelector(`[aria-label="${name} choices"]`)!;
      expect(choices.textContent).toContain("not available in this build");
      expect(choices.querySelectorAll("button")).toHaveLength(0);
    }
  });

  test("fade library reaches inspector, applies once, saves 1.1, and Delete removes only the fade", async () => {
    const h = await receiptHarness();
    const clip = document.querySelector('[aria-label^="video clip clip-a"]')!;
    await act(async () => { for (const type of ["pointerdown", "pointerup"]) clip.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event); });
    await act(async () => (document.querySelector('[aria-label="Transitions library"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[aria-label="Choose Video fade in"]') as HTMLButtonElement).click());
    expect(h.button("Undo").disabled).toBe(true);
    expect(document.querySelector('[aria-label="Fade duration in seconds"]')).not.toBeNull();
    await act(async () => h.button("Apply fade").click());
    await save(h.window);
    expect(h.writes).toHaveLength(1);
    const parsed = parseVideoHtml(h.writes[0]!);
    expect(parsed.ok && parsed.document.manifest.version).toBe("1.1");
    const faded = latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips.find((item) => item.id === "clip-a")!;
    expect(faded.props["fades"]).toEqual({ videoIn: { startSec: 0, durationSec: 1 }, audioIn: { startSec: 0, durationSec: 1 } });
    const handle = clip.querySelector('[data-fade-key="videoIn"]')!;
    expect(handle).not.toBeNull();
    const pointer = (type: string, x: number) => handle.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 4, clientX: x }) as unknown as Event);
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 24); });
    await save(h.window);
    expect(h.writes).toHaveLength(1); // a gesture preview is not a durable edit
    await act(async () => handle.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
    await act(async () => pointer("pointerup", 24));
    await save(h.window); expect(h.writes).toHaveLength(1);
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 24); pointer("pointerup", 24); });
    await save(h.window); expect(h.writes).toHaveLength(2);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips.find((item) => item.id === "clip-a")!.props["fades"]).toMatchObject({ videoIn: { durationSec: 1.5 } });
    await act(async () => handle.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }) as unknown as Event));
    await save(h.window);
    const after = latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips;
    expect(after).toHaveLength(3);
    expect(after.find((item) => item.id === "clip-a")!.props["fades"]).toEqual({ audioIn: { startSec: 0, durationSec: 1 } });
    await act(async () => h.button("Undo").click());
    expect(clip.querySelector('[data-fade-key="videoIn"]')).not.toBeNull();
  });

  test("narrow category navigation opens one drawer; creating text opens and focuses its inspector", async () => {
    const h = await receiptHarness(undefined, undefined, undefined, createEmptyProject());
    // happy-dom emits the same media-query change used by the mounted shell.
    await act(async () => { h.window.happyDOM.setWindowSize({ width: 600, height: 800 }); await Promise.resolve(); });
    const text = document.querySelector('[aria-label="Text library"]') as HTMLButtonElement;
    await act(async () => { text.focus(); text.click(); });
    const library = document.querySelector('#video-toolbox-library')!;
    expect(library.getAttribute("aria-hidden")).toBe("false");
    await act(async () => (document.querySelector('[aria-label="Add a caption clip"]') as HTMLButtonElement).click());
    expect(document.querySelector('.cutting-room__properties')!.getAttribute("aria-hidden")).toBe("false");
    expect(library.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Clip text"]'));
    await act(async () => { text.focus(); text.click(); });
    expect(library.getAttribute("aria-hidden")).toBe("false");
    expect(document.querySelector('.cutting-room__properties')!.getAttribute("aria-hidden")).toBe("true");
  });

  test("dragging a linked audio/video selection changes lanes, saves once and undoes without losing clip types", async () => {
    const project = createEmptyProject();
    project.sequences[0]!.durationSec = 3;
    project.sequences[0]!.tracks = [
      { id: "top", kind: "caption", order: 0, clips: [] },
      { id: "middle", kind: "overlay", order: 1, clips: [] },
      { id: "sound", kind: "audio", order: 2, clips: [{ id: "a", trackId: "sound", kind: "audio", timelineStartSec: 1, durationSec: 2, linkedClipIds: ["v"], props: {} }] },
      { id: "picture", kind: "video", order: 3, clips: [{ id: "v", trackId: "picture", kind: "video", timelineStartSec: 1, durationSec: 2, linkedClipIds: ["a"], props: {} }] },
    ];
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const dispatch = (clip: Element, type: string, y: number, shiftKey = false) => clip.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 100, clientY: y, shiftKey }) as unknown as Event);
    const audio = document.querySelector('[aria-label^="audio clip a"]')!;
    const video = document.querySelector('[aria-label^="video clip v"]')!;
    await act(async () => { dispatch(audio, "pointerdown", 160); dispatch(audio, "pointerup", 160); });
    await act(async () => { dispatch(video, "pointerdown", 228, true); dispatch(video, "pointerup", 228, true); });
    await act(async () => { dispatch(video, "pointerdown", 228); dispatch(video, "pointermove", 92); dispatch(video, "pointerup", 92); });
    await save(h.window);
    const moved = latestWrittenProject(h.writes);
    expect(moved.sequences[0]!.tracks.map((track) => track.clips.map((clip) => [clip.id, clip.kind, clip.timelineStartSec]))).toEqual([[["a", "audio", 1]], [["v", "video", 1]], [], []]);
    expect(h.writes).toHaveLength(1);
    await act(async () => h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })));
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences).toEqual(project.sequences);
    expect(document.querySelector('select[aria-label="Add track"]')).toBeNull();
    await act(async () => (document.querySelector('[aria-label="Add track"]') as HTMLButtonElement).click());
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks.at(-1)!.name).toBe("Track 5");
  });
  test("range Cut/Copy/Paste keys and Edit menu preserve linked audio, Undo and saved source windows", async () => {
    const project = createEmptyProject();
    project.media = [{ id: "movie", kind: "video", ref: "movie.mp4", durationSec: 20 }];
    project.sequences[0]!.durationSec = 10;
    project.sequences[0]!.tracks = [
      { id: "audio", kind: "audio", order: 0, name: "Sound", clips: [{ id: "a", trackId: "audio", kind: "audio", mediaId: "movie", timelineStartSec: 0, durationSec: 10, sourceInSec: 3, sourceOutSec: 13, linkedClipIds: ["v"], props: {} }] },
      { id: "video", kind: "video", order: 1, name: "Picture", clips: [{ id: "v", trackId: "video", kind: "video", mediaId: "movie", timelineStartSec: 0, durationSec: 10, sourceInSec: 3, sourceOutSec: 13, linkedClipIds: ["a"], props: { muted: true } }] },
    ];
    const h = await receiptHarness(undefined, undefined, undefined, project);
    const key = async (value: string, metaKey = true, shiftKey = false) => act(async () => { h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: value, metaKey, shiftKey, bubbles: true, cancelable: true })); });
    const ruler = document.querySelector(".video-ruler") as HTMLElement;
    Object.defineProperty(ruler, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 600, height: 32 }) });
    const wing = async (side: string, x: number) => act(async () => {
      const element = document.querySelector(`[aria-label="Range ${side} handle"]`)!;
      element.dispatchEvent(new h.window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: x, clientY: 10, altKey: true }) as unknown as Event);
      element.dispatchEvent(new h.window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: x, clientY: 10, altKey: true }) as unknown as Event);
    });
    await wing("out", 192); await wing("in", 96);
    expect(document.querySelector(".video-timeline__scope")!.textContent).toContain("2.00–4.00s");
    await key("c"); expect(h.writes).toHaveLength(0);
    expect(document.querySelector(".video-timeline__clipboard")!.textContent).toContain("2 clips · 2.00s");
    await key("x"); await save(h.window);
    const cut = latestWrittenProject(h.writes);
    expect(cut.sequences[0]!.tracks.map((track) => track.clips.length)).toEqual([2, 2]);
    expect(cut.sequences[0]!.tracks[0]!.clips[1]!.sourceInSec).toBe(7);
    // Selecting a playback range now brings transport into that range. Move
    // back to occupied time deliberately before exercising collision refusal.
    await act(async () => h.button("↤").click());
    await key("v"); expect(document.body.textContent).toContain("Not enough space on Sound");
    expect(document.querySelector(".video-timeline__clipboard")!.textContent).toContain("2 clips · 2.00s");
    await act(async () => { ruler.dispatchEvent(new h.window.PointerEvent("pointerdown", { bubbles: true, clientX: 96 }) as unknown as Event); });
    await act(async () => { (document.querySelector('[aria-label="Timeline Edit menu"]') as HTMLButtonElement).click(); });
    const paste = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Paste at playhead")) as HTMLButtonElement;
    await act(async () => paste.click()); await save(h.window);
    const restored = latestWrittenProject(h.writes);
    expect(restored.sequences[0]!.tracks.map((track) => track.clips.length)).toEqual([3, 3]);
    expect(document.querySelectorAll(".video-clip--selected").length).toBe(2);
    await key("Delete", false); await save(h.window);
    expect(latestWrittenProject(h.writes).sequences).toEqual(cut.sequences);
    expect(document.querySelector(".video-timeline__clipboard")!.textContent).toContain("2 clips · 2.00s");
    await key("z"); await save(h.window);
    // History merges clip records by identity; array order is not timeline order.
    const restoredAfterUndo = latestWrittenProject(h.writes);
    for (const track of restoredAfterUndo.sequences[0]!.tracks) track.clips.sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    expect(restoredAfterUndo.sequences).toEqual(restored.sequences);
    await key("z"); await save(h.window); expect(latestWrittenProject(h.writes).sequences).toEqual(cut.sequences);
    await key("z"); await save(h.window); expect(latestWrittenProject(h.writes).sequences).toEqual(project.sequences);
    await key("z", true, true); await save(h.window); expect(latestWrittenProject(h.writes).sequences).toEqual(cut.sequences);
    await act(async () => root?.unmount()); root = createRoot(host!);
    await act(async () => { root!.render(createElement(VideoApp)); });
    expect(document.querySelector(".video-timeline__clipboard")).toBeNull();
    expect(document.querySelectorAll(".video-clip").length).toBe(4);
    await key("v"); expect(document.body.textContent).toContain("Copy or cut a timeline selection first");
  });

  test("clipboard keys leave text editing alone and refused cut retains the previous clipboard", async () => {
    const h = await receiptHarness();
    const element = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => {
      element.dispatchEvent(new h.window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }) as unknown as Event);
      element.dispatchEvent(new h.window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }) as unknown as Event);
    });
    await act(async () => h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true })));
    const priorClipboard = document.querySelector(".video-timeline__clipboard")!.textContent;
    const input = document.createElement("textarea"); document.body.append(input); input.focus();
    for (const key of ["x", "c", "v"]) {
      const event = new h.window.KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true });
      await act(async () => input.dispatchEvent(event as unknown as Event));
      expect(event.defaultPrevented).toBe(false);
    }
    input.remove();
    await h.patch((project) => { project.sequences[0]!.tracks[0]!.locked = true; });
    await act(async () => h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "x", metaKey: true, bubbles: true, cancelable: true })));
    expect(document.querySelector(".video-timeline__clipboard")!.textContent).toBe(priorClipboard);
    expect(h.writes).toHaveLength(0);
  });

  test("first-video modal adopts the source rate, remembers policy outside the document, and leaves later rates alone", async () => {
    const stored: Record<string, unknown> = {};
    const preferences: NautiloAppBridge["preferences"] = {
      get: async <T,>(key: string) => (stored[key] ?? (key === "video.firstSourceRate" ? { decision: "ask" } : { enabled: true })) as T,
      set: async <T,>(key: string, value: T) => { stored[key] = value; return value; },
      subscribe: () => () => undefined,
    };
    const empty: NautiloDocumentEnvelope = { content: serializeVideoHtml(createDefaultManifest(), createEmptyProject()), path: "fixture.video.html", baseSha256: "base", baseRevision: 1 };
    const h = await receiptHarness(preferences, Promise.resolve(empty));
    let rate = 60;
    h.bridge.media = {
      importVideo: async () => ({ kind: "ready", mediaKind: "video", mediaRef: `source-${rate}.mp4`, label: "Source", durationSec: 4, frameRate: { numerator: rate, denominator: 1 } }),
      openPreview: async () => ({ kind: "unavailable", code: "unsupported_environment" }),
      closePreview: () => undefined,
      exportVideo: async () => ({ kind: "unavailable", code: "unsupported_environment" }),
    };
    await act(async () => { h.button("Add media").click(); await Promise.resolve(); });
    expect(document.querySelector("dialog")?.textContent).toContain("Match this project to your video?");
    const remember = document.querySelector('dialog input[type="checkbox"]') as HTMLInputElement;
    await act(async () => remember.click());
    await act(async () => { h.button("Change project to 60 fps").click(); await Promise.resolve(); });
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.frameRate).toEqual({ numerator: 60, denominator: 1 });
    expect(stored["video.firstSourceRate"]).toEqual({ decision: "adopt-source-rate" });
    expect(h.writes.at(-1)).not.toContain("firstSourceRate");
    rate = 24;
    await act(async () => { h.button("Add media").click(); await Promise.resolve(); });
    expect(document.querySelector("dialog")).toBeNull();
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.frameRate).toEqual({ numerator: 60, denominator: 1 });
    expect(latestWrittenProject(h.writes).media).toHaveLength(2);
  });

  test("reopening restores a retained Genie receipt without a live patch event", async () => {
    const before = structuredClone(fixtureProject);
    before.sequences[0]!.tracks[0]!.clips[1]!.props = { label: "Before" };
    const after = structuredClone(before);
    after.sequences[0]!.tracks[0]!.clips[1]!.props = { label: "Genie" };
    const manifest = createDefaultManifest();
    const content = serializeVideoHtml(manifest, after);
    const h = await receiptHarness(undefined, Promise.resolve({ content, path: "fixture.video.html", baseSha256: "base", baseRevision: 1 }), async () => ({
      kind: "ready", operationId: "journal-operation", author: { kind: "agent", displayName: "Genie" },
      before: { content: serializeVideoHtml(manifest, before), sha256: "before" }, after: { content, sha256: "after" }, currentSha256: "base",
    }));
    expect(document.body.textContent).toContain("Recovered from retained document history");
    expect(h.button("Undo").disabled).toBe(true);
    await act(async () => h.button("Revert Genie edit").click());
    await save(h.window);
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.clips[1]!.props["label"]).toBe("Before");
    expect(h.button("Undo").disabled).toBe(true);
  });

  test("late recovery cannot replace a newer live Genie receipt", async () => {
    let release!: (value: Awaited<ReturnType<NonNullable<NautiloAppBridge["document"]["authoredChange"]>>>) => void;
    const pending = new Promise<Awaited<ReturnType<NonNullable<NautiloAppBridge["document"]["authoredChange"]>>>>((resolve) => { release = resolve; });
    const h = await receiptHarness(undefined, undefined, () => pending);
    const initial = h.current();
    const parsed = parseVideoHtml(initial.content);
    if (!parsed.ok) throw new Error(parsed.error);
    const earlier = structuredClone(parsed.document.project);
    earlier.metadata = { ...earlier.metadata, title: "Earlier retained title" };
    await h.patch((project) => { project.sequences[0]!.tracks[0]!.clips[0]!.props = { label: "Latest live" }; });
    await act(async () => { release({ kind: "ready", operationId: "old-retained", author: { kind: "agent", displayName: "Genie" },
      before: { content: serializeVideoHtml(parsed.document.manifest, earlier), sha256: "before" },
      after: { content: initial.content, sha256: "after" }, currentSha256: initial.baseSha256! }); await Promise.resolve(); });
    expect(document.querySelector('[aria-label="Latest Genie edit"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Recovered from retained document history");
  });
  test("rename during initial loading does not cancel the only document read", async () => {
    let release!: (value: NautiloDocumentEnvelope) => void;
    const pending = new Promise<NautiloDocumentEnvelope>((resolve) => { release = resolve; });
    const h = await receiptHarness(undefined, pending);
    await h.emit({ type: "renamed", path: "renamed.video.html" });
    await act(async () => { release(h.current()); await Promise.resolve(); });
    expect(document.querySelector('[aria-label^="video clip clip-a"]')).not.toBeNull();
    expect(h.button("Undo").disabled).toBe(true);
  });

  test("a superseded initial read failure cannot replace successfully refreshed content", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<NautiloDocumentEnvelope>((_resolve, fail) => { reject = fail; });
    const h = await receiptHarness(undefined, pending);
    await h.emit({ type: "changed" });
    await act(async () => { reject(new Error("Old request failed")); await Promise.resolve(); });
    expect(document.querySelector('[aria-label^="video clip clip-a"]')).not.toBeNull();
    expect(host!.textContent).not.toContain("Old request failed");
  });

  test("rename and duplicate patches do not suppress a pending generic content refresh", async () => {
    const h = await receiptHarness();
    const duplicate = await h.patch((project) => { project.metadata = { title: "First" }; });
    const parsed = parseVideoHtml(h.current().content); if (!parsed.ok) throw new Error(parsed.error);
    parsed.document.project.sequences[0]!.tracks[0]!.name = "Fresh read";
    const latest = { ...h.current(), content: serializeVideoHtml(parsed.document.manifest, parsed.document.project), baseSha256: "fresh", baseRevision: 3 };
    let release!: (value: NautiloDocumentEnvelope) => void;
    h.delayRead(new Promise((resolve) => { release = resolve; }));
    await h.emit({ type: "changed" });
    await h.emit({ type: "renamed", path: "renamed.video.html" });
    await h.emit(duplicate);
    await act(async () => { release(latest); await Promise.resolve(); });
    expect([...document.querySelectorAll(".video-track__name")].some((button) => button.textContent === "Fresh read")).toBe(true);
  });

  test("Genie Revert preserves dirty human work, stays outside Undo, saves and reopens", async () => {
    const h = await receiptHarness();
    await h.deleteClip("clip-a");
    const event = await h.patch((project) => { project.metadata = { title: "Genie title" }; });
    expect(host!.textContent).toContain("Genie edited the video project.");
    expect(h.button("Revert Genie edit").disabled).toBe(false);
    expect(h.button("Undo").disabled).toBe(false);
    await act(async () => { h.button("Revert Genie edit").click(); h.button("Revert Genie edit")?.click(); });
    expect(host!.textContent).toContain("Revert applied to your draft. It is not saved yet.");
    expect(h.button("Undo").disabled).toBe(false);
    await save(h.window);
    expect(h.writes).toHaveLength(1);
    const saved = latestWrittenProject(h.writes);
    expect(saved.metadata?.title).toBeUndefined();
    expect(saved.sequences[0]!.tracks[0]!.clips.some((clip) => clip.id === "clip-a")).toBe(false);
    await h.emit(event);
    expect(h.button("Revert Genie edit")).toBeUndefined();
    expect(host!.textContent).toContain("Your current draft is saved");
    await act(async () => root?.unmount()); root = createRoot(host!);
    await act(async () => { root?.render(createElement(VideoApp)); await Promise.resolve(); });
    expect(document.querySelector('[aria-label^="video clip clip-a"]')).toBeNull();
    expect(h.button("Undo").disabled).toBe(true);
    expect(document.querySelector('[aria-label="Latest Genie edit"]')).toBeNull();
  });

  test("later human overlap refuses Revert without deleting human history or writing", async () => {
    const h = await receiptHarness();
    await h.patch((project) => { project.sequences[0]!.tracks[0]!.clips[1]!.props = { note: "Genie edit" }; });
    await h.deleteClip("clip-a");
    await act(async () => h.button("Revert Genie edit").click());
    expect(host!.textContent).toContain("Cannot revert this Genie edit. This clip changed elsewhere. Nothing was overwritten.");
    expect(document.querySelector('[aria-label^="video clip clip-a"]')).toBeNull();
    expect(h.button("Undo").disabled).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  test("same-target dirty conflict disables Revert and preserves the draft", async () => {
    const h = await receiptHarness();
    await h.deleteClip("clip-a");
    await h.patch((project) => { project.sequences[0]!.tracks[0]!.clips[1]!.props = { note: "Genie edit" }; });
    expect(h.button("Revert Genie edit").disabled).toBe(true);
    expect(document.querySelector('[aria-label^="video clip clip-a"]')).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  test("a delayed generic reread cannot overwrite two subsequent exact patches", async () => {
    const h = await receiptHarness();
    const old = h.current();
    let release!: (value: NautiloDocumentEnvelope) => void;
    h.delayRead(new Promise((resolve) => { release = resolve; }));
    await h.emit({ type: "changed" });
    await h.patch((project) => { project.metadata = { title: "First patch" }; });
    await h.patch((project) => { project.sequences[0]!.tracks[0]!.name = "Second patch"; });
    await act(async () => { release(old); await Promise.resolve(); });
    await act(async () => h.button("Revert Genie edit").click());
    await save(h.window);
    expect(latestWrittenProject(h.writes).metadata?.title).toBe("First patch");
    expect(latestWrittenProject(h.writes).sequences[0]!.tracks[0]!.name).toBeUndefined();
  });

  test("receipt dismissal and device preference do not mutate the document or get undone by a stale read", async () => {
    let release!: (value: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((resolve) => { release = resolve; });
    const preferences: NautiloAppBridge["preferences"] = {
      get: async <T,>() => await pending as T,
      set: async <T,>(_key: "video.agentReceipts", value: T) => value,
      subscribe: () => () => undefined,
    };
    const h = await receiptHarness(preferences);
    await h.patch((project) => { project.metadata = { title: "Genie" }; });
    await act(async () => h.button("Dismiss").click());
    expect(document.querySelector('[aria-label="Latest Genie edit"]')).toBeNull();
    await act(async () => h.button("Show latest edit").click());
    expect(document.querySelector('[aria-label="Latest Genie edit"]')).not.toBeNull();
    await act(async () => { h.button("Genie notices: On").click(); await Promise.resolve(); });
    await act(async () => { release({ enabled: true }); await Promise.resolve(); });
    expect(h.button("Genie notices: Off")).toBeDefined();
    expect(document.querySelector('[aria-label="Latest Genie edit"]')).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  test("export shows live progress, local save destination, and actionable authentication failure in the editor", async () => {
    const window = installDom();
    const content = serializeVideoHtml(createDefaultManifest(), fixtureProject);
    type ExportOptions = Parameters<NonNullable<NautiloAppBridge["media"]>["exportVideo"]>[1];
    let options: ExportOptions;
    let finish!: (value: { kind: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } }) => void;
    const completed = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
    let attempts = 0;
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      document: { read: async () => ({ content, path: "test_video.html", baseSha256: "a".repeat(64), baseRevision: 1 }), write: async () => ({ kind: "conflict" }) },
      context: { set: () => undefined },
      media: {
        getExportCapabilities: async () => ({ workspace: true }),
        importVideo: async () => ({ kind: "unavailable", code: "cancelled" }), openPreview: async () => ({ kind: "unavailable", code: "unused" }), closePreview: () => undefined,
        exportVideo: async (request, nextOptions) => {
          expect(request).toEqual({ document: { sha256: "a".repeat(64), revision: 1 }, publishToWorkspace: attempts > 0, exportSettings: { resolution: "1080p", quality: "balanced", audioBitrateKbps: 192 } });
          options = nextOptions;
          const attempt = ++attempts;
          return attempt === 1
            ? completed
            : attempt === 2
              ? { kind: "unavailable", code: "not_signed_in" }
              : attempt === 3
                ? { kind: "unavailable", code: "text_overflow" }
                : attempt === 4
                  ? { kind: "succeeded", label: "cut.mp4", sizeBytes: 1_048_576, warnings: [], workspace: { status: "unknown", path: "exports/cut.mp4" } }
                  : { kind: "succeeded", label: "cut.mp4", sizeBytes: 1_048_576, warnings: [] };
        },
      },
    } satisfies NautiloAppBridge;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root?.render(createElement(VideoApp)); await Promise.resolve(); await Promise.resolve(); });
    const exportButton = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Export video")!;
    const confirmExport = () => document.querySelector<HTMLButtonElement>('.video-export-dialog button[type="submit"]')!.click();
    await act(async () => { exportButton().click(); });
    const publishCheckbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(publishCheckbox.checked).toBe(false);
    expect(host.textContent).toContain("Also save a copy to Workspace");
    expect(attempts).toBe(0);
    await act(async () => { confirmExport(); await Promise.resolve(); });
    expect(host.textContent).toContain("Preparing the saved snapshot for export");
    expect(host.textContent).toContain("Cancel export");
    await act(async () => { options?.onProgress?.({ stage: "rendering", processedTimeUs: 3_000_000 }); });
    expect(host.textContent).toContain("Rendering the saved snapshot… 50%");
    await act(async () => { options?.onProgress?.({ stage: "saving" }); });
    expect(host.textContent).toContain("Saving MP4");
    await act(async () => { options?.onProgress?.({ stage: "publishing" }); });
    expect(host.textContent).toContain("Saving to Workspace…");
    await act(async () => { finish({ kind: "succeeded", label: "cut.mp4", sizeBytes: 1_048_576, warnings: [], workspace: { status: "published", path: "exports/cut.mp4", artifactId: "10000000-0000-4000-8000-000000000003" } }); await completed; });
    expect(host.textContent).toContain("Saved cut.mp4 to your computer (1.0 MB).");
    expect(host.textContent).toContain("Also saved to Workspace at exports/cut.mp4.");
    await act(async () => { exportButton().click(); await Promise.resolve(); });
    await act(async () => { (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { confirmExport(); await Promise.resolve(); });
    expect(host.textContent).toContain("Sign in again to download this project's media, then export again.");
    await act(async () => { exportButton().click(); await Promise.resolve(); });
    await act(async () => { confirmExport(); await Promise.resolve(); });
    expect(host.textContent).toContain("Text does not fit in the frame. Shorten it or split it into more clips");
    expect(host.textContent).toContain("No MP4 was saved.");
    await act(async () => { exportButton().click(); await Promise.resolve(); });
    await act(async () => { confirmExport(); await Promise.resolve(); });
    expect(host.textContent).toContain("Check exports/cut.mp4 in Workspace before retrying.");
    await act(async () => { exportButton().click(); await Promise.resolve(); });
    await act(async () => { confirmExport(); await Promise.resolve(); });
    expect(host.textContent).toContain("Workspace publication was not confirmed; check Workspace before retrying.");
  });

  test("Current Folder hides unsupported Workspace publication and still exports locally", async () => {
    const window = installDom(); let exports = 0;
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      context: { set: () => undefined },
      document: { read: async () => ({ content: serializeVideoHtml(createDefaultManifest(), fixtureProject), path: "/folder/film.video.html", baseSha256: "a".repeat(64), baseRevision: null }), write: async () => ({ kind: "saved" }) },
      media: {
        getExportCapabilities: async () => ({ workspace: false }),
        importVideo: async () => ({ kind: "unavailable", code: "unused" }), openPreview: async () => ({ kind: "unavailable", code: "unused" }), closePreview: () => undefined,
        exportVideo: async (request) => { exports++; expect(request.publishToWorkspace).toBe(false); return { kind: "succeeded", label: "film.mp4", sizeBytes: 1024, warnings: [] }; },
      },
    } satisfies NautiloAppBridge;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root?.render(createElement(VideoApp)); await Promise.resolve(); });
    expect(host.textContent).not.toContain("Also save to Workspace");
    await act(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent === "Export video")!.click(); await Promise.resolve(); });
    expect(exports).toBe(0);
    expect(document.querySelector(".video-export-dialog")?.textContent).not.toContain("Workspace");
    await act(async () => { document.querySelector<HTMLButtonElement>('.video-export-dialog button[type="submit"]')!.click(); });
    expect(exports).toBe(1);
    expect(host.textContent).toContain("Saved film.mp4 to your computer");
  });

  test("saves a Workspace copy from the flushed Current Folder snapshot and opens it only on explicit request", async () => {
    const window = installDom(); const content = serializeVideoHtml(createDefaultManifest(), fixtureProject); let opens = 0; let savedSha = ""; let copies = 0;
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      context: { set: () => undefined },
      document: { read: async () => ({ content, path: "/folder/film.video.html", baseSha256: "a".repeat(64), baseRevision: null }), write: async () => ({ kind: "saved", sha256: "a".repeat(64) }) },
      media: {
        getExportCapabilities: async () => ({ workspace: false }), getWorkspaceCopyCapabilities: async () => ({ available: true, roomLabel: "Film Room" }),
        importVideo: async () => ({ kind: "unavailable", code: "unused" }), openPreview: async () => ({ kind: "unavailable", code: "unused" }), closePreview: () => undefined,
        exportVideo: async () => ({ kind: "cancelled" }),
        saveWorkspaceCopy: async (input) => {
          savedSha = input.sha256; copies++;
          if (copies > 1) return { kind: "unknown", code: "authority_changed", retainedPaths: [] };
          return { kind: "succeeded", path: "video-projects/run/film.video.html", roomLabel: "Film Room", mediaCount: 2 };
        },
        openWorkspaceCopy: async () => { opens++; return { opened: true }; },
      },
    } satisfies NautiloAppBridge;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root?.render(createElement(VideoApp)); await Promise.resolve(); await Promise.resolve(); });
    const saveCopy = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Save a Workspace copy"));
    expect(saveCopy?.textContent).toContain("Film Room");
    await act(async () => { saveCopy?.click(); await Promise.resolve(); });
    expect(savedSha).toBe("a".repeat(64)); expect(opens).toBe(0);
    expect(host.textContent).toContain("Your Current Folder project is unchanged");
    const open = [...document.querySelectorAll("button")].find((button) => button.textContent === "Open Workspace copy");
    await act(async () => { open?.click(); await Promise.resolve(); }); expect(opens).toBe(1);
    await act(async () => { saveCopy?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("A copy may already exist in the previous Workspace destination");
    expect(host.textContent).toContain("check before retrying");
    expect(host.textContent).not.toContain("Open Workspace copy");
    expect(copies).toBe(2); expect(opens).toBe(1);
  });

  test("caption text is multiline, edits through the command/save spine and survives reopening", async () => {
    const win = installDom(); const project = createEmptyProject(); const track = project.sequences[0]!.tracks[2]!;
    track.clips = [{ id: "caption-edit", kind: "caption", trackId: track.id, timelineStartSec: 0, durationSec: 3, props: { text: "Before" } }];
    let content = serializeVideoHtml(createDefaultManifest(), project); const writes: string[] = [];
    (win as unknown as { nautiloApp: NautiloAppBridge }).nautiloApp = {
      document: {
        read: async () => ({ content, path: "captions.html", baseSha256: "a".repeat(64), baseRevision: 1 }),
        write: async (input) => { content = typeof input === "string" ? input : input.content; writes.push(content); return { kind: "saved", sha256: "b".repeat(64), revision: 2, persistedContent: content }; },
      }, context: { set: () => undefined },
    } satisfies NautiloAppBridge;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(VideoApp)); });
    const clip = document.querySelector('[aria-label^="caption clip caption-edit"]');
    expect(clip).not.toBeNull();
    await act(async () => {
      clip!.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      clip!.dispatchEvent(new win.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
    });
    const textarea = document.querySelector("textarea[aria-label='Clip text']") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    const text = "Edited first line\nSecond line <literal>";
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
    await save(win);
    expect(latestWrittenProject(writes).sequences[0]!.tracks[2]!.clips[0]!.props["text"]).toBe(text);
    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await act(async () => { root!.render(createElement(VideoApp)); });
    expect(document.querySelector("[data-text-content]")!.textContent).toBe(text);
  });

  test("guards a pending native import and admits audio/images only to the Media Bin", async () => {
    const window = installDom();
    const initialContent = serializeVideoHtml(createDefaultManifest(), createEmptyProject());
    const writes: string[] = [];
    let importCalls = 0;
    let resolveAudio!: (value: {
      kind: "ready"; mediaKind: "audio"; mediaRef: string; label: string; durationSec: number;
      source: { kind: "workspace-artifact"; artifactId: string; path: string };
    }) => void;
    const audioImport = new Promise<Parameters<typeof resolveAudio>[0]>((resolve) => { resolveAudio = resolve; });
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      document: {
        read: async () => ({ content: initialContent, path: "fixture.video.html", baseSha256: "base", baseRevision: 1 }),
        write: async (next) => {
          const content = typeof next === "string" ? next : next.content;
          writes.push(content);
          return { kind: "saved", sha256: `saved-${writes.length}`, revision: writes.length + 1, persistedContent: content };
        },
      },
      context: { set: () => undefined },
      media: {
        importVideo: async () => {
          importCalls += 1;
          if (importCalls === 1) return audioImport;
          return {
            kind: "ready" as const,
            mediaKind: "image" as const,
            mediaRef: "video-imports/still.png",
            label: "Still",
            source: { kind: "workspace-artifact" as const, artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "video-imports/still.png" },
          };
        },
        openPreview: async () => ({ kind: "ready", url: "https://media.invalid/source", mimeType: "audio/wav", sizeBytes: 10, revokeToken: "preview", waveform: { peaks: [0, 0.5, 1, 0], samplesPerSecond: 2 } }),
        closePreview: () => undefined,
        exportVideo: async () => ({ kind: "unavailable", code: "unused" }),
      },
    } satisfies NautiloAppBridge;

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(VideoApp));
      await Promise.resolve();
      await Promise.resolve();
    });
    const importButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add media") as HTMLButtonElement;
    await act(async () => {
      importButton.click();
      importButton.click();
      await Promise.resolve();
    });
    expect(importCalls).toBe(1);
    expect(importButton.disabled).toBe(true);

    await act(async () => {
      resolveAudio({
        kind: "ready",
        mediaKind: "audio",
        mediaRef: "video-imports/voice.wav",
        label: "Voice",
        durationSec: 2.5,
        source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53", path: "video-imports/voice.wav" },
      });
      await audioImport;
      await Promise.resolve();
    });
    expect(importButton.disabled).toBe(false);
    expect(document.querySelector(".video-media-bin audio")?.getAttribute("src")).toBe("https://media.invalid/source");
    expect(document.querySelector('.video-media-bin [aria-label="Audio waveform"]')).not.toBeNull();
    expect(document.querySelector(".video-media-bin")?.textContent).toContain("Voiceaudio · 2.5s");
    await act(async () => { importButton.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(importCalls).toBe(2);
    expect(document.querySelector(".video-media-bin")?.textContent).toContain("Stillimage");

    await save(window);
    const saved = latestWrittenProject(writes);
    expect(saved.media).toHaveLength(2);
    expect(saved.media[0]).toMatchObject({ kind: "audio", durationSec: 2.5 });
    expect(saved.media[1]).toMatchObject({ kind: "image" });
    expect(saved.media[0]).not.toHaveProperty("frameRate");
    expect(saved.media[1]).not.toHaveProperty("durationSec");
    expect(saved.media[1]).not.toHaveProperty("frameRate");
    expect(saved.sequences[0]!.frameRate).toEqual({ numerator: 30, denominator: 1 });
    expect(saved.sequences[0]!.tracks.flatMap((track) => track.clips)).toHaveLength(0);
  });

  test("commits an atomic left trim and preserves both clips through a selected group drag", async () => {
    const window = installDom();
    const initialContent = serializeVideoHtml(createDefaultManifest(), fixtureProject);
    const writes: string[] = [];
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      document: {
        read: async () => ({ content: initialContent, path: "fixture.video.html", baseSha256: "base", baseRevision: 1 }),
        write: async (next) => {
          const content = typeof next === "string" ? next : next.content;
          writes.push(content);
          return { kind: "saved", sha256: `saved-${writes.length}`, revision: writes.length + 1, persistedContent: content };
        },
      },
      context: { set: () => undefined },
    } satisfies NautiloAppBridge;

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(VideoApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    const clipA = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    const leftHandle = clipA.querySelector('[aria-label="Trim clip start by one frame"]') as HTMLElement;
    expect(clipA).toBeTruthy();
    expect(leftHandle).toBeTruthy();

    await act(async () => {
      leftHandle.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 10 }) as unknown as Event);
      leftHandle.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 48, clientY: 10 }) as unknown as Event);
      leftHandle.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 48, clientY: 10 }) as unknown as Event);
    });
    await save(window);

    const trimmed = latestWrittenProject(writes);
    const trimmedA = trimmed.sequences[0]!.tracks[0]!.clips.find((clip) => clip.id === "clip-a")!;
    const neighbor = trimmed.sequences[0]!.tracks[0]!.clips.find((clip) => clip.id === "neighbor")!;
    const followingNeighbor = trimmed.sequences[0]!.tracks[0]!.clips.find((clip) => clip.id === "following-neighbor")!;
    expect(trimmedA).toMatchObject({ timelineStartSec: 3, durationSec: 1, sourceInSec: 1, sourceOutSec: 2 });
    expect(neighbor).toMatchObject({ timelineStartSec: 0, durationSec: 2, sourceInSec: 0, sourceOutSec: 2 });
    expect(followingNeighbor).toMatchObject({ timelineStartSec: 4, durationSec: 2, sourceInSec: 0, sourceOutSec: 2 });

    const currentA = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    const clipB = document.querySelector('[aria-label^="video clip clip-b"]') as HTMLElement;
    await act(async () => {
      currentA.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 10, clientY: 10 }) as unknown as Event);
      currentA.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 10, clientY: 10 }) as unknown as Event);
      clipB.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 10, clientY: 70, shiftKey: true }) as unknown as Event);
      clipB.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 3, clientX: 10, clientY: 70, shiftKey: true }) as unknown as Event);
    });
    await act(async () => {
      currentA.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 4, clientX: 10, clientY: 10 }) as unknown as Event);
      currentA.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 4, clientX: -38, clientY: 10, altKey: true }) as unknown as Event);
      currentA.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 4, clientX: -38, clientY: 10, altKey: true }) as unknown as Event);
    });
    await save(window);

    const moved = latestWrittenProject(writes);
    const movedClips = moved.sequences[0]!.tracks.flatMap((track) => track.clips);
    expect(movedClips.find((clip) => clip.id === "clip-a")).toMatchObject({ timelineStartSec: 2, durationSec: 1, sourceInSec: 1, sourceOutSec: 2 });
    expect(movedClips.find((clip) => clip.id === "clip-b")).toMatchObject({ timelineStartSec: 2, durationSec: 2, sourceInSec: 0, sourceOutSec: 2 });
    expect(movedClips.find((clip) => clip.id === "neighbor")).toMatchObject({ timelineStartSec: 0, durationSec: 2 });
    expect(movedClips.find((clip) => clip.id === "following-neighbor")).toMatchObject({ timelineStartSec: 4, durationSec: 2 });

    const scrubber = document.querySelector('[aria-label="Timeline playhead"]') as HTMLInputElement;
    expect(Number(scrubber.step)).toBeCloseTo(1 / 30);
    const jumpEnd = document.querySelector('[aria-label="Jump playhead to end"]') as HTMLButtonElement;
    const play = document.querySelector('[aria-label="Play sequence preview"]') as HTMLButtonElement;
    await act(async () => jumpEnd.click());
    expect(Number(scrubber.value)).toBe(6);
    await act(async () => play.click());
    expect(Number(scrubber.value)).toBe(0);
  });

  test("keeps human undo across a clean external refresh and preserves the external edit", async () => {
    const window = installDom();
    let currentContent = serializeVideoHtml(createDefaultManifest(), fixtureProject);
    let currentSha = "base";
    let currentRevision = 1;
    const writes: string[] = [];
    let onChange: ((event: NautiloDocumentChangedEvent) => void) | null = null;
    (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = {
      document: {
        read: async () => ({ content: currentContent, path: "fixture.video.html", baseSha256: currentSha, baseRevision: currentRevision }),
        write: async (next) => {
          currentContent = typeof next === "string" ? next : next.content;
          currentRevision += 1;
          currentSha = `saved-${currentRevision}`;
          writes.push(currentContent);
          return { kind: "saved", sha256: currentSha, revision: currentRevision, persistedContent: currentContent };
        },
        onChange: (listener) => { onChange = listener; return () => { onChange = null; }; },
      },
      context: { set: () => undefined },
    } satisfies NautiloAppBridge;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(VideoApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    const clip = document.querySelector('[aria-label^="video clip clip-a"]') as HTMLElement;
    await act(async () => {
      clip.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      clip.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }) as unknown as Event);
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    await save(window);
    expect(latestWrittenProject(writes).sequences[0]!.tracks[0]!.clips.some((entry) => entry.id === "clip-a")).toBe(false);

    const scrubber = document.querySelector('[aria-label="Timeline playhead"]') as HTMLInputElement;
    const jumpEnd = document.querySelector('[aria-label="Jump playhead to end"]') as HTMLButtonElement;
    await act(async () => jumpEnd.click());

    const external = structuredClone(latestWrittenProject(writes));
    external.metadata = { ...external.metadata, title: "External title" };
    currentContent = serializeVideoHtml(createDefaultManifest(), external);
    currentRevision += 1;
    currentSha = `external-${currentRevision}`;
    await act(async () => {
      onChange?.({ type: "changed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(Number(scrubber.value)).toBe(6);

    const undo = [...document.querySelectorAll("button")].find((button) => button.textContent === "Undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    expect((document.querySelectorAll(".video-banner--error")[0] as HTMLElement | undefined)?.textContent).toBeUndefined();
    expect(undo.disabled).toBe(true);
    await save(window);
    expect(writes.map((content) => {
      const parsed = parseVideoHtml(content);
      return parsed.ok ? parsed.document.project.metadata?.title : "invalid";
    })).toEqual([undefined, "External title"]);
    const undone = latestWrittenProject(writes);
    expect(undone.metadata?.title).toBe("External title");
    expect(undone.sequences[0]!.tracks[0]!.clips.some((entry) => entry.id === "clip-a")).toBe(true);
  });
});

test("shared picker admits and saves a batch without timeline clips, with dismissible partial failures", async () => {
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ pick: async () => ({ kind: "ready", imports: ["first", "second"].map((name, i) => ({ kind: "ready", mediaKind: "image", mediaRef: `media/${name}.png`, label: name, source: { kind: "workspace-artifact", artifactId: `48a0266d-b1c2-4ffd-9c10-2865bea8fc5${i}`, path: `media/${name}.png` } })), references: [], mediaIds: [], failures: [{ label: "Broken file", code: "decode_failed" }] }) }));
  await h.control({ action: "import-media" });
  await act(async () => { await Promise.resolve(); });
  const saved = latestWrittenProject(h.writes);
  expect(saved.media.map(asset => asset.label)).toEqual(["first", "second"]);
  expect(saved.sequences).toEqual(fixtureProject.sequences);
  expect(document.body.textContent).toContain("Broken file (decode_failed)");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss media message"]')!.click());
  expect(document.body.textContent).not.toContain("Broken file (decode_failed)");
});

test("shared picker cancellation and empty selection leave no notice and allow another import", async () => {
  let calls = 0;
  const h = await receiptHarness(undefined, undefined, undefined, fixtureProject, undefined, nativeMediaStub({ pick: async () => ++calls === 1 ? { kind: "unavailable", code: "cancelled" } : { kind: "ready", imports: [], references: [], mediaIds: [], failures: [] } }));
  await h.control({ action: "import-media" });
  expect(document.body.textContent).not.toContain("Import cancelled");
  expect(document.querySelector('[aria-label="Dismiss media message"]')).toBeNull();
  await h.control({ action: "import-media" });
  expect(calls).toBe(2);
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import?.stage).toBe("succeeded");
  expect(h.writes).toHaveLength(0);
});

test("batch waits for one first-source rate decision then saves both clips only to the bin", async () => {
  const h = await receiptHarness(undefined, undefined, undefined, createEmptyProject(), undefined, nativeMediaStub({ pick: async () => ({ kind: "ready", imports: ["first", "second"].map((name, i) => ({ kind: "ready", mediaRef: `media/${name}.mp4`, label: name, durationSec: 4, frameRate: { numerator: 60, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: `48a0266d-b1c2-4ffd-9c10-2865bea8fc5${i}`, path: `media/${name}.mp4` } })), references: [], mediaIds: [], failures: [] }) }));
  const first = parseMediaOperationsResult(await h.control({ action: "import-media" }))!;
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import?.stage).toBe("awaiting-rate");
  expect(h.writes).toHaveLength(0);
  await h.control({ action: "choose-import-rate", operationId: first.import!.id, decision: "adopt-source-rate" });
  const saved = latestWrittenProject(h.writes);
  expect(saved.media).toHaveLength(2);
  expect(saved.sequences[0]!.frameRate).toEqual({ numerator: 60, denominator: 1 });
  expect(saved.sequences[0]!.tracks.every(track => track.clips.length === 0)).toBe(true);
});

test("cancelling the batch frame-rate question releases the import operation", async () => {
  const h = await receiptHarness(undefined, undefined, undefined, createEmptyProject(), undefined, nativeMediaStub({ pick: async () => ({ kind: "ready", imports: [{ kind: "ready", mediaRef: "media/first.mp4", label: "first", durationSec: 4, frameRate: { numerator: 60, denominator: 1 }, source: { kind: "workspace-artifact", artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc50", path: "media/first.mp4" } }], references: [], mediaIds: [], failures: [] }) }));
  const first = parseMediaOperationsResult(await h.control({ action: "import-media" }))!;
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import?.stage).toBe("awaiting-rate");
  await h.control({ action: "cancel-import", operationId: first.import!.id });
  expect(parseMediaOperationsResult(await h.control({ action: "inspect-media" }))!.import?.stage).toBe("cancelled");
  expect(document.querySelector('[aria-label="Dismiss media message"]')).toBeNull();
  expect(h.writes).toHaveLength(0);
  expect(parseMediaOperationsResult(await h.control({ action: "import-media" }))!.import?.id).not.toBe(first.import!.id);
});
