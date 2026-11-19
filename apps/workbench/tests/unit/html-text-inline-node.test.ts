import { describe, expect, test } from "bun:test";
import { createEditor, TextNode, ParagraphNode, $createParagraphNode, $createTextNode, $getRoot, $setSelection, $getSelection, $isRangeSelection, $isElementNode } from "@mdxeditor/lexical";
import { buildHtmlTextModel, applyHtmlRegionText } from "../../src/editors/html-text-model";
import { HtmlSourceInlineNode, $appendHtmlRegionRuns, $reconcileHtmlRegion } from "../../src/editors/html-text-inline-node";
import { $htmlTextSelectionAtOffsets, $htmlTextSelectionOffsets } from "../../src/editors/html-text-selection";

describe("canonical inline rendering during edits", () => {
  test("whole-region replacement preserves original wrappers in committed history states", () => {
    const source = '<p>Hello <strong class="bold">bold</strong> and <a href="/guide">linked</a> text.</p>';
    const region = buildHtmlTextModel(source).regions[0];
    const editor = createEditor({ nodes: [HtmlSourceInlineNode], onError: error => { throw error; } });
    editor.update(() => { const p = $createParagraphNode(); $appendHtmlRegionRuns(p, region.runs, new Map()); $getRoot().append(p); }, { discrete: true });
    const normalize = () => { const selection = $htmlTextSelectionOffsets(); if ($reconcileHtmlRegion(region, new Map())) $setSelection($htmlTextSelectionAtOffsets(selection.anchor, selection.focus)); };
    const stopText = editor.registerNodeTransform(TextNode, normalize), stopParagraph = editor.registerNodeTransform(ParagraphNode, normalize);
    const before = editor.getEditorState();
    const expected = region.text + " Final review complete.";
    editor.update(() => {
      $setSelection($htmlTextSelectionAtOffsets(0, region.text.length));
      const selection = $getSelection(); if (!$isRangeSelection(selection)) throw new Error("Expected selection");
      selection.insertText(expected);
    }, { discrete: true });
    const after = editor.getEditorState();
    const inspect = () => {
      const tags: string[] = [];
      const walk = (node: ReturnType<typeof $getRoot> | HtmlSourceInlineNode) => { for (const child of node.getChildren()) { if (child instanceof HtmlSourceInlineNode) tags.push(child.__descriptor.tagName); if ($isElementNode(child)) walk(child as HtmlSourceInlineNode); } };
      walk($getRoot()); return { text: $getRoot().getTextContent(), tags, selection: $htmlTextSelectionOffsets() };
    };
    after.read(() => expect(inspect()).toEqual({ text: expected, tags: ["strong", "a"], selection: { anchor: expected.length, focus: expected.length } }));
    editor.setEditorState(before); editor.getEditorState().read(() => expect(inspect().tags).toEqual(["strong", "a"]));
    editor.setEditorState(after); editor.getEditorState().read(() => expect(inspect().text).toBe(expected));
    expect(applyHtmlRegionText({ ...buildHtmlTextModel(source) }, source, region.id, expected)).toMatchObject({ source: source.replace(" text.</p>", " text. Final review complete.</p>") });
    stopText(); stopParagraph();
  });
  test("equivalent merged leaves and empty wrappers do not create a transform loop", () => {
    const region = buildHtmlTextModel('<p><span class="x">one<!--keep-->two</span><b></b></p>').regions[0];
    const editor = createEditor({ nodes: [HtmlSourceInlineNode], onError: error => { throw error; } });
    editor.update(() => {
      const p = $createParagraphNode(); $appendHtmlRegionRuns(p, region.runs, new Map()); $getRoot().append(p);
      expect($reconcileHtmlRegion(region, new Map())).toBe(false);
      $getRoot().clear().append($createParagraphNode().append($createTextNode("")));
      expect($reconcileHtmlRegion(region, new Map())).toBe(true);
      expect($reconcileHtmlRegion(region, new Map())).toBe(false);
    }, { discrete: true });
  });
});
