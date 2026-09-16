// Modified by Nautilo: resolve the owned Office workspace packages.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { exportPptx } from '../../../src/export/pptx/index.js';
import { importPptx } from '../../../src/import/pptx/index.js';
import { buildMinimalPptx } from '../../import/pptx/__fixtures__/build-minimal-pptx.js';
import { MemSlidesStore } from '../../../src/store/memory.js';
import { DEFAULT_BLOCK_STYLE } from '@nautilo/office-docs';
import type { ChartElement, TextElement } from '../../../src/model/element.js';

function textElementWithHref(href: string): TextElement {
  return {
    id: 'link-box',
    type: 'text',
    frame: { x: 10, y: 10, w: 200, h: 40, rotation: 0 },
    data: {
      blocks: [
        {
          id: 'b1',
          type: 'paragraph',
          inlines: [{ text: 'click', style: { href } }],
          style: { ...DEFAULT_BLOCK_STYLE },
        },
      ],
    },
  };
}

describe('exportPptx', () => {
  it('wires the synthesized master to its theme and fallback layout', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    deck.masters = [];
    deck.layouts = [];
    const zip = await JSZip.loadAsync(await exportPptx(deck));
    const master = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    const rels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string');
    const masterId = presentation.match(/<p:sldMasterId id="(\d+)"/);
    const layoutId = master.match(/<p:sldLayoutId id="(\d+)" r:id="([^"]+)"/);
    expect(masterId).not.toBeNull();
    expect(layoutId).not.toBeNull();
    expect(layoutId![1]).not.toBe(masterId![1]);
    expect(rels).toContain(`Id="${layoutId![2]}"`);
    expect(rels).toContain('Target="../slideLayouts/slideLayout1.xml"');
    expect(rels).toContain('Target="../theme/theme1.xml"');
  });

  it('exports sparse chart coordinates without changing the original deck', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    const chart: ChartElement = {
      id: 'sales-chart',
      type: 'chart',
      frame: { x: 10, y: 10, w: 400, h: 240, rotation: 0 },
      data: {
        kind: 'column',
        categories: ['Q1', 'Q5001'],
        categoryIndices: [0, 5000],
        series: [{ name: 'Sales', values: [10, 20] }],
      },
    };
    deck.slides[0].elements.push(chart);
    const original = structuredClone(deck);

    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('ppt/charts/chart1.xml')).not.toBeNull();
    expect(zip.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx')).not.toBeNull();
    expect(deck).toEqual(original);
  });

  it('rejects an unrepresentable list level without changing the original deck', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    const element = textElementWithHref('https://example.com');
    element.data.blocks[0].type = 'list-item';
    element.data.blocks[0].listKind = 'unordered';
    element.data.blocks[0].listLevel = 9;
    deck.slides[0].elements.push(element);
    const original = structuredClone(deck);

    await expect(exportPptx(deck)).rejects.toThrow('PPTX supports nine list levels');
    expect(deck).toEqual(original);

    element.data.blocks[0].listLevel = 8;
    const zip = await JSZip.loadAsync(await exportPptx(deck));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('lvl="8"');
  });

  it('produces a zip with required parts that re-imports', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('ppt/presentation.xml')).not.toBeNull();
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull();
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    // Re-import must not throw and yields one slide.
    // Use transferToFixedLength / slice to get a plain ArrayBuffer.
    const reimportBuf: ArrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const reimported = await importPptx(reimportBuf);
    expect(reimported.document.slides).toHaveLength(1);
  });

  it('deck with layouts:[] still produces ppt/slideLayouts/slideLayout1.xml', async () => {
    // Fix 8: when layouts is empty, a synthetic blank layout must be emitted so
    // every slide's layout rel resolves to a valid part.
    const { document: base } = await importPptx(await buildMinimalPptx());
    const deck = { ...base, layouts: [] };
    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('ppt/slideLayouts/slideLayout1.xml')).not.toBeNull();
  });

  it('preserves slide layouts owned by the retained default master when exporting an imported master', async () => {
    const store = new MemSlidesStore();
    store.batch(() => {
      store.addSlide('title-slide');
      store.addSlide('title-body');
    });
    const deck = store.read();
    const importedMaster = structuredClone(deck.masters[0]);
    importedMaster.id = 'imported-master';
    deck.masters = [importedMaster, ...deck.masters];
    deck.meta.masterId = importedMaster.id;
    const original = structuredClone(deck);

    const bytes = await exportPptx(deck);
    expect(deck).toEqual(original);

    const zip = await JSZip.loadAsync(bytes);
    const layoutParts = Object.keys(zip.files).filter((path) =>
      /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path),
    );
    expect(layoutParts).toHaveLength(2);

    const relationshipTargets = await Promise.all(
      deck.slides.map(async (_slide, index) => {
        const rels = await zip
          .file(`ppt/slides/_rels/slide${index + 1}.xml.rels`)!
          .async('string');
        return rels.match(/Type="[^"]*\/slideLayout" Target="([^"]+)"/)?.[1];
      }),
    );
    expect(new Set(relationshipTargets).size).toBe(2);

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const roundTripped = await importPptx(buffer);
    expect(roundTripped.document.slides.map(slide => roundTripped.document.layouts.find(layout => layout.id === slide.layoutId)?.name)).toEqual(['Title slide', 'Title and body']);
  });

  it('exports a custom master background fill onto inheriting slides', async () => {
    // Theme-builder regression: a slide that inherits its background
    // (no explicit fill) must export the resolved master fill, not the
    // theme background role.
    const store = new MemSlidesStore();
    store.batch(() => {
      store.updateMaster('default', {
        background: { fill: { kind: 'srgb', value: '#FF0000' } },
      });
      store.addSlide('blank');
    });
    const bytes = await exportPptx(store.read());
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const bg = xml.match(/<p:bg>.*?<\/p:bg>/s)?.[0] ?? '';
    expect(bg).toMatch(/srgbClr val="FF0000"/i);
  });

  it('reports background-image and radial-gradient loss to an opted-in caller', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    deck.slides[0].background = {
      image: { src: 'https://example.com/background.png' },
      fill: {
        kind: 'gradient', type: 'radial', angle: 0,
        stops: [
          { pos: 0, color: { kind: 'srgb', value: '#FFFFFF' } },
          { pos: 1, color: { kind: 'srgb', value: '#000000' } },
        ],
      },
    };
    const warnings: string[] = [];
    await exportPptx(deck, { onFidelityWarning: warning => warnings.push(warning) });
    expect(warnings).toEqual([
      'slide 1: background image is not supported by PPTX export; the fallback fill was exported.',
      'slide 1: radial background gradient is not supported by PPTX export; a linear gradient was exported.',
    ]);
  });

  it('exports a text-run hyperlink as an external rel and round-trips it', async () => {
    const { document: base } = await importPptx(await buildMinimalPptx());
    const url = 'https://example.com/a?x=1&y=2';
    const deck = {
      ...base,
      slides: [
        {
          ...base.slides[0],
          elements: [...base.slides[0].elements, textElementWithHref(url)],
        },
        ...base.slides.slice(1),
      ],
    };

    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);

    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const hlink = slideXml.match(/<a:hlinkClick r:id="(rId\d+)"\/>/);
    expect(hlink).not.toBeNull();
    const rId = hlink![1];

    const relsXml = await zip
      .file('ppt/slides/_rels/slide1.xml.rels')!
      .async('string');
    // The rel must be external, target the (XML-escaped) URL, and match rId.
    expect(relsXml).toContain(`Id="${rId}"`);
    expect(relsXml).toContain('TargetMode="External"');
    expect(relsXml).toContain('Target="https://example.com/a?x=1&amp;y=2"');
    expect(relsXml).toContain('relationships/hyperlink');

    // Re-import: the href must survive back onto the run.
    const reimportBuf: ArrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const { document: back } = await importPptx(reimportBuf);
    const hrefs: string[] = [];
    for (const el of back.slides[0].elements) {
      if (el.type === 'text') {
        for (const block of el.data.blocks) {
          for (const inline of block.inlines) {
            if (inline.style.href) hrefs.push(inline.style.href);
          }
        }
      }
    }
    expect(hrefs).toContain(url);
  });

  it('retains slide placeholder identity so master typography remains applicable', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    const title = textElementWithHref('https://example.com');
    title.placeholderRef = { type: 'title', index: 0 };
    deck.slides[0].elements.push(title);
    const bytes = await exportPptx(deck);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<p:ph type="title" idx="0"/>');
    const reimported = await importPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(reimported.document.slides[0].elements.find(element => element.type === 'text')?.placeholderRef)
      .toEqual({ type: 'title', index: 0 });
  });

  it('rejects an invalid slide placeholder reference before emitting OOXML', async () => {
    const { document: deck } = await importPptx(await buildMinimalPptx());
    const title = textElementWithHref('https://example.com');
    title.placeholderRef = { type: 'title', index: -1 };
    deck.slides[0].elements.push(title);
    await expect(exportPptx(deck)).rejects.toThrow('Cannot export an invalid slide placeholder reference.');
  });
});
