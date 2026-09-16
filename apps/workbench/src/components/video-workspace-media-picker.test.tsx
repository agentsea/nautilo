import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { WorkspaceMediaArtifact } from "@nautilo/types";
import { groupWorkspaceMediaPickerArtifacts, VideoWorkspaceMediaPicker, type WorkspaceMediaPreview, workspaceMediaPickerName, workspaceMediaPickerRowKey } from "./video-workspace-media-picker";

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) { TestIntersectionObserver.instances.push(this); }
  observe(target: Element) { this.targets.push(target); }
  unobserve(target: Element) { const index = this.targets.indexOf(target); if (index >= 0) this.targets.splice(index, 1); }
  disconnect() { this.targets.length = 0; }
  takeRecords() { return []; }
  emit(visible: boolean) { this.callback(this.targets.map((target) => ({ target, isIntersecting: visible } as IntersectionObserverEntry)), this as unknown as IntersectionObserver); }
}

const image: WorkspaceMediaArtifact = { id: "image", artifactId: "image-artifact", path: "video-references/9cb43f6b-19e5-4d4e-8c5c-5c2ce47b7d48_Sunrise still.png", mimeType: "image/png", size: 12, revision: 1 };
const video: WorkspaceMediaArtifact = { id: "video", artifactId: "video-artifact", path: "generated-media/Opening.mp4", mimeType: "video/mp4", size: 12, revision: 1 };
const audio: WorkspaceMediaArtifact = { id: "audio", artifactId: "audio-artifact", path: "audio/voice.wav", mimeType: "audio/wav", size: 12, revision: 1 };
const copyA: WorkspaceMediaArtifact = { ...image, id: "copy-a", artifactId: "copy-a-artifact", path: "video-references/First copy.png" };
const copyB: WorkspaceMediaArtifact = { ...image, id: "copy-b", artifactId: "copy-b-artifact", path: "video-references/Second copy.png" };

let root: Root | null = null;
let host: HTMLElement | null = null;
let win: Window | null = null;
const globals = ["window", "document", "HTMLElement", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const prior = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
  win = new Window();
  for (const key of globals) prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement, IntersectionObserver: TestIntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true });
  TestIntersectionObserver.instances = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
}

function render(loadPreview?: (artifact: WorkspaceMediaArtifact, signal: AbortSignal) => Promise<WorkspaceMediaPreview | null>) {
  return root!.render(<VideoWorkspaceMediaPicker artifacts={[image, video, audio]} labels={{}} loading={false} error={null} onSelect={() => undefined} onUpload={() => undefined} onCancel={() => undefined} loadPreview={loadPreview} />);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove(); win?.close();
  for (const key of globals) {
    const descriptor = prior.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  prior.clear(); root = null; host = null; win = null;
});

describe("VideoWorkspaceMediaPicker previews", () => {
  test("loads only visible rows, including actual audio waveforms without autoplay", async () => {
    installDom();
    const calls: string[] = [];
    await act(async () => render(async (artifact) => {
      calls.push(artifact.id);
      return { url: `nautilo-media://proxy/${artifact.id}`, mediaKind: artifact.mimeType.startsWith("video/") ? "video" : artifact.mimeType.startsWith("audio/") ? "audio" : "image", waveform: { peaks: [0.1, 0.7, 0.3], samplesPerSecond: 100 }, release: () => undefined };
    }));
    expect(calls).toEqual([]);
    expect(TestIntersectionObserver.instances).toHaveLength(3);
    await act(async () => { TestIntersectionObserver.instances[0]!.emit(true); await Promise.resolve(); });
    expect(calls).toEqual(["image"]);
    expect(host!.textContent).toContain("Audio");
    expect(calls).not.toContain("audio");
    await act(async () => { TestIntersectionObserver.instances[2]!.emit(true); await Promise.resolve(); });
    expect(calls).toEqual(["image", "audio"]);
    expect(host!.querySelector('svg[aria-label="Audio waveform"]')).not.toBeNull();
    expect(host!.querySelector("audio")).toBeNull();
    const previewButton = host!.querySelector<HTMLButtonElement>('button[aria-label="Preview voice.wav"]')!;
    await act(async () => previewButton.click());
    await act(async () => { TestIntersectionObserver.instances.at(-1)!.emit(true); await Promise.resolve(); });
    expect(host!.querySelector('audio[controls]')).not.toBeNull();
    expect(host!.querySelector('audio[autoplay]')).toBeNull();
    expect(host!.querySelector('video[controls]')).toBeNull();
    expect(host!.querySelector('video[autoplay]')).toBeNull();
  });

  test("audio remains playable without peaks and releases previews on leaving the picker", async () => {
    installDom();
    let releases = 0;
    await act(async () => render(async () => ({ url: "nautilo-media://proxy/audio", mediaKind: "audio", release: () => { releases++; } })));
    await act(async () => { TestIntersectionObserver.instances[2]!.emit(true); await Promise.resolve(); });
    expect(host!.textContent).toContain("Waveform unavailable");
    expect(host!.querySelector('svg[aria-label="Audio waveform"]')).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Preview voice.wav"]')!.click());
    expect(releases).toBe(1);
    await act(async () => { TestIntersectionObserver.instances.at(-1)!.emit(true); await Promise.resolve(); });
    expect(host!.querySelector('audio[controls]')).not.toBeNull();
    await act(async () => root?.unmount()); root = null;
    expect(releases).toBe(2);
  });

  test("audio-only MP4 uses its inspected waveform, Audio label and filter while retaining exact selection identity", async () => {
    installDom();
    const picked: WorkspaceMediaArtifact[] = [];
    const mislabeled = { ...video, path: "media/Audio.mp4" };
    await act(async () => root!.render(<VideoWorkspaceMediaPicker artifacts={[mislabeled]} labels={{}} loading={false} error={null} onSelect={a => picked.push(a)} onUpload={() => {}} onCancel={() => {}} loadPreview={async () => ({ url: "nautilo-media://proxy/audio", mediaKind: "audio", waveform: { peaks: [0.2, 0.7], samplesPerSecond: 100 }, release: () => {} })} />));
    const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
    // Unknown MP4s must remain discoverable when Audio is selected before inspection.
    await act(async () => button("Audio").click());
    expect(host!.querySelectorAll("li")).toHaveLength(1);
    await act(async () => { TestIntersectionObserver.instances[0]!.emit(true); await Promise.resolve(); });
    expect(host!.querySelector('svg[aria-label="Audio waveform"]')).not.toBeNull();
    expect(host!.querySelector("li")!.textContent).toBe("Audio.mp4AudioPreview");
    await act(async () => host!.querySelector<HTMLButtonElement>("li button")!.click());
    expect(picked).toEqual([mislabeled]);
    expect(picked[0]!.mimeType).toBe("video/mp4");
    await act(async () => button("Videos").click());
    expect(host!.querySelectorAll("li")).toHaveLength(0);
  });

  test("aborts and releases a late preview after the row unmounts", async () => {
    installDom();
    let resolve: ((preview: WorkspaceMediaPreview | null) => void) | undefined;
    let signal: AbortSignal | undefined;
    let releases = 0;
    await act(async () => render((artifact, nextSignal) => {
      if (artifact.id !== "image") return Promise.resolve(null);
      signal = nextSignal;
      return new Promise((done) => { resolve = done; });
    }));
    await act(async () => { TestIntersectionObserver.instances[0]!.emit(true); await Promise.resolve(); });
    expect(signal?.aborted).toBe(false);
    await act(async () => root?.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve?.({ url: "nautilo-media://proxy/late", mediaKind: "image", release: () => { releases += 1; } }); await Promise.resolve(); });
    expect(releases).toBe(1);
  });

  test("releases a hidden preview, reloads on re-entry, and reports a decode failure", async () => {
    installDom();
    let calls = 0;
    let releases = 0;
    await act(async () => render(async (artifact) => {
      calls += 1;
      return { url: `nautilo-media://proxy/${artifact.id}-${calls}`, mediaKind: artifact.mimeType.startsWith("video/") ? "video" : "image", release: () => { releases += 1; } };
    }));
    const imageObserver = TestIntersectionObserver.instances[0]!;
    await act(async () => { imageObserver.emit(true); await Promise.resolve(); });
    expect(calls).toBe(1);
    await act(async () => imageObserver.emit(false));
    expect(releases).toBe(1);
    expect(host!.querySelector("img")).toBeNull();
    await act(async () => { imageObserver.emit(true); await Promise.resolve(); });
    expect(calls).toBe(2);
    const imageElement = host!.querySelector("img")!;
    await act(async () => imageElement.dispatchEvent(new win!.Event("error")));
    expect(releases).toBe(2);
    expect(host!.textContent).toContain("Preview unavailable");
  });

  test("preserves known labels and removes only a meaningful UUID prefix", () => {
    expect(workspaceMediaPickerName(image, {})).toBe("Sunrise still.png");
    expect(workspaceMediaPickerName(video, { [`${video.artifactId}\0${video.path}`]: "Opening take" })).toBe("Opening take");
    expect(workspaceMediaPickerName({ ...image, path: "video-references/9cb43f6b-19e5-4d4e-8c5c-5c2ce47b7d48.png" }, {})).toBe("Reference image");
  });

  test("groups only exact digest, size, and kind matches with a stable preferred representative", () => {
    const variant = { ...copyA, id: "variant", artifactId: "variant-artifact", path: "video-references/Variant.png", size: 13 };
    const unknown = { ...copyA, id: "unknown", artifactId: "unknown-artifact", path: "video-references/Unknown.png" };
    const labels = { [`${copyB.artifactId}\0${copyB.path}`]: "Project opening" };
    const digest = "a".repeat(64);
    const groups = groupWorkspaceMediaPickerArtifacts([copyA, copyB, variant, unknown], labels, new Map([
      [workspaceMediaPickerRowKey(copyA), digest], [workspaceMediaPickerRowKey(copyB), digest], [workspaceMediaPickerRowKey(variant), digest],
    ]));
    expect(groups).toHaveLength(3);
    expect(groups[0]!.representative.id).toBe("copy-b");
    expect(groups[0]!.artifacts.map((artifact) => artifact.id)).toEqual(["copy-a", "copy-b"]);
    expect(groups.slice(1).map((group) => group.representative.id)).toEqual(["variant", "unknown"]);
    for (const otherDigest of ["b".repeat(64), "A".repeat(64), "invalid"]) {
      expect(groupWorkspaceMediaPickerArtifacts([copyA, copyB], labels, new Map([
        [workspaceMediaPickerRowKey(copyA), digest], [workspaceMediaPickerRowKey(copyB), otherDigest],
      ]))).toHaveLength(2);
    }
    expect(groupWorkspaceMediaPickerArtifacts([copyA, video], labels, new Map([
      [workspaceMediaPickerRowKey(copyA), digest], [workspaceMediaPickerRowKey(video), digest],
    ]))).toHaveLength(2);
    const revisedCopyA = { ...copyA, revision: 2 };
    expect(groupWorkspaceMediaPickerArtifacts([revisedCopyA, copyB], labels, new Map([
      [workspaceMediaPickerRowKey(copyA), digest], [workspaceMediaPickerRowKey(copyB), digest],
    ]))).toHaveLength(2);
  });

  test("an alias remains searchable and selects its exact artifact", async () => {
    installDom();
    const selected: string[] = [];
    let loads = 0;
    let releases = 0;
    const labels = { [`${copyB.artifactId}\0${copyB.path}`]: "Project opening" };
    const loadPreview = async (artifact: WorkspaceMediaArtifact) => {
      loads += 1;
      return { url: `nautilo-media://proxy/${artifact.id}`, mediaKind: "image" as const, sha256: "b".repeat(64), release: () => { releases += 1; } };
    };
    await act(async () => root!.render(<VideoWorkspaceMediaPicker artifacts={[copyA, copyB]} labels={labels} loading={false} error={null} onSelect={(artifact) => selected.push(artifact.id)} onUpload={() => undefined} onCancel={() => undefined} loadPreview={loadPreview} />));
    await act(async () => { TestIntersectionObserver.instances[0]!.emit(true); TestIntersectionObserver.instances[1]!.emit(true); await Promise.resolve(); });
    expect(host!.textContent).toContain("2 copies");
    expect(loads).toBe(2);
    expect(releases).toBe(1);
    await act(async () => await Promise.resolve());
    expect(loads).toBe(2);
    const search = host!.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "First copy";
    await act(async () => search.dispatchEvent(new win!.Event("input", { bubbles: true })));
    expect(host!.textContent).toContain("Project opening");
    await act(async () => (host!.querySelector(`button[title="${copyA.path}"]`) as HTMLButtonElement).click());
    expect(selected).toEqual(["copy-a"]);
    await act(async () => root?.unmount());
    expect(releases).toBe(2);
  });
});

async function click(label: string) {
  const button = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test("selection survives source, view and type changes and reuses existing Media Bin identities", async () => {
  installDom();
  const picks: unknown[] = [];
  await act(async () => root!.render(<VideoWorkspaceMediaPicker artifacts={[image, video, audio]} labels={{}} loading={false} error={null} purpose="references" multiple projectMedia={[{ id: "media_existing", label: "Opening", kind: "video", artifactId: video.artifactId, path: video.path }]} onSelect={() => undefined} onConfirm={selection => picks.push(selection)} onUpload={() => undefined} onCancel={() => undefined} />));
  expect(host!.textContent).not.toContain("voice.wav");
  await act(async () => host!.querySelector<HTMLButtonElement>(`button[title="${image.path}"]`)!.click());
  await click("Media Bin");
  await click("List view");
  await click("Videos");
  await act(async () => host!.querySelector<HTMLButtonElement>(`button[title="${video.path}"]`)!.click());
  expect(host!.textContent).toContain("2 selected");
  await click("Add 2 references");
  expect(picks).toEqual([{ artifacts: [image], mediaIds: ["media_existing"] }]);
});

test("computer keeps batch selection but replaces a single selection", async () => {
  for (const multiple of [true, false]) {
    if (!host) installDom();
    const uploads: unknown[] = [];
    await act(async () => root!.render(<VideoWorkspaceMediaPicker key={String(multiple)} artifacts={[image, video]} labels={{}} loading={false} error={null} purpose="references" multiple={multiple} onSelect={() => undefined} onConfirm={() => undefined} onUpload={selection => uploads.push(selection)} onCancel={() => undefined} />));
    await act(async () => host!.querySelector<HTMLButtonElement>(`button[title="${image.path}"]`)!.click());
    await click("Computer"); await click("Choose files…");
    expect(uploads).toEqual([{ artifacts: multiple ? [image] : [], mediaIds: [], fromComputer: true }]);
  }
});

test("single replacement selects only the last item; Escape and X cancel without confirmation", async () => {
  installDom(); let cancelled = 0;
  const picks: unknown[] = [];
  await act(async () => root!.render(<VideoWorkspaceMediaPicker artifacts={[image, video]} labels={{}} loading={false} error={null} purpose="references" multiple={false} onSelect={() => undefined} onConfirm={selection => picks.push(selection)} onUpload={() => undefined} onCancel={() => cancelled++} />));
  for (const row of [image, video]) await act(async () => host!.querySelector<HTMLButtonElement>(`button[title="${row.path}"]`)!.click());
  await click("Use reference");
  expect(picks).toEqual([{ artifacts: [video], mediaIds: [] }]);
  await act(async () => host!.querySelector('[role="dialog"]')!.dispatchEvent(new win!.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click("Close media picker");
  expect(cancelled).toBe(2); expect(picks).toHaveLength(1);
});

test("revised inventory drops a stale selection and already-added media cannot be added twice", async () => {
  installDom();
  const props = { labels: {}, loading: false, error: null, multiple: true, onSelect: () => undefined, onConfirm: () => undefined, onUpload: () => undefined, onCancel: () => undefined };
  await act(async () => root!.render(<VideoWorkspaceMediaPicker {...props} artifacts={[image, video]} projectMedia={[{ id: "existing", label: "Opening", kind: "video", artifactId: video.artifactId, path: video.path }]} />));
  expect(host!.querySelector<HTMLButtonElement>(`button[title="${video.path}"]`)!.disabled).toBe(true);
  await act(async () => host!.querySelector<HTMLButtonElement>(`button[title="${image.path}"]`)!.click());
  expect(host!.textContent).toContain("1 selected");
  await act(async () => root!.render(<VideoWorkspaceMediaPicker {...props} artifacts={[{ ...image, revision: 2 }, video]} />));
  expect(host!.textContent).not.toContain("1 selected");
});
