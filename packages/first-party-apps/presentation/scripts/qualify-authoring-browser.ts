#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/** Hermetic authoring qualification. Authority and persistence are synthetic; the real Slides handlers and sandboxed editor are used. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";
import type { Element } from "../engine/node.js";
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from "../src/slide-document";
import { editOpenPresentation, saveOpenTemplate, type AgentToolContext } from "../src/slide-tools";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/presentation");
const evidence = join(tmpdir(), "stack416-slides-authoring-synthetic.png");
const scratch = await mkdtemp(join(tmpdir(), "stack416-authoring-browser-"));
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let content = serializeSlideHtml(createSlideDocument());
let revision = 1;
let writes = 0;
const templates = new Map<string, { name: string; content: string }>();
/* eslint-disable @typescript-eslint/require-await -- Synthetic host RPCs implement the real asynchronous interface. */
const ctx: AgentToolContext = { nautiloApp: {
  assets: { async read() { return { ok: true, dataUrl: tinyPng, sha256: "b".repeat(64), byteLength: 68, mimeType: "image/png" }; } },
  templates: {
    async list() { return { templates: [...templates].map(([id, value]) => ({ id, name: value.name })), nextCursor: null }; },
    async read({ templateId }) { const value = templates.get(templateId); if (!value) throw new Error("synthetic template missing"); return { content: value.content }; },
    async save(value) { const id = `synthetic-template-${templates.size + 1}`; templates.set(id, value); return { ok: true, template: { id, name: value.name }, stateChanged: true }; },
    async remove({ templateId }) { return { ok: true, stateChanged: templates.delete(templateId) }; },
  },
  document: {
    async createFromAction() { throw new Error("unused in qualification"); },
    async read() { return { content, baseRevision: revision, baseSha256: `synthetic-${revision}`, displayPath: "Synthetic qualification.presentation.html" }; },
    async write() { throw new Error("closed write unused in qualification"); },
    async writeBound(next) { content = next.content; revision += 1; writes += 1; return { kind: "saved" as const, revision, sha256: `synthetic-${revision}` }; },
  },
} };

/* eslint-enable @typescript-eslint/require-await */

const invoke = (operations: unknown[]) => editOpenPresentation({
  expectedVersion: JSON.stringify({ kind: "artifact_revision", revision }),
  documentVersion: { kind: "artifact_revision", revision },
  sessionToken: "synthetic-host-validated",
  __canonicalContent: content,
  operations,
}, ctx);

const initial = parseSlideHtml(content);
const slideId = initial.slides[0].id;
const titleIndex = initial.slides[0].elements.findIndex((element) => element.type === "text");
const title = initial.slides[0].elements[titleIndex];
requireCondition(title?.type === "text", "Fresh native deck has no title text element");
const richBlock = structuredClone(title.data.blocks[0]);
richBlock.inlines = [
  { text: "Ideas become ", style: { fontFamily: "Aptos Display", fontSize: 38, color: "#173B45" } },
  { text: "visible", style: { fontFamily: "Georgia", fontSize: 38, bold: true, italic: true, color: "#E05D44" } },
];
const shape: Element = { id: "hero-orbit", type: "shape", frame: { x: 1390, y: 120, w: 250, h: 250, rotation: 0.18 }, data: { kind: "ellipse", fill: { kind: "gradient", type: "linear", angle: 30, stops: [{ pos: 0, color: { kind: "srgb", value: "#173B45" } }, { pos: 1, color: { kind: "srgb", value: "#E8B44B" } }] } } };
const chart: Element = { id: "momentum-chart", type: "chart", frame: { x: 140, y: 560, w: 650, h: 350, rotation: 0 }, data: { kind: "column", title: "Momentum", categories: ["Now", "Next", "Soon"], series: [{ name: "Teams", values: [18, 47, 83] }] } };
const tableBlock = (id: string, text: string) => ({ ...structuredClone(richBlock), id, inlines: [{ text, style: { fontFamily: "Aptos", fontSize: 18, color: "#173B45" } }] });
const border = { color: "#173B45", width: 2 };
const table: Element = { id: "signal-table", type: "table", frame: { x: 870, y: 610, w: 650, h: 180, rotation: 0 }, data: { columnWidths: [260, 390], rows: [
  { height: 90, cells: [{ body: { blocks: [tableBlock("cell-a", "Signal")] }, style: { fill: "#F5D98A", border: { top: border, right: border, bottom: border, left: border } } }, { body: { blocks: [tableBlock("cell-b", "Human intent")] }, style: { fill: "#F5D98A", border: { top: border, right: border, bottom: border, left: border } } }] },
  { height: 90, cells: [{ body: { blocks: [tableBlock("cell-c", "Result")] }, style: { border: { top: border, right: border, bottom: border, left: border } } }, { body: { blocks: [tableBlock("cell-d", "A reusable native story")] }, style: { border: { top: border, right: border, bottom: border, left: border } } }] },
] } };
const group: Element = { id: "connected-story", type: "group", frame: { x: 950, y: 250, w: 390, h: 230, rotation: -0.12 }, data: { refSize: { w: 300, h: 300 }, children: [
  { id: "group-node", type: "shape", frame: { x: 120, y: 90, w: 90, h: 70, rotation: 0 }, data: { kind: "roundRect", fill: { kind: "srgb", value: "#E05D44" } } },
  { id: "group-link", type: "connector", frame: { x: 0, y: 0, w: 1, h: 1, rotation: 0 }, routing: "curved", curveBend: 0.2, start: { kind: "free", x: 20, y: 240 }, end: { kind: "attached", elementId: "group-node", siteIndex: 3 }, arrowheads: { end: { kind: "triangle", size: "md" } }, stroke: { color: "#173B45", width: 5 } },
] } };

const first = await invoke([
  { op: "apply-theme", themeId: "default-light" },
  { op: "patch", changes: [
    { op: "test", path: `/slides/0/elements/${titleIndex}/id`, value: title.id },
    { op: "replace", path: `/slides/0/elements/${titleIndex}/data/blocks/0`, value: richBlock },
    { op: "add", path: "/slides/0/elements/-", value: shape },
    { op: "add", path: "/slides/0/elements/-", value: chart },
    { op: "add", path: "/slides/0/elements/-", value: table },
    { op: "add", path: "/slides/0/elements/-", value: group },
  ] },
  { op: "insert-image", slideId, asset: { ref: `artifact:11111111-1111-4111-8111-111111111111:${"b".repeat(64)}` }, element: { frame: { x: 1580, y: 700, w: 180, h: 180, rotation: 0.08 }, data: { alt: "Synthetic one-pixel qualification image" } } },
]);
requireCondition(first.ok === true && first.status === "saved", `First authoring revision failed: ${JSON.stringify(first)}`);

const authored = parseSlideHtml(content);
const save = await saveOpenTemplate({
  expectedVersion: JSON.stringify({ kind: "artifact_revision", revision }),
  documentVersion: { kind: "artifact_revision", revision }, sessionToken: "synthetic-host-validated",
  __canonicalContent: content, slideId: authored.slides[0].id, name: "Synthetic authored hero",
}, ctx);
requireCondition(save.ok === true, `Synthetic template capture failed: ${JSON.stringify(save)}`);
const templateId = [...templates.keys()][0];
requireCondition(templateId, "Synthetic template was not persisted");

const second = await invoke([
  { op: "insert-template", templateId, afterSlideId: authored.slides[0].id },
  { op: "patch", changes: [{ op: "replace", path: "/meta/title", value: "Synthetic authoring qualification — revision 2" }] },
]);
requireCondition(second.ok === true && second.status === "saved", `Second authoring revision failed: ${JSON.stringify(second)}`);
requireCondition(writes === 2 && revision === 3, "Expected two atomic document writes and revision 3");
const persisted = parseSlideHtml(content);
requireCondition(persisted.slides.length === 2, "Template reuse did not add exactly one slide");
requireCondition(persisted.slides[1].id !== persisted.slides[0].id, "Template reuse did not remap slide identity");
requireCondition(serializeSlideHtml(parseSlideHtml(serializeSlideHtml(persisted))) === serializeSlideHtml(persisted), "Saved deck changed across serialize/reopen");
const elementTypes = new Set<string>();
const collectTypes = (elements: Element[]): void => elements.forEach((element) => {
  elementTypes.add(element.type);
  if (element.type === "group") collectTypes(element.data.children);
});
persisted.slides.forEach((slide) => collectTypes(slide.elements));

await Bun.write(join(scratch, "entry.ts"), `
import { MemSlidesStore } from ${JSON.stringify(join(appRoot, "engine/browser.js"))};
import { parseSlideHtml } from ${JSON.stringify(join(appRoot, "src/slide-document.ts"))};
import { mountSlidesSurface } from ${JSON.stringify(join(appRoot, "src/slides-surface.ts"))};
const expected=${JSON.stringify(JSON.stringify(persisted))};
const reopened=parseSlideHtml(${JSON.stringify(content)});
const store=new MemSlidesStore(reopened);
const errors=[];
mountSlidesSurface(document.querySelector("#app"),store,{changed(){},editing(){},error(message){errors.push(message);}});
window.__authoringQualification={expected,store,errors};
`);
const built = await Bun.build({ entrypoints: [join(scratch, "entry.ts")], target: "browser", format: "esm", splitting: false, minify: false });
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const bundle = await built.outputs[0].text();
const styles = await Bun.file(join(appRoot, "styles.css")).text();
const runtime = buildMiniAppRuntimeSrcDoc({ appId: "nautilo-presentation-authoring-synthetic-qualification", html: "<!doctype html><html data-theme=\"light\"><body><div id=\"app\"></div></body></html>", styles: [{ path: "styles.css", content: styles }], bundleJs: bundle });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(runtime, { headers: { "content-type": "text/html" } }) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const executablePath = process.env["NAUTILO_SLIDES_CHROME_EXECUTABLE"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("button", { name: "Add slide" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".wfb-slides-thumb").length === 2);
  const adoption = await page.evaluate(() => ({
    value: JSON.stringify(window.__authoringQualification.store.read()),
    expected: window.__authoringQualification.expected,
    errors: window.__authoringQualification.errors,
    canvas: document.querySelector(".ps-canvas") instanceof HTMLCanvasElement,
    thumbnails: document.querySelectorAll(".wfb-slides-thumb").length,
  }));
  requireCondition(adoption.value === adoption.expected, "Real editor store adoption changed persisted native data");
  requireCondition(adoption.canvas && adoption.thumbnails === 2, "Real editor did not render the authored two-slide deck");
  requireCondition(adoption.errors.length === 0 && pageErrors.length === 0, `Renderer errors: ${JSON.stringify([...adoption.errors, ...pageErrors])}`);
  await page.screenshot({ path: evidence, fullPage: true });
  console.log(JSON.stringify({ qualified: true, authority: "synthetic host only", handlers: ["editOpenPresentation", "saveOpenTemplate"], revisions: revision, atomicWrites: writes, slides: persisted.slides.length, elementTypes: [...elementTypes].sort(), evidence }));
} finally {
  await browser?.close();
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}

declare global { interface Window { __authoringQualification: any } }
