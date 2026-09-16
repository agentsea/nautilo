// Modified by Nautilo: resolve the owned Office workspace packages.
/**
 * PPTX export orchestrator.
 *
 * `exportPptx` assembles a complete `.pptx` archive from a `SlidesDocument`:
 *   1. Pre-scans all elements for image `src` values (deduped).
 *   2. Optionally fetches each image via `opts.fetchImage` and adds media parts.
 *   3. Emits theme / master / layout parts with the correct rel chain.
 *   4. Emits each slide part; wires slide→layout rels and image rels per slide.
 *   5. Emits `ppt/presentation.xml` with slide-id list and master-id list.
 *   6. Returns `writer.build()` — a complete in-memory zip as `Uint8Array`.
 *
 * ## Rel chain (mirrors what import/pptx/index.ts traverses)
 *   _rels/.rels              → ppt/presentation.xml (officeDocument)
 *   ppt/_rels/presentation.xml.rels
 *     → ppt/theme/theme1.xml     (theme)
 *     → ppt/slideMasters/slideMaster1.xml  (slideMaster)
 *     → ppt/slides/slideN.xml    (slide, one per slide)
 *   ppt/slideMasters/_rels/slideMaster1.xml.rels
 *     → ppt/theme/theme1.xml     (theme)
 *     → ppt/slideLayouts/slideLayoutN.xml  (slideLayout, one per layout)
 *   ppt/slideLayouts/_rels/slideLayoutN.xml.rels
 *     → ppt/slideMasters/slideMaster1.xml  (slideMaster)
 *   ppt/slides/_rels/slideN.xml.rels
 *     → ppt/slideLayouts/slideLayoutM.xml  (slideLayout — the slide's layout)
 *     → ppt/media/imageK.{ext}             (image, one per image element)
 *
 * ## Image handling
 *   If `opts.fetchImage` is absent and a slide has image elements whose `src`
 *   is a data-URL or remote URL that cannot be resolved at build time, we
 *   throw a clear error rather than silently writing broken rId references.
 *   Callers that don't need images can pass a deck with no image elements and
 *   omit `opts.fetchImage`.
 *
 * ## Content types added
 *   - presentation.xml:    presentationml.presentation.main+xml
 *   - theme/themeN.xml:    theme+xml
 *   - slideMasters/…:      presentationml.slideMaster+xml
 *   - slideLayouts/…:      presentationml.slideLayout+xml
 *   - slides/slideN.xml:   presentationml.slide+xml
 *   - slides/notesN.xml:   presentationml.notesSlide+xml
 */

import type { SlidesDocument } from '../../model/presentation.js';
import { getThemeForSlide, resolveBackgroundFill } from '../../model/presentation.js';
import { yieldToPaint } from '../yield.js';
import type { ImageElement } from '../../model/element.js';
import { flattenElements, buildElementWorldLookup } from '../../model/group.js';
import { computeConnectorFrame } from '../../view/canvas/connector-frame.js';
import { PptxWriter } from './zip.js';
import { REL_TYPES } from './templates.js';
import { themeToXml } from './theme.js';
import { masterToXml } from './master.js';
import { layoutToXml } from './layout.js';
import { slideToXml, notesSlideToXml } from './slide.js';
import { presentationToXml } from './presentation.js';
import type { ElementXmlCtx } from './group.js';
import { chartToXml, chartWorkbook } from './chart.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExportPptxOptions {
  /**
   * Called once per unique image `src` across all slides. Must return the
   * raw image bytes and MIME type so the exporter can embed the file in the
   * `ppt/media/` directory.
   *
   * Required if the deck contains `ImageElement` elements. Omit only when
   * the deck has no images — attempting to export a deck with images without
   * this option throws a clear error rather than writing broken XML.
   */
  fetchImage?: (src: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  /**
   * Opt in to surviving an image `fetchImage` could not deliver: the failure
   * is reported here and the element is left out of its slide, instead of
   * failing the whole deck.
   *
   * Supplying it is the choice, so it never happens by default. The CLI
   * passes one because its SSRF guard makes a refused `src` an ordinary
   * outcome — the same reason the docs PDF/DOCX exporters take a reporter —
   * while the browser export keeps the loud failure its UI can report.
   */
  onImageError?: (src: string, error: unknown) => void;
  /** Reports a successful export whose target format cannot retain an effect. */
  onFidelityWarning?: (warning: string) => void;
  /** Progress callback: `(done, total, 'slides')` once before work, then after each serialized slide. */
  onProgress?: (done: number, total: number, phase: string) => void;
}

// ---------------------------------------------------------------------------
// MIME → file extension helper
// ---------------------------------------------------------------------------

/** Map a MIME type to the file extension used in `ppt/media/`. */
function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

// ---------------------------------------------------------------------------
// Content-type constants
// ---------------------------------------------------------------------------

const CT_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CT_THEME =
  'application/vnd.openxmlformats-officedocument.theme+xml';
const CT_SLIDE_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_SLIDE_LAYOUT =
  'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * PPTX assigns one theme to a slide master, while the native model permits a
 * scoped slide theme override. Split only conflicting master/layout ownership
 * in an export clone so routine layout changes remain exportable and the live
 * document is never rewritten.
 */
function qualifyThemeOwnershipForPptx(source: SlidesDocument): SlidesDocument {
  const deck = structuredClone(source);
  const usedIds = new Set<string>([
    ...deck.masters.map(master => master.id),
    ...deck.layouts.map(layout => layout.id),
  ]);
  let sequence = 0;
  const fresh = (kind: 'master' | 'layout'): string => {
    let id: string;
    do id = `__pptx-${kind}-${++sequence}`; while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  for (const master of [...deck.masters]) {
    const ownedLayouts = deck.layouts.filter(layout => layout.masterId === master.id);
    const ownedLayoutIds = new Set(ownedLayouts.map(layout => layout.id));
    const themes = new Set(
      deck.slides
        .filter(slide => ownedLayoutIds.has(slide.layoutId))
        .map(slide => getThemeForSlide(deck, slide).id),
    );
    if (themes.size === 0) {
      master.themeId = deck.meta.themeId;
      continue;
    }
    const baseTheme = themes.has(deck.meta.themeId) ? deck.meta.themeId : themes.values().next().value!;
    master.themeId = baseTheme;
    for (const themeId of themes) {
      if (themeId === baseTheme) continue;
      const splitMaster = { ...structuredClone(master), id: fresh('master'), themeId };
      deck.masters.push(splitMaster);
      for (const layout of ownedLayouts) {
        const matchingSlides = deck.slides.filter(
          slide => slide.layoutId === layout.id && getThemeForSlide(deck, slide).id === themeId,
        );
        if (matchingSlides.length === 0) continue;
        const splitLayout = { ...structuredClone(layout), id: fresh('layout'), masterId: splitMaster.id };
        deck.layouts.push(splitLayout);
        for (const slide of matchingSlides) slide.layoutId = splitLayout.id;
      }
    }
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Export a `SlidesDocument` to a `.pptx` binary (zip archive) returned as
 * `Uint8Array`. The bytes can be written directly to a file or served as a
 * download response.
 *
 * Node consumers should import this from `@nautilo/office-slides/node`. Browser
 * consumers can import from `@nautilo/office-slides` (same symbol, same code —
 * the orchestrator itself is DOM-free).
 */
export async function exportPptx(
  deck: SlidesDocument,
  opts: ExportPptxOptions = {},
): Promise<Uint8Array> {
  deck = qualifyThemeOwnershipForPptx(deck);
  reportBackgroundLosses(deck, opts.onFidelityWarning);
  const writer = new PptxWriter();

  // -------------------------------------------------------------------------
  // Step 1: Pre-scan all image elements across all slides (dedup by src).
  // -------------------------------------------------------------------------
  const allImageSrcs = new Set<string>();
  for (const slide of deck.slides) {
    for (const el of flattenElements(slide.elements)) {
      if (el.type === 'image') {
        allImageSrcs.add(el.data.src);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Fetch + add media; build src→mediaPath map.
  // -------------------------------------------------------------------------
  // src → the relative path under ppt/ (e.g. "media/image1.png")
  const srcToMediaPath = new Map<string, string>();

  if (allImageSrcs.size > 0) {
    if (!opts.fetchImage) {
      throw new Error(
        'exportPptx: deck contains image elements but `opts.fetchImage` is not provided. ' +
          'Supply a `fetchImage` implementation that returns { bytes, mime } for each image src.',
      );
    }
    for (const src of allImageSrcs) {
      let fetched: { bytes: Uint8Array; mime: string };
      try {
        fetched = await opts.fetchImage(src);
      } catch (error) {
        // No reporter means the caller never opted into a partial deck, so
        // the failure is theirs to handle. With one, the src stays out of the
        // media map and `resolveImageRId` drops the element.
        if (!opts.onImageError) throw error;
        opts.onImageError(src, error);
        continue;
      }
      const ext = extFromMime(fetched.mime);
      const mediaPath = writer.addMedia(fetched.bytes, ext);
      srcToMediaPath.set(src, mediaPath);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Theme parts.
  //
  // The importer picks up the theme via a `theme` rel from
  // ppt/presentation.xml. We emit the deck's first theme (which, after an
  // import, is the imported theme). If there are no themes at all, fall back
  // to the built-in default-light via a minimal synthetic XML — importPptx
  // always populates at least BUILT_IN_THEMES so this path should be rare.
  // -------------------------------------------------------------------------
  const activeTheme = deck.themes.find(theme => theme.id === deck.meta.themeId) ?? deck.themes[0];
  const themes = activeTheme ? [activeTheme] : [];
  const emittedThemeIds = new Set(themes.map(theme => theme.id));
  for (const slide of deck.slides) {
    const theme = getThemeForSlide(deck, slide);
    if (!emittedThemeIds.has(theme.id)) {
      emittedThemeIds.add(theme.id);
      themes.push(theme);
    }
  }
  const themePaths: string[] = [];
  const themeIdToPath = new Map<string, string>();
  for (let i = 0; i < themes.length; i++) {
    const theme = themes[i];
    const themePath = `ppt/theme/theme${i + 1}.xml`;
    writer.addPart(themePath, themeToXml(theme, i + 1), CT_THEME);
    themePaths.push(themePath);
    themeIdToPath.set(theme.id, themePath);
  }

  // If no theme was available (extremely unlikely), emit a placeholder path
  // so the rest of the wiring doesn't need to branch.
  const primaryThemePath = themePaths[0] ?? null;

  // -------------------------------------------------------------------------
  // Step 4: Master + layout parts.
  //
  // We emit one master (the deck's first master or DEFAULT_MASTER), its
  // layouts, and any other layouts referenced by slides. Imported documents
  // retain built-in layouts owned by DEFAULT_MASTER alongside their imported
  // master; omitting those referenced layouts would redirect every slide to
  // slideLayout1 and destroy its layout assignment. The rel chain expected by
  // the importer:
  //   presentation → master (slideMaster)
  //   master → theme (theme)
  //   master → each layout (slideLayout)
  //   layout → master (slideMaster)
  //   slide → one layout (slideLayout)
  // -------------------------------------------------------------------------
  const masterObj = deck.masters.find(master => master.id === deck.meta.masterId) ?? deck.masters[0] ?? null;
  const masterId = masterObj?.id ?? 'default';
  const layoutsToEmit = deck.layouts.filter(layout => layout.masterId === masterId || deck.slides.some(slide => slide.layoutId === layout.id));
  if (!layoutsToEmit.length && deck.layouts.length) layoutsToEmit.push(deck.layouts[0]);
  const useFallbackLayout = layoutsToEmit.length === 0;
  const FALLBACK_LAYOUT_ID = '__fallback_blank__';
  const mastersToEmit = masterObj ? [masterObj, ...deck.masters.filter(master => master.id !== masterObj.id && layoutsToEmit.some(layout => layout.masterId === master.id))] : [];
  const masterPaths = new Map(mastersToEmit.map((master, index) => [master.id, `ppt/slideMasters/slideMaster${index + 1}.xml`]));
  if (!mastersToEmit.length) masterPaths.set(masterId, 'ppt/slideMasters/slideMaster1.xml');
  const layoutIdToPath = new Map<string, string>();
  const masterLayoutRIds = new Map<string, Array<{ rId: string; id: number }>>();

  const emitLayout = (layoutId: string, xml: string, index: number, ownerId: string): void => {
    const ownerPath = masterPaths.get(ownerId);
    if (!ownerPath) throw new Error(`Cannot export layout "${layoutId}": its master "${ownerId}" is missing.`);
    const path = `ppt/slideLayouts/slideLayout${index + 1}.xml`;
    writer.addPart(path, xml, CT_SLIDE_LAYOUT);
    layoutIdToPath.set(layoutId, path);
    writer.addRel(path, REL_TYPES.slideMaster, `../${ownerPath.slice('ppt/'.length)}`);
    const rid = writer.addRel(ownerPath, REL_TYPES.slideLayout, `../slideLayouts/slideLayout${index + 1}.xml`);
    const rids = masterLayoutRIds.get(ownerId) ?? [];
    // Slide master and layout IDs share PowerPoint's presentation-wide ID
    // space. Allocate layouts after every emitted master so strict readers do
    // not repair an otherwise valid package because the first IDs collide.
    rids.push({ rId: rid, id: 2147483648 + masterPaths.size + index });
    masterLayoutRIds.set(ownerId, rids);
  };
  if (useFallbackLayout) emitLayout(FALLBACK_LAYOUT_ID, fallbackLayoutXml(), 0, masterId);
  else layoutsToEmit.forEach((layout, index) => emitLayout(layout.id, layoutToXml(layout, index + 1), index, layout.masterId));
  if (!mastersToEmit.length) writer.addPart('ppt/slideMasters/slideMaster1.xml', fallbackMasterXml(masterLayoutRIds.get(masterId) ?? []), CT_SLIDE_MASTER);
  for (const [index, master] of mastersToEmit.entries()) {
    const path = masterPaths.get(master.id)!;
    writer.addPart(path, masterToXml(master, index, masterLayoutRIds.get(master.id) ?? []), CT_SLIDE_MASTER);
  }
  for (const [masterIdForTheme, path] of masterPaths) {
    const layoutIds = new Set(
      layoutsToEmit.filter(layout => layout.masterId === masterIdForTheme).map(layout => layout.id),
    );
    const themeIds = new Set(
      deck.slides
        .filter(slide => layoutIds.has(slide.layoutId))
        .map(slide => getThemeForSlide(deck, slide).id),
    );
    if (themeIds.size > 1) throw new Error(`Internal PPTX theme qualification failed for master "${masterIdForTheme}".`);
    const themeId = themeIds.values().next().value ?? activeTheme?.id;
    const themePath = themeId ? themeIdToPath.get(themeId) : undefined;
    if (themePath) writer.addRel(path, REL_TYPES.theme, `../${themePath.slice('ppt/'.length)}`);
  }

  // -------------------------------------------------------------------------
  // Step 5: Slide parts — emit each slide, wire image + layout rels.
  // -------------------------------------------------------------------------
  const slideRIds: string[] = [];
  let chartSequence = 0;

  const onProgress = opts.onProgress;
  const slideTotal = deck.slides.length;
  onProgress?.(0, slideTotal, 'slides');

  for (let i = 0; i < slideTotal; i++) {
    const slide = deck.slides[i];
    const slidePath = `ppt/slides/slide${i + 1}.xml`;

    // Build the world-element lookup for connector geometry.
    const worldLookup = buildElementWorldLookup(slide.elements);

    const slideChartRIds = new Map<string, string>();
    for (const element of flattenElements(slide.elements)) {
      if (element.type !== 'chart') continue;
      const chart = element;
      const chartNumber = ++chartSequence;
      const chartPath = `ppt/charts/chart${chartNumber}.xml`;
      const workbookPath = `ppt/embeddings/Microsoft_Excel_Worksheet${chartNumber}.xlsx`;
      writer.addBinaryPart(workbookPath, await chartWorkbook(chart), CT_XLSX);
      const workbookRId = writer.addRel(chartPath, REL_TYPES.package, `../embeddings/Microsoft_Excel_Worksheet${chartNumber}.xlsx`);
      writer.addPart(chartPath, chartToXml(chart, workbookRId, chartNumber), CT_CHART);
      slideChartRIds.set(chart.id, writer.addRel(slidePath, REL_TYPES.chart, `../charts/chart${chartNumber}.xml`));
    }

    // Build per-slide image rId resolver.
    // src → rId is slide-local (each slide has its own .rels file).
    const slideImageRIdCache = new Map<string, string>();
    function resolveImageRId(el: ImageElement): string | null {
      const src = el.data.src;
      const cached = slideImageRIdCache.get(src);
      if (cached) return cached;
      const mediaPath = srcToMediaPath.get(src);
      if (!mediaPath) {
        // Every src was pre-scanned, so the only way one is missing is a fetch
        // the caller chose to survive via `onImageError`. `null` drops the
        // element rather than writing an invalid `r:embed=""`; with no
        // reporter the fetch loop above already threw.
        return null;
      }
      // Add an image rel for this slide (target is relative to slide's dir).
      const rId = writer.addRel(slidePath, REL_TYPES.image, `../${mediaPath}`);
      slideImageRIdCache.set(src, rId);
      return rId;
    }

    // Build per-slide hyperlink rId resolver. Like images, hyperlink rels
    // are slide-local; de-dupe by target so repeated links share one rel.
    // The target is an external URL (`TargetMode="External"`).
    const slideHyperlinkRIdCache = new Map<string, string>();
    function resolveHyperlinkRId(href: string): string {
      const cached = slideHyperlinkRIdCache.get(href);
      if (cached) return cached;
      const rId = writer.addRel(slidePath, REL_TYPES.hyperlink, href, true);
      slideHyperlinkRIdCache.set(href, rId);
      return rId;
    }

    const ctx: ElementXmlCtx = {
      resolveImageRId,
      connectorFrame: (el) => computeConnectorFrame(el, worldLookup),
      resolveHyperlinkRId,
      resolveChartRId: (chart) => {
        const rId = slideChartRIds.get(chart.id);
        if (!rId) throw new Error(`Cannot resolve chart relationship for "${chart.id}".`);
        return rId;
      },
    };

    // Always serialize the *resolved* effective fill (slide → layout →
    // master → role) so master/layout background edits round-trip. A real
    // slide override returns itself; an inheriting slide — whether it has
    // no fill OR a bare `{role:'background'}` fill (the legacy default,
    // which resolveBackgroundFill also treats as inherit) — resolves to
    // the master/layout color. Background *images* are still not exported
    // (see backgroundToXml).
    const slideForXml = {
      ...slide,
      background: {
        ...slide.background,
        fill: resolveBackgroundFill(slide, deck),
      },
    };

    // Emit slide XML.
    writer.addPart(slidePath, slideToXml(slideForXml, ctx), CT_SLIDE);

    // Determine this slide's layout. Fall back to first layout or blank.
    const resolvedLayoutPath =
      layoutIdToPath.get(slide.layoutId) ?? 'ppt/slideLayouts/slideLayout1.xml';

    // Image rels are added during slideToXml() via resolveImageRId.
    // Add the layout rel after so it follows any image rels in rId order.
    writer.addRel(slidePath, REL_TYPES.slideLayout, `../${resolvedLayoutPath.slice('ppt/'.length)}`);

    // Notes slide — if the slide has non-empty notes, emit a notes part.
    if (slide.notes && slide.notes.length > 0) {
      const notesPath = `ppt/notesSlides/notesSlide${i + 1}.xml`;
      writer.addPart(notesPath, notesSlideToXml(slide.notes), CT_NOTES);
      writer.addRel(slidePath, REL_TYPES.notesSlide, `../notesSlides/notesSlide${i + 1}.xml`);
    }

    // Collect the rId for this slide in presentation.xml.rels (added below).
    const slideRId = writer.addRel(
      'ppt/presentation.xml',
      REL_TYPES.slide,
      `slides/slide${i + 1}.xml`,
    );
    slideRIds.push(slideRId);
    onProgress?.(i + 1, slideTotal, 'slides');
    // Only yield on the interactive (progress-reporting) path; headless/CLI
    // exports gain nothing from the extra event-loop turn per slide.
    if (onProgress && i + 1 < slideTotal) await yieldToPaint();
  }

  // -------------------------------------------------------------------------
  // Step 6: presentation.xml → master rel + theme rel.
  // -------------------------------------------------------------------------
  const masterRIds = [...masterPaths.values()].map(path => writer.addRel(
    'ppt/presentation.xml', REL_TYPES.slideMaster, path.slice('ppt/'.length),
  ));

  if (primaryThemePath) {
    writer.addRel('ppt/presentation.xml', REL_TYPES.theme, 'theme/theme1.xml');
  }

  // -------------------------------------------------------------------------
  // Step 7: presentation.xml part.
  // -------------------------------------------------------------------------
  writer.addPart(
    'ppt/presentation.xml',
    presentationToXml(deck, slideRIds, masterRIds),
    CT_PRESENTATION,
  );

  // -------------------------------------------------------------------------
  // Step 8: Build and return the zip.
  // -------------------------------------------------------------------------
  return writer.build();
}

function reportBackgroundLosses(
  deck: SlidesDocument,
  report: ExportPptxOptions['onFidelityWarning'],
): void {
  if (!report) return;
  const backgrounds = [
    ...deck.masters.map(master => [`master "${master.id}"`, master.background] as const),
    ...deck.layouts.map(layout => [`layout "${layout.name}"`, layout.background] as const),
    ...deck.slides.map((slide, index) => [`slide ${index + 1}`, slide.background] as const),
  ];
  for (const [owner, background] of backgrounds) {
    if (background?.image) report(`${owner}: background image is not supported by PPTX export; the fallback fill was exported.`);
    if (background?.fill?.kind === 'gradient' && background.fill.type === 'radial') {
      report(`${owner}: radial background gradient is not supported by PPTX export; a linear gradient was exported.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback layout XML (used when the deck has no layouts at all)
// ---------------------------------------------------------------------------

/**
 * Emit a bare-minimum blank slide layout when the deck has no layout records.
 * This ensures every slide's layout rel resolves to a valid part even for
 * programmatically constructed decks that omit layout data.
 */
function fallbackLayoutXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldLayout` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
    ` type="blank"` +
    `>` +
    `<p:cSld>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree>` +
    `</p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sldLayout>`
  );
}

// ---------------------------------------------------------------------------
// Fallback master XML (used when the deck has no masters at all — rare)
// ---------------------------------------------------------------------------

/**
 * Emit a bare-minimum slide master when the deck has no master records.
 * This avoids a crash while still producing a structurally valid archive.
 */
function fallbackMasterXml(layoutRIds: Array<{ rId: string; id: number }> = []): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldMaster` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
    `>` +
    `<p:cSld>` +
    `<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree>` +
    `</p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst>${layoutRIds.map(entry => `<p:sldLayoutId id="${entry.id}" r:id="${entry.rId}"/>`).join('')}</p:sldLayoutIdLst>` +
    `</p:sldMaster>`
  );
}
