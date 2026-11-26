import { chromium } from "playwright";
import { strict as assert } from "node:assert";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
const frame = page.frameLocator('iframe[title="Edit HTML text"]');
const button = (name: string) => page.getByRole('button', { name, exact: true });
const source = async () => await page.getByTestId('canonical-source').textContent() ?? '';
const waitSource = async (html: string) => {
  try { await page.waitForFunction(html => document.querySelector('[data-testid="canonical-source"]')?.textContent === html, html); }
  catch (error) { console.error({ expected: html, actual: await source(), errors, alerts: await page.getByRole('alert').allTextContents() }); throw error; }
};
async function load(html: string) {
  const previousSource = await source();
  const previous = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  await button('Source').click(); const code = page.locator('.cm-content[contenteditable="true"]');
  await code.click(); await code.press('ControlOrMeta+A'); await page.keyboard.insertText(html); await button('Text').click();
  await waitSource(html); if (previous && previousSource !== html) await page.waitForFunction(element => !element.isConnected, previous);
  await frame.locator('[data-nautilo-html-region]').first().waitFor();
}
async function caret(offset: number, index = 0) {
  const region = frame.locator('[data-nautilo-html-region]').nth(index); await region.click();
  await region.press('ControlOrMeta+A'); await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
}
try {
  await page.goto('http://127.0.0.1:5241');
  const original = '<!doctype html><style>p{font:20px Georgia}</style><!--keep--><p>Sentence one. Sentence two. Sentence three.</p><p>Other text</p>';
  await load(original); await caret(14); await page.keyboard.press('Enter');
  const split = original.replace('Sentence one. Sentence two.', 'Sentence one. </p><p>Sentence two.');
  await waitSource(split); await page.keyboard.type('New '); await waitSource(split.replace('Sentence two.', 'New Sentence two.'));
  // Undo typed letters, then the split; redo the split restores the new paragraph's caret.
  for (let i = 0; i < 4; i++) await button('Undo').click(); await waitSource(split);
  await button('Undo').click(); await waitSource(original); await button('Redo').click(); await waitSource(split);
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="Edit HTML text"]')?.contentDocument;
    return doc?.activeElement?.textContent === 'Sentence two. Sentence three.' && doc.getSelection()?.isCollapsed;
  });
  await page.keyboard.type('Again '); const edited = split.replace('Sentence two.', 'Again Sentence two.'); await waitSource(edited);
  await button('Save').click(); await button('Reopen saved').click(); await waitSource(edited);
  await caret(0, 1); await page.keyboard.press('Shift+Enter');
  const soft = edited.replace('<p>Again', '<p><br>Again'); await waitSource(soft);
  await page.keyboard.type('Line '); await waitSource(soft.replace('<br>Again', '<br>Line Again'));

  await load('<p>Text</p>'); await caret(4); await page.keyboard.press('Shift+Enter'); await waitSource('<p>Text<br></p>');
  await page.keyboard.press('Shift+Enter'); await waitSource('<p>Text<br><br></p>');
  await page.keyboard.type('Last line'); await waitSource('<p>Text<br><br>Last line</p>');
  await button('Save').click(); await button('Reopen saved').click(); await caret(0, 1);
  await page.keyboard.type('Middle'); await waitSource('<p>Text<br>Middle<br>Last line</p>');

  await load('<p>First</p>'); await caret(5); await page.keyboard.press('Enter'); await waitSource('<p>First</p><p></p>');
  await page.keyboard.press('Enter'); await waitSource('<p>First</p><p></p><p></p>');
  await page.keyboard.type('Third'); await waitSource('<p>First</p><p></p><p>Third</p>');
  await caret(0, 1); await page.keyboard.type('Second'); await waitSource('<p>First</p><p>Second</p><p>Third</p>');

  await load('<p><strong>First second</strong> tail</p>'); await caret(6); await page.keyboard.press('Enter');
  await waitSource('<p><strong>First </strong></p><p><strong>second</strong> tail</p>');
  await page.keyboard.type('Bold '); await waitSource('<p><strong>First </strong></p><p><strong>Bold second</strong> tail</p>');
  await page.keyboard.press('Shift+Enter'); await waitSource('<p><strong>First </strong></p><p><strong>Bold <br>second</strong> tail</p>');
  await page.keyboard.type('Next '); await waitSource('<p><strong>First </strong></p><p><strong>Bold <br>Next second</strong> tail</p>');

  await load('<p>Body<sup><a href="#note">[2]</a></sup></p>'); await caret(7); await page.keyboard.press('Enter');
  await waitSource('<p>Body<sup><a href="#note">[2]</a></sup></p><p></p>');
  await page.keyboard.type('Ordinary text');
  await waitSource('<p>Body<sup><a href="#note">[2]</a></sup></p><p>Ordinary text</p>');

  await load('<p>A selected Z</p>'); await caret(2); for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Enter'); await waitSource('<p>A </p><p>Z</p>');
  await button('Undo').click(); await waitSource('<p>A selected Z</p>');
  assert.equal(await frame.locator('body > p').evaluate(e => e.ownerDocument.getSelection()?.toString()), 'selected ');
  assert.deepEqual(errors, []); assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  console.log('PASS: paragraph split, typing, undo/redo caret and selection, save/reopen, soft breaks, repeated empty lines and paragraphs, inline formatting');
} finally { await browser.close(); }
