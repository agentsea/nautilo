import { afterEach, expect, test } from "bun:test";
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { GeneratorWorkspace } from "./GeneratorWorkspace";
import { appendGenerationShot, createEmptyGenerationBrief, type GenerationBrief } from "./generation-brief";
import { sharedGenerationReferences } from "./generator-composer";
import type { NautiloVideoGenerationTakeStatus } from "./bridge";
import { createEmptyProject, type VideoProject } from "./edl";

let root: Root | undefined;
let win: Window | undefined;
const original = new Map<string, PropertyDescriptor | undefined>();

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  win?.close(); root = undefined; win = undefined;
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  original.clear();
});

async function fixture(importImages?: () => Promise<unknown>, simpleCompleted = false, active: boolean | "saved" = false, projectMedia: VideoProject["media"] = []) {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, getComputedStyle: win.getComputedStyle.bind(win), Event: win.Event, HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  if (importImages) (win as unknown as { nautiloApp: unknown }).nautiloApp = { media: { openPreview: async () => ({ kind: "unavailable", code: "test" }), closePreview: async () => undefined, pick: async () => { const result = await importImages() as { kind: string; assets?: unknown[]; mediaIds?: string[]; failures?: unknown[] }; return result.kind === "ready" ? { kind: "ready", imports: [], mediaIds: result.mediaIds ?? [], references: result.assets ?? [], failures: result.failures ?? [] } : result; } } };
  const brief: GenerationBrief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "A train reaches the station", durationSec: 4 }, () => "scene-one"), { title: "Departure", description: "The train leaves", durationSec: 6 }, () => "scene-two");
  const generated: string[][] = [];
  const placed: string[] = [];
  let reconnects = 0;
  let updateProps: ((props: Partial<ComponentProps<typeof GeneratorWorkspace>>) => void) | undefined;
  let currentProject: VideoProject;
  let switchDocumentKey: (() => void) | undefined;
  const host = win.document.createElement("div"); win.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  const Harness = () => {
    const [project, setProject] = useState<VideoProject>(() => simpleCompleted ? { ...createEmptyProject(), generationBrief: createEmptyGenerationBrief(), media: [{ id: "saved-take", kind: "video", ref: "generated.mp4", source: { kind: "workspace-artifact", artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4" } }], generatedTakes: [{ id: "take_generated", briefRevision: 1, mediaKind: "video", modelId: "model", settings: {}, artifact: { artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4", zone: "workspace", mime: "video/mp4", bytes: 42 } }] } : { ...createEmptyProject(), generationBrief: brief, media: projectMedia });
    const [overrides, setOverrides] = useState<Partial<ComponentProps<typeof GeneratorWorkspace>>>({});
    updateProps = next => setOverrides(current => ({ ...current, ...next }));
    currentProject = overrides.project ?? project;
    const [documentKey, setDocumentKey] = useState("fixture-a");
    switchDocumentKey = () => setDocumentKey("fixture-b");
    return <GeneratorWorkspace project={project} documentKey={documentKey} savedMediaIds={new Set(simpleCompleted ? ["saved-take"] : projectMedia.map(media => media.id))} enabled mutate={(change) => setProject((current) => ({ ...current, generationBrief: change(current.generationBrief ?? createEmptyGenerationBrief()) }))} onGenerate={(ids) => generated.push(ids ?? [])} onPlaceMedia={(id) => placed.push(id)} onPlaceSequence={() => undefined} onReturn={() => undefined} busy={active === true} onReconnectMedia={() => { reconnects++; }} modelControl={null} feedback={null} takes={active ? [{ takeId: "take_active", shotId: "scene-two", shotLabel: "Departure", documentRevision: 2 }] : simpleCompleted ? [{ takeId: "take_generated", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 1 }] : []} statuses={active ? { take_active: { takeId: "take_active", revision: 1, state: active === "saved" ? "ready" : "generating", mediaKind: "video", modelId: "model", settings: {}, ...(active === "saved" ? { artifact: {artifactId:"12345678-1234-4234-8234-123456789abc",path:"generated/take.mp4",zone:"workspace" as const,mime:"video/mp4",bytes:42} } : {}) } satisfies NautiloVideoGenerationTakeStatus } : {}} unavailableIds={[]} progressForTake={() => active ? "Generation is active." : "Queued"} timingForTake={() => active ? "1m 12s elapsed · Typical time: about 2m 25s" : null} {...overrides} />;
  };
  await act(async () => { root?.render(createElement(Harness)); });
  return { host, generated, placed, project: () => currentProject, update: (props: Partial<ComponentProps<typeof GeneratorWorkspace>>) => updateProps?.(props), reconnects: () => reconnects, window: win, switchDocumentKey: () => switchDocumentKey?.() };
}

function button(host: { querySelectorAll(selector: string): ArrayLike<unknown> }, name: string) {
  const nodes = host.querySelectorAll("button");
  const match = Array.from({ length: nodes.length }, (_, index) => nodes[index]).find((item) => (item as { textContent?: string }).textContent?.includes(name));
  if (!match) throw new Error(`Missing button ${name}`);
  return match as unknown as HTMLButtonElement;
}

test("selected scene owns the primary action while sequence generation names the complete ordered scope", async () => {
  const h = await fixture();
  expect(h.host.textContent).toContain("2 scenes · 10s total");
  await act(async () => button(h.host, "Departure").click());
  expect(h.host.querySelector("textarea[aria-label='Scene 2 prompt']")).not.toBeNull();
  await act(async () => button(h.host, "Generate scene").click());
  expect(h.generated).toEqual([["scene-two"]]);
  await act(async () => button(h.host, "Generate sequence").click());
  expect(h.generated).toEqual([["scene-two"], ["scene-one", "scene-two"]]);
});

test("adding a scene selects its dedicated writing workspace", async () => {
  const h = await fixture();
  await act(async () => button(h.host, "+ Add scene").click());
  expect(h.host.textContent).toContain("Scene 3 of 3");
  expect(h.host.textContent).toContain("3 scenes · 10s + auto duration");
  expect(h.host.querySelector("textarea[aria-label='Scene 3 prompt']")).not.toBeNull();
});

test("batch image imports add the successful references together and keep partial failures visible", async () => {
  const h = await fixture(async () => ({ kind: "ready", assets: [
    { artifactId: "artifact-image", path: "references/subject.png", label: "Subject", mediaKind: "image", mimeType: "image/png", sizeBytes: 42 },
    { artifactId: "artifact-frame", path: "references/frame.png", label: "Frame", mediaKind: "image", mimeType: "image/png", sizeBytes: 43 },
  ], failures: [{ label: "Broken", code: "unavailable" }] }));
  await act(async () => { button(h.host, "+ Add references").click(); await Promise.resolve(); });
  expect(h.host.textContent).toContain("Subject");
  expect(h.host.textContent).toContain("Frame");
  expect(h.host.textContent).toContain("Could not add Broken (unavailable).");
});

test("unified reference imports keep audio and assign an Audio mention", async () => {
  const h = await fixture(async () => ({ kind: "ready", assets: [
    { artifactId: "artifact-image", path: "references/subject.png", label: "Subject", mediaKind: "image", mimeType: "image/png", sizeBytes: 42 },
    { artifactId: "artifact-audio", path: "references/voice.wav", label: "Voice", mediaKind: "audio", mimeType: "audio/wav", sizeBytes: 43 },
  ], failures: [] }));
  await act(async () => { button(h.host, "+ Add references").click(); await Promise.resolve(); });
  expect(h.host.textContent).toContain("@Audio1");
  expect(sharedGenerationReferences(h.project().generationBrief!).find((reference) => reference.name === "Voice")?.mediaKind).toBe("audio");
});

test("Media Bin audio can be attached as a reference before a visual is added", async () => {
  const media = [{ id: "voice", kind: "audio" as const, ref: "voice.wav", durationSec: 8, label: "Library voice", lifecycle: "durable" as const,
    source: { kind: "workspace-artifact" as const, artifactId: "artifact-voice", path: "media/voice.wav" } }];
  const h = await fixture(async () => ({ kind: "ready", assets: [], mediaIds: ["voice"], failures: [] }), false, false, media);
  await act(async () => { button(h.host, "+ Add references").click(); await Promise.resolve(); });
  expect(h.host.textContent).toContain("@Audio1");
  const reference = sharedGenerationReferences(h.project().generationBrief!).find((entry) => entry.name === "Library voice");
  expect(reference?.mediaKind).toBe("audio");
  expect(reference?.source).toEqual({ kind: "project-media", mediaId: "voice" });
});

test("batch imports survive ordinary draft edits", async () => {
  let resolve!: (result: unknown) => void;
  const pending = new Promise<unknown>((done) => { resolve = done; });
  const h = await fixture(() => pending);
  await act(async () => button(h.host, "+ Add references").click());
  await act(async () => button(h.host, "+ Add scene").click());
  await act(async () => resolve({ kind: "ready", assets: [{ artifactId: "artifact-draft", path: "references/draft.png", label: "Draft survives", mediaKind: "image", mimeType: "image/png", sizeBytes: 42 }], failures: [] }));
  expect(h.host.textContent).toContain("Draft survives");

});

test("batch imports are discarded after the document changes", async () => {
  let resolveSwitched!: (result: unknown) => void;
  const switched = new Promise<unknown>((done) => { resolveSwitched = done; });
  const h2 = await fixture(() => switched);
  await act(async () => button(h2.host, "+ Add references").click());
  await act(async () => h2.switchDocumentKey());
  await act(async () => resolveSwitched({ kind: "ready", assets: [{ artifactId: "artifact-stale", path: "references/stale.png", label: "Must not arrive", mediaKind: "image", mimeType: "image/png", sizeBytes: 42 }], failures: [] }));
  expect(h2.host.textContent).not.toContain("Must not arrive");
});

test("Simple retains completed preview, takes, and explicit placement", async () => {
  const h = await fixture(undefined, true);
  await act(async () => button(h.host, "Simple").click());
  expect(h.host.querySelector(".generator-workspace[aria-label='Simple generation']")).not.toBeNull();
  expect(h.host.querySelector(".generator-writing textarea[aria-label='Video prompt']")).not.toBeNull();
  expect(h.host.textContent).not.toContain("Generate sequence");
  expect(h.host.textContent).toContain("Preview and takes");
  const results = h.host.querySelector(".generator-results") as unknown as HTMLDetailsElement;
  await act(async () => results.querySelector("summary")!.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(h.host.textContent).toContain("Take 1");
  await act(async () => button(h.host, "Add at playhead").click());
  expect(h.placed).toEqual(["saved-take"]);
});


test("submitted progress replaces writing and returning to design does not cancel or resubmit", async () => {
  const h = await fixture(undefined, false, true);
  const check = () => {
    const progress = h.host.querySelector('[aria-label="Generation progress"]');
    expect(progress?.closest("details")).toBeNull();
    expect(progress?.textContent).toContain("Departure");
    expect(progress?.textContent).toContain("Generation is active.");
    expect(progress?.textContent).toContain("1m 12s elapsed · Typical time: about 2m 25s");
    expect(progress?.querySelector('[data-testid="generated-media-ambient"]')).not.toBeNull();
    expect(progress?.querySelector('[role="progressbar"]')).toBeNull();
  };
  check();
  expect(h.host.querySelector(".generator-writing textarea")).toBeNull();
  await act(async () => button(h.host, "Departure").click());
  expect(h.host.querySelector("textarea[aria-label='Scene 2 prompt']")).not.toBeNull();
  expect(h.host.querySelector('[aria-label="Generation progress"]')).toBeNull();
  await act(async () => button(h.host, "View generation progress").click());
  check();
  await act(async () => button(h.host, "Simple").click());
  check();
  expect(h.generated).toEqual([]);
});


test("a saved video missing from Media Bin stays visible and reconnect never submits generation", async () => {
  const h = await fixture(undefined, false, "saved");
  const progress = h.host.querySelector('[aria-label="Generation progress"]');
  expect(progress?.textContent).toContain("Video saved");
  expect(progress?.textContent).toContain("Saved in Workspace");
  expect(progress?.querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
  await act(async () => button(h.host, "Reconnect Media Bin").click());
  expect(h.reconnects()).toBe(1);
  expect(h.generated).toEqual([]);
});


test("completion stays in the same pane and only saved media can be previewed or placed", async () => {
  const h = await fixture(undefined, false, true);
  const artifact = { artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 42 };
  await act(async () => h.update({ statuses: { take_active: { takeId: "take_active", revision: 2, state: "ready", mediaKind: "video", modelId: "model", settings: {}, artifact } } }));
  expect(h.host.textContent).toContain("Video saved");
  expect(h.host.querySelector('[aria-label="Generation progress"] .video-media-bin-preview')).toBeNull();
  const project = { ...h.project(), media: [{ id: "result", kind: "video" as const, ref: artifact.path, lifecycle: "durable" as const, source: { kind: "workspace-artifact" as const, artifactId: artifact.artifactId, path: artifact.path } }] };
  await act(async () => h.update({ project }));
  expect(h.host.querySelector('[aria-label="Generation progress"] .video-media-bin-preview')).toBeNull();
  await act(async () => h.update({ savedMediaIds: new Set(["result"]), busy: false }));
  expect(h.host.querySelector('[aria-label="Generation progress"]')?.textContent).toContain("Your scene is ready");
  expect(h.host.querySelector(".generator-writing textarea")).toBeNull();
  await act(async () => button(h.host, "Add at playhead").click());
  expect(h.placed).toEqual(["result"]);
  await act(async () => button(h.host, "Back to scene design").click());
  expect(h.host.textContent).toContain("View result");
  await act(async () => button(h.host, "View result").click());
  expect(h.host.textContent).toContain("Your scene is ready");
  expect(h.generated).toEqual([]);
});

test("reconnecting and failed takes never animate as active or automatically resubmit", async () => {
  const h = await fixture(undefined, false, true);
  await act(async () => h.update({ unavailableIds: ["take_active"] }));
  const progress = () => h.host.querySelector('[aria-label="Generation progress"]')!;
  expect(progress().textContent).toContain("Couldn’t check this take");
  expect(progress().querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
  await act(async () => button(h.host, "Check status").click());
  expect(h.reconnects()).toBe(1);
  await act(async () => h.update({ unavailableIds: [], statuses: { take_active: { takeId: "take_active", revision: 3, state: "failed", mediaKind: "video", modelId: "model", settings: {}, failure: { code: "provider_error", message: "The provider stopped this take." } } } }));
  expect(progress().textContent).toContain("The provider stopped this take.");
  expect(progress().querySelector('[data-testid="generated-media-ambient"]')).toBeNull();
  expect(h.generated).toEqual([]);
});

test("status ticks do not pull the user out of design; a new submitted scene does", async () => {
  const h = await fixture(undefined, false, true);
  await act(async () => button(h.host, "Back to scene design").click());
  await act(async () => h.update({ statuses: { take_active: { takeId: "take_active", revision: 2, state: "saving", mediaKind: "video", modelId: "model", settings: {} } } }));
  expect(h.host.querySelector('[aria-label="Generation progress"]')).toBeNull();
  await act(async () => h.update({ takes: [{ takeId: "new_take", shotId: "scene-one", shotLabel: "Arrival", documentRevision: 3 }], statuses: { new_take: { takeId: "new_take", revision: 1, state: "queued", mediaKind: "video", modelId: "model", settings: {} } } }));
  expect(h.host.querySelector('[aria-label="Generation progress"]')?.textContent).toContain("Arrival");
  await act(async () => h.update({ documentKey: "different-document", project: createEmptyProject(), takes: [], statuses: {} }));
  expect(h.host.querySelector('[aria-label="Generation progress"]')).toBeNull();
  expect(h.host.textContent).not.toContain("View generation progress");
  expect(h.generated).toEqual([]);
});


test("Review next scene requests its existing cost review only on a click", async () => {
  const h = await fixture(undefined, false, true);
  const artifact = { artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4", zone: "workspace" as const, mime: "video/mp4", bytes: 42 };
  await act(async () => h.update({ busy: false, takes: [{ takeId: "take_active", shotId: "scene-one", shotLabel: "Arrival", documentRevision: 2 }], statuses: { take_active: { takeId: "take_active", revision: 2, state: "ready", mediaKind: "video", modelId: "model", settings: {}, artifact } }, project: { ...h.project(), media: [{ id: "result", kind: "video", ref: artifact.path, source: { kind: "workspace-artifact", artifactId: artifact.artifactId, path: artifact.path } }] }, savedMediaIds: new Set(["result"]) }));
  expect(h.generated).toEqual([]);
  await act(async () => button(h.host, "Review next scene").click());
  expect(h.generated).toEqual([["scene-two"]]);
});

test("a saved take remains usable when status is unavailable and does not replace scene design on reopen", async () => {
  const h = await fixture(undefined, true);
  await act(async () => h.update({ unavailableIds: ["take_generated"] }));
  expect(h.host.querySelector('[aria-label="Generation progress"]')).toBeNull();
  expect(h.host.textContent).not.toContain("Reconnecting to your scene");
  await act(async () => button(h.host, "Take 1Queued").click());
  expect(h.host.textContent).toContain("Your scene is ready");
  await act(async () => button(h.host, "Add at playhead").click());
  expect(h.placed).toEqual(["saved-take"]);
  expect(h.generated).toEqual([]);
});
