import type { Layout } from '../../model/presentation.js';
import { fillXml } from './color.js';
import { shapeToXml, textElementToXml } from './shape.js';
import { slotRefsForLayout } from '../../model/layout.js';
import { escapeXmlAttr } from './xml.js';

/**
 * Built-in layout id → OOXML `<p:sldLayout type>` value.
 *
 * This is the inverse of `import/pptx/layout.ts` `TYPE_TO_BUILT_IN`.
 * The importer maps many-to-one (multiple OOXML types collapse to one
 * built-in id); the exporter picks the canonical primary type so that a
 * round-trip `export → import` re-derives the same built-in layout id.
 *
 * Canonical mapping (first/most-common type for each built-in):
 *   title-slide        ← title  (ctrTitle also maps here; title is primary)
 *   section-header     ← secHead
 *   title-body         ← obj    (tx/body also map here; obj is OOXML primary)
 *   title-two-columns  ← twoColTx
 *   title-only         ← titleOnly
 *   one-column-text    ← body
 *   blank              ← blank
 *   main-point, section-title-description, caption, big-number
 *                      → no exact OOXML token; use 'blank' so a re-import
 *                        still produces a valid layout rather than crashing.
 *
 * A `Map`, not an object literal: `layout.id` is persisted JSON — custom
 * layouts carry arbitrary ids and the content PUT API lets a caller store any
 * string — and an object lookup consults the prototype chain, so an id of
 * `constructor` / `toString` would resolve to an inherited `Object.prototype`
 * member, survive the `?? 'blank'` fallback and be stringified into the
 * `type` attribute. `Map.get` only ever returns an own entry.
 */
const BUILT_IN_TO_TYPE = new Map<string, string>([
  ['title-slide', 'title'],
  ['section-header', 'secHead'],
  ['title-body', 'obj'],
  ['title-two-columns', 'twoColTx'],
  ['title-only', 'titleOnly'],
  ['one-column-text', 'body'],
  ['blank', 'blank'],
  // Wafflebase-specific layouts with no exact OOXML equivalent — use the
  // closest approximation so the importer still produces a valid result:
  //   main-point, caption, big-number → 'blank'
  //   section-title-description       → 'obj' (title+body is the closest match)
  ['main-point', 'blank'],
  ['section-title-description', 'obj'],
  ['caption', 'blank'],
  ['big-number', 'blank'],
]);

/**
 * Serialize a `Layout` to `ppt/slideLayouts/slideLayoutN.xml` content.
 *
 * Emits the OOXML `type` attribute so that `import/pptx/layout.ts`
 * `parseLayout` can re-derive the same built-in layout id on round-trip.
 *
 * Retains the layout name, solid/gradient background and supported editable
 * placeholders with their source slot indices. Unsupported artwork refuses
 * export rather than producing an apparently successful empty layout.
 */
export function layoutToXml(layout: Layout, index: number): string {
  const ooxmlType = BUILT_IN_TO_TYPE.get(layout.id) ?? 'blank';
  const nameAttr = escapeXmlAttr(layout.name ?? `Layout${index}`);

  if (layout.staticElements.length) throw new Error(`Cannot export layout "${layout.name}": static layout artwork is not supported yet.`);
  const slots = slotRefsForLayout(layout);
  const placeholders = layout.placeholders.map((spec, i) => {
    const element = { ...spec, id: `${layout.id}-placeholder-${i}` };
    const xml = element.type === 'text' ? textElementToXml(element)
      : element.type === 'shape' ? shapeToXml(element)
      : undefined;
    if (!xml) throw new Error(`Cannot export layout "${layout.name}": unsupported placeholder type ${element.type}.`);
    const slot = slots[i];
    const type = slot.type === 'subtitle' ? 'subTitle' : slot.type === 'title' ? 'title' : 'body';
    return xml.replace('<p:nvPr/>', `<p:nvPr><p:ph type="${type}" idx="${slot.index}"/></p:nvPr>`)
      .replace('<p:cNvPr id="0"', `<p:cNvPr id="${i + 2}"`);
  }).join('');
  // Image backgrounds retain the existing conversion-warning behavior: only
  // their fill exports until image relationships are supported at this level.
  const background = layout.background?.fill
    ? `<p:bg><p:bgPr>${fillXml(layout.background.fill)}</p:bgPr></p:bg>` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldLayout` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
    ` type="${ooxmlType}"` +
    `>` +
    `<p:cSld name="${nameAttr}">` + background +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    placeholders + `</p:spTree>` +
    `</p:cSld>` +
    `</p:sldLayout>`
  );
}
