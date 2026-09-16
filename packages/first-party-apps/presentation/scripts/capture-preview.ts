#!/usr/bin/env bun
/** Capture the real Slides editor with a fictional, reproducible showcase deck.
 * No user instance, account, or persisted Nautilo data is accessed.
 */
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";
import { createSlideDocument, serializeSlideHtml } from "../src/slide-document";

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/presentation");
const output = join(repository, "apps/workbench/public/apps/office/slides-preview.png");
const document = createSlideDocument();
document.meta.title = "Studio North — Autumn Launch";
document.themes[0].colors = {
  ...document.themes[0].colors,
  text: "#173F37",
  background: "#FBF8F0",
  textSecondary: "#667B74",
  backgroundAlt: "#E6F0EA",
  accent1: "#E65A3F",
  accent2: "#2B665A",
  accent3: "#EAB95B",
};

const text = (id: string, value: string, x: number, y: number, w: number, h: number, size: number, color: string, weight?: "bold") => ({
  id,
  type: "text" as const,
  frame: { x, y, w, h, rotation: 0 },
  data: {
    autofit: "shrink" as const,
    blocks: [{
      id: `${id}-block`,
      type: "paragraph" as const,
      inlines: [{ text: value, style: { fontFamily: "Inter", fontSize: size, color, ...(weight ? { bold: true } : {}) } }],
      style: { alignment: "left" as const, lineHeight: 1.15, marginTop: 0, marginBottom: 0, textIndent: 0, marginLeft: 0 },
    }],
  },
});
const shape = (id: string, x: number, y: number, w: number, h: number, color: string, kind: "rect" | "roundRect" | "ellipse" = "rect") => ({
  id,
  type: "shape" as const,
  frame: { x, y, w, h, rotation: 0 },
  data: { kind, fill: { kind: "srgb" as const, value: color } },
});
const note = (id: string, value: string) => ({
  id,
  type: "paragraph" as const,
  inlines: [{ text: value, style: {} }],
  style: { alignment: "left" as const, lineHeight: 1.5, marginTop: 0, marginBottom: 8, textIndent: 0, marginLeft: 0 },
});

document.slides = [
  {
    id: "launch-cover", layoutId: "blank", background: { fill: { kind: "srgb", value: "#FBF8F0" } },
    elements: [
      shape("cover-band", 0, 0, 310, 1080, "#173F37"),
      shape("cover-dot", 1550, 120, 210, 210, "#EAB95B", "ellipse"),
      shape("cover-mark", 1510, 690, 310, 160, "#E65A3F", "roundRect"),
      text("eyebrow", "STUDIO NORTH  /  AUTUMN 2026", 430, 270, 900, 60, 22, "#2B665A", "bold"),
      text("title", "Make room\nfor wonder.", 430, 370, 1040, 300, 76, "#173F37", "bold"),
      text("subtitle", "A launch story built for people who still look up.", 435, 720, 930, 70, 25, "#667B74"),
    ],
    notes: [note("cover-note", "Open on the feeling: the city is loud, the product creates a quiet moment of discovery.")],
  },
  {
    id: "launch-idea", layoutId: "blank", background: { fill: { kind: "srgb", value: "#173F37" } },
    elements: [
      text("idea-kicker", "01  /  THE IDEA", 120, 100, 600, 55, 20, "#AFC9BF", "bold"),
      text("idea-title", "A calmer kind\nof momentum.", 120, 230, 1050, 250, 65, "#FBF8F0", "bold"),
      shape("idea-line", 124, 560, 1100, 8, "#E65A3F"),
      text("idea-copy", "Less noise. More signal. A campaign that earns attention through clarity, warmth, and one unforgettable color.", 120, 640, 1230, 160, 28, "#DCE8E2"),
      shape("idea-orbit", 1515, 610, 215, 215, "#EAB95B", "ellipse"),
    ],
    notes: [note("idea-note", "Pause after ‘less noise.’ Let the contrast with the launch category land before revealing the visual system.")],
  },
  {
    id: "launch-system", layoutId: "blank", background: { fill: { kind: "srgb", value: "#FBF8F0" } },
    elements: [
      text("system-kicker", "02  /  VISUAL SYSTEM", 120, 90, 700, 55, 20, "#2B665A", "bold"),
      text("system-title", "Three notes.\nOne clear voice.", 120, 200, 760, 210, 55, "#173F37", "bold"),
      shape("system-a", 1030, 170, 610, 170, "#E65A3F", "roundRect"),
      shape("system-b", 1030, 390, 610, 170, "#2B665A", "roundRect"),
      shape("system-c", 1030, 610, 610, 170, "#EAB95B", "roundRect"),
      text("system-copy", "Warm ivory grounds the story. Forest green carries trust. Vermilion creates the pulse.", 120, 520, 690, 180, 27, "#667B74"),
    ],
    notes: [note("system-note", "The palette should feel editorial rather than ornamental. Use vermilion only where we want the eye to stop.")],
  },
  {
    id: "launch-plan", layoutId: "blank", background: { fill: { kind: "srgb", value: "#E6F0EA" } },
    elements: [
      text("plan-kicker", "03  /  LAUNCH RHYTHM", 120, 90, 700, 55, 20, "#2B665A", "bold"),
      text("plan-title", "Tease. Reveal.\nKeep moving.", 120, 200, 800, 220, 57, "#173F37", "bold"),
      shape("plan-one", 1040, 170, 160, 610, "#173F37", "roundRect"),
      shape("plan-two", 1260, 300, 160, 480, "#E65A3F", "roundRect"),
      shape("plan-three", 1480, 430, 160, 350, "#EAB95B", "roundRect"),
      text("plan-copy", "Week 01 · a quiet signal\nWeek 02 · the full reveal\nWeek 03 · stories in motion", 120, 540, 720, 190, 25, "#2B665A"),
    ],
    notes: [note("plan-note", "Close with pace: each week adds energy without changing the core visual promise.")],
  },
];

const content = serializeSlideHtml(document);
const built = await Bun.build({
  entrypoints: [join(appRoot, "main.ts")], target: "browser", format: "esm",
  minify: true, sourcemap: "none", splitting: false,
});
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const html = `<!doctype html><html data-theme="light"><body><div id="app"></div><script>
const content = ${JSON.stringify(content).replaceAll("<", "\\u003c")};
window.nautiloApp = {
 document: {
  read: async () => ({content, baseRevision:1, baseSha256:"showcase", path:"Studio North launch.presentation.html"}),
  write: async () => { throw new Error("This capture fixture is read-only."); },
  onChange: () => () => {}, downloadCopy: async () => {}
 },
 context: {mode:"edit", set: () => {}}, humanEdit: {set: () => {}}
};</script></body></html>`;
const runtime = buildMiniAppRuntimeSrcDoc({
  appId: "nautilo-presentation", html,
  styles: [{ path: "styles.css", content: await Bun.file(join(appRoot, "styles.css")).text() }],
  bundleJs: await built.outputs[0].text(),
});
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response(runtime, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const chrome = process.env["NAUTILO_SLIDES_CHROME_EXECUTABLE"];
  browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, deviceScaleFactor: 2, locale: "en-US" });
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("button", { name: "Show speaker notes" }).waitFor();
  await page.getByRole("button", { name: "Show speaker notes" }).click();
  await page.locator('.ps-notes textarea').blur();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.locator(".ps-canvas").waitFor();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: output });
  console.log(`Captured real Slides editor: ${output}`);
} finally {
  await browser?.close();
  await server.stop(true);
}
