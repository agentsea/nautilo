#!/usr/bin/env bun
/**
 * Hermetic recovery qualification for the real Presentation editor.
 * The in-page authority is a deterministic strict-CAS fault fixture. This proves
 * browser/session behavior only; it is not an authenticated server qualification.
 */
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";
import { createSlideDocument, serializeSlideHtml } from "../src/slide-document";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/presentation");
const initialDocument = createSlideDocument();
initialDocument.meta.title = "Recovery qualification";
const initial = serializeSlideHtml(initialDocument);
const concurrentDocument = structuredClone(initialDocument);
concurrentDocument.slides[0].notes = [{
  id: "remote-note", type: "paragraph", inlines: [{ text: "Remote authority note", style: {} }],
  style: { alignment: "left", lineHeight: 1.5, marginTop: 0, marginBottom: 8, textIndent: 0, marginLeft: 0 },
}];
const concurrent = serializeSlideHtml(concurrentDocument);

const built = await Bun.build({
  entrypoints: [join(appRoot, "main.ts")], target: "browser", format: "esm",
  minify: false, sourcemap: "none", splitting: false,
});
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const output = built.outputs[0];
requireCondition(output, "Presentation browser bundle emitted no output.");
const bundle = await output.text();
const styles = await Bun.file(join(appRoot, "styles.css")).text();
const fixtureScript = `<script>
const initial = ${JSON.stringify(initial).replaceAll("<", "\\u003c")};
const concurrent = ${JSON.stringify(concurrent).replaceAll("<", "\\u003c")};
let authority = { content: initial, baseRevision: 1, baseSha256: "sha-1", path: "Recovery qualification.presentation.html" };
let writeMode = "saved";
let changeHandler;
let prepareHandler;
const writes = [];
const copies = [];
const fixture = {
  writes, copies,
  get authority(){ return authority; },
  setWriteMode(mode){ writeMode = mode; },
  concurrent(){ authority = { content: concurrent, baseRevision: authority.baseRevision + 1, baseSha256: "sha-" + (authority.baseRevision + 1), path: authority.path }; },
  signal(){ changeHandler?.({type:"changed"}); },
  async prepare(action = "prepare-close"){ if (!prepareHandler) throw new Error("prepare-close handler unavailable"); return await prepareHandler({reason:"close", action}); }
};
window.__recoveryFixture = fixture;
window.nautiloApp = {
 document: {
  read: async () => ({...authority}),
  write: async (next, base) => {
   writes.push({content:next, base:{baseRevision:base.baseRevision, baseSha256:base.baseSha256, conflictPolicy:base.conflictPolicy}});
   if (writeMode === "conflict-on-write") {
    fixture.concurrent();
    return {kind:"conflict", currentSha256:authority.baseSha256};
   }
   if (base.conflictPolicy !== "strict" || base.baseRevision !== authority.baseRevision || base.baseSha256 !== authority.baseSha256) return {kind:"conflict", currentSha256:authority.baseSha256};
   if (writeMode === "error-unchanged") return {kind:"error", message:"fixture transport unavailable"};
   authority = {content:next, baseRevision:authority.baseRevision + 1, baseSha256:"sha-" + (authority.baseRevision + 1), path:authority.path};
   if (writeMode === "throw-after-commit") throw new Error("fixture completion unknown");
   return {kind:"saved", revision:authority.baseRevision, sha256:authority.baseSha256, persistedContent:authority.content, path:authority.path};
  },
  onChange: (handler) => { changeHandler = handler; return () => { if (changeHandler === handler) changeHandler = undefined; }; },
  downloadCopy: async (content) => { copies.push(content); },
  saveCopy: async (content) => {
   copies.push(content);
   return {path:"Recovery qualification copy.presentation.html"};
  }
 },
 context: {set: () => {}}, humanEdit: {set: () => {}},
 lifecycle: {onPrepareClose: (handler) => { prepareHandler = handler; return () => { if (prepareHandler === handler) prepareHandler = undefined; }; }}
};
</script>`;
const appHtml = `<!doctype html><html data-theme="light"><body><div id="app"></div>${fixtureScript}</body></html>`;
const runtime = buildMiniAppRuntimeSrcDoc({
  appId: "nautilo-presentation-recovery-qualification", html: appHtml,
  styles: [{ path: "styles.css", content: styles }], bundleJs: bundle,
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(runtime, { headers: { "content-type": "text/html; charset=utf-8" } }) });

type BrowserFixture = {
  writes: Array<{ content: string; base: { baseRevision: number; baseSha256: string; conflictPolicy: string } }>;
  copies: string[];
  authority: { content: string; baseRevision: number; baseSha256: string };
  setWriteMode(mode: string): void;
  concurrent(): void;
  signal(): void;
  prepare(action?: "prepare-close" | "save-copy"): Promise<{ documentSaved: boolean; recoveryPersisted: boolean; recoverableDraftExact: boolean; errorMessage?: string }>;
};

async function ready(page: Page): Promise<void> {
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("button", { name: "Show speaker notes" }).waitFor();
}

async function editNotes(page: Page, value: string, keepFocused = false): Promise<void> {
  await page.getByRole("button", { name: "Show speaker notes" }).click();
  const notes = page.getByPlaceholder("Speaker notes…");
  await notes.fill(value);
  if (!keepFocused) await notes.blur();
}

async function fixture<T>(page: Page, run: (value: BrowserFixture) => T | Promise<T>): Promise<T> {
  const handle = await page.evaluateHandle(() => (window as unknown as { __recoveryFixture: BrowserFixture }).__recoveryFixture);
  try { return await handle.evaluate(run); }
  finally { await handle.dispose(); }
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const chrome = process.env["NAUTILO_SLIDES_CHROME_EXECUTABLE"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });

  // Raw focused draft + concurrent authority: keep editing, exact recovery copy,
  // then explicit discard/reload. No remote content may replace the draft early.
  await ready(page);
  await editNotes(page, "Focused local draft", true);
  await fixture(page, (value) => { value.concurrent(); value.signal(); });
  await page.locator('[data-save-state="conflict"]').waitFor();
  requireCondition(await page.getByPlaceholder("Speaker notes…").inputValue() === "Focused local draft", "Concurrent authority replaced the focused raw draft.");
  const refusedClose = await fixture(page, (value) => value.prepare());
  requireCondition(!refusedClose.documentSaved && refusedClose.errorMessage?.includes("changed elsewhere"), "Conflict close did not refuse with a truthful recovery message.");
  const copiedClose = await fixture(page, (value) => value.prepare("save-copy"));
  requireCondition(copiedClose.recoveryPersisted && copiedClose.recoverableDraftExact, "Save-copy close did not persist an exact recoverable draft.");
  const copied = await fixture(page, (value) => value.copies.at(-1));
  requireCondition(copied && copied.includes("Focused local draft"), "Recovery copy lost the focused raw draft.");
  await page.getByRole("button", { name: "Reload latest" }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  requireCondition(await page.getByPlaceholder("Speaker notes…").inputValue() === "Focused local draft", "Keep editing discarded the local draft.");
  await page.getByRole("button", { name: "Reload latest" }).click();
  await page.getByRole("button", { name: "Reload latest" }).last().click();
  await page.getByRole("button", { name: "Show speaker notes" }).click();
  await page.getByPlaceholder("Speaker notes…").waitFor({ state: "visible" });
  requireCondition(await page.getByPlaceholder("Speaker notes…").inputValue() === "Remote authority note", "Explicit reload did not adopt current authority.");

  // Strict CAS conflict injected at write time retains the real editor draft.
  await ready(page);
  await fixture(page, (value) => value.setWriteMode("conflict-on-write"));
  await editNotes(page, "CAS-local draft");
  await page.locator('[data-save-state="conflict"]').waitFor();
  const conflictState = await fixture(page, (value) => ({ writes: value.writes, authority: value.authority }));
  requireCondition(conflictState.writes.length === 1, "Strict-CAS conflict retried unexpectedly.");
  const conflictWrite = conflictState.writes[0];
  requireCondition(conflictWrite, "Strict-CAS conflict recorded no write.");
  requireCondition(conflictWrite.base.conflictPolicy === "strict" && conflictWrite.base.baseRevision === 1 && conflictWrite.base.baseSha256 === "sha-1", "Conflict write did not use the inspected strict-CAS base.");
  requireCondition(conflictState.authority.content.includes("Remote authority note"), "Concurrent authority was overwritten by the local conflict.");
  requireCondition(await page.getByPlaceholder("Speaker notes…").inputValue() === "CAS-local draft", "Strict-CAS conflict replaced the local editor draft.");

  // Unknown completion: the fixture commits then throws. A change signal must
  // reconcile exact authority without a duplicate write or losing editor state.
  await ready(page);
  await fixture(page, (value) => value.setWriteMode("throw-after-commit"));
  await editNotes(page, "Uncertain committed draft");
  await page.locator('[data-save-state="error"]').waitFor();
  requireCondition(await fixture(page, (value) => value.writes.length) === 1, "Unknown completion did not stop after its first write.");
  await fixture(page, (value) => value.signal());
  await page.locator('[data-save-state="saved"]').waitFor();
  requireCondition(await fixture(page, (value) => value.writes.length) === 1, "Reconciliation duplicated an already committed uncertain write.");
  requireCondition(await page.getByPlaceholder("Speaker notes…").inputValue() === "Uncertain committed draft", "Reconciliation lost the uncertain committed draft.");

  // Definite failure with unchanged authority: signal-driven reconciliation may
  // retry only after proving the original CAS base is still current.
  await ready(page);
  await fixture(page, (value) => value.setWriteMode("error-unchanged"));
  await editNotes(page, "Retryable failed draft");
  await page.locator('[data-save-state="error"]').waitFor();
  await fixture(page, (value) => { value.setWriteMode("saved"); value.signal(); });
  await page.locator('[data-save-state="saved"]').waitFor();
  const retryState = await fixture(page, (value) => ({ writes: value.writes, authority: value.authority }));
  requireCondition(retryState.writes.length === 2, "Unchanged-authority failure did not make exactly one safe retry.");
  requireCondition(retryState.writes.every((write) => write.base.baseRevision === 1 && write.base.baseSha256 === "sha-1" && write.base.conflictPolicy === "strict"), "Safe retry changed or weakened its strict-CAS base.");
  requireCondition(retryState.authority.content.includes("Retryable failed draft"), "Safe retry did not persist the retained draft.");

  console.log(JSON.stringify({
    ok: true,
    hermetic: true,
    proven: [
      "focused raw draft survives concurrent authority",
      "conflicted close refuses",
      "save-copy close preserves exact draft",
      "keep editing preserves draft",
      "explicit reload adopts authority",
      "strict-CAS write conflict preserves both sides",
      "unknown committed write reconciles without duplicate",
      "unchanged-authority failure retries once with the same CAS base",
    ],
  }));
} finally {
  await browser?.close();
  await server.stop(true);
}
