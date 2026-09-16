import console from "node:console";
import process from "node:process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = await mkdtemp(path.join(tmpdir(), "board-browser-"));
let browser;
try {
  await build({
    root,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry: path.join(root, "test/browser-entry.ts"),
        formats: ["iife"],
        name: "BoardQualification",
        fileName: () => "board.js",
      },
    },
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BOARD_TEST_BROWSER_CHANNEL
      ? { channel: process.env.BOARD_TEST_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on(
    "pageerror",
    (error) => (errors.push(error.message), console.error(error.message)),
  );
  await page.route("http://127.0.0.1/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Board qualification</title>",
    }),
  );
  await page.goto("http://127.0.0.1/board-qualification");
  await page.setContent(
    "<!doctype html><title>Board engine qualification</title><body></body>",
  );
  await page.addScriptTag({
    content: await readFile(path.join(outDir, "board.js"), "utf8"),
  });
  await page.waitForFunction(() => globalThis.document.body.dataset.result);
  const result = await page.locator("body").getAttribute("data-result");
  assert.deepEqual(errors, []);
  assert.equal(
    result,
    JSON.stringify({ pixel: [51, 102, 255, 255], text: "A & B", zoom: 20 }),
  );
  console.log(`Browser ${browser.version()}: ${result}`);
} finally {
  await browser?.close();
  await rm(outDir, { recursive: true, force: true });
}
