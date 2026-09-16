#!/usr/bin/env bun
/** Hermetic browser qualification for the real Presentation mini-app.
 * The in-page bridge is a test-only strict-CAS fixture; no account or database is used.
 */
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from "../src/slide-document";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/presentation");
const initialDocument = createSlideDocument();
const titleElement = initialDocument.slides[0]?.elements.find((item) => item.type === "text");
requireCondition(titleElement, "The qualification fixture has no editable title element.");
const initial = serializeSlideHtml(initialDocument);
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const tinyPngSource = `data:image/png;base64,${tinyPngBase64}`;
const built = await Bun.build({
  entrypoints: [join(appRoot, "main.ts")],
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "none",
  splitting: false,
});
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join("\n"));
const bundle = await built.outputs[0].text();
const styles = await Bun.file(join(appRoot, "styles.css")).text();
const fixtureScript = `<script>
const initial = ${JSON.stringify(initial).replaceAll("<", "\\u003c")};
let revision = Number(localStorage.getItem("slides-fixture-revision") || "1");
let content = localStorage.getItem("slides-fixture-content") || initial;
let sha = "fixture-" + revision;
window.__slidesFixture = { get content(){ return content; }, get revision(){ return revision; }, writes: [] };
window.nautiloApp = {
 document: {
  read: async () => ({content, baseRevision: revision, baseSha256: sha, path: "Browser qualification.presentation.html"}),
  write: async (next, base) => {
   if (base.conflictPolicy !== "strict" || base.baseRevision !== revision || base.baseSha256 !== sha) return {kind:"conflict", currentSha256:sha};
   content = next; revision += 1; sha = "fixture-" + revision;
   localStorage.setItem("slides-fixture-content", content); localStorage.setItem("slides-fixture-revision", String(revision));
   window.__slidesFixture.writes.push(content);
   return {kind:"saved", revision, sha256:sha, persistedContent:content, path:"Browser qualification.presentation.html"};
  },
  onChange: () => () => {}, downloadCopy: async () => {}
 }, context: {mode: new URL(location.href).searchParams.has("preview") ? "preview" : "edit", set: () => {}}, humanEdit: {set: () => {}}
};
</script>`;
const appHtml = `<!doctype html><html data-theme="light"><head></head><body><div id="app"></div>${fixtureScript}</body></html>`;
const runtime = buildMiniAppRuntimeSrcDoc({
  appId: "nautilo-presentation-qualification",
  html: appHtml,
  styles: [{ path: "styles.css", content: styles }],
  bundleJs: bundle,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(runtime, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const chrome = process.env["NAUTILO_SLIDES_CHROME_EXECUTABLE"]
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    // Preserve the native method and explicitly supply each canvas context below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const paintText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text.startsWith("Click to add ")) this.canvas.dataset.placeholderHintPainted = "true";
      if (maxWidth === undefined) paintText.call(this, text, x, y);
      else paintText.call(this, text, x, y, maxWidth);
    };
  });
  page.on("console", (message) => console.log(`browser:${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => console.log(`browser:pageerror: ${error.message}`));
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("button", { name: "Add slide" }).waitFor();
  requireCondition(await page.getByLabel("Font family").isVisible(), "Font controls are hidden before text editing starts.");
  requireCondition(await page.getByLabel("Font size").isVisible(), "Font size is hidden before text editing starts.");
  requireCondition(await page.getByLabel("Font family").isDisabled(), "Font controls should wait for an active text selection.");
  await page.waitForFunction(() => document.querySelector('.ps-canvas[data-placeholder-hint-painted="true"]'));
  const qualifyMenus = async (viewport: string): Promise<void> => {
    for (const name of ["Slide", "Insert"] as const) {
      const trigger = page.getByLabel(`${name} menu`);
      await trigger.click();
      const menuGeometry = await trigger.locator("xpath=..").evaluate((details) => {
        const app = document.querySelector(".presentation-app")?.getBoundingClientRect();
        const toolbar = document.querySelector(".ps-toolbar");
        const panel = details.querySelector<HTMLElement>(".ps-menu__panel");
        const rect = panel?.getBoundingClientRect();
        const labels = panel ? [...panel.querySelectorAll<HTMLElement>("button .ps-button__label")].map((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          const rect = range.getBoundingClientRect();
          return {
            text: label.textContent?.trim() ?? "",
            display: getComputedStyle(label).display,
            visibility: getComputedStyle(label).visibility,
            width: rect.width,
            height: rect.height,
          };
        }) : [];
        return {
          app: app && { left: app.left, top: app.top, right: app.right, bottom: app.bottom },
          panel: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          toolbarOverflowX: toolbar && getComputedStyle(toolbar).overflowX,
          toolbarOverflowY: toolbar && getComputedStyle(toolbar).overflowY,
          labels,
        };
      });
      requireCondition(menuGeometry.app && menuGeometry.panel, `${name} menu did not produce measurable geometry at ${viewport}.`);
      requireCondition(
        menuGeometry.toolbarOverflowX === "visible" && menuGeometry.toolbarOverflowY === "visible",
        `The toolbar clips ${name} menu overflow at ${viewport}.`,
      );
      requireCondition(
        menuGeometry.panel.left >= menuGeometry.app.left
          && menuGeometry.panel.top >= menuGeometry.app.top
          && menuGeometry.panel.right <= menuGeometry.app.right
          && menuGeometry.panel.bottom <= menuGeometry.app.bottom,
        `${name} menu extends outside the visible Slides app at ${viewport}.`,
      );
      requireCondition(
        menuGeometry.labels.length > 0 && menuGeometry.labels.every((item) =>
          item.text.length > 0 && item.display !== "none" && item.visibility === "visible" && item.width > 0 && item.height > 0),
        `${name} menu contains a blank or clipped text action at ${viewport}.`,
      );
      await page.screenshot({ path: `/tmp/stack416-native-${viewport}-${name.toLowerCase()}-menu.png`, fullPage: true });
      await trigger.click();
    }
  };
  const layout = await page.evaluate(() => Object.fromEntries(
    [".presentation-content", ".presentation-stage", ".ps-body", ".ps-stage", ".ps-canvas"].map((selector) => {
      const node = document.querySelector(selector);
      const rect = node?.getBoundingClientRect();
      return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null];
    }),
  ));
  console.log("layout", JSON.stringify(layout));
  const thumbnailGeometry = await page.evaluate(() => {
    const content = document.querySelector(".ps-rail__content")?.getBoundingClientRect();
    const thumbnail = document.querySelector(".wfb-slides-thumb")?.getBoundingClientRect();
    return {
      content: content && { left: content.left, right: content.right },
      thumbnail: thumbnail && { left: thumbnail.left, right: thumbnail.right },
    };
  });
  requireCondition(thumbnailGeometry.content && thumbnailGeometry.thumbnail, "The slide rail did not render a measurable thumbnail.");
  requireCondition(
    thumbnailGeometry.thumbnail.left >= thumbnailGeometry.content.left
      && thumbnailGeometry.thumbnail.right <= thumbnailGeometry.content.right,
    "The slide thumbnail runs outside the padded rail content box.",
  );
  const documentTitlePresentation = await page.locator(".presentation-document-title").evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { position: style.position, clip: style.clip, width: rect.width, height: rect.height };
  });
  requireCondition(
    documentTitlePresentation.position === "absolute"
      && documentTitlePresentation.width <= 1
      && documentTitlePresentation.height <= 1
      && documentTitlePresentation.clip !== "auto",
    "The host-owned filename is duplicated visibly inside Slides.",
  );
  requireCondition(await page.getByRole("button", { name: "Show speaker notes" }).getAttribute("aria-expanded") === "false", "Speaker notes did not start collapsed.");
  await qualifyMenus("normal");
  await page.screenshot({ path: "/tmp/stack416-native-light.png", fullPage: true });

  const canvas = page.locator(".ps-canvas");
  const box = await canvas.boundingBox();
  requireCondition(box, "The real Slides canvas did not render.");
  const x = box.x + ((titleElement.frame.x + titleElement.frame.w / 2) / 1920) * box.width;
  const slideHeight = initialDocument.meta.slideHeight ?? 1080;
  const y = box.y + ((titleElement.frame.y + titleElement.frame.h / 2) / slideHeight) * box.height;
  await page.mouse.dblclick(x, y);
  await page.getByLabel("Font family").waitFor({ state: "visible" });
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Qualified native slides");
  await page.keyboard.press("Meta+A");
  await page.getByLabel("Font family").fill("Georgia");
  await page.getByLabel("Font family").press("Enter");
  await page.getByLabel("Font size").fill("31.5");
  await page.getByLabel("Font size").press("Enter");
  await page.getByRole("button", { name: "Underline" }).click();
  requireCondition(await page.getByLabel("Font family").isVisible(), "Text editing ended when a contextual control was used.");
  await page.setViewportSize({ width: 620, height: 720 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const narrowTextCanvas = await canvas.boundingBox();
  requireCondition(narrowTextCanvas, "The Slides canvas disappeared before narrow text-control qualification.");
  await page.mouse.dblclick(
    narrowTextCanvas.x + ((titleElement.frame.x + titleElement.frame.w / 2) / 1920) * narrowTextCanvas.width,
    narrowTextCanvas.y + ((titleElement.frame.y + titleElement.frame.h / 2) / slideHeight) * narrowTextCanvas.height,
  );
  await page.getByLabel("Font family").waitFor({ state: "visible" });
  for (const name of ["Bold", "Italic", "Underline"]) {
    const control = page.locator(`button[aria-label="${name}"]`);
    const geometry = await control.evaluate((button) => {
      const node = button.querySelector<HTMLElement>(".ps-button__label");
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRect = range.getBoundingClientRect();
      const controlRect = button.getBoundingClientRect();
      return { text: node.textContent, display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility, textWidth: textRect.width, textHeight: textRect.height, controlWidth: controlRect.width, controlHeight: controlRect.height };
    });
    requireCondition(
      geometry && geometry.display !== "none" && geometry.visibility === "visible"
        && geometry.textWidth > 0 && geometry.textHeight > 0 && geometry.controlWidth > 0 && geometry.controlHeight > 0,
      `${name} lost its visible text label at narrow width: ${JSON.stringify(geometry)}.`,
    );
  }
  await page.screenshot({ path: "/tmp/stack416-native-narrow-context.png", fullPage: true });
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.screenshot({ path: "/tmp/stack416-native-text-edit.png", fullPage: true });

  await page.getByRole("button", { name: "Show speaker notes" }).click();
  const notes = page.getByPlaceholder("Speaker notes…");
  await notes.waitFor({ state: "visible" });
  await notes.fill("Presenter-only note survives save and reopen.");
  await page.getByRole("button", { name: "Hide speaker notes" }).click();
  requireCondition(await notes.isHidden(), "Speaker notes did not collapse after editing.");
  await page.getByRole("button", { name: "Add slide" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Add slide" }).click();

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "one-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(tinyPngBase64, "base64"),
  });
  await page.waitForFunction((source) => {
    const fixture = (window as unknown as { __slidesFixture?: { content: string } }).__slidesFixture;
    return document.querySelector(".ps-canvas") !== null && fixture !== undefined && source.length > 0;
  }, tinyPngSource);

  await page.getByLabel("Insert menu").click();
  await page.getByRole("button", { name: "Rectangle" }).click();
  const insertionCanvas = await canvas.boundingBox();
  requireCondition(insertionCanvas, "The Slides canvas disappeared before shape insertion.");
  await page.mouse.move(insertionCanvas.x + insertionCanvas.width * 0.58, insertionCanvas.y + insertionCanvas.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(insertionCanvas.x + insertionCanvas.width * 0.72, insertionCanvas.y + insertionCanvas.height * 0.72);
  await page.mouse.up();

  await page.getByRole("button", { name: "Present" }).click();
  await page.locator(".ps-presenter canvas").waitFor();
  await page.getByRole("button", { name: "Exit presentation", exact: true }).waitFor({ state: "visible" });
  requireCondition(await page.locator('.ps-presenter canvas[data-placeholder-hint-painted="true"]').count() === 0, "Presentation paints authoring placeholders.");
  await page.screenshot({ path: "/tmp/stack416-presenter-exit.png", fullPage: true });
  await page.getByRole("button", { name: "Exit presentation", exact: true }).click();
  await page.locator(".ps-presenter").waitFor({ state: "detached" });
  requireCondition(await page.getByRole("button", { name: "Present from current slide", exact: true }).evaluate((node) => node === document.activeElement), "Exit did not return focus to Present.");
  await page.getByRole("button", { name: "Present" }).click();
  await page.locator(".ps-presenter canvas").waitFor();
  await page.keyboard.press("Tab");
  requireCondition(await page.getByRole("button", { name: "Exit presentation", exact: true }).evaluate((node) => node === document.activeElement), "Presenter swallowed keyboard access to Exit.");
  await page.keyboard.press("Enter");
  await page.locator(".ps-presenter").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Present" }).click();
  await page.locator(".ps-presenter canvas").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".ps-presenter").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page.getByRole("status").filter({ hasText: "Saved" }).first().waitFor();
  } catch (error) {
    await page.screenshot({ path: "/tmp/stack416-native-failure.png", fullPage: true });
    const diagnostics = await page.evaluate(() => ({
      saveState: document.querySelector(".presentation-app")?.getAttribute("data-save-state"),
      statuses: [...document.querySelectorAll('[role="status"]')].map((node) => ({ text: node.textContent, hidden: (node as HTMLElement).hidden })),
    }));
    console.error("save diagnostics", JSON.stringify(diagnostics));
    throw error;
  }
  const saved = await page.evaluate(() => (window as unknown as { __slidesFixture: { content: string; writes: string[] } }).__slidesFixture);
  requireCondition(saved.writes.length > 0, "The strict-CAS bridge received no write.");
  requireCondition(saved.content === saved.writes.at(-1), "Saved bytes differ from the strict-CAS persisted bytes.");
  requireCondition(saved.content.includes("Qualified native slides"), "Saved bytes lost edited text.");
  requireCondition(saved.content.includes("Georgia"), "Font-family control did not persist its real engine action.");
  requireCondition(saved.content.includes("31.5"), "Positive fractional font-size control did not persist its real engine action.");
  requireCondition(saved.content.includes('"underline":true'), "Underline control did not persist its real engine action.");
  requireCondition(saved.content.includes("Presenter-only note survives save and reopen."), "Saved bytes lost speaker notes.");
  const savedDocument = parseSlideHtml(saved.content);
  const savedImage = savedDocument.slides.flatMap((slide) => slide.elements).find((element) => element.type === "image");
  requireCondition(savedImage?.data.src === tinyPngSource, "PNG insertion did not preserve the exact self-contained source.");
  requireCondition(savedImage.frame.w > 0 && savedImage.frame.h > 0, "PNG insertion produced a non-positive frame.");
  const savedRectangle = savedDocument.slides.flatMap((slide) => slide.elements).find(
    (element) => element.type === "shape" && element.data.kind === "rect",
  );
  requireCondition(savedRectangle, "Rectangle insertion did not persist a real shape element.");
  requireCondition(savedRectangle.frame.w > 0 && savedRectangle.frame.h > 0, "Rectangle insertion produced a non-positive frame.");

  await page.reload();
  await page.getByRole("button", { name: "Add slide" }).waitFor();
  const reopened = await page.evaluate(() => (window as unknown as { __slidesFixture: { content: string } }).__slidesFixture.content);
  requireCondition(reopened === saved.content, "Page reopen did not read the exact persisted bytes.");
  const reopenedDocument = parseSlideHtml(reopened);
  const reopenedImage = reopenedDocument.slides.flatMap((slide) => slide.elements).find((element) => element.id === savedImage.id);
  requireCondition(reopenedImage?.type === "image" && reopenedImage.data.src === tinyPngSource, "Reopen lost the inserted PNG source.");
  requireCondition(reopenedImage.frame.w > 0 && reopenedImage.frame.h > 0, "Reopen lost the PNG frame.");
  requireCondition(
    reopenedDocument.slides.flatMap((slide) => slide.elements).some((element) => element.id === savedRectangle.id),
    "Reopen lost the inserted rectangle.",
  );

  await page.setViewportSize({ width: 620, height: 720 });
  await qualifyMenus("narrow");
  const toolbarRows = await page.evaluate(() => {
    const zoom = document.querySelector('[aria-label="Zoom"]')!.getBoundingClientRect();
    const present = document.querySelector('[aria-label="Present from current slide"]')!.getBoundingClientRect();
    const fonts = document.querySelector('[aria-label="Font family"]')!.getBoundingClientRect();
    return { gap: present.left - zoom.right, tops: Math.abs(present.top - zoom.top), formattingGap: fonts.top - present.bottom };
  });
  requireCondition(toolbarRows.gap >= 8 && toolbarRows.tops < 1 && toolbarRows.formattingGap > 0, "Embedded toolbar lost its separate action/format rows or Fit/Present spacing.");
  await page.screenshot({ path: "/tmp/stack416-native-narrow-light.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: "/tmp/stack416-native-narrow-dark.png", fullPage: true });
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.screenshot({ path: "/tmp/stack416-native-dark.png", fullPage: true });

  const persisted = () => page.evaluate(() => (window as unknown as {
    __slidesFixture: { content: string; revision: number };
  }).__slidesFixture);
  const saveDesign = async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('[data-save-state="saved"]').waitFor();
    return (await persisted()).content;
  };
  const beforeDesign = await persisted();
  await page.getByRole("button", { name: "Design", exact: true }).click();
  const panel = page.locator(".ps-design-host");
  await panel.waitFor({ state: "visible" });
  requireCondition(await panel.locator("[data-theme-id]").count() === 23, "Existing deck cannot browse all 23 themes.");
  requireCondition(await page.getByRole("tab", { name: "Themes", exact: true }).evaluate((node) => node === document.activeElement), "Opening Design did not focus its current tab.");
  await page.keyboard.press("ArrowRight");
  requireCondition(await page.getByRole("tab", { name: "Layouts", exact: true }).getAttribute("aria-selected") === "true", "Arrow key did not switch Design tabs.");
  requireCondition(await panel.locator("[data-layout-id]").count() === 11, "Design did not list all 11 document layouts.");
  const layoutPainted = await panel.locator('[data-layout-id="title-body"] canvas').evaluate((canvas) => {
    const node = canvas as HTMLCanvasElement;
    const pixels = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0)
      && pixels.some((value, index) => index % 4 !== 3 && value !== pixels[index % 4]);
  });
  requireCondition(layoutPainted, "Layout preview has no rendered content.");
  requireCondition(JSON.stringify(await persisted()) === JSON.stringify(beforeDesign), "Browsing Design wrote to the document.");
  await page.screenshot({ path: "/tmp/stack416-design-layouts-dark.png", fullPage: true });
  await page.getByRole("tab", { name: "Themes", exact: true }).click();
  await page.screenshot({ path: "/tmp/stack416-design-themes-dark.png", fullPage: true });
  await page.getByRole("button", { name: "Apply Luxe theme", exact: true }).click();
  requireCondition(await panel.locator('[data-theme-id="luxe"]').evaluate((node) => node === document.activeElement), "Theme selection lost keyboard focus.");
  const themeSaved = await saveDesign();
  const themed = parseSlideHtml(themeSaved);
  requireCondition(themed.meta.themeId === "luxe" && themed.themes.length === 2, "Selected theme was not persisted exactly once.");
  requireCondition(JSON.stringify(themed.slides) === JSON.stringify(reopenedDocument.slides), "Theme choice changed existing text, fonts, images or notes.");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  requireCondition(await saveDesign() === beforeDesign.content, "Theme Undo did not restore exact original document bytes.");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  requireCondition(await saveDesign() === themeSaved, "Theme Redo did not restore the chosen definition.");
  await page.getByRole("tab", { name: "Layouts", exact: true }).click();
  await panel.locator('[data-layout-id="title-two-columns"]').click();
  const layoutSaved = await saveDesign();
  requireCondition(parseSlideHtml(layoutSaved).slides[0].layoutId === "title-two-columns", "Layout choice was not applied to selected slide.");
  requireCondition(layoutSaved.includes("Qualified native slides") && layoutSaved.includes("Presenter-only note survives save and reopen."), "Layout choice lost existing content or notes.");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  requireCondition(await saveDesign() === themeSaved, "Layout Undo did not restore prior content and geometry.");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  requireCondition(await saveDesign() === layoutSaved, "Layout Redo did not restore chosen layout.");
  await page.reload();
  await page.getByRole("button", { name: "Design", exact: true }).click();
  requireCondition(await panel.locator('[data-theme-id="luxe"]').getAttribute("aria-pressed") === "true", "Reopen lost selected theme indication.");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: "/tmp/stack416-design-themes-light.png", fullPage: true });
  await page.getByRole("tab", { name: "Layouts", exact: true }).click();
  requireCondition(await panel.locator('[data-layout-id="title-two-columns"]').getAttribute("aria-pressed") === "true", "Reopen lost selected layout indication.");
  await page.screenshot({ path: "/tmp/stack416-design-layouts-light.png", fullPage: true });
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 620, height: 720 });
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const geometry = await panel.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
    });
    requireCondition(geometry.left >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height, "Embedded Design panel is clipped.");
    await panel.locator("[data-layout-id]").last().scrollIntoViewIfNeeded();
    requireCondition(await page.getByRole("button", { name: "Close Design", exact: true }).isVisible(), "Panel scrolling hid the Close control.");
    await page.screenshot({ path: `/tmp/stack416-design-narrow-${theme}.png`, fullPage: true });
  }
  await page.getByRole("tab", { name: "Layouts", exact: true }).focus();
  await page.keyboard.press("Escape");
  requireCondition(await panel.isHidden(), "Escape did not dismiss Design.");
  requireCondition(await page.getByRole("button", { name: "Design", exact: true }).evaluate((node) => node === document.activeElement), "Closing Design did not return focus.");
  const beforePreview = await persisted();
  await page.goto(`http://${server.hostname}:${server.port}/?preview=1`);
  await page.getByRole("button", { name: "Present from current slide", exact: true }).waitFor();
  await page.locator(".ps-canvas").waitFor();
  requireCondition(await page.locator('canvas[data-placeholder-hint-painted="true"]').count() === 0, "Preview paints authoring placeholders.");
  requireCondition(await page.getByRole("button", { name: "Design", exact: true }).count() === 0, "Read-only Preview exposes Design authoring.");
  await page.getByRole("button", { name: "Present from current slide", exact: true }).click();
  await page.getByRole("button", { name: "Exit presentation", exact: true }).click();
  await page.locator(".ps-presenter").waitFor({ state: "detached" });
  requireCondition((await persisted()).content === beforePreview.content, "Preview changed the designed presentation.");
  // An existing imported deck may own same-ID theme definitions and a different
  // aspect ratio. Test the actual panel against that document, not a new template.
  const imported = parseSlideHtml(beforePreview.content);
  const importedTheme = imported.themes.find((theme) => theme.id === "luxe")!;
  importedTheme.name = "Imported gold";
  importedTheme.colors.accent1 = "#8A641C";
  const brand = structuredClone(importedTheme);
  brand.id = "company-brand";
  brand.name = "Company brand";
  imported.themes.push(brand);
  imported.meta.slideHeight = 1440;
  const importedLayout = structuredClone(imported.layouts.find((layout) => layout.id === "title-body")!);
  importedLayout.id = "imported-4-3";
  importedLayout.name = "Imported 4:3 layout";
  imported.layouts.push(importedLayout);
  await page.evaluate((content) => localStorage.setItem("slides-fixture-content", content), serializeSlideHtml(imported));
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.getByRole("button", { name: "Design", exact: true }).click();
  requireCondition(await panel.locator("[data-theme-id]").count() === 24, "Custom theme is missing from the gallery.");
  requireCondition(await page.getByRole("button", { name: "Apply Imported gold theme", exact: true }).getAttribute("aria-pressed") === "true", "Built-in theme replaced the imported same-ID definition.");
  await page.getByRole("button", { name: "Apply Company brand theme", exact: true }).click();
  await page.getByRole("tab", { name: "Layouts", exact: true }).click();
  requireCondition(await panel.locator("[data-layout-id]").count() === 12, "Imported layout is missing from the gallery.");
  const importedPreview = await panel.locator('[data-layout-id="imported-4-3"] canvas').boundingBox();
  requireCondition(importedPreview && Math.abs(importedPreview.width / importedPreview.height - 4 / 3) < 0.02, "Imported layout preview has the wrong aspect ratio.");
  await panel.locator('[data-layout-id="imported-4-3"]').click();
  const importedSaved = parseSlideHtml(await saveDesign());
  requireCondition(importedSaved.meta.themeId === brand.id && importedSaved.slides[0].layoutId === importedLayout.id, "Imported choices failed to apply.");
  requireCondition(JSON.stringify(importedSaved.themes) === JSON.stringify(imported.themes), "Applying a custom theme changed existing definitions.");
  requireCondition(JSON.stringify(importedSaved.layouts) === JSON.stringify(imported.layouts), "Applying an imported layout changed template definitions.");
  await page.screenshot({ path: "/tmp/stack416-design-imported.png", fullPage: true });
  console.log("design-panel: 23 themes, 11 rendered layouts, no browse writes, undo/redo, exact reopen, keyboard, embedded palettes and read-only Preview passed");
  console.log(JSON.stringify({
    ok: true,
    revision: saved.writes.length,
    screenshots: [
      "/tmp/stack416-native-light.png",
      "/tmp/stack416-native-text-edit.png",
      "/tmp/stack416-native-narrow-context.png",
      "/tmp/stack416-native-narrow-light.png",
      "/tmp/stack416-native-narrow-dark.png",
      "/tmp/stack416-native-dark.png",
      "/tmp/stack416-native-normal-slide-menu.png",
      "/tmp/stack416-native-normal-insert-menu.png",
      "/tmp/stack416-native-narrow-slide-menu.png",
      "/tmp/stack416-native-narrow-insert-menu.png",
    ],
  }));
} finally {
  await browser?.close();
  await server.stop(true);
}
