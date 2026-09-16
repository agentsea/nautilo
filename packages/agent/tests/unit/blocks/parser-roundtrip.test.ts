/**
 * D121-P4 / D087-P2B — parser round-trip idempotency tests.
 *
 * The block-edit substrate is correct only if the parser is faithful.
 * These tests pin the spike-test properties from `parser.ts`'s header
 * comment as automated assertions so a future bump of `linkedom`'s
 * version (or a swap to `cheerio`) surfaces regressions in CI.
 *
 * Test fixtures are deliberately small and self-contained — they don't
 * load real artifacts. The point is: given a parse→serialize cycle, do
 * the load-bearing properties survive?
 */

import { describe, test, expect } from "bun:test";
import {
  collectAllIds,
  findBlockById,
  findRange,
  parseArtifact,
  parseFragment,
  serializeArtifact,
} from "../../../src/tools/file/blocks/parser";

const SAMPLE = `<!doctype html>
<html><body>
<nw-deck id="d">
  <nw-slide id="s1" data-foo="bar"><p>hello &amp; world</p></nw-slide>
  <nw-slide id="s2"><p id="p_a">alpha</p><p id="p_b">beta</p></nw-slide>
  <nw-button data-action="ok" onclick="alert(1)">Go</nw-button>
</nw-deck>
</body></html>`;

describe("parseArtifact + serializeArtifact — round-trip properties", () => {
  test("custom <nw-*> elements preserved verbatim", () => {
    const doc = parseArtifact(SAMPLE);
    const out = serializeArtifact(doc);
    expect(out).toContain("<nw-deck");
    expect(out).toContain("</nw-deck>");
    expect(out).toContain("<nw-slide");
    expect(out).toContain("</nw-slide>");
    expect(out).toContain("<nw-button");
    expect(out).toContain("</nw-button>");
  });

  test("custom attributes (data-*) preserved", () => {
    const out = serializeArtifact(parseArtifact(SAMPLE));
    expect(out).toContain('data-foo="bar"');
    expect(out).toContain('data-action="ok"');
  });

  test('inline event handlers preserved as text (no eval, no strip)', () => {
    const out = serializeArtifact(parseArtifact(SAMPLE));
    expect(out).toContain('onclick="alert(1)"');
  });

  test("HTML entities round-trip without double-escape or unescape-to-literal", () => {
    const out = serializeArtifact(parseArtifact(SAMPLE));
    expect(out).toContain("&amp;");
    expect(out).not.toContain("hello & world"); // would indicate unescape-to-literal
    expect(out).not.toContain("&amp;amp;"); // would indicate double-escape
  });

  test("parse→serialize→parse is stable (second cycle matches first)", () => {
    const out1 = serializeArtifact(parseArtifact(SAMPLE));
    const out2 = serializeArtifact(parseArtifact(out1));
    expect(out2).toBe(out1);
  });

  test("mixed sibling kinds (<p> + <nw-slide>) preserved in source order", () => {
    const mixed = `<!doctype html><html><body><nw-deck id="d"><p id="p_intro">intro</p><nw-slide id="s1">slide</nw-slide><p id="p_outro">outro</p></nw-deck></body></html>`;
    const out = serializeArtifact(parseArtifact(mixed));
    const introIdx = out.indexOf('id="p_intro"');
    const slideIdx = out.indexOf('id="s1"');
    const outroIdx = out.indexOf('id="p_outro"');
    expect(introIdx).toBeGreaterThan(-1);
    expect(slideIdx).toBeGreaterThan(introIdx);
    expect(outroIdx).toBeGreaterThan(slideIdx);
  });
});

describe("findBlockById", () => {
  test("finds custom-element by id", () => {
    const doc = parseArtifact(SAMPLE);
    const slide = findBlockById(doc, "s1");
    expect(slide).not.toBeNull();
    expect(slide?.tagName.toLowerCase()).toBe("nw-slide");
  });

  test("returns null for unknown id", () => {
    const doc = parseArtifact(SAMPLE);
    expect(findBlockById(doc, "does-not-exist")).toBeNull();
  });

  test("escapes double quotes in the id selector", () => {
    const tricky = `<!doctype html><html><body><div id='has"quote'>x</div></body></html>`;
    const doc = parseArtifact(tricky);
    const el = findBlockById(doc, 'has"quote');
    expect(el).not.toBeNull();
  });
});

describe("findRange", () => {
  test("same-parent sibling range returns inclusive elements", () => {
    const doc = parseArtifact(SAMPLE);
    // s1 and s2 are siblings under <nw-deck id="d">. nw-button is also
    // a sibling. Range s1..s2 should be [s1, s2].
    const r = findRange(doc, "s1", "s2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.elements.length).toBe(2);
      expect(r.elements[0]!.getAttribute("id")).toBe("s1");
      expect(r.elements[1]!.getAttribute("id")).toBe("s2");
    }
  });

  test("cross-parent range rejected", () => {
    // s1 is a child of <nw-deck>; p_a is a child of <nw-slide id="s2">.
    // Different parents — reject.
    const doc = parseArtifact(SAMPLE);
    const r = findRange(doc, "s1", "p_a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cross-parent");
  });

  test("from-not-found surfaces explicit reason", () => {
    const doc = parseArtifact(SAMPLE);
    const r = findRange(doc, "missing", "s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("from-not-found");
  });

  test("to-not-found surfaces explicit reason", () => {
    const doc = parseArtifact(SAMPLE);
    const r = findRange(doc, "s1", "missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("to-not-found");
  });

  test("reversed range (to precedes from) is empty-range", () => {
    const doc = parseArtifact(SAMPLE);
    // s2 comes after s1 in source order; reversing yields empty range.
    const r = findRange(doc, "s2", "s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty-range");
  });

  test("same-id from and to returns single element", () => {
    const doc = parseArtifact(SAMPLE);
    const r = findRange(doc, "s1", "s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.elements.length).toBe(1);
      expect(r.elements[0]!.getAttribute("id")).toBe("s1");
    }
  });
});

describe("collectAllIds", () => {
  test("returns every unique id in source order; duplicates surfaced", () => {
    const dupSrc = `<!doctype html><html><body><div id="a"><div id="b"/></div><div id="b"/></body></html>`;
    const doc = parseArtifact(dupSrc);
    const { ids, duplicates } = collectAllIds(doc);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(duplicates).toContain("b");
    expect(duplicates).not.toContain("a");
  });

  test("clean document reports zero duplicates", () => {
    const doc = parseArtifact(SAMPLE);
    const { duplicates } = collectAllIds(doc);
    expect(duplicates).toEqual([]);
  });
});

describe("parseFragment", () => {
  test("multiple top-level elements parsed in source order", () => {
    const { elements } = parseFragment(`<p id="x">x</p><p id="y">y</p><nw-slide id="s">s</nw-slide>`);
    expect(elements.length).toBe(3);
    expect(elements[0]!.getAttribute("id")).toBe("x");
    expect(elements[1]!.getAttribute("id")).toBe("y");
    expect(elements[2]!.getAttribute("id")).toBe("s");
  });

  test("text-only input yields zero top-level elements", () => {
    const { elements } = parseFragment(`just text no tags`);
    expect(elements.length).toBe(0);
  });

  test("custom <nw-*> in fragment input preserved", () => {
    const { elements } = parseFragment(`<nw-button data-action="go" onclick="x()">Go</nw-button>`);
    expect(elements.length).toBe(1);
    expect(elements[0]!.tagName.toLowerCase()).toBe("nw-button");
    expect(elements[0]!.getAttribute("data-action")).toBe("go");
    expect(elements[0]!.getAttribute("onclick")).toBe("x()");
  });
});
