import { parse, type DefaultTreeAdapterMap } from "parse5";
import { hasUrlAlteringChars, isSafeUrl } from "@nautilo/office-core/url";
import type { HtmlTextModel, HtmlTextRegion, HtmlTextRun } from "./html-text-model";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Text = DefaultTreeAdapterMap["textNode"];
export type HtmlFormattingAction =
  | { kind: "mark"; mark: "bold" | "italic" | "underline" | "superscript"; enabled: boolean }
  | { kind: "link"; href: string | null; text?: string };
export type HtmlFormattingRequest = {
  regionId: string; anchor: number; focus: number; action: HtmlFormattingAction;
  /** Exact source start-tag offsets of CSS decoration owners, captured by the trusted preview. */
  underlineOwners?: number[];
  underlineOwnerLines?: Record<number, string>;
  /** Trusted computed appearance for source wrappers split into ID-less fragments. */
  sourceInlineStyles?: Record<number, string>;
};
export type HtmlFormattingResult = { ok: true; source: string; anchor: number; focus: number } | { ok: false; reason: string };
type Patch = { start: number; end: number; text: string };
type Portion = { start: number; end: number };
const isElement = (node: Node): node is Element => "tagName" in node;
const isText = (node: Node): node is Text => node.nodeName === "#text";
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replaceAll('"', "&quot;");
const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "plaintext", "iframe", "noembed", "noframes", "noscript"]);

/** Validate the exact spelling we emit, including safe relative references. */
export function normalizeHtmlLinkUrl(input: string): string | null {
  const value = input;
  if (!value || hasUrlAlteringChars(value) || value.includes("\\")) return null;
  try { return isSafeUrl(new URL(value, "https://html-edit.invalid/").href) ? value : null; }
  catch { return null; }
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  if ("childNodes" in node) for (const child of node.childNodes) walk(child, visit);
}
function textNodesAndElements(source: string) {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const texts = new Map<number, Text>(); const elements = new Map<number, Element>();
  walk(tree, node => {
    if (isText(node) && node.sourceCodeLocation) texts.set(node.sourceCodeLocation.startOffset, node);
    if (isElement(node) && node.sourceCodeLocation?.startTag) elements.set(node.sourceCodeLocation.startTag.startOffset, node);
  });
  return { texts, elements };
}
function ancestorAnchor(node: Node | undefined): Element | undefined {
  let parent = node && "parentNode" in node ? node.parentNode : undefined;
  while (parent) {
    if (isElement(parent) && parent.tagName === "a") return parent;
    parent = "parentNode" in parent ? parent.parentNode : undefined;
  }
}
function runAtOffset(region: HtmlTextRegion, offset: number): HtmlTextRun | undefined {
  let start = 0;
  for (const run of region.runs) {
    const end = start + run.text.length;
    if (offset > start && offset <= end || offset === 0 && start === 0) return run;
    start = end;
  }
}

/** A continuation at the end of a superscript/subscript belongs outside it. */
export function insertHtmlTextAfterAnnotation(model: HtmlTextModel, regionId: string, offset: number, text: string): HtmlFormattingResult | null {
  if (model.blockedReason || !text || !Number.isInteger(offset)) return null;
  const region = model.regions.find(candidate => candidate.id === regionId);
  if (!region || offset <= 0 || offset > region.text.length) return null;
  const run = runAtOffset(region, offset);
  if (!run?.inlinePath?.some(inline => inline.tagName === "sup" || inline.tagName === "sub")) return null;
  const { texts } = textNodesAndElements(model.source);
  let node: Node | undefined = texts.get(run.startOffset);
  let annotation: Element | undefined;
  while (node && "parentNode" in node && node.parentNode) {
    node = node.parentNode;
    if (isElement(node) && (node.tagName === "sup" || node.tagName === "sub")) annotation = node;
  }
  if (!annotation?.sourceCodeLocation?.endTag) return null;
  const endsAtCaret = (element: Element) => {
    const location = element.sourceCodeLocation!;
    let position = 0, end = -1;
    for (const candidate of region.runs) {
      position += candidate.text.length;
      if (candidate.startOffset >= location.startOffset && candidate.endOffset <= location.endOffset) end = position;
    }
    return end === offset;
  };
  if (!endsAtCaret(annotation)) return null;
  // Citations can be <sup><a>…</a></sup> or <a><sup>…</sup></a>.
  // Exit an enclosing link too, but retain unrelated surrounding formatting.
  let boundary = annotation;
  const inlineOffsets = new Set(run.inlinePath.map(inline => inline.sourceStartOffset));
  for (let parent = annotation.parentNode; parent && isElement(parent); parent = parent.parentNode) {
    if (!parent.sourceCodeLocation?.endTag || !inlineOffsets.has(parent.sourceCodeLocation.startOffset) || !endsAtCaret(parent)) break;
    if (parent.tagName === "a") boundary = parent;
  }
  const at = boundary.sourceCodeLocation!.endTag!.endOffset;
  const next = offset + text.length;
  return { ok: true, source: model.source.slice(0, at) + escapeText(text) + model.source.slice(at), anchor: next, focus: next };
}

/** A caret edits the whole containing link; a range is intentionally left to the caller. */
export function htmlFormattingLinkRange(model: HtmlTextModel, regionId: string, offset: number): { anchor: number; focus: number; href: string } | null {
  const region = model.regions.find(candidate => candidate.id === regionId);
  if (!region || !Number.isInteger(offset) || offset < 0 || offset > region.text.length) return null;
  const { texts } = textNodesAndElements(model.source);
  const run = runAtOffset(region, offset);
  const anchor = ancestorAnchor(run && texts.get(run.startOffset));
  const href = anchor && attribute(anchor, "href");
  if (!anchor || href === undefined) return null;
  let position = 0; let from: number | undefined; let to = 0;
  for (const candidate of region.runs) {
    if (ancestorAnchor(texts.get(candidate.startOffset)) === anchor) { from ??= position; to = position + candidate.text.length; }
    position += candidate.text.length;
  }
  return from === undefined ? null : { anchor: from, focus: to, href };
}

function replaceAttribute(source: string, element: Element, name: string, value: string | null): string {
  const location = element.sourceCodeLocation;
  if (!location?.startTag) throw new Error("This formatting element has no explicit source start tag. Use Source to edit it.");
  const start = location.startTag.startOffset; const end = location.startTag.endOffset;
  const attr = location.attrs?.[name];
  if (attr) return source.slice(start, attr.startOffset) + (value === null ? "" : `${name}="${escapeAttribute(value)}"`) + source.slice(attr.endOffset, end);
  if (value === null) return source.slice(start, end);
  const opening = source.slice(start, end);
  const insertion = opening.endsWith("/>") ? opening.length - 2 : opening.length - 1;
  return opening.slice(0, insertion) + ` ${name}="${escapeAttribute(value)}"` + opening.slice(insertion);
}
function openingTag(source: string, element: Element, changes: Record<string, string | null>): string {
  const location = element.sourceCodeLocation!;
  const start = location.startTag!.startOffset;
  const opening = source.slice(start, location.startTag!.endOffset);
  const patches: Patch[] = [];
  const appended: string[] = [];
  for (const [name, value] of Object.entries(changes)) {
    const attr = location.attrs?.[name];
    const text = value === null ? "" : `${name}="${escapeAttribute(value)}"`;
    if (attr) patches.push({ start: attr.startOffset - start, end: attr.endOffset - start, text });
    else if (text) appended.push(text);
  }
  if (appended.length) {
    const end = opening.length - (opening.endsWith("/>") ? 2 : 1);
    patches.push({ start: end, end, text: " " + appended.join(" ") });
  }
  return applyPatches(opening, patches);
}
function safeBoundary(text: string, offset: number) {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}
function applyPatches(source: string, patches: Patch[]): string {
  patches.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < patches.length; i++) if (patches[i - 1].end > patches[i].start) throw new Error("The recovered HTML locations overlap. Use Source to format this area safely.");
  for (const patch of patches.reverse()) source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  return source;
}
function selectedPortions(region: HtmlTextRegion, from: number, to: number) {
  const selected = new Map<number, Portion>(); let position = 0;
  for (const run of region.runs) {
    const start = Math.max(0, from - position); const end = Math.min(run.text.length, to - position);
    if (start < end) selected.set(run.startOffset, { start, end });
    position += run.text.length;
  }
  return selected;
}

/** Intentional inline markup changes are bounded source patches, never document serialization. */
export function applyHtmlFormatting(model: HtmlTextModel, currentSource: string, request: HtmlFormattingRequest): HtmlFormattingResult {
  try {
    if (model.source !== currentSource) throw new Error("The HTML changed. Select the current text again before formatting.");
    if (model.blockedReason) throw new Error(model.blockedReason);
    const region = model.regions.find(candidate => candidate.id === request.regionId);
    if (!region) throw new Error("Select one current text area before formatting.");
    let from = Math.min(request.anchor, request.focus); let to = Math.max(request.anchor, request.focus);
    if (![from, to].every(value => Number.isInteger(value) && value >= 0 && value <= region.text.length && safeBoundary(region.text, value))) throw new Error("The selection does not identify complete characters in this text area.");
    const action = request.action;
    if (action.kind === "link" && action.href !== null && normalizeHtmlLinkUrl(action.href) === null) throw new Error("Use an http, https, mailto, tel, relative, or page-anchor link without control characters.");
    const { texts, elements } = textNodesAndElements(currentSource);
    if (from === to && action.kind === "link") {
      const existing = htmlFormattingLinkRange(model, region.id, from);
      if (existing) { from = existing.anchor; to = existing.focus; }
      else if (action.href !== null && action.text) {
        const run = runAtOffset(region, from) ?? region.runs[0];
        if (!run) throw new Error("This text area has no safe source insertion point.");
        const runStart = region.runs.slice(0, region.runs.indexOf(run)).reduce((sum, candidate) => sum + candidate.text.length, 0);
        const offset = from - runStart;
        const text = escapeText(run.text.slice(0, offset)) + `<a href="${escapeAttribute(normalizeHtmlLinkUrl(action.href)!)}">${escapeText(action.text)}</a>` + escapeText(run.text.slice(offset));
        return { ok: true, source: applyPatches(currentSource, [{ start: run.startOffset, end: run.endOffset, text }]), anchor: from + action.text.length, focus: from + action.text.length };
      } else throw new Error("Select linked text or enter text for the new link.");
    }
    if (from === to) return { ok: true, source: currentSource, anchor: request.anchor, focus: request.focus };
    const selected = selectedPortions(region, from, to);
    const patches: Patch[] = [];
    if (action.kind === "mark" && action.mark !== "superscript") {
      if (action.mark === "underline" && !action.enabled) {
        const owners = new Set(request.underlineOwners ?? []);
        for (const start of selected.keys()) {
          let node: Node | undefined = texts.get(start);
          while (node && "parentNode" in node && node.parentNode) {
            node = node.parentNode;
            if (isElement(node) && node.tagName === "u" && node.sourceCodeLocation?.startTag) owners.add(node.sourceCodeLocation.startTag.startOffset);
          }
        }
        const retained = new Map<number, { node: Text; decorations: string[] }>();
        for (const offset of owners) {
          const owner = elements.get(offset);
          if (!owner?.sourceCodeLocation?.startTag) throw new Error("This underline comes from an implicit element. Use Source to change that style.");
          // Do not accept a stale or unrelated DOM decoration owner.
          let intersects = false;
          walk(owner, node => { if (isText(node) && node.sourceCodeLocation && selected.has(node.sourceCodeLocation.startOffset)) intersects = true; });
          if (!intersects) throw new Error("The underline style owner changed. Select the text again.");
          const declared = request.underlineOwnerLines?.[offset] ?? "underline";
          const remaining = declared.split(/\s+/).filter(line => ["line-through", "overline", "blink"].includes(line)).join(" ") || "none";
          const style = attribute(owner, "style") ?? "";
          patches.push({ start: owner.sourceCodeLocation.startTag.startOffset, end: owner.sourceCodeLocation.startTag.endOffset,
            text: replaceAttribute(currentSource, owner, "style", `${style}${style.trimEnd().endsWith(";") || !style ? "" : ";"}text-decoration-line:${remaining} !important;`) });
          const decoration = [...(request.sourceInlineStyles?.[offset] ?? "").matchAll(/(?:^|;)\s*(text-decoration-(?:style|color|thickness))\s*:([^;]*)/g)]
            .map(match => `${match[1]}:${match[2]};`).join("");
          const collect = (node: Node) => {
            if (isElement(node) && (RAW_TEXT.has(node.tagName) || String(node.namespaceURI) !== "http://www.w3.org/1999/xhtml")) return;
            if (isText(node) && node.sourceCodeLocation) {
              const start = node.sourceCodeLocation.startOffset;
              const entry = retained.get(start) ?? { node, decorations: [] };
              entry.decorations.push(decoration); retained.set(start, entry);
            }
            if ("childNodes" in node) node.childNodes.forEach(collect);
          };
          collect(owner);
        }
        for (const [start, { node, decorations }] of retained) {
          const location = node.sourceCodeLocation!; const portion = selected.get(start);
          const wrap = (text: string) => text ? decorations.reduceRight((inner, decoration) => `<span style="text-decoration-line:underline${decoration ? ";" + escapeAttribute(decoration) : ""}">${inner}</span>`, escapeText(text)) : "";
          const text = portion ? wrap(node.value.slice(0, portion.start)) + escapeText(node.value.slice(portion.start, portion.end)) + wrap(node.value.slice(portion.end)) : wrap(node.value);
          if (text) patches.push({ start, end: location.endOffset, text });
        }
      } else {
        const property = action.mark === "bold" ? "font-weight" : action.mark === "italic" ? "font-style" : "text-decoration-line";
        const value = action.enabled ? action.mark === "bold" ? "bold" : action.mark === "italic" ? "italic" : "underline" : "normal";
        for (const run of region.runs) {
          const portion = selected.get(run.startOffset); if (!portion) continue;
          const text = escapeText(run.text.slice(0, portion.start)) + `<span style="${property}:${value} !important">${escapeText(run.text.slice(portion.start, portion.end))}</span>` + escapeText(run.text.slice(portion.end));
          patches.push({ start: run.startOffset, end: run.endOffset, text });
        }
      }
    } else {
      const anchors = new Set<Element>();
      const superscript = action.kind === "mark";
      const annotation = (node: Node | undefined): Element | undefined => {
        let result: Element | undefined;
        while (node && "parentNode" in node && node.parentNode) {
          node = node.parentNode;
          if (isElement(node) && node.tagName === "sup") result = node;
        }
        return result;
      };
      for (const start of selected.keys()) {
        const owner = superscript ? annotation(texts.get(start)) : ancestorAnchor(texts.get(start));
        if (owner && (!superscript || !action.enabled)) anchors.add(owner);
      }
      type Fragment = { selected: boolean; text: string };
      const combine = (fragments: Fragment[]) => {
        const result: Fragment[] = [];
        for (const fragment of fragments) {
          const previous = result[result.length - 1];
          if (previous?.selected === fragment.selected) previous.text += fragment.text;
          else result.push({ ...fragment });
        }
        return result;
      };
      const split = (node: Node): Fragment[] => {
        const location = node.sourceCodeLocation;
        if (!location) throw new Error("This link crosses recovered HTML without exact source boundaries. Use Source to edit it.");
        const portion = selected.get(location.startOffset);
        if (isText(node) && portion) return [
          { selected: false, text: escapeText(node.value.slice(0, portion.start)) },
          { selected: true, text: escapeText(node.value.slice(portion.start, portion.end)) },
          { selected: false, text: escapeText(node.value.slice(portion.end)) },
        ].filter(fragment => fragment.text);
        let intersects = false;
        walk(node, descendant => { if (isText(descendant) && descendant.sourceCodeLocation && selected.has(descendant.sourceCodeLocation.startOffset)) intersects = true; });
        if (!intersects) return [{ selected: false, text: currentSource.slice(location.startOffset, location.endOffset) }];
        if (!isElement(node) || !node.sourceCodeLocation?.startTag || !node.sourceCodeLocation.endTag) throw new Error("This link needs explicit opening and closing tags to split safely. Use Source to edit it.");
        const elementLocation = node.sourceCodeLocation;
        const fragments = combine(node.childNodes.flatMap(split));
        return fragments.map((fragment, index) => {
          const changes: Record<string, string | null> = {};
          if (action.kind === "link" && node.tagName === "a" && fragment.selected) changes.href = action.href === null ? null : normalizeHtmlLinkUrl(action.href)!;
          if (index > 0) {
            changes.id = null;
            const appearance = request.sourceInlineStyles?.[elementLocation.startTag!.startOffset];
            if (appearance) {
              const style = attribute(node, "style") ?? "";
              changes.style = `${style}${style.trimEnd().endsWith(";") || !style ? "" : ";"}${appearance}`;
            }
          }
          const removeSuperscript = superscript && fragment.selected && node.tagName === "sup";
          if (removeSuperscript) {
            const style = changes.style ?? attribute(node, "style") ?? "";
            changes.style = `${style}${style.trimEnd().endsWith(";") || !style ? "" : ";"}vertical-align:baseline !important;font-size:inherit !important;`;
          }
          let opening = openingTag(currentSource, node, changes);
          if (removeSuperscript) opening = opening.replace(/^<sup\b/i, "<span");
          const closing = removeSuperscript ? "</span>" : currentSource.slice(elementLocation.endTag!.startOffset, elementLocation.endTag!.endOffset);
          // Keep a href-less anchor on removal: its classes, ID and attributes
          // can carry authored styling/anchors; only hyperlink behavior changes.
          return { selected: fragment.selected, text: opening + fragment.text + closing };
        });
      };
      for (const anchor of anchors) {
        const location = anchor.sourceCodeLocation!;
        patches.push({ start: location.startOffset, end: location.endOffset, text: split(anchor).map(fragment => fragment.text).join("") });
      }
      if (action.kind === "mark" ? action.enabled : action.href !== null) for (const run of region.runs) {
        const portion = selected.get(run.startOffset); if (!portion || (superscript ? annotation(texts.get(run.startOffset)) : ancestorAnchor(texts.get(run.startOffset)))) continue;
        patches.push({ start: run.startOffset, end: run.endOffset, text: escapeText(run.text.slice(0, portion.start)) + (action.kind === "mark" ? `<sup>${escapeText(run.text.slice(portion.start, portion.end))}</sup>` : `<a href="${escapeAttribute(normalizeHtmlLinkUrl(action.href!)!)}">${escapeText(run.text.slice(portion.start, portion.end))}</a>`) + escapeText(run.text.slice(portion.end)) });
      }
    }
    return { ok: true, source: applyPatches(currentSource, patches), anchor: request.anchor === request.focus ? from : request.anchor, focus: request.anchor === request.focus ? to : request.focus };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "This formatting change could not be mapped safely to the HTML source." }; }
}
