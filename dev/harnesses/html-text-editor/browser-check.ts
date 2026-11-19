import { chromium, type Frame } from "playwright";
import { strict as assert } from "node:assert";
import { fixture } from "./fixture";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:5241");
  await page.getByRole("button", { name: "Reset example", exact: true }).click();
  await page.frameLocator("iframe").locator("#mixed").waitFor();
  const frame = () => page.frames().find(frame => frame !== page.mainFrame()) as Frame;
  const getSource = async () => {
    await page.getByRole("button", { name: "Source", exact: true }).click();
    const source = await page.getByRole("textbox", { name: "HTML source" }).inputValue();
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.frameLocator("iframe").locator("#mixed").waitFor();
    return source;
  };
  assert.equal(await frame().evaluate(() => (window as unknown as { authoredScriptRan?: boolean }).authoredScriptRan), undefined);
  assert.equal(await frame().locator("script").count(), 0);
  assert.equal(await frame().locator('meta[http-equiv="Content-Security-Policy"]').count(), 1);
  assert.equal(await getSource(), fixture, "opening editor leaves source byte-for-byte identical");

  // Click the middle of untouched text, rather than programmatically selecting
  // the end: the first activation must preserve pointer intent.
  const mixed = frame().locator("#mixed");
  await mixed.scrollIntoViewIfNeeded();
  const point = await mixed.evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4); range.setEnd(text, 5);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + 1, y: rect.y + rect.height / 2 };
  });
  const iframeBox = (await page.locator("iframe").boundingBox())!;
  await page.mouse.click(iframeBox.x + point.x, iframeBox.y + point.y);
  await page.keyboard.type("NEW ");

  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Unsaved");
  assert.equal(await mixed.textContent(), "The NEW harbour library welcomed 240 visitors during its first week. Read our community report for the full story.");
  assert.equal(await page.locator('iframe').getAttribute("sandbox"), "allow-same-origin");

  // A single edit must undo even when this region has never had another update.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await mixed.textContent())?.startsWith("The NEW harbour"), false);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal((await mixed.textContent())?.startsWith("The NEW harbour"), true);

  const cell = frame().locator("tbody tr:first-child td:first-child");
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Story workshop");
  const last = frame().locator("#last");
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(" Bring a neighbour.");
  const scrollBefore = await frame().evaluate(() => scrollY);
  assert.ok(scrollBefore > 0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.ok(Math.abs(await frame().evaluate(() => scrollY) - scrollBefore) < 10, "undo must not jump to top");
  await page.getByRole("button", { name: "Redo", exact: true }).click();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  await page.frameLocator("iframe").locator("#mixed").waitFor();
  assert.equal(await frame().locator("tbody tr:first-child td:first-child").textContent(), "Story workshop");
  assert.ok((await frame().locator("#last").textContent())?.endsWith(" Bring a neighbour."), await frame().locator("#last").textContent() ?? "missing");
  const result = await getSource();
  const expected = fixture.replace("The harbour library welcomed", "The NEW harbour library welcomed")
    .replace("<td>Story circle</td>", "<td>Story workshop</td>")
    .replace("more useful.</p></section>", "more useful. Bring a neighbour.</p></section>");
  assert.equal(result, expected, "only intended text changes persist; CSS, tags, links, script and comments remain identical");
  // Empty source-backed paragraphs remain editable after reopening. Pasted
  // line breaks in normal HTML are spaces, consistently before and after save.
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("textbox", { name: "HTML source" }).fill('<!doctype html><html><head lang="en"></head><body><p id="empty"></p><p id="mixed">Other text</p></body></html>');
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const empty = frame().locator("#empty");
  await empty.click();
  await empty.evaluate(element => {
    const data = new DataTransfer();
    data.setData("text/plain", "Two lines\nbecome one paragraph");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  assert.equal(await frame().locator("#empty").textContent(), "Two lines become one paragraph");
  assert.equal(await frame().locator('meta[http-equiv="Content-Security-Policy"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: first-click caret, typing, undo/redo, scroll, multiple regions, save/reopen, exact source diff, scripts disabled");
} finally {
  await browser.close();
}
