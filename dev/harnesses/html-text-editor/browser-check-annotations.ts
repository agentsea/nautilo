import { chromium } from "playwright";
import { strict as assert } from "node:assert";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const frame = page.frameLocator('iframe[title="Edit HTML text"]');
const button = (name: string) => page.getByRole("button", { name, exact: true });
const waitSource = async (html: string) => {
  try { await page.waitForFunction(html => document.querySelector('[data-testid="canonical-source"]')?.textContent === html, html); }
  catch (error) { console.error({ expected: html, actual: await page.getByTestId("canonical-source").textContent(), errors, alerts: await page.getByRole('alert').allTextContents() }); throw error; }
};
const fixture = '<!doctype html><style>p{font-size:24px}sup,sub{color:red}a{color:inherit}</style><!--keep--><p id="copy">Body<sup><a href="#two">[2]</a></sup><a href="#three"><sup>[3]</sup></a></p><p id="other">Other text</p>';
async function load(html = fixture) {
  const previous = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  await button("Source").click();
  const code = page.locator('.cm-content[contenteditable="true"]');
  await code.click(); await code.press("ControlOrMeta+A"); await page.keyboard.insertText(html);
  await button("Text").click(); await waitSource(html);
  if (previous) await page.waitForFunction(element => !element.isConnected, previous);
  await frame.locator('#copy[tabindex="0"]').waitFor();
}
async function end() {
  const copy = frame.locator('#copy'); await copy.click(); await copy.press('ControlOrMeta+A'); await page.keyboard.press('ArrowRight');
}
async function paste(text: string) {
  await frame.locator('#copy').evaluate((element, text) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, text);
}
try {
  await page.goto('http://127.0.0.1:5241'); await load(); await end();
  await paste(' More & <plain>\ntext');
  const expected = fixture.replace('</a></p>', '</a> More &amp; &lt;plain&gt; text</p>');
  await waitSource(expected);
  assert.equal(await frame.locator('#copy sup').allTextContents().then(v => v.join('')), '[2][3]');
  assert.equal(await frame.locator('#copy a').allTextContents().then(v => v.join('')), '[2][3]');
  const style = await frame.locator('#copy').evaluate(element => {
    const walk = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (walk.currentNode.textContent?.includes(' More')) {
      const parent = walk.currentNode.parentElement!;
      return { font: getComputedStyle(parent).fontSize, normalFont: getComputedStyle(element).fontSize, annotation: !!parent.closest('sup,sub,a') };
    }
    throw new Error('Missing pasted continuation');
  });
  assert.equal(style.font, style.normalFont); assert.equal(style.annotation, false);
  await button('Undo').click(); await waitSource(fixture);
  await button('Redo').click(); await waitSource(expected);
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="Edit HTML text"]')?.contentDocument;
    const element = doc?.querySelector('#copy'), selection = doc?.getSelection();
    if (!element || !selection?.focusNode || !element.contains(selection.focusNode) || !selection.isCollapsed) return false;
    const range = doc!.createRange(); range.selectNodeContents(element); range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length === element.textContent?.length;
  });
  await page.keyboard.type(' continues'); await waitSource(expected.replace(' text</p>', ' text continues</p>'));
  await button('Save').click(); const old = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  await button('Reopen saved').click(); await page.waitForFunction(element => !element.isConnected, old);
  await end(); await page.keyboard.type(' again'); await waitSource(expected.replace(' text</p>', ' text continues again</p>'));

  await load(); await end(); await page.keyboard.type(' typed'); await waitSource(fixture.replace('</a></p>', '</a> typed</p>'));
  await button('Undo').click(); // Each ordinary typing transaction remains undoable.
  assert.equal(await frame.locator('#copy sup').allTextContents().then(v => v.join('')), '[2][3]');

  // A caret inside a citation still edits that citation.
  await load(); await end(); await page.keyboard.press('ArrowLeft');
  await paste('9');
  await waitSource(fixture.replace('[3]', '[39]'));
  // Selecting citation text and replacing it must also preserve its formatting.
  await load(); await end(); await page.keyboard.press('Shift+ArrowLeft'); await paste('!');
  await waitSource(fixture.replace('[3]', '[3!'));

  // Insertion between two citations must not attach to either link.
  await load(); await end(); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await paste(' middle '); await waitSource(fixture.replace('</sup><a', '</sup> middle <a'));

  // Explicit pending bold applies to the continuation, independently of the citation.
  await load(); await end(); await button('Bold').click(); await paste(' bold');
  await waitSource(fixture.replace('</a></p>', '</a><span style="font-weight:bold !important"> bold</span></p>'));
  await load('<p id="copy">H<sub>2</sub></p>'); await end(); await paste('O');
  await waitSource('<p id="copy">H<sub>2</sub>O</p>');
  await load('<p id="copy">Plain text</p>'); await end(); await page.keyboard.press('ArrowLeft');
  await paste(' first\nsecond'); await waitSource('<p id="copy">Plain tex first secondt</p>');
  await load('<pre id="copy">Pre</pre>'); await end(); await paste('\nSecond\tline');
  await waitSource('<pre id="copy">Pre\nSecond\tline</pre>');
  assert.deepEqual(errors, []); assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  console.log('PASS: citation paste and typing, baseline style, exact source, undo/redo, reopen, inner and ranged edits, adjacent citations, pending formatting');
} finally { await browser.close(); }
