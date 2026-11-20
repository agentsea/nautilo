import { parse, serialize, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import { diffChars } from "diff";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlText = DefaultTreeAdapterMap["textNode"];
export type HtmlTextMark = "bold" | "italic" | "underline" | "strikethrough" | "code" | "subscript" | "superscript";
export type HtmlTextInline = { id: string; tagName: string; attributes: Record<string, string>; sourceStartOffset?: number };
export type HtmlTextRun = {
  id: string;
  text: string;
  /** Exact UTF-16 source range of this original text node, including entities. */
  startOffset: number;
  endOffset: number;
  marks: HtmlTextMark[];
  href?: string;
  /** Sanitized original wrappers, outermost first, relative to the region. */
  inlinePath?: HtmlTextInline[];
};
export type HtmlTextRegion = { id: string; tagName: string; label: string; text: string; runs: HtmlTextRun[];
  paragraph?: { startOffset: number; endOffset: number; wholeRegion: boolean } };
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
  const runNodes = new Map<string, HtmlText>();
  const grouped = new Map<HtmlElement, HtmlTextRegion>();
  const splitContainers = new WeakMap<HtmlElement, boolean>();
  let nativeDocument = false;
  const inspect = (node: HtmlNode) => {
    if (element(node) && node.tagName === "script" && attr(node, "type")?.trim().toLowerCase() === "application/vnd.nautilo.document+json") nativeDocument = true;
    if ("childNodes" in node) node.childNodes.forEach(inspect);
  };
  inspect(tree);
  // A structural boundary divides editable inline islands, not every text
  // token. Keep contiguous text/formatting siblings in one inert preview span
  // so adding a mark never turns one text area into several unrelated areas.
  // These wrappers have no source locations and never enter saved HTML.
  const islands = new WeakSet<HtmlElement>();
  const barriers = new WeakSet<HtmlElement>();
  const safeInline = (node: HtmlNode): boolean => {
    if (!element(node)) return true;
    if (BLOCK_TAGS.has(node.tagName) || INLINE_BOUNDARIES.has(node.tagName) || OMIT_TEXT.has(node.tagName) ||
      node.namespaceURI !== HTML_NAMESPACE || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true") return false;
    return node.childNodes.every(safeInline);
  };
  const groupIslands = (node: HtmlNode) => {
    if (!("childNodes" in node)) return;
    if (element(node) && (OMIT_TEXT.has(node.tagName) || node.namespaceURI !== HTML_NAMESPACE ||
      attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true")) return;
    node.childNodes.forEach(groupIslands);
    if (!element(node) || !node.childNodes.some(child => !safeInline(child))) return;
    barriers.add(node);
    const children: DefaultTreeAdapterMap["childNode"][] = [];
    let group: DefaultTreeAdapterMap["childNode"][] = [];
    const flush = () => {
      if (!group.length) return;
      const hasText = (child: HtmlNode): boolean => textNode(child) ? !!child.value.trim() : "childNodes" in child && child.childNodes.some(hasText);
      if (!group.some(hasText)) { children.push(...group); group = []; return; }
      const span = defaultTreeAdapter.createElement("span", HTML_NAMESPACE, [{ name: "style", value: "all:unset" }]);
      span.parentNode = node; islands.add(span);
      for (const child of group) defaultTreeAdapter.appendChild(span, child);
      children.push(span); group = [];
    };
    for (const child of node.childNodes) {
      if (safeInline(child)) group.push(child);
      else { flush(); children.push(child); }
    }
    flush(); node.childNodes = children;
  };
  groupIslands(tree);
  const needsSplit = (node: HtmlElement): boolean => {
    const known = splitContainers.get(node);
    if (known !== undefined) return known;
    const descendants = [...node.childNodes];
    let split = barriers.has(node);
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
    const island = [...ancestors].reverse().find(ancestor => islands.has(ancestor));
    const target = island ?? (parent && !needsSplit(parent) ? parent : node);
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
    region.runs.push(run); region.text += run.text; runNodes.set(run.id, node);
  };
  visit(tree, []);
  // Deleting a formatted paragraph leaves its inline elements intact. Keep an
  // editing target after reopen, including whitespace-only leaves, without
  // inventing source coordinates for implicit/recovered block boundaries.
  const visitBlank = (node: HtmlNode, ancestors: HtmlElement[]) => {
    if (element(node)) {
      if (OMIT_TEXT.has(node.tagName) || node.namespaceURI !== HTML_NAMESPACE || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true") return;
      if (!nativeDocument && EMPTY_TEXT_BLOCKS.has(node.tagName) && !grouped.has(node) && !needsSplit(node) &&
        node.sourceCodeLocation?.startTag && node.sourceCodeLocation.endTag) {
        const leaves: HtmlText[] = [];
        const collect = (child: HtmlNode) => {
          if (textNode(child)) leaves.push(child);
          else if (element(child) && attr(child, "hidden") === undefined && attr(child, "aria-hidden") !== "true") child.childNodes.forEach(collect);
        };
        node.childNodes.forEach(collect);
        if (leaves.every(leaf => !leaf.value.trim() && leaf.sourceCodeLocation)) {
          let first = leaves[0];
          let offset = first?.sourceCodeLocation?.startOffset;
          if (!first) {
            // Choose the first explicitly located inline descendant so typing
            // into an emptied bold/link/span retains that original formatting.
            let insertion = node;
            while (true) {
              const child = insertion.childNodes.find((candidate): candidate is HtmlElement => element(candidate) && attr(candidate, "hidden") === undefined && attr(candidate, "aria-hidden") !== "true" && !!candidate.sourceCodeLocation?.startTag && !!candidate.sourceCodeLocation.endTag);
              if (!child) break;
              insertion = child;
            }
            offset = insertion.sourceCodeLocation!.startTag!.endOffset;
            first = defaultTreeAdapter.createTextNode("");
            defaultTreeAdapter.appendChild(insertion, first);
          }
          const run: HtmlTextRun = { id: `html-run-${offset}-${first.sourceCodeLocation?.endOffset ?? offset}`, text: first.value,
            startOffset: offset!, endOffset: first.sourceCodeLocation?.endOffset ?? offset!, marks: [...new Set(ancestors.flatMap(a => MARKS[a.tagName] ? [MARKS[a.tagName]!] : []))] };
          const region: HtmlTextRegion = { id: `html-region-${offset}`, tagName: node.tagName, label: LABELS[node.tagName] ?? "Text", text: first.value, runs: [run] };
          regions.push(region); targets.set(region.id, node); grouped.set(node, region); runNodes.set(run.id, first);
        }
      }
      node.childNodes.forEach(child => visitBlank(child, [...ancestors, node]));
    } else if ("childNodes" in node) node.childNodes.forEach(child => visitBlank(child, ancestors));
  };
  visitBlank(tree, []);
  for (const region of regions) {
    const target = targets.get(region.id)!;
    let owner: HtmlNode | null = target;
    while (owner && !(element(owner) && owner.tagName === "p")) owner = "parentNode" in owner ? owner.parentNode : null;
    if (owner && element(owner) && owner.sourceCodeLocation?.startTag) {
      const { startOffset, endOffset } = owner.sourceCodeLocation;
      // Parser-owned element bounds also cover HTML's valid omitted </p> tag.
      if (endOffset >= owner.sourceCodeLocation.startTag.endOffset) {
        region.paragraph = { startOffset, endOffset, wholeRegion: target === owner };
      }
    }
  }
  regions.sort((a, b) => a.runs[0].startOffset - b.runs[0].startOffset);
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
        if (!region.runs.some(existing => existing.id === run.id)) region.runs.push(run);
        runNodes.set(run.id, node);
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
        if (child.sourceCodeLocation?.startTag) child.attrs.push({ name: "data-nautilo-html-source", value: String(child.sourceCodeLocation.startTag.startOffset) });
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
  // Keep the sanitized inline tree for the editing renderer. The marker lets
  // it capture the original computed appearance before Lexical mounts.
  const inlineElements = new Map<HtmlElement, HtmlTextInline>();
  if (!blockedReason) for (const region of regions) for (const run of region.runs) {
    const target = targets.get(region.id);
    const node = runNodes.get(run.id);
    if (!node || target === node) { run.inlinePath = []; continue; }
    const path: HtmlTextInline[] = [];
    let parent = node.parentNode;
    while (parent && parent !== target && element(parent)) {
      let descriptor = inlineElements.get(parent);
      if (!descriptor) {
        descriptor = { id: `html-inline-${inlineElements.size}`, tagName: parent.tagName,
          ...(parent.sourceCodeLocation?.startTag ? { sourceStartOffset: parent.sourceCodeLocation.startTag.startOffset } : {}),
          attributes: Object.fromEntries(parent.attrs.map(a => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value])) };
        inlineElements.set(parent, descriptor);
        parent.attrs.push({ name: "data-nautilo-html-inline", value: descriptor.id });
      }
      path.unshift(descriptor);
      parent = parent.parentNode;
    }
    run.inlinePath = path;
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

/** The exact inline run distribution used by both source patches and active rendering. */
export function projectHtmlRegionRuns(region: HtmlTextRegion, text: string): HtmlTextRun[] {
  const edits = regionRunEdits(region, text);
  return region.runs.map((run, index) => ({ ...run, text: edits[index].text }));
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

/** Explicit paragraph removal includes its markup, leaving surrounding source untouched. */
export function deleteHtmlParagraph(model: HtmlTextModel, currentSource: string, regionId: string): HtmlTextEditResult {
  if (model.source !== currentSource) return { ok: false, reason: "The HTML changed. Select the paragraph again before deleting it." };
  if (model.blockedReason) return { ok: false, reason: model.blockedReason };
  const paragraph = model.regions.find(region => region.id === regionId)?.paragraph;
  if (!paragraph) return { ok: false, reason: "Select a paragraph to delete. Other page elements can be changed in Source." };
  return { ok: true, source: currentSource.slice(0, paragraph.startOffset) + currentSource.slice(paragraph.endOffset),
    changedRunIds: model.regions.filter(region => region.paragraph?.startOffset === paragraph.startOffset).flatMap(region => region.runs.map(run => run.id)) };
}
