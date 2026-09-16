import { BUILT_IN_THEMES, type MemSlidesStore, type SlidesDocument, type Theme } from "../engine/node.js";

/** The document owns existing definitions, including imported built-in IDs. */
export function getDesignThemes(document: Pick<SlidesDocument, "themes">): Theme[] {
  // Stable catalog order keeps keyboard focus on the chosen card when its
  // definition is first persisted. Document definitions override by ID.
  const themes = new Map(BUILT_IN_THEMES.map((theme) => [theme.id, theme]));
  for (const theme of document.themes) themes.set(theme.id, theme);
  return [...themes.values()];
}

/** Add only the chosen definition and apply it as one undoable edit. */
export function applyDesignTheme(store: MemSlidesStore, themeId: string): void {
  const snapshot = store.read();
  const theme = getDesignThemes(snapshot).find((candidate) => candidate.id === themeId);
  if (!theme) throw new Error("This presentation theme is no longer available.");
  if (snapshot.meta.themeId === themeId && !snapshot.slides.some(slide => slide.themeId !== undefined)) return;
  store.batch(() => {
    store.addTheme(theme);
    store.applyTheme(themeId);
  });
}
