import { chromium } from "playwright";
import { strict as assert } from "node:assert";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors: string[] = [];
let stage = "re-entry";
page.on("pageerror", error => errors.push(error.message));
const frame = page.frameLocator('iframe[title="Edit HTML text"]');
const source = () => page.getByTestId("canonical-source").textContent();
const button = (name: string) => page.getByRole("button", { name, exact: true });
const waitSource = async (html: string) => {
  try { await page.waitForFunction(html => document.querySelector('[data-testid="canonical-source"]')?.textContent === html, html); }
  catch (error) { console.error({ stage, expected: html, actual: await source(), errors, alerts: await page.getByRole('alert').allTextContents() }); throw error; }
};
const ready = (id: string) => frame.locator(`#${id}[tabindex="0"]`);
async function load(html: string) {
  const previous = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  if (await button("Source").isVisible()) await button("Source").click();
  const code = page.locator('.cm-content[contenteditable="true"]');
  await code.click(); await code.press("ControlOrMeta+A"); await page.keyboard.insertText(html);
  await button("Text").click(); await waitSource(html);
  if (previous) await page.waitForFunction(element => !element.isConnected, previous);
}
async function reopen() {
  const previous = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  await button("Save").click(); await button("Reopen saved").click();
  await page.waitForFunction(element => !element.isConnected, previous);
}
async function clear(id: string) {
  const element = ready(id); await element.click(); await element.press("ControlOrMeta+A"); await page.keyboard.press("Backspace");
  assert.equal(await element.textContent(), "");
}
async function caret(id: string, offset: number) {
  const selection = await ready(id).evaluate(element => {
    const selected = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
    const inside = !!selected?.focusNode && element.contains(selected.focusNode);
    if (inside) range.setEnd(selected.focusNode, selected.focusOffset);
    return { inside, collapsed: selected?.isCollapsed, offset: range.toString().length };
  });
  assert.deepEqual(selection, { inside: true, collapsed: true, offset });
}
const fixture = '<!doctype html><style>p{margin:24px 0;min-height:28px}</style><!--keep--><p id="before">Before</p><p id="plain">Plain text</p><p id="mixed"><b>Bold</b> and <a href="/keep">linked</a></p><p id="after">After</p><table><tr><td id="cell">Cell</td></tr></table><script>original()</script>';
try {
  await page.goto("http://127.0.0.1:5241"); await load(fixture);
  // Regression: an empty plain paragraph can have focus but no DOM selection.
  await clear("plain"); await ready("after").click(); await ready("plain").click(); await caret("plain", 0);
  await page.keyboard.type("Retyped"); await waitSource(fixture.replace('>Plain text<', '>Retyped<'));
  await clear("plain");
  const empty = fixture.replace('>Plain text<', '><'); await waitSource(empty);
  await reopen();
  await ready("plain").click(); await caret("plain", 0); await page.keyboard.type("Reopened");
  await waitSource(empty.replace('<p id="plain"></p>', '<p id="plain">Reopened</p>'));
  await clear("plain"); await ready("before").click(); await page.keyboard.press("Tab"); await caret("plain", 0);
  await page.keyboard.type("Tabbed"); await waitSource(empty.replace('<p id="plain"></p>', '<p id="plain">Tabbed</p>'));

  await load(fixture); await clear("mixed"); await ready("after").click(); await ready("mixed").click();
  await page.keyboard.type("New"); assert.equal(await ready("mixed").textContent(), "New");
  assert.equal(await ready("mixed").locator('b').count(), 1, "retyping retains the original bold wrapper");
  assert.equal(await ready("mixed").locator('a[href="/keep"]').count(), 1, "retyping retains the original link wrapper");

  // A deliberate delete removes the block, not just its text. Undo retains selection.
  stage = "toolbar deletion";
  await load(fixture); await ready("plain").click();
  await ready("plain").press("ControlOrMeta+A");
  await button("Delete paragraph").click();
  const deleted = fixture.replace('<p id="plain">Plain text</p>', ''); await waitSource(deleted);
  assert.equal(await frame.locator('#plain').count(), 0); await caret("mixed", 0);
  await button("Undo").click(); await waitSource(fixture);
  assert.equal(await ready("plain").evaluate(e => e.ownerDocument.getSelection()?.toString()), "Plain text");
  await button("Redo").click(); await waitSource(deleted); await caret("mixed", 0);
  await reopen(); await ready("after").waitFor();
  assert.equal(await frame.locator('#plain').count(), 0);

  // Clear and remove are separate undo steps. Empty Backspace selects the previous neighbour.
  stage = "empty Backspace";
  await load(fixture); await clear("plain"); await page.keyboard.press("Backspace");
  await waitSource(deleted); await caret("before", "Before".length);
  await button("Undo").click(); await waitSource(empty); await caret("plain", 0);
  await button("Undo").click(); await waitSource(fixture);
  await button("Redo").click(); await waitSource(empty); await caret("plain", 0);
  stage = "empty Delete after redo";
  await page.keyboard.press("Delete"); await waitSource(deleted); await caret("mixed", 0);
  await button("Source").click(); await button("Undo").click(); await waitSource(empty); await caret("plain", 0);

  await ready("cell").click();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Delete paragraph"]')?.disabled === true);
  await clear("cell"); await page.keyboard.press("Backspace"); assert.equal(await frame.locator('#cell').count(), 1);

  // A split paragraph can be removed explicitly; an empty island must not delete its nonempty sibling.
  const split = '<p id="split">First<br>Second</p><p id="after">After</p>';
  await load(split);
  const island = frame.locator('#split > [data-nautilo-html-region]').first();
  await island.click(); await island.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  assert.equal(await frame.locator('#split').count(), 1); assert.equal(await frame.locator('#split').textContent(), 'Second');
  await button("Undo").click(); await waitSource(split);
  await button("Delete paragraph").click(); await waitSource('<p id="after">After</p>');

  const only = '<p id="only">The last paragraph</p><!--preserve-->';
  await load(only); await ready("only").click(); await button("Delete paragraph").click(); await waitSource('<!--preserve-->');
  await page.getByText('No editable text was found. Use Undo to restore deleted text, or Source to add content.', { exact: true }).waitFor();
  await button("Undo").click(); await waitSource(only); await ready("only").waitFor();
  await button("Redo").click(); await waitSource('<!--preserve-->');
  assert.deepEqual(errors, []); assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  console.log('PASS: empty paragraph re-entry, reopen, Tab, inline retyping, exact block deletion, retained undo selection, redo, neighbouring caret, source history, cell and split-region protection, last paragraph deletion');
} finally { await browser.close(); }
