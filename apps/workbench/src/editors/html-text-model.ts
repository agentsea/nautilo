import { parse, serialize, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import { diffChars } from "diff";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlText = DefaultTreeAdapterMap["textNode"];
export type HtmlTextMark = "bold" | "italic" | "underline" | "strikethrough" | "code" | "subscript" | "superscript";
export type HtmlTextRun = {
  id: string;
  text: string;
  /** Exact UTF-16 source range of this original text node, including entities. */
  startOffset: number;
  endOffset: number;
  marks: HtmlTextMark[];
  href?: string;
};
export type HtmlTextRegion = { id: string; tagName: string; label: string; text: string; runs: HtmlTextRun[] };
export type HtmlTextModel = { source: string; regions: HtmlTextRegion[]; previewHtml: string; blockedReason?: string };
export type HtmlTextEditResult = { ok: true; source: string; changedRunIds: string[] } | { ok: false; reason: string };

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml" as HtmlElement["namespaceURI"];
const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "caption", "figcaption", "pre", "blockquote", "address", "div", "section", "article", "main", "aside", "header", "footer", "body", "dt", "dd"]);
const OMIT_TEXT = new Set(["head", "script", "style", "template", "noscript", "iframe", "object", "embed", "textarea", "select", "button", "input", "svg", "math", "xmp", "plaintext", "noembed", "noframes"]);
const EMPTY_TEXT_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "li", "caption", "figcaption", "dt", "dd", "pre", "blockquote", "address"]);
const INLINE_BOUNDARIES = new Set(["br", "hr", "img", "picture", "video", "audio", "canvas"]);
const REMOVE_PREVIEW = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "template", "noscript"]);
const LABELS: Partial<Record<string, string>> = { p: "Paragraph", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", li: "List item", td: "Table cell", th: "Table heading", caption: "Table caption", figcaption: "Caption", pre: "Preformatted text", blockquote: "Quotation", address: "Address", dt: "Term", dd: "Definition" };
const MARKS: Partial<Record<string, HtmlTextMark>> = { b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline", s: "strikethrough", strike: "strikethrough", del: "strikethrough", code: "code", sub: "subscript", sup: "superscript" };
const element = (node: HtmlNode): node is HtmlElement => "tagName" in node;
const textNode = (node: HtmlNode): node is HtmlText => node.nodeName === "#text";
const attr = (node: HtmlElement, name: string) => node.attrs.find(a => a.name === name)?.value;
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Build editable text descriptors from parser-owned source locations. The AST
 * is serialized ONLY for the inert preview; saved HTML always comes from source
 * patches. CSS visibility is intentionally not guessed by this source model.
 */
export function buildHtmlTextModel(source: string, options: { previewCsp?: string; previewStyle?: string } = {}): HtmlTextModel {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const regions: HtmlTextRegion[] = [];
  const targets = new Map<string, HtmlElement | HtmlText>();
  const grouped = new Map<HtmlElement, HtmlTextRegion>();
  const splitContainers = new WeakMap<HtmlElement, boolean>();
  let nativeDocument = false;
  const inspect = (node: HtmlNode) => {
    if (element(node) && node.tagName === "script" && attr(node, "type")?.trim().toLowerCase() === "application/vnd.nautilo.document+json") nativeDocument = true;
    if ("childNodes" in node) node.childNodes.forEach(inspect);
  };
  inspect(tree);
  const needsSplit = (node: HtmlElement): boolean => {
    const known = splitContainers.get(node);
    if (known !== undefined) return known;
    const descendants = [...node.childNodes];
    let split = false;
    while (descendants.length) {
      const child = descendants.pop()!;
      if (!element(child)) continue;
      if (INLINE_BOUNDARIES.has(child.tagName) || OMIT_TEXT.has(child.tagName) || BLOCK_TAGS.has(child.tagName)) { split = true; break; }
      descendants.push(...child.childNodes);
    }
    splitContainers.set(node, split);
    return split;
  };
  const visit = (node: HtmlNode, ancestors: HtmlElement[]) => {
    if (element(node)) {
      if (OMIT_TEXT.has(node.tagName) || node.namespaceURI !== HTML_NAMESPACE || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true") return;
      const location = node.sourceCodeLocation;
      if (!nativeDocument && EMPTY_TEXT_BLOCKS.has(node.tagName) &&
        !node.childNodes.some(child => element(child) || textNode(child)) &&
        location?.startTag && location.endTag && location.startTag.endOffset <= location.endTag.startOffset) {
        // An explicit empty leaf has no text token. Its start-tag boundary is
        // the only permitted insertion point; never infer recovered DOM spans.
        const offset = location.startTag.endOffset;
        const run: HtmlTextRun = { id: `html-run-${offset}-${offset}`, text: "", startOffset: offset, endOffset: offset,
          marks: [...new Set([...ancestors, node].flatMap(a => MARKS[a.tagName] ? [MARKS[a.tagName]!] : []))] };
        const region: HtmlTextRegion = { id: `html-region-${offset}`, tagName: node.tagName, label: LABELS[node.tagName] ?? "Text", text: "", runs: [run] };
        regions.push(region); targets.set(region.id, node); grouped.set(node, region);
      }
      node.childNodes.forEach(child => visit(child, [...ancestors, node]));
      return;
    }
    if (!textNode(node)) { if ("childNodes" in node) node.childNodes.forEach(child => visit(child, ancestors)); return; }
    const location = node.sourceCodeLocation;
    if (!location || !node.value.trim() || nativeDocument) return;
    const parent = [...ancestors].reverse().find(a => BLOCK_TAGS.has(a.tagName));
    const target = parent && !needsSplit(parent) ? parent : node;
    let region = element(target) ? grouped.get(target) : undefined;
    if (!region) {
      const tagName = parent?.tagName ?? "text";
      region = { id: `html-region-${location.startOffset}`, tagName, label: LABELS[tagName] ?? "Text", text: "", runs: [] };
      regions.push(region); targets.set(region.id, target);
      if (element(target)) grouped.set(target, region);
    }
    const marks = [...new Set(ancestors.flatMap(a => MARKS[a.tagName] ? [MARKS[a.tagName]!] : []))];
    const href = [...ancestors].reverse().find(a => a.tagName === "a")?.attrs.find(a => a.name === "href")?.value;
    const run: HtmlTextRun = { id: `html-run-${location.startOffset}-${location.endOffset}`, text: node.value, startOffset: location.startOffset, endOffset: location.endOffset, marks, ...(href !== undefined ? { href } : {}) };
    region.runs.push(run); region.text += run.text;
  };
  visit(tree, []);
  // Include whitespace-only nodes inside an otherwise editable leaf block. They
  // are significant between inline spans and must participate in the text diff.
  for (const [container, region] of grouped) {
    const collect = (node: HtmlNode, ancestors: HtmlElement[]) => {
      if (element(node)) {
        if (OMIT_TEXT.has(node.tagName) || node.namespaceURI !== HTML_NAMESPACE || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true") return;
        node.childNodes.forEach(child => collect(child, [...ancestors, node]));
      } else if (textNode(node) && !node.value.trim() && node.sourceCodeLocation) {
        const { startOffset, endOffset } = node.sourceCodeLocation;
        const run: HtmlTextRun = { id: `html-run-${startOffset}-${endOffset}`, text: node.value, startOffset, endOffset, marks: [...new Set(ancestors.flatMap(a => MARKS[a.tagName] ? [MARKS[a.tagName]!] : []))] };
        region.runs.push(run);
      }
    };
    collect(container, []);
    region.runs.sort((a, b) => a.startOffset - b.startOffset);
    region.text = region.runs.map(r => r.text).join("");
  }
  const orderedRuns = regions.flatMap(r => r.runs).sort((a, b) => a.startOffset - b.startOffset);
  const ambiguous = orderedRuns.some((run, i) => i > 0 && orderedRuns[i - 1].endOffset > run.startOffset);
  const blockedReason = nativeDocument ? "This document belongs to a Nautilo app. Open it in its owning editor to keep its document data intact."
    : ambiguous ? "This HTML has overlapping recovered text locations. Use Source to edit it without guessing which bytes to replace." : undefined;
  if (blockedReason) regions.length = 0;
  // Preview markers are authored by us, never accepted from the input HTML.
  const sanitize = (node: HtmlNode) => {
    if (!("childNodes" in node)) return;
    const children: DefaultTreeAdapterMap["childNode"][] = [];
    for (const child of node.childNodes) {
      if (element(child)) {
        if (REMOVE_PREVIEW.has(child.tagName) || (child.tagName === "meta" && attr(child, "http-equiv"))) continue;
        child.attrs = child.attrs.filter(a => !a.name.toLowerCase().startsWith("on") && !a.name.startsWith("data-nautilo-html-") && !["srcdoc", "autofocus", "contenteditable", "tabindex", "draggable", "action", "formaction", "form", "target", "download"].includes(a.name));
        child.attrs = child.attrs.filter(a => {
          if (!["href", "src", "xlink:href"].includes(a.name)) return true;
          const value = [...a.value].filter(char => char.charCodeAt(0) > 32).join("").toLowerCase();
          return !value.startsWith("javascript:") && !value.startsWith("vbscript:") && (!value.startsWith("data:") || (a.name === "src" && value.startsWith("data:image/") && !value.startsWith("data:image/svg")));
        });
        if (["input", "button", "select", "textarea"].includes(child.tagName)) child.attrs.push({ name: "disabled", value: "" });
        sanitize(child);
        if (child.tagName === "form") {
          child.childNodes.forEach(grandchild => { grandchild.parentNode = node; children.push(grandchild); });
          continue;
        }
      }
      children.push(child);
    }
    node.childNodes = children;
  };
  sanitize(tree);
  if (!blockedReason) for (const region of regions) {
    const target = targets.get(region.id)!;
    if (element(target)) target.attrs.push({ name: "data-nautilo-html-region", value: region.id });
    else if (target.parentNode) {
      const parent = target.parentNode;
      const wrapper: HtmlElement = { nodeName: "span", tagName: "span", namespaceURI: HTML_NAMESPACE, attrs: [{ name: "data-nautilo-html-region", value: region.id }], childNodes: [target], parentNode: parent };
      const index = parent.childNodes.indexOf(target);
      if (index >= 0) { parent.childNodes[index] = wrapper; target.parentNode = wrapper; }
    }
  }
  // These options are trusted parent-owned policy/style, never document fields.
  // Insert through the parsed head so authored attributes cannot bypass policy.
  const html = tree.childNodes.find((node): node is HtmlElement => element(node) && node.tagName === "html");
  const head = html?.childNodes.find((node): node is HtmlElement => element(node) && node.tagName === "head");
  if (head) {
    const trusted: HtmlElement[] = [];
    if (options.previewCsp !== undefined) trusted.push(defaultTreeAdapter.createElement("meta", HTML_NAMESPACE,
      [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: options.previewCsp }]));
    if (options.previewStyle !== undefined) {
      const style = defaultTreeAdapter.createElement("style", HTML_NAMESPACE, []);
      defaultTreeAdapter.insertText(style, options.previewStyle);
      trusted.push(style);
    }
    trusted.forEach(node => { node.parentNode = head; });
    head.childNodes.unshift(...trusted);
  }
  return { source, regions, previewHtml: serialize(tree), ...(blockedReason ? { blockedReason } : {}) };
}

/** Patch original text nodes; do not parse/serialize the entire document on save. */
export function applyHtmlTextEdits(model: HtmlTextModel, currentSource: string, edits: readonly { runId: string; text: string }[]): HtmlTextEditResult {
  if (model.source !== currentSource) return { ok: false, reason: "The HTML changed while this text was being edited. Reopen the text region against the current source." };
  if (model.blockedReason) return { ok: false, reason: model.blockedReason };
  const runs = new Map(model.regions.flatMap(region => region.runs).map(run => [run.id, run]));
  const seen = new Set<string>();
  const patches: Array<{ start: number; end: number; text: string; id: string }> = [];
  for (const edit of edits) {
    const run = runs.get(edit.runId);
    if (!run || seen.has(edit.runId) || typeof edit.text !== "string") return { ok: false, reason: "The text edit does not identify one current HTML text range." };
    seen.add(edit.runId);
    if (edit.text !== run.text) patches.push({ start: run.startOffset, end: run.endOffset, text: escapeText(edit.text), id: run.id });
  }
  patches.sort((a, b) => b.start - a.start);
  let source = currentSource;
  for (const patch of patches) source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  return { ok: true, source, changedRunIds: patches.map(p => p.id) };
}

/**
 * Keep inline element boundaries while editing one paragraph as plain text.
 * Insertions at a run boundary inherit the preceding run (at start, the first).
 * Deleted text may leave empty inline elements; removing markup is not text editing.
 */
function regionRunEdits(region: HtmlTextRegion, newText: string): Array<{ runId: string; text: string }> {
  const values = region.runs.map(() => "");
  let oldOffset = 0;
  let replacementStart: number | undefined;
  const starts: number[] = []; let length = 0;
  for (const run of region.runs) { starts.push(length); length += run.text.length; }
  const owner = (position: number, insertion: boolean): number => {
    for (let i = 0; i < region.runs.length; i++) {
      const end = starts[i] + region.runs[i].text.length;
      if (position < end || (insertion && position === end)) return i;
    }
    return region.runs.length - 1;
  };
  for (const change of diffChars(region.text, newText)) {
    if (change.added) {
      values[owner(replacementStart ?? oldOffset, replacementStart === undefined)] += change.value;
      replacementStart = undefined;
      continue;
    }
    if (change.removed) { replacementStart ??= oldOffset; oldOffset += change.value.length; continue; }
    replacementStart = undefined;
    let remaining = change.value.length;
    while (remaining > 0) {
      const index = owner(oldOffset, false);
      const count = Math.min(remaining, starts[index] + region.runs[index].text.length - oldOffset);
      values[index] += region.text.slice(oldOffset, oldOffset + count);
      remaining -= count; oldOffset += count;
    }
  }
  return region.runs.map((run, i) => ({ runId: run.id, text: values[i] }));
}

/** Apply all desired region texts to one immutable editing-session baseline. */
export function applyHtmlRegionTexts(model: HtmlTextModel, currentSource: string, edits: readonly { regionId: string; text: string }[]): HtmlTextEditResult {
  const seen = new Set<string>();
  const runs: Array<{ runId: string; text: string }> = [];
  for (const edit of edits) {
    const region = model.regions.find(r => r.id === edit.regionId);
    if (!region || seen.has(edit.regionId)) return { ok: false, reason: "This text region is no longer available or was edited twice. Reopen it from the current preview." };
    if (typeof edit.text !== "string") return { ok: false, reason: "Replacement text must be a string." };
    seen.add(edit.regionId);
    runs.push(...regionRunEdits(region, edit.text));
  }
  return applyHtmlTextEdits(model, currentSource, runs);
}

export function applyHtmlRegionText(model: HtmlTextModel, currentSource: string, regionId: string, newText: string): HtmlTextEditResult {
  return applyHtmlRegionTexts(model, currentSource, [{ regionId, text: newText }]);
}
