import { parse, html, type DefaultTreeAdapterMap } from "parse5";
import { buildStaticWriterDocument, type StaticWriterDocumentResult } from "./static-document";
import { normalizeEmbeddedRasterDataUrl } from "./raster-data-url";

export type StaticArtifactDocumentResult = StaticWriterDocumentResult;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const ELEMENTS = new Set(("html head body title style main article section header footer nav aside div span p " +
  "h1 h2 h3 h4 h5 h6 blockquote pre code ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr td th " +
  "a strong em b i u s strike small sup sub mark br hr figure figcaption img picture details summary time address abbr cite q kbd samp var wbr").split(" "));
const VOID_ELEMENTS = new Set(["br", "hr", "img", "col", "wbr"]);
const PRESENTATION_ATTRIBUTES = new Set(("class id style lang dir title role align valign width height bgcolor color border " +
  "cellpadding cellspacing colspan rowspan scope headers start reversed type open datetime").split(" "));
const ACTIVE_CONTAINERS = new Set(["iframe", "object", "embed", "canvas", "video", "audio"]);
const OMIT_ELEMENTS = new Set(["script", "base", "meta", "link", "template", "source", "track"]);

/** Server-authorized content is a document, not a grant to execute an app. */
export function buildStaticArtifactDocument(source: string): StaticArtifactDocumentResult {
  try {
    const writer = buildStaticWriterDocument(source);
    if (writer.kind !== "not_writer") return writer;
    const document = parse(source, { scriptingEnabled: false });
    const output: string[] = ["<!doctype html>"];
    const warnings: Extract<StaticWriterDocumentResult, { kind: "ready" }>["warnings"][number][] = [];
    const notices = new Set<string>();
    const notice = (code: "unsupported_block" | "unavailable_image" | "unsafe_link" | "unsupported_style", message: string) => {
      if (notices.has(message)) return;
      notices.add(message);
      warnings.push({ code, path: "document", message });
    };
    // Iterative traversal keeps authored nesting from consuming the JS stack.
    const pending: Array<Node | string> = [...document.childNodes].reverse();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (typeof node === "string") { output.push(node); continue; }
      if (node.nodeName === "#text" && "value" in node) { output.push(escapeText(node.value)); continue; }
      if (!("tagName" in node)) continue;
      const tag = node.tagName;
      if (node.namespaceURI !== html.NS.HTML || ACTIVE_CONTAINERS.has(tag)) {
        output.push('<p role="note">Embedded content is available in the original file.</p>');
        notice("unsupported_block", "Embedded applications or media are not run in this document reader. Save the original to open them elsewhere.");
        continue;
      }
      if (OMIT_ELEMENTS.has(tag)) {
        if (tag === "script") notice("unsupported_block", "This is a read-only document view; embedded scripts are not run.");
        if (tag === "link") notice("unsupported_style", "External stylesheets and fonts are not loaded in this document view.");
        continue;
      }
      if (tag === "input") {
        output.push(`<span>${escapeText(attribute(node, "value") ?? attribute(node, "placeholder") ?? "")}</span>`);
        notice("unsupported_block", "Form values are shown without submission controls.");
        continue;
      }
      if (!ELEMENTS.has(tag)) {
        notice("unsupported_block", "Some document controls or containers are shown as read-only content.");
        pending.push(...node.childNodes.slice().reverse());
        continue;
      }
      if (tag === "style") {
        // Preserve authored static CSS. The native reader and injected CSP
        // prohibit scripts/network; CSS remains confined to this document.
        const css = node.childNodes.map((child) => "value" in child ? child.value : "").join("");
        output.push(`<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`);
        if (/@import|url\s*\(/i.test(css)) notice("unsupported_style", "External CSS resources are not loaded; embedded styles are preserved.");
        continue;
      }
      const attributes: string[] = [];
      for (const attr of node.attrs) {
        if (attr.namespace) continue;
        if (PRESENTATION_ATTRIBUTES.has(attr.name) || /^aria-[a-z-]+$/.test(attr.name)) {
          attributes.push(` ${attr.name}="${escapeAttribute(attr.value)}"`);
        }
      }
      if (tag === "a") {
        const href = safeDocumentLink(attribute(node, "href") ?? "");
        if (href !== null) attributes.push(` href="${escapeAttribute(href)}"`);
        else if (attribute(node, "href")) notice("unsafe_link", "A link needs an unavailable or unsupported destination.");
      }
      if (tag === "img") {
        const original = attribute(node, "src") ?? "";
        const src = normalizeEmbeddedRasterDataUrl(original);
        const alt = attribute(node, "alt") || "Embedded image";
        if (!src) {
          output.push(`<span role="note">${escapeText(alt)} — image unavailable in this view.</span>`);
          notice("unavailable_image", "Some images require a source-bound resource resolver. They remain in the saved original.");
          continue;
        }
        attributes.push(` src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"`);
      }
      output.push(`<${tag}${attributes.join("")}>`);
      if (tag === "head") output.push(STATIC_DOCUMENT_HEAD);
      if (!VOID_ELEMENTS.has(tag)) {
        pending.push(`</${tag}>`, ...node.childNodes.slice().reverse());
      }
    }
    return { kind: "ready", html: output.join(""), warnings };
  } catch {
    return { kind: "malformed", message: "This document could not be prepared. Its original file can still be saved." };
  }
}

export function safeDocumentLink(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export const STATIC_DOCUMENT_HEAD = '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
  '<style>html{background:#fff;color:#111}body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;overflow-x:auto}pre{overflow-x:auto}</style>';

function attribute(node: Element, name: string): string | undefined { return node.attrs.find((attr) => attr.name === name && !attr.namespace)?.value; }
function escapeText(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttribute(value: string): string { return escapeText(value).replace(/"/g, "&quot;"); }
