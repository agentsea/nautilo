// @vitest-environment jsdom
// Nautilo regression: assert raw attachments, without roundtrip normalization.
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportPptx } from '../../../src/export/pptx/index.js';
import { importPptx } from '../../../src/import/pptx/index.js';
import { flattenElements } from '../../../src/model/group.js';
import type { ShapeElement, GroupElement } from '../../../src/model/element.js';
import type { ConnectorElement } from '../../../src/model/connector.js';
import { MemSlidesStore } from '../../../src/store/memory.js';

function fixture(kind: 'rect' | 'ellipse', siteIndex: number, grouped = false) {
  const doc = new MemSlidesStore().read();
  const target: ShapeElement = {
    id: 'target&"<', type: 'shape',
    frame: { x: 100, y: 100, w: 200, h: 100, rotation: 0 },
    data: { kind },
  };
  const connector: ConnectorElement = {
    id: 'connector&"<', type: 'connector', routing: 'straight',
    frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    start: { kind: 'attached', elementId: target.id, siteIndex },
    end: { kind: 'attached', elementId: target.id, siteIndex },
    arrowheads: {},
  };
  const group: GroupElement = {
    id: 'group', type: 'group',
    frame: { x: 50, y: 50, w: 500, h: 400, rotation: 0 },
    data: { children: [target], refSize: { w: 500, h: 400 } },
  };
  doc.slides = [{
    id: 'slide', layoutId: 'blank', background: {}, notes: [],
    // The connector appears before its target in serialized document order.
    elements: [connector, grouped ? group : target],
  }];
  return { doc, target, connector };
}

async function roundTrip(doc: ReturnType<typeof fixture>['doc']) {
  const bytes = await exportPptx(doc);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await importPptx(buffer)).document;
}

describe('PPTX connector attachment roundtrip', () => {
  for (const [kind, sites] of [['rect', [0, 1, 2, 3]], ['ellipse', [0, 1, 2, 3, 4, 5, 6, 7]]] as const) {
    it.each(sites)(`retains both ${kind} endpoints at site %i`, async site => {
      const { doc } = fixture(kind, site);
      const result = await roundTrip(doc);
      const elements = flattenElements(result.slides[0].elements);
      const target = elements.find(el => el.type === 'shape');
      const connector = elements.find(el => el.type === 'connector');
      expect(target).toBeDefined();
      expect(connector?.start).toEqual({ kind: 'attached', elementId: target!.id, siteIndex: site });
      expect(connector?.end).toEqual({ kind: 'attached', elementId: target!.id, siteIndex: site });
    });
  }

  it('retains a forward reference into a nested group', async () => {
    const { doc } = fixture('rect', 1, true);
    const result = await roundTrip(doc);
    const elements = flattenElements(result.slides[0].elements);
    const target = elements.find(el => el.type === 'shape');
    const connector = elements.find(el => el.type === 'connector');
    expect(elements.some(el => el.type === 'group')).toBe(true);
    expect(connector?.start).toEqual({ kind: 'attached', elementId: target!.id, siteIndex: 1 });
    expect(connector?.end).toEqual({ kind: 'attached', elementId: target!.id, siteIndex: 1 });
  });

  it('refuses missing attachment targets instead of silently exporting a free line', async () => {
    const { doc, connector } = fixture('rect', 0);
    doc.slides[0].elements = [connector];
    await expect(exportPptx(doc)).rejects.toThrow('attached target is missing');
  });

  it.each([['rect', -1], ['rect', 4], ['ellipse', 8]] as const)('refuses invalid %s attachment site %i', async (kind, site) => {
    const { doc } = fixture(kind, site);
    await expect(exportPptx(doc)).rejects.toThrow('invalid attachment site');
  });
  it('writes distinct target IDs and site indices and retains special-ID animations in raw XML', async () => {
    const { doc, target, connector } = fixture('rect', 1);
    const second = { ...target, id: 'second&target' };
    connector.end = { kind: 'attached', elementId: second.id, siteIndex: 3 };
    doc.slides[0].elements.push(second);
    doc.slides[0].animations = [{ id: 'animation', elementId: target.id,
      category: 'entrance', effect: 'appear', start: 'onClick', durationMs: 500 }];
    const zip = await JSZip.loadAsync(await exportPptx(doc));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const all = (name: string) => Array.from(parsed.getElementsByTagNameNS('*', name));
    const shapeId = (name: string) => all('cNvPr').find(el => el.getAttribute('name') === name)!.getAttribute('id');
    expect(all('stCxn').map(el => [el.getAttribute('id'), el.getAttribute('idx')]))
      .toEqual([[shapeId(target.id), '3']]);
    expect(all('endCxn').map(el => [el.getAttribute('id'), el.getAttribute('idx')]))
      .toEqual([[shapeId(second.id), '1']]);
    expect(all('spTgt').map(el => el.getAttribute('spid'))).toContain(shapeId(target.id));
  });

});
