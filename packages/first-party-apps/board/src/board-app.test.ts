import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBoardDocument, parseBoardHtml, serializeBoardHtml } from "./board-document";
import { mountBoard } from "./board-app";
import type { BoardBridge, DocumentChange } from "./board-bridge";
import type { mountBoardSurface } from "./board-surface";
let win: Window;
let cleanups: (() => void)[];
beforeEach(() => { win = new Window(); cleanups = []; });
afterEach(() => { for (const cleanup of cleanups) cleanup(); win.close(); });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function fixture(options: { conflict?: boolean; preview?: boolean; failRead?: boolean } = {}) {
  const root = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.append(root as never);
  const original = serializeBoardHtml(createBoardDocument("Ideas"));
  let remote = { content: original, baseSha256: sha(original), baseRevision: 1, path: "Ideas.board.html" };
  let current = createBoardDocument();
  let callbacks!: Parameters<typeof mountBoardSurface>[2];
  let change: ((event: DocumentChange) => void) | undefined;
  let prepare: Parameters<NonNullable<BoardBridge["lifecycle"]>["onPrepareClose"]>[0] | undefined;
  let pending = false;
  let malformed = false;
  let mounts = 0;
  const disposed: number[] = [];
  const writes: string[] = [];
  const copies: string[] = [];
  const contexts: unknown[] = [];
  const bridge: BoardBridge = {
    document: {
      async read() { if (options.failRead) throw new Error("offline"); return remote; },
      async write(content, base) {
        expect(base.conflictPolicy).toBe("strict");
        writes.push(content);
        if (options.conflict || base.baseSha256 !== remote.baseSha256 || base.baseRevision !== remote.baseRevision) return { kind: "conflict" };
        remote = { ...remote, content, baseSha256: sha(content), baseRevision: remote.baseRevision + 1 };
        return { kind: "saved", sha256: remote.baseSha256, revision: remote.baseRevision, persistedContent: content };
      },
      async downloadCopy() { throw new Error("Host saveCopy is available"); },
      async saveCopy(content) { copies.push(content); return { path: "Ideas copy.board.html" }; },
      onChange(fn) { change = fn; return () => { change = undefined; }; },
    },
    context: { mode: options.preview ? "preview" : "edit", set(value) { contexts.push(value); } },
    humanEdit: { set() {} },
    lifecycle: { onPrepareClose(fn) { prepare = fn; return () => { prepare = undefined; }; } },
  };
  const cleanup = await mountBoard(root, bridge, {
    mountSurface(stage, model, next) {
      const id = ++mounts;
      const local = structuredClone(model);
      current = local; callbacks = next;
      if (malformed) local.meta.title = "silently lost source";
      const header = stage.ownerDocument.createElement("header");
      const status = stage.ownerDocument.createElement("span");
      header.append(status); stage.append(header);
      return {
        read: () => structuredClone(local),
        async commit() { if (pending) throw new Error("An image is still being placed"); callbacks.editing?.(false); },
        setStatus(text) { status.textContent = text; }, setTitle() {}, setActions(actions) { header.append(...actions); },
        fit() {}, setTheme() {}, viewport: () => ({ panX: 0, panY: 0, zoom: 1 }), selection: () => [],
        hasPendingImages: () => pending,
        dispose() { disposed.push(id); stage.replaceChildren(); },
      };
    },
  });
  cleanups.push(cleanup);
  return {
    root, writes, copies, contexts, disposed,
    get remote() { return remote; }, get current() { return current; },
    get hasLifecycle() { return prepare !== undefined; },
    type(value: string) { callbacks.editing?.(true); current.meta.title = value; callbacks.changed(); },
    repeatDraftNotification() { callbacks.changed(); },
    pendingImage() { pending = true; callbacks.editing?.(true); callbacks.changed(); },
    finishImage() { pending = false; callbacks.editing?.(false); },
    prepare(action: "prepare-close" | "save-copy" = "prepare-close") { return prepare!({ reason: "close", action }); },
    async updateRemote(title: string) {
      const model = parseBoardHtml(remote.content); model.meta.title = title;
      const content = serializeBoardHtml(model);
      remote = { ...remote, content, baseSha256: sha(content), baseRevision: remote.baseRevision + 1 };
      change?.({ type: "changed" }); await settle();
    },
    failAdoption() { malformed = true; },
  };
}
test("active Human edits are held until commit and saved with strict canonical revision", async () => {
  const f = await fixture(); f.type("Human ideas"); await settle();
  expect(f.writes).toHaveLength(0);
  expect((await f.prepare()).documentSaved).toBe(true);
  expect(parseBoardHtml(f.remote.content).meta.title).toBe("Human ideas");
  expect(f.root.dataset.saveState).toBe("saved");
});
test("repeated draft changes do not republish identical host context or remount the header", async () => {
  const f = await fixture(); f.type("Draft");
  const count = f.contexts.length; const header = f.root.querySelector("header");
  for (let i = 0; i < 20; i++) f.repeatDraftNotification();
  expect(f.contexts).toHaveLength(count); expect(f.root.querySelector("header")).toBe(header);
  expect(f.disposed).toHaveLength(0);
});
test("conflicting close keeps source and offers exact recovery copy", async () => {
  const f = await fixture({ conflict: true }); const before = f.remote.content;
  f.type("Keep this draft"); expect((await f.prepare()).documentSaved).toBe(false);
  const copy = await f.prepare("save-copy");
  expect(copy.recoveryPersisted).toBe(true); expect(copy.recoverableDraftExact).toBe(true);
  expect(parseBoardHtml(f.copies[0]).meta.title).toBe("Keep this draft"); expect(f.remote.content).toBe(before);
});
test("pending images cannot authorize a save or close with missing bytes", async () => {
  const f = await fixture(); f.pendingImage();
  await rejects(f.prepare(), /image is still being placed/);
  expect(f.writes).toHaveLength(0); expect(f.root.dataset.saveState).toBe("unsaved");
  f.finishImage(); expect((await f.prepare()).documentSaved).toBe(true);
});
test("a clean canonical Genie update replaces the board while a dirty Human edit is protected", async () => {
  const f = await fixture(); await f.updateRemote("Genie ideas");
  expect(f.current.meta.title).toBe("Genie ideas"); expect(f.writes).toHaveLength(0);
  f.type("Human draft"); await f.updateRemote("Another Genie change");
  expect(f.current.meta.title).toBe("Human draft"); expect(f.root.dataset.saveState).toBe("conflict");
});
test("lossy candidate adoption preserves the existing surface and Save control", async () => {
  const f = await fixture(); const header = f.root.querySelector("header");
  f.failAdoption(); await f.updateRemote("Keep exact model");
  expect(f.disposed).toEqual([2]); expect(f.root.querySelector("header")).toBe(header);
  expect(header?.textContent).toContain("Save"); expect(f.root.dataset.saveState).toBe("error");
});
test("preview opens read only and never registers persistence lifecycle", async () => {
  const f = await fixture({ preview: true });
  expect(f.hasLifecycle).toBe(false); expect(f.root.textContent).toContain("Read only");
  f.type("Ignore mutation callbacks"); await settle(); expect(f.writes).toHaveLength(0);
});
test("failed initial read allows close without claiming a save", async () => {
  const f = await fixture({ failRead: true }); const result = await f.prepare();
  expect(result.noLocalChanges).toBe(true); expect(result.documentSaved).toBe(false);
});
