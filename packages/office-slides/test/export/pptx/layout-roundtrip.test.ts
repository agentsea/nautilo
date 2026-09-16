// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { importPptx } from '../../../src/import/pptx/index';
import { exportPptx } from '../../../src/export/pptx/index';
import { MemSlidesStore } from '../../../src/store/memory';
import { resolveBackgroundFill } from '../../../src/model/presentation';
import { buildMinimalPptx } from '../../import/pptx/__fixtures__/build-minimal-pptx';

async function customSource(explicitType = 'obj') {
  const zip = await JSZip.loadAsync(await buildMinimalPptx());
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="cust"><p:cSld name="Editorial"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4EAD7"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph ${explicitType ? `type="${explicitType}"` : ''} idx="7"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="317500"/><a:ext cx="2540000" cy="635000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="3200"><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:t>Template prompt</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('retained custom layouts', () => {
  it('retains sparse content slots and typography when creating and applying slides, then exporting', async () => {
    for (const encoding of ['obj', '']) {
      const { document } = await importPptx(await customSource(encoding));
      const layout = document.layouts.find(item => item.id === document.slides[0].layoutId)!;
      expect(layout.name).toBe('Editorial');
      expect(layout.placeholders).toHaveLength(1);
      expect(layout.placeholders[0]).toMatchObject({ placeholder: { type: 'body', index: 7 }, frame: { x: 100, y: 50, w: 400, h: 100 } });
      const store = new MemSlidesStore(document);
      let created = '';
      store.batch(() => { created = store.addSlide(layout.id); store.applyLayout(document.slides[0].id, layout.id); });
      for (const slide of store.read().slides) {
        const text = slide.elements[0];
        expect(text).toMatchObject({ placeholderRef: { type: 'body', index: 7 }, data: { blocks: [{ style: { alignment: 'center' }, inlines: [{ text: '', style: { fontSize: 32, fontFamily: 'Georgia' } }] }] } });
      }
      expect(store.read().slides.some(slide => slide.id === created)).toBe(true);
      const before = structuredClone(store.read());
      const bytes = await exportPptx(before);
      expect(store.read()).toEqual(before);
      const result = await importPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const retained = result.document.layouts.find(item => item.id === result.document.slides[0].layoutId)!;
      expect(retained.name).toBe(layout.name);
      expect(retained.background).toEqual(layout.background);
      expect(retained.placeholders[0]).toMatchObject({ frame: layout.placeholders[0].frame, placeholder: { type: 'body', index: 7 } });
      expect(retained.placeholders[0]).toMatchObject({ data: { blocks: [{ inlines: [{ style: { fontFamily: 'Georgia', fontSize: 32 } }] }] } });
    }
  });

  it('keeps each referenced layout attached to its own master across export and import', async () => {
    const { document } = await importPptx(await customSource());
    const primary = document.masters[0];
    primary.background.fill = { kind: 'srgb', value: '#662244' };
    const secondary = structuredClone(primary);
    secondary.id = 'second-master';
    secondary.background.fill = { kind: 'srgb', value: '#224466' };
    document.masters.push(secondary);
    const layout = document.layouts.find(item => item.id === document.slides[0].layoutId)!;
    delete layout.background;
    const secondLayout = structuredClone(layout);
    secondLayout.id = 'second-layout'; secondLayout.name = 'Secondary'; secondLayout.masterId = secondary.id;
    document.layouts.push(secondLayout);
    const secondSlide = structuredClone(document.slides[0]);
    secondSlide.id = 'second-slide'; secondSlide.layoutId = secondLayout.id; secondSlide.background = {};
    document.slides[0].background = {};
    document.slides.push(secondSlide);
    const expected = document.slides.map(slide => resolveBackgroundFill(slide, document));
    expect(expected).toEqual([{ kind: 'srgb', value: '#662244' }, { kind: 'srgb', value: '#224466' }]);
    const bytes = await exportPptx(document);
    const zip = await JSZip.loadAsync(bytes);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    const masterIds = [...presentation.matchAll(/<p:sldMasterId id="(\d+)"/g)].map(match => match[1]);
    const masterParts = Object.keys(zip.files).filter(path => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(path));
    const layoutIds: string[] = [];
    for (const path of masterParts) {
      const xml = await zip.file(path)!.async('string');
      layoutIds.push(...[...xml.matchAll(/<p:sldLayoutId id="(\d+)"/g)].map(match => match[1]));
    }
    expect(layoutIds.length).toBe(2);
    expect(new Set(layoutIds).size).toBe(layoutIds.length);
    expect(masterIds.length).toBe(2);
    expect(new Set([...masterIds, ...layoutIds]).size).toBe(masterIds.length + layoutIds.length);
    const { document: result } = await importPptx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(result.slides.map(slide => resolveBackgroundFill(slide, result))).toEqual(expected);
    expect(result.slides.map(slide => {
      const used = result.layouts.find(item => item.id === slide.layoutId)!;
      return result.masters.find(master => master.id === used.masterId)!.background.fill;
    })).toEqual(expected);
  });
});
