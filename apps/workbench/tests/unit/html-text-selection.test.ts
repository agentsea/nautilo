import { describe, expect, test } from "bun:test";
import { createEditor, $createParagraphNode, $createTextNode, $createLineBreakNode, $getRoot, $getSelection, $isRangeSelection, $setSelection } from "@mdxeditor/lexical";
import { $htmlTextSelectionAtOffsets, $htmlTextSelectionOffsets } from "../../src/editors/html-text-selection";

describe("HTML history selection coordinates", () => {
  test("counts Unicode text, element child indexes and explicit line breaks", () => {
    const editor = createEditor({ onError: error => { throw error; } });
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode("A😀"), $createLineBreakNode(), $createTextNode("tail"));
      $getRoot().append(paragraph);
      paragraph.select(2, 2);
      expect($htmlTextSelectionOffsets()).toEqual({ anchor: 4, focus: 4 });
      $setSelection($htmlTextSelectionAtOffsets(4, 8));
      expect($htmlTextSelectionOffsets()).toEqual({ anchor: 4, focus: 8 });
      for (const offset of [0, 1, 3, 4, 5, 8]) {
        $setSelection($htmlTextSelectionAtOffsets(offset, offset));
        expect($htmlTextSelectionOffsets()).toEqual({ anchor: offset, focus: offset });
      }
    }, { discrete: true });
  });
  test("restores captured offsets instead of a stale saved caret, including reversed selection", () => {
    const editor = createEditor({ onError: error => { throw error; } });
    editor.update(() => { const paragraph = $createParagraphNode().append($createTextNode("long text 😀 end")); $getRoot().append(paragraph); paragraph.selectStart(); }, { discrete: true });
    const state = editor.getEditorState();
    const selection = state.read(() => $htmlTextSelectionAtOffsets(16, 5));
    const restored = state.clone(selection);
    restored.read(() => {
      expect($htmlTextSelectionOffsets()).toEqual({ anchor: 16, focus: 5 });
      const current = $getSelection();
      expect($isRangeSelection(current) && current.isBackward()).toBe(true);
    });
    state.read(() => expect($htmlTextSelectionOffsets()).toEqual({ anchor: 0, focus: 0 }));
  });
});
