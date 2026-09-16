import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { MemSlidesStore } from "../engine/browser.js";
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from "./slide-document";
import { mountPresentation } from "./presentation-app";
import type { SlidesBridge, PrepareCloseResult, DocumentChange } from "./slide-bridge";
import type { SlidesSurfaceCallbacks, SlidesSurfaceOptions } from "./slides-surface";
import type { PreparedSlidesPdf } from "./slide-pdf";

let window: Window;
let cleanups: Array<() => void>;
beforeEach(() => { window = new Window(); cleanups = []; });
afterEach(() => { for (const cleanup of cleanups) cleanup(); window.close(); });
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const sha256 = async (content: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
  byte => byte.toString(16).padStart(2, "0"),
).join("");

async function fixture(options: {
  failFirstRead?: boolean;
  conflict?: boolean;
  failCopy?: boolean;
  failWrites?: boolean;
  recovery?: boolean;
  mode?: "edit" | "preview";
  preparePdf?: (document: ReturnType<typeof createSlideDocument>) => Promise<PreparedSlidesPdf>;
} = {}) {
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const root = element as unknown as HTMLElement;
  const initialContent = serializeSlideHtml(createSlideDocument());
  let remote = { content: initialContent, baseSha256: await sha256(initialContent), baseRevision: 1, path: "Launch.presentation.html" };
  const writes: string[] = [];
  const copies: string[] = [];
  const downloads: string[] = [];
  let handler: ((event: DocumentChange) => void) | undefined;
  let prepare!: NonNullable<SlidesBridge["lifecycle"]>["onPrepareClose"] extends (cb: infer T) => unknown ? T : never;
  let prepareExport!: NonNullable<SlidesBridge["exports"]>["onPrepare"] extends (cb: infer T) => unknown ? T : never;
  let current!: MemSlidesStore;
  let callbacks!: SlidesSurfaceCallbacks;
  let surfaceOptions: SlidesSurfaceOptions | undefined;
  let lifecycleRegistrations = 0;
  let exportRegistrations = 0;
  let pendingText: string | undefined;
  let selectedSlideId: string | undefined;
  let first = true;
  let failWrite = options.failWrites === true;
  let failRefresh = false;
  let mounts = 0;
  const disposedMounts: number[] = [];
  let releaseWrite: (() => void) | undefined;
  let blockedWrite: Promise<void> | undefined;
  let blockedCommit: Promise<void> | undefined;
  let releaseCommit: (() => void) | undefined;
  let recovery: Awaited<ReturnType<NonNullable<SlidesBridge["recovery"]>["read"]>> = { revision: null, draft: null };
  let recoveryWrites = 0;
  let failRecoveryClear = false;
  const bridge: SlidesBridge = {
    ...(options.recovery ? { recovery: {
      async read() { return recovery; },
      async write(input) {
        if (input.expectedRevision !== recovery.revision) throw new Error("Recovery copy changed");
        if (input.draft === null && failRecoveryClear) throw new Error("Recovery storage unavailable");
        recovery = { revision: String(++recoveryWrites), draft: input.draft };
        return { revision: recovery.revision };
      },
    } satisfies NonNullable<SlidesBridge["recovery"]> } : {}),
    document: {
      async read() { if (first && options.failFirstRead) { first = false; throw new Error("offline"); } first = false; return remote; },
      async write(content, base) {
        writes.push(content);
        if (blockedWrite) await blockedWrite;
        if (failWrite) throw new Error("Offline");
        if (options.conflict || base.baseSha256 !== remote.baseSha256 || base.baseRevision !== remote.baseRevision) return { kind: "conflict" };
        remote = { ...remote, content, baseRevision: remote.baseRevision + 1, baseSha256: await sha256(content) };
        return { kind: "saved", sha256: remote.baseSha256, revision: remote.baseRevision, persistedContent: content };
      },
      async downloadCopy(content) { downloads.push(content); },
      async saveCopy(content) { if (options.failCopy) throw new Error("Folder unavailable"); copies.push(content); return { path: "Recovery.presentation.html" }; },
      onChange(next) { handler = next; return () => { handler = undefined; }; },
    },
    context: Object.assign({ set() {} }, options.mode ? { mode: options.mode } : {}), humanEdit: { set() {} },
    lifecycle: { onPrepareClose(cb) { lifecycleRegistrations++; prepare = cb; return () => {}; } },
    exports: { onPrepare(cb) { exportRegistrations++; prepareExport = cb; return () => {}; } },
  };
  const dispose = await mountPresentation(root, bridge, {
    ...(options.preparePdf ? { preparePdf: options.preparePdf } : {}),
    mountSurface(_root, store, nextCallbacks, nextOptions) {
      current = store; callbacks = nextCallbacks;
      surfaceOptions = nextOptions;
      selectedSlideId = nextOptions?.activeSlideId ?? store.read().slides[0]?.id;
      const mountId = ++mounts;
      const off = store.onChange(() => callbacks.changed());
      return {
        getDraftSnapshot() {
          const snapshot = store.read();
          const text = snapshot.slides[0]?.elements.find(element => element.type === "text");
          if (pendingText !== undefined && text?.type === "text") text.data.blocks[0].inlines = [{ text: pendingText, style: {} }];
          return snapshot;
        },
        isDraftExact() { return true; },
        commit() {
          return (blockedCommit ?? Promise.resolve()).then(() => {
          if (pendingText !== undefined) {
            const slide = store.read().slides[0];
            const text = slide.elements.find(e => e.type === "text")!;
            if (text.type !== "text") throw new Error("missing text");
            const blocks = structuredClone(text.data.blocks);
            blocks[0].inlines = [{ text: pendingText, style: {} }];
            store.batch(() => store.updateElementData(slide.id, text.id, { blocks }));
            pendingText = undefined;
          }
          callbacks.editing(false);
          });
        },
        dispose() { disposedMounts.push(mountId); off(); }, refresh() { if (failRefresh) throw new Error("candidate paint failed"); }, getActiveSlideId: () => selectedSlideId,
      };
    },
  });
  cleanups.push(dispose);
  return {
    root, writes, copies, downloads, disposedMounts,
    get surfaceOptions() { return surfaceOptions; },
    selectSlide(id: string) { selectedSlideId = id; },
    get lifecycleRegistrations() { return lifecycleRegistrations; },
    get exportRegistrations() { return exportRegistrations; },
    failReplacement() { failRefresh = true; remote = { ...remote, baseRevision: remote.baseRevision + 1 }; },
    prepare: (action: "prepare-close" | "save-copy" = "prepare-close") => prepare({ reason: "close", action }),
    prepareExport: () => prepareExport({ actionId: "export-pdf", mimeType: "application/pdf" }),
    dispose,
    get remote() { return remote; }, get store() { return current; },
    type(text: string) { pendingText = text; callbacks.editing(true); },
    emit(event: DocumentChange) { handler?.(event); },
    blockCommit() { blockedCommit = new Promise<void>(resolve => { releaseCommit = resolve; }); },
    releaseCommit() { releaseCommit?.(); blockedCommit = undefined; },
    blockSave() { blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; }); },
    releaseSave() { releaseWrite?.(); blockedWrite = undefined; },
    restoreWrites() { failWrite = false; },
    get recovery() { return recovery; },
    failRecoveryClear() { failRecoveryClear = true; },
    async replaceRemote(content: string) {
      remote = { ...remote, content, baseSha256: await sha256(content), baseRevision: remote.baseRevision + 1 };
    },
  };
}

function textOf(html: string): string {
  return parseSlideHtml(html).slides.flatMap(s => s.elements).filter(e => e.type === "text").flatMap(e => e.data.blocks).flatMap(b => b.inlines).map(i => i.text).join("");
}

describe("presentation canonical app loop", () => {
  test("commits active text and waits for exact canonical save before closing", async () => {
    const f = await fixture();
    f.type("Launch together");
    expect(f.writes).toHaveLength(0);
    const result = await f.prepare();
    expect(result.documentSaved).toBe(true);
    expect(textOf(f.remote.content)).toContain("Launch together");
    expect(f.root.dataset["saveState"]).toBe("saved");
    expect(parseSlideHtml(f.remote.content).slides).toHaveLength(1);
  });

  test("refuses a conflicting close and creates an exact recovery copy", async () => {
    const f = await fixture({ conflict: true });
    const before = f.remote.content;
    f.type("Keep my draft");
    const result = await f.prepare();
    expect(result.documentSaved).toBe(false);
    expect(f.remote.content).toBe(before);
    expect(result.errorMessage).toContain("changed elsewhere");
    const copy = await f.prepare("save-copy");
    expect(copy.recoveryPersisted).toBe(true);
    expect(copy.recoverableDraftExact).toBe(true);
    expect(textOf(f.copies[0])).toContain("Keep my draft");
    expect(f.remote.content).toBe(before);
  });

  test("the conflict notice saves an exact host copy and reports its destination", async () => {
    const f = await fixture({ conflict: true });
    const before = f.remote.content;
    f.type("Preserve the focused draft");
    await f.prepare();
    const copy = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy")!;
    copy.click();
    await settle();
    expect(f.copies).toHaveLength(1);
    expect(textOf(f.copies[0])).toContain("Preserve the focused draft");
    expect(f.downloads).toHaveLength(0);
    expect(f.root.textContent).toContain("Copy saved as Recovery.presentation.html");
    expect(f.remote.content).toBe(before);
    expect(f.root.dataset["saveState"]).toBe("conflict");
  });

  test("a failed recovery copy preserves the conflict controls and draft", async () => {
    const f = await fixture({ conflict: true, failCopy: true });
    const before = f.remote.content;
    f.type("Keep my conflicted draft");
    await f.prepare();
    const copy = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy")!;
    copy.click();
    await settle();
    expect(f.root.dataset["saveState"]).toBe("conflict");
    expect(f.root.textContent).toContain("Folder unavailable");
    expect((f.root.querySelector("header button") as HTMLButtonElement).disabled).toBe(true);
    expect([...f.root.querySelectorAll("button")].find(button => button.textContent === "Retry save")!.hidden).toBe(true);
    expect(f.copies).toHaveLength(0);
    expect(f.remote.content).toBe(before);
    expect(textOf(serializeSlideHtml(f.store.read()))).toContain("Keep my conflicted draft");
  });

  for (const entry of ["notice", "lifecycle"] as const) {
    test(`${entry} Save Copy does not retry the original when committing an active edit after an outage`, async () => {
      const f = await fixture({ failWrites: true });
      const before = f.remote.content;
      f.blockSave();
      f.type("First unsaved edit");
      const preparing = f.prepare();
      await settle();
      expect(f.writes).toHaveLength(1);
      f.type("Keep this newer active edit in the copy");
      f.releaseSave();
      expect((await preparing).documentSaved).toBe(false);
      f.restoreWrites();
      if (entry === "notice") {
        const copy = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy")!;
        expect(copy.hidden).toBe(false);
        copy.click();
        await settle();
      } else {
        const result = await f.prepare("save-copy");
        expect(result.recoveryPersisted).toBe(true);
        expect(result.recoverableDraftExact).toBe(true);
      }
      expect(f.writes).toHaveLength(1);
      expect(f.remote.content).toBe(before);
      expect(f.copies).toHaveLength(1);
      expect(textOf(f.copies[0])).toContain("Keep this newer active edit in the copy");
      expect(f.downloads).toHaveLength(0);
      expect(f.root.dataset["saveState"]).toBe("unsaved");
    });
  }

  test("lifecycle Save Copy retires the recovery journal only after an exact host copy", async () => {
    const f = await fixture({ conflict: true, recovery: true });
    const before = f.remote.content;
    f.type("Recover this draft into a copy");
    await f.prepare();
    await settle();
    expect(f.recovery.draft?.content).toContain("Recover this draft into a copy");
    const result = await f.prepare("save-copy");
    expect(result.recoverableDraftExact).toBe(true);
    expect(result.recoveryPersisted).toBe(true);
    expect(f.copies).toHaveLength(1);
    expect(f.recovery.draft).toBeNull();
    expect(f.remote.content).toBe(before);
  });

  test("lifecycle cannot authorize close when retiring a copied journal fails", async () => {
    const f = await fixture({ conflict: true, recovery: true });
    f.type("Keep this recovery journal");
    await f.prepare();
    await settle();
    f.failRecoveryClear();
    const result = await f.prepare("save-copy");
    expect(result.recoveryPersisted).toBe(false);
    expect(result.recoverableDraftExact).toBe(false);
    expect(result.errorMessage).toContain("Recovery storage unavailable");
    expect(f.copies).toHaveLength(1);
    expect(f.recovery.draft?.content).toContain("Keep this recovery journal");
    expect(f.root.dataset["saveState"]).toBe("conflict");
  });

  test("notice Save Copy keeps recovery for the editor that remains open", async () => {
    const f = await fixture({ conflict: true, recovery: true });
    f.type("Keep editing after copying");
    await f.prepare();
    await settle();
    [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy")!.click();
    await settle();
    expect(f.copies).toHaveLength(1);
    expect(f.recovery.draft?.content).toContain("Keep editing after copying");
  });

  test("serializes a close behind an explicit save already in flight", async () => {
    const f = await fixture();
    f.blockSave(); f.type("Wait for the write");
    (f.root.querySelector("header button") as HTMLButtonElement).click();
    await settle(); expect(f.writes).toHaveLength(1);
    let completed = false;
    const closing = f.prepare().then(result => { completed = true; return result; });
    await settle(); expect(completed).toBe(false);
    f.releaseSave();
    expect((await closing).documentSaved).toBe(true);
    expect(textOf(f.remote.content)).toContain("Wait for the write");
  });

  test("retries an initial read without losing document event subscriptions", async () => {
    const f = await fixture({ failFirstRead: true });
    expect(f.root.textContent).toContain("offline");
    const retry = [...f.root.querySelectorAll("button")].find(b => b.textContent === "Retry opening")!;
    retry.click(); await settle();
    expect(f.root.dataset["saveState"]).toBe("saved");
    f.emit({ type: "deleted" }); await settle();
    expect(f.root.dataset["saveState"]).toBe("conflict");
    expect((await f.prepare()).documentSaved).toBe(false);
  });

  test("failed opening can close without claiming any document was saved", async () => {
    const f = await fixture({ failFirstRead: true });
    const result: PrepareCloseResult = await f.prepare();
    expect(result.noLocalChanges).toBe(true);
    expect(result.documentSaved).toBe(false);
    expect(f.writes).toHaveLength(0);
  });
});

test("preview mounts the real surface read-only without persistence registrations", async () => {
  const f = await fixture({ mode: "preview" });

  expect(f.surfaceOptions).toEqual({ readOnly: true });
  expect(f.root.querySelector("main")?.getAttribute("aria-label")).toBe("Presentation preview");
  expect((f.root.querySelector("header button") as HTMLButtonElement).hidden).toBe(true);
  expect(f.root.textContent).toContain("Read only");
  expect(f.lifecycleRegistrations).toBe(0);
  expect(f.exportRegistrations).toBe(0);

  f.type("A read-only callback must not autosave");
  const saveShortcut = new window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
  window.document.dispatchEvent(saveShortcut);
  await settle();
  expect(saveShortcut.defaultPrevented).toBe(true);
  expect(f.writes).toHaveLength(0);
});

test("preview replaces its read-only surface when canonical content changes", async () => {
  const f = await fixture({ mode: "preview" });
  const changed = createSlideDocument();
  changed.meta.title = "Canonical preview update";
  const content = serializeSlideHtml(changed);
  await f.replaceRemote(content);

  f.emit({ type: "changed" });
  await settle();

  expect(f.store.readMeta().title).toBe("Canonical preview update");
  expect(f.surfaceOptions).toEqual({ readOnly: true });
  expect(f.writes).toHaveLength(0);
});

test("preview retries a failed canonical read without exposing recovery writes", async () => {
  const f = await fixture({ mode: "preview", failFirstRead: true });
  const reload = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Retry opening");
  const copy = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy");
  expect(reload?.hidden).toBe(false);
  expect(copy?.hidden).toBe(true);

  reload?.click();
  await settle();

  expect(f.root.textContent).toContain("Read only");
  expect(f.writes).toHaveLength(0);
});

test("preview offers a read-only reload when the canonical presentation disappears", async () => {
  const f = await fixture({ mode: "preview" });

  f.emit({ type: "deleted" });
  await settle();

  expect(f.root.textContent).toContain("Unavailable");
  expect(f.root.textContent).not.toContain("Save conflict");
  const reload = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Reload latest");
  const copy = [...f.root.querySelectorAll("button")].find(button => button.textContent === "Save a copy");
  expect(reload?.hidden).toBe(false);
  expect(copy?.hidden).toBe(true);
  expect(f.writes).toHaveLength(0);
});

const preparedPdf: PreparedSlidesPdf = {
  content: "JVBERi0=",
  encoding: "base64",
  mimeType: "application/pdf",
  byteLength: 5,
  warnings: ["Raster PDF"],
};

test("PDF export commits, saves and prepares the canonical verified snapshot", async () => {
  const seen: string[] = [];
  const f = await fixture({
    preparePdf: async (document) => {
      seen.push(serializeSlideHtml(document));
      return preparedPdf;
    },
  });
  f.type("Canonical PDF content");

  const result = await f.prepareExport();

  expect(f.writes).toHaveLength(1);
  expect(textOf(seen[0])).toContain("Canonical PDF content");
  expect(seen[0]).toBe(f.remote.content);
  expect(result.sourceSha256).toBe(await sha256(f.remote.content));
  expect(result).toMatchObject(preparedPdf);
});

test("PDF export refuses a failed save before preparing bytes", async () => {
  let called = false;
  const f = await fixture({
    conflict: true,
    preparePdf: async () => { called = true; return preparedPdf; },
  });
  f.type("Unsaved PDF content");

  await rejects(f.prepareExport(), /Save the presentation/);
  expect(called).toBe(false);
});

test("PDF export refuses canonical bytes that no longer match the editor", async () => {
  let called = false;
  const f = await fixture({ preparePdf: async () => { called = true; return preparedPdf; } });
  const changed = createSlideDocument();
  changed.meta.title = "Changed elsewhere";
  const content = serializeSlideHtml(changed);
  f.remote.content = content;
  f.remote.baseSha256 = await sha256(content);
  f.remote.baseRevision += 1;

  await rejects(f.prepareExport(), /changed elsewhere/);
  expect(called).toBe(false);
});

test("PDF export refuses a local mutation while rendering is pending", async () => {
  let release!: (result: PreparedSlidesPdf) => void;
  let began!: () => void;
  const rendering = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture({
    preparePdf: () => { began(); return new Promise(resolve => { release = resolve; }); },
  });
  const exporting = f.prepareExport();
  await rendering;
  f.type("Changed during rendering");
  release(preparedPdf);

  await rejects(exporting, /changed during export/);
});

test("PDF export refuses completion after the presentation is disposed", async () => {
  let release!: (result: PreparedSlidesPdf) => void;
  let began!: () => void;
  const rendering = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture({
    preparePdf: () => { began(); return new Promise(resolve => { release = resolve; }); },
  });
  const exporting = f.prepareExport();
  await rendering;
  f.dispose();
  release(preparedPdf);

  await rejects(exporting, /changed during export/);
});


test("a failed candidate repaint preserves the currently mounted editor", async () => {
  const f = await fixture();
  f.failReplacement();
  f.emit({ type: "changed" });
  await settle();
  expect(f.root.textContent).toContain("candidate paint failed");
  expect(f.disposedMounts).toEqual([2]);
  expect(f.root.querySelectorAll(".presentation-stage")).toHaveLength(1);
});


test("close waits for accepted asynchronous surface edits before saving", async () => {
  const f = await fixture();
  f.type("Pending surface content"); f.blockCommit();
  let completed = false;
  const close = f.prepare().then(result => { completed = true; return result; });
  await settle();
  expect(completed).toBe(false);
  expect(f.writes).toHaveLength(0);
  f.releaseCommit();
  expect((await close).documentSaved).toBe(true);
  expect(textOf(f.remote.content)).toContain("Pending surface content");
});


test("canonical Genie updates keep the viewed slide and fall back only when it was removed", async () => {
  const f = await fixture();
  const deck = f.store.read();
  deck.slides.push({ id: "second", layoutId: deck.slides[0].layoutId, background: {}, elements: [], notes: [] });
  await f.replaceRemote(serializeSlideHtml(deck));
  f.emit({ type: "changed" });
  await settle();
  f.selectSlide("second");
  deck.meta.title = "Genie refinement";
  await f.replaceRemote(serializeSlideHtml(deck));
  f.emit({ type: "changed" });
  await settle();
  expect(f.surfaceOptions?.activeSlideId).toBe("second");
  expect(f.writes).toHaveLength(0);
  deck.slides.pop();
  await f.replaceRemote(serializeSlideHtml(deck));
  f.emit({ type: "changed" });
  await settle();
  expect(f.surfaceOptions?.activeSlideId).toBeUndefined();
  expect(f.writes).toHaveLength(0);
});
