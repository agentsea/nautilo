import { chromium, type Frame } from "playwright";
import { strict as assert } from "node:assert";
import { formattingFixture } from "./fixture";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(10_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const frame = () => page.frames().find(candidate => candidate !== page.mainFrame()) as Frame;
const ready = (selector: string) => page.frameLocator("iframe").locator(`${selector}[tabindex="0"]`).waitFor();
const text = async (selector: string) => { await ready(selector); return await frame().locator(selector).textContent() ?? ""; };
const source = async () => await page.getByTestId("canonical-source").textContent() ?? "";
let stage = "load formatting fixture";
const waitSource = (expected: string) => page.waitForFunction(expected => document.querySelector('[data-testid="canonical-source"]')?.textContent === expected, expected);
const markButton = (name: "Bold" | "Italic" | "Underline") => page.getByRole("button", { name, exact: true });
const waitPressed = (name: string, state: "true" | "false" | "mixed") => page.waitForFunction(({ name, state }) => document.querySelector(`button[aria-label="${name}"]`)?.getAttribute("aria-pressed") === state, { name, state });
const reset = async () => {
  await page.getByRole("button", { name: "Load formatting example", exact: true }).click();
  await page.frameLocator("iframe").locator('#format-plain[tabindex="0"]').waitFor();
  await waitSource(formattingFixture);
};
async function select(selector: string, start: number, end: number) {
  await page.frameLocator("iframe").locator(`${selector}[tabindex="0"]`).waitFor();
  const target = frame().locator(selector);
  await target.click();
  await target.press("ControlOrMeta+A");
  await target.press("ArrowLeft");
  for (let index = 0; index < start; index++) await target.press("ArrowRight");
  await page.keyboard.down("Shift");
  for (let index = start; index < end; index++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  const currentText = await target.textContent() ?? "";
  assert.equal(await frame().evaluate(() => getSelection()?.toString()), currentText.slice(start, end), "real keyboard selection must identify the intended text before using the toolbar");
}
async function selectWord(selector: string, word: string) {
  const currentText = await text(selector);
  const start = currentText.indexOf(word); assert.ok(start >= 0, `Missing fixture word ${word}`);
  await select(selector, start, start + word.length);
}
async function wordStyles(selector: string, word: string) {
  await ready(selector);
  return await frame().evaluate(({ selector, word }) => {
    const root = document.querySelector(selector)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const samples: Array<{ bold: boolean; italic: boolean; underline: boolean; href: string | null }> = [];
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement!;
      const computed = getComputedStyle(parent);
      const ancestors: Element[] = []; let current: Element | null = parent;
      while (current) { ancestors.push(current); if (current === root) break; current = current.parentElement; }
      const style = { bold: Number.parseInt(computed.fontWeight, 10) >= 600,
        italic: /italic|oblique/.test(computed.fontStyle),
        underline: ancestors.some(element => getComputedStyle(element).textDecorationLine.includes("underline")),
        href: parent.closest("a")?.getAttribute("href") ?? null };
      const value = node.textContent ?? ""; text += value;
      for (let index = 0; index < value.length; index++) samples.push(style);
    }
    const start = text.indexOf(word);
    if (start < 0) throw new Error(`Missing styled text ${word}`);
    return samples.slice(start, start + word.length);
  }, { selector, word });
}
async function assertMark(selector: string, word: string, mark: "bold" | "italic" | "underline", enabled: boolean) {
  const styles = await wordStyles(selector, word);
  assert.ok(styles.length > 0);
  assert.ok(styles.every(style => style[mark] === enabled), `${word} must render ${mark}=${enabled}`);
}
function outsideParagraph(html: string, id: string) {
  const opening = html.indexOf(`<p id="${id}"`); assert.ok(opening >= 0);
  const end = html.indexOf("</p>", opening); assert.ok(end >= 0);
  return `${html.slice(0, opening)}<UNCHANGED-REGION>${html.slice(end + 4)}`;
}
async function assertLocalChange(before: string, id: string) {
  const after = await source();
  assert.equal(outsideParagraph(after, id), outsideParagraph(before, id), "formatting preserves all source bytes outside the selected paragraph");
  return after;
}
async function assertText(selector: string, expected: string) {
  assert.equal((await text(selector)).replaceAll("\u00a0", " "), expected);
  assert.equal(await page.evaluate(({ html, selector }) => new DOMParser().parseFromString(html, "text/html").querySelector(selector)?.textContent, { html: await source(), selector }), expected, "canonical text matches the active preview");
}
async function assertCaret(selector: string, expected: number) {
  await ready(selector);
  const actual = await frame().evaluate(selector => {
    const root = document.querySelector(selector)!;
    const selection = getSelection();
    const focus = selection?.focusNode;
    const inside = !!focus && (focus === root || root.contains(focus));
    const range = document.createRange(); range.selectNodeContents(root);
    if (inside) range.setEnd(focus, selection.focusOffset);
    return { collapsed: selection?.isCollapsed, inside, offset: range.toString().length };
  }, selector);
  assert.deepEqual(actual, { collapsed: true, inside: true, offset: expected }, "editing/removing a link at the caret retains its original collapsed text position");
}
async function undoTo(expected: string) { await page.getByRole("button", { name: "Undo", exact: true }).click(); await waitSource(expected); }
async function redoTo(expected: string) { await page.getByRole("button", { name: "Redo", exact: true }).click(); await waitSource(expected); }
async function openLink(shortcut = false) {
  if (shortcut) await page.keyboard.press("ControlOrMeta+K");
  else await page.getByRole("button", { name: "Link", exact: true }).click();
  await page.getByRole("dialog").waitFor();
}
async function applyUrl(url: string) {
  await page.getByRole("textbox", { name: "Link URL", exact: true }).fill(url);
  await page.getByRole("button", { name: "Apply link", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
try {
  await page.goto("http://127.0.0.1:5241"); await reset();
  assert.equal(await frame().locator("script").count(), 0);
  assert.equal(await frame().evaluate(() => (window as unknown as { formattingAuthoredScriptRan?: boolean }).formattingAuthoredScriptRan), undefined);

  stage = "selected range marks and shortcuts";
  await selectWord("#format-plain", "readers"); await waitPressed("Bold", "false");
  await markButton("Bold").click(); await waitPressed("Bold", "true");
  await ready("#format-plain");
  assert.equal(await frame().evaluate(() => getSelection()?.toString()), "readers", "toolbar click retains iframe selection");
  await assertMark("#format-plain", "readers", "bold", true); await assertMark("#format-plain", "Harbour", "bold", false);
  const bold = await assertLocalChange(formattingFixture, "format-plain");
  await undoTo(formattingFixture); await redoTo(bold);
  await selectWord("#format-plain", "readers"); await waitPressed("Bold", "true");
  await page.keyboard.press("ControlOrMeta+B"); await waitPressed("Bold", "false");
  await assertMark("#format-plain", "readers", "bold", false);
  for (const [name, key, mark] of [["Italic", "I", "italic"], ["Underline", "U", "underline"]] as const) {
    await selectWord("#format-plain", "useful");
    await page.keyboard.press(`ControlOrMeta+${key}`); await waitPressed(name, "true");
    await assertMark("#format-plain", "useful", mark, true);
    await markButton(name).click(); await waitPressed(name, "false");
    await assertMark("#format-plain", "useful", mark, false);
  }
  await selectWord("#format-plain", "useful");
  await page.keyboard.press("ControlOrMeta+I"); await waitPressed("Italic", "true");
  await page.keyboard.press("ControlOrMeta+U"); await waitPressed("Underline", "true");
  await assertText("#format-plain", "Harbour readers share useful ideas.");
  await assertLocalChange(formattingFixture, "format-plain");

  stage = "collapsed mark applies to future typing only";
  const beforeTyping = await source();
  const plainLength = (await text("#format-plain")).length;
  await select("#format-plain", plainLength, plainLength);
  await markButton("Bold").click(); await waitPressed("Bold", "true");
  assert.equal(await source(), beforeTyping, "toggling a collapsed typing mark does not rewrite existing source");
  await page.keyboard.type(" Neighbours.");
  await assertMark("#format-plain", "Neighbours", "bold", true);
  await assertMark("#format-plain", "ideas", "bold", false);
  await page.keyboard.press("ControlOrMeta+B"); await waitPressed("Bold", "false");
  await page.keyboard.type(" Welcome.");
  await assertMark("#format-plain", "Welcome", "bold", false);
  await assertText("#format-plain", "Harbour readers share useful ideas. Neighbours. Welcome.");
  await assertLocalChange(beforeTyping, "format-plain");
  const savedMarks = await source();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  await page.frameLocator("iframe").locator('#format-plain[tabindex="0"]').waitFor();
  assert.equal(await source(), savedMarks, "all three marks persist through canonical save/reopen");
  await assertMark("#format-plain", "useful", "italic", true);
  await assertMark("#format-plain", "useful", "underline", true);
  await assertMark("#format-plain", "Neighbours", "bold", true);
  await assertMark("#format-plain", "Welcome", "bold", false);

  stage = "mixed and inherited existing marks"; await reset();
  const mixedLength = (await text("#format-mixed")).length;
  await select("#format-mixed", 0, mixedLength); await waitPressed("Bold", "mixed");
  await markButton("Bold").click(); await waitPressed("Bold", "true");
  await assertMark("#format-mixed", "Keep bold and plain.", "bold", true);
  await markButton("Bold").click(); await waitPressed("Bold", "false");
  await assertMark("#format-mixed", "Keep bold and plain.", "bold", false);
  await assertLocalChange(formattingFixture, "format-mixed");
  const beforeInherited = await source();
  await selectWord("#format-inherited", "harbour"); await waitPressed("Bold", "true");
  await markButton("Bold").click(); await waitPressed("Bold", "false");
  await assertMark("#format-inherited", "harbour", "bold", false);
  await assertMark("#format-inherited", "Inherited", "bold", true);
  await assertLocalChange(beforeInherited, "format-inherited");
  const beforeNested = await source();
  await selectWord("#format-nested", "harbour"); await waitPressed("Italic", "true");
  await page.keyboard.press("ControlOrMeta+I"); await waitPressed("Italic", "false");
  await assertMark("#format-nested", "harbour", "italic", false);
  const nested = await assertLocalChange(beforeNested, "format-nested");
  await undoTo(beforeNested); await redoTo(nested);
  await selectWord("#format-nested", "available"); await waitPressed("Underline", "true");
  await page.keyboard.press("ControlOrMeta+U"); await waitPressed("Underline", "false");
  await assertMark("#format-nested", "available", "underline", false);
  await assertText("#format-nested", "The harbour notes stay available.");
  assert.ok((await source()).includes('<span class="original-emphasis" style="letter-spacing:.3px">'), "mark changes retain the unrelated nested span's exact authored attributes");

  stage = "inline islands around a preserved line break"; await reset();
  const secondIsland = "#format-break > [data-nautilo-html-region]:last-child";
  await selectWord(secondIsland, "words");
  await markButton("Italic").click(); await waitPressed("Italic", "true");
  await assertMark(secondIsland, "words", "italic", true);
  await assertMark(secondIsland, "Second", "italic", false);
  const breakMarked = await assertLocalChange(formattingFixture, "format-break");
  const islandEnd = (await text(secondIsland)).length;
  await select(secondIsland, islandEnd, islandEnd);
  await page.keyboard.insertText(" Added.");
  assert.equal(await text(secondIsland), "Second words bold Added.");
  assert.equal(await page.evaluate(html => new DOMParser().parseFromString(html, "text/html").getElementById("format-break")?.textContent, await source()), "First wordsSecond words bold Added.");
  assert.equal(await frame().locator("#format-break br").count(), 1, "formatting and subsequent typing preserve the authored line break");
  assert.equal(await text("#format-break > [data-nautilo-html-region]:first-child"), "First words");
  const breakTyped = await assertLocalChange(breakMarked, "format-break");
  await undoTo(breakMarked); await redoTo(breakTyped);

  stage = "real IME composition retains pending bold and one undo unit"; await reset();
  const compositionEnd = (await text("#format-plain")).length;
  await select("#format-plain", compositionEnd, compositionEnd);
  await markButton("Bold").click(); await waitPressed("Bold", "true");
  const cdp = await page.context().newCDPSession(page);
  const imeSnapshots: string[] = [];
  for (const provisional of ["港", "港湾"]) {
    await cdp.send("Input.imeSetComposition", { text: provisional, selectionStart: provisional.length, selectionEnd: provisional.length });
    await page.waitForFunction(expected => {
      const html = document.querySelector('[data-testid="canonical-source"]')?.textContent;
      return !!html && new DOMParser().parseFromString(html, "text/html").getElementById("format-plain")?.textContent === expected;
    }, `Harbour readers share useful ideas.${provisional}`);
    imeSnapshots.push(await assertLocalChange(formattingFixture, "format-plain"));
  }
  assert.notEqual(imeSnapshots[0], imeSnapshots[1], "real provisional IME updates reach canonical draft continuously");
  await cdp.send("Input.insertText", { text: "港湾" });
  await page.waitForFunction(() => {
    const doc = document.querySelector("iframe")?.contentDocument;
    const root = doc?.getElementById("format-plain");
    if (!doc || !root?.textContent?.endsWith("港湾")) return false;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.textContent?.includes("港湾")) return Number.parseInt(doc.defaultView!.getComputedStyle(walker.currentNode.parentElement!).fontWeight, 10) >= 600;
    return false;
  });
  await assertText("#format-plain", "Harbour readers share useful ideas.港湾");
  await assertMark("#format-plain", "港湾", "bold", true);
  const composed = await assertLocalChange(formattingFixture, "format-plain");
  await undoTo(formattingFixture); await redoTo(composed);
  await cdp.detach();

  stage = "link validation, cancellation and selected range insertion"; await reset();
  await selectWord("#format-plain", "readers"); await openLink(true);
  assert.equal(await page.getByRole("textbox", { name: "Link text", exact: true }).count(), 0, "selected link text comes from the retained selection");
  for (const invalid of ["javascript:alert(1)", "data:text/html,unsafe", "https://example.org/a\tb"]) {
    await page.getByRole("textbox", { name: "Link URL", exact: true }).fill(invalid);
    await page.getByRole("button", { name: "Apply link", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await source(), formattingFixture, "invalid URL cannot mutate source");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled(), true, "invalid URL creates no history entry");
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await source(), formattingFixture);
  assert.equal(await frame().evaluate(() => getSelection()?.toString()), "readers", "cancel restores the original selection");
  await openLink();
  await page.getByRole("textbox", { name: "Link URL", exact: true }).fill("https://example.org/not-applied");
  await page.keyboard.press("Escape");
  assert.equal(await source(), formattingFixture, "Escape cancels link changes");
  await openLink(); await applyUrl("https://example.org/readers?day=1&view=all");
  assert.ok((await wordStyles("#format-plain", "readers")).every(style => style.href === "https://example.org/readers?day=1&view=all"));
  const linked = await assertLocalChange(formattingFixture, "format-plain");
  await undoTo(formattingFixture); await redoTo(linked);

  stage = "partial existing link edit and removal"; await reset();
  await selectWord("#format-link", "report"); await openLink();
  assert.equal(await page.getByRole("dialog", { name: "Edit link", exact: true }).count(), 1);
  assert.equal(await page.getByRole("textbox", { name: "Link URL", exact: true }).inputValue(), "https://example.org/original");
  await applyUrl("https://example.org/revised");
  assert.ok((await wordStyles("#format-link", "report")).every(style => style.href === "https://example.org/revised"));
  assert.ok((await wordStyles("#format-link", "community")).every(style => style.href === "https://example.org/original"), "partial editing preserves the unselected anchor fragment");
  assert.ok(await frame().locator('#format-link a.original-link[title="Original harbour link"]').count() > 0);
  assert.equal(await frame().locator("#original-report-link").count(), 1, "splitting an existing link preserves its unique authored ID on one fragment");
  const partial = await assertLocalChange(formattingFixture, "format-link");
  await selectWord("#format-link", "report"); await openLink();
  await page.getByRole("button", { name: "Remove link", exact: true }).click();
  assert.ok((await wordStyles("#format-link", "report")).every(style => style.href === null));
  assert.ok((await wordStyles("#format-link", "community")).every(style => style.href === "https://example.org/original"));
  const removed = await assertLocalChange(partial, "format-link");
  await undoTo(partial); await redoTo(removed);
  await assertText("#format-link", "Read the community report today.");
  // A caret edits the containing anchor, in contrast to the selected-slice
  // operation above. Its original class/title stay attached to that link.
  const linkText = await text("#format-link");
  const caret = linkText.indexOf("community") + 3;
  await select("#format-link", caret, caret); await openLink(true);
  assert.equal(await page.getByRole("dialog", { name: "Edit link", exact: true }).count(), 1);
  assert.equal(await page.getByRole("textbox", { name: "Link text", exact: true }).count(), 0);
  await applyUrl("https://example.org/community");
  assert.ok((await wordStyles("#format-link", "community")).every(style => style.href === "https://example.org/community"));
  assert.ok((await wordStyles("#format-link", "report")).every(style => style.href === null));
  const caretEdited = await assertLocalChange(removed, "format-link");
  await assertCaret("#format-link", caret);
  await undoTo(removed); await redoTo(caretEdited);
  await assertCaret("#format-link", caret);
  await select("#format-link", caret, caret); await openLink();
  await page.getByRole("button", { name: "Remove link", exact: true }).click();
  await assertCaret("#format-link", caret);
  assert.ok((await wordStyles("#format-link", "community")).every(style => style.href === null));
  const caretRemoved = await assertLocalChange(caretEdited, "format-link");
  await undoTo(caretEdited); await redoTo(caretRemoved);
  await assertCaret("#format-link", caret);

  stage = "collapsed new link and save/reopen";
  const beforeCollapsed = await source();
  const end = (await text("#format-plain")).length;
  await select("#format-plain", end, end); await openLink(true);
  await page.getByRole("textbox", { name: "Link text", exact: true }).fill("Map");
  await applyUrl("https://example.org/map");
  await assertText("#format-plain", "Harbour readers share useful ideas.Map");
  assert.ok((await wordStyles("#format-plain", "Map")).every(style => style.href === "https://example.org/map"));
  const final = await assertLocalChange(beforeCollapsed, "format-plain");
  await undoTo(beforeCollapsed); await redoTo(final);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved", exact: true }).click();
  await page.frameLocator("iframe").locator('#format-plain[tabindex="0"]').waitFor();
  assert.equal(await source(), final, "save/reopen retains the precise formatting and link source");
  assert.ok((await wordStyles("#format-plain", "Map")).every(style => style.href === "https://example.org/map"));
  assert.deepEqual(errors, []);
  console.log("PASS: selected/collapsed/mixed/inherited marks, BR-island typing, real IME composition, B/I/U/K shortcuts, retained selection, safe links, partial link edit/removal, cancel, history, exact source locality and save/reopen");
} catch (error) {
  console.error(JSON.stringify({ stage, errors, selected: await frame().evaluate(() => getSelection()?.toString()), alerts: await page.getByRole("alert").allTextContents(),
    canonicalPlain: await page.evaluate(html => new DOMParser().parseFromString(html, "text/html").getElementById("format-plain")?.outerHTML, await source()),
    livePlain: await frame().evaluate(() => ({ text: document.getElementById("format-plain")?.textContent, spans: Array.from(document.querySelectorAll("#format-plain span")).map(span => ({ text: span.textContent, weight: getComputedStyle(span).fontWeight, italic: getComputedStyle(span).fontStyle, decoration: getComputedStyle(span).textDecorationLine })), focusedId: document.activeElement?.id, anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset })),
    aria: await page.getByRole("toolbar", { name: "Text formatting" }).locator("button").evaluateAll(buttons => buttons.map(button => [button.getAttribute("aria-label"), button.getAttribute("aria-pressed")])) }));
  throw error;
} finally { await browser.close(); }
