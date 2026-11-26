import { parse, type DefaultTreeAdapterMap } from "parse5";
import { applyHtmlRegionTexts, buildHtmlTextModel, type HtmlTextModel } from "./html-text-model";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const splitBlocks = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);
const safeBoundary = (text: string, offset: number) => Number.isInteger(offset) && offset >= 0 && offset <= text.length &&
  !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));

type BreakResult = { ok: true; source: string; regionIndex: number; offset: number } | { ok: false; reason: string };
/** Split only parser-owned source boundaries. Unrelated document bytes remain untouched. */
export function insertHtmlTextBreak(model: HtmlTextModel, regionId: string, anchor: number, focus: number, soft: boolean,
  sourceStyles: Record<number, string> = {}): BreakResult {
  if (model.blockedReason) return { ok: false, reason: model.blockedReason };
  const index = model.regions.findIndex(region => region.id === regionId);
  let region = model.regions[index];
  if (!region || !safeBoundary(region.text, anchor) || !safeBoundary(region.text, focus)) return { ok: false, reason: "Select a text position before inserting a break." };
  const from = Math.min(anchor, focus), to = Math.max(anchor, focus);
  let source = model.source;
  if (from !== to) {
    const originalElements: number[] = [];
    const collect = (node: Node) => { if (element(node) && node.sourceCodeLocation?.startTag) originalElements.push(node.sourceCodeLocation.startOffset); if ("childNodes" in node) node.childNodes.forEach(collect); };
    collect(parse(source, { sourceCodeLocationInfo: true }));
    const replaced = applyHtmlRegionTexts(model, source, [{ regionId, text: region.text.slice(0, from) + region.text.slice(to) }]);
    if (!replaced.ok) return replaced;
    source = replaced.source;
    let elementIndex = 0;
    const remapped: Record<number, string> = {};
    const remap = (node: Node) => {
      if (element(node) && node.sourceCodeLocation?.startTag) {
        const style = sourceStyles[originalElements[elementIndex++]];
        if (style !== undefined) remapped[node.sourceCodeLocation.startOffset] = style;
      }
      if ("childNodes" in node) node.childNodes.forEach(remap);
    };
    remap(parse(source, { sourceCodeLocationInfo: true })); sourceStyles = remapped;
    region = buildHtmlTextModel(source).regions[index];
    if (!region) return { ok: false, reason: "The selected text area changed. Select it again." };
  }
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const elements: Element[] = [];
  const visit = (node: Node) => { if (element(node)) elements.push(node); if ("childNodes" in node) node.childNodes.forEach(visit); };
  visit(tree);
  let position = 0;
  const run = region.runs.find(candidate => { const end = position + candidate.text.length; if (from <= end) return true; position = end; return false; });
  if (!run) return { ok: false, reason: "The text position is no longer available." };
  const offset = from - position;
  const ancestors = elements.filter(node => {
    const loc = node.sourceCodeLocation;
    return loc?.startTag && loc.startTag.endOffset <= run.startOffset && (loc.endTag?.startOffset ?? loc.endOffset) >= run.endOffset;
  }).sort((a, b) => a.sourceCodeLocation!.startOffset - b.sourceCodeLocation!.startOffset);
  const block = soft ? undefined : [...ancestors].reverse().find(node => splitBlocks.has(node.tagName));
  const location = block?.sourceCodeLocation;
  const left = escapeText(run.text.slice(0, offset)), right = escapeText(run.text.slice(offset));
  let result: string, caret: number;
  if (!block || !location?.startTag) {
    const inserted = left + "<br>";
    result = source.slice(0, run.startOffset) + inserted + right + source.slice(run.endOffset);
    caret = run.startOffset + inserted.length;
  } else {
    const wrappers = ancestors.slice(ancestors.indexOf(block) + 1);
    if (wrappers.some(node => !node.sourceCodeLocation?.endTag)) return { ok: false, reason: "This recovered HTML has no safe paragraph boundary. Use a line break here." };
    const copyOpening = (node: Element, paragraph = false) => {
      const loc = node.sourceCodeLocation!;
      let opening = source.slice(loc.startTag!.startOffset, loc.startTag!.endOffset);
      const patches = [loc.attrs?.id, ...(node.tagName === "a" ? [loc.attrs?.name] : [])]
        .filter(value => value !== undefined).map(attr => ({ start: attr.startOffset - loc.startOffset, end: attr.endOffset - loc.startOffset, text: "" }));
      // IDs stay on the original element; preserve its computed text appearance on a clone.
      const appearance = loc.attrs?.id && sourceStyles[loc.startOffset];
      if (appearance) {
        const style = (node.attrs.find(attr => attr.name === "style")?.value ?? "") + ";" + appearance;
        const text = `style="${escapeText(style).replaceAll('"', '&quot;')}"`;
        const attr = loc.attrs?.style;
        patches.push(attr ? { start: attr.startOffset - loc.startOffset, end: attr.endOffset - loc.startOffset, text }
          : { start: opening.length - 1, end: opening.length - 1, text: " " + text });
      }
      for (const patch of patches.sort((a, b) => b.start - a.start)) opening = opening.slice(0, patch.start) + patch.text + opening.slice(patch.end);
      return paragraph ? opening.replace(/^<h[1-6]\b/i, "<p") : opening;
    };
    const close = (node: Element) => source.slice(node.sourceCodeLocation!.endTag!.startOffset, node.sourceCodeLocation!.endTag!.endOffset);
    const closing = location.endTag ? close(block) : `</${block.tagName}>`;
    const nextTag = /^h[1-6]$/.test(block.tagName) ? "p" : block.tagName;
    let nextWrappers = wrappers;
    let tailStart = run.endOffset;
    if (!right) {
      // Enter after a citation/link starts ordinary text, just like typing
      // after it. Preserve annotations when splitting inside their content.
      let end = run.endOffset;
      const ending = new Set<Element>();
      for (const node of [...wrappers].reverse()) {
        const tag = node.sourceCodeLocation!.endTag!;
        if (tag.startOffset !== end) break;
        ending.add(node); end = tag.endOffset;
      }
      const annotation = wrappers.findIndex(node => ending.has(node) && ["sup", "sub", "a"].includes(node.tagName));
      if (annotation >= 0) {
        nextWrappers = wrappers.slice(0, annotation);
        tailStart = wrappers[annotation].sourceCodeLocation!.endTag!.endOffset;
      }
    }
    const middle = left + [...wrappers].reverse().map(close).join("") + closing + copyOpening(block, true) + nextWrappers.map(node => copyOpening(node)).join("");
    result = source.slice(0, run.startOffset) + middle + right + source.slice(tailStart, location.endTag?.startOffset ?? location.endOffset) + `</${nextTag}>` + source.slice(location.endOffset);
    caret = run.startOffset + middle.length;
  }
  const next = buildHtmlTextModel(result);
  let regionIndex = next.regions.findIndex(candidate => candidate.runs.some(candidateRun => candidateRun.startOffset <= caret && candidateRun.endOffset >= caret));
  if (regionIndex < 0) regionIndex = next.regions.findIndex(candidate => candidate.runs[0].startOffset >= caret);
  if (regionIndex < 0) return { ok: false, reason: "The new line could not be made editable." };
  return { ok: true, source: result, regionIndex, offset: 0 };
}
