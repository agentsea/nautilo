import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
export type HtmlPageLinkTarget = { offset: number; label: string; href: string; id: string; needsId: boolean };
const isElement = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(candidate => candidate.name === name)?.value;
const skipped = new Set(["script", "style", "template", "noscript", "head", "svg", "math"]);
const targetTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]);

/** Existing anchors plus visible headings/paragraphs that can receive an ID on demand. */
export function htmlPageLinkTargets(source: string): HtmlPageLinkTarget[] {
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const identifiers = new Map<string, number>();
  const countIds = (node: Node) => {
    if (isElement(node)) for (const id of new Set([attr(node, "id"), ...(node.tagName === "a" ? [attr(node, "name")] : [])])) {
      if (id) identifiers.set(id, (identifiers.get(id) ?? 0) + 1);
    }
    if ("childNodes" in node) node.childNodes.forEach(countIds);
  };
  countIds(tree);
  const used = new Set(identifiers.keys()), targets: HtmlPageLinkTarget[] = [];
  const hidden = (node: Element) => skipped.has(node.tagName) || attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true";
  const text = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value
    : isElement(node) && hidden(node) ? "" : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  const visit = (node: Node) => {
    if (isElement(node)) {
      if (hidden(node) || String(node.namespaceURI) !== "http://www.w3.org/1999/xhtml") return;
      const location = node.sourceCodeLocation?.startTag;
      const existing = attr(node, "id") || (node.tagName === "a" ? attr(node, "name") : undefined);
      const label = text(node).replace(/\s+/g, " ").trim() || existing;
      if (location && label && (existing || targetTags.has(node.tagName)) && (!existing || identifiers.get(existing) === 1)) {
        const base = 'section-' + (label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'note');
        let id = existing || base, suffix = 2;
        if (!existing) { while (used.has(id)) id = `${base}-${suffix++}`; used.add(id); }
        targets.push({ offset: location.startOffset, label, href: '#' + encodeURIComponent(id), id, needsId: !existing });
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(tree);
  return targets;
}

/** Add only the selected destination's missing ID; preserve every other source byte. */
export function prepareHtmlPageLinkTarget(source: string, offset: number): { source: string; href: string } {
  const target = htmlPageLinkTargets(source).find(candidate => candidate.offset === offset);
  if (!target) throw new Error("That destination is no longer available. Choose it again.");
  if (!target.needsId) return { source, href: target.href };
  const tree = parse(source, { sourceCodeLocationInfo: true });
  let end: number | undefined;
  let idRange: { startOffset: number; endOffset: number } | undefined;
  const visit = (node: Node) => {
    if (isElement(node) && node.sourceCodeLocation?.startTag?.startOffset === offset) {
      end = node.sourceCodeLocation.startTag.endOffset;
      idRange = node.sourceCodeLocation.attrs?.id;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(tree);
  if (end === undefined) throw new Error("The destination has no explicit HTML boundary.");
  const at = source[end - 2] === '/' ? end - 2 : end - 1;
  const id = target.id.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  if (idRange) return { source: source.slice(0, idRange.startOffset) + `id="${id}"` + source.slice(idRange.endOffset), href: target.href };
  return { source: source.slice(0, at) + ` id="${id}"` + source.slice(at), href: target.href };
}
