import { chromium, type Frame } from "playwright";
import { strict as assert } from "node:assert";
import { fixture } from "./fixture";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const frame = () => page.frames().find(candidate => candidate !== page.mainFrame()) as Frame;
const source = () => page.getByTestId("canonical-source").textContent();
let stage = "document history";
let sourceCheck = 0;
const waitSource = async (expected: string) => {
  const check = ++sourceCheck;
  try { await page.waitForFunction(expected => document.querySelector('[data-testid="canonical-source"]')?.textContent === expected, expected); }
  catch (error) {
    const actual = await source() ?? "";
    let mismatch = 0; while (mismatch < Math.min(actual.length, expected.length) && actual[mismatch] === expected[mismatch]) mismatch++;
    const details = await frame().evaluate(() => ({ focusedId: document.activeElement?.id, repeatedEditable: document.getElementById("repeated")?.getAttribute("contenteditable"), repeatedTabIndex: document.getElementById("repeated")?.getAttribute("tabindex"), repeated: document.getElementById("repeated")?.textContent, selected: window.getSelection()?.toString() }));
    throw new Error(`${stage} (check ${check}): ${JSON.stringify(details)} canonical source mismatch at ${mismatch}; expected ${JSON.stringify(expected.slice(Math.max(0, mismatch - 70), mismatch + 130))}; actual ${JSON.stringify(actual.slice(Math.max(0, mismatch - 70), mismatch + 130))}`, { cause: error });
  }
};
const undo = () => page.getByRole("button", { name: "Undo", exact: true }).click();
const redo = () => page.getByRole("button", { name: "Redo", exact: true }).click();
const reset = async () => {
  await page.getByRole("button", { name: "Reset example", exact: true }).click();
  await page.frameLocator("iframe").locator("#mixed").waitFor();
  await waitSource(fixture);
};
async function append(selector: string, text: string) {
  const target = frame().locator(selector);
  // Parsed srcdoc text can be visible before the parent onLoad handler installs
  // edit listeners. Wait for its actual ready marker, never a timer.
  await frame().waitForFunction(selector => document.querySelector(selector)?.getAttribute("tabindex") === "0", selector);
  await target.click();
  await frame().waitForFunction(selector => document.querySelector(selector)?.getAttribute("contenteditable") === "true", selector);
  // Use the real keyboard route after activation, avoiding synthetic selection
  // changes racing Lexical's first-focus callback.
  await target.press("ControlOrMeta+A");
  await target.press("ArrowRight");
  // Read browser selection before input; history must capture this caret rather
  // than an older Lexical selection from the initial click.
  await activeSelection(selector, (await target.textContent())!.length);
  await page.keyboard.insertText(text);
}
async function activeSelection(selector: string, expectedOffset?: number) {
  const actual = await frame().evaluate(selector => {
    const element = document.querySelector(selector)!;
    const selection = window.getSelection();
    const focus = selection?.focusNode;
    const range = document.createRange(); range.selectNodeContents(element);
    if (focus && element.contains(focus)) range.setEnd(focus, selection.focusOffset);
    return { focused: document.activeElement === element || element.contains(document.activeElement),
      selectionInside: !!focus && (element === focus || element.contains(focus)),
      collapsed: selection?.isCollapsed, offset: range.toString().length };
  }, selector);
  assert.equal(actual.focused, true, `undo/redo must focus ${selector}`);
  assert.equal(actual.selectionInside, true, `undo/redo must restore selection inside ${selector}`);
  if (expectedOffset !== undefined) {
    assert.equal(actual.collapsed, true, "the saved caret must remain collapsed");
    assert.equal(actual.offset, expectedOffset, "the saved caret must return to its exact text offset");
  }
}
async function styleSnapshot() {
  return await frame().evaluate(() => {
    const result: Record<string, Record<string, string>> = {};
    const authoredSelectors: Record<string, string> = { signal: ".outer", shelter: ".outer .inner", "reading guide": "a.guide" };
    for (const word of ["signal", "shelter", "reading guide"]) {
      const root = document.getElementById("fidelity")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let found: Text | null = null;
      while (walker.nextNode()) if (walker.currentNode.textContent?.includes(word)) { found = walker.currentNode as Text; break; }
      if (!found) throw new Error(`Missing styled text ${word}`);
      const authored = root.querySelector(authoredSelectors[word]);
      if (!authored || !authored.textContent?.includes(word)) throw new Error(`Missing authored inline wrapper for ${word}`);
      const computed = getComputedStyle(authored);
      result[word] = Object.fromEntries(["color", "font-family", "font-size", "font-style", "font-weight", "line-height", "letter-spacing", "background-color", "text-decoration-line", "text-decoration-thickness"].map(property => [property, computed.getPropertyValue(property)]));
      // Lexical may add a transparent leaf span. Typography/color must still
      // inherit correctly even though background and decoration paint upstream.
      const leaf = getComputedStyle(found.parentElement!);
      for (const property of ["color", "font-family", "font-size", "font-style", "font-weight", "line-height", "letter-spacing"]) result[word][`leaf:${property}`] = leaf.getPropertyValue(property);
    }
    return result;
  });
}
try {
  await page.goto("http://127.0.0.1:5241");
  await page.evaluate(() => {
    const counters = window as unknown as { fixtureInlineConstructions: number };
    counters.fixtureInlineConstructions = 0;
    customElements.define("fixture-inline", class extends HTMLElement { constructor() { super(); counters.fixtureInlineConstructions++; } });
  });
  await reset();
  await frame().waitForFunction(() => document.getElementById("custom-inline")?.getAttribute("tabindex") === "0");
  await frame().locator("#custom-inline").click();
  assert.equal(await page.evaluate(() => (window as unknown as { fixtureInlineConstructions: number }).fixtureInlineConstructions), 0, "authored custom tags never invoke the parent's registered custom-element constructor");
  assert.equal(await frame().locator("fixture-inline").evaluate(element => element.ownerDocument === document), true, "authored inline elements belong to the sandbox iframe document");
  const paragraphOriginal = await frame().locator("#last").textContent();
  const cellOriginal = await frame().locator("tbody tr:first-child td:first-child").textContent();
  const headingOriginal = await frame().locator("#programme-heading").textContent();
  const paragraphEdit = fixture.replace("more useful.</p></section>", "more useful. Paragraph change.</p></section>");
  const cellEdit = paragraphEdit.replace("<td>Story circle</td>", "<td>Story circle · table change</td>");
  const headingEdit = cellEdit.replace('id="programme-heading">The programme</h2>', 'id="programme-heading">The programme · heading change</h2>');
  await append("#last", " Paragraph change."); await waitSource(paragraphEdit);
  await append("tbody tr:first-child td:first-child", " · table change"); await waitSource(cellEdit);
  await append("#programme-heading", " · heading change"); await waitSource(headingEdit);

  // Focus another region without changing it. Undo must still target the last
  // document edit, then traverse the table and paragraph instead of going dead.
  await frame().locator("#last").click();
  await undo(); await waitSource(cellEdit); await activeSelection("#programme-heading", headingOriginal!.length);
  await frame().locator("#mixed").click();
  await undo(); await waitSource(paragraphEdit); await activeSelection("tbody tr:first-child td:first-child", cellOriginal!.length);
  await frame().locator("#mixed").click();
  await undo(); await waitSource(fixture); await activeSelection("#last", paragraphOriginal!.length);
  const visible = await frame().locator("#last").evaluate(element => {
    const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight, scroll: scrollY };
  });
  assert.ok(visible.scroll > 0 && visible.bottom > 0 && visible.top < visible.height, "undo to a lower paragraph must restore its viewport instead of jumping to the top");

  await frame().locator("#mixed").click(); await redo(); await waitSource(paragraphEdit);
  await activeSelection("#last", paragraphOriginal!.length + " Paragraph change.".length);
  await frame().locator("#mixed").click(); await redo(); await waitSource(cellEdit);
  await frame().locator("#last").click(); await redo(); await waitSource(headingEdit);
  await undo(); await waitSource(cellEdit);
  const repeatedOriginal = await frame().locator("#repeated").textContent();
  await append("#repeated", " Fresh 🌊 edit.");
  const freshEdit = cellEdit.replace('visit the café.</p>', 'visit the café. Fresh 🌊 edit.</p>');
  await waitSource(freshEdit);
  assert.equal(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true, "a new edit invalidates redo throughout the document");

  // Explicitly cross modes with pending history. The host must keep the history
  // session while Text is hidden and restore its affected region.
  await page.getByRole("button", { name: "Source", exact: true }).click();
  assert.equal(await source(), freshEdit);
  assert.equal(await page.locator(".cm-content[contenteditable=true]").count(), 1, "Source uses the actual CodeMirror editor");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.frameLocator("iframe").locator("#mixed").waitFor();
  await undo(); await waitSource(cellEdit); await activeSelection("#repeated", repeatedOriginal!.length);
  await frame().locator("#mixed").click(); await redo(); await waitSource(freshEdit);
  // Source edits establish a different canonical baseline; old redo must not
  // overwrite them when the Text presentation is recreated.
  await undo(); await waitSource(cellEdit);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const sourceEdit = cellEdit.replace("Harbour community report", "Harbour community report, revised source");
  await page.locator(".cm-content[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sourceEdit);
  await waitSource(sourceEdit);
  await page.keyboard.press("ControlOrMeta+Z"); await waitSource(cellEdit);
  await page.keyboard.press("ControlOrMeta+Shift+Z"); await waitSource(sourceEdit);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.frameLocator("iframe").locator("#mixed").waitFor();
  await waitSource(sourceEdit);
  assert.equal(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true, "an explicit Source change cannot resurrect stale redo");
  await undo(); await waitSource(cellEdit);
  await redo(); await waitSource(sourceEdit);

  stage = "inline style and source fidelity";
  await reset();
  const before = await styleSnapshot();
  await frame().locator("#fidelity").click();
  assert.deepEqual(await styleSnapshot(), before, "activating a region preserves authored nested spans, classes, inline styles and link styles");
  assert.equal(await source(), fixture, "activation alone does not modify canonical source");
  stage = "styled paragraph append";
  await append("#fidelity", " Today.");
  const styledEdit = fixture.replace("reading guide</a>.</p>", "reading guide</a>. Today.</p>");
  await waitSource(styledEdit);
  assert.deepEqual(await styleSnapshot(), before, "typing leaves pre-existing inline visual styles unchanged");
  stage = "styled paragraph cross-region undo";
  await frame().locator("#last").click(); await undo(); await waitSource(fixture);
  assert.deepEqual(await styleSnapshot(), before, "cross-region undo restores inline fidelity");
  await redo(); await waitSource(styledEdit);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled(), false, "an own-save echo retains document undo");
  await undo(); await waitSource(fixture);
  await redo(); await waitSource(styledEdit);
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  await page.frameLocator("iframe").locator("#fidelity").waitFor();
  assert.deepEqual(await styleSnapshot(), before, "save/reopen retains authored inline styling");
  assert.equal(await source(), styledEdit, "canonical output changes only the intended text, preserving every authored tag and attribute");
  // Replacing an entire mixed-format paragraph must render the canonical
  // retained wrappers immediately, not lose them until switching presentations.
  stage = "whole mixed-format paragraph replacement";
  const mixedPaint = () => frame().locator("#mixed").evaluate(element => {
    const strong = element.querySelector("strong");
    const link = element.querySelector("a");
    if (!strong || !link) throw new Error("Mixed paragraph lost its authored strong or link wrapper");
    const paint = (node: Element) => {
      const computed = getComputedStyle(node);
      return Object.fromEntries(["color", "font-family", "font-size", "font-weight", "font-style", "text-decoration-line"].map(property => [property, computed.getPropertyValue(property)]));
    };
    return { strong: { text: strong.textContent, paint: paint(strong) },
      link: { text: link.textContent, href: link.getAttribute("href"), title: link.getAttribute("title"), paint: paint(link) } };
  });
  const originalMixedPaint = await mixedPaint();
  const mixed = frame().locator("#mixed");
  const mixedText = await mixed.textContent();
  await page.frameLocator("iframe").locator('#mixed[tabindex="0"]').waitFor();
  await mixed.click();
  await mixed.press("ControlOrMeta+A");
  await page.keyboard.insertText(`${mixedText} Final review complete.`);
  const bulkEdit = styledEdit.replace("for the full story.</p>", "for the full story. Final review complete.</p>");
  await waitSource(bulkEdit);
  assert.deepEqual(await mixedPaint(), originalMixedPaint, "whole-paragraph replacement immediately retains original strong/link wrappers and styles that remain in canonical source");
  await undo(); await waitSource(styledEdit);
  assert.deepEqual(await mixedPaint(), originalMixedPaint, "undo of whole-paragraph replacement retains inline fidelity");
  await redo(); await waitSource(bulkEdit);
  assert.deepEqual(await mixedPaint(), originalMixedPaint, "redo of whole-paragraph replacement retains inline fidelity");

  stage = "post-reopen edit before external replacement";
  await append("#repeated", " Before peer.");
  const beforePeer = bulkEdit.replace("visit the café.</p>", "visit the café. Before peer.</p>");
  await waitSource(beforePeer);
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled(), false);
  stage = "external canonical replacement";
  await page.getByRole("button", { name: "Simulate external update", exact: true }).click();
  const external = beforePeer.replace("</body>", '<p id="external-update">A neighbour published this updated programme.</p></body>');
  await waitSource(external);
  await page.frameLocator("iframe").locator("#external-update").waitFor();
  await page.getByText("Document updated elsewhere; undo history restarted.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled(), true, "an external canonical replacement clears local undo");
  assert.equal(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true, "an external canonical replacement clears local redo");
  await frame().locator("#fidelity").click();
  await page.keyboard.press("ArrowRight");
  assert.equal(await source(), external, "re-entering a region after external replacement cannot emit an old source snapshot");
  assert.deepEqual(errors, []);
  console.log("PASS: document undo across paragraph/table/heading, selection/viewport restoration, cross-focus redo, redo invalidation, mode history, own-save retention, external reset, nested inline fidelity, whole-paragraph replacement fidelity, parent custom-element isolation, exact canonical source");
} finally {
  await browser.close();
}
