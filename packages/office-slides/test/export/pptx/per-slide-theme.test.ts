import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportPptx } from '../../../src/export/pptx/index.js';
import { DEFAULT_MASTER } from '../../../src/model/master.js';
import type { SlidesDocument } from '../../../src/model/presentation.js';
import { defaultLight } from '../../../src/themes/default-light.js';

describe('PPTX per-slide themes', () => {
  it('emits one theme relationship for each independently themed master', async () => {
    const alternate = {
      ...structuredClone(defaultLight),
      id: 'alternate',
      name: 'Alternate',
      colors: { ...defaultLight.colors, accent1: '#C026D3' },
    };
    const document: SlidesDocument = {
      meta: { title: 'Two themes', themeId: defaultLight.id, masterId: 'master-one' },
      themes: [structuredClone(defaultLight), alternate],
      masters: [
        { ...structuredClone(DEFAULT_MASTER), id: 'master-one', themeId: defaultLight.id },
        { ...structuredClone(DEFAULT_MASTER), id: 'master-two', themeId: alternate.id },
      ],
      layouts: [
        { id: 'layout-one', masterId: 'master-one', name: 'One', placeholders: [], staticElements: [] },
        { id: 'layout-two', masterId: 'master-two', name: 'Two', placeholders: [], staticElements: [] },
      ],
      slides: [
        { id: 'slide-one', layoutId: 'layout-one', background: {}, elements: [], notes: [] },
        { id: 'slide-two', layoutId: 'layout-two', themeId: alternate.id, background: {}, elements: [], notes: [] },
      ],
      guides: [],
    };

    const zip = await JSZip.loadAsync(await exportPptx(document));
    expect(zip.file('ppt/theme/theme1.xml')).not.toBeNull();
    expect(zip.file('ppt/theme/theme2.xml')).not.toBeNull();
    const firstRels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string');
    const secondRels = await zip.file('ppt/slideMasters/_rels/slideMaster2.xml.rels')!.async('string');
    expect(firstRels).toContain('Target="../theme/theme1.xml"');
    expect(secondRels).toContain('Target="../theme/theme2.xml"');
    expect(await zip.file('ppt/theme/theme2.xml')!.async('string')).toContain('val="C026D3"');
  });

  it('qualifies a shared master by theme in the export clone without mutating the deck', async () => {
    const alternate = {
      ...structuredClone(defaultLight),
      id: 'alternate',
      colors: { ...defaultLight.colors, accent1: '#C026D3' },
    };
    const document: SlidesDocument = {
      meta: { title: 'Shared master', themeId: defaultLight.id, masterId: 'shared-master' },
      themes: [structuredClone(defaultLight), alternate],
      masters: [{ ...structuredClone(DEFAULT_MASTER), id: 'shared-master', themeId: defaultLight.id }],
      layouts: [{ id: 'shared-layout', masterId: 'shared-master', name: 'Shared', placeholders: [], staticElements: [] }],
      slides: [
        { id: 'legacy', layoutId: 'shared-layout', background: {}, elements: [], notes: [] },
        { id: 'template', layoutId: 'shared-layout', themeId: alternate.id, background: {}, elements: [], notes: [] },
      ],
      guides: [],
    };
    const before = JSON.stringify(document);

    const zip = await JSZip.loadAsync(await exportPptx(document));

    expect(zip.file('ppt/slideMasters/slideMaster2.xml')).not.toBeNull();
    expect(zip.file('ppt/slideLayouts/slideLayout2.xml')).not.toBeNull();
    const secondMasterRels = await zip.file('ppt/slideMasters/_rels/slideMaster2.xml.rels')!.async('string');
    const templateSlideRels = await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string');
    expect(secondMasterRels).toContain('Target="../theme/theme2.xml"');
    expect(templateSlideRels).toContain('Target="../slideLayouts/slideLayout2.xml"');
    expect(JSON.stringify(document)).toBe(before);
  });
});
