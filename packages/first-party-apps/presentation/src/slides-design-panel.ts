import {
  buildLayoutSlide,
  deckSlideHeight,
  getActiveTheme,
  renderThumbnail,
  SLIDE_WIDTH,
  type SlidesDocument,
  type Theme,
} from "../engine/browser.js";
import { parseSlideHtml } from "./slide-document";
import type { SlidesTemplateLibrary, SlideTemplateSummary } from "./slide-template-library";

export interface SlidesDesignPanelCallbacks {
  theme(id: string): void;
  layout(id: string): void;
  template?(document: SlidesDocument): void;
  close(): void;
}

export interface SlidesDesignPanelHandle {
  refresh(snapshot: SlidesDocument, themes: Theme[], activeSlideId?: string): void;
  dispose(): void;
  focus(): void;
  showTemplates(): void;
}

type DesignTab = "themes" | "layouts" | "templates";

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const result = doc.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  return result;
}

function contentKey(value: unknown): string {
  return JSON.stringify(value);
}

/** A state-free view over presentation themes and layouts. */
export function mountSlidesDesignPanel(
  container: HTMLElement,
  callbacks: SlidesDesignPanelCallbacks,
  templates?: SlidesTemplateLibrary,
): SlidesDesignPanelHandle {
  const doc = container.ownerDocument;
  const panel = doc.createElement("section");
  panel.className = "ps-design-panel";
  panel.setAttribute("aria-label", "Design");

  const header = doc.createElement("header");
  header.className = "ps-design-panel__header";
  const heading = doc.createElement("h2");
  heading.textContent = "Design";
  const close = button(doc, "ps-design-panel__close", "Close");
  close.setAttribute("aria-label", "Close Design");
  header.append(heading, close);

  const tabList = doc.createElement("div");
  tabList.className = "ps-design-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Design options");
  const themesTab = button(doc, "ps-design-tabs__tab", "Themes");
  const layoutsTab = button(doc, "ps-design-tabs__tab", "Layouts");
  const templatesTab = button(doc, "ps-design-tabs__tab", "My Templates");
  const panelId = `ps-design-${crypto.randomUUID()}`;
  themesTab.id = `${panelId}-themes-tab`;
  layoutsTab.id = `${panelId}-layouts-tab`;
  templatesTab.id = `${panelId}-templates-tab`;
  themesTab.setAttribute("role", "tab");
  layoutsTab.setAttribute("role", "tab");
  templatesTab.setAttribute("role", "tab");
  themesTab.setAttribute("aria-controls", `${panelId}-themes-panel`);
  layoutsTab.setAttribute("aria-controls", `${panelId}-layouts-panel`);
  templatesTab.setAttribute("aria-controls", `${panelId}-templates-panel`);
  tabList.append(themesTab, layoutsTab, templatesTab);

  const themesPanel = doc.createElement("div");
  themesPanel.id = `${panelId}-themes-panel`;
  themesPanel.className = "ps-design-panel__content";
  themesPanel.setAttribute("role", "tabpanel");
  themesPanel.setAttribute("aria-labelledby", themesTab.id);
  const themesCaption = doc.createElement("p");
  themesCaption.className = "ps-design-panel__caption";
  themesCaption.textContent = "For the whole presentation. Existing text keeps its fonts.";
  const themesGrid = doc.createElement("div");
  themesGrid.className = "ps-design-grid ps-design-grid--themes";
  themesPanel.append(themesCaption, themesGrid);

  const layoutsPanel = doc.createElement("div");
  layoutsPanel.id = `${panelId}-layouts-panel`;
  layoutsPanel.className = "ps-design-panel__content";
  layoutsPanel.setAttribute("role", "tabpanel");
  layoutsPanel.setAttribute("aria-labelledby", layoutsTab.id);
  const layoutsCaption = doc.createElement("p");
  layoutsCaption.className = "ps-design-panel__caption";
  layoutsCaption.textContent = "Applies to the selected slide";
  const layoutsGrid = doc.createElement("div");
  layoutsGrid.className = "ps-design-grid ps-design-grid--layouts";
  layoutsPanel.append(layoutsCaption, layoutsGrid);

  const templatesPanel = doc.createElement("div");
  templatesPanel.id = `${panelId}-templates-panel`;
  templatesPanel.className = "ps-design-panel__content";
  templatesPanel.setAttribute("role", "tabpanel");
  templatesPanel.setAttribute("aria-labelledby", templatesTab.id);
  const templatesStatus = doc.createElement("p");
  templatesStatus.className = "ps-design-panel__caption";
  const templatesGrid = doc.createElement("div");
  templatesGrid.className = "ps-design-grid ps-design-grid--templates";
  templatesPanel.append(templatesStatus, templatesGrid);

  panel.append(header, tabList, themesPanel, layoutsPanel, templatesPanel);
  container.replaceChildren(panel);

  let activeTab: DesignTab = "themes";
  let themesKey = "";
  let layoutsKey = "";
  let selectedThemeId = "";
  let selectedLayoutId = "";
  let disposed = false;
  let templateGeneration = 0;
  let templateSnapshot: SlidesDocument | undefined;
  let themeButtons = new Map<string, HTMLButtonElement>();
  let layoutButtons = new Map<string, HTMLButtonElement>();

  const selectTab = (next: DesignTab, moveFocus = false): void => {
    activeTab = next;
    for (const [name, tab, content] of [["themes", themesTab, themesPanel], ["layouts", layoutsTab, layoutsPanel], ["templates", templatesTab, templatesPanel]] as const) {
      const selected = next === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      content.hidden = !selected;
      if (selected && moveFocus) tab.focus();
    }
    if (next === "templates") void loadTemplates();
  };

  const onTabKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: DesignTab = event.key === "Home" ? "themes" : event.key === "End" ? "templates"
      : event.key === "ArrowLeft"
        ? ({ themes: "templates", layouts: "themes", templates: "layouts" } as const)[activeTab]
        : ({ themes: "layouts", layouts: "templates", templates: "themes" } as const)[activeTab];
    selectTab(next, true);
  };
  const onPanelKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    callbacks.close();
  };
  themesTab.addEventListener("click", () => selectTab("themes"));
  layoutsTab.addEventListener("click", () => selectTab("layouts"));
  templatesTab.addEventListener("click", () => selectTab("templates"));
  themesTab.addEventListener("keydown", onTabKeydown);
  layoutsTab.addEventListener("keydown", onTabKeydown);
  templatesTab.addEventListener("keydown", onTabKeydown);
  const onClose = (): void => callbacks.close();
  close.addEventListener("click", onClose);
  panel.addEventListener("keydown", onPanelKeydown);
  selectTab(activeTab);

  const renderTemplate = (summary: SlideTemplateSummary, generation: number): { card: HTMLElement; load(): Promise<void> } | null => {
    if (!templates || !templateSnapshot) return null;
    const wrapper = doc.createElement("div");
    wrapper.className = "ps-template-card";
    const insert = button(doc, "ps-design-card ps-design-layout", "");
    insert.setAttribute("aria-label", `Insert ${summary.name} template`);
    const preview = doc.createElement("span");
    preview.className = "ps-design-layout__preview";
    preview.textContent = "Loading preview…";
    const name = doc.createElement("span");
    name.className = "ps-design-card__name";
    name.textContent = summary.name;
    insert.disabled = true;
    const remove = button(doc, "ps-template-card__remove", "Delete");
    remove.setAttribute("aria-label", `Delete ${summary.name} template`);
    remove.addEventListener("click", () => {
      if (wrapper.querySelector(".ps-template-card__confirmation")) return;
      const confirmation = doc.createElement("div");
      confirmation.className = "ps-template-card__confirmation";
      confirmation.setAttribute("role", "alertdialog");
      confirmation.setAttribute("aria-label", `Delete ${summary.name} template?`);
      const question = doc.createElement("strong");
      question.textContent = `Delete “${summary.name}”?`;
      const consequence = doc.createElement("span");
      consequence.textContent = "Inserted slides will not be affected.";
      const actions = doc.createElement("span");
      actions.className = "ps-template-card__confirmation-actions";
      const cancelDelete = button(doc, "ps-template-card__cancel-delete", "Cancel");
      const confirmDelete = button(doc, "ps-template-card__confirm-delete", "Delete");
      const cancel = (): void => { confirmation.remove(); remove.focus(); };
      cancelDelete.addEventListener("click", cancel);
      confirmation.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      });
      confirmDelete.addEventListener("click", () => { void (async () => {
        cancelDelete.disabled = true;
        confirmDelete.disabled = true;
        try { await templates.remove(summary.id); if (!disposed) await loadTemplates(); }
        catch (error) {
          if (disposed || !confirmation.isConnected) return;
          templatesStatus.textContent = `Couldn’t delete template: ${error instanceof Error ? error.message : String(error)}`;
          templatesStatus.classList.add("ps-design-panel__caption--error");
          cancelDelete.disabled = false;
          confirmDelete.disabled = false;
          confirmDelete.focus();
        }
      })(); });
      actions.append(cancelDelete, confirmDelete);
      confirmation.append(question, consequence, actions);
      wrapper.append(confirmation);
      cancelDelete.focus();
    });
    insert.append(preview, name); wrapper.append(insert, remove);
    const load = async (): Promise<void> => {
      preview.classList.remove("ps-design-layout__preview--error");
      preview.textContent = "Loading preview…";
      wrapper.querySelector(".ps-template-card__retry")?.remove();
      try {
        const loaded = parseSlideHtml((await templates.read(summary.id)).content);
        if (disposed || generation !== templateGeneration || !wrapper.isConnected) return;
        const slide = loaded.slides[0];
        if (!slide) throw new Error("Template has no slide");
        const slideHeight = deckSlideHeight(loaded.meta);
        preview.style.aspectRatio = `${SLIDE_WIDTH} / ${slideHeight}`;
        const canvas = doc.createElement("canvas");
        const width = 216;
        const height = Math.max(1, Math.round(width * slideHeight / SLIDE_WIDTH));
        const dpr = doc.defaultView?.devicePixelRatio ?? 1;
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable");
        const paint = (): void => renderThumbnail(
          context,
          slide,
          loaded,
          { hostWidth: width, hostHeight: height, dpr },
          repaintAfterAssetLoad,
        );
        const repaintAfterAssetLoad = (): void => {
          if (disposed || generation !== templateGeneration || !wrapper.isConnected) return;
          paint();
        };
        paint();
        preview.replaceChildren(canvas);
        insert.disabled = false;
        insert.onclick = () => callbacks.template?.(loaded);
      } catch (error) {
        if (disposed || generation !== templateGeneration || !wrapper.isConnected) return;
        preview.classList.add("ps-design-layout__preview--error");
        preview.textContent = "Preview unavailable";
        insert.disabled = true;
        insert.title = error instanceof Error ? error.message : String(error);
        const retry = button(doc, "ps-template-card__retry", "Retry preview");
        retry.addEventListener("click", () => void load());
        wrapper.append(retry);
      }
    };
    return { card: wrapper, load };
  };

  async function loadTemplates(): Promise<void> {
    if (!templates) { templatesStatus.textContent = "Template storage is unavailable."; templatesGrid.replaceChildren(); return; }
    const generation = ++templateGeneration;
    templatesStatus.classList.remove("ps-design-panel__caption--error");
    templatesStatus.textContent = "Loading templates…";
    try {
      const summaries = await templates.list();
      if (disposed || generation !== templateGeneration) return;
      const cards = summaries.map((summary) => renderTemplate(summary, generation)).filter((card): card is NonNullable<typeof card> => card !== null);
      templatesGrid.replaceChildren(...cards.map(({ card }) => card));
      templatesStatus.textContent = summaries.length ? "Insert a reusable copy after the selected slide." : "No saved templates yet.";
      for (const card of cards) {
        if (disposed || generation !== templateGeneration) return;
        await card.load();
      }
    } catch (error) {
      if (disposed || generation !== templateGeneration) return;
      templatesGrid.replaceChildren();
      templatesStatus.textContent = `Couldn’t load templates: ${error instanceof Error ? error.message : String(error)}`;
      templatesStatus.classList.add("ps-design-panel__caption--error");
      const retry = button(doc, "ps-design-panel__retry", "Retry");
      retry.addEventListener("click", () => void loadTemplates());
      templatesGrid.append(retry);
    }
  }

  const rebuildThemes = (themes: Theme[]): void => {
    const fragment = doc.createDocumentFragment();
    const nextButtons = new Map<string, HTMLButtonElement>();
    for (const theme of themes) {
      const card = button(doc, "ps-design-card ps-design-theme", "");
      card.dataset.themeId = theme.id;
      card.setAttribute("aria-label", `Apply ${theme.name} theme`);
      card.setAttribute("aria-pressed", "false");
      card.title = `Heading: ${theme.fonts.heading} · Body: ${theme.fonts.body}`;
      const sample = doc.createElement("span");
      sample.className = "ps-design-theme__sample";
      sample.setAttribute("aria-hidden", "true");
      sample.style.setProperty("--theme-background", theme.colors.background);
      sample.style.setProperty("--theme-text", theme.colors.text);
      sample.style.setProperty("--theme-muted", theme.colors.textSecondary);
      sample.style.setProperty("--theme-accent", theme.colors.accent1);
      sample.style.setProperty("--theme-accent-two", theme.colors.accent2);
      sample.style.setProperty("--theme-heading-font", theme.fonts.heading);
      sample.style.setProperty("--theme-body-font", theme.fonts.body);
      const sampleHeading = doc.createElement("span");
      sampleHeading.className = "ps-design-theme__heading";
      sampleHeading.textContent = "Big ideas";
      const sampleBody = doc.createElement("span");
      sampleBody.className = "ps-design-theme__body";
      sampleBody.textContent = "Clear stories";
      const swatches = doc.createElement("span");
      swatches.className = "ps-design-theme__swatches";
      for (const color of [theme.colors.accent1, theme.colors.accent2, theme.colors.accent3, theme.colors.accent4]) {
        const swatch = doc.createElement("i");
        swatch.style.backgroundColor = color;
        swatches.append(swatch);
      }
      sample.append(sampleHeading, sampleBody, swatches);
      const name = doc.createElement("span");
      name.className = "ps-design-card__name";
      name.textContent = theme.name;
      card.append(sample, name);
      card.addEventListener("click", () => callbacks.theme(theme.id));
      nextButtons.set(theme.id, card);
      fragment.append(card);
    }
    themesGrid.replaceChildren(fragment);
    themeButtons = nextButtons;
  };

  const rebuildLayouts = (snapshot: SlidesDocument): void => {
    const fragment = doc.createDocumentFragment();
    const nextButtons = new Map<string, HTMLButtonElement>();
    const theme = getActiveTheme(snapshot);
    const slideHeight = deckSlideHeight(snapshot.meta);
    const previewWidth = 216;
    const previewHeight = Math.max(1, Math.round(previewWidth * slideHeight / SLIDE_WIDTH));
    for (const layout of snapshot.layouts) {
      const card = button(doc, "ps-design-card ps-design-layout", "");
      card.dataset.layoutId = layout.id;
      card.setAttribute("aria-label", `Apply ${layout.name} layout to selected slide`);
      card.setAttribute("aria-pressed", "false");
      const preview = doc.createElement("span");
      preview.className = "ps-design-layout__preview";
      preview.style.aspectRatio = `${SLIDE_WIDTH} / ${slideHeight}`;
      const master = snapshot.masters.find((candidate) => candidate.id === layout.masterId);
      if (master) {
        try {
          const canvas = doc.createElement("canvas");
          const dpr = doc.defaultView?.devicePixelRatio ?? 1;
          canvas.width = Math.round(previewWidth * dpr);
          canvas.height = Math.round(previewHeight * dpr);
          canvas.setAttribute("aria-hidden", "true");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas rendering is unavailable");
          const slide = buildLayoutSlide(layout, master, theme);
          const previewDocument = { ...snapshot, slides: [slide] };
          const paint = (): void => {
            renderThumbnail(
              context,
              slide,
              previewDocument,
              // Template choices show slot hints; actual document previews never do.
              { hostWidth: previewWidth, hostHeight: previewHeight, dpr, showPlaceholderHints: true },
              repaintAfterAssetLoad,
            );
          };
          const repaintAfterAssetLoad = (): void => {
            if (disposed || !card.isConnected) return;
            paint();
          };
          paint();
          preview.append(canvas);
          const guides = doc.createElement("span");
          guides.className = "ps-design-layout__guides";
          guides.setAttribute("aria-hidden", "true");
          guides.style.setProperty("--layout-accent", theme.colors.accent1);
          guides.style.setProperty("--layout-accent-two", theme.colors.accent2);
          for (const placeholder of layout.placeholders) {
            const frame = placeholder.frame;
            const guide = doc.createElement("i");
            guide.dataset.placeholderType = placeholder.placeholder.type;
            guide.style.left = `${frame.x / SLIDE_WIDTH * 100}%`;
            guide.style.top = `${frame.y / slideHeight * 100}%`;
            guide.style.width = `${frame.w / SLIDE_WIDTH * 100}%`;
            guide.style.height = `${frame.h / slideHeight * 100}%`;
            if (frame.rotation) guide.style.transform = `rotate(${frame.rotation}rad)`;
            guides.append(guide);
          }
          preview.append(guides);
        } catch (error) {
          preview.classList.add("ps-design-layout__preview--error");
          preview.textContent = "Preview unavailable";
          card.title = error instanceof Error ? error.message : String(error);
        }
      } else {
        preview.classList.add("ps-design-layout__preview--error");
        preview.textContent = "Master unavailable";
        card.title = `Layout references missing master ${layout.masterId}`;
      }
      const name = doc.createElement("span");
      name.className = "ps-design-card__name";
      name.textContent = layout.name;
      card.append(preview, name);
      card.addEventListener("click", () => callbacks.layout(layout.id));
      nextButtons.set(layout.id, card);
      fragment.append(card);
    }
    layoutsGrid.replaceChildren(fragment);
    layoutButtons = nextButtons;
  };

  const syncSelection = (buttons: Map<string, HTMLButtonElement>, previous: string, next: string): void => {
    if (previous === next) return;
    if (previous) buttons.get(previous)?.setAttribute("aria-pressed", "false");
    if (next) buttons.get(next)?.setAttribute("aria-pressed", "true");
  };

  return {
    refresh(snapshot, themes, activeSlideId) {
      if (disposed) return;
      templateSnapshot = snapshot;
      const nextThemesKey = contentKey(themes);
      if (nextThemesKey !== themesKey) {
        rebuildThemes(themes);
        themesKey = nextThemesKey;
        selectedThemeId = "";
      }
      const activeTheme = getActiveTheme(snapshot);
      const nextLayoutsKey = contentKey({
        layouts: snapshot.layouts,
        masters: snapshot.masters,
        theme: activeTheme,
        slideHeight: snapshot.meta.slideHeight,
        pxPerPt: snapshot.meta.pxPerPt,
        dpr: doc.defaultView?.devicePixelRatio ?? 1,
        fonts: doc.fonts?.status,
      });
      if (nextLayoutsKey !== layoutsKey) {
        rebuildLayouts(snapshot);
        layoutsKey = nextLayoutsKey;
        selectedLayoutId = "";
      }
      syncSelection(themeButtons, selectedThemeId, snapshot.meta.themeId);
      selectedThemeId = snapshot.meta.themeId;
      const activeSlide = snapshot.slides.find((slide) => slide.id === activeSlideId);
      const nextLayoutId = activeSlide?.layoutId ?? "";
      syncSelection(layoutButtons, selectedLayoutId, nextLayoutId);
      selectedLayoutId = nextLayoutId;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      themesTab.removeEventListener("keydown", onTabKeydown);
      layoutsTab.removeEventListener("keydown", onTabKeydown);
      templatesTab.removeEventListener("keydown", onTabKeydown);
      templateGeneration += 1;
      close.removeEventListener("click", onClose);
      panel.removeEventListener("keydown", onPanelKeydown);
      panel.remove();
      themeButtons.clear();
      layoutButtons.clear();
    },
    focus() {
      if (!disposed) ({ themes: themesTab, layouts: layoutsTab, templates: templatesTab })[activeTab].focus();
    },
    showTemplates() {
      if (!disposed) selectTab("templates", true);
    },
  };
}
