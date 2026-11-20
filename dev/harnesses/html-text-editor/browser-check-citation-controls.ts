import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { buildSrcdoc } from "../../../apps/workbench/src/viewers/html/srcdoc";
import { buildCsp } from "../../../apps/workbench/src/viewers/html/csp";
import { htmlPageAnchorNavigationScript } from "../../../apps/workbench/src/viewers/html/page-anchor-navigation";

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
const fixture = '<!doctype html><style>body{font:20px Georgia}h2{margin-top:1000px}</style><p id="copy">Research [4]</p><h2>References</h2><p id="footnote">The source for this citation.</p>';
async function load(html = fixture) {
  const previous = await page.locator('iframe[title="Edit HTML text"]').elementHandle();
  await button('Source').click(); const code = page.locator('.cm-content[contenteditable="true"]');
  await code.click(); await code.press('ControlOrMeta+A'); await page.keyboard.insertText(html); await button('Text').click();
  await waitSource(html); if (previous) await page.waitForFunction(element => !element.isConnected, previous); await frame.locator('#copy[tabindex="0"]').waitFor();
}
async function end() { const e = frame.locator('#copy'); await e.click(); await e.press('ControlOrMeta+A'); await page.keyboard.press('ArrowRight'); }
async function citation() { await end(); for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft'); }
try {
  await page.goto('http://127.0.0.1:5241'); await load(); await citation(); await button('Superscript').click();
  const superscript = fixture.replace('[4]', '<sup>[4]</sup>'); await waitSource(superscript);
  assert.equal(await button('Superscript').getAttribute('aria-pressed'), 'true');
  await button('Superscript').click();
  assert.equal(await frame.locator('#copy sup').count(), 0);
  assert.equal(await frame.locator('#copy').textContent(), 'Research [4]');
  await button('Undo').click(); await waitSource(superscript); await citation();
  await button('Link').click(); await page.getByRole('combobox', { name: 'Link within this document' }).selectOption({ label: 'References' });
  await button('Apply link').click();
  const linked = superscript.replace('[4]', '<a href="#section-references">[4]</a>').replace('<h2>', '<h2 id="section-references">');
  await waitSource(linked);
  await button('Undo').click(); await waitSource(superscript); await button('Redo').click(); await waitSource(linked);
  await citation(); await button('Link').click(); await page.getByRole('combobox', { name: 'Link within this document' }).selectOption({ label: 'The source for this citation.' });
  await button('Apply link').click(); const footnote = linked.replace('href="#section-references"', 'href="#footnote"'); await waitSource(footnote);
  await button('Save').click(); await button('Reopen saved').click(); await frame.locator('#copy[tabindex="0"]').waitFor(); await waitSource(footnote);
  await end(); await page.keyboard.type(' normal'); await waitSource(footnote.replace('</sup></p>', '</sup> normal</p>'));

  // Explicit superscript typing remains active until the user turns it off.
  await load('<p id="copy">x</p>'); await end(); await page.keyboard.press('ControlOrMeta+Shift+='); await page.keyboard.type('42');
  await waitSource('<p id="copy">x<sup>42</sup></p>');
  await page.keyboard.press('ControlOrMeta+Shift+='); await page.keyboard.type(' normal');
  const plain = await source(); assert.equal(await frame.locator('#copy sup').textContent(), '42'); assert.ok(plain.includes('</sup>'));
  assert.equal(await frame.locator('#copy').textContent(), 'x42 normal');
  // Exercise the same sandbox and trusted fragment navigation as Reader.
  const previewSource = buildSrcdoc(footnote, buildCsp(), undefined, [htmlPageAnchorNavigationScript()]);
  await page.evaluate(source => {
    const iframe = document.createElement('iframe'); iframe.id = 'page-link-preview'; iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.height = '400px'; iframe.srcdoc = source; document.body.append(iframe);
  }, previewSource);
  const preview = page.frameLocator('#page-link-preview');
  await preview.locator('a[href="#footnote"]').click();
  await preview.locator('#footnote').evaluate(element => {
    const rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.top >= element.ownerDocument.defaultView!.innerHeight) throw new Error('Footnote did not scroll into view');
    if (element.ownerDocument.activeElement !== element) throw new Error('Footnote did not receive keyboard focus');
  });
  assert.equal(page.url(), 'http://127.0.0.1:5241/');
  assert.equal(await preview.locator('#copy').textContent(), 'Research [4]');
  assert.deepEqual(errors, []); assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  console.log('PASS: superscript selection, removal, typing mode, shortcut, heading and footnote links, generated anchors, undo/redo, save/reopen, normal continuation');
} finally { await browser.close(); }
