#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
/** Hermetic browser proof for reusable Slides templates. No Nautilo instance is accessed. */
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/presentation");
const evidence = join(tmpdir(), "stack416-slides-template-evidence");
const scratch = await mkdtemp(join(tmpdir(), "stack416-template-browser-"));
await Bun.write(join(scratch, "entry.ts"), `
import { MemSlidesStore } from ${JSON.stringify(join(appRoot, "engine/browser.js"))};
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from ${JSON.stringify(join(appRoot, "src/slide-document.ts"))};
import { mountSlidesSurface } from ${JSON.stringify(join(appRoot, "src/slides-surface.ts"))};
const deck = createSlideDocument();
const title = deck.slides[0].elements.find((element) => element.type === "text");
if (!title) throw new Error("fixture title missing");
title.data.blocks[0].inlines[0].text = "Studio North";
const imageId = "template-image";
deck.slides[0].elements.push({id:imageId,type:"image",frame:{x:1380,y:120,w:320,h:240,rotation:0},data:{src:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}});
const store = new MemSlidesStore(deck);
const records = new Map(); let nextId = 1; let failSave = true;
const library = {
 list: async () => [...records].map(([id, value]) => ({id, name:value.name})),
 read: async (id) => { const value=records.get(id); if(!value) throw new Error("missing template"); return {content:value.content}; },
 save: async (input) => { if(failSave){failSave=false;throw new Error("synthetic permission failure");} const id=String(nextId++);records.set(id,input);return{id,name:input.name}; },
 remove: async (id) => { records.delete(id); }
};
const root=document.querySelector("#app");
const errors=[];
const surface=mountSlidesSurface(root,store,{changed(){},editing(){},error(message){errors.push(message);}}, {templates:library});
window.__templateFixture={store,library,records,errors,surface,serializeSlideHtml,reopen:(content)=>new MemSlidesStore(parseSlideHtml(content)),titleFrame:title.frame};
`);
const built = await Bun.build({ entrypoints: [join(scratch, "entry.ts")], target: "browser", format: "esm", splitting: false, minify: false });
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const bundle = await built.outputs[0].text();
const styles = await Bun.file(join(appRoot, "styles.css")).text();
const html = '<!doctype html><html data-theme="light"><body><div id="app"></div></body></html>';
const runtime = buildMiniAppRuntimeSrcDoc({ appId: "nautilo-presentation-template-qualification", html, styles: [{ path: "styles.css", content: styles }], bundleJs: bundle });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(runtime, { headers: { "content-type": "text/html" } }) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const executablePath = process.env["NAUTILO_SLIDES_CHROME_EXECUTABLE"];
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, deviceScaleFactor: 2 });
  page.on("console", (message) => console.log(`browser:${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => console.log(`browser:pageerror: ${error.message}`));
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("button", { name: "Add slide" }).waitFor();
  const canvas = page.locator(".ps-canvas");
  const [box, frame] = await Promise.all([canvas.boundingBox(), page.evaluate(() => window.__templateFixture.titleFrame)]);
  requireCondition(box, "Slides canvas missing");
  await page.mouse.dblclick(box.x + (frame.x + frame.w / 2) / 1920 * box.width, box.y + (frame.y + frame.h / 2) / 1080 * box.height);
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Uncommitted launch story");
  await page.getByLabel("Slide menu").click();
  await page.getByRole("button", { name: "Save slide as template" }).click();
  const name = page.getByLabel("Template name");
  await name.fill("Launch hero");
  await page.getByRole("button", { name: "Save template" }).click();
  await page.getByText("Couldn’t save template: synthetic permission failure").waitFor();
  requireCondition(await name.inputValue() === "Launch hero", "Failed save discarded the template name");
  await page.getByRole("button", { name: "Save template" }).click();
  await page.getByRole("tab", { name: "My Templates" }).waitFor();
  await page.getByRole("button", { name: "Insert Launch hero template" }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".ps-design-grid--templates canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d");
    if (!context) return false;
    const pixel = context.getImageData(Math.round(canvas.width * .80), Math.round(canvas.height * .22), 1, 1).data;
    return pixel[3] > 0 && pixel[0] < 30 && pixel[1] < 30 && pixel[2] < 30;
  });
  const stored = await page.evaluate(() => [...window.__templateFixture.records.values()][0]?.content ?? "");
  requireCondition(stored.includes("Uncommitted launch story"), "Template missed the active text draft");
  await page.evaluate(() => {
    const current = window.__templateFixture.store.read().themes[0];
    window.__templateFixture.store.batch(() => {
      window.__templateFixture.store.addTheme({ ...current, id: "target-theme", name: "Target theme", colors: { ...current.colors, background: "#e8f0ec", accent1: "#c85040" } });
      window.__templateFixture.store.applyTheme("target-theme");
    });
  });
  await page.getByRole("button", { name: "Insert Launch hero template" }).click();
  requireCondition(await page.evaluate(() => window.__templateFixture.store.read().slides.length) === 2, "Template insert did not add one slide");
  await page.getByRole("button", { name: "Undo" }).click();
  requireCondition(await page.evaluate(() => window.__templateFixture.store.read().slides.length) === 1, "Template insert was not one undo step");
  await page.getByRole("button", { name: "Insert Launch hero template" }).click();
  await Bun.write(evidence + "-light.png", await page.screenshot());
  await page.getByRole("button", { name: "Delete Launch hero template" }).click();
  await page.getByRole("alertdialog", { name: "Delete Launch hero template?" }).getByRole("button", { name: "Delete" }).click();
  await page.waitForFunction(() => window.__templateFixture.records.size === 0);
  requireCondition(await page.evaluate(() => window.__templateFixture.store.read().slides.length) === 2, "Deleting template changed an inserted slide");
  const reopened = await page.evaluate(() => {
    const content = window.__templateFixture.serializeSlideHtml(window.__templateFixture.store.read());
    return window.__templateFixture.reopen(content).read();
  });
  requireCondition(JSON.stringify(reopened).includes("Uncommitted launch story"), "Inserted template did not survive reopening");
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.setViewportSize({ width: 680, height: 720 });
  await Bun.write(evidence + "-dark-narrow.png", await page.screenshot());
  console.log(`Qualified Slides templates; evidence: ${evidence}-{light,dark-narrow}.png`);
} finally {
  await browser?.close();
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

declare global {
  interface Window { __templateFixture: any; }
}
