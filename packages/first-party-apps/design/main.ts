import { DesignImagePreviews, isDesignAssetRef } from "./src/image-assets";
import { focusMenu, installMenuKeyboard } from "./src/editor/menu-keyboard";
/**
 * Nautilo Design — interactive canvas editor mount.
 *
 * Replaces the V1 read-only viewer. Reads the bound `.design.html` through the
 * host `window.nautiloApp` bridge, parses the scene graph, and drives a
 * three-pane editor (left structure/layers, center SVG canvas, right
 * inspector) on top of the renderer-neutral scene model. The scene graph JSON
 * remains the source of truth; SVG DOM is only a render output. Edits autosave
 * back through the bridge and the active context (selection + scene brief) is
 * published so Genie sees the exact scene state.
 *
 * Plain TypeScript + DOM + inline SVG only — no framework, no external fetches,
 * CSP-safe under the strict srcdoc sandbox.
 */

import {
  createDefaultManifest,
  parseDesignHtml,
  serializeDesignHtml,
  type DesignHtmlManifest,
} from "./src/design-document";
import {
  collectiveBounds,
  createEmptyDocument,
  findPage,
  type DesignDocument,
} from "./src/scene-graph";
import { copyDesignFragment, type DesignFragment } from "./src/organization";
import { encodeDesignClipboard, decodeDesignClipboard, DESIGN_CLIPBOARD_MIME } from "./src/editor/clipboard";
import { nodeTransformMatrix } from "./src/geometry";
import { paintOrder, selectionBounds } from "./src/editor/selection";
import { visualBounds } from "./src/transactions";
import {
  getNautiloApp,
  isNoDocumentError,
  parseDocumentEnvelope,
  type NautiloAppBridge,
  type NautiloDocumentEnvelope,
  type NautiloDocumentPatchAppliedEvent,
} from "./src/bridge";
import {
  bridgeWriteResult,
  DesignAutosave,
  type AutosaveState,
} from "./src/autosave";
import { designDraftRecoveryStateAdapter, readDesignDraftRecoveryState } from "./src/draft-recovery";
import { createBrowserTextMeasurer, layoutTextNode, textRenderStyle } from "./src/text-layout";
import { importSvgFragment } from "./src/svg-import";
import { renderPathControls } from "./src/editor/path-controls";
import { pathEditTransaction, type PathEdit } from "./src/editor/path-commands";
import type { VectorPart } from "./src/editor/vector-edit";
import { DesignStore, type ChangeReason, type EditorState } from "./src/editor/store";
import { createViewport, fitBounds, setZoom, zoomAt, type Point, type Viewport } from "./src/editor/viewport";
import { createCanvasRenderer, type CanvasRenderer } from "./src/editor/render";
import { attachCanvasInteractions, type Tool } from "./src/editor/interactions";
import {
  actionLabel,
  creationBarModeForWidth,
  type CreationActionId,
  SHAPE_ACTIONS,
} from "./src/editor/creation-bar";
import { renderInspector, renderLayersPanel } from "./src/editor/panels";
import { createDesignIcon, type DesignIconName } from "./src/icons";
import { buildVector, type PenPath } from "./src/editor/pen";
import { publishContext } from "./src/editor/context";
import {
  acceptsCanvasPanningShortcut,
  acceptsEditorShortcut,
  historyControlState,
  initialToolForLoad,
} from "./src/editor/shell";
import {
  createCanvasLayout,
  closeNarrowDrawer,
  exitFullCanvas,
  toggleCanvasPanel,
  toggleFullCanvas,
  type CanvasLayout,
  type CanvasPanel,
} from "./src/editor/canvas-layout";
import {
  emptyViewportState,
  isViewportStranded,
  parseViewportState,
  saveViewportForPage,
  viewportStateWriteDisposition,
  type DesignViewportState,
} from "./src/editor/viewport-state";
import { isArtifactStateUnavailable, ViewportWriteQueue } from "./src/editor/viewport-write-queue";
import {
  AgentReceiptState,
  deriveAgentReceipt,
  receiptInspectableNodeIds,
  receiptObjectDetail,
} from "./src/agent-receipt";

const DRAFT_RECOVERY_KEY = "nautilo-design.draft-recovery.v1";
const DRAFT_RECOVERY_SCOPE = "bound-artifact";
const VIEWPORT_STATE_KEY = "nautilo-design.viewport.v1";

const SHAPE_ICONS: Record<(typeof SHAPE_ACTIONS)[number], DesignIconName> = {
  rectangle: "rectangle",
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
  pentagon: "pentagon",
  hexagon: "hexagon",
  star: "star",
  arrow: "arrow",
};

function isShapeAction(tool: Tool): tool is (typeof SHAPE_ACTIONS)[number] {
  return SHAPE_ACTIONS.includes(tool as (typeof SHAPE_ACTIONS)[number]);
}

function statusLabel(state: AutosaveState): string {
  switch (state.status) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "unsaved":
      return "Unsaved";
    case "conflict":
      return "Conflict";
    case "failed":
      return "Save failed";
    case "unavailable":
      return "Document deleted";
    default:
      return state.dirty ? "Unsaved" : "Saved";
  }
}

export class DesignEditor {
  private availability: "loading" | "ready" | "failed" | "deleted" = "loading";
  private disposed = false;
  private imagePreviews: DesignImagePreviews;
  private readonly menuCleanups: Array<() => void> = [];
  private pickingImage = false;
  private readonly bridge: NautiloAppBridge | null;
  private readonly root: HTMLElement;
  private store: DesignStore;
  private manifest: DesignHtmlManifest;
  private documentPath: string | undefined;
  private viewport: Viewport = createViewport();
  private viewportState: DesignViewportState = emptyViewportState();
  private viewportStateEligible = false;
  private viewportStateUnavailable = false;
  private viewportStateReady = false;
  private viewportRestoreGeneration = 0;
  private readonly viewportWriteQueue: ViewportWriteQueue<DesignViewportState>;
  private layout: CanvasLayout = createCanvasLayout();
  private readonly collapsedPanelSections = new Set<string>();
  private spacePanning = false;
  private tool: Tool = "select";
  private initialLoadHandled = false;
  private savedCopyContent: string | null = null;
  private userHasChosenTool = false;
  private autosave: DesignAutosave | null = null;
  private readonly receipts = new AgentReceiptState();
  private receiptsEnabled = true;
  private lifecycleUnsubscribe: (() => void) | null = null;
  private documentUnsubscribe: (() => void) | null = null;
  private receiptPreferenceUnsubscribe: (() => void) | null = null;
  private renderer!: CanvasRenderer;
  private detachInteractions: (() => void) | null = null;
  private applyingRemote = false;
  private textEditor: { nodeId: string; el: HTMLTextAreaElement } | null = null;
  private editNodeId: string | null = null;
  private selectedVectorPart: VectorPart | null = null;
  private penPath: PenPath | null = null;
  private penCursor: Point | null = null;
  private clipboard: DesignFragment | null = null;

  // DOM references
  private statusEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private layersToggleBtn!: HTMLButtonElement;
  private inspectorToggleBtn!: HTMLButtonElement;
  private fullCanvasBtn!: HTMLButtonElement;
  private leftPanel!: HTMLElement;
  private rightPanel!: HTMLElement;
  private layersHost!: HTMLElement;
  private inspectorHost!: HTMLElement;
  private layersCollapseBtn!: HTMLButtonElement;
  private inspectorCollapseBtn!: HTMLButtonElement;
  private canvasEl!: HTMLElement;
  private canvasHintEl!: HTMLElement;
  private topbarEl!: HTMLElement;
  private creationBarEl!: HTMLElement;
  private activeToolEl!: HTMLElement;
  private shapeButton!: HTMLButtonElement;
  private shapeMenu!: HTMLElement;
  private overflowButton!: HTMLButtonElement;
  private overflowMenu!: HTMLElement;
  private readonly creationToolButtons = new Map<CreationActionId, HTMLButtonElement>();
  private topbarResizeObserver: ResizeObserver | null = null;
  private lastShape: CreationActionId = "rectangle";
  private zoomEl!: HTMLElement;
  private fitSelectionBtn!: HTMLButtonElement;
  private bannerHost!: HTMLElement;
  private receiptHost!: HTMLElement;
  private receiptPreferenceBtn!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.bridge = getNautiloApp();
    this.imagePreviews = new DesignImagePreviews(async (ref) => {
      if (!this.bridge?.assets) throw new Error("Image access is unavailable in this host. Reopen with the current Nautilo Design app.");
      return this.bridge.assets.read(ref);
    }, () => { if (!this.disposed) { this.renderCanvas(); this.renderPanels(); } });
    this.viewportWriteQueue = new ViewportWriteQueue((state) => this.writeViewportState(state));
    this.manifest = createDefaultManifest();
    this.store = new DesignStore(createEmptyDocument());
    this.buildShell();
    this.setAvailability("loading");
    this.store.subscribe((reason, state) => this.onStoreChange(reason, state));
  }

  // ----- shell -----

  private buildShell(): void {
    this.root.textContent = "";
    const app = document.createElement("div");
    app.className = "design-app";
    this.appEl = app;

    // Top bar: the host chrome already shows the filename, app name, close,
    // and export actions, so our strip carries save state and local controls.
    // Never repeat the document title here (that was the "double header" bug).
    const header = document.createElement("header");
    header.className = "design-topbar";
    this.topbarEl = header;
    this.statusEl = document.createElement("span");
    this.statusEl.className = "design-topbar__status";
    this.statusEl.textContent = "Saved";
    header.appendChild(this.statusEl);
    const history = document.createElement("div");
    history.className = "design-topbar__history";
    this.undoBtn = this.topbarButton("Undo", "undo", () => this.store.undo(), "Undo (Cmd/Ctrl+Z)");
    history.appendChild(this.undoBtn);
    this.redoBtn = this.topbarButton("Redo", "redo", () => this.store.redo(), "Redo (Cmd/Ctrl+Shift+Z)");
    history.appendChild(this.redoBtn);
    header.appendChild(history);

    this.creationBarEl = document.createElement("div");
    this.creationBarEl.className = "design-topbar__creation";
    for (const action of ["select", "frame", "text"] as const) {
      this.creationBarEl.appendChild(this.creationToolButton(action, action === "select" ? "select" : action));
    }
    const shapes = document.createElement("div");
    shapes.className = "design-shapes";
    this.shapeButton = this.topbarButton("Shapes", "shapes", () => this.toggleShapeMenu(), "Choose a shape");
    this.shapeButton.classList.add("design-topbar__shape-button");
    this.shapeButton.setAttribute("aria-haspopup", "menu");
    this.shapeButton.setAttribute("aria-expanded", "false");
    shapes.appendChild(this.shapeButton);
    this.shapeMenu = document.createElement("div");
    this.shapeMenu.className = "design-shapes__menu";
    this.shapeMenu.setAttribute("role", "menu");
    this.shapeMenu.hidden = true;
    for (const action of SHAPE_ACTIONS) {
      const item = this.creationToolButton(action, SHAPE_ICONS[action], true);
      item.classList.add("design-shapes__item");
      item.setAttribute("role", "menuitem");
      this.shapeMenu.appendChild(item);
    }
    shapes.appendChild(this.shapeMenu);
    this.creationBarEl.appendChild(shapes);
    this.creationBarEl.appendChild(this.creationToolButton("pen", "pen"));
    this.creationBarEl.appendChild(this.creationToolButton("connector", "connector"));
    this.creationBarEl.appendChild(this.topbarButton("Place image", "image", () => void this.placeImage()));
    header.appendChild(this.creationBarEl);

    this.activeToolEl = document.createElement("span");
    this.activeToolEl.className = "design-topbar__active-tool";
    header.appendChild(this.activeToolEl);

    const actions = document.createElement("div");
    actions.className = "design-topbar__actions";
    this.layersToggleBtn = this.layoutButton("Layers", "layers");
    actions.appendChild(this.layersToggleBtn);
    this.inspectorToggleBtn = this.layoutButton("Inspector", "inspector");
    actions.appendChild(this.inspectorToggleBtn);
    this.fullCanvasBtn = this.topbarButton("Full canvas", "expand", () => this.setLayout(toggleFullCanvas(this.layout)));
    this.fullCanvasBtn.dataset["viewAction"] = "full-canvas";
    actions.appendChild(this.fullCanvasBtn);
    header.appendChild(actions);
    this.buildOverflowMenu(header);
    this.menuCleanups.push(installMenuKeyboard(this.shapeMenu, this.shapeButton, { close: () => this.closeShapeMenu() }), installMenuKeyboard(this.overflowMenu, this.overflowButton, { close: () => this.closeOverflowMenu() }));
    this.syncHistoryControls();

    this.bannerHost = document.createElement("div");
    this.bannerHost.className = "design-banners";

    const body = document.createElement("div");
    body.className = "design-body";
    this.leftPanel = document.createElement("aside");
    this.leftPanel.className = "design-panel design-panel--left";
    this.leftPanel.id = "design-layers-panel";
    this.layersCollapseBtn = this.panelCollapseButton("layers");
    this.leftPanel.appendChild(this.layersCollapseBtn);
    this.layersHost = document.createElement("div");
    this.layersHost.className = "design-layers-host";
    this.leftPanel.appendChild(this.layersHost);
    this.canvasEl = document.createElement("main");
    this.canvasEl.className = "design-canvas";
    this.rightPanel = document.createElement("aside");
    this.rightPanel.className = "design-panel design-panel--right";
    this.rightPanel.id = "design-inspector-panel";
    this.inspectorCollapseBtn = this.panelCollapseButton("inspector");
    this.rightPanel.appendChild(this.inspectorCollapseBtn);
    // The Inspector remains a supporting surface. Genie context is published
    // through the bridge, rather than duplicated as a database-style panel.
    this.inspectorHost = document.createElement("div");
    this.inspectorHost.className = "design-inspector-host";
    this.rightPanel.appendChild(this.inspectorHost);
    body.appendChild(this.leftPanel);
    body.appendChild(this.canvasEl);
    body.appendChild(this.rightPanel);

    app.appendChild(header);
    app.appendChild(this.bannerHost);
    app.appendChild(body);
    this.root.appendChild(app);

    // Canvas renderer
    this.renderer = createCanvasRenderer();
    this.canvasEl.appendChild(this.renderer.svg);

    this.receiptHost = document.createElement("section");
    this.receiptHost.className = "design-receipt";
    this.receiptHost.hidden = true;
    this.receiptHost.setAttribute("role", "status");
    this.receiptHost.setAttribute("aria-label", "Latest Genie change");
    this.receiptHost.setAttribute("aria-live", "polite");
    this.canvasEl.appendChild(this.receiptHost);

    // Subtle centered hint shown while the active page has no nodes.
    this.canvasHintEl = document.createElement("div");
    this.canvasHintEl.className = "design-canvas__hint";
    this.canvasHintEl.textContent = "Drag to create your first frame.";
    this.canvasEl.appendChild(this.canvasHintEl);

    // Navigation-only controls are pinned to the canvas; creation lives in the
    // responsive top bar so this strip can stay bounded as tools expand.
    const zoombar = document.createElement("div");
    zoombar.className = "design-zoombar";
    zoombar.appendChild(this.zoomButton("Zoom out", "−", () => this.zoomBy(1 / 1.2)));
    this.zoomEl = document.createElement("span");
    this.zoomEl.className = "design-zoombar__zoom";
    this.zoomEl.setAttribute("aria-label", "Canvas zoom");
    this.zoomEl.textContent = "100%";
    zoombar.appendChild(this.zoomEl);
    zoombar.appendChild(this.zoomButton("Zoom in", "+", () => this.zoomBy(1.2)));
    zoombar.appendChild(this.zoomButton("Set zoom to 100%", "100%", () => this.resetZoom()));
    zoombar.appendChild(this.zoomButton("Fit page", "Fit page", () => this.zoomToFit(true)));
    this.fitSelectionBtn = this.zoomButton("Fit selection", "Fit selection", () => this.zoomToSelection());
    zoombar.appendChild(this.fitSelectionBtn);
    this.canvasEl.appendChild(zoombar);

    this.detachInteractions = attachCanvasInteractions({
      svg: this.renderer.svg,
      store: this.store,
      getViewport: () => this.viewport,
      setViewport: (viewport) => {
        this.setViewport(viewport, true);
      },
      getSpacePanning: () => this.spacePanning,
      getTool: () => this.tool,
      setTool: (tool) => this.setTool(tool),
      onTextEdit: (nodeId) => this.openTextEditor(nodeId),
      getEditNodeId: () => this.editNodeId,
      setEditNodeId: (nodeId) => {
        this.editNodeId = nodeId;
        this.renderCanvas();
      },
      onVectorPartSelected: (part) => { this.selectedVectorPart = part; this.renderPanels(); },
      getPen: () => this.penPath,
      setPen: (pen, cursor) => this.setPen(pen, cursor),
      commitPen: (path) => this.commitPen(path),
    });

    window.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("copy", this.onClipboardCopy);
    document.addEventListener("cut", this.onClipboardCopy);
    document.addEventListener("paste", this.onClipboardPaste);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
    this.syncLayoutControls();
    this.syncCreationControls();
    this.observeTopbar();
  }

  private appEl!: HTMLElement;

  private layoutButton(label: string, panel: CanvasPanel): HTMLButtonElement {
    const icon = panel === "layers" ? "layers" : "inspector";
    const button = this.topbarButton(label, icon, () => this.setLayout(toggleCanvasPanel(this.layout, panel, this.isNarrowLayout())));
    button.dataset["viewAction"] = panel;
    button.setAttribute("aria-controls", panel === "layers" ? "design-layers-panel" : "design-inspector-panel");
    return button;
  }

  private panelCollapseButton(panel: CanvasPanel): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `design-panel__collapse design-panel__collapse--${panel}`;
    button.appendChild(createDesignIcon(document, "chevron"));
    button.addEventListener("click", () => {
      (panel === "layers" ? this.layersToggleBtn : this.inspectorToggleBtn).click();
    });
    return button;
  }

  private topbarButton(
    label: string,
    icon: DesignIconName,
    onClick: () => void,
    title = label,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-topbar__button";
    button.setAttribute("aria-label", label);
    button.title = title;
    button.appendChild(createDesignIcon(document, icon));
    const text = document.createElement("span");
    text.className = "design-topbar__button-label";
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener("click", onClick);
    return button;
  }

  private creationToolButton(action: CreationActionId, icon: DesignIconName, menuItem = false): HTMLButtonElement {
    const label = actionLabel(action);
    const button = this.topbarButton(label, icon, () => {
      this.setTool(action as Tool, { userInitiated: true });
      this.closeShapeMenu();
      this.closeOverflowMenu();
    });
    button.classList.add("design-topbar__creation-button");
    button.dataset["creationAction"] = action;
    if (menuItem) button.classList.add("design-topbar__menu-button");
    this.creationToolButtons.set(action, button);
    return button;
  }

  private buildOverflowMenu(header: HTMLElement): void {
    const overflow = document.createElement("div");
    overflow.className = "design-topbar__overflow";
    this.overflowButton = this.topbarButton("More tools", "more", () => this.toggleOverflowMenu(), "More tools");
    this.overflowButton.classList.add("design-topbar__overflow-button");
    this.overflowButton.setAttribute("aria-haspopup", "menu");
    this.overflowButton.setAttribute("aria-expanded", "false");
    overflow.appendChild(this.overflowButton);
    this.overflowMenu = document.createElement("div");
    this.overflowMenu.className = "design-topbar__overflow-menu";
    this.overflowMenu.setAttribute("role", "menu");
    this.overflowMenu.hidden = true;
    this.appendOverflowGroup("Edit", [
      ["Undo", "undo", () => this.store.undo()],
      ["Redo", "redo", () => this.store.redo()],
    ]);
    this.appendOverflowGroup("Create", [
      ["Select", "select", () => this.setTool("select", { userInitiated: true })],
      ["Frame", "frame", () => this.setTool("frame", { userInitiated: true })],
      ["Text", "text", () => this.setTool("text", { userInitiated: true })],
      ...SHAPE_ACTIONS.map((action) => [actionLabel(action), "shapes" as const, () => this.setTool(action as Tool, { userInitiated: true })] as const),
      ["Place image", "image", () => void this.placeImage()],
      ["Pen", "pen", () => this.setTool("pen", { userInitiated: true })],
      ["Import SVG…", "shapes", () => this.chooseSvgImport()],
      ["Connector", "connector", () => this.setTool("connector" as Tool, { userInitiated: true })],
    ]);
    this.appendOverflowGroup("Objects", [
      ["Select all", "select", () => this.selectAll()],
      ["Copy", "select", () => void this.copyObjects(false)],
      ["Cut", "select", () => void this.copyObjects(true)],
      ["Paste", "select", () => void this.pasteObjects()],
      ["Duplicate", "shapes", () => this.duplicateSelection()],
      ["Group", "layers", () => this.groupSelection(false)],
      ["Ungroup", "layers", () => this.groupSelection(true)],
      ["Flip horizontal", "select", () => this.flipSelection("horizontal")],
      ["Flip vertical", "select", () => this.flipSelection("vertical")],
    ]);
    const viewGroup = this.appendOverflowGroup("View", [
      ["Layers", "layers", () => this.layersToggleBtn.click()],
      ["Inspector", "inspector", () => this.inspectorToggleBtn.click()],
      ["Full canvas", "expand", () => this.fullCanvasBtn.click()],
    ]);
    this.receiptPreferenceBtn = this.topbarButton("Genie receipts: On", "inspector", () => {
      void this.setReceiptsEnabled(!this.receiptsEnabled);
      this.closeOverflowMenu();
    });
    this.receiptPreferenceBtn.classList.add("design-topbar__menu-button");
    this.receiptPreferenceBtn.setAttribute("role", "menuitemcheckbox");
    viewGroup.appendChild(this.receiptPreferenceBtn);
    this.syncReceiptPreferenceControl();
    overflow.appendChild(this.overflowMenu);
    header.appendChild(overflow);
  }

  private appendOverflowGroup(
    label: string,
    entries: ReadonlyArray<readonly [string, DesignIconName, () => void]>,
  ): HTMLElement {
    const group = document.createElement("section");
    group.className = "design-topbar__overflow-group";
    group.dataset["overflowGroup"] = label.toLowerCase();
    const heading = document.createElement("h2");
    heading.textContent = label;
    group.appendChild(heading);
    for (const [buttonLabel, icon, onClick] of entries) {
      const button = this.topbarButton(buttonLabel, icon, () => {
        onClick();
        this.closeOverflowMenu();
      });
      button.classList.add("design-topbar__menu-button");
      button.setAttribute("role", "menuitem");
      group.appendChild(button);
    }
    this.overflowMenu.appendChild(group);
    return group;
  }

  private zoomButton(label: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-zoombar__button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private toggleShapeMenu(): void {
    const open = this.shapeMenu.hidden;
    this.shapeMenu.hidden = !open;
    this.shapeButton.setAttribute("aria-expanded", String(open));
    if (open) { this.closeOverflowMenu(); focusMenu(this.shapeMenu); }
  }

  private closeShapeMenu(): void {
    if (this.shapeMenu.contains(document.activeElement)) this.shapeButton.focus();
    this.shapeMenu.hidden = true;
    this.shapeButton.setAttribute("aria-expanded", "false");
  }

  private toggleOverflowMenu(): void {
    const open = this.overflowMenu.hidden;
    this.overflowMenu.hidden = !open;
    this.overflowButton.setAttribute("aria-expanded", String(open));
    if (open) { this.closeShapeMenu(); focusMenu(this.overflowMenu); }
  }

  private closeOverflowMenu(): void {
    if (this.overflowMenu.contains(document.activeElement)) this.overflowButton.focus();
    this.overflowMenu.hidden = true;
    this.overflowButton.setAttribute("aria-expanded", "false");
  }

  private closeOpenMenuForEscape(): boolean {
    if (!this.shapeMenu.hidden) {
      this.closeShapeMenu();
      this.shapeButton.focus();
      return true;
    }
    if (!this.overflowMenu.hidden) {
      this.closeOverflowMenu();
      this.overflowButton.focus();
      return true;
    }
    return false;
  }

  private displayToolLabel(tool: Tool): string {
    if (tool === "polygon") return "Triangle";
    if (tool === "line") return "Line";
    return actionLabel(tool as CreationActionId);
  }

  private syncCreationControls(): void {
    if (this.tool === "polygon") {
      this.lastShape = "triangle";
    } else if (isShapeAction(this.tool)) {
      this.lastShape = this.tool;
    }
    for (const [action, button] of this.creationToolButtons) {
      const active = action === this.tool;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const shapeActive = isShapeAction(this.tool) || this.tool === "polygon";
    this.shapeButton.classList.toggle("is-active", shapeActive);
    this.shapeButton.setAttribute("aria-pressed", String(shapeActive));
    this.shapeButton.setAttribute("aria-label", `Shapes — ${actionLabel(this.lastShape)}`);
    this.shapeButton.title = `Shapes — ${actionLabel(this.lastShape)}`;
    const label = this.shapeButton.querySelector<HTMLElement>(".design-topbar__button-label");
    if (label) label.textContent = `Shapes: ${actionLabel(this.lastShape)}`;
    this.activeToolEl.textContent = `Tool: ${this.displayToolLabel(this.tool)}`;
    // Legacy Line remains keyboard-addressable (L) even though the compact
    // creation model folds common geometry into Shapes. Keep that active tool
    // explicit rather than leaving a person with an invisible drawing mode.
    this.appEl.classList.toggle("has-unrepresented-active-tool", this.tool === "line");
    this.syncTopbarMode();
  }

  private topbarIntrinsicWidth(): number {
    const children = [...this.topbarEl.children] as HTMLElement[];
    // Bounding boxes only include the bar's direct flow children. Popups are
    // absolutely positioned, so an open Shapes/overflow menu cannot inflate a
    // threshold or cause the ResizeObserver to flip presentation modes.
    const widths = children.map((child) => child.getBoundingClientRect().width).filter((width) => width > 0);
    return Math.ceil(widths.reduce((total, width) => total + width, 24 + Math.max(0, widths.length - 1) * 12));
  }

  private syncTopbarMode(): void {
    if (!this.topbarEl.isConnected) return;
    const available = this.topbarEl.clientWidth;
    if (available === 0) return;
    this.appEl.dataset["topbarMode"] = "wide";
    const wide = this.topbarIntrinsicWidth();
    this.appEl.dataset["topbarMode"] = "compact";
    const compact = this.topbarIntrinsicWidth();
    const mode = creationBarModeForWidth(available, { wide, compact });
    this.appEl.dataset["topbarMode"] = mode;
    if (mode === "wide") this.closeOverflowMenu();
  }

  private observeTopbar(): void {
    this.syncTopbarMode();
    if (typeof ResizeObserver === "undefined") return;
    this.topbarResizeObserver = new ResizeObserver(() => this.syncTopbarMode());
    this.topbarResizeObserver.observe(this.topbarEl);
  }

  private setTool(tool: Tool, options: { userInitiated?: boolean } = {}): void {
    // Switching tools drops any in-progress pen path and node-edit session so
    // stale affordances never linger.
    if (tool !== "pen" && this.penPath) this.setPen(null, null);
    if (tool !== "select") this.editNodeId = null;
    if (options.userInitiated) this.userHasChosenTool = true;
    this.tool = tool;
    this.syncCreationControls();
    this.renderer.svg.dataset["tool"] = tool;
    this.renderCanvas();
  }

  // ----- pen tool -----

  private setPen(pen: PenPath | null, cursor: Point | null): void {
    this.penPath = pen;
    this.penCursor = cursor;
    this.renderCanvas();
  }

  private commitPen(path: PenPath): void {
    const built = buildVector(path);
    this.setPen(null, null);
    if (!built) return;
    const id = this.store.addVectorNode(built);
    this.store.setSelection([id]);
    this.setTool("select");
  }

  /** Finish an open pen path (Enter). Cancel discards it (Escape). */
  private finishPen(): void {
    if (!this.penPath) return;
    this.commitPen(this.penPath);
  }

  private cancelPen(): void {
    if (!this.penPath) return;
    this.setPen(null, null);
  }

  // ----- lifecycle -----

  private setAvailability(state: "loading" | "ready" | "failed" | "deleted"): void {
    this.availability = state;
    this.root.setAttribute("aria-busy", String(state === "loading"));
    this.topbarEl.inert = state !== "ready";
    const body = this.appEl.querySelector<HTMLElement>(".design-body");
    if (body) body.inert = state !== "ready";
  }

  private focusPanelTrigger(panel: CanvasPanel): void {
    const button = panel === "layers" ? this.layersToggleBtn : this.inspectorToggleBtn;
    // Minimal bars hide the direct controls. More tools is their visible return point.
    (button.getClientRects().length ? button : this.overflowButton).focus();
  }

  private async placeImage(replaceNodeId?: string): Promise<void> {
    if (this.availability !== "ready" || this.pickingImage) return;
    const pageId = this.store.getState().activePageId;
    this.pickingImage = true;
    try {
      if (!this.bridge?.assets) throw new Error("Image placement requires the current Nautilo Design host.");
      const asset = await this.bridge.assets.pick();
      if (!asset || this.disposed || this.availability !== "ready") return;
      if (!isDesignAssetRef(asset.ref) || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0) throw new Error("The host returned an invalid image reference.");
      const size = this.canvasSize();
      const fit = Math.min(1, size.width / (asset.width * this.viewport.scale), size.height / (asset.height * this.viewport.scale));
      const width = asset.width * fit;
      const height = asset.height * fit;
      const result = this.store.transact(replaceNodeId
        ? { kind: "image", nodeId: replaceNodeId, assetRef: asset.ref }
        : { kind: "create", pageId, node: {
            type: "image", assetRef: asset.ref, name: asset.name.split("/").pop() || "Image",
            x: (size.width / 2 - this.viewport.tx) / this.viewport.scale - width / 2,
            y: (size.height / 2 - this.viewport.ty) / this.viewport.scale - height / 2,
            width, height,
          } });
      if (!result.ok) throw new Error(`Image saved in Workspace, but placement could not finish: ${result.error.message}`);
      const nodeId = replaceNodeId ?? result.receipt.changedNodeIds[0];
      if (nodeId) this.store.setSelection([nodeId]);
      this.setTool("select");
    } catch (error) {
      if (!this.disposed) this.showBanner("error", error instanceof Error ? error.message : "Could not place image.");
    } finally { this.pickingImage = false; }
  }

  private renderImageControls(nodeId: string): void {
    const node = this.store.getDocument().nodes[nodeId];
    if (!node) return;
    const section = document.createElement("section");
    section.className = "design-inspector__section";
    section.setAttribute("aria-label", "Image source");
    const preview = node.assetRef ? this.imagePreviews.entries.get(node.assetRef) : undefined;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = !node.assetRef ? "Legacy image source. Replace it to use a saved Workspace image."
      : preview?.status === "failed" ? preview.message
      : preview?.status === "ready" ? "Image linked to Workspace."
      : "Loading image…";
    const replace = this.bannerButton("Replace image", () => void this.placeImage(nodeId));
    replace.disabled = node.locked === true;
    section.append(status, replace);
    if (node.assetRef && preview?.status === "failed") {
      section.appendChild(this.bannerButton("Retry image", () => {
        this.imagePreviews.retry(node.assetRef!); this.renderCanvas(); this.renderPanels();
      }));
    }
    this.inspectorHost.appendChild(section);
  }

  private isDeleted(): boolean { return this.availability === "deleted"; }

  async start(): Promise<void> {
    if (this.disposed || this.isDeleted()) return;
    this.setAvailability("loading");
    this.clearBanner("error");
    this.statusEl.textContent = "Loading…";
    this.initializeReceiptPreference();
    if (!this.bridge) {
      this.setupAutosave(null);
      this.loadNewEmptyScene();
      this.setAvailability("ready");
      this.showBanner("info", "No document is bound. Editing a blank canvas; changes will not persist.");
      return;
    }
    this.setupAutosave(this.bridge);
    this.subscribeDocumentChanges(this.bridge);
    try {
      const raw = await this.bridge.document.read();
      const envelope = parseDocumentEnvelope(raw);
      if (!envelope) throw new Error("Unexpected document envelope from host.");
      if (this.disposed || this.isDeleted()) return;
      this.applyEnvelope(envelope);
      await this.restoreDraftRecovery();
      if (!this.disposed && !this.isDeleted()) this.setAvailability("ready");
    } catch (err) {
      if (this.disposed || this.isDeleted()) return;
      if (isNoDocumentError(err)) {
        this.setupAutosave(null);
        this.loadNewEmptyScene();
        this.setAvailability("ready");
        this.showBanner("info", "No document is bound. Editing a blank canvas; changes will not persist.");
        return;
      }
      if (this.disposed || this.isDeleted()) return;
      this.setAvailability("failed");
      this.statusEl.textContent = "Could not load";
      this.showBanner("error", err instanceof Error ? err.message : "Failed to load document.");
      this.bannerHost.querySelector('[data-kind="error"]')?.appendChild(this.bannerButton("Retry load", () => void this.start()));
    }
  }

  private initializeReceiptPreference(): void {
    const preferences = this.bridge?.preferences;
    if (!preferences) return;
    void preferences
      .get<{ enabled?: unknown }>("design.agentReceipts")
      .then((value) => this.applyReceiptPreference(value))
      .catch(() => undefined);
    this.receiptPreferenceUnsubscribe = preferences.subscribe<{ enabled?: unknown }>(
      "design.agentReceipts",
      (value) => this.applyReceiptPreference(value),
    );
  }

  private applyReceiptPreference(value: { enabled?: unknown }): void {
    if (typeof value.enabled !== "boolean") return;
    this.receiptsEnabled = value.enabled;
    if (!value.enabled) this.receipts.clear();
    this.syncReceiptPreferenceControl();
    this.renderReceipt();
  }

  private async setReceiptsEnabled(enabled: boolean): Promise<void> {
    this.applyReceiptPreference({ enabled });
    try {
      await this.bridge?.preferences?.set("design.agentReceipts", { enabled });
    } catch {
      // The toggle still applies to this editor session if device persistence
      // is unavailable.
    }
  }

  private syncReceiptPreferenceControl(): void {
    if (!this.receiptPreferenceBtn) return;
    const label = `Genie receipts: ${this.receiptsEnabled ? "On" : "Off"}`;
    this.receiptPreferenceBtn.setAttribute("aria-label", label);
    this.receiptPreferenceBtn.setAttribute("aria-checked", String(this.receiptsEnabled));
    const text = this.receiptPreferenceBtn.querySelector<HTMLElement>(".design-topbar__button-label");
    if (text) text.textContent = label;
  }

  private setupAutosave(bridge: NautiloAppBridge | null): void {
    this.autosave?.destroy();
    if (!bridge) {
      this.autosave = null;
      return;
    }
    this.autosave = new DesignAutosave(
      async (content, base) => {
        const result = await bridge.document.write(
          { content },
          { baseSha256: base.sha256, baseRevision: base.revision },
        );
        return bridgeWriteResult(result);
      },
      async () => {
        const raw = await bridge.document.read();
        const env = parseDocumentEnvelope(raw);
        if (!env) return null;
        return {
          content: env.content,
          ...(env.path !== undefined ? { path: env.path } : {}),
          baseSha256: env.baseSha256,
          baseRevision: env.baseRevision,
        };
      },
    );
    this.autosave.subscribe((state) => this.onAutosaveState(state));
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = bridge.lifecycle?.onPrepareClose(async (request) => {
      // A failed initial read never enabled editing or admitted a local draft.
      if (this.availability === "failed" && !this.initialLoadHandled) {
        return { noLocalChanges: true, documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false, errorMessage: null };
      }
      if (request.action === "save-copy") return this.saveDraftCopy();
      const result = await this.autosave!.flush();
      await this.viewportWriteQueue.flush();
      const exact = this.autosave!.getState().recoverableDraftExact;
      const copied = exact && this.savedCopyContent !== null && this.savedCopyContent === this.autosave!.getSaveCopyContent();
      return { documentSaved: result.documentSaved, recoveryPersisted: result.recoveryPersisted || copied,
        recoverableDraftExact: exact, errorMessage: copied ? null : result.errorMessage };
    }) ?? null;
  }

  private async restoreDraftRecovery(): Promise<void> {
    const state = this.bridge?.state;
    if (!state || !this.autosave) return;
    try {
      const recovery = await readDesignDraftRecoveryState(state, DRAFT_RECOVERY_KEY, DRAFT_RECOVERY_SCOPE);
      if (this.disposed || this.isDeleted()) return;
      this.autosave.configureRecovery(DRAFT_RECOVERY_SCOPE, designDraftRecoveryStateAdapter(state, DRAFT_RECOVERY_KEY));
      if (!recovery) return;
      const parsed = parseDesignHtml(recovery.content);
      if (!parsed.ok) { this.showBanner("error", "A saved recovery draft could not be opened. It has been retained."); return; }
      const result = this.autosave.restoreRecoveryDraft(recovery);
      if (result === "scope_mismatch") return;
      this.loadScene(parsed.document.scene, parsed.document.manifest, this.documentPath, recovery.content);
      this.showBanner("info", recovery.exact ? "Recovered your unsaved work." : "Recovered the last readable draft. Some later changes could not be serialized.");
    } catch {
      // Current-folder documents do not support artifact state. Close protection
      // still waits for a successful document save and refuses uncertain loss.
      this.showBanner("info", "Draft recovery is unavailable here. Closing will wait for your document to save.");
    }
  }

  private async saveDraftCopy(): Promise<{ documentSaved: boolean; recoveryPersisted: boolean; recoverableDraftExact: boolean; errorMessage: string | null }> {
    const content = this.autosave?.getSaveCopyContent();
    const exact = this.autosave?.getState().recoverableDraftExact ?? false;
    try {
      if (content === null || content === undefined || !this.bridge?.document.saveCopy) throw new Error("Save Copy is unavailable in this host. Keep this editor open and retry saving.");
      const result = await this.bridge.document.saveCopy({ content });
      if (exact) this.savedCopyContent = content;
      this.showBanner("info", `Saved recovery copy: ${result.path}`);
      return { documentSaved: false, recoveryPersisted: true, recoverableDraftExact: exact, errorMessage: null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Save Copy failed.";
      this.showBanner("error", message);
      return { documentSaved: false, recoveryPersisted: false, recoverableDraftExact: exact, errorMessage: message };
    }
  }

  private subscribeDocumentChanges(bridge: NautiloAppBridge): void {
    this.documentUnsubscribe?.();
    this.documentUnsubscribe = bridge.document.onChange?.((event) => {
      if (event.type === "deleted") {
        this.setAvailability("deleted");
        this.autosave?.markUnavailable("This document was deleted. Save a copy to keep your work.");
        this.closeTextEditor(true);
        this.cancelPen();
        this.store.cancelTransient();
        this.viewportStateEligible = false;
        try { this.autosave?.notifyChange(this.serializeCurrent()); }
        catch (cause) { this.autosave?.markSerializationFailure(cause instanceof Error ? cause.message : "Could not serialize the latest changes."); }
        this.showBanner("error", "This document was deleted. Save a copy to keep your work.");
        this.bannerHost.querySelector('[data-kind="error"]')?.appendChild(this.bannerButton("Save Copy", () => void this.saveDraftCopy()));
        return;
      }
      if (this.isDeleted()) return;
      if (event.type === "patch_applied") {
        this.applyAuthoredPatch(event);
        return;
      }
      void this.reloadFromHost(event.type === "renamed" || event.type === "changed" ? event.path : undefined);
    }) ?? null;
  }

  private applyAuthoredPatch(event: NautiloDocumentPatchAppliedEvent): void {
    const prior = this.autosave?.getSavedSnapshot();
    const receipt = prior ? deriveAgentReceipt(event, prior) : null;
    const patchPath = event.path ?? event.envelope.path;
    const applied = this.adoptRemoteEnvelope(
      {
        content: event.envelope.content,
        ...(event.envelope.mimeType !== undefined ? { mimeType: event.envelope.mimeType } : {}),
        ...(patchPath !== undefined ? { path: patchPath } : {}),
        baseSha256: event.envelope.baseSha256,
        baseRevision: event.envelope.baseRevision,
      },
      event.path,
    );
    if (applied && receipt && this.receiptsEnabled) {
      this.receipts.replace(receipt);
      this.renderReceipt();
    }
  }

  private applyEnvelope(envelope: NautiloDocumentEnvelope): void {
    this.receipts.clear();
    this.documentPath = envelope.path;
    // Do not let a blank/unbound draft create host state merely because the
    // person pans. A non-null optimistic revision/hash proves a durable read.
    this.viewportStateEligible = envelope.baseSha256 !== null || envelope.baseRevision !== null;
    this.viewportStateUnavailable = false;
    this.viewportStateReady = false;
    if (envelope.content.trim().length === 0) {
      this.loadInitialScene(createEmptyDocument(), createDefaultManifest(), envelope.path, "");
      this.autosave?.markInitialLoad("", envelope.baseSha256, envelope.baseRevision);
      void this.restoreViewportFromBridge();
      return;
    }
    const parsed = parseDesignHtml(envelope.content);
    if (!parsed.ok) throw new Error(parsed.error);
    this.loadInitialScene(parsed.document.scene, parsed.document.manifest, envelope.path, envelope.content);
    this.autosave?.markInitialLoad(envelope.content, envelope.baseSha256, envelope.baseRevision);
    void this.restoreViewportFromBridge();
  }

  private loadScene(
    scene: DesignDocument,
    manifest: DesignHtmlManifest,
    path: string | undefined,
    _initialContent: string,
  ): void {
    this.manifest = manifest;
    this.documentPath = path;
    this.applyingRemote = true;
    try {
      this.store.replaceDocument(scene, { keepSelection: true });
    } finally {
      this.applyingRemote = false;
    }
    this.zoomToFit();
    this.renderAll();
    this.publish();
  }

  /** Initial document load alone can make a blank canvas immediately drawable. */
  private loadInitialScene(
    scene: DesignDocument,
    manifest: DesignHtmlManifest,
    path: string | undefined,
    initialContent: string,
  ): void {
    const initialTool = initialToolForLoad({
      isInitialLoad: !this.initialLoadHandled,
      document: scene,
      userHasChosenTool: this.userHasChosenTool,
    });
    this.initialLoadHandled = true;
    if (initialTool) this.setTool(initialTool);
    this.loadScene(scene, manifest, path, initialContent);
  }

  private loadNewEmptyScene(): void {
    this.loadInitialScene(createEmptyDocument(), createDefaultManifest(), undefined, "");
  }

  private async reloadFromHost(pathOverride?: string): Promise<void> {
    if (!this.bridge || !this.autosave) return;
    try {
      const raw = await this.bridge.document.read();
      const envelope = parseDocumentEnvelope(raw);
      if (!envelope) return;
      this.adoptRemoteEnvelope(envelope, pathOverride);
    } catch (err) {
      this.showBanner("error", err instanceof Error ? err.message : "Failed to reload document.");
    }
  }

  /** Returns false when the autosave boundary retained the local draft/conflict. */
  private adoptRemoteEnvelope(envelope: NautiloDocumentEnvelope, pathOverride?: string): boolean {
    if (!this.autosave) return false;
    try {
      this.documentPath = pathOverride ?? envelope.path ?? this.documentPath;
      const content = this.autosave.applyRemoteEnvelope({
        content: envelope.content,
        baseSha256: envelope.baseSha256,
        baseRevision: envelope.baseRevision,
      });
      if (this.autosave.getState().status === "conflict") return false;
      if (content.trim().length === 0) {
        this.loadScene(createEmptyDocument(), createDefaultManifest(), this.documentPath, "");
        return true;
      }
      const parsed = parseDesignHtml(content);
      if (!parsed.ok) {
        this.showBanner("error", parsed.error);
        return false;
      }
      this.manifest = parsed.document.manifest;
      this.applyingRemote = true;
      try {
        this.store.replaceDocument(parsed.document.scene, { keepSelection: true });
      } finally {
        this.applyingRemote = false;
      }
      this.renderAll();
      this.publish();
      return true;
    } catch (err) {
      this.showBanner("error", err instanceof Error ? err.message : "Failed to reload document.");
      return false;
    }
  }

  // ----- serialization -----

  private serializeCurrent(): string {
    return serializeDesignHtml(this.manifest, this.store.getDocument(), {
      touchMetadata: true,
    });
  }

  // ----- store change handling -----

  private onStoreChange(reason: ChangeReason, _state: EditorState): void {
    if (reason === "interaction") {
      this.renderCanvas();
      this.repositionTextEditor();
      return;
    }
    if (reason === "remote") {
      // loadScene/reloadFromHost handle the full re-render + publish.
      return;
    }
    this.renderAll();
    if (reason === "document" && !this.applyingRemote && this.availability === "ready") {
      try {
        this.autosave?.notifyChange(this.serializeCurrent());
        this.clearBanner("error");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to serialize this document.";
        this.autosave?.markSerializationFailure(message);
        this.showBanner("error", message);
      }
    }
    this.publish();
  }

  private onAutosaveState(state: AutosaveState): void {
    this.statusEl.textContent = statusLabel(state);
    this.statusEl.dataset["status"] = state.status;
    this.bridge?.humanEdit?.set({ state: state.status === "conflict" ? "conflict" : state.status === "saving" ? "saving" : state.dirty ? "dirty" : "clean" });
    if (state.status === "conflict") {
      this.renderConflictBanner(state);
    } else {
      this.clearBanner("conflict");
    }
    if (state.status === "failed" && state.errorMessage) {
      this.showBanner("error", state.errorMessage);
      const banner = this.bannerHost.querySelector('[data-kind="error"]');
      if (banner) {
        banner.appendChild(this.bannerButton("Retry save", () => { try { this.autosave?.notifyChange(this.serializeCurrent()); void this.autosave?.retry(); } catch (cause) { this.autosave?.markSerializationFailure(String(cause)); } }));
        banner.appendChild(this.bannerButton("Save Copy", () => void this.saveDraftCopy()));
      }
    }
    // A newly saved deferred artifact starts with a null base. Enable the
    // presentation bridge only after autosave has authoritative save evidence;
    // this avoids state.set materializing an unbound draft merely on pan.
    if (!this.viewportStateEligible && state.status === "saved") {
      const saved = this.autosave?.getSavedSnapshot();
      if (saved && (saved.sha256 !== null || saved.revision !== null)) {
        this.viewportStateEligible = true;
        this.persistViewport();
      }
    }
    this.publish();
  }

  private publish(): void {
    const state = this.store.getState();
    const auto = this.autosave?.getState();
    publishContext(this.bridge, {
      document: this.store.getDocument(),
      activePageId: state.activePageId,
      selectionNodeIds: state.selection,
      dirty: auto?.dirty ?? false,
      lastSavedAt: auto?.lastSavedAt ?? null,
      ...(this.documentPath !== undefined ? { documentPath: this.documentPath } : {}),
    });
  }

  // ----- rendering -----

  private renderAll(): void {
    this.renderCanvas();
    this.renderPanels();
    this.renderReceipt();
    this.syncHistoryControls();
    this.updateZoomLabel();
    this.repositionTextEditor();
  }

  private renderReceipt(): void {
    const receipt = this.receipts.get();
    this.receiptHost.textContent = "";
    this.receiptHost.hidden = receipt === null || !this.receiptsEnabled;
    if (!receipt || !this.receiptsEnabled) return;
    const summary = document.createElement("p");
    summary.className = "design-receipt__summary";
    summary.textContent = receipt.summary;
    this.receiptHost.appendChild(summary);
    const detail = document.createElement("p");
    detail.className = "design-receipt__detail";
    detail.textContent = receiptObjectDetail(receipt);
    this.receiptHost.appendChild(detail);
    const actions = document.createElement("div");
    actions.className = "design-receipt__actions";
    const inspectableNodeIds = receiptInspectableNodeIds(receipt, this.store.getDocument());
    if (inspectableNodeIds.length > 0) {
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.textContent = "Inspect";
      inspect.addEventListener("click", () => this.store.setSelection(inspectableNodeIds));
      actions.appendChild(inspect);
    }
    if (receipt.revert) {
      const revert = document.createElement("button");
      revert.type = "button";
      revert.textContent = "Revert";
      revert.addEventListener("click", () => {
        const result = this.store.applyEphemeralRevert(receipt.revert!);
        if (!result.ok) {
          this.showBanner("error", result.error.message);
          return;
        }
        if (result.receipt.outcome === "applied") {
          this.receipts.clear();
          this.renderReceipt();
        }
      });
      actions.appendChild(revert);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.setAttribute("aria-label", "Dismiss Genie receipt");
    dismiss.addEventListener("click", () => {
      this.receipts.clear();
      this.renderReceipt();
    });
    actions.appendChild(dismiss);
    const turnOff = document.createElement("button");
    turnOff.type = "button";
    turnOff.textContent = "Turn off notices";
    turnOff.addEventListener("click", () => void this.setReceiptsEnabled(false));
    actions.appendChild(turnOff);
    this.receiptHost.appendChild(actions);
  }

  private renderCanvas(): void {
    const state = this.store.getState();
    this.imagePreviews.reconcile(paintOrder(state.document, state.activePageId).flatMap((node) => node.assetRef ? [node.assetRef] : []));
    // Drop a stale node-edit target if the selection moved off it.
    if (this.editNodeId && !state.selection.includes(this.editNodeId)) {
      this.editNodeId = null;
    }
    this.renderer.render(state.document, state.activePageId, this.viewport, state.selection, {
      imagePreviews: this.imagePreviews.entries,
      editNodeId: this.editNodeId,
      pen: this.penPath ? { path: this.penPath, cursor: this.penCursor } : null,
    });
    this.updateCanvasHint(state);
  }

  private updateCanvasHint(state: EditorState): void {
    const page = findPage(state.document, state.activePageId);
    const empty = !page || page.children.length === 0;
    this.canvasHintEl.hidden = !empty;
  }

  private renderPanels(): void {
    const state = this.store.getState();
    renderLayersPanel(
      this.layersHost,
      { doc: state.document, activePageId: state.activePageId, selection: state.selection },
      {
        onSelectNode: (id, additive) => this.store.select(id, additive ? "toggle" : "replace"),
        onSelectPage: (id) => {
          this.store.setActivePage(id);
          this.zoomToFit(false);
          void this.restoreViewportFromBridge();
        },
        onAddPage: () => {
          this.store.addPage();
          this.zoomToFit(false);
          void this.restoreViewportFromBridge();
        },
        onReorderTopLevel: (orderedIds) => this.store.reorderPageChild(orderedIds),
        onOrganize: (request) => { const result = this.store.organize(request); if (!result.ok) this.showBanner("error", result.error.message); },
        onReorderSiblings: (parentId, pageId, orderedIds) => { const result = this.store.transact({ kind: "reorder", parentId, pageId, orderedIds }); if (!result.ok) this.showBanner("error", result.error.message); },
      },
      {
        collapsed: this.collapsedPanelSections,
        onToggle: (sectionId, collapsed) => this.setPanelSectionCollapsed(sectionId, collapsed),
      },
    );
    renderInspector(this.inspectorHost, this.store.getSelectedNodes(), {
      onPatch: (patch) => {
        const selection = this.store.getState().selection;
        try {
          for (const id of selection) {
            const node = this.store.getDocument().nodes[id];
            if (node?.type === "text") layoutTextNode({ ...node, ...patch } as typeof node);
          }
          if (selection.length > 0 && !this.store.updateNodes(selection, patch)) this.showBanner("error", "This edit could not be applied. Check the object is unlocked and the values are valid.");
        } catch (cause) { this.showBanner("error", cause instanceof Error ? cause.message : "This text style is unavailable."); }
      },
      onOrganize: (request) => { const result = this.store.organize(request); if (!result.ok) this.showBanner("error", result.error.message); },
      onPatchEach: (patches) => this.store.updateNodePatches(patches),
      onConnectorPatch: (patch) => {
        const selected = this.store.getSelectedNodes();
        const connector = selected.length === 1 ? selected[0] : undefined;
        if (connector?.connector) this.store.updateConnector(connector.id, patch);
      },
      onBoolean: (op) => {
        const selection = this.store.getState().selection;
        const result = this.store.transact({ kind: "boolean", nodeIds: selection, op });
        if (!result.ok) this.showBanner("error", result.error.message);
        else if (result.receipt.changedNodeIds[0]) this.store.setSelection([result.receipt.changedNodeIds[0]]);
      },
      onLayout: (intent) => {
        const selection = this.store.getState().selection;
        if (intent.kind === "align") {
          this.store.alignNodes(selection, intent.axis, intent.mode);
        } else {
          this.store.distributeNodes(selection, intent.axis);
        }
      },
      onStack: (direction) => {
        this.store.reorderNodes(this.store.getState().selection, direction);
      },
    }, state.document, {
      collapsed: this.collapsedPanelSections,
      onToggle: (sectionId, collapsed) => this.setPanelSectionCollapsed(sectionId, collapsed),
    });
    const selected = this.store.getSelectedNodes();
    if (selected.length === 1 && selected[0]!.type === "image") this.renderImageControls(selected[0]!.id);
    if (selected.length === 1 && selected[0]!.type === "vector" && !selected[0]!.connector) {
      renderPathControls(this.inspectorHost, selected[0]!, this.selectedVectorPart, (edit) => this.editSelectedPath(edit));
    }
  }

  private setPanelSectionCollapsed(sectionId: string, collapsed: boolean): void {
    if (collapsed) this.collapsedPanelSections.add(sectionId);
    else this.collapsedPanelSections.delete(sectionId);
  }

  private updateZoomLabel(): void {
    this.zoomEl.textContent = `${Math.round(this.viewport.scale * 100)}%`;
    const state = this.store.getState();
    this.fitSelectionBtn.disabled = this.visualBoundsForIds(state.selection) === null;
  }

  private syncHistoryControls(): void {
    const history = historyControlState(this.store.canUndo(), this.store.canRedo());
    this.undoBtn.disabled = history.undoDisabled;
    this.redoBtn.disabled = history.redoDisabled;
  }

  private canvasSize(): { width: number; height: number } {
    const rect = this.canvasEl.getBoundingClientRect();
    return {
      width: rect.width > 0 ? rect.width : 800,
      height: rect.height > 0 ? rect.height : 600,
    };
  }

  private setViewport(viewport: Viewport, persist: boolean): void {
    if (persist) this.viewportRestoreGeneration += 1;
    this.viewport = viewport;
    this.renderCanvas();
    this.updateZoomLabel();
    if (persist) this.persistViewport();
  }

  private canvasCenter(): Point {
    const size = this.canvasSize();
    return { x: size.width / 2, y: size.height / 2 };
  }

  private zoomBy(factor: number): void {
    this.setViewport(zoomAt(this.viewport, factor, this.canvasCenter()), true);
  }

  private resetZoom(): void {
    this.setViewport(setZoom(this.viewport, 1, this.canvasCenter()), true);
  }

  private zoomToFit(persist = false): void {
    const state = this.store.getState();
    const page = findPage(state.document, state.activePageId);
    const bounds = page ? this.visualBoundsForIds(page.children) : null;
    const size = this.canvasSize();
    this.setViewport(this.fitViewport(bounds, size), persist);
  }

  private zoomToSelection(): void {
    const state = this.store.getState();
    const bounds = this.visualBoundsForIds(state.selection);
    if (!bounds) return;
    this.setViewport(
      fitBounds(
        bounds,
        this.canvasSize(),
        64,
      ),
      true,
    );
  }

  private fitViewport(
    bounds: ReturnType<typeof collectiveBounds> | null,
    size: { width: number; height: number },
  ): Viewport {
    // An empty page has no geometric bounds. Its standard recovery view is a
    // stable centered 100% canvas, not a stale transform from another page.
    if (!bounds) return { scale: 1, tx: size.width / 2 - 200, ty: size.height / 2 - 150 };
    return fitBounds(bounds, size, 64);
  }

  private visualBoundsForIds(nodeIds: readonly string[]): ReturnType<typeof collectiveBounds> | null {
    const nodes = this.store.getDocument().nodes;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let seen = false;
    for (const id of nodeIds) {
      const node = nodes[id];
      if (!node) continue;
      const bounds = visualBounds(node);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
      seen = true;
    }
    return seen ? { minX, minY, maxX, maxY } : null;
  }

  private isNarrowLayout(): boolean {
    return window.matchMedia?.("(max-width: 640px)").matches ?? false;
  }

  private setLayout(layout: CanvasLayout): void {
    this.layout = layout;
    this.syncLayoutControls();
    // The scene Store is intentionally not involved in presentation changes.
    this.renderCanvas();
  }

  private syncLayoutControls(): void {
    const narrow = this.isNarrowLayout();
    this.appEl.classList.toggle("is-layers-collapsed", !this.layout.layersVisible && !narrow);
    this.appEl.classList.toggle("is-inspector-collapsed", !this.layout.inspectorVisible && !narrow);
    this.appEl.classList.toggle("is-full-canvas", this.layout.fullCanvas);
    this.appEl.dataset["narrowDrawer"] = narrow ? this.layout.narrowDrawer ?? "" : "";
    this.layersToggleBtn.setAttribute(
      "aria-expanded",
      String(narrow ? this.layout.narrowDrawer === "layers" : this.layout.layersVisible),
    );
    this.inspectorToggleBtn.setAttribute(
      "aria-expanded",
      String(narrow ? this.layout.narrowDrawer === "inspector" : this.layout.inspectorVisible),
    );
    const fullCanvasLabel = this.layout.fullCanvas ? "Exit canvas" : "Full canvas";
    this.fullCanvasBtn.textContent = "";
    this.fullCanvasBtn.appendChild(createDesignIcon(document, "expand"));
    const fullCanvasText = document.createElement("span");
    fullCanvasText.className = "design-topbar__button-label";
    fullCanvasText.textContent = fullCanvasLabel;
    this.fullCanvasBtn.appendChild(fullCanvasText);
    this.fullCanvasBtn.setAttribute("aria-label", fullCanvasLabel);
    this.fullCanvasBtn.title = fullCanvasLabel;
    this.fullCanvasBtn.setAttribute("aria-pressed", String(this.layout.fullCanvas));
    this.layersToggleBtn.disabled = this.layout.fullCanvas;
    this.inspectorToggleBtn.disabled = this.layout.fullCanvas;
    const layersExpanded = narrow ? this.layout.narrowDrawer === "layers" : this.layout.layersVisible;
    const inspectorExpanded = narrow ? this.layout.narrowDrawer === "inspector" : this.layout.inspectorVisible;
    this.syncPanelCollapseButton(this.layersCollapseBtn, "Layers", layersExpanded);
    this.syncPanelCollapseButton(this.inspectorCollapseBtn, "Inspector", inspectorExpanded);
  }

  private syncPanelCollapseButton(button: HTMLButtonElement, label: string, expanded: boolean): void {
    const action = expanded ? `Collapse ${label}` : `Expand ${label}`;
    button.setAttribute("aria-label", action);
    button.title = action;
    button.setAttribute("aria-expanded", String(expanded));
    button.disabled = this.layout.fullCanvas;
  }

  private async restoreViewportFromBridge(apply = true): Promise<boolean> {
    const bridge = this.bridge;
    if (!bridge?.state || !this.viewportStateEligible || this.viewportStateUnavailable) return false;
    const generation = ++this.viewportRestoreGeneration;
    try {
      const raw = await bridge.state.get(VIEWPORT_STATE_KEY);
      if (generation !== this.viewportRestoreGeneration) return false;
      const state = this.store.getState();
      this.viewportState = parseViewportState(raw, state.document.pages.map((page) => page.id));
      this.viewportStateReady = true;
      if (!apply) return true;
      const saved = this.viewportState.pages[state.activePageId];
      const page = findPage(state.document, state.activePageId);
      const bounds = page ? this.visualBoundsForIds(page.children) : null;
      if (saved && bounds && !isViewportStranded(saved, bounds, this.canvasSize())) {
        this.setViewport(saved, false);
      } else {
        this.zoomToFit(false);
      }
      return true;
    } catch (error) {
      // Current-folder documents have no host state authority. Keep the local
      // presentation and stop probing rather than deriving a key from a path.
      if (isArtifactStateUnavailable(error)) this.viewportStateUnavailable = true;
      return false;
    }
  }

  private persistViewport(): void {
    if (!this.bridge?.state) return;
    const disposition = viewportStateWriteDisposition(
      this.viewportStateEligible,
      this.viewportStateReady,
      this.viewportStateUnavailable,
    );
    if (disposition === "none") return;
    if (disposition === "probe") {
      void this.restoreViewportFromBridge(false).then((ready) => {
        if (ready) this.persistViewport();
      });
      return;
    }
    const pageId = this.store.getState().activePageId;
    this.viewportState = saveViewportForPage(this.viewportState, pageId, this.viewport);
    this.viewportWriteQueue.schedule(this.viewportState);
  }

  private async writeViewportState(state: DesignViewportState): Promise<void> {
    const bridge = this.bridge;
    if (!bridge?.state || !this.viewportStateEligible || this.viewportStateUnavailable) return;
    try {
      await bridge.state.set(VIEWPORT_STATE_KEY, state);
    } catch (error) {
      // See restoreViewportFromBridge: this is an expected platform fallback
      // for current-folder documents, not a document-save failure.
      if (isArtifactStateUnavailable(error)) this.viewportStateUnavailable = true;
    }
  }

  // ----- text editing overlay -----

  private openTextEditor(nodeId: string): void {
    const node = this.store.getDocument().nodes[nodeId];
    if (!node || node.type !== "text") return;
    this.closeTextEditor(false);
    const textarea = document.createElement("textarea");
    textarea.className = "design-text-editor";
    textarea.value = node.text ?? "";
    this.canvasEl.appendChild(textarea);
    this.textEditor = { nodeId, el: textarea };
    this.repositionTextEditor();
    textarea.focus();
    textarea.select();
    textarea.addEventListener("blur", () => this.closeTextEditor(true));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeTextEditor(false);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.closeTextEditor(true);
      }
    });
  }

  private repositionTextEditor(): void {
    if (!this.textEditor) return;
    const node = this.store.getDocument().nodes[this.textEditor.nodeId];
    if (!node) {
      this.closeTextEditor(false);
      return;
    }
    const el = this.textEditor.el;
    el.style.left = `${node.x * this.viewport.scale + this.viewport.tx}px`;
    el.style.top = `${node.y * this.viewport.scale + this.viewport.ty}px`;
    const fontStretch = node.fontStretch ?? 1;
    el.style.width = `${node.width * this.viewport.scale / fontStretch}px`;
    el.style.minHeight = `${node.height * this.viewport.scale}px`;
    const textStyle = textRenderStyle(node);
    el.style.fontFamily = textStyle.fontFamily;
    el.style.fontWeight = String(textStyle.fontWeight);
    el.style.lineHeight = String(node.lineHeight ?? 1.25);
    el.style.textAlign = node.textAlign ?? "left";
    el.wrap = node.textWrap ? "soft" : "off";
    const transform = nodeTransformMatrix(node);
    const offsetX = (transform.a * node.x + transform.c * node.y + transform.e - node.x) * this.viewport.scale;
    const offsetY = (transform.b * node.x + transform.d * node.y + transform.f - node.y) * this.viewport.scale;
    el.style.transformOrigin = "0 0";
    el.style.transform = `matrix(${transform.a * fontStretch},${transform.b * fontStretch},${transform.c},${transform.d},${offsetX},${offsetY})`;
    el.style.fontSize = `${(node.fontSize ?? 14) * this.viewport.scale}px`;
  }

  private closeTextEditor(commit: boolean): void {
    const editor = this.textEditor;
    if (!editor) return;
    this.textEditor = null;
    const value = editor.el.value;
    editor.el.remove();
    if (commit) {
      const node = this.store.getDocument().nodes[editor.nodeId];
      if (node && (node.text ?? "") !== value) {
        this.store.updateNode(editor.nodeId, { text: value });
      }
    }
  }

  // ----- banners -----

  private renderConflictBanner(state: AutosaveState): void {
    this.clearBanner("conflict");
    const banner = document.createElement("div");
    banner.className = "design-banner design-banner--conflict";
    banner.dataset["kind"] = "conflict";
    banner.setAttribute("role", "alert");
    const message = document.createElement("span");
    const affected = state.conflictAffectedNodeIds.map((id) => this.store.getDocument().nodes[id]?.name ?? "Deleted object");
    const conflictDetail = affected.length > 0
      ? ` Review needed for ${affected.length === 1 ? "object" : "objects"}: ${affected.join(", ")}.`
      : state.conflictReason === "recovery_base_changed" ? " Your recovered draft is based on an earlier saved version. Save a copy or choose which version to keep."
      : state.conflictReason === "invalid_document"
        ? " The incoming document could not be safely parsed."
        : "";
    message.textContent = `This document changed elsewhere.${conflictDetail}`;
    banner.appendChild(message);
    const actions = document.createElement("div");
    actions.className = "design-banner__actions";
    actions.appendChild(
      this.bannerButton("Reload latest", () => {
        void this.autosave?.reloadLatest().then((latest) => {
          if (!latest) return;
          const parsed = parseDesignHtml(latest.content);
          if (!parsed.ok) {
            this.showBanner("error", parsed.error);
            return;
          }
          this.manifest = parsed.document.manifest;
          this.documentPath = latest.path ?? this.documentPath;
          this.applyingRemote = true;
          try {
            this.store.replaceDocument(parsed.document.scene, { keepSelection: true });
          } finally {
            this.applyingRemote = false;
          }
          this.renderAll();
          this.publish();
        });
      }),
    );
    actions.appendChild(this.bannerButton("Keep mine", () => void this.autosave?.keepMine()));
    actions.appendChild(this.bannerButton("Save Copy", () => void this.saveDraftCopy()));
    banner.appendChild(actions);
    this.bannerHost.appendChild(banner);
  }

  private bannerButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private showBanner(kind: "error" | "info", message: string): void {
    this.clearBanner(kind);
    const banner = document.createElement("div");
    banner.className = `design-banner design-banner--${kind}`;
    banner.dataset["kind"] = kind;
    banner.setAttribute("role", kind === "error" ? "alert" : "status");
    banner.textContent = message;
    this.bannerHost.appendChild(banner);
  }

  private clearBanner(kind: string): void {
    for (const child of Array.from(this.bannerHost.children)) {
      if (child instanceof HTMLElement && child.dataset["kind"] === kind) child.remove();
    }
  }

  private chooseSvgImport(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((source) => {
        const textMeasurer = createBrowserTextMeasurer();
        const imported = importSvgFragment(source, textMeasurer ? { textMeasurer } : {});
        if (!imported.ok) { this.showBanner("error", `SVG import: ${imported.error.message}`); return; }
        const root = imported.fragment.nodes.find((node) => node.id === imported.fragment.roots[0]);
        if (root) root.name = file.name.replace(/\.svg$/i, "");
        const result = this.store.organize({ kind: "insert", fragment: imported.fragment, pageId: this.store.getState().activePageId, dx: 0, dy: 0 });
        if (!result.ok) this.showBanner("error", result.error.message);
        else { this.setTool("select"); this.zoomToSelection(); this.showBanner("info", `Imported ${file.name} as editable objects.`); }
      }).catch((cause: unknown) => this.showBanner("error", cause instanceof Error ? cause.message : "Unable to read the SVG file."));
    }, { once: true });
    input.click();
  }

  private editSelectedPath(edit: PathEdit): void {
    const nodes = this.store.getSelectedNodes();
    if (nodes.length !== 1) return;
    try {
      const result = this.store.transact(pathEditTransaction(nodes[0]!, edit));
      if (!result.ok) this.showBanner("error", result.error.message);
    } catch (cause) { this.showBanner("error", cause instanceof Error ? cause.message : "Unable to edit the path."); }
  }

  private selectAll(): void {
    const state = this.store.getState();
    const visible = new Set(paintOrder(state.document, state.activePageId).filter((node) => !node.locked).map((node) => node.id));
    this.store.setSelection((findPage(state.document, state.activePageId)?.children ?? []).filter((id) => visible.has(id)));
  }

  private duplicateSelection(): void {
    const result = this.store.organize({ kind: "duplicate", nodeIds: this.store.getState().selection, dx: 20, dy: 20 });
    if (!result.ok) this.showBanner("error", result.error.message);
  }

  private groupSelection(ungroup: boolean): void {
    const result = this.store.organize({ kind: ungroup ? "ungroup" : "group", nodeIds: this.store.getState().selection });
    if (!result.ok) this.showBanner("error", result.error.message);
  }

  private flipSelection(axis: "horizontal" | "vertical"): void {
    const state = this.store.getState();
    const bounds = selectionBounds(state.document, state.selection);
    if (!bounds) return;
    const result = this.store.transact({ kind: "affine", nodeIds: state.selection, matrix: {
      a: axis === "horizontal" ? -1 : 1, b: 0, c: 0, d: axis === "vertical" ? -1 : 1,
      e: axis === "horizontal" ? bounds.x * 2 + bounds.width : 0,
      f: axis === "vertical" ? bounds.y * 2 + bounds.height : 0,
    } });
    if (!result.ok) this.showBanner("error", result.error.message);
  }

  private async copyObjects(cut: boolean): Promise<void> {
    const selection = this.store.getState().selection;
    if (!selection.length) return;
    this.clipboard = copyDesignFragment(this.store.getDocument(), selection);
    try { await navigator.clipboard.writeText(encodeDesignClipboard(this.clipboard)); }
    catch { this.showBanner("info", "Copied within this editor. Use Cmd/Ctrl+C to copy to another document."); }
    if (cut) this.store.deleteNodes(selection);
  }

  private insertClipboard(fragment: DesignFragment): void {
    const result = this.store.organize({ kind: "insert", fragment, pageId: this.store.getState().activePageId, dx: 20, dy: 20 });
    if (!result.ok) this.showBanner("error", result.error.message);
  }

  private async pasteObjects(): Promise<void> {
    let fragment = this.clipboard;
    try { fragment = decodeDesignClipboard(await navigator.clipboard.readText()) ?? fragment; } catch { /* Browser paste events remain available when clipboard permissions are denied. */ }
    if (fragment) this.insertClipboard(fragment);
    else this.showBanner("info", "Copy design objects first, then paste with Cmd/Ctrl+V.");
  }

  private readonly onClipboardCopy = (event: ClipboardEvent): void => {
    if (!acceptsEditorShortcut(event.target) || !event.clipboardData || !this.store.getState().selection.length) return;
    this.clipboard = this.store.copySelection();
    const text = encodeDesignClipboard(this.clipboard);
    event.clipboardData.setData(DESIGN_CLIPBOARD_MIME, text);
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    if (event.type === "cut") this.store.deleteNodes(this.store.getState().selection);
  };

  private readonly onClipboardPaste = (event: ClipboardEvent): void => {
    if (this.availability !== "ready" || !acceptsEditorShortcut(event.target) || !event.clipboardData) return;
    const fragment = decodeDesignClipboard(event.clipboardData.getData(DESIGN_CLIPBOARD_MIME) || event.clipboardData.getData("text/plain"));
    if (!fragment) return;
    event.preventDefault();
    this.insertClipboard(fragment);
  };

  // ----- keyboard -----

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.availability !== "ready") return;
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && !this.textEditor && this.isNarrowLayout() && this.layout.narrowDrawer !== null) {
      event.preventDefault();
      const panel = this.layout.narrowDrawer;
      this.setLayout(closeNarrowDrawer(this.layout));
      this.focusPanelTrigger(panel);
      return;
    }
    // Inspector controls and the text editor own all of their native editing
    // shortcuts, including Cmd/Ctrl-S and Cmd/Ctrl-Z.
    if (!acceptsEditorShortcut(event.target)) return;
    if (event.key === "Escape" && this.closeOpenMenuForEscape()) {
      event.preventDefault();
      return;
    }
    if (event.code === "Space" && acceptsCanvasPanningShortcut(event.target)) {
      event.preventDefault();
      this.spacePanning = true;
      this.renderer.svg.dataset["spacePan"] = "true";
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.autosave?.saveNow();
      return;
    }
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") { event.preventDefault(); this.selectAll(); return; }
    if (meta && event.key.toLowerCase() === "d") { event.preventDefault(); this.duplicateSelection(); return; }
    if (meta && event.key.toLowerCase() === "g") { event.preventDefault(); this.groupSelection(event.shiftKey); return; }
    if (meta || event.altKey) return;
    if (event.key === "Enter") {
      if (this.penPath) {
        event.preventDefault();
        this.finishPen();
      }
      return;
    }
    if (event.key === "Escape") {
      if (this.layout.fullCanvas) {
        event.preventDefault();
        this.setLayout(exitFullCanvas(this.layout));
        return;
      }
      if (this.isNarrowLayout() && this.layout.narrowDrawer !== null) {
        event.preventDefault();
        this.setLayout(closeNarrowDrawer(this.layout));
        return;
      }
      this.closeTextEditor(false);
      if (this.penPath) {
        this.cancelPen();
        return;
      }
      if (this.editNodeId) {
        this.editNodeId = null;
        this.renderCanvas();
        return;
      }
      this.store.clearSelection();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const selection = this.store.getState().selection;
      if (selection.length > 0) {
        event.preventDefault();
        this.store.deleteNodes(selection);
      }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      this.nudgeSelection(event);
      return;
    }
    const toolByKey: Record<string, Tool> = {
      v: "select", f: "frame", t: "text", r: "rectangle", e: "ellipse", l: "line", g: "polygon", p: "pen",
    };
    const tool = toolByKey[event.key.toLowerCase()];
    if (tool) this.setTool(tool, { userInitiated: true });
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== "Space") return;
    this.spacePanning = false;
    delete this.renderer.svg.dataset["spacePan"];
  };

  private nudgeSelection(event: KeyboardEvent): void {
    const selection = this.store.getState().selection;
    if (selection.length === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    this.store.nudgeNodes(selection, dx, dy);
  }

  private readonly onWindowBlur = (): void => {
    this.spacePanning = false;
    delete this.renderer.svg.dataset["spacePan"];
    void this.viewportWriteQueue.flush();
    void this.autosave?.flush();
  };

  private readonly onWindowResize = (): void => {
    this.syncLayoutControls();
    this.renderCanvas();
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!this.shapeMenu.hidden && !this.shapeButton.parentElement?.contains(target)) this.closeShapeMenu();
    if (!this.overflowMenu.hidden && !this.overflowButton.parentElement?.contains(target)) this.closeOverflowMenu();
  };

  async destroy(): Promise<void> {
    this.disposed = true;
    this.imagePreviews.dispose();
    this.menuCleanups.forEach((cleanup) => cleanup());
    this.detachInteractions?.();
    window.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("copy", this.onClipboardCopy);
    document.removeEventListener("cut", this.onClipboardCopy);
    document.removeEventListener("paste", this.onClipboardPaste);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("pointerdown", this.onDocumentPointerDown);
    this.topbarResizeObserver?.disconnect();
    this.receiptPreferenceUnsubscribe?.();
    this.documentUnsubscribe?.();
    this.lifecycleUnsubscribe?.();
    await this.viewportWriteQueue.closeAndFlush();
    await this.autosave?.flush();
    this.autosave?.destroy();
  }
}

async function mount(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  root.inert = true;
  const editor = new DesignEditor(root);
  try { await editor.start(); } finally { root.inert = false; }
  window.addEventListener("pagehide", () => void editor.destroy(), { once: true });
}

void mount();
