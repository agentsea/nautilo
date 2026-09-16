#!/usr/bin/env bun
/** Capture the actual Board editor with a fictional, reproducible launch map.
 * The temporary host bridge has no account, instance, or persisted user data.
 */
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { BoardModel } from "@nautilo/office-board";
import { makeDefaultSlidesTextBlock, type Element as BoardElement } from "@nautilo/office-slides/browser";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";
import { serializeBoardHtml } from "../src/board-document";

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/board");
const output = join(repository, "apps/workbench/public/apps/office/board-preview.png");

function blocks(heading: string, body: string, color = "#292524") {
  return [heading, body].map((value, index) => {
    const block = makeDefaultSlidesTextBlock();
    block.style = { ...block.style, alignment: "left", lineHeight: index === 0 ? 1.1 : 1.28, marginTop: 0, marginBottom: index === 0 ? 15 : 0 };
    block.inlines = [{ text: value, style: { fontFamily: "Inter", fontSize: index === 0 ? 20 : 14, bold: index === 0, color } }];
    return block;
  });
}

function note(id: string, x: number, y: number, color: string, heading: string, body: string): BoardElement {
  return {
    id, type: "shape", frame: { x, y, w: 275, h: 180, rotation: 0 },
    data: { kind: "roundRect", fill: { kind: "srgb", value: color }, text: { blocks: blocks(heading, body), verticalAnchor: "middle", autofit: "shrink" } },
  };
}

function label(id: string, value: string, x: number, y: number, w: number, size: number, color: string): BoardElement {
  const block = makeDefaultSlidesTextBlock();
  block.style = { ...block.style, alignment: "left", lineHeight: 1.1, marginTop: 0, marginBottom: 0 };
  block.inlines = [{ text: value, style: { fontFamily: "Inter", fontSize: size, bold: size >= 24, color } }];
  return { id, type: "text", frame: { x, y, w, h: size * 1.5, rotation: 0 }, data: { blocks: [block] } };
}

function arrow(id: string, x1: number, y1: number, x2: number, y2: number): BoardElement {
  return {
    id, type: "connector", frame: { x: 0, y: 0, w: 0, h: 0, rotation: 0 }, routing: "straight",
    start: { kind: "free", x: x1, y: y1 }, end: { kind: "free", x: x2, y: y2 },
    stroke: { color: "#917E67", width: 2.5 }, arrowheads: { end: { kind: "triangle", size: "md" } },
  };
}

const document: BoardModel = {
  meta: { title: "Studio North — Launch map" },
  elements: [
    label("eyebrow", "STUDIO NORTH  /  AUTUMN LAUNCH", 0, -120, 820, 15, "#806F5C"),
    label("title", "Find the signal. Make it travel.", 0, -82, 920, 34, "#292524"),
    label("subtitle", "One shared map for the story, the moments, and the people who make it real.", 0, -27, 860, 16, "#675E56"),
    note("signal", 0, 75, "#FFF0B6", "01  /  THE SIGNAL", "A small invitation that makes people stop and look again."),
    note("story", 345, 75, "#DDF0DB", "02  /  THE STORY", "A clear promise, told in the warmest possible voice."),
    note("moment", 690, 75, "#DCEAFF", "03  /  THE MOMENT", "A launch scene with enough room for wonder."),
    note("people", 172, 335, "#F9DCE7", "THE PEOPLE", "Creators, neighbors, and the team in one moving frame."),
    note("next", 518, 335, "#ECE1FA", "NEXT WEEK", "Tease on Monday. Reveal Thursday. Keep listening after."),
    {
      id: "launch-badge", type: "shape", frame: { x: 899, y: 357, w: 174, h: 132, rotation: 0 },
      data: { kind: "roundRect", fill: { kind: "srgb", value: "#E76543" }, text: { blocks: blocks("GO LIVE", "OCT 16  ·  09:00", "#FFF9F1"), verticalAnchor: "middle", autofit: "shrink" } },
    },
    arrow("signal-story", 275, 165, 345, 165), arrow("story-moment", 620, 165, 690, 165),
    arrow("story-people", 480, 255, 310, 335), arrow("people-next", 447, 425, 518, 425), arrow("next-launch", 793, 425, 899, 425),
  ],
};

const content = serializeBoardHtml(document);
const built = await Bun.build({ entrypoints: [join(appRoot, "main.ts")], target: "browser", format: "esm", minify: true, sourcemap: "none", splitting: false });
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const html = `<!doctype html><html data-theme="light"><body><main id="app"></main><script>
const content = ${JSON.stringify(content).replaceAll("<", "\\u003c")};
window.nautiloApp = {
  document: {
    read: async () => ({ content, baseRevision: 1, baseSha256: "showcase", path: "Studio North — Launch map.board.html" }),
    write: async () => { throw new Error("This capture fixture is read-only."); },
    downloadCopy: async () => {}, onChange: () => () => {},
  }, context: { mode: "edit", set: () => {} }, humanEdit: { set: () => {} },
};</script></body></html>`;
const runtime = buildMiniAppRuntimeSrcDoc({
  appId: "nautilo-board", html,
  styles: [{ path: "styles.css", content: await Bun.file(join(appRoot, "styles.css")).text() }],
  bundleJs: await built.outputs[0].text(),
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(runtime, { headers: { "content-type": "text/html; charset=utf-8" } }) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const chrome = process.env["NAUTILO_BOARD_CHROME_EXECUTABLE"];
  browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, deviceScaleFactor: 2, locale: "en-US" });
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("heading", { name: "Studio North — Launch map.board.html" }).waitFor();
  await page.locator(".bd-stage").waitFor();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.screenshot({ path: output });
  console.log(`Captured real Board editor: ${output}`);
} finally {
  await browser?.close();
  await server.stop(true);
}
