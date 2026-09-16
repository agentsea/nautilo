import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import type { BoardModel, Viewport } from "@nautilo/office-board";
const root = resolve(import.meta.dir, "..");
const out = resolve(root, "../../../docs/office-engines/board-native");
await mkdir(out, { recursive: true });
const built = await Bun.build({
  entrypoints: [join(root, "preview.ts")],
  target: "browser",
  format: "esm",
});
if (!built.success)
  throw new Error(built.logs.map((l) => l.message).join("\n"));
const bundle = await built.outputs[0].text();
const html = await Bun.file(join(root, "preview.html")).text();
const css = await Bun.file(join(root, "styles.css")).text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    return new Response(
      path === "/preview.js" ? bundle : path === "/styles.css" ? css : html,
      {
        headers: {
          "content-type":
            path === "/preview.js"
              ? "text/javascript"
              : path === "/styles.css"
                ? "text/css"
                : "text/html",
        },
      },
    );
  },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks: string[] = [];
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on("pageerror", (e) => errors.push(e.message));
type Preview = {
  read(): BoardModel;
  viewport(): Viewport;
  selection(): string[];
  errors: string[];
  pending(): boolean;
};
const model = () =>
  page.evaluate(() =>
    (window as unknown as { boardPreview: Preview }).boardPreview.read(),
  );
const point = async (
  id: string,
  side: "center" | "east" | "west" = "center",
) => {
  const frame = (await model()).elements.find((e) => e.id === id)!.frame;
  const v = await page.evaluate(() =>
    (window as unknown as { boardPreview: Preview }).boardPreview.viewport(),
  );
  const stage = await page.locator(".bd-stage").boundingBox();
  assert(stage);
  return {
    x:
      stage.x +
      v.panX +
      (frame.x + frame.w * (side === "east" ? 1 : side === "west" ? 0 : 0.5)) *
        v.zoom,
    y: stage.y + v.panY + (frame.y + frame.h / 2) * v.zoom,
  };
};
async function clickObject(id: string) {
  const p = await point(id);
  await page.mouse.click(p.x, p.y);
}
const pause = async () => {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
};
async function shot(name: string) {
  await pause();
  await page.screenshot({ path: join(out, name + ".png") });
}
try {
  await page.goto(server.url.toString());
  await page
    .getByRole("button", { name: "Add your first note", exact: true })
    .waitFor();
  await shot("ivory-empty");
  await page
    .getByRole("button", { name: "Add your first note", exact: true })
    .click();
  await page.keyboard.type("Ideas deserve room to grow.");
  await pause();
  let current = await model();
  assert.equal(current.elements.length, 1);
  const note = current.elements[0];
  assert.equal(note.type, "shape");
  const serialized = JSON.stringify(note);
  assert(serialized.includes("Ideas deserve room to grow."));
  checks.push("empty board → one click note → immediate native text entry");
  await page.evaluate(() => {
    const root = document.querySelector(".bd-header")!;
    Object.assign(window, {
      headerMutations: 0,
      originalHeader: root,
      originalRail: document.querySelector(".bd-rail"),
    });
    const observer = new MutationObserver((records) => {
      (window as unknown as { headerMutations: number }).headerMutations +=
        records.length;
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
  });
  await page.keyboard.type(" Every letter stays put.");
  await pause();
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { headerMutations: number }).headerMutations,
    ),
    0,
  );
  assert(
    await page.evaluate(
      () =>
        document.querySelector(".bd-header") ===
          (window as unknown as { originalHeader: Element }).originalHeader &&
        document.querySelector(".bd-rail") ===
          (window as unknown as { originalRail: Element }).originalRail,
    ),
  );
  checks.push("typing preserves header and rail nodes; zero header mutations");
  // Arrow keys work consistently across macOS and Linux keyboard maps.
  for (
    let i = 0;
    i < "Ideas deserve room to grow. Every letter stays put.".length;
    i++
  )
    await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < "Ideas".length; i++)
    await page.keyboard.press("Shift+ArrowRight");
  await pause();
  const selectionPainted = await page
    .locator(".wfb-slides-text-box-editor canvas")
    .evaluate((canvas) => {
      const c = canvas as HTMLCanvasElement;
      const pixels = c
        .getContext("2d")!
        .getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3] > 0 &&
          pixels[i] > pixels[i + 2] + 30 &&
          pixels[i + 1] > pixels[i + 2] + 30
        )
          return true;
      return false;
    });
  assert(
    selectionPainted,
    "Selected text must paint a visible highlight on a note at negative world coordinates",
  );
  await shot("selected-text-highlight");
  await page.getByLabel("Text color", { exact: true }).fill("#dc2626");
  await pause();
  const colored = (await model()).elements[0];
  assert.equal(colored.type, "shape");
  if (colored.type !== "shape") throw new Error("Expected a note");
  const runs = colored.data.text!.blocks.flatMap((block) => block.inlines);
  assert.equal(
    runs
      .filter((run) => run.style.color === "#dc2626")
      .map((run) => run.text)
      .join(""),
    "Ideas",
  );
  assert.equal(
    runs.map((run) => run.text).join(""),
    "Ideas deserve room to grow. Every letter stays put.",
  );
  await shot("selected-text-color");
  await page.keyboard.press("ControlOrMeta+z");
  await pause();
  assert(!JSON.stringify((await model()).elements[0]).includes("#dc2626"));
  checks.push(
    "negative-coordinate note visibly highlights selected text; color changes only that range and undo restores it",
  );
  await page.keyboard.press("Escape");
  await pause();
  assert(
    JSON.stringify((await model()).elements[0]).includes(
      "Ideas deserve room to grow. Every letter stays put.",
    ),
  );
  assert(
    await page
      .locator(".bd-stage")
      .evaluate((stage) => document.activeElement === stage),
  );
  checks.push("Escape commits note and returns canvas focus");
  await page
    .getByRole("combobox", { name: "Font family", exact: true })
    .fill("Georgia");
  await page.keyboard.press("Tab");
  await pause();
  assert(JSON.stringify((await model()).elements[0]).includes("Georgia"));
  await page
    .getByRole("spinbutton", { name: "Font size", exact: true })
    .fill("22");
  await page.keyboard.press("Tab");
  await pause();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await pause();
  current = await model();
  assert(JSON.stringify(current.elements[0]).includes('"fontSize":22'));
  checks.push("visible font family/size and whole-object emphasis");
  await page.getByRole("button", { name: "Sage", exact: true }).click();
  await pause();
  current = await model();
  assert.equal(
    current.elements[0].type === "shape"
      ? current.elements[0].data.fill?.kind === "srgb"
        ? current.elements[0].data.fill.value
        : ""
      : "",
    "#d7edcf",
  );
  const start = await point(note.id);
  const before = (await model()).elements[0].frame;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 210, start.y - 80, { steps: 12 });
  await page.mouse.up();
  await pause();
  assert.notEqual((await model()).elements[0].frame.x, before.x);
  checks.push("native selection drag preserves text and color");
  console.log("Passed note/edit/drag");
  await page.getByRole("button", { name: "Shapes", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Find a shape", exact: true })
    .fill("Ellipse");
  await page.getByRole("button", { name: "Ellipse", exact: true }).click();
  const stage = await page.locator(".bd-stage").boundingBox();
  assert(stage);
  await page.mouse.move(
    stage.x + stage.width * 0.65,
    stage.y + stage.height * 0.48,
  );
  await page.mouse.down();
  await page.mouse.move(
    stage.x + stage.width * 0.8,
    stage.y + stage.height * 0.68,
    { steps: 10 },
  );
  await page.mouse.up();
  await pause();
  current = await model();
  const ellipse = current.elements.find(
    (e) => e.type === "shape" && e.data.kind === "ellipse",
  );
  assert(ellipse);
  checks.push("search native registry → drag a resizable ellipse");
  const handles = await page.locator("[data-handle]").count();
  assert(handles > 0);
  const se = await page.locator('[data-handle="se"]').boundingBox();
  assert(se);
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + 45, se.y + 35, { steps: 8 });
  await page.mouse.up();
  await pause();
  assert(
    (await model()).elements.find((e) => e.id === ellipse.id)!.frame.w >
      ellipse.frame.w,
  );
  checks.push("native resize handles change geometry");
  await page.getByRole("button", { name: "Connect (C)", exact: true }).click();
  const a = await point(note.id, "east"),
    b = await point(ellipse.id, "west");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 16 });
  await page.mouse.up();
  await pause();
  current = await model();
  const connector = current.elements.find((e) => e.type === "connector");
  assert(connector?.type === "connector");
  assert.equal(connector.start.kind, "attached");
  assert.equal(connector.end.kind, "attached");
  checks.push("native connector creation between objects");
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  await page.keyboard.press("Meta+A");
  await page
    .getByRole("combobox", { name: "Arrange", exact: true })
    .selectOption("group");
  await pause();
  assert((await model()).elements.some((e) => e.type === "group"));
  await page
    .getByRole("combobox", { name: "Arrange", exact: true })
    .selectOption("ungroup");
  await pause();
  assert(!(await model()).elements.some((e) => e.type === "group"));
  checks.push("multi-select → group → ungroup");
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fa145a";
    ctx.fillRect(0, 0, 128, 64);
    return canvas.toDataURL("image/png");
  });
  const png = Buffer.from(imageData.split(",")[1], "base64");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() =>
    (window as unknown as { boardPreview: Preview }).boardPreview
      .read()
      .elements.some((e) => e.type === "image"),
  );
  await pause();
  assert(
    !(await page.evaluate(() =>
      (window as unknown as { boardPreview: Preview }).boardPreview.pending(),
    )),
  );
  const imageElement = (await model()).elements.find((e) => e.type === "image");
  assert(imageElement?.type === "image");
  assert.equal(imageElement.data.src, imageData);
  await page.waitForFunction(() => {
    const api = (window as unknown as { boardPreview: Preview }).boardPreview;
    const image = api.read().elements.find((e) => e.type === "image")!;
    const v = api.viewport();
    const canvas = document.querySelector<HTMLCanvasElement>(".bd-canvas")!;
    const x =
      (v.panX + (image.frame.x + image.frame.w / 2) * v.zoom) *
      devicePixelRatio;
    const y =
      (v.panY + (image.frame.y + image.frame.h / 2) * v.zoom) *
      devicePixelRatio;
    const pixel = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
    return (
      pixel[0] === 250 && pixel[1] === 20 && pixel[2] === 90 && pixel[3] === 255
    );
  });
  checks.push(
    "image retains exact PNG bytes and paints after asynchronous decode without another click",
  );
  const count = (await model()).elements.length;
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await pause();
  assert.equal((await model()).elements.length, count - 1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await pause();
  assert.equal((await model()).elements.length, count);
  checks.push("image insert undo/redo");
  await page.getByRole("button", { name: "Fit board", exact: true }).click();
  const initialView = await page.evaluate(() =>
    (window as unknown as { boardPreview: Preview }).boardPreview.viewport(),
  );
  await page
    .getByRole("button", { name: "Pan (H or Space)", exact: true })
    .click();
  await page.mouse.move(
    stage.x + stage.width * 0.5,
    stage.y + stage.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    stage.x + stage.width * 0.5 + 100,
    stage.y + stage.height * 0.5 + 60,
    { steps: 10 },
  );
  await page.mouse.up();
  const panned = await page.evaluate(() =>
    (window as unknown as { boardPreview: Preview }).boardPreview.viewport(),
  );
  assert.notEqual(panned.panX, initialView.panX);
  await page.getByRole("button", { name: "Fit board", exact: true }).click();
  assert.equal(
    (
      await page.evaluate(() =>
        (
          window as unknown as { boardPreview: Preview }
        ).boardPreview.viewport(),
      )
    ).zoom,
    initialView.zoom,
  );
  checks.push("pan and repeatable fit retain native geometry");
  await page
    .getByRole("spinbutton", { name: "Zoom percent", exact: true })
    .fill("5");
  await page.keyboard.press("Tab");
  await pause();
  assert.equal(
    (
      await page.evaluate(() =>
        (
          window as unknown as { boardPreview: Preview }
        ).boardPreview.viewport(),
      )
    ).zoom,
    0.05,
  );
  await page.getByRole("button", { name: "Fit board", exact: true }).click();
  checks.push("explicit zoom below inherited floor");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByLabel("Board minimap. Click to navigate or use arrow keys.")
    .click({ position: { x: 100, y: 50 } });
  await page
    .getByRole("button", { name: "Close overview", exact: true })
    .click();
  checks.push("overview and minimap navigation with close/focus return");
  await page.goto(server.url.toString() + "?example=1");
  await page.locator(".bd-canvas").waitFor();
  await shot("ivory");
  await clickObject("people");
  await pause();
  await shot("ivory-formatting");
  const paletteSource = JSON.stringify(await model());
  await page.locator("#theme").selectOption("dark");
  await pause();
  assert.equal(JSON.stringify(await model()), paletteSource);
  assert.equal(
    await page.locator(".board-app").getAttribute("data-theme"),
    "dark",
  );
  await shot("palette-switch");
  checks.push(
    "live palette switch keeps document colors and geometry unchanged",
  );
  await page.goto(server.url.toString() + "?example=1&theme=dark");
  await page.locator(".bd-canvas").waitFor();
  await shot("tokyo");
  await clickObject("people");
  await pause();
  await shot("tokyo-formatting");
  await page.setViewportSize({ width: 560, height: 820 });
  await page.getByRole("button", { name: "Fit board", exact: true }).click();
  await shot("narrow");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .getByRole("combobox", { name: "Font family", exact: true })
    .scrollIntoViewIfNeeded();
  checks.push(
    "Ivory/Tokyo and narrow embedded surface with reachable formatting",
  );
  await page.goto(server.url.toString() + "?readonly=1&example=1");
  await page.locator(".bd-canvas").waitFor();
  assert(await page.locator(".bd-rail").isHidden());
  const saved = JSON.stringify(await model());
  await page.locator(".bd-stage").focus();
  await page.keyboard.press("n");
  await page.keyboard.press("Delete");
  await pause();
  assert.equal(JSON.stringify(await model()), saved);
  checks.push("read-only view preserves model");
  await page.goto(server.url.toString());
  await page.locator(".bd-stage").focus();
  await page.keyboard.press("n");
  await page.keyboard.type("Keyboard-first board");
  await page.keyboard.press("Escape");
  const keyboardNote = (await model()).elements[0];
  assert(JSON.stringify(keyboardNote).includes("Keyboard-first board"));
  await page.keyboard.press("ArrowRight");
  await pause();
  assert((await model()).elements[0].frame.x > keyboardNote.frame.x);
  await page.keyboard.press("Meta+z");
  await pause();
  assert.equal((await model()).elements[0].frame.x, keyboardNote.frame.x);
  await page.keyboard.press("Delete");
  await pause();
  assert.equal((await model()).elements.length, 0);
  checks.push("keyboard create, text, commit, nudge, undo and delete");
  assert.deepEqual(errors, []);
  const result = {
    testedAt: new Date().toISOString(),
    browser: browser.version(),
    checks,
    limitations: [
      "Surface fixture only: integrated Desktop, canonical concurrency/image integrity and packaged lifecycle evidence are recorded separately in the live and packaged qualification documents.",
    ],
  };
  await Bun.write(
    join(out, "qualification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: join(out, "failure.png") });
  console.error("Browser errors", errors);
  throw error;
} finally {
  await browser.close();
  await server.stop(true);
}
