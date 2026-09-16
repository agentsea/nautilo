/**
 * D121-P4 / D087-P2B — DOM parser + finder + serializer for the
 * block-edit substrate.
 *
 * Parser choice: **linkedom**. Locked 2026-05-13 via a round-trip
 * spike (`docs/internal-tests/parser-spike.ts` results captured in
 * the D121-P4 commit body) against a representative artifact:
 *
 *   <!doctype html>
 *   <nw-deck id="d">
 *     <nw-slide id="s1" data-foo="bar"><p>hello &amp; world</p></nw-slide>
 *     <nw-button data-action="ok" onclick="alert(1)">Go</nw-button>
 *   </nw-deck>
 *
 * Confirmed properties of the spike output:
 *   - `<nw-*>` custom elements preserved verbatim (no lowercase rewrite
 *     of attributes, no self-close drift, no namespace mangling).
 *   - `data-foo="bar"` and all custom attributes preserved.
 *   - `onclick="alert(1)"` preserved as text (no eval — linkedom is a
 *     DOM parser, not a JS runtime).
 *   - `&amp;` round-trips through parse→serialize without
 *     double-escaping or unescape-to-literal.
 *   - `document.querySelector('[id="..."]')` resolves custom-element ids.
 *
 * cheerio was the fallback candidate; not needed.
 *
 * Note: linkedom uppercases `Element.tagName` (matching browser DOM
 * spec) but lowercases tag names in the serialized output. When
 * filtering by tag in `list_blocks`, lowercase the input + compare
 * against `tagName.toLowerCase()`.
 */

import { parseHTML } from "linkedom";

/**
 * Linkedom's HTML interfaces. The types from `linkedom` are awkward
 * to import in strict TS so we use structural-typed aliases that
 * match the subset of the DOM we actually use. All methods called
 * here exist on linkedom's Element / Document.
 */
export interface ParsedDocument {
  readonly documentElement: ParsedElement | null;
  readonly body: ParsedElement | null;
  querySelector(selector: string): ParsedElement | null;
  querySelectorAll(selector: string): Iterable<ParsedElement>;
  createElement(tagName: string): ParsedElement;
  /** linkedom-specific: serializes the full document including doctype. */
  toString(): string;
}

export interface ParsedNode {
  readonly nodeType: number;
  readonly parentNode: ParsedElement | ParsedDocument | null;
  readonly nextSibling: ParsedNode | null;
  textContent: string | null;
}

export interface ParsedElement extends ParsedNode {
  readonly tagName: string;
  readonly children: { length: number; [index: number]: ParsedElement } & Iterable<ParsedElement>;
  readonly childNodes: Iterable<ParsedNode>;
  readonly firstChild: ParsedNode | null;
  innerHTML: string;
  outerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttributeNames(): string[];
  appendChild<T extends ParsedNode>(child: T): T;
  insertBefore<T extends ParsedNode>(child: T, ref: ParsedNode | null): T;
  replaceChild<T extends ParsedNode>(newChild: T, oldChild: ParsedNode): T;
  remove(): void;
  cloneNode(deep?: boolean): ParsedElement;
}

/** Constants matching the DOM spec; linkedom honors these values. */
// Module-local: linkedom's node-type constant for Element nodes.
// Not exported — internal traversal helper only.
const NODE_TYPE_ELEMENT = 1;
export const NODE_TYPE_TEXT = 3;

/**
 * Parse an HTML artifact source string into a linkedom Document.
 * Accepts both full documents (`<!doctype html>...`) and body fragments;
 * linkedom synthesizes the missing structural wrappers.
 */
export function parseArtifact(content: string): ParsedDocument {
  // linkedom's types lose the Document return type through parseHTML's
  // overloaded signature; widen via `unknown` so the structural cast
  // below is the only assertion in the path.
  const result = parseHTML(content) as unknown as { document: unknown };
  return result.document as ParsedDocument;
}

/**
 * Find an element by id attribute anywhere in the document.
 *
 * Uses attribute-selector form `[id="..."]` instead of the CSS id
 * selector `#...` because custom-element practice (and the
 * `<nw-*>` vocabulary in particular) sometimes carries ids that
 * contain CSS-special characters (`:`, `.`, leading digits). The
 * attribute form quotes the value so escaping is straightforward.
 *
 * Caller must pre-escape any embedded `"` in the id; the function
 * does this for them so the agent's wire-level id can be any
 * non-control-char string.
 */
export function findBlockById(doc: ParsedDocument, id: string): ParsedElement | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return doc.querySelector(`[id="${escaped}"]`);
}

/**
 * Find a contiguous sibling range. `from` and `to` MUST share the same
 * parent (same `parentNode` reference). The returned array is the
 * sibling sequence from `from` through `to` inclusive, in source order.
 *
 * Rejection reasons (caller surfaces as a clear error message):
 *   - `"from-not-found"` / `"to-not-found"` — id resolution failed.
 *   - `"cross-parent"` — both ids resolved but they're not siblings of
 *     the same parent; ranges must lie within one parent block.
 *   - `"empty-range"` — `to` precedes `from` in source order.
 */
export type FindRangeResult =
  | { ok: true; elements: ParsedElement[] }
  | { ok: false; reason: "from-not-found" | "to-not-found" | "cross-parent" | "empty-range" };

export function findRange(doc: ParsedDocument, fromId: string, toId: string): FindRangeResult {
  const from = findBlockById(doc, fromId);
  if (!from) return { ok: false, reason: "from-not-found" };
  const to = findBlockById(doc, toId);
  if (!to) return { ok: false, reason: "to-not-found" };
  if (from.parentNode !== to.parentNode) return { ok: false, reason: "cross-parent" };
  // Walk siblings from `from` forward until we hit `to`. If we never
  // see `to`, it's behind `from` in source order — reject with
  // empty-range rather than silently traversing the whole tail.
  const elements: ParsedElement[] = [];
  let cursor: ParsedNode | null = from;
  while (cursor !== null) {
    if (cursor.nodeType === NODE_TYPE_ELEMENT) {
      elements.push(cursor as ParsedElement);
      if (cursor === to) {
        return { ok: true, elements };
      }
    }
    cursor = cursor.nextSibling;
  }
  return { ok: false, reason: "empty-range" };
}

/**
 * Serialize a document back to a string. linkedom's `Document.toString()`
 * emits the doctype + html + head + body wrappers verbatim; for
 * fragment-input artifacts the wrappers are linkedom-synthesized but
 * stable across round-trips.
 */
export function serializeArtifact(doc: ParsedDocument): string {
  return doc.toString();
}

/**
 * Collect every `id` attribute value present in the document. Used by
 * `replace_block` / `insert_block` to reject id collisions after a
 * proposed mutation has been applied to a clone. Order-independent;
 * duplicates collapse — callers compare counts to detect duplicate ids.
 */
export function collectAllIds(doc: ParsedDocument): { ids: Set<string>; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const el of doc.querySelectorAll("[id]")) {
    const id = el.getAttribute("id");
    if (id === null || id.length === 0) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return { ids: seen, duplicates: [...duplicates] };
}

/**
 * Parse a content fragment (one or more sibling top-level elements +
 * inter-element whitespace) into an array of element nodes belonging
 * to a temporary document. Used by `replace_block` / `insert_block` to
 * accept multi-element `newContent` payloads.
 *
 * Implementation note: linkedom's parser is HTML5-tolerant; wrapping
 * the fragment in a `<body>` so its children become the parsed
 * top-level set is the standard idiom (`DOMParser` does the same).
 *
 * Throws nothing — malformed input yields a possibly-empty element
 * list; callers decide whether empty is an error for their op.
 */
export function parseFragment(html: string): { elements: ParsedElement[]; doc: ParsedDocument } {
  const wrapper = `<!doctype html><html><body>${html}</body></html>`;
  const doc = parseArtifact(wrapper);
  const body = doc.body;
  if (!body) return { elements: [], doc };
  const elements: ParsedElement[] = [];
  for (const child of body.children) {
    elements.push(child);
  }
  return { elements, doc };
}

/**
 * Whitespace-collapse a text snippet to ~`max` characters for outline
 * preview rendering. Strips leading/trailing whitespace, collapses
 * runs of whitespace (including newlines) to single spaces, and
 * truncates with an ellipsis. Pure; safe for any text content.
 */
export function previewText(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}
