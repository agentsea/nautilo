import {
  deckFontScale,
  flattenElements,
  getThemeForSlide,
  type MemSlidesStore,
  type SlidesDocument,
} from "../engine/node.js";

/** Capture one slide and only the design resources needed to render it. */
export function captureSlideTemplate(
  document: SlidesDocument,
  slideId: string,
): SlidesDocument {
  const slide = document.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error(`Slide not found: ${slideId}`);
  const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
  if (!layout) throw new Error(`Slide layout not found: ${slide.layoutId}`);
  const master = document.masters.find((candidate) => candidate.id === layout.masterId);
  if (!master) throw new Error(`Slide master not found: ${layout.masterId}`);
  const theme = getThemeForSlide(document, slide);

  const captured = structuredClone({
    meta: {
      title: document.meta.title,
      themeId: theme.id,
      masterId: master.id,
      ...(document.meta.pxPerPt !== undefined ? { pxPerPt: document.meta.pxPerPt } : {}),
      ...(document.meta.slideHeight !== undefined ? { slideHeight: document.meta.slideHeight } : {}),
    },
    themes: [theme],
    masters: [{ ...master, themeId: theme.id }],
    layouts: [layout],
    slides: [{ ...slide, themeId: theme.id }],
    guides: [],
  });
  return captured;
}

/** Insert an independent copy as one undoable store transaction. */
export function insertSlideTemplate(
  store: MemSlidesStore,
  templateDocument: SlidesDocument,
  afterSlideId?: string,
): string {
  const templateScale = deckFontScale(templateDocument.meta);
  const targetScale = deckFontScale(store.readMeta());
  const containsChart = templateDocument.slides.some((slide) =>
    flattenElements(slide.elements).some((element) => element.type === "chart"),
  );
  if (containsChart && templateScale !== targetScale) {
    throw new Error(
      "This template contains a chart created at a different presentation font scale. " +
      "Insert it into a presentation with the same slide format, or remove the chart before saving the template.",
    );
  }
  let inserted = "";
  store.batch(() => {
    inserted = store.importSlideTemplate(templateDocument, afterSlideId);
  });
  return inserted;
}
