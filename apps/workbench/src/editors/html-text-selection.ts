import {
  $createRangeSelection, $getRoot, $getSelection, $getNearestNodeFromDOMNode,
  $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode,
  type LexicalEditor, type LexicalNode, type RangeSelection,
} from "@mdxeditor/lexical";

export type HtmlTextSelectionOffsets = { anchor: number; focus: number };
function textLength(node: LexicalNode): number {
  return $isElementNode(node) ? node.getChildren().reduce((sum, child) => sum + textLength(child), 0) : node.getTextContentSize();
}

/** Region-relative UTF-16 offsets, including explicit line breaks and element points. */
export function $htmlTextSelectionOffsets(): HtmlTextSelectionOffsets {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return { anchor: 0, focus: 0 };
  const offset = (point: RangeSelection["anchor"]): number => {
    let total = 0;
    const walk = (node: LexicalNode): boolean => {
      if (node.getKey() === point.key) {
        total += $isElementNode(node)
          ? node.getChildren().slice(0, point.offset).reduce((sum, child) => sum + textLength(child), 0)
          : point.offset;
        return true;
      }
      if ($isElementNode(node)) { for (const child of node.getChildren()) if (walk(child)) return true; }
      else total += textLength(node);
      return false;
    };
    walk($getRoot());
    return total;
  };
  return { anchor: offset(selection.anchor), focus: offset(selection.focus) };
}

/** Build a detached selection suitable for EditorState.clone or $setSelection. */
export function $htmlTextSelectionAtOffsets(anchor: number, focus: number): RangeSelection {
  const current = $getSelection();
  const selection = $isRangeSelection(current) ? current.clone() : $createRangeSelection();
  const set = (point: RangeSelection["anchor"], requested: number) => {
    let remaining = Math.max(0, requested);
    const walk = (node: LexicalNode): boolean => {
      if ($isTextNode(node)) {
        if (remaining <= node.getTextContentSize()) { point.set(node.getKey(), remaining, "text"); return true; }
        remaining -= node.getTextContentSize();
      } else if ($isElementNode(node)) {
        for (const child of node.getChildren()) if (walk(child)) return true;
        if (remaining === 0) { point.set(node.getKey(), node.getChildrenSize(), "element"); return true; }
      } else {
        const length = textLength(node);
        if (remaining <= length) {
          const parent = node.getParentOrThrow();
          point.set(parent.getKey(), node.getIndexWithinParent() + (remaining === 0 ? 0 : 1), "element");
          return true;
        }
        remaining -= length;
      }
      return false;
    };
    if (!walk($getRoot())) {
      const last = $getRoot().getLastDescendant();
      if (last && $isTextNode(last)) point.set(last.getKey(), last.getTextContentSize(), "text");
      else { const root = $getRoot(); point.set(root.getKey(), root.getChildrenSize(), "element"); }
    }
  };
  set(selection.anchor, anchor); set(selection.focus, focus);
  return selection;
}

/** DOM navigation may precede Lexical's selectionchange update; beforeinput is authoritative. */
export function captureHtmlDomSelection(root: HTMLElement, editor: LexicalEditor): HtmlTextSelectionOffsets | null {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  return editor.getEditorState().read(() => {
    const length = (node: Node): number => {
      if (node.nodeType === 3) return node.textContent?.length ?? 0;
      if (node.nodeName === "BR") return $isLineBreakNode($getNearestNodeFromDOMNode(node)) ? 1 : 0;
      return Array.from(node.childNodes).reduce((sum, child) => sum + length(child), 0);
    };
    const offset = (target: Node, at: number): number => {
      let total = 0;
      const walk = (node: Node): boolean => {
        if (node === target) {
          total += node.nodeType === 3 ? at : Array.from(node.childNodes).slice(0, at).reduce((sum, child) => sum + length(child), 0);
          return true;
        }
        if (node.nodeType === 3 || node.nodeName === "BR") total += length(node);
        else for (const child of Array.from(node.childNodes)) if (walk(child)) return true;
        return false;
      };
      walk(root); return total;
    };
    return { anchor: offset(selection.anchorNode!, selection.anchorOffset), focus: offset(selection.focusNode!, selection.focusOffset) };
  });
}
