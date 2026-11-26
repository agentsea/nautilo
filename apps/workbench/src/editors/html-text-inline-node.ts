import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, $isLineBreakNode, ElementNode, type LexicalNode, type EditorConfig, type LexicalEditor, type NodeKey, type SerializedElementNode, type Spread } from "@mdxeditor/lexical";
import { projectHtmlRegionRuns, type HtmlTextInline, type HtmlTextRegion, type HtmlTextRun } from "./html-text-model";

type SerializedHtmlInline = Spread<{ type: "html-source-inline"; descriptor: HtmlTextInline; appearance: string }, SerializedElementNode>;

/** Original inert inline wrappers survive Lexical reconciliation and history. */
export class HtmlSourceInlineNode extends ElementNode {
  __descriptor: HtmlTextInline;
  __appearance: string;
  static getType(): string { return "html-source-inline"; }
  static clone(node: HtmlSourceInlineNode): HtmlSourceInlineNode {
    return new HtmlSourceInlineNode(node.__descriptor, node.__appearance, node.__key);
  }
  constructor(descriptor: HtmlTextInline = { id: "", tagName: "span", attributes: {} }, appearance = "", key?: NodeKey) {
    super(key);
    this.__descriptor = descriptor;
    this.__appearance = appearance;
  }
  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    // Use the inert frame's registry, never the host application's registered
    // custom elements, when constructing an authored inline tag.
    const owner = editor.getRootElement()?.ownerDocument;
    if (!owner) throw new Error("HTML text nodes require their editing frame.");
    const dom = owner.createElement(this.__descriptor.tagName);
    for (const [name, value] of Object.entries(this.__descriptor.attributes)) dom.setAttribute(name, value);
    // CSS selectors that cross Lexical's mandatory paragraph wrapper no longer
    // match. Mirror inline paint/typography while keeping original classes and
    // nesting; do not freeze measured width/height, positions or transforms.
    dom.style.cssText += this.__appearance;
    return dom;
  }
  updateDOM(previous: HtmlSourceInlineNode): boolean {
    return previous.__descriptor !== this.__descriptor || previous.__appearance !== this.__appearance;
  }
  isInline(): boolean { return true; }
  canBeEmpty(): boolean { return true; }
  exportJSON(): SerializedHtmlInline {
    return { ...super.exportJSON(), type: "html-source-inline", descriptor: this.__descriptor, appearance: this.__appearance, version: 1 };
  }
  static importJSON(serialized: SerializedHtmlInline): HtmlSourceInlineNode {
    return new HtmlSourceInlineNode(serialized.descriptor, serialized.appearance).updateFromJSON(serialized);
  }
}


/** Only properties whose computed values do not freeze a text run's geometry. */
export function inlineAppearance(style: CSSStyleDeclaration, options: { includeResourceUrls?: boolean } = {}): string {
  const names = ["color", "font-family", "font-size", "font-style", "font-weight", "font-stretch", "font-variant", "font-kerning", "font-feature-settings", "font-variation-settings", "line-height", "letter-spacing", "word-spacing", "text-transform", "text-decoration-line", "text-decoration-style", "text-decoration-color", "text-decoration-thickness", "text-shadow", "vertical-align", "white-space", "background-color", "background-image", "background-size", "background-position", "background-repeat", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "box-shadow", "opacity", "display"];
  // Computed image URLs are resolved against this preview's origin. Mirror
  // them in the live preview, but never bake that runtime address into source.
  return names.filter(name => options.includeResourceUrls !== false || name !== "background-image")
    .map(name => `${name}:${style.getPropertyValue(name)};`).join("");
}


type RunSignature = { path: string[]; text: string };
function appendSignature(runs: RunSignature[], path: string[], text: string): void {
  if (!text) return;
  const previous = runs.at(-1);
  if (previous && JSON.stringify(previous.path) === JSON.stringify(path)) previous.text += text;
  else runs.push({ path, text });
}

/** Construct the same inert inline tree regardless of how Lexical split text leaves. */
export function $appendHtmlRegionRuns(parent: ElementNode, runs: HtmlTextRun[], appearances: ReadonlyMap<string, string>): void {
  const inlineNodes = new Map<string, HtmlSourceInlineNode>();
  for (const run of runs) {
    let container = parent;
    for (const inline of run.inlinePath ?? []) {
      let wrapper = inlineNodes.get(inline.id);
      if (!wrapper) {
        wrapper = new HtmlSourceInlineNode(inline, appearances.get(inline.id) ?? "");
        container.append(wrapper); inlineNodes.set(inline.id, wrapper);
      }
      container = wrapper;
    }
    container.append($createTextNode(run.text).setStyle("all:unset;display:contents"));
  }
}

/**
 * Whole-region replacement can remove wrappers even when the source patch keeps
 * them. Normalize before commit/history, only when its tree differs from the
 * deterministic source projection. Equivalent adjacent leaves are coalesced.
 */
export function $reconcileHtmlRegion(region: HtmlTextRegion, appearances: ReadonlyMap<string, string>): boolean {
  const root = $getRoot();
  const projected = projectHtmlRegionRuns(region, root.getTextContent());
  const expectedWrappers: string[] = [], expectedRuns: RunSignature[] = [];
  const seen = new Set<string>();
  for (const run of projected) {
    const path = (run.inlinePath ?? []).map(inline => inline.id);
    for (const id of path) if (!seen.has(id)) { seen.add(id); expectedWrappers.push(id); }
    appendSignature(expectedRuns, path, run.text);
  }
  const actualWrappers: string[] = [], actualRuns: RunSignature[] = [];
  const visit = (node: LexicalNode, path: string[]) => {
    if (node instanceof HtmlSourceInlineNode) {
      const id = node.getLatest().__descriptor.id;
      actualWrappers.push(id); path = [...path, id];
    }
    if ($isTextNode(node) || $isLineBreakNode(node)) appendSignature(actualRuns, path, node.getTextContent());
    else if ($isElementNode(node)) node.getChildren().forEach(child => visit(child, path));
  };
  visit(root, []);
  if (root.getChildrenSize() === 1 && JSON.stringify([expectedWrappers, expectedRuns]) === JSON.stringify([actualWrappers, actualRuns])) return false;
  const paragraph = $createParagraphNode();
  $appendHtmlRegionRuns(paragraph, projected, appearances);
  root.clear().append(paragraph);
  return true;
}
