// Modified by Nautilo: local Node XML parsing and explicit malformed/DTD refusal.
/**
 * Thin DOMParser facade + namespace-tolerant traversal helpers.
 *
 * PPTX XML uses several namespaces (`p:`, `a:`, `r:` plus a handful of
 * extension namespaces). Rather than threading the namespace URI through
 * every lookup, this module matches on `localName` so callers don't have
 * to distinguish between `p:sp` and `sp` etc.
 *
 * Browser consumers retain the native DOMParser path. Emitted Node consumers
 * fall back locally to xmldom without installing or mutating a global parser.
 */

import { DOMParser as XmldomParser } from '@xmldom/xmldom';

export const NS = {
  /** PresentationML — `p:` */
  P: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  /** DrawingML — `a:` */
  A: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  /** Relationships (per-part) — `r:` */
  R: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  /** Relationships (package-level `.rels` files) */
  RELS: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const;

export function parseXml(text: string): Document {
  // UTF-8 XML parts may carry a byte-order mark. JSZip decodes it to U+FEFF,
  // which native DOMParser accepts but xmldom reports as content outside the
  // root element. Remove only the permitted leading marker; all other input
  // remains subject to the parser's strict error handling below.
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;

  if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) {
    throw new Error('Invalid XML: DTD and entity declarations are unsupported');
  }

  const doc =
    typeof globalThis.DOMParser === 'function'
      ? new globalThis.DOMParser().parseFromString(source, 'text/xml')
      : (new XmldomParser({
          locator: false,
          onError(_level, message) {
            // xmldom otherwise reports warnings and recoverable errors while
            // returning a repaired tree. Imported Office data must fail
            // atomically instead of silently changing structure.
            throw new Error(`Invalid XML: ${message}`);
          },
        }).parseFromString(source, 'text/xml') as unknown as Document);
  // DOMParser emits a `<parsererror>` element rather than throwing.
  // Surface it as an Error so callers don't proceed with a junk tree.
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) {
    throw new Error(`Invalid XML: ${err.textContent ?? 'unknown parse error'}`);
  }
  return doc;
}

/** First child element with matching `localName`, or `undefined`. */
export function child(parent: Element | Document, localName: string): Element | undefined {
  const root: ParentNode = parent;
  const nodes = root.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && (n as Element).localName === localName) {
      return n as Element;
    }
  }
  return undefined;
}

/** Every direct child element with matching `localName`. */
export function children(parent: Element | Document, localName: string): Element[] {
  const out: Element[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && (n as Element).localName === localName) {
      out.push(n as Element);
    }
  }
  return out;
}

/**
 * First descendant element with matching `localName`. Useful for reading
 * a single deeply-nested attribute (e.g. `<p:sldSz>` inside the root).
 */
export function descendant(parent: Element | Document, localName: string): Element | undefined {
  // Document and Element both expose `getElementsByTagName` (`*` matches any).
  // We then filter by `localName` to stay namespace-agnostic.
  const all = (parent).getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i];
  }
  return undefined;
}

export function attr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === null ? undefined : v;
}

/** Parse an int attribute; returns `undefined` if missing or not a number. */
export function attrInt(el: Element, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function textOf(el: Element): string {
  return el.textContent ?? '';
}
