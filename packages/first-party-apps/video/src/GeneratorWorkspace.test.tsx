import { afterEach, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { GeneratorWorkspace } from "./GeneratorWorkspace";
import { appendGenerationShot, createEmptyGenerationBrief, type GenerationBrief } from "./generation-brief";
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

async function fixture(importImages?: () => Promise<unknown>, simpleCompleted = false, active: boolean | "saved" = false) {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, getComputedStyle: win.getComputedStyle.bind(win), Event: win.Event, HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  if (importImages) (win as unknown as { nautiloApp: unknown }).nautiloApp = { videoGeneration: { importReferences: importImages } };
  const brief: GenerationBrief = appendGenerationShot(appendGenerationShot(createEmptyGenerationBrief(), { title: "Arrival", description: "A train reaches the station", durationSec: 4 }, () => "scene-one"), { title: "Departure", description: "The train leaves", durationSec: 6 }, () => "scene-two");
  const generated: string[][] = [];
  const placed: string[] = [];
  let reconnects = 0;
  let switchDocumentKey: (() => void) | undefined;
  const host = win.document.createElement("div"); win.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  const Harness = () => {
    const [project, setProject] = useState<VideoProject>(() => simpleCompleted ? { ...createEmptyProject(), generationBrief: createEmptyGenerationBrief(), media: [{ id: "saved-take", kind: "video", ref: "generated.mp4", source: { kind: "workspace-artifact", artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4" } }], generatedTakes: [{ id: "take_generated", briefRevision: 1, mediaKind: "video", modelId: "model", settings: {}, artifact: { artifactId: "12345678-1234-4234-8234-123456789abc", path: "generated/take.mp4", zone: "workspace", mime: "video/mp4", bytes: 42 } }] } : { ...createEmptyProject(), generationBrief: brief });
    const [documentKey, setDocumentKey] = useState("fixture-a");
    switchDocumentKey = () => setDocumentKey("fixture-b");
    return <GeneratorWorkspace project={project} documentKey={documentKey} savedMediaIds={new Set(simpleCompleted ? ["saved-take"] : [])} enabled mutate={(change) => setProject((current) => ({ ...current, generationBrief: change(current.generationBrief ?? createEmptyGenerationBrief()) }))} onGenerate={(ids) => generated.push(ids ?? [])} onPlaceMedia={(id) => placed.push(id)} onPlaceSequence={() => undefined} onReturn={() => undefined} busy={active === true} onReconnectMedia={() => { reconnects++; }} modelControl={null} feedback={null} takes={active ? [{ takeId: "take_active", shotId: "scene-two", shotLabel: "Departure", documentRevision: 2 }] : simpleCompleted ? [{ takeId: "take_generated", shotId: "quick-brief", shotLabel: "Quick brief", documentRevision: 1 }] : []} statuses={active ? { take_active: { takeId: "take_active", revision: 1, state: active === "saved" ? "ready" : "generating", mediaKind: "video", modelId: "model", settings: {}, ...(active === "saved" ? { artifact: {artifactId:"12345678-1234-4234-8234-123456789abc",path:"generated/take.mp4",zone:"workspace" as const,mime:"video/mp4",bytes:42} } : {}) } satisfies NautiloVideoGenerationTakeStatus } : {}} unavailableIds={[]} progressForTake={() => active ? "Generation is active." : "Queued"} timingForTake={() => active ? "1m 12s elapsed · Typical time: about 2m 25s" : null} />;
  };
  await act(async () => { root?.render(createElement(Harness)); });
  return { host, generated, placed, reconnects: () => reconnects, window: win, switchDocumentKey: () => switchDocumentKey?.() };
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
  await act(async () => { button(h.host, "Images").click(); await Promise.resolve(); });
  expect(h.host.textContent).toContain("Subject");
  expect(h.host.textContent).toContain("Frame");
  expect(h.host.textContent).toContain("Could not add Broken (unavailable).");
});

test("batch imports survive ordinary draft edits", async () => {
  let resolve!: (result: unknown) => void;
  const pending = new Promise<unknown>((done) => { resolve = done; });
  const h = await fixture(() => pending);
  await act(async () => button(h.host, "Images").click());
  await act(async () => button(h.host, "+ Add scene").click());
  await act(async () => resolve({ kind: "ready", assets: [{ artifactId: "artifact-draft", path: "references/draft.png", label: "Draft survives", mediaKind: "image", mimeType: "image/png", sizeBytes: 42 }], failures: [] }));
  expect(h.host.textContent).toContain("Draft survives");

});

test("batch imports are discarded after the document changes", async () => {
  let resolveSwitched!: (result: unknown) => void;
  const switched = new Promise<unknown>((done) => { resolveSwitched = done; });
  const h2 = await fixture(() => switched);
  await act(async () => button(h2.host, "Images").click());
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


test("active take progress stays visible across scene and mode changes, outside collapsed takes", async () => {
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
  await act(async () => button(h.host, "Departure").click());
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
