import {
  boardToSlidesDocument,
  screenToWorld,
  zoomAt,
  panBy,
  type BoardModel,
  type Viewport,
} from "@nautilo/office-board";
import {
  initializeEditor,
  MemSlidesStore,
  makeDefaultSlidesTextBlock,
  PATH_BUILDERS,
  renderShapeIcon,
  flattenElements,
  type Element as BoardElement,
  type ShapeKind,
} from "@nautilo/office-slides/browser";
import type { InlineStyle, BlockStyle, Block } from "@nautilo/office-docs/node";
import {
  centerOn,
  editableTarget,
  fitBoard,
  gridStep,
  readableName,
  viewportFrame,
} from "./board-view";
import { boardImageSourceError } from "./board-model-validation";
import { icon, type BoardIcon } from "./board-icons";

const NOTE_COLORS = [
  "#fff1b8",
  "#d7edcf",
  "#d5e6ff",
  "#f6d8e4",
  "#f9dec1",
  "#e7dcf5",
] as const;
interface BoardSurfaceOptions {
  theme?: "light" | "dark";
  readOnly?: boolean;
  status?: string;
  viewport?: Viewport;
  selection?: readonly string[];
}
interface BoardSurfaceCallbacks {
  changed(): void;
  error(message: string): void;
  editing?(active: boolean): void;
  selection?(): void;
}
export interface BoardSurface {
  read(): BoardModel;
  commit(): Promise<void>;
  setStatus(message: string): void;
  setActions(actions: HTMLElement[]): void;
  setTitle(title: string): void;
  fit(): void;
  setTheme(theme: "light" | "dark"): void;
  viewport(): Viewport;
  selection(): readonly string[];
  hasPendingImages(): boolean;
  dispose(): void;
}

export function mountBoardSurface(
  root: HTMLElement,
  model: BoardModel,
  callbacks: BoardSurfaceCallbacks,
  options: BoardSurfaceOptions = {},
): BoardSurface {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("A browser window is required");
  const abort = new AbortController();
  const readOnly = options.readOnly === true;
  let theme = options.theme ?? "light";
  // The synthetic Slides theme is view state. Role colors follow the shell;
  // explicit document colors and undo history remain untouched by palette changes.
  const store = new (class extends MemSlidesStore {
    override read() {
      const snapshot = super.read();
      for (const item of snapshot.themes)
        item.colors = {
          ...item.colors,
          text: theme === "dark" ? "#d8e0fa" : "#292524",
          textSecondary: theme === "dark" ? "#a9b4d5" : "#675e56",
        };
      return snapshot;
    }
  })(boardToSlidesDocument(model));
  let disposed = false;
  let viewport: Viewport = { panX: 0, panY: 0, zoom: 1 };
  let host = { w: 1, h: 1 };
  let initialFit = false;
  let panMode = false;
  let spacePan = false;
  let snapping = false;
  let grid = true;
  let frameRequest: number | null = null;
  let paintRequest: number | null = null;
  let pendingImages = 0;
  const readers = new Set<FileReader>();
  const listen = (
    target: EventTarget,
    event: string,
    fn: EventListener,
    opts: AddEventListenerOptions = {},
  ) => target.addEventListener(event, fn, { ...opts, signal: abort.signal });
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls = "",
    text = "",
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
  };
  const button = (
    label: string,
    symbol?: BoardIcon,
    compact = false,
  ): HTMLButtonElement => {
    const b = el("button", compact ? "bd-icon-button" : "bd-button");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    if (symbol) b.append(icon(doc, symbol));
    if (!compact) b.append(el("span", "", label));
    return b;
  };
  const input = (label: string, type: string) => {
    const i = el("input");
    i.type = type;
    i.setAttribute("aria-label", label);
    i.title = label;
    return i;
  };
  const field = (label: string, control: HTMLElement) => {
    const l = el("label", "bd-field");
    l.append(el("span", "", label), control);
    return l;
  };
  root.replaceChildren();
  root.classList.add("board-app");
  root.dataset.theme = theme;
  const header = el("header", "bd-header");
  const identity = el("div", "bd-identity");
  identity.append(icon(doc, "board"), el("span", "bd-app-name", "Board"));
  const title = el("h1", "bd-title", model.meta.title || "Untitled board");
  const status = el("span", "bd-status", options.status ?? "");
  status.setAttribute("role", "status");
  const overviewToggle = button("Overview", "overview", true);
  overviewToggle.setAttribute("aria-expanded", "false");
  header.append(
    identity,
    el("span", "bd-divider"),
    title,
    status,
    overviewToggle,
  );
  const body = el("div", "bd-body");
  const stage = el("div", "bd-stage");
  stage.setAttribute("aria-label", "Board canvas");
  stage.tabIndex = 0;
  const canvas = el("canvas", "bd-canvas");
  canvas.setAttribute("aria-label", "Editable board");
  const overlay = el("div", "bd-overlay");
  stage.append(canvas, overlay);
  const rail = el("nav", "bd-rail");
  rail.setAttribute("aria-label", "Create and edit");
  const select = button("Select (V)", "select", true);
  const pan = button("Pan (H or Space)", "pan", true);
  const note = button("Sticky note (N)", "note", true);
  const text = button("Text (T)", "text", true);
  const shapes = button("Shapes", "shape", true);
  const connect = button("Connect (C)", "connector", true);
  const image = button("Add image", "image", true);
  const undo = button("Undo", "undo", true);
  const redo = button("Redo", "redo", true);
  rail.append(
    select,
    pan,
    el("span", "bd-rule"),
    note,
    text,
    shapes,
    connect,
    image,
    el("span", "bd-rule"),
    undo,
    redo,
  );
  const file = input("Choose image", "file");
  file.accept = "image/png,image/jpeg,image/gif,image/webp";
  file.hidden = true;
  const format = el("div", "bd-format");
  format.setAttribute("role", "toolbar");
  format.setAttribute("aria-label", "Object formatting");
  const selectionLabel = el(
    "span",
    "bd-selection-label",
    "Select an object to format",
  );
  const font = input("Font family", "text");
  font.value = "Inter";
  font.placeholder = "Font family";
  font.setAttribute("list", "board-font-options");
  const fonts = el("datalist");
  fonts.id = "board-font-options";
  for (const family of [
    "Inter",
    "Arial",
    "Georgia",
    "Helvetica",
    "Times New Roman",
    "Verdana",
  ]) {
    const o = el("option");
    o.value = family;
    fonts.append(o);
  }
  const fontSize = input("Font size", "number");
  fontSize.step = "any";
  fontSize.min = "0";
  fontSize.value = "18";
  const bold = button("Bold");
  bold.textContent = "B";
  bold.style.fontWeight = "750";
  const italic = button("Italic");
  italic.textContent = "I";
  italic.style.fontStyle = "italic";
  const underline = button("Underline");
  underline.textContent = "U";
  underline.style.textDecoration = "underline";
  const alignment = el("select");
  alignment.setAttribute("aria-label", "Text alignment");
  for (const name of ["left", "center", "right", "justify"]) {
    const o = el("option", "", readableName(name));
    o.value = name;
    alignment.append(o);
  }
  const color = input("Text color", "color");
  const fill = input("Object fill", "color");
  const stroke = input("Outline color", "color");
  const strokeWidth = input("Outline width", "number");
  strokeWidth.min = "0";
  strokeWidth.step = "any";
  strokeWidth.value = "1";
  const swatches = el("div", "bd-swatches");
  swatches.setAttribute("aria-label", "Note colors");
  const arrange = el("select");
  arrange.setAttribute("aria-label", "Arrange");
  for (const [value, label] of [
    ["", "Arrange"],
    ["front", "Bring to front"],
    ["back", "Send to back"],
    ["group", "Group"],
    ["ungroup", "Ungroup"],
    ["left", "Align left"],
    ["center", "Align center"],
    ["right", "Align right"],
    ["top", "Align top"],
    ["middle", "Align middle"],
    ["bottom", "Align bottom"],
  ]) {
    const o = el("option", "", label);
    o.value = value;
    arrange.append(o);
  }
  const crop = button("Crop image");
  const remove = button("Delete", "trash", true);
  const textControls = el("div", "bd-format-group");
  textControls.append(
    field("Font", font),
    fonts,
    field("Size", fontSize),
    bold,
    italic,
    underline,
    field("Align", alignment),
    field("Text", color),
  );
  const shapeControls = el("div", "bd-format-group");
  shapeControls.append(
    swatches,
    field("Fill", fill),
    field("Line", stroke),
    field("Width", strokeWidth),
  );
  format.append(
    selectionLabel,
    textControls,
    shapeControls,
    arrange,
    crop,
    remove,
  );
  for (const c of [font, fontSize, bold, italic, underline, alignment, color])
    c.setAttribute("data-text-edit-keepalive", "");
  for (const c of [bold, italic, underline])
    listen(c, "mousedown", (e) => e.preventDefault());
  const picker = el("section", "bd-picker");
  picker.hidden = true;
  picker.setAttribute("aria-label", "Shape library");
  const search = input("Find a shape", "search");
  search.placeholder = "Find a shape…";
  const pickerTitle = el("div", "bd-picker-title");
  const closePicker = button("Close shapes", "close", true);
  pickerTitle.append(el("strong", "", "Shapes"), closePicker);
  const shapeList = el("div", "bd-shape-list");
  picker.append(pickerTitle, search, shapeList);
  const empty = el("div", "bd-empty");
  empty.append(
    icon(doc, "board"),
    el("h2", "", "A little space for big ideas"),
    el("p", "", "Add a note, connect a thought, see where it goes."),
  );
  const firstNote = button("Add your first note", "plus");
  firstNote.classList.add("bd-primary");
  empty.append(
    firstNote,
    el(
      "span",
      "bd-empty-hint",
      "N for a note · Space to pan · ⌘ / Ctrl + scroll to zoom",
    ),
  );
  const navigation = el("div", "bd-navigation");
  const gridToggle = button("Show grid", "grid", true);
  gridToggle.setAttribute("aria-pressed", "true");
  const snapToggle = button("Snap");
  snapToggle.setAttribute("aria-pressed", "false");
  const minus = button("Zoom out", "minus", true);
  const plus = button("Zoom in", "plus", true);
  const zoom = input("Zoom percent", "number");
  zoom.step = "any";
  zoom.min = "0";
  const fit = button("Fit board", "fit");
  navigation.append(
    gridToggle,
    snapToggle,
    el("span", "bd-divider"),
    minus,
    zoom,
    el("span", "", "%"),
    plus,
    fit,
  );
  const overview = el("aside", "bd-overview");
  overview.hidden = true;
  const overviewTitle = el("div", "bd-picker-title");
  const closeOverview = button("Close overview", "close", true);
  overviewTitle.append(el("strong", "", "Overview"), closeOverview);
  const mini = el("canvas", "bd-minimap");
  mini.width = 200;
  mini.height = 130;
  mini.tabIndex = 0;
  mini.setAttribute(
    "aria-label",
    "Board minimap. Click to navigate or use arrow keys.",
  );
  const outline = el("div", "bd-outline");
  overview.append(overviewTitle, mini, outline);
  const notice = el("div", "bd-notice");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  body.append(
    stage,
    empty,
    rail,
    format,
    picker,
    overview,
    navigation,
    notice,
    file,
  );
  root.append(header, body);
  if (readOnly) {
    rail.hidden = true;
    format.hidden = true;
    firstNote.hidden = true;
    empty.querySelector("p")!.textContent = "This board is empty.";
  }

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    notice.textContent = message;
    notice.hidden = false;
    callbacks.error(message);
  };
  const editor = initializeEditor({
    canvas,
    overlay,
    store,
    hostWidth: host.w,
    hostHeight: host.h,
    dpr: win.devicePixelRatio || 1,
    viewport,
    cull: true,
    suppressSlideChrome: true,
    readOnly,
    onFitToContent: () => fitAll(),
    getSnapGrid: () => (snapping ? gridStep(viewport.zoom) : null),
    onDraftChange: () => callbacks.changed(),
    onToast: fail,
  });
  editor.setCurrentSlide("board");
  const elements = (): BoardElement[] => store.read().slides[0].elements;
  const selected = (): BoardElement[] => {
    const ids = new Set(editor.getSelection());
    return flattenElements(elements()).filter((e) => ids.has(e.id));
  };
  const transact = (fn: () => void) => {
    if (readOnly || disposed) return;
    try {
      store.batch(fn);
    } catch (error) {
      fail(error);
    }
  };
  const focusStage = () => stage.focus({ preventScroll: true });
  function commitViewport(next: Viewport): void {
    if (disposed) return;
    if (
      next.zoom !== viewport.zoom ||
      next.panX !== viewport.panX ||
      next.panY !== viewport.panY
    )
      editor.exitTextEditing();
    viewport = next;
    editor.setViewport(next);
    const step = gridStep(next.zoom) * next.zoom;
    stage.style.backgroundSize = `${step}px ${step}px`;
    stage.style.backgroundPosition = `${next.panX % step}px ${next.panY % step}px`;
    stage.dataset.grid = String(grid);
    if (doc.activeElement !== zoom)
      zoom.value = Number((next.zoom * 100).toPrecision(3)).toString();
    drawMinimap();
  }
  function fitAll(): void {
    editor.exitTextEditing();
    const next = fitBoard(
      elements().map((e) => e.frame),
      host,
    );
    if (next) commitViewport(next);
    focusStage();
  }
  function zoomBy(
    factor: number,
    point = { x: host.w / 2, y: host.h / 2 },
  ): void {
    try {
      commitViewport(zoomAt(viewport, point, factor));
    } catch (error) {
      fail(error);
    }
  }
  const worldCenter = () =>
    screenToWorld(viewport, { x: host.w / 2, y: host.h / 2 });
  function createText(kind: "note" | "text"): void {
    if (readOnly) return;
    setPan(false);
    editor.exitTextEditing();
    editor.setInsertMode(null);
    const center = worldCenter();
    const block = makeDefaultSlidesTextBlock();
    block.style = {
      ...block.style,
      alignment: kind === "note" ? "center" : "left",
    };
    block.inlines = block.inlines.map((i) => ({
      ...i,
      style: {
        ...i.style,
        fontSize: 18,
        fontFamily: "Inter",
        color: kind === "note" ? "#292524" : { kind: "role", role: "text" },
      },
    }));
    const frame = {
      x: center.x - 120,
      y: center.y - (kind === "note" ? 100 : 40),
      w: 240,
      h: kind === "note" ? 200 : 80,
      rotation: 0,
    };
    let id = "";
    transact(() => {
      id = store.addElement(
        "board",
        kind === "note"
          ? {
              type: "shape",
              frame,
              data: {
                kind: "roundRect",
                fill: { kind: "srgb", value: NOTE_COLORS[0] },
                text: {
                  blocks: [block],
                  verticalAnchor: "middle",
                  autofit: "shrink",
                },
              },
            }
          : { type: "text", frame, data: { blocks: [block] } },
      );
    });
    if (id) {
      editor.setSelection([id]);
      editor.enterTextEditing(id);
      refresh();
    }
  }
  function setPan(value: boolean): void {
    panMode = value;
    editor.setInsertMode(null);
    if (value) {
      editor.exitTextEditing();
      editor.setSelection([]);
    }
    stage.dataset.pan = String(value || spacePan);
    pan.setAttribute("aria-pressed", String(value));
    select.setAttribute(
      "aria-pressed",
      String(!value && !editor.getInsertMode()),
    );
  }
  function blocksOf(element: BoardElement): Block[] {
    return element.type === "text"
      ? element.data.blocks
      : element.type === "shape"
        ? (element.data.text?.blocks ?? [])
        : [];
  }
  function styleText(
    inline?: Partial<InlineStyle>,
    blockStyle?: Partial<BlockStyle>,
  ): void {
    if (readOnly) return;
    const active = editor.getActiveTextEditor();
    if (active) {
      if (inline) active.applyStyle(inline);
      if (blockStyle) active.applyBlockStyle(blockStyle);
      active.focus();
      scheduleRefresh();
      return;
    }
    transact(() => {
      for (const e of selected()) {
        const change = (blocks: Block[]) => {
          for (const b of blocks) {
            if (blockStyle) b.style = { ...b.style, ...blockStyle };
            if (inline)
              b.inlines = b.inlines.map((i) => ({
                ...i,
                style: { ...i.style, ...inline },
              }));
          }
        };
        if (e.type === "text") store.withTextElement("board", e.id, change);
        else if (e.type === "shape") store.withShapeText("board", e.id, change);
      }
    });
    focusStage();
  }
  const setFill = (value: string) => {
    editor.exitTextEditing();
    transact(() => {
      for (const e of selected())
        if (e.type === "shape" || e.type === "text")
          store.updateElementData("board", e.id, {
            fill: { kind: "srgb", value },
          });
    });
  };
  for (const [i, value] of NOTE_COLORS.entries()) {
    const b = button(["Butter", "Sage", "Sky", "Rose", "Peach", "Lilac"][i]);
    b.className = "bd-swatch";
    b.style.background = value;
    listen(b, "click", () => setFill(value));
    swatches.append(b);
  }
  function applyOutline(): void {
    const width = Number(strokeWidth.value);
    if (!Number.isFinite(width) || width < 0) {
      fail("Choose a non-negative outline width.");
      return;
    }
    editor.exitTextEditing();
    transact(() => {
      for (const e of selected()) {
        const next = { color: stroke.value, width };
        if (e.type === "shape" || e.type === "text")
          store.updateElementData("board", e.id, { stroke: next });
        else if (e.type === "connector")
          store.updateConnectorStroke("board", e.id, next);
      }
    });
  }
  function removeSelected(): void {
    editor.exitTextEditing();
    transact(() => store.removeElements("board", [...editor.getSelection()]));
    editor.setSelection([]);
    focusStage();
  }
  function refresh(): void {
    if (disposed) return;
    const list = elements();
    const chosen = selected();
    const first = chosen[0];
    const textable = chosen.some(
      (e) => e.type === "text" || e.type === "shape",
    );
    const fillable = chosen.some(
      (e) => e.type === "text" || e.type === "shape",
    );
    const outlined = fillable || chosen.some((e) => e.type === "connector");
    empty.hidden = list.length !== 0;
    format.dataset.selected = String(chosen.length > 0);
    selectionLabel.hidden = chosen.length > 0;
    textControls.hidden = !textable;
    shapeControls.hidden = !outlined;
    swatches.hidden = !fillable;
    fill.parentElement!.hidden = !fillable;
    arrange.hidden = chosen.length === 0;
    remove.hidden = chosen.length === 0;
    crop.hidden = chosen.length !== 1 || first?.type !== "image";
    undo.disabled = !store.canUndo();
    redo.disabled = !store.canRedo();
    const styles = chosen.flatMap((item) =>
      blocksOf(item).flatMap((block) => block.inlines.map((run) => run.style)),
    );
    const common: Partial<InlineStyle> = {};
    for (const key of [
      "fontFamily",
      "fontSize",
      "bold",
      "italic",
      "underline",
      "color",
    ] as const) {
      const value = styles[0]?.[key];
      if (styles.every((style) => style[key] === value))
        Object.assign(common, { [key]: value });
    }
    const inline =
      editor.getActiveTextEditor()?.getRangeStyleSummary() ?? common;
    font.placeholder = "Mixed";
    fontSize.placeholder = "—";
    if (doc.activeElement !== font)
      font.value =
        typeof inline?.fontFamily === "string" ? inline.fontFamily : "";
    if (doc.activeElement !== fontSize)
      fontSize.value =
        typeof inline?.fontSize === "number" ? String(inline.fontSize) : "";
    for (const [b, key] of [
      [bold, "bold"],
      [italic, "italic"],
      [underline, "underline"],
    ] as const)
      b.setAttribute("aria-pressed", String(inline?.[key] === true));
    if (
      typeof inline?.color === "string" &&
      /^#[\da-f]{6}$/i.test(inline.color)
    )
      color.value = inline.color;
    if (first && (first.type === "shape" || first.type === "text")) {
      const f = first.data.fill;
      if (f?.kind === "srgb" && /^#[\da-f]{6}$/i.test(f.value))
        fill.value = f.value;
      const a = blocksOf(first)[0]?.style.alignment;
      if (a && doc.activeElement !== alignment) alignment.value = a;
    }
    const outline =
      first?.type === "connector"
        ? first.stroke
        : first?.type === "shape" || first?.type === "text"
          ? first.data.stroke
          : undefined;
    if (doc.activeElement !== strokeWidth)
      strokeWidth.value = String(outline?.width ?? 0);
    const lineColor = outline?.color;
    if (typeof lineColor === "string" && /^#[\da-f]{6}$/i.test(lineColor))
      stroke.value = lineColor;
    connect.setAttribute("aria-pressed", String(editor.isConnectorMode()));
    select.setAttribute(
      "aria-pressed",
      String(!panMode && !editor.getInsertMode()),
    );
    editor.markDirty();
    editor.render();
    drawMinimap();
    refreshOutline(list);
  }
  function scheduleRefresh(): void {
    if (frameRequest !== null || disposed) return;
    frameRequest = win!.requestAnimationFrame(() => {
      frameRequest = null;
      refresh();
    });
  }
  let outlineSignature = "";
  function refreshOutline(list: BoardElement[]): void {
    if (overview.hidden) return;
    const rows = list.map((e) => ({
      id: e.id,
      label:
        blocksOf(e)
          .map((b) => b.inlines.map((i) => i.text).join(""))
          .join(" ")
          .trim() || readableName(e.type),
    }));
    const signature = JSON.stringify(rows);
    if (signature === outlineSignature) return;
    outlineSignature = signature;
    outline.replaceChildren();
    for (const row of rows) {
      const b = button(row.label);
      b.title = row.label;
      listen(b, "click", () => {
        const e = elements().find((e) => e.id === row.id);
        if (!e) return;
        editor.exitTextEditing();
        editor.setSelection([e.id]);
        commitViewport(
          centerOn(
            viewport,
            { x: e.frame.x + e.frame.w / 2, y: e.frame.y + e.frame.h / 2 },
            host,
          ),
        );
        focusStage();
      });
      outline.append(b);
    }
  }
  let miniView: Viewport | undefined;
  function drawMinimap(): void {
    if (overview.hidden) return;
    const ctx = mini.getContext("2d");
    if (!ctx) return;
    const list = elements();
    const visible = viewportFrame(viewport, host);
    miniView = fitBoard([...list.map((e) => e.frame), visible], {
      w: mini.width,
      h: mini.height,
    });
    if (!miniView) return;
    const m = miniView;
    ctx.clearRect(0, 0, mini.width, mini.height);
    for (const e of list) {
      ctx.fillStyle =
        e.type === "shape" && e.data.fill?.kind === "srgb"
          ? e.data.fill.value
          : theme === "dark"
            ? "#9cabd5"
            : "#847467";
      ctx.fillRect(
        e.frame.x * m.zoom + m.panX,
        e.frame.y * m.zoom + m.panY,
        Math.max(1, e.frame.w * m.zoom),
        Math.max(1, e.frame.h * m.zoom),
      );
    }
    ctx.strokeStyle = theme === "dark" ? "#82aaff" : "#ad5942";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      visible.x * m.zoom + m.panX,
      visible.y * m.zoom + m.panY,
      visible.w * m.zoom,
      visible.h * m.zoom,
    );
  }
  function toggleOverview(open: boolean): void {
    overview.hidden = !open;
    overviewToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      refreshOutline(elements());
      drawMinimap();
    } else overviewToggle.focus();
  }
  function chooseShape(kind: ShapeKind): void {
    setPan(false);
    editor.exitTextEditing();
    editor.setInsertMode(kind);
    picker.hidden = true;
    shapes.setAttribute("aria-expanded", "false");
    notice.textContent = `Drag on the canvas to place ${readableName(kind).toLowerCase()}.`;
    notice.hidden = false;
    focusStage();
  }
  const shapeButtons: HTMLButtonElement[] = [];
  for (const kind of PATH_BUILDERS.keys()) {
    const b = button(readableName(kind));
    const c = el("canvas");
    c.width = 40;
    c.height = 32;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.strokeStyle = "#8196b8";
      renderShapeIcon(kind, ctx, { w: 40, h: 32 });
    }
    b.prepend(c);
    b.dataset.kind = kind;
    listen(b, "click", () => chooseShape(kind));
    shapeList.append(b);
    shapeButtons.push(b);
  }
  listen(search, "input", () => {
    const q = search.value.toLowerCase();
    for (const b of shapeButtons) b.hidden = !b.title.toLowerCase().includes(q);
  });
  listen(shapes, "click", () => {
    picker.hidden = !picker.hidden;
    shapes.setAttribute("aria-expanded", String(!picker.hidden));
    if (!picker.hidden) search.focus();
  });
  listen(closePicker, "click", () => {
    picker.hidden = true;
    shapes.setAttribute("aria-expanded", "false");
    shapes.focus();
  });
  listen(note, "click", () => createText("note"));
  listen(firstNote, "click", () => createText("note"));
  listen(text, "click", () => createText("text"));
  listen(select, "click", () => {
    setPan(false);
    focusStage();
  });
  listen(pan, "click", () => {
    setPan(!panMode);
    focusStage();
  });
  listen(connect, "click", () => {
    setPan(false);
    editor.exitTextEditing();
    editor.setInsertMode("connector:arrow");
    notice.textContent =
      "Drag from one object’s edge to another to keep the connection attached as they move.";
    notice.hidden = false;
    focusStage();
  });
  listen(undo, "click", () => {
    editor.exitTextEditing();
    store.undo();
    refresh();
    focusStage();
  });
  listen(redo, "click", () => {
    editor.exitTextEditing();
    store.redo();
    refresh();
    focusStage();
  });
  listen(remove, "click", removeSelected);
  listen(crop, "click", () => {
    const first = selected()[0];
    if (first) editor.enterImageCrop(first.id);
  });
  listen(font, "change", () => {
    if (font.value.trim()) styleText({ fontFamily: font.value.trim() });
  });
  listen(fontSize, "change", () => {
    const n = Number(fontSize.value);
    if (Number.isFinite(n) && n > 0) styleText({ fontSize: n });
    else {
      fail("Choose a positive font size.");
      refresh();
    }
  });
  for (const [b, key] of [
    [bold, "bold"],
    [italic, "italic"],
    [underline, "underline"],
  ] as const)
    listen(b, "click", () =>
      styleText({ [key]: b.getAttribute("aria-pressed") !== "true" }),
    );
  listen(alignment, "change", () =>
    styleText(undefined, {
      alignment: alignment.value as BlockStyle["alignment"],
    }),
  );
  listen(color, "change", () => styleText({ color: color.value }));
  listen(fill, "change", () => setFill(fill.value));
  listen(stroke, "change", applyOutline);
  listen(strokeWidth, "change", applyOutline);
  listen(arrange, "change", () => {
    const action = arrange.value;
    arrange.value = "";
    editor.exitTextEditing();
    const ids = [...editor.getSelection()];
    if (action === "group") {
      if (ids.length < 2) {
        fail("Select two or more objects to group.");
        return;
      }
      transact(() => {
        const result = store.group("board", ids);
        editor.setSelection([result.groupId]);
      });
    } else if (action === "ungroup") {
      transact(() => {
        const next: string[] = [];
        for (const e of selected())
          if (e.type === "group") next.push(...store.ungroup("board", e.id));
        editor.setSelection(next);
      });
    } else if (action === "front" || action === "back") {
      transact(() => {
        const count = elements().length;
        for (const id of action === "back" ? [...ids].reverse() : ids)
          store.reorderElement("board", id, action === "front" ? count - 1 : 0);
      });
    } else if (
      ["left", "center", "right", "top", "middle", "bottom"].includes(action)
    ) {
      if (ids.length < 2) {
        fail("Select two or more objects to align.");
        return;
      }
      editor.align(action as Parameters<typeof editor.align>[0]);
    }
    focusStage();
  });
  listen(gridToggle, "click", () => {
    grid = !grid;
    gridToggle.setAttribute("aria-pressed", String(grid));
    commitViewport(viewport);
  });
  listen(snapToggle, "click", () => {
    snapping = !snapping;
    snapToggle.setAttribute("aria-pressed", String(snapping));
  });
  listen(minus, "click", () => zoomBy(1 / 1.2));
  listen(plus, "click", () => zoomBy(1.2));
  listen(fit, "click", fitAll);
  listen(zoom, "change", () => {
    const n = Number(zoom.value) / 100;
    if (Number.isFinite(n) && n > 0) zoomBy(n / viewport.zoom);
    else {
      fail("Choose a positive zoom percentage.");
      commitViewport(viewport);
    }
  });
  listen(overviewToggle, "click", () => toggleOverview(overview.hidden));
  listen(closeOverview, "click", () => toggleOverview(false));
  listen(mini, "pointerdown", (event) => {
    const e = event as PointerEvent;
    if (!miniView) return;
    const r = mini.getBoundingClientRect();
    const point = screenToWorld(miniView, {
      x: ((e.clientX - r.left) * mini.width) / r.width,
      y: ((e.clientY - r.top) * mini.height) / r.height,
    });
    commitViewport(centerOn(viewport, point, host));
  });
  listen(mini, "keydown", (event) => {
    const e = event as KeyboardEvent;
    const delta = host.w / 4;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      e.stopPropagation();
      commitViewport(
        panBy(
          viewport,
          e.key === "ArrowLeft" ? delta : e.key === "ArrowRight" ? -delta : 0,
          e.key === "ArrowUp" ? delta : e.key === "ArrowDown" ? -delta : 0,
        ),
      );
    }
  });
  // Navigation intercepts before the shared editor, so pan cannot also drag an object.
  let drag: { id: number; x: number; y: number } | null = null;
  listen(
    stage,
    "pointerdown",
    (event) => {
      const e = event as PointerEvent;
      if (!(panMode || spacePan || e.button === 1)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      editor.exitTextEditing();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.dataset.dragging = "true";
    },
    { capture: true },
  );
  listen(
    stage,
    "pointermove",
    (event) => {
      const e = event as PointerEvent;
      if (!drag || drag.id !== e.pointerId) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      commitViewport(panBy(viewport, e.clientX - drag.x, e.clientY - drag.y));
      drag.x = e.clientX;
      drag.y = e.clientY;
    },
    { capture: true },
  );
  const endPan = (event: Event) => {
    const e = event as PointerEvent;
    if (drag?.id !== e.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = null;
    stage.dataset.dragging = "false";
    if (stage.hasPointerCapture(e.pointerId))
      stage.releasePointerCapture(e.pointerId);
  };
  listen(stage, "pointerup", endPan, { capture: true });
  listen(stage, "pointercancel", endPan, { capture: true });
  listen(
    stage,
    "wheel",
    (event) => {
      const e = event as WheelEvent;
      if (editableTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = stage.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.h : 1;
      if (e.ctrlKey || e.metaKey) {
        if (e.deltaY !== 0)
          zoomBy(Math.exp((-e.deltaY * unit) / 300), {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
      } else
        commitViewport(panBy(viewport, -e.deltaX * unit, -e.deltaY * unit));
    },
    { passive: false, capture: true },
  );
  listen(
    root,
    "keydown",
    (event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Escape") {
        if (editor.isTextEditing()) {
          editor.exitTextEditing();
          focusStage();
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (!picker.hidden) {
          picker.hidden = true;
          shapes.focus();
          e.preventDefault();
          return;
        }
        if (panMode) {
          setPan(false);
          focusStage();
          e.preventDefault();
          return;
        }
      }
      if (editableTarget(e.target) || editor.isTextEditing()) return;
      if (e.code === "Space") {
        e.preventDefault();
        spacePan = true;
        stage.dataset.pan = "true";
        return;
      }
      if (
        e.target instanceof Element &&
        e.target.closest("button,select,input")
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopImmediatePropagation();
        editor.setSelection(elements().map((i) => i.id));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "0") {
        e.preventDefault();
        fitAll();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(1.2);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        zoomBy(1 / 1.2);
        return;
      }
      if (e.key.toLowerCase() === "h") {
        e.preventDefault();
        setPan(true);
        return;
      }
      if (e.key.toLowerCase() === "v") {
        e.preventDefault();
        setPan(false);
        return;
      }
      if (readOnly) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        e.stopImmediatePropagation();
        createText("note");
      } else if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        e.stopImmediatePropagation();
        createText("text");
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        chooseShape("rect");
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        connect.click();
      }
    },
    { capture: true },
  );
  listen(win, "keyup", (event) => {
    if ((event as KeyboardEvent).code === "Space") {
      spacePan = false;
      stage.dataset.pan = String(panMode);
    }
  });
  listen(win, "blur", () => {
    spacePan = false;
    drag = null;
    stage.dataset.pan = String(panMode);
    stage.dataset.dragging = "false";
  });
  function importImage(blob: File, at = worldCenter()): void {
    if (readOnly || disposed) return;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.type)) {
      notice.textContent = "Choose a PNG, JPEG, GIF or WebP image. Your board is unchanged.";
      notice.hidden = false;
      return;
    }
    const reader = new win!.FileReader();
    readers.add(reader);
    pendingImages++;
    // Pending bytes make the recovery snapshot incomplete, but they have not
    // changed the model. The store change below is the only dirty signal for a
    // successful insert; failures must leave a previously clean board clean.
    callbacks.editing?.(true);
    notice.hidden = false;
    notice.textContent = "Placing image…";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      readers.delete(reader);
      pendingImages--;
      if (!disposed) {
        callbacks.editing?.(editor.isTextEditing() || pendingImages > 0);
        if (pendingImages === 0 && notice.textContent === "Placing image…")
          notice.hidden = true;
      }
    };
    reader.onerror = () => {
      if (!disposed)
        fail("That image could not be read. Your board is unchanged.");
      finish();
    };
    reader.onabort = finish;
    reader.onload = () => {
      if (disposed) {
        finish();
        return;
      }
      const src = reader.result;
      if (typeof src !== "string") {
        finish();
        return;
      }
      const invalidSource = boardImageSourceError(src);
      if (invalidSource) {
        fail(`This image ${invalidSource}. Your board is unchanged.`);
        finish();
        return;
      }
      const img = new win!.Image();
      img.onerror = () => {
        if (!disposed)
          fail("This image format could not be decoded. Try another image.");
        finish();
      };
      img.onload = () => {
        try {
          if (disposed) return;
          const scale = Math.min(
            1,
            (host.w * 0.55) / (img.naturalWidth * viewport.zoom),
            (host.h * 0.55) / (img.naturalHeight * viewport.zoom),
          );
          const w = img.naturalWidth * scale;
          const h = img.naturalHeight * scale;
          let id = "";
          editor.exitTextEditing();
          transact(() => {
            id = store.addElement("board", {
              type: "image",
              frame: { x: at.x - w / 2, y: at.y - h / 2, w, h, rotation: 0 },
              data: { src },
            });
          });
          if (id) {
            editor.setSelection([id]);
            focusStage();
          }
        } catch (error) {
          fail(error);
        } finally {
          finish();
        }
      };
      img.src = src;
    };
    reader.readAsDataURL(blob);
  }
  listen(image, "click", () => file.click());
  listen(file, "change", () => {
    for (const blob of Array.from(file.files ?? [])) importImage(blob);
    file.value = "";
  });
  listen(stage, "dragover", (event) => {
    if (!readOnly) {
      event.preventDefault();
      (event as DragEvent).dataTransfer!.dropEffect = "copy";
    }
  });
  listen(stage, "drop", (event) => {
    if (readOnly) return;
    const e = event as DragEvent;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const at = screenToWorld(viewport, {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    });
    for (const blob of Array.from(e.dataTransfer?.files ?? []))
      importImage(blob, at);
  });
  listen(
    root,
    "paste",
    (event) => {
      const e = event as ClipboardEvent;
      if (readOnly || editableTarget(e.target) || editor.isTextEditing())
        return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      for (const blob of files) importImage(blob);
    },
    { capture: true },
  );
  const subscriptions = [
    store.onChange(() => {
      callbacks.changed();
      scheduleRefresh();
    }),
    editor.onSelectionChange(() => { scheduleRefresh(); callbacks.selection?.(); }),
    editor.onTextEditingChange(() => {
      callbacks.editing?.(editor.isTextEditing() || pendingImages > 0);
      scheduleRefresh();
    }),
    editor.onInsertModeChange(() => {
      notice.hidden = true;
      scheduleRefresh();
    }),
  ];
  const resize = () => {
    if (disposed) return;
    const size = stage.getBoundingClientRect();
    if (size.width <= 0 || size.height <= 0) return;
    const old = host;
    host = { w: size.width, h: size.height };
    const ratio = win.devicePixelRatio || 1;
    canvas.width = Math.round(host.w * ratio);
    canvas.height = Math.round(host.h * ratio);
    canvas.style.width = `${host.w}px`;
    canvas.style.height = `${host.h}px`;
    overlay.style.width = `${host.w}px`;
    overlay.style.height = `${host.h}px`;
    editor.setHostSize(host.w, host.h);
    if (!initialFit) {
      viewport =
        options.viewport ?? fitBoard(
          elements().map((e) => e.frame),
          host,
        ) ?? centerOn(viewport, { x: 0, y: 0 }, host);
      initialFit = true;
    } else
      viewport = panBy(viewport, (host.w - old.w) / 2, (host.h - old.h) / 2);
    commitViewport(viewport);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  if (options.selection) {
    const ids = new Set(flattenElements(elements()).map(element => element.id));
    editor.setSelection(options.selection.filter(id => ids.has(id)));
  }
  refresh();
  // Async engine image/font caches mark the renderer dirty. Keep its cheap
  // clean-frame path running without rebuilding toolbars or notifying the host.
  const paint = () => {
    if (disposed) return;
    editor.render();
    paintRequest = win.requestAnimationFrame(paint);
  };
  paintRequest = win.requestAnimationFrame(paint);
  return {
    read() {
      const draft = editor.getDraftSnapshot();
      return {
        ...model,
        meta: {
          ...model.meta,
          title: draft.meta.title,
          unit: draft.meta.unit,
          recentColors: draft.meta.recentColors,
        },
        elements: draft.slides[0].elements,
      };
    },
    commit() {
      editor.exitTextEditing();
      if (pendingImages > 0) return Promise.reject(new Error("An image is still being placed. Keep this board open and save again once it appears."));
      return Promise.resolve();
    },
    setStatus(message) { if (status.textContent !== message) status.textContent = message; },
    setActions(actions) { header.append(...actions); },
    setTitle(label) { if (title.textContent !== label) title.textContent = label; },
    fit: fitAll,
    viewport: () => ({ ...viewport }),
    selection: () => editor.getSelection(),
    hasPendingImages: () => pendingImages > 0,
    setTheme(next) {
      editor.exitTextEditing();
      theme = next;
      root.dataset.theme = next;
      editor.markDirty();
      editor.render();
      drawMinimap();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (paintRequest !== null) win.cancelAnimationFrame(paintRequest);
      observer.disconnect();
      abort.abort();
      if (frameRequest !== null) win.cancelAnimationFrame(frameRequest);
      for (const reader of readers)
        if (reader.readyState === FileReader.LOADING) reader.abort();
      for (const off of subscriptions) off();
      editor.detach();
      root.replaceChildren();
    },
  };
}
