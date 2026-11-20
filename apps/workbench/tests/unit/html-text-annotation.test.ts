import { describe, expect, test } from "bun:test";
import { buildHtmlTextModel } from "../../src/editors/html-text-model";
import { insertHtmlTextAfterAnnotation } from "../../src/editors/html-text-formatting";

const insert = (source: string, offset: number, text = " more") => {
  const model = buildHtmlTextModel(source);
  return insertHtmlTextAfterAnnotation(model, model.regions[0].id, offset, text);
};
describe("HTML annotation continuations", () => {
  test("inserts escaped text after the citation and its link without changing surrounding source", () => {
    for (const citation of ['<sup><a href="#ref">[2]</a></sup>', '<a href="#ref"><sup>[2]</sup></a>', '<sup><b>[2]</b></sup>']) {
      const source = '<!--keep--><p>Body' + citation + '</p><style>sup{color:red}</style>';
      expect(insert(source, 7, ' A&B <ok>')).toEqual({ ok: true, source: source.replace(citation, citation + ' A&amp;B &lt;ok&gt;'), anchor: 16, focus: 16 });
    }
  });
  test("keeps surrounding formatting, adjacent citations, and subscript content intact", () => {
    const source = '<p><b>Body<sup>[2]</sup></b> tail</p>';
    expect(insert(source, 7)).toMatchObject({ source: '<p><b>Body<sup>[2]</sup> more</b> tail</p>' });
    expect(insert('<p>Body<sup>[2]</sup><sup>[3]</sup></p>', 7)).toMatchObject({ source: '<p>Body<sup>[2]</sup> more<sup>[3]</sup></p>' });
    expect(insert('<p>H<sub>2</sub>O</p>', 2)).toMatchObject({ source: '<p>H<sub>2</sub> moreO</p>' });
    expect(insert('<a href="#ref"><p>Body<sup>[2]</sup></p></a>', 7)).toMatchObject({ source: '<a href="#ref"><p>Body<sup>[2]</sup> more</p></a>' });
  });
  test("does not take over edits inside a citation or ordinary text", () => {
    const source = '<p>Body<sup>[<a href="#ref">2</a>]</sup> tail</p>';
    for (const offset of [-1, 0, 4, 5, 6, 8, 99]) expect(insert(source, offset)).toBeNull();
    expect(insert(source, 7, '')).toBeNull();
    expect(insert('<p>Body<b>bold</b></p>', 8)).toBeNull();
    expect(insert('<p>Body<sup>[2]<i> more</i></sup></p>', 7)).toBeNull();
  });
});
