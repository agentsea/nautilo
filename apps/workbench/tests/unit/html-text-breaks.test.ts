import { describe, expect, test } from "bun:test";
import { buildHtmlTextModel } from "../../src/editors/html-text-model";
import { insertHtmlTextBreak } from "../../src/editors/html-text-breaks";
const split = (source: string, anchor: number, focus = anchor, soft = false, index = 0) => {
  const model = buildHtmlTextModel(source);
  const result = insertHtmlTextBreak(model, model.regions[index].id, anchor, focus, soft);
  if (!result.ok) throw new Error(result.reason);
  return result;
};
describe("HTML paragraph and line breaks", () => {
  test("splits a sentence without rewriting surrounding bytes", () => {
    const source = '<!--keep--><p class="copy">First. Second. Third.</p><style>p{color:red}</style>';
    const result = split(source, 7);
    expect(result.source).toBe('<!--keep--><p class="copy">First. </p><p class="copy">Second. Third.</p><style>p{color:red}</style>');
    expect(result.regionIndex).toBe(1);
  });
  test("preserves nested inline formatting, links and unique IDs", () => {
    const result = split('<p id="original" class="copy"><b id="bold">One <a href="#note">two three</a></b></p>', 8);
    expect(result.source).toBe('<p id="original" class="copy"><b id="bold">One <a href="#note">two </a></b></p><p  class="copy"><b ><a href="#note">three</a></b></p>');
    expect(result.source.match(/id="original"/g)).toHaveLength(1);
  });
  test("creates editable empty paragraphs at either end and replaces a selection", () => {
    expect(split('<p>Text</p>', 0).source).toBe('<p></p><p>Text</p>');
    expect(split('<p>Text</p>', 4).source).toBe('<p>Text</p><p></p>');
    expect(split('<p></p>', 0).source).toBe('<p></p><p></p>');
    expect(split('<p>A selected Z</p>', 2, 11).source).toBe('<p>A </p><p>Z</p>');
  });
  test("line breaks have editable empty sides and survive repeated breaks", () => {
    for (const offset of [0, 2, 4]) {
      const result = split('<p>Text</p>', offset, offset, true);
      const next = buildHtmlTextModel(result.source);
      expect(next.regions).toHaveLength(2);
      expect(next.regions[result.regionIndex].text).toBe('Text'.slice(offset));
    }
    const first = split('<p>Text</p>', 4, 4, true);
    const second = split(first.source, 0, 0, true, first.regionIndex);
    expect(second.source).toBe('<p>Text<br><br></p>');
    expect(buildHtmlTextModel(second.source).regions.map(r => r.text)).toEqual(['Text', '', '']);
  });
  test("handles omitted paragraph ends, inline islands, headings, lists and cells", () => {
    expect(split('<p>One<p>Two', 1).source).toBe('<p>O</p><p>ne</p><p>Two');
    expect(split('<p>One<br>Two<img src="cover.png"></p>', 1, 1, false, 1).source).toBe('<p>One<br>T</p><p>wo<img src="cover.png"></p>');
    expect(split('<h2>Title more</h2>', 6).source).toBe('<h2>Title </h2><p>more</p>');
    expect(split('<ul><li>One two</li></ul>', 4).source).toBe('<ul><li>One </li><li>two</li></ul>');
    expect(split('<table><tr><td>One two</td></tr></table>', 4).source).toBe('<table><tr><td>One <br>two</td></tr></table>');
  });
  test("handles entities and rejects half-surrogate boundaries", () => {
    expect(split('<p>A &amp; B</p>', 3).source).toBe('<p>A &amp;</p><p> B</p>');
    expect(() => split('<p>😀Text</p>', 1)).toThrow();
  });
  test("new paragraphs after citations or links do not inherit those annotations", () => {
    expect(split('<p>Body<sup><a href="#note">[2]</a></sup></p>', 7).source)
      .toBe('<p>Body<sup><a href="#note">[2]</a></sup></p><p></p>');
    expect(split('<p><b>Body<a href="#note">link</a> tail</b></p>', 8).source)
      .toBe('<p><b>Body<a href="#note">link</a></b></p><p><b> tail</b></p>');
    expect(split('<p><sup>One two</sup></p>', 4).source)
      .toBe('<p><sup>One </sup></p><p><sup>two</sup></p>');
  });
});
