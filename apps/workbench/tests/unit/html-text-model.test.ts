import { describe, expect, test } from "bun:test";
import { parse } from "parse5";
import { applyHtmlRegionText, applyHtmlRegionTexts, applyHtmlTextEdits, buildHtmlTextModel, deleteHtmlParagraph } from "../../src/editors/html-text-model";

describe("source-preserving HTML text editing", () => {
  test("explicit paragraph deletion removes its exact source, including all inline islands", () => {
    const paragraph = '<p class="copy">First <b>part</b><br>Second<img src="cover.png"><span hidden>Hidden</span></p>';
    const source = '<style>p{color:red}</style><!--before-->' + paragraph + '<!--after--><p>Next</p><script>keep()</script>';
    const model = buildHtmlTextModel(source);
    expect(model.regions[0].paragraph?.wholeRegion).toBe(false);
    for (const region of model.regions.slice(0, 2)) {
      expect(deleteHtmlParagraph(model, source, region.id)).toMatchObject({ ok: true, source: source.replace(paragraph, "") });
    }
  });
  test("paragraph deletion handles omitted closing tags, emptiness and stale selections without removing other structure", () => {
    for (const paragraph of ['<p>First', '<p></p>', '<p><b></b></p>']) {
      const source = paragraph + '<p>Next</p><table><tr><td>Cell</td></tr></table>';
      const model = buildHtmlTextModel(source);
      expect(deleteHtmlParagraph(model, source, model.regions[0].id)).toMatchObject({ ok: true, source: source.slice(paragraph.length) });
      expect(deleteHtmlParagraph(model, source + ' ', model.regions[0].id).ok).toBe(false);
      expect(deleteHtmlParagraph(model, source, model.regions.at(-1)!.id).ok).toBe(false);
    }
    const native = '<script type="application/vnd.nautilo.document+json">{}</script><p>Preview</p>';
    expect(deleteHtmlParagraph(buildHtmlTextModel(native), native, 'guessed').ok).toBe(false);
  });
  test("maps decoded text, inline marks and link destinations to exact source spans", () => {
    const source = '<!doctype html><style>p { color:red }</style><p class="x">Hello <strong>bold &amp; bright</strong> <a href="/go">link</a>.</p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions).toHaveLength(1);
    const region = model.regions[0];
    expect(region.text).toBe("Hello bold & bright link.");
    expect(region.runs.map(r => source.slice(r.startOffset, r.endOffset))).toEqual(["Hello ", "bold &amp; bright", " ", "link", "."]);
    expect(region.runs[1].marks).toEqual(["bold"]);
    expect(region.runs[3].href).toBe("/go");
    expect(model.previewHtml).toContain(`data-nautilo-html-region="${region.id}"`);
  });
  test("patches only changed text nodes and retains all other source bytes", () => {
    const source = '<!DOCTYPE HTML>\r\n<!-- keep -->\r\n<STYLE>.hero{color: red}</STYLE><p CLASS=hero>Fish &amp; chips <b data-x="1">today</b> &#x21;</p><script>doThing()</script>';
    const model = buildHtmlTextModel(source);
    const result = applyHtmlRegionText(model, source, model.regions[0].id, "Fish & chips tomorrow !");
    expect(result).toEqual({ ok: true, source: source.replace("today", "tomorrow"), changedRunIds: [model.regions[0].runs[1].id] });
  });
  test("retains formatting boundaries during multi-run edits and escapes literal markup", () => {
    const source = '<p>Hello <b>bold</b> and <a href="/safe">linked</a> text.</p>';
    const model = buildHtmlTextModel(source);
    const result = applyHtmlRegionText(model, source, model.regions[0].id, "Hello new bold and linked text <script>!");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('<b>bold</b>');
    expect(result.source).toContain('<a href="/safe">linked</a>');
    expect(result.source).toContain('&lt;script&gt;');
    expect(buildHtmlTextModel(result.source).regions[0].text).toBe("Hello new bold and linked text <script>!");
  });
  test("boundary insertions inherit preceding run and replacements inherit first replaced run", () => {
    const source = '<p><b>left</b><i>right</i></p>';
    const model = buildHtmlTextModel(source);
    expect(applyHtmlRegionText(model, source, model.regions[0].id, "left right")).toMatchObject({ source: '<p><b>left </b><i>right</i></p>' });
    expect(applyHtmlRegionText(model, source, model.regions[0].id, "NEW")).toMatchObject({ source: '<p><b>NEW</b><i></i></p>' });
  });
  test("composes region edits from a stable baseline and rejects stale/duplicate/unknown edits", () => {
    const source = '<table class="sheet"><tr><td>A</td><td>B</td></tr></table><p>C</p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.tagName)).toEqual(["td", "td", "p"]);
    const edits = model.regions.map((r, i) => ({ regionId: r.id, text: `${i}` }));
    expect(applyHtmlRegionTexts(model, source, edits)).toMatchObject({ ok: true, source: source.replace(">A<", ">0<").replace(">B<", ">1<").replace(">C<", ">2<") });
    expect(applyHtmlRegionTexts(model, source + " ", edits)).toMatchObject({ ok: false });
    expect(applyHtmlRegionTexts(model, source, [edits[0], edits[0]])).toMatchObject({ ok: false });
    expect(applyHtmlTextEdits(model, source, [{ runId: "guessed", text: "x" }])).toMatchObject({ ok: false });
    expect(applyHtmlRegionTexts(model, source, [])).toEqual({ ok: true, source, changedRunIds: [] });
  });
  test("does not expose scripts, style text, hidden content, forms or active preview attributes", () => {
    const source = '<head><base href="https://example.com"><meta http-equiv="refresh" content="0;url=https://example.com"><style>.x{color:red}</style></head><body><script>bad()</script><p onclick="bad()" data-nautilo-html-region="forged">Visible<a href="java&#x73;cript:bad()"> link</a></p><p hidden>Secret</p><iframe srcdoc="bad"></iframe><object>Bad</object><form action="/post"><input autofocus><p>Form text</p></form></body>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.text)).toEqual(["Visible link", "Form text"]);
    for (const forbidden of ["<script", "onclick", "javascript:", "<iframe", "<object", "<form", "<base", "http-equiv", "autofocus", '="forged"']) expect(model.previewHtml).not.toContain(forbidden);
    expect(model.previewHtml).toContain(`<style data-nautilo-html-source="${source.indexOf("<style>")}">.x{color:red}</style>`);
    expect(model.previewHtml).toContain("disabled");
    expect(applyHtmlRegionTexts(model, source, [])).toMatchObject({ source });
  });
  test("keeps nested block structure and existing breaks outside editable region mounts", () => {
    const source = '<div>Before<p>Paragraph</p>After</div><p>One<br>Two <b>bold</b></p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.text)).toEqual(["Before", "Paragraph", "After", "One", "Two bold"]);
    expect(model.previewHtml).toContain('<div data-nautilo-html-source="0"><span style="all:unset" data-nautilo-html-region=');
    expect(model.previewHtml).toContain(`<br data-nautilo-html-source="${source.indexOf("<br>")}">`);
    expect(applyHtmlRegionText(model, source, model.regions[3].id, "First")).toMatchObject({ source: source.replace("One", "First") });
  });
  test("keeps inline images and other nontext content outside editable mounts", () => {
    const source = '<p>Before<img src="cover.png" width="100">After<svg><text>Graphic label</text></svg>End</p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.text)).toEqual(["Before", "After", "End"]);
    expect(model.previewHtml).toContain('<img src="cover.png" width="100" data-nautilo-html-source="9">');
    expect(model.previewHtml).not.toContain('<p data-nautilo-html-region');
    expect(applyHtmlRegionText(model, source, model.regions[1].id, "Changed")).toMatchObject({ source: source.replace("After", "Changed") });
  });
  test("distributes arbitrary Unicode replacements without losing or duplicating text", () => {
    const source = '<p>A <b>😀bold</b> and <i>漢字</i> Z</p>';
    const model = buildHtmlTextModel(source);
    for (const text of ["", " ", "Entirely new", "A 😀bold and 漢字 Z!", "A 🐈bold and 漢 Z", "<b>literal</b> & 😀", "A  and  Z", "😀😀😀"]) {
      const result = applyHtmlRegionText(model, source, model.regions[0].id, text);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const tree = parse(result.source);
      let actual = "";
      const walk = (node: typeof tree | (typeof tree.childNodes)[number]) => {
        if ("value" in node) actual += node.value;
        if ("childNodes" in node) node.childNodes.forEach(walk);
      };
      walk(tree);
      expect(actual).toBe(text);
      expect(result.source).toContain("<b>"); expect(result.source).toContain("<i>");
    }
  });
  test("keeps script/style and hidden inline content out of text edits", () => {
    const source = '<p>Visible<script>bad()</script><style>.x{color:red}</style><span hidden>Hidden</span> Tail</p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.text)).toEqual(["Visible", " Tail"]);
    expect(model.regions.map(r => r.label)).toEqual(["Paragraph", "Paragraph"]);
    expect(model.previewHtml).toContain(`<style data-nautilo-html-source="${source.indexOf("<style>")}">.x{color:red}</style>`);
    expect(model.previewHtml).toContain(`<span hidden="" data-nautilo-html-source="${source.indexOf('<span hidden>')}">Hidden</span>`);
    expect(model.previewHtml).not.toContain("<script>");
    expect(applyHtmlRegionText(model, source, model.regions[0].id, "Edited")).toMatchObject({ source: source.replace("Visible", "Edited") });
  });
  test("inserts trusted preview policy before authored head content even with head attributes", () => {
    const source = '<html><head lang="en" data-x=">quoted"><meta http-equiv="Content-Security-Policy" content="script-src *"><style>p{color:red}</style></head><body><p>Text</p></body></html>';
    const policy = "default-src 'none'; script-src 'none'";
    const model = buildHtmlTextModel(source, { previewCsp: policy, previewStyle: "[data-nautilo-html-region]{cursor:text}" });
    expect(model.previewHtml).toContain('http-equiv="Content-Security-Policy" content="' + policy + '"');
    expect(model.previewHtml).not.toContain("script-src *");
    expect(model.previewHtml.indexOf(policy)).toBeLessThan(model.previewHtml.indexOf("p{color:red}"));
    expect(model.previewHtml).toContain("[data-nautilo-html-region]{cursor:text}");
    expect(applyHtmlRegionTexts(model, source, [])).toMatchObject({ source });
  });
  test("reopens explicitly empty text blocks for safe zero-width insertion", () => {
    const source = '<h2 class="title"></h2><p><!--keep--></p><table><tr><td data-x="1"></td><th></th></tr></table><ul><li></li></ul>';
    const model = buildHtmlTextModel(source);
    expect(model.regions.map(r => r.tagName)).toEqual(["h2", "p", "td", "th", "li"]);
    expect(model.regions.every(r => r.text === "" && r.runs.length === 1 && r.runs[0].startOffset === r.runs[0].endOffset)).toBe(true);
    const result = applyHtmlRegionTexts(model, source, model.regions.map(r => ({ regionId: r.id, text: "New & <text>" })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('<h2 class="title">New &amp; &lt;text&gt;</h2><p>New &amp; &lt;text&gt;<!--keep--></p><table><tr><td data-x="1">New &amp; &lt;text&gt;</td><th>New &amp; &lt;text&gt;</th></tr></table><ul><li>New &amp; &lt;text&gt;</li></ul>');
    expect(applyHtmlRegionTexts(model, source, model.regions.map(r => ({ regionId: r.id, text: "" })))).toEqual({ ok: true, source, changedRunIds: [] });
    const original = '<p class="copy">Delete me</p>';
    const originalModel = buildHtmlTextModel(original);
    const cleared = applyHtmlRegionText(originalModel, original, originalModel.regions[0].id, "");
    if (!cleared.ok) throw new Error(cleared.reason);
    const reopened = buildHtmlTextModel(cleared.source);
    expect(applyHtmlRegionText(reopened, cleared.source, reopened.regions[0].id, "Restored")).toMatchObject({ source: '<p class="copy">Restored</p>' });
  });
  test("does not invent empty ranges for implicit, recovered or nontext containers", () => {
    for (const source of ['<p>', '<p><p>', '<table><tr><td>', '<div></div>', '<p><img src="image.png"></p>']) {
      expect(buildHtmlTextModel(source).regions).toEqual([]);
    }
  });
  test("reopens emptied inline formatting and whitespace-only paragraphs without dropping wrappers", () => {
    for (const source of ['<p><b></b></p>', '<p><a class="guide" href="/x"><span style="color:red"></span></a></p>', '<p>  </p>']) {
      const model = buildHtmlTextModel(source);
      expect(model.regions).toHaveLength(1);
      const region = model.regions[0];
      const result = applyHtmlRegionText(model, source, region.id, "Restored");
      if (!result.ok) throw new Error(result.reason);
      expect(buildHtmlTextModel(result.source).regions[0].text).toBe("Restored");
      expect(result.source.replace("Restored", region.text)).toBe(source);
    }
    const source = '<p><span class="outer"><em data-kind="label">Text</em></span> <a href="/x" onclick="bad()">Link</a></p>';
    const model = buildHtmlTextModel(source);
    expect(model.regions[0].runs[0].inlinePath?.map(inline => inline.tagName)).toEqual(["span", "em"]);
    expect(model.regions[0].runs[0].inlinePath?.[0].attributes).toEqual({ class: "outer", "data-nautilo-html-source": String(source.indexOf("<span")) });
    expect(model.regions[0].runs.at(-1)?.inlinePath?.[0].attributes).toEqual({ href: "/x", "data-nautilo-html-source": String(source.indexOf("<a ")) });
  });
  test("blocks native Nautilo document manifests without touching their canonical payload", () => {
    const source = '<script id="manifest" type="application/vnd.nautilo.document+json">{"editor":"writer"}</script><p>Preview only</p>';
    const model = buildHtmlTextModel(source);
    expect(model.blockedReason).toContain("owning editor"); expect(model.regions).toEqual([]);
    expect(applyHtmlRegionTexts(model, source, [])).toMatchObject({ ok: false });
  });
  test("handles recovered HTML, entities, emoji and no-op edits without reserialization", () => {
    for (const source of ['<p>A &copy; 😀<p>B', '<table>before<tr><td>Cell &lt;x&gt;</table>after', '<p>line\r\nbreak &#38; entity</p>']) {
      const model = buildHtmlTextModel(source);
      expect(applyHtmlRegionTexts(model, source, model.regions.map(r => ({ regionId: r.id, text: r.text })))).toEqual({ ok: true, source, changedRunIds: [] });
      expect(parse(model.previewHtml)).toBeDefined();
    }
  });
});
