import {
  SLIDE_WIDTH,
  deckSlideHeight,
  initializeEditor,
  mountNotesPanel,
  mountThumbnailPanel,
  renderThumbnail,
  startPresenter,
  type MemSlidesStore,
  type Presenter,
  type SlidesDocument,
  type SlidesEditor,
  type ThumbnailPanelHandle,
} from "../engine/browser.js";
import { slidesIcon, type SlidesIconName } from "./slides-icons";
import { applyDesignTheme, getDesignThemes } from "./slide-design";
import { mountSlidesDesignPanel } from "./slides-design-panel";
import { serializeSlideHtml } from "./slide-document";
import type { SlidesTemplateLibrary } from "./slide-template-library";
import { captureSlideTemplate, insertSlideTemplate } from "./slide-templates";

export interface SlidesSurfaceCallbacks {
  changed(): void;
  editing(active: boolean): void;
  error(message: string): void;
  selection?(): void;
}

export interface SlidesSurfaceHandle {
  dispose(): void;
  commit(): void | Promise<void>;
  /** Detached recovery view, including active text/crop/notes drafts. */
  getDraftSnapshot(): SlidesDocument;
  /** False while an async image import has bytes that cannot yet be represented. */
  isDraftExact(): boolean;
  refresh(): void;
  getActiveSlideId(): string | undefined;
}

export interface SlidesSurfaceOptions {
  readOnly?: boolean;
  activeSlideId?: string;
  templates?: SlidesTemplateLibrary;
}

const FIT_ZOOM = 0;
const ZOOM_LEVELS = [FIT_ZOOM, 0.5, 0.75, 1, 1.5, 2] as const;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isSupportedSlidesImageType(type: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(type);
}

export function captureExactSlideTemplateDraft(input: {
  slideId: string;
  isDraftExact(): boolean;
  getDraftSnapshot(): SlidesDocument;
}): SlidesDocument {
  if (!input.isDraftExact()) {
    throw new Error("Wait for the slide’s images to finish loading before saving a template.");
  }
  return captureSlideTemplate(input.getDraftSnapshot(), input.slideId);
}

export function fitSlideSize(
  availableWidth: number,
  availableHeight: number,
  slideHeight: number,
): { width: number; height: number } {
  const scale = Math.min(availableWidth / SLIDE_WIDTH, availableHeight / slideHeight);
  return {
    width: Math.max(1, Math.floor(SLIDE_WIDTH * scale)),
    height: Math.max(1, Math.floor(slideHeight * scale)),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(doc: Document, label: string, title = label, icon?: SlidesIconName, iconOnly = false): HTMLButtonElement {
  const node = el(doc, "button", "ps-button");
  node.type = "button";
  if (icon) node.append(slidesIcon(doc, icon));
  const text = el(doc, "span", iconOnly ? "ps-visually-hidden" : "ps-button__label");
  text.textContent = label;
  node.append(text);
  if (iconOnly) node.classList.add("ps-button--icon");
  node.title = title;
  node.setAttribute("aria-label", title);
  return node;
}

function menu(doc: Document, label: string, children: Node[]): HTMLDetailsElement {
  const details = el(doc, "details", "ps-menu");
  const summary = el(doc, "summary", "ps-button");
  summary.textContent = label;
  summary.setAttribute("aria-label", `${label} menu`);
  const panel = el(doc, "div", "ps-menu__panel");
  panel.append(...children);
  details.append(summary, panel);
  return details;
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const item = select.ownerDocument.createElement("option");
  item.value = value;
  item.textContent = label;
  select.appendChild(item);
}

function applySlidesSurfaceMode(
  toolbar: HTMLElement,
  present: HTMLButtonElement,
  readOnly: boolean,
): void {
  if (!readOnly) return;
  for (const group of [...toolbar.querySelectorAll<HTMLElement>(".ps-toolbar__group")]) {
    if (!group.contains(present)) group.remove();
  }
  toolbar.setAttribute("aria-label", "Presentation viewing tools");
}

function selectedElement(store: MemSlidesStore, editor: SlidesEditor) {
  const slideId = editor.getCurrentSlideId();
  const ids = editor.getSelection();
  if (!slideId || ids.length !== 1) return undefined;
  return store.read().slides.find((slide) => slide.id === slideId)?.elements.find((item) => item.id === ids[0]);
}

function cssColor(value: unknown): string {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value;
  if (value && typeof value === "object" && "kind" in value && "value" in value) {
    const candidate = (value as { kind: unknown; value: unknown }).value;
    if (typeof candidate === "string" && /^#[0-9a-f]{6}$/i.test(candidate)) return candidate;
  }
  return "#2563eb";
}

/** Mount the framework-free owned Slides engine into the presentation mini-app. */
export function mountSlidesSurface(
  root: HTMLElement,
  store: MemSlidesStore,
  callbacks: SlidesSurfaceCallbacks,
  options: SlidesSurfaceOptions = {},
): SlidesSurfaceHandle {
  const readOnly = options.readOnly === true;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("Slides surface requires a browser window");
  const surfaceWindow = win;
  if (store.read().slides.length === 0) throw new Error("A presentation must contain at least one slide.");

  root.replaceChildren();
  root.classList.add("presentation-app");
  const abort = new AbortController();
  const listen = <T extends EventTarget>(target: T, type: string, fn: EventListener): void =>
    target.addEventListener(type, fn, { signal: abort.signal });

  const toolbar = el(doc, "div", "ps-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Presentation editing tools");
  const undo = button(doc, "Undo", "Undo", "undo", true);
  const redo = button(doc, "Redo", "Redo", "redo", true);
  const add = button(doc, "New slide", "Add slide", "plus");
  add.classList.add("ps-button--compact-label");
  const duplicate = button(doc, "Duplicate");
  const remove = button(doc, "Delete");
  const up = button(doc, "Up", "Move slide up");
  const down = button(doc, "Down", "Move slide down");
  const saveTemplate = button(doc, "Save slide as template");
  const selectTool = button(doc, "Select", "Select", "pointer", true);
  const textTool = button(doc, "Text", "Insert text", "type");
  const rectTool = button(doc, "Rectangle");
  const ellipseTool = button(doc, "Ellipse");
  const lineTool = button(doc, "Line");
  const imageTool = button(doc, "Image", "Insert image", "image");
  const imageInput = el(doc, "input");
  imageInput.type = "file";
  imageInput.accept = "image/png,image/jpeg,image/webp,image/gif";
  imageInput.hidden = true;
  const design = button(doc, "Design", "Design", "panel");
  design.setAttribute("aria-expanded", "false");
  const fill = el(doc, "input", "ps-color");
  fill.type = "color";
  fill.title = "Selected object fill";
  fill.setAttribute("aria-label", "Selected object fill");
  const bold = button(doc, "B", "Bold");
  const italic = button(doc, "I", "Italic");
  const underline = button(doc, "U", "Underline");
  const fontFamily = el(doc, "input", "ps-text-input ps-font-family");
  fontFamily.type = "text";
  fontFamily.placeholder = "Font family";
  fontFamily.setAttribute("aria-label", "Font family");
  const fontList = el(doc, "datalist");
  fontList.id = `ps-font-list-${crypto.randomUUID()}`;
  fontFamily.setAttribute("list", fontList.id);
  for (const family of ["Arial", "Georgia", "Helvetica", "Inter", "Times New Roman", "Verdana"]) {
    option(fontList as unknown as HTMLSelectElement, family, family);
  }
  const fontSize = el(doc, "input", "ps-text-input ps-font-size");
  fontSize.type = "number";
  fontSize.min = "0";
  fontSize.step = "any";
  fontSize.inputMode = "decimal";
  fontSize.placeholder = "Size";
  fontSize.setAttribute("aria-label", "Font size");
  const alignLeft = button(doc, "Left", "Align text left", "alignLeft", true);
  const alignCenter = button(doc, "Center", "Align text center", "alignCenter", true);
  const alignRight = button(doc, "Right", "Align text right", "alignRight", true);
  const zoom = el(doc, "select", "ps-select ps-zoom");
  zoom.setAttribute("aria-label", "Zoom");
  for (const level of ZOOM_LEVELS) option(zoom, String(level), level === FIT_ZOOM ? "Fit" : `${level * 100}%`);
  const present = button(doc, "Present", "Present from current slide", "play");
  present.classList.add("ps-button--primary");
  const slideMenu = menu(doc, "Slide", [duplicate, remove, up, down, ...(options.templates ? [saveTemplate] : [])]);
  const insertMenu = menu(doc, "Insert", [textTool, rectTool, ellipseTool, lineTool, imageTool, imageInput]);
  const baseGroups = [
    [undo, redo],
    [add, slideMenu, selectTool, insertMenu, design],
    [zoom, present],
  ];
  const mainTools = el(doc, "div", "ps-toolbar__main");
  for (const nodes of baseGroups) {
    const group = el(doc, "div", "ps-toolbar__group");
    if (nodes.includes(present)) group.classList.add("ps-toolbar__view");
    for (const node of nodes) group.appendChild(node);
    mainTools.appendChild(group);
  }
  const objectGroup = el(doc, "div", "ps-toolbar__group ps-toolbar__context");
  objectGroup.append(fill);
  const textGroup = el(doc, "div", "ps-toolbar__group ps-toolbar__context");
  textGroup.setAttribute("role", "group");
  textGroup.setAttribute("aria-label", "Text formatting");
  for (const controls of [[fontFamily, fontList, fontSize], [bold, italic, underline], [alignLeft, alignCenter, alignRight]]) {
    const set = el(doc, "div", "ps-format-set");
    set.append(...controls);
    textGroup.append(set);
  }
  const formattingTools = el(doc, "div", "ps-toolbar__formatting");
  formattingTools.append(objectGroup, textGroup);
  toolbar.append(mainTools, formattingTools);
  applySlidesSurfaceMode(toolbar, present, readOnly);

  const body = el(doc, "div", "ps-body");
  const rail = el(doc, "aside", "ps-rail");
  rail.setAttribute("aria-label", "Slides");
  const railHeader = el(doc, "div", "ps-rail__header");
  const railTitle = el(doc, "span", "ps-rail__title");
  railTitle.textContent = "Slides";
  const railCount = el(doc, "span", "ps-rail__count");
  railHeader.append(railTitle, railCount);
  const railContent = el(doc, "div", "ps-rail__content");
  const railThumbnails = el(doc, "div", "ps-rail__thumbnails");
  railContent.append(railThumbnails);
  rail.append(railHeader, railContent);
  const stageColumn = el(doc, "div", "ps-stage-column");
  const stage = el(doc, "div", "ps-stage");
  const canvasWrap = el(doc, "div", "ps-canvas-wrap");
  const canvas = el(doc, "canvas", "ps-canvas");
  const overlay = el(doc, "div", "ps-overlay");
  canvasWrap.append(canvas, overlay);
  stage.appendChild(canvasWrap);
  const notesRegion = el(doc, "section", "ps-notes-region");
  const notesToggle = button(doc, "Speaker notes", "Show speaker notes", "panel");
  notesToggle.classList.add("ps-notes-toggle");
  notesToggle.setAttribute("aria-expanded", "false");
  const notes = el(doc, "div", "ps-notes");
  notes.setAttribute("aria-label", "Speaker notes");
  notes.hidden = true;
  notesRegion.append(notesToggle, notes);
  stageColumn.append(stage, notesRegion);
  body.append(rail, stageColumn);
  const designHost = el(doc, "aside", "ps-design-host");
  designHost.id = `ps-design-${crypto.randomUUID()}`;
  designHost.setAttribute("aria-label", "Presentation design");
  designHost.hidden = true;
  design.setAttribute("aria-controls", designHost.id);
  if (!readOnly) body.append(designHost);
  root.append(toolbar, body);

  const templateDialog = el(doc, "dialog", "ps-template-dialog");
  const templateDialogTitleId = `ps-template-dialog-${crypto.randomUUID()}`;
  templateDialog.setAttribute("aria-labelledby", templateDialogTitleId);
  const templateTitle = el(doc, "h2");
  templateTitle.id = templateDialogTitleId;
  templateTitle.textContent = "Save slide as template";
  const templatePreview = el(doc, "canvas", "ps-template-dialog__preview");
  const templateLabel = el(doc, "label");
  templateLabel.textContent = "Template name";
  const templateName = el(doc, "input", "ps-text-input");
  templateName.type = "text";
  templateLabel.append(templateName);
  const templateMessage = el(doc, "p", "ps-template-dialog__message");
  templateMessage.setAttribute("aria-live", "polite");
  const templateActions = el(doc, "div", "ps-template-dialog__actions");
  const cancelTemplate = button(doc, "Cancel");
  const confirmTemplate = button(doc, "Save template");
  confirmTemplate.classList.add("ps-button--primary");
  templateActions.append(cancelTemplate, confirmTemplate);
  templateDialog.append(templateTitle, templatePreview, templateLabel, templateMessage, templateActions);
  if (!readOnly) doc.body.append(templateDialog);

  let disposed = false;
  let zoomLevel = FIT_ZOOM;
  let presenter: Presenter | null = null;
  let presenterHost: HTMLElement | null = null;
  let presenterControls: AbortController | null = null;
  let thumbHandle: ThumbnailPanelHandle | null = null;
  let designHandle: ReturnType<typeof mountSlidesDesignPanel> | null = null;
  let lastSlideIds = "";
  const pendingReaders = new Map<FileReader, () => void>();
  const pendingImageImports = new Set<Promise<void>>();
  let notesFocused = false;
  let pendingTemplateDocument: SlidesDocument | undefined;
  let menuTemplateDraft: { slideId: string; document: SlidesDocument } | undefined;
  let savingTemplate = false;

  const editorOptions: Parameters<typeof initializeEditor>[0] = {
    canvas,
    overlay,
    store,
    hostWidth: 960,
    hostHeight: 540,
    dpr: win.devicePixelRatio || 1,
    onStartPresentation: (from) => { void startPresentation(from); },
    onToast: (message) => callbacks.error(message),
    onFontsLoaded: () => {
      thumbHandle?.refreshContent();
      if (!designHost.hidden) refreshDesign();
    },
    onDraftChange: () => callbacks.changed(),
    readOnly,
  };
  const editor = initializeEditor(editorOptions);
  if (options.activeSlideId && store.read().slides.some(slide => slide.id === options.activeSlideId)) {
    editor.setCurrentSlide(options.activeSlideId);
  }

  const fit = (): void => {
    if (disposed) return;
    const slideHeight = deckSlideHeight(store.readMeta());
    const stageStyle = win.getComputedStyle(stage);
    const horizontalPadding = Number.parseFloat(stageStyle.paddingLeft) + Number.parseFloat(stageStyle.paddingRight);
    const verticalPadding = Number.parseFloat(stageStyle.paddingTop) + Number.parseFloat(stageStyle.paddingBottom);
    const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
    let width: number;
    let height: number;
    if (zoomLevel === FIT_ZOOM) {
      ({ width, height } = fitSlideSize(availableWidth, availableHeight, slideHeight));
    } else {
      width = Math.floor(SLIDE_WIDTH * zoomLevel);
      height = Math.floor(slideHeight * zoomLevel);
    }
    const dpr = win.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    canvasWrap.style.width = `${width}px`;
    canvasWrap.style.height = `${height}px`;
    editor.setHostSize(width, height);
    editor.markDirty();
    editor.render();
  };

  thumbHandle = mountThumbnailPanel(railThumbnails, store, editor, { readOnly });
  const notesHandle = mountNotesPanel(notes, store, editor, { readOnly });

  function transact(fn: () => void): void {
    if (readOnly) return;
    try {
      store.batch(fn);
    } catch (error) {
      callbacks.error(error instanceof Error ? error.message : String(error));
    }
  }

  function refreshDesign(): void {
    if (!designHandle || designHost.hidden) return;
    const snapshot = store.read();
    designHandle.refresh(snapshot, getDesignThemes(snapshot), editor.getCurrentSlideId());
  }

  function closeDesign(): void {
    designHost.hidden = true;
    body.classList.remove("ps-body--design-open");
    design.setAttribute("aria-expanded", "false");
    design.focus();
    fit();
  }

  if (!readOnly) designHandle = mountSlidesDesignPanel(designHost, {
    theme: (id) => {
      editor.exitTextEditing();
      const snapshot = store.read();
      if (snapshot.meta.themeId === id && !snapshot.slides.some((slide) => slide.themeId !== undefined)) return;
      transact(() => applyDesignTheme(store, id));
    },
    layout: (id) => {
      editor.exitTextEditing();
      const slideId = editor.getCurrentSlideId();
      if (slideId && store.read().slides.find((slide) => slide.id === slideId)?.layoutId !== id) {
        transact(() => store.applyLayout(slideId, id));
      }
    },
    template: (templateDocument) => {
      const afterSlideId = editor.getCurrentSlideId();
      try {
        const insertedSlideId = insertSlideTemplate(store, templateDocument, afterSlideId);
        editor.setCurrentSlide(insertedSlideId);
      } catch (error) {
        callbacks.error(error instanceof Error ? error.message : String(error));
      }
    },
    close: closeDesign,
  }, options.templates);

  const reportEditing = (): void => callbacks.editing(notesFocused || editor.isTextEditing() || editor.isCropping() || pendingImageImports.size > 0);

  const getDraftSnapshot = (): SlidesDocument => {
    const snapshot = editor.getDraftSnapshot();
    const draftNotes = notesHandle.getDraftSnapshot();
    if (draftNotes) {
      const slide = snapshot.slides.find((candidate) => candidate.id === draftNotes.slideId);
      if (slide) slide.notes = draftNotes.blocks;
    }
    return snapshot;
  };

  const isDraftExact = (): boolean =>
    pendingImageImports.size === 0;

  async function commitPendingEdits(): Promise<void> {
    if (readOnly) return;
    if (notes.contains(doc.activeElement) && doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
    editor.exitTextEditing();
    editor.exitImageCrop(true);
    while (pendingImageImports.size > 0) await Promise.all([...pendingImageImports]);
    reportEditing();
  }

  async function startPresentation(from: "current" | "first"): Promise<void> {
    await commitPendingEdits();
    if (disposed) return;
    const snapshot = store.read();
    if (snapshot.slides.length === 0 || presenter) return;
    const host = el(doc, "div", "ps-presenter");
    host.tabIndex = -1;
    doc.body.appendChild(host);
    presenterHost = host;
    const restoreFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : present;
    const startSlideId = from === "first" ? snapshot.slides[0].id : editor.getCurrentSlideId() ?? snapshot.slides[0].id;
    const exit = (): void => {
      presenterControls?.abort();
      presenterControls = null;
      presenter?.dispose();
      presenter = null;
      host.remove();
      presenterHost = null;
      restoreFocus.focus();
    };
    try {
      presenter = startPresenter({ container: host, doc: snapshot, startSlideId, onExit: exit });
      const exitButton = button(doc, "Exit presentation", "Exit presentation");
      exitButton.classList.add("ps-presenter-exit");
      const shortcut = el(doc, "kbd");
      shortcut.textContent = "Esc";
      shortcut.setAttribute("aria-hidden", "true");
      exitButton.append(shortcut);
      host.append(exitButton);
      presenterControls = new AbortController();
      const signal = presenterControls.signal;
      exitButton.addEventListener("click", (event) => { event.stopPropagation(); exit(); }, { signal });
      // A touch on Exit must not also become the engine's tap-to-advance gesture.
      exitButton.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
      exitButton.addEventListener("pointerup", (event) => event.stopPropagation(), { signal });
      // The engine captures all document keys. Intercept only control focus and
      // activation above that handler; slide navigation and Escape stay native.
      surfaceWindow.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopImmediatePropagation();
          exitButton.focus();
        } else if (doc.activeElement === exitButton && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          exit();
        }
      }, { capture: true, signal });
      host.focus();
    } catch (error) {
      presenterControls?.abort();
      presenterControls = null;
      presenter?.dispose();
      presenter = null;
      host.remove();
      presenterHost = null;
      callbacks.error(error instanceof Error ? error.message : String(error));
    }
  }

  const refreshToolbar = (): void => {
    const snapshot = store.read();
    const slideId = editor.getCurrentSlideId();
    const index = snapshot.slides.findIndex((slide) => slide.id === slideId);
    railCount.textContent = `${snapshot.slides.length}`;
    railCount.setAttribute("aria-label", `${snapshot.slides.length} ${snapshot.slides.length === 1 ? "slide" : "slides"}`);
    undo.disabled = !store.canUndo();
    redo.disabled = !store.canRedo();
    duplicate.disabled = index < 0;
    remove.disabled = index < 0 || snapshot.slides.length <= 1;
    up.disabled = index <= 0;
    down.disabled = index < 0 || index >= snapshot.slides.length - 1;
    refreshDesign();
    const active = selectedElement(store, editor);
    const supportsFill = active?.type === "shape" || active?.type === "text";
    fill.disabled = !supportsFill;
    if (supportsFill) fill.value = cssColor(active.data.fill);
    const textEditor = editor.getActiveTextEditor();
    objectGroup.hidden = !supportsFill || Boolean(textEditor);
    // Keep typography discoverable and the toolbar stable between text edits.
    // Preview removes this entire group in applySlidesSurfaceMode.
    textGroup.hidden = false;
    textGroup.title = textEditor ? "Format selected text" : "Double-click text on the slide to format it";
    for (const control of [fontFamily, fontSize, bold, italic, underline, alignLeft, alignCenter, alignRight]) control.disabled = !textEditor;
    if (textEditor) {
      const summary = textEditor.getRangeStyleSummary();
      fontFamily.value = summary.fontFamily ?? "";
      fontSize.value = typeof summary.fontSize === "number" ? String(summary.fontSize) : "";
      bold.classList.toggle("ps-button--active", summary.bold === true);
      italic.classList.toggle("ps-button--active", summary.italic === true);
      underline.classList.toggle("ps-button--active", summary.underline === true);
    } else {
      fontFamily.value = "";
      fontSize.value = "";
      for (const control of [bold, italic, underline]) control.classList.remove("ps-button--active");
    }
    const mode = editor.getInsertMode();
    for (const [control, activeMode] of [[selectTool, null], [textTool, "text"], [rectTool, "rect"], [ellipseTool, "ellipse"], [lineTool, "connector:line"]] as const) {
      control.classList.toggle("ps-button--active", mode === activeMode);
    }
  };

  const refresh = (): void => {
    editor.markDirty();
    editor.render();
    thumbHandle?.refreshContent();
    presenter?.setDocument(store.read());
    refreshToolbar();
  };

  listen(undo, "click", () => { if (!readOnly) store.undo(); });
  listen(redo, "click", () => { if (!readOnly) store.redo(); });
  listen(add, "click", () => transact(() => {
    const current = store.read().slides.find((slide) => slide.id === editor.getCurrentSlideId());
    const id = store.addSlide(current?.layoutId || "blank");
    editor.setCurrentSlide(id);
  }));
  listen(duplicate, "click", () => {
    const id = editor.getCurrentSlideId();
    if (id) transact(() => editor.setCurrentSlide(store.duplicateSlide(id)));
  });
  listen(remove, "click", () => {
    const snapshot = store.read();
    const id = editor.getCurrentSlideId();
    const index = snapshot.slides.findIndex((slide) => slide.id === id);
    if (!id || index < 0 || snapshot.slides.length <= 1) return;
    const next = snapshot.slides[index + 1] ?? snapshot.slides[index - 1];
    transact(() => store.removeSlide(id));
    if (next) editor.setCurrentSlide(next.id);
  });
  const move = (delta: number): void => {
    const snapshot = store.read();
    const id = editor.getCurrentSlideId();
    const index = snapshot.slides.findIndex((slide) => slide.id === id);
    const target = index + delta;
    if (id && target >= 0 && target < snapshot.slides.length) transact(() => store.moveSlide(id, target));
  };
  listen(up, "click", () => move(-1));
  listen(down, "click", () => move(1));
  const slideMenuSummary = slideMenu.querySelector("summary");
  if (slideMenuSummary) listen(slideMenuSummary, "pointerdown", () => {
    const slideId = editor.getCurrentSlideId();
    if (!slideId || !options.templates || !isDraftExact()) { menuTemplateDraft = undefined; return; }
    try {
      menuTemplateDraft = { slideId, document: captureExactSlideTemplateDraft({ slideId, isDraftExact, getDraftSnapshot }) };
    } catch { menuTemplateDraft = undefined; }
  });
  listen(saveTemplate, "mousedown", (event) => event.preventDefault());
  listen(saveTemplate, "click", () => {
    slideMenu.open = false;
    const slideId = editor.getCurrentSlideId();
    if (!slideId || !options.templates) {
      callbacks.error("Template storage is unavailable.");
      return;
    }
    try {
      pendingTemplateDocument = menuTemplateDraft?.slideId === slideId
        ? menuTemplateDraft.document
        : captureExactSlideTemplateDraft({ slideId, isDraftExact, getDraftSnapshot });
      menuTemplateDraft = undefined;
      const captured = pendingTemplateDocument;
      templateName.value = "";
      templateMessage.textContent = "";
      const slide = captured.slides[0];
      if (slide) {
        const slideHeight = deckSlideHeight(captured.meta);
        const width = 400; const height = Math.round(width * slideHeight / SLIDE_WIDTH);
        const dpr = win.devicePixelRatio || 1;
        templatePreview.width = Math.round(width * dpr); templatePreview.height = Math.round(height * dpr);
        const context = templatePreview.getContext("2d");
        if (context) {
          const paint = (): void => renderThumbnail(
            context,
            slide,
            captured,
            { hostWidth: width, hostHeight: height, dpr },
            repaintAfterAssetLoad,
          );
          const repaintAfterAssetLoad = (): void => {
            if (disposed || !templateDialog.open || pendingTemplateDocument !== captured) return;
            paint();
          };
          paint();
        }
      }
      templateDialog.showModal();
      templateName.focus();
    } catch (error) { callbacks.error(error instanceof Error ? error.message : String(error)); }
  });
  listen(cancelTemplate, "click", () => { if (!savingTemplate) templateDialog.close(); });
  listen(templateDialog, "cancel", (event) => { if (savingTemplate) event.preventDefault(); });
  listen(templateDialog, "close", () => {
    pendingTemplateDocument = undefined;
    (slideMenuSummary ?? saveTemplate).focus();
  });
  listen(confirmTemplate, "click", () => {
    if (savingTemplate || !pendingTemplateDocument || !options.templates) return;
    const name = templateName.value.trim();
    if (!name) { templateMessage.textContent = "Enter a template name."; templateName.focus(); return; }
    savingTemplate = true; confirmTemplate.disabled = true; cancelTemplate.disabled = true;
    void options.templates.save({ name, content: serializeSlideHtml(pendingTemplateDocument) }).then(() => {
      if (disposed) return;
      templateDialog.close();
      designHost.hidden = false;
      body.classList.add("ps-body--design-open");
      design.setAttribute("aria-expanded", "true");
      refreshDesign();
      designHandle?.showTemplates();
      fit();
    }).catch((error: unknown) => {
      if (!disposed) templateMessage.textContent = `Couldn’t save template: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => {
      savingTemplate = false; confirmTemplate.disabled = false; cancelTemplate.disabled = false;
    });
  });
  listen(templateDialog, "keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === "Escape" && savingTemplate) event.preventDefault();
    if (keyboard.key !== "Tab") return;
    const focusable = [templateName, cancelTemplate, confirmTemplate].filter((node) => !node.disabled);
    const index = focusable.indexOf(doc.activeElement as typeof templateName);
    if (keyboard.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!keyboard.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0]?.focus(); }
  });
  listen(design, "click", () => {
    if (readOnly) return;
    if (!designHost.hidden) { closeDesign(); return; }
    void commitPendingEdits().then(() => {
      if (disposed) return;
      designHost.hidden = false;
      body.classList.add("ps-body--design-open");
      design.setAttribute("aria-expanded", "true");
      refreshDesign();
      designHandle?.focus();
      fit();
    }).catch((error: unknown) => callbacks.error(error instanceof Error ? error.message : String(error)));
  });
  listen(selectTool, "click", () => editor.setInsertMode(null));
  listen(textTool, "click", () => editor.setInsertMode("text"));
  listen(rectTool, "click", () => editor.setInsertMode("rect"));
  listen(ellipseTool, "click", () => editor.setInsertMode("ellipse"));
  listen(lineTool, "click", () => editor.setInsertMode("connector:line"));
  listen(imageTool, "click", () => imageInput.click());
  listen(imageInput, "change", () => {
    const file = imageInput.files?.[0];
    const targetSlideId = editor.getCurrentSlideId();
    imageInput.value = "";
    if (!file || !isSupportedSlidesImageType(file.type)) {
      if (file) callbacks.error("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    const reader = new win.FileReader();
    let finishImport!: () => void;
    const pendingImport = new Promise<void>((resolve) => { finishImport = resolve; });
    const finish = (): void => {
      if (!pendingImageImports.delete(pendingImport)) return;
      pendingReaders.delete(reader);
      finishImport();
      if (!disposed) {
        reportEditing();
        callbacks.changed();
      }
    };
    pendingReaders.set(reader, finish);
    pendingImageImports.add(pendingImport);
    reportEditing();
    callbacks.changed();
    reader.onerror = () => {
      if (!disposed) callbacks.error("The image could not be read.");
      finish();
    };
    reader.onabort = finish;
    reader.onload = () => {
      if (disposed || !targetSlideId || !store.read().slides.some((slide) => slide.id === targetSlideId)) {
        finish();
        return;
      }
      const src = typeof reader.result === "string" ? reader.result : "";
      const image = new win.Image();
      image.onerror = () => {
        if (!disposed) callbacks.error("The image could not be decoded.");
        finish();
      };
      image.onload = () => {
        if (disposed || !store.read().slides.some((slide) => slide.id === targetSlideId)) {
          finish();
          return;
        }
        const slideHeight = deckSlideHeight(store.readMeta());
        const maxW = SLIDE_WIDTH * 0.5;
        const maxH = slideHeight * 0.56;
        const scale = Math.min(1, maxW / image.naturalWidth, maxH / image.naturalHeight);
        const w = Math.max(1, image.naturalWidth * scale);
        const h = Math.max(1, image.naturalHeight * scale);
        let id = "";
        transact(() => {
          id = store.addElement(targetSlideId, {
            type: "image",
            frame: { x: (SLIDE_WIDTH - w) / 2, y: (slideHeight - h) / 2, w, h, rotation: 0 },
            data: { src },
          });
        });
        try {
          if (id && editor.getCurrentSlideId() === targetSlideId) editor.setSelection([id]);
        } finally { finish(); }
      };
      image.src = src;
    };
    reader.readAsDataURL(file);
  });
  listen(fill, "input", () => {
    const active = selectedElement(store, editor);
    const slideId = editor.getCurrentSlideId();
    if (!active || !slideId || (active.type !== "shape" && active.type !== "text")) return;
    transact(() => {
      store.updateElementData(slideId, active.id, { fill: { kind: "srgb", value: fill.value } });
      store.pushRecentColor(fill.value);
    });
  });
  const textControls = [fontFamily, fontSize, bold, italic, underline, alignLeft, alignCenter, alignRight];
  for (const control of textControls) control.setAttribute("data-text-edit-keepalive", "");
  for (const control of [bold, italic, underline, alignLeft, alignCenter, alignRight]) {
    listen(control, "mousedown", (event) => event.preventDefault());
  }
  const inline = (style: object): void => {
    const api = editor.getActiveTextEditor();
    if (!api) return;
    api.applyStyle(style);
    api.focus();
    refreshToolbar();
  };
  listen(fontFamily, "change", () => {
    const value = fontFamily.value.trim();
    if (value) inline({ fontFamily: value });
  });
  listen(fontSize, "change", () => {
    const value = Number(fontSize.value);
    if (Number.isFinite(value) && value > 0) inline({ fontSize: value });
    else refreshToolbar();
  });
  listen(bold, "click", () => {
    const api = editor.getActiveTextEditor();
    if (api) inline({ bold: api.getRangeStyleSummary().bold !== true });
  });
  listen(italic, "click", () => {
    const api = editor.getActiveTextEditor();
    if (api) inline({ italic: api.getRangeStyleSummary().italic !== true });
  });
  listen(underline, "click", () => {
    const api = editor.getActiveTextEditor();
    if (api) inline({ underline: api.getRangeStyleSummary().underline !== true });
  });
  const block = (alignment: "left" | "center" | "right"): void => {
    const api = editor.getActiveTextEditor();
    if (!api) return;
    api.applyBlockStyle({ alignment });
    api.focus();
    refreshToolbar();
  };
  listen(alignLeft, "click", () => block("left"));
  listen(alignCenter, "click", () => block("center"));
  listen(alignRight, "click", () => block("right"));
  listen(zoom, "change", () => { zoomLevel = Number(zoom.value); fit(); });
  listen(present, "click", () => { void startPresentation("current"); });
  listen(notesToggle, "click", () => {
    const open = notes.hidden;
    notes.hidden = !open;
    notesRegion.classList.toggle("ps-notes-region--open", open);
    notesToggle.setAttribute("aria-expanded", String(open));
    notesToggle.title = open ? "Hide speaker notes" : "Show speaker notes";
    notesToggle.setAttribute("aria-label", notesToggle.title);
    fit();
    if (open) notes.querySelector<HTMLElement>("textarea")?.focus();
  });

  listen(notes, "focusin", () => { notesFocused = true; reportEditing(); });
  listen(notes, "focusout", () => { notesFocused = false; reportEditing(); });

  const offSelection = editor.onSelectionChange(() => { callbacks.selection?.(); refreshToolbar(); });
  const offSlide = editor.onCurrentSlideChange(() => { callbacks.selection?.(); refreshToolbar(); });
  const offEditing = editor.onTextEditingChange(() => { reportEditing(); refreshToolbar(); });
  const offCrop = editor.onCropChange(reportEditing);
  const offInsert = editor.onInsertModeChange(refreshToolbar);
  const offStore = store.onChange(() => {
    callbacks.changed();
    const ids = store.read().slides.map((slide) => slide.id).join("\u0000");
    if (ids !== lastSlideIds) {
      lastSlideIds = ids;
      thumbHandle?.refresh();
    } else {
      thumbHandle?.refreshContent();
    }
    refresh();
  });
  lastSlideIds = store.read().slides.map((slide) => slide.id).join("\u0000");

  const ResizeObserverCtor = win.ResizeObserver;
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(fit) : null;
  resizeObserver?.observe(stage);
  fit();
  refreshToolbar();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      callbacks.editing(false);
      presenterControls?.abort();
      presenterControls = null;
      presenter?.dispose();
      presenter = null;
      presenterHost?.remove();
      presenterHost = null;
      for (const [reader, finish] of pendingReaders) {
        reader.abort();
        finish();
      }
      pendingReaders.clear();
      resizeObserver?.disconnect();
      offStore();
      offCrop();
      offInsert();
      offEditing();
      offSlide();
      offSelection();
      notesHandle.dispose();
      designHandle?.dispose();
      templateDialog.remove();
      thumbHandle?.dispose();
      editor.detach();
      abort.abort();
      root.replaceChildren();
      root.classList.remove("presentation-app");
    },
    commit: commitPendingEdits,
    getDraftSnapshot,
    isDraftExact,
    refresh,
    getActiveSlideId: () => editor.getCurrentSlideId(),
  };
}
