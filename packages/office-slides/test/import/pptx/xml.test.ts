// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { attr, attrInt, child, children, descendant, parseXml, textOf, NS } from '../../../src/import/pptx/xml';

const SAMPLE = `<?xml version="1.0"?>
<root xmlns:p="${NS.P}" xmlns:a="${NS.A}">
  <p:wrap>
    <a:run sz="1200">Hello</a:run>
    <a:run sz="abc">World</a:run>
    <a:run>!</a:run>
  </p:wrap>
  <p:other/>
</root>`;

function withoutGlobalDomParser<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'DOMParser', descriptor);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  }
}

describe('xml helpers', () => {
  it('throws on malformed input', () => {
    expect(() => parseXml('<a><b>')).toThrow(/Invalid XML/);
  });

  it('matches children by localName ignoring prefix', () => {
    const doc = parseXml(SAMPLE);
    const root = doc.documentElement;
    const wrap = child(root, 'wrap');
    expect(wrap).toBeDefined();
    const runs = children(wrap!, 'run');
    expect(runs).toHaveLength(3);
    expect(textOf(runs[0])).toBe('Hello');
  });

  it('finds a descendant deep in the tree', () => {
    const doc = parseXml(SAMPLE);
    const run = descendant(doc, 'run');
    expect(run).toBeDefined();
    expect(textOf(run!)).toBe('Hello');
  });

  it('reads attributes safely', () => {
    const doc = parseXml(SAMPLE);
    const run = descendant(doc, 'run')!;
    expect(attr(run, 'sz')).toBe('1200');
    expect(attr(run, 'missing')).toBeUndefined();
    expect(attrInt(run, 'sz')).toBe(1200);

    const runs = children(child(doc.documentElement, 'wrap')!, 'run');
    expect(attrInt(runs[1], 'sz')).toBeUndefined();
    expect(attrInt(runs[2], 'sz')).toBeUndefined();
  });

  it('uses the local Node parser without installing a global', () => {
    const original = globalThis.DOMParser;
    withoutGlobalDomParser(() => {
      const doc = parseXml(SAMPLE);
      expect(textOf(descendant(doc, 'run')!)).toBe('Hello');
      expect(globalThis.DOMParser).toBeUndefined();
    });
    expect(globalThis.DOMParser).toBe(original);
  });

  it('accepts a leading byte-order mark on the browser parser path', () => {
    const doc = parseXml(`\uFEFF${SAMPLE}`);
    expect(textOf(descendant(doc, 'run')!)).toBe('Hello');
  });

  it('accepts a leading byte-order mark on the local Node parser path without a global leak', () => {
    const original = globalThis.DOMParser;
    withoutGlobalDomParser(() => {
      const doc = parseXml(`\uFEFF${SAMPLE}`);
      expect(textOf(descendant(doc, 'run')!)).toBe('Hello');
      expect(globalThis.DOMParser).toBeUndefined();
    });
    expect(globalThis.DOMParser).toBe(original);
  });

  it('fails malformed XML on the local Node parser path', () => {
    withoutGlobalDomParser(() => {
      expect(() => parseXml('<root><unclosed></root>')).toThrow(/Invalid XML/);
      expect(() => parseXml('\uFEFF<root><unclosed></root>')).toThrow(/Invalid XML/);
      expect(globalThis.DOMParser).toBeUndefined();
    });
  });

  it.each([
    '<!DOCTYPE root><root/>',
    '\uFEFF<!DOCTYPE root><root/>',
    '<!DOCTYPE root SYSTEM "https://example.invalid/external.dtd"><root/>',
    '<!DOCTYPE root [<!ENTITY external SYSTEM "file:///etc/passwd">]><root>&external;</root>',
  ])('rejects DTD and entity declarations', (xml) => {
    expect(() => parseXml(xml)).toThrow(/DTD and entity declarations/);
  });
});
