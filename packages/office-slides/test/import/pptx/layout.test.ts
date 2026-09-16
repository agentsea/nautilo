// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseLayout, type LayoutBackgroundContext } from '../../../src/import/pptx/layout';
import { ImportReport } from '../../../src/import/pptx/report';
import { slotRefsForLayout } from '../../../src/model/layout';
import type { PptxRel } from '../../../src/import/pptx/rels';

function layoutImageContext(
  overrides: Partial<LayoutBackgroundContext['imageCtx']> = {},
): LayoutBackgroundContext['imageCtx'] {
  return {
    archive: {
      readText: async () => undefined,
      readBytes: async () => undefined,
      list: () => [],
    },
    slidePartPath: 'ppt/slideLayouts/slideLayout1.xml',
    rels: new Map<string, PptxRel>(),
    scale: { sx: 1, sy: 1 },
    report: new ImportReport(),
    ...overrides,
  };
}

function layoutXml(type: string): string {
  return `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="${type}">
  <p:cSld name="Layout"><p:spTree/></p:cSld>
</p:sldLayout>`;
}

describe('parseLayout', () => {
  it('retains a custom source layout identity, master, background and sparse placeholder slot', async () => {
    const xml = `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="cust">
      <p:cSld name="Editorial &amp; Chart"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4EAD7"/></a:solidFill></p:bgPr></p:bg><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="7"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="952500" y="476250"/><a:ext cx="3810000" cy="952500"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle><a:p><a:r><a:t>Heading</a:t></a:r></a:p></p:txBody>
      </p:sp></p:spTree></p:cSld></p:sldLayout>`;
    const report = new ImportReport();
    const imported = await parseLayout(xml, 'ppt/slideLayouts/editorial.xml', report, {
      imageCtx: layoutImageContext({ scale: { sx: 1 / 9525, sy: 1 / 9525 } }), clrMap: new Map(), masterId: 'imported-master-2',
    });
    expect(imported.layout).toMatchObject({ id: 'imported-ppt/slideLayouts/editorial.xml',
      masterId: 'imported-master-2', name: 'Editorial & Chart',
      background: { fill: { kind: 'srgb', value: '#F4EAD7' } },
      placeholders: [{ frame: { x: 100, y: 50, w: 400, h: 100, rotation: 0 }, placeholder: { type: 'title', index: 7 } }],
    });
    expect(slotRefsForLayout(imported.layout)).toEqual([{ type: 'title', index: 7 }]);
    expect(report.unknownLayoutTypes).toBe(0);
  });

  it('maps the four types used by the benchmark deck', async () => {
    const r = new ImportReport();
    expect((await parseLayout(layoutXml('tx'), 'l1', r)).layout.id).toBe('title-body');
    expect((await parseLayout(layoutXml('secHead'), 'l2', r)).layout.id).toBe('section-header');
    expect((await parseLayout(layoutXml('body'), 'l3', r)).layout.id).toBe('one-column-text');
    expect((await parseLayout(layoutXml('title'), 'l4', r)).layout.id).toBe('title-slide');
    expect(r.unknownLayoutTypes).toBe(0);
  });

  it('falls back to title-body and counts unknown types', async () => {
    const r = new ImportReport();
    const out = await parseLayout(layoutXml('mediaText'), 'lx', r);
    expect(out.layout.id).toBe('title-body');
    expect(r.unknownLayoutTypes).toBe(1);
  });

  it('preserves the OOXML part name for later rels resolution', async () => {
    const r = new ImportReport();
    const out = await parseLayout(layoutXml('blank'), 'ppt/slideLayouts/slideLayout11.xml', r);
    expect(out.ooxmlPartName).toBe('ppt/slideLayouts/slideLayout11.xml');
    expect(out.layout.id).toBe('blank');
    expect(out.placeholderSizes.size).toBe(0);
    expect(out.background).toBeUndefined();
  });

  it('extracts placeholder default font sizes from <a:lstStyle><a:lvl1pPr><a:defRPr sz>', async () => {
    // Mirrors the benchmark deck's slideLayout1.xml, where the ctrTitle
    // placeholder carries sz="5200" (52pt) as its default. Without
    // reading this, slide-level runs with no explicit sz collapse to
    // the docs renderer's 11pt fallback.
    const xml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title">
  <p:cSld name="Title Slide">
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle><a:lvl1pPr><a:defRPr sz="5200"/></a:lvl1pPr></a:lstStyle>
          <a:p><a:r><a:t/></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1" type="subTitle"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>
          <a:p><a:r><a:t/></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
    const out = await parseLayout(xml, 'ppt/slideLayouts/slideLayout1.xml', new ImportReport());
    // `ctrTitle` is normalized to `title` so a slide-level `<p:ph type="title"/>`
    // (the common Google-Slides export) inherits this layout default.
    expect(out.placeholderSizes.get('title:0')).toBe(52);
    expect(out.placeholderSizes.get('subTitle:1')).toBe(24);
  });

  it('extracts placeholder default alignment from <a:lstStyle><a:lvl1pPr algn>', async () => {
    // Mirrors slideLayout4.xml of the Naver deck, whose title placeholder
    // centers via `<a:lvl1pPr algn="ctr">` while the slide paragraph and
    // master titleStyle carry no `algn` (master is even `algn="l"`).
    const xml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="titleOnly">
  <p:cSld name="Title Only">
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="7200"/></a:lvl1pPr></a:lstStyle>
          <a:p><a:r><a:t/></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1" type="body"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></a:lstStyle>
          <a:p><a:r><a:t/></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
    const out = await parseLayout(xml, 'ppt/slideLayouts/slideLayout4.xml', new ImportReport());
    expect(out.placeholderAlignments.get('title:0')).toBe('center');
    // A placeholder whose lvl1pPr has no algn contributes no default.
    expect(out.placeholderAlignments.has('body:1')).toBe(false);
  });

  it('parses a layout <p:bg> blipFill into layout.background.image', async () => {
    // slideLayout1.xml of the Naver deck references image6.png (BytePlus
    // logo + bottom gradient) as its background. Slide 1 has no <p:bg> of
    // its own, so this layout background is what must render.
    const xml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="title">
  <p:cSld name="Title Slide">
    <p:bg><p:bgPr>
      <a:blipFill dpi="0" rotWithShape="1">
        <a:blip r:embed="rId2"/>
        <a:stretch><a:fillRect/></a:stretch>
      </a:blipFill>
      <a:effectLst/>
    </p:bgPr></p:bg>
    <p:spTree/>
  </p:cSld>
</p:sldLayout>`;
    const uploaded: string[] = [];
    const imageCtx = layoutImageContext({
      archive: {
        readText: async () => undefined,
        readBytes: async () => new Uint8Array([1, 2, 3]),
        list: () => [],
      },
      slidePartPath: 'ppt/slideLayouts/slideLayout1.xml',
      rels: new Map<string, PptxRel>([
        ['rId2', { type: 'image', target: '../media/image6.png', external: false }],
      ]),
      uploadImage: async (_bytes: Uint8Array, mime: string) => {
        uploaded.push(mime);
        return 'blob:image6';
      },
      scale: { sx: 1, sy: 1 },
      report: new ImportReport(),
    });
    const out = await parseLayout(xml, 'ppt/slideLayouts/slideLayout1.xml', new ImportReport(), {
      imageCtx,
      clrMap: new Map(),
    });
    expect(out.background?.image?.src).toBe('blob:image6');
    expect(uploaded).toEqual(['image/png']);
  });

  it('extracts placeholder frames (scaled) when a bgCtx with scale is provided', async () => {
    const xml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title">
  <p:cSld name="Title Slide"><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr/>
        <p:nvPr><p:ph sz="quarter" idx="10"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="1000" y="2000"/><a:ext cx="4000" cy="500"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t/></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`;
    const out = await parseLayout(xml, 'l', new ImportReport(), {
      imageCtx: layoutImageContext({ scale: { sx: 2, sy: 3 } }),
      clrMap: new Map(),
    });
    expect(out.placeholderFrames.get('body:10')).toMatchObject({
      x: 2000,
      y: 6000,
      w: 8000,
      h: 1500,
    });
  });

  it('inherits master placeholder geometry per axis and lets the layout override it', async () => {
    const masterFrame = { x: 10, y: 20, w: 300, h: 80, rotation: 0 };
    const parse = (xfrm = '') => parseLayout(`<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`, 'l', new ImportReport(), {
        imageCtx: layoutImageContext(), clrMap: new Map(), masterId: 'm',
        masterPlaceholderFrames: new Map([['title:0', masterFrame]]),
      });
    const inherited = await parse();
    expect(inherited.placeholderFrames.get('title:0')).toEqual(masterFrame);
    expect(inherited.layout.placeholders[0]?.frame).toEqual(masterFrame);
    expect((await parse('<a:xfrm><a:off x="40" y="50"/></a:xfrm>')).placeholderFrames.get('title:0'))
      .toEqual({ x: 40, y: 50, w: 300, h: 80, rotation: 0 });
    expect((await parse('<a:xfrm><a:ext cx="600" cy="160"/></a:xfrm>')).placeholderFrames.get('title:0'))
      .toEqual({ x: 10, y: 20, w: 600, h: 160, rotation: 0 });
    expect((await parse('<a:xfrm><a:off x="40" y="50"/><a:ext cx="600" cy="160"/></a:xfrm>')).placeholderFrames.get('title:0'))
      .toEqual({ x: 40, y: 50, w: 600, h: 160, rotation: 0 });
  });

  it('yields empty placeholderFrames when no bgCtx (no scale) is provided', async () => {
    const out = await parseLayout(layoutXml('title'), 'l', new ImportReport());
    expect(out.placeholderFrames.size).toBe(0);
  });

  it('leaves layout.background undefined for a <p:bgRef> style-matrix reference', async () => {
    const xml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title">
  <p:cSld name="Title Slide">
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree/>
  </p:cSld>
</p:sldLayout>`;
    const out = await parseLayout(xml, 'l', new ImportReport(), {
      imageCtx: layoutImageContext(),
      clrMap: new Map(),
    });
    expect(out.background).toBeUndefined();
  });
});
