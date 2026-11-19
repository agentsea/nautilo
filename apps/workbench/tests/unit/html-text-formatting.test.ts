import { describe, expect, test } from "bun:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { applyHtmlRegionText, buildHtmlTextModel } from "../../src/editors/html-text-model";
import { applyHtmlFormatting, htmlFormattingLinkRange, normalizeHtmlLinkUrl, type HtmlFormattingAction } from "../../src/editors/html-text-formatting";

function format(source: string, anchor: number, focus: number, action: HtmlFormattingAction) {
  const model = buildHtmlTextModel(source);
  const result = applyHtmlFormatting(model, source, { regionId: model.regions[0].id, anchor, focus, action });
  if (!result.ok) throw new Error(result.reason);
  return result;
}
function anchors(source: string) {
  const values: { text: string; href?: string; id?: string; title?: string; className?: string }[] = [];
  const text = (node: DefaultTreeAdapterMap["node"]): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "a") {
      const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
      values.push({ text: text(node), href: attrs.href, id: attrs.id, title: attrs.title, className: attrs.class });
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(source)); return values;
}

describe("source-preserving HTML formatting", () => {
  test("wraps partial Unicode/entity text while retaining page bytes, nested tags, attributes and scripts", () => {
    const source = '<!doctype html><style>.x{color:red}</style><p class="x" id="p">A &amp; <b title="keep">bold🌊 words</b> end</p><!--tail--><script>trustedSourceOnly()</script>';
    const result = format(source, 6, 12, { kind: "mark", mark: "italic", enabled: true });
    expect(result.source).toBe(source.replace('bold🌊 words', 'bo<span style="font-style:italic !important">ld🌊 w</span>ords'));
    expect(buildHtmlTextModel(result.source).regions[0].text).toBe('A & bold🌊 words end');
    expect(result.anchor).toBe(6); expect(result.focus).toBe(12);
  });
  test("removes inherited bold/italic only from the chosen range and preserves backward selection", () => {
    const source = '<p><strong id="keep" class="styled">one two three</strong></p>';
    const result = format(source, 7, 4, { kind: "mark", mark: "bold", enabled: false });
    expect(result.source).toBe('<p><strong id="keep" class="styled">one <span style="font-weight:normal !important">two</span> three</strong></p>');
    expect(result.anchor).toBe(7); expect(result.focus).toBe(4);
  });
  test("partial link change splits nested formatting and retains attrs with unique IDs", () => {
    const source = '<p><a id="one" href="/old" class="guide" title="a > b"><b id="bold">one two three</b></a> tail</p>';
    const result = format(source, 4, 7, { kind: "link", href: '/new?x=1&y=2' });
    expect(anchors(result.source)).toEqual([
      { text: 'one ', href: '/old', id: 'one', className: 'guide', title: 'a > b' },
      { text: 'two', href: '/new?x=1&y=2', id: undefined, className: 'guide', title: 'a > b' },
      { text: ' three', href: '/old', id: undefined, className: 'guide', title: 'a > b' },
    ]);
    expect(result.source.match(/id="bold"/g)).toHaveLength(1);
    expect(buildHtmlTextModel(result.source).regions[0].text).toBe('one two three tail');
  });
  test("link replacement across links creates no nested anchor and preserves comments", () => {
    const source = '<p>before <a href="/one" title="one">first</a><!-- keep --> and <em><a href="/two">second</a></em> after</p>';
    const result = format(source, 9, 22, { kind: "link", href: '#new' });
    expect(anchors(result.source).map(a => [a.text, a.href])).toEqual([['fi','/one'], ['rst','#new'], [' and ','#new'], ['secon','#new'], ['d','/two']]);
    expect(result.source).toContain('<!-- keep -->');
    expect(buildHtmlTextModel(result.source).regions[0].text).toBe('before first and second after');
  });
  test("partial remove retains original anchor styling and only removes href", () => {
    const source = '<p><a href="/old" id="link" title="keep">first second</a></p>';
    const result = format(source, 6, 12, { kind: 'link', href: null });
    expect(anchors(result.source).map(a => [a.text, a.href, a.title, a.id])).toEqual([['first ', '/old', 'keep', 'link'], ['second', undefined, 'keep', undefined]]);
  });
  test("caret edits whole containing link and insertion escapes label and URL", () => {
    const source = '<p>Hello <a href="/old" title="keep">linked <em>words</em></a>.</p>';
    const model = buildHtmlTextModel(source);
    expect(htmlFormattingLinkRange(model, model.regions[0].id, 9)).toEqual({ anchor: 6, focus: 18, href: '/old' });
    expect(htmlFormattingLinkRange(model, model.regions[0].id, 18)).toEqual({ anchor: 6, focus: 18, href: '/old' });
    expect(format(source, 9, 9, { kind: 'link', href: '/new' }).source).toBe(source.replace('href="/old"', 'href="/new"'));
    expect(format('<p>Hi </p>', 3, 3, { kind: 'link', href: '/?a=1&b=2', text: '<hello>' }).source).toBe('<p>Hi <a href="/?a=1&amp;b=2">&lt;hello&gt;</a></p>');
    expect(format('<p></p>', 0, 0, { kind: 'link', href: '#top', text: 'Top' }).focus).toBe(3);
  });
  test("underline off changes decorating ancestor while preserving unselected text and line-through", () => {
    const source = '<div class="decorated"><p>one two three</p><p>other text</p><script>keep()</script></div>';
    const model = buildHtmlTextModel(source);
    const result = applyHtmlFormatting(model, source, { regionId: model.regions[0].id, anchor: 4, focus: 7,
      action: { kind: 'mark', mark: 'underline', enabled: false }, underlineOwners: [0], underlineOwnerLines: { 0: 'underline line-through' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('class="decorated" style="text-decoration-line:line-through !important;"');
    expect(result.source).toContain('<p><span style="text-decoration-line:underline">one </span>two<span style="text-decoration-line:underline"> three</span></p>');
    expect(result.source).toContain('<p><span style="text-decoration-line:underline">other text</span></p><script>keep()</script>');
  });
  test("semantic underline owner is resolved without computed metadata", () => {
    const result = format('<p><u class="keep">one two</u></p>', 4, 7, { kind: 'mark', mark: 'underline', enabled: false });
    expect(result.source).toContain('<u class="keep" style="text-decoration-line:none !important;">');
    expect(result.source).toContain('<span style="text-decoration-line:underline">one </span>two');
  });
  test("rejects stale source, half-surrogate coordinates and unrelated decoration owners", () => {
    const source = '<p>🌊wave</p><p>other</p>'; const model = buildHtmlTextModel(source);
    const base = { regionId: model.regions[0].id, anchor: 0, focus: 2, action: { kind: 'mark' as const, mark: 'bold' as const, enabled: true } };
    expect(applyHtmlFormatting(model, source + ' ', base).ok).toBe(false);
    expect(applyHtmlFormatting(model, source, { ...base, focus: 1 }).ok).toBe(false);
    expect(applyHtmlFormatting(model, source, { ...base, action: { kind: 'mark', mark: 'underline', enabled: false }, underlineOwners: [source.indexOf('<p>other')] }).ok).toBe(false);
  });
  test("only admits exact safe link spellings", () => {
    for (const url of ['https://example.com/a?b=1&c=2', 'http://example.com', 'mailto:fixture@example.invalid', 'tel:+441234', '/path', '../path', '#anchor', '?query=x']) expect(normalizeHtmlLinkUrl(url)).toBe(url);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:https://x/id', 'java\nscript:alert(1)', '\thttps://example.com', 'https://a b', '//x\\y', '']) expect(normalizeHtmlLinkUrl(url)).toBeNull();
  });
  test("split clone appearance preserves ID-derived styles without duplicating the ID", () => {
    const source = '<p><a id="styled" href="/old">one two</a></p>';
    const model = buildHtmlTextModel(source);
    const result = applyHtmlFormatting(model, source, { regionId: model.regions[0].id, anchor: 4, focus: 7,
      action: { kind: 'link', href: '/new' }, sourceInlineStyles: { 3: 'color:rgb(255, 0, 0);font-weight:700;' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.match(/id="styled"/g)).toHaveLength(1);
    expect(result.source).toContain('href="/new" style="color:rgb(255, 0, 0);font-weight:700;"');
  });
  test("retains underline color, style and thickness on unselected text", () => {
    const source = '<p><u>one two</u></p>'; const model = buildHtmlTextModel(source);
    const result = applyHtmlFormatting(model, source, { regionId: model.regions[0].id, anchor: 4, focus: 7,
      action: { kind: 'mark', mark: 'underline', enabled: false }, sourceInlineStyles: { 3: 'color:red;text-decoration-style:wavy;text-decoration-color:rgb(0, 0, 255);text-decoration-thickness:2px;' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('text-decoration-line:underline;text-decoration-style:wavy;text-decoration-color:rgb(0, 0, 255);text-decoration-thickness:2px;');
  });
  test("formatting and subsequent typing retain inline islands around breaks and media", () => {
    const source = '<p>First words<br>Second words <strong>bold</strong><img src="keep.png">Last words</p>';
    const initial = buildHtmlTextModel(source);
    expect(initial.regions.map(region => region.text)).toEqual(['First words', 'Second words bold', 'Last words']);
    expect(initial.previewHtml).toContain('<span style="all:unset" data-nautilo-html-region=');
    const formatted = applyHtmlFormatting(initial, source, { regionId: initial.regions[1].id, anchor: 7, focus: 12,
      action: { kind: 'mark', mark: 'italic', enabled: true } });
    expect(formatted.ok).toBe(true); if (!formatted.ok) return;
    const next = buildHtmlTextModel(formatted.source);
    expect(next.regions.map(region => region.text)).toEqual(initial.regions.map(region => region.text));
    expect(formatted.anchor).toBe(7); expect(formatted.focus).toBe(12);
    const typed = applyHtmlRegionText(next, formatted.source, next.regions[1].id, 'Second words! bold');
    expect(typed.ok).toBe(true); if (!typed.ok) return;
    expect(typed.source).toContain('<br>Second <span style="font-style:italic !important">words!</span> <strong>bold</strong><img src="keep.png">');
    expect(buildHtmlTextModel(typed.source).regions.map(region => region.text)).toEqual(['First words', 'Second words! bold', 'Last words']);
  });
  test("inline islands do not wrap structural table whitespace or absorb hidden source nodes", () => {
    const source = '<table>\n<tbody>\n<tr>\n<td>A <b>cell</b></td>\n</tr>\n</tbody>\n</table><p>Before<span hidden>Secret</span>After<br>Tail</p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(region => region.text)).toEqual(['A cell', 'Before', 'After', 'Tail']);
    expect(model.previewHtml).toContain('<table data-nautilo-html-source="0">\n<tbody');
    expect(model.previewHtml).toContain('hidden=""');
    const result = applyHtmlRegionText(model, source, model.regions[1].id, 'Changed');
    expect(result).toMatchObject({ ok: true, source: source.replace('Before', 'Changed') });
  });
  test("source markers cannot be spoofed and are attached to region ancestors", () => {
    const source = '<section data-nautilo-html-source="999"><p><b>hello</b></p></section>';
    const model = buildHtmlTextModel(source);
    expect(model.previewHtml).toContain('data-nautilo-html-source="0"');
    expect(model.previewHtml).not.toContain('data-nautilo-html-source="999"');
    expect(model.regions[0].runs[0].inlinePath?.[0].sourceStartOffset).toBe(source.indexOf('<b>'));
  });
});
