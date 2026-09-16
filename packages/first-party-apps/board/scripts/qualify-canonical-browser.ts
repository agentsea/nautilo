import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createBoardDocument, parseBoardHtml, serializeBoardHtml } from "../src/board-document";
import type { BoardModel } from "@nautilo/office-board";
const root = resolve(import.meta.dir, "..");
const out = resolve(root, "../../../docs/office-engines/board-native");
await mkdir(out, { recursive: true });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const initial = serializeBoardHtml(createBoardDocument("Connected ideas"));
let canonical = { content: initial, baseSha256: hash(initial), baseRevision: 1, path: "Connected ideas.board.html" };
let writes = 0;
let recoveryRevision: string | null = null;
let recoveryDraft: unknown = null;
let recoveryWrites = 0;
const copies: string[] = [];
const contexts: unknown[] = [];
const checks: string[] = [];
const errors: string[] = [];
const bundle = await Bun.file(join(root, "engine/main.js")).text();
const css = await Bun.file(join(root, "styles.css")).text();
const bootstrap = `
const preview = new URL(location.href).searchParams.has('preview');
let changed; let close;
const json = async (path,body) => { const response = await fetch(path, body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {}); if (!response.ok) throw new Error(await response.text()); return response.json(); };
window.nautiloApp = {
 document: { read: () => json('/document'), write: (content,base) => json('/save',{content,base}), downloadCopy: async () => { throw new Error('Use host save copy'); }, saveCopy: content => json('/copy',{content}), onChange: fn => { changed=fn; return () => {changed=undefined}; } },
 recovery: { read: () => json('/recovery'), write: input => json('/recovery',input) },
 context: { mode: preview ? 'preview' : 'edit', set: value => {void json('/context',value)} },
 humanEdit: {set: value => {window.humanState=value.state}},
 lifecycle: { onPrepareClose: fn => {close=fn; return () => {close=undefined}} }
};
window.boardAcceptance = { notify: () => changed?.({type:'changed'}), close: () => close?.({reason:'close',action:'prepare-close'}) };
`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/document") return Response.json(canonical);
  if (path === "/save") {
    const { content, base } = await request.json() as { content: string; base: typeof canonical & { conflictPolicy: string } };
    assert.equal(base.conflictPolicy, "strict");
    if (base.baseRevision !== canonical.baseRevision || base.baseSha256 !== canonical.baseSha256) return Response.json({ kind: "conflict" });
    parseBoardHtml(content); writes++;
    canonical = { ...canonical, content, baseRevision: canonical.baseRevision + 1, baseSha256: hash(content) };
    return Response.json({ kind: "saved", persistedContent: content, sha256: canonical.baseSha256, revision: canonical.baseRevision });
  }
  if (path === "/copy") { const { content } = await request.json() as { content: string }; copies.push(content); return Response.json({ path: "Recovered ideas.board.html" }); }
  if (path === "/recovery") {
    if (request.method !== "POST") return Response.json({ revision: recoveryRevision, draft: recoveryDraft });
    const input = await request.json() as { expectedRevision: string | null; draft: unknown };
    if (input.expectedRevision !== recoveryRevision) return new Response("recovery conflict", { status: 409 });
    recoveryDraft = input.draft; recoveryRevision = `recovery-${++recoveryWrites}`;
    return Response.json({ revision: recoveryRevision });
  }
  if (path === "/context") { contexts.push(await request.json()); return Response.json({}); }
  if (path === "/main.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
  return new Response(`<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/styles.css"></head><body><main id="app"></main><script>${bootstrap}</script><script type="module" src="/main.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on("pageerror", error => errors.push(error.message));
const text = (m: BoardModel) => JSON.stringify(m.elements);
const saved = () => page.locator('#app[data-save-state="saved"]').waitFor();
const turns = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2lY5QAAAABJRU5ErkJggg==";
const png = Buffer.from(pngData, "base64");
const installDeferredReader = () => page.evaluate(() => {
  const NativeReader = window.FileReader;
  class DeferredReader extends NativeReader {
    private input?: Blob;
    override readAsDataURL(input: Blob): void {
      this.input = input;
      (window as unknown as { pendingImageReader: DeferredReader }).pendingImageReader = this;
    }
    release(): void { if (this.input) super.readAsDataURL(this.input); }
    override abort(): void { this.onabort?.(new ProgressEvent("abort") as ProgressEvent<FileReader>); }
    fail(): void { this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>); }
  }
  window.FileReader = DeferredReader;
});
try {
  await page.goto(server.url.toString());
  await saved();
  await page.getByRole("button", { name: "Add your first note", exact: true }).click();
  await page.keyboard.type("A board worth saving.");
  await turns();
  assert.equal(writes, 0, "Typing must hold canonical writes");
  await page.evaluate(() => {
    Object.assign(window, { oldHeader: document.querySelector('.bd-header'), headerChanges: 0 });
    new MutationObserver(records => { (window as unknown as {headerChanges:number}).headerChanges += records.length; })
      .observe(document.querySelector('.bd-header')!, { childList: true, subtree: true, characterData: true });
  });
  const count = contexts.length;
  await page.keyboard.type(" Every letter stays put.");
  await turns();
  assert.equal(contexts.length, count, "Typing identical context must not republish host state");
  assert.equal(await page.evaluate(() => (window as unknown as {headerChanges:number}).headerChanges), 0);
  assert.equal(await page.evaluate(() => document.querySelector('.bd-header') === (window as unknown as {oldHeader:Element}).oldHeader), true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved();
  assert(text(parseBoardHtml(canonical.content)).includes("A board worth saving. Every letter stays put."));
  checks.push("real native typing holds autosave, stable header/context, explicit Save commits exact canonical bytes");
  const beforeReload = canonical.content;
  await page.reload(); await saved();
  assert.equal(canonical.content, beforeReload);
  assert.equal(await page.locator('.bd-empty').isVisible(), false);
  checks.push("fresh page reopen renders the persisted native board without a write");
  const beforeRejectedImage = canonical.content;
  await page.locator('input[type="file"]').setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>') });
  await page.getByText("Choose a PNG, JPEG, GIF or WebP image. Your board is unchanged.", { exact: false }).first().waitFor();
  assert.equal(canonical.content, beforeRejectedImage);
  assert.equal(await page.evaluate(() => (window as unknown as {humanState:string}).humanState), "clean");
  await page.getByRole("button", { name: "Save", exact: true }).click(); await saved();
  checks.push("unsupported image is refused before changing the model or dirty Human lease");

  const beforeCorrupt = { content: canonical.content, revision: canonical.baseRevision, writes };
  await page.locator('input[type="file"]').setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
  await page.getByText("image format could not be decoded", { exact: false }).waitFor(); await turns();
  assert.deepEqual({ content: canonical.content, revision: canonical.baseRevision, writes }, beforeCorrupt);
  assert.equal(await page.evaluate(() => (window as unknown as {humanState:string}).humanState), "clean");
  checks.push("decode failure leaves canonical bytes, revision and clean Human state unchanged");

  await installDeferredReader();
  const beforePending = { content: canonical.content, revision: canonical.baseRevision, writes };
  await page.locator('input[type="file"]').setInputFiles({ name: "pending.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => (window as unknown as {humanState:string}).humanState === "dirty"); await turns();
  assert.equal((recoveryDraft as { exact?: boolean } | null)?.exact, false);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("image is still being placed", { exact: false }).waitFor();
  const pendingClose = await page.evaluate(() =>
    (window as unknown as {boardAcceptance:{close():Promise<unknown>}}).boardAcceptance.close()
      .then(() => ({ ok: true, message: "" }), error => ({ ok: false, message: error instanceof Error ? error.message : String(error) })));
  assert.equal(pendingClose.ok, false); assert.match(pendingClose.message, /image is still being placed/i);
  assert.deepEqual({ content: canonical.content, revision: canonical.baseRevision, writes }, beforePending);
  await page.evaluate(() => (window as unknown as {pendingImageReader:{release():void}}).pendingImageReader.release());
  await page.waitForFunction(() => document.querySelectorAll('.bd-stage canvas').length > 0 && (window as unknown as {humanState:string}).humanState === "clean");
  await saved(); await turns();
  const inserted = parseBoardHtml(canonical.content).elements.filter(element => element.type === "image");
  assert.equal(inserted.length, 1); assert.equal(inserted[0].type, "image");
  if (inserted[0].type === "image") assert.equal(inserted[0].data.src, `data:image/png;base64,${pngData}`);
  assert.equal(writes, beforePending.writes + 1); assert.equal(recoveryDraft, null);
  checks.push("pending real image refuses Save/close, journals exact:false, then saves exact bytes once after release");

  await page.reload(); await saved(); await installDeferredReader();
  const beforeAbort = { content: canonical.content, revision: canonical.baseRevision, writes };
  await page.locator('input[type="file"]').setInputFiles({ name: "abort.png", mimeType: "image/png", buffer: png });
  await page.evaluate(() => (window as unknown as {pendingImageReader:FileReader}).pendingImageReader.abort()); await turns();
  assert.deepEqual({ content: canonical.content, revision: canonical.baseRevision, writes }, beforeAbort);
  assert.equal(await page.evaluate(() => (window as unknown as {humanState:string}).humanState), "clean");
  await installDeferredReader();
  await page.locator('input[type="file"]').setInputFiles({ name: "error.png", mimeType: "image/png", buffer: png });
  await page.evaluate(() => (window as unknown as {pendingImageReader:{fail():void}}).pendingImageReader.fail()); await turns();
  assert.deepEqual({ content: canonical.content, revision: canonical.baseRevision, writes }, beforeAbort);
  checks.push("reader abort and reader error leave canonical bytes, revision and writes unchanged");

  await installDeferredReader();
  await page.locator('input[type="file"]').setInputFiles({ name: "restart.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => (window as unknown as {humanState:string}).humanState === "dirty"); await turns();
  assert.equal((recoveryDraft as { exact?: boolean } | null)?.exact, false);
  const beforePendingReload = { content: canonical.content, revision: canonical.baseRevision, writes };
  await page.reload();
  await page.locator('#app[data-save-state="conflict"]').waitFor();
  await page.getByText("unfinished operation may be missing", { exact: false }).waitFor();
  assert.deepEqual({ content: canonical.content, revision: canonical.baseRevision, writes }, beforePendingReload);
  checks.push("reload during pending image restores the inexact journal in conflict without writing canonical bytes");
  recoveryDraft = null; recoveryRevision = `recovery-${++recoveryWrites}`;
  await page.reload(); await saved();
  const beforePalette = canonical.content;
  await page.screenshot({ path: join(out, "canonical-ivory.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.board-app[data-theme="dark"]').waitFor();
  await page.screenshot({ path: join(out, "canonical-tokyo.png") });
  assert.equal(canonical.content, beforePalette);
  checks.push("Ivory and Tokyo palette changes preserve canonical bytes");
  // External canonical update conflicts with an active Human note, preserving it.
  await page.getByRole("button", { name: "Sticky note (N)", exact: true }).click();
  await page.keyboard.type("Do not lose this Human draft.");
  const remote = parseBoardHtml(canonical.content); remote.meta.title = "Changed elsewhere";
  const changed = serializeBoardHtml(remote);
  canonical = { ...canonical, content: changed, baseSha256: hash(changed), baseRevision: canonical.baseRevision + 1 };
  await page.evaluate(() => (window as unknown as {boardAcceptance:{notify():void}}).boardAcceptance.notify());
  await page.locator('#app[data-save-state="conflict"]').waitFor();
  await page.getByRole("button", { name: "Save a copy", exact: true }).click();
  await page.getByText("Copy saved as Recovered ideas.board.html", { exact: false }).waitFor();
  assert.equal(copies.length, 1); assert(text(parseBoardHtml(copies[0])).includes("Do not lose this Human draft."));
  assert.equal(canonical.content, changed);
  checks.push("concurrent canonical update preserves active Human text and saves an exact separate copy");
  await page.goto(`${server.url}?preview=1`);
  await saved();
  const previewWrites = writes;
  assert.equal(await page.getByRole("button", {name:"Save",exact:true}).count(), 0);
  await page.keyboard.press('Control+s'); await turns();
  assert.equal(writes, previewWrites);
  assert.equal(await page.evaluate(() => (window as unknown as {boardAcceptance:{close():unknown}}).boardAcceptance.close()), undefined);
  checks.push("read-only native preview renders canonical content without Save or close-write registration");
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), scope: "Prepared Board application with an HTTP canonical bridge fixture; no live Nautilo account or provider", checks, writes, errors };
  await Bun.write(join(out,"canonical-qualification.json"), JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); await server.stop(true); }
