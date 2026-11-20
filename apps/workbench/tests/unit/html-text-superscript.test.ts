import { describe, expect, test } from "bun:test";
import { buildHtmlTextModel } from "../../src/editors/html-text-model";
import { applyHtmlFormatting } from "../../src/editors/html-text-formatting";
import { htmlPageLinkTargets, prepareHtmlPageLinkTarget } from "../../src/editors/html-page-links";
const mark = (source: string, anchor: number, focus: number, enabled: boolean) => {
  const model = buildHtmlTextModel(source);
  const result = applyHtmlFormatting(model, source, { regionId: model.regions[0].id, anchor, focus, action: { kind: "mark", mark: "superscript", enabled } });
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.reason); return result.source;
};
describe("superscript and document links", () => {
  test("adds semantic superscript and does not nest existing superscript", () => {
    expect(mark('<p>Text [4].</p>', 5, 8, true)).toBe('<p>Text <sup>[4]</sup>.</p>');
    expect(mark('<p>Text <sup>[4]</sup>.</p>', 5, 8, true)).toBe('<p>Text <sup>[4]</sup>.</p>');
    expect(mark('<p>A <sup>B</sup> C</p>', 0, 5, true)).toBe('<p><sup>A </sup><sup>B</sup><sup> C</sup></p>');
  });
  test("turns off part of a superscript while retaining links, IDs, and surrounding text", () => {
    const source = '<p><sup id="note" class="citation"><a href="#footnote">[123]</a></sup></p>';
    const result = mark(source, 2, 3, false);
    expect(result).toContain('<sup id="note" class="citation"><a href="#footnote">[1</a></sup>');
    expect(result).toContain('<span  class="citation" style="vertical-align:baseline !important;font-size:inherit !important;"><a href="#footnote">2</a></span>');
    expect(result.match(/id="note"/g)).toHaveLength(1);
    expect(buildHtmlTextModel(result).regions[0].text).toBe('[123]');
  });
  test("offers existing anchors and creates a missing destination without reserializing the page", () => {
    const source = '<!--keep--><h2 class=title>References</h2><p id="note-1">First note</p><p>Second note</p><p hidden>Hidden</p><script>secret()</script>';
    const targets = htmlPageLinkTargets(source);
    expect(targets.map(t => t.label)).toEqual(['References', 'First note', 'Second note']);
    expect(prepareHtmlPageLinkTarget(source, targets[1].offset)).toEqual({ source, href: '#note-1' });
    expect(prepareHtmlPageLinkTarget(source, targets[0].offset)).toEqual({ source: source.replace('<h2 class=title>', '<h2 class=title id="section-references">'), href: '#section-references' });
    expect(() => prepareHtmlPageLinkTarget(source, -1)).toThrow();
    const empty = '<p id="">Empty identifier</p>';
    expect(prepareHtmlPageLinkTarget(empty, 0).source).toBe('<p id="section-empty-identifier">Empty identifier</p>');
  });
  test("handles duplicate headings, ambiguous IDs, legacy named anchors, and Unicode destinations", () => {
    const targets = htmlPageLinkTargets('<h2>Notes</h2><h2>Notes</h2><p id="duplicate">One</p><p id="duplicate">Two</p><a name="legacy"></a><h2>参考</h2>');
    expect(targets.map(t => t.href)).toEqual(['#section-notes', '#section-notes-2', '#legacy', '#section-%E5%8F%82%E8%80%83']);
  });
});
