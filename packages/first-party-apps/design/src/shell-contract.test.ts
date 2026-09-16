import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const packageRoot = join(import.meta.dir, "..");
const main = readFileSync(join(packageRoot, "main.ts"), "utf8");
const styles = readFileSync(join(packageRoot, "styles.css"), "utf8");
const manifest = JSON.parse(readFileSync(join(packageRoot, "app.json"), "utf8")) as { description?: string };

describe("Design canvas shell contract", () => {
  test("keeps host identity out of the mini-app and removes the pinned Genie context block", () => {
    expect(main).not.toContain("design-genie");
    expect(main).not.toContain('renderGenieContext');
    expect(main).toContain("publishContext(this.bridge");
    expect(styles).not.toContain(".design-genie");
  });

  test("makes the canvas the flexible center, with explicit panel controls and one narrow drawer", () => {
    expect(styles).toContain("grid-template-rows: auto auto 1fr;");
    expect(styles).toContain(".design-topbar {\n  grid-row: 1;");
    expect(styles).toContain(".design-banners {\n  grid-row: 2;");
    expect(styles).toContain(".design-banners:empty {\n  display: none;");
    expect(styles).toContain(".design-body {\n  grid-row: 3;");
    expect(styles).toContain("grid-template-columns: clamp(9rem, 18vw, 12.5rem) minmax(0, 1fr) clamp(12rem, 23vw, 16.25rem);");
    expect(styles).toContain("@media (min-width: 641px) and (max-width: 900px)");
    expect(styles).toContain("@media (max-width: 640px)");
    expect(styles).toContain('.design-app[data-narrow-drawer="layers"] .design-panel--left');
    expect(styles).toContain('.design-app[data-narrow-drawer="inspector"] .design-panel--right');
    expect(styles).not.toContain("grid-template-rows: minmax(16rem, 1fr) minmax(0, 14rem);");
    expect(main).toContain('this.layersToggleBtn = this.layoutButton("Layers", "layers");');
    expect(main).toContain('this.inspectorToggleBtn = this.layoutButton("Inspector", "inspector");');
    expect(main).toContain('this.layersCollapseBtn = this.panelCollapseButton("layers");');
    expect(main).toContain('this.inspectorCollapseBtn = this.panelCollapseButton("inspector");');
    expect(styles).toContain("grid-template-columns: 2.2rem minmax(0, 1fr) 2.2rem;");
    expect(styles).toContain(".design-app.is-layers-collapsed .design-layers-host");
    expect(main).toContain('const fullCanvasLabel = this.layout.fullCanvas ? "Exit canvas" : "Full canvas";');
  });

  test("keeps creation in a measured responsive top bar and navigation-only controls on canvas", () => {
    expect(main).toContain('import {\n  actionLabel,\n  creationBarModeForWidth,');
    expect(main).toContain("new ResizeObserver(() => this.syncTopbarMode())");
    expect(main).toContain("creationBarModeForWidth(available, { wide, compact })");
    expect(main).toContain('this.appendOverflowGroup("Edit"');
    expect(main).toContain('this.appendOverflowGroup("Create"');
    expect(main).toContain('this.appendOverflowGroup("View"');
    expect(main).toContain('this.creationToolButton("connector", "connector")');
    expect(main).toContain("for (const action of SHAPE_ACTIONS)");
    expect(main).toContain("SHAPE_ICONS[action]");
    expect(main).not.toContain("design-toolpill");
    expect(styles).toContain('.design-app[data-topbar-mode="minimal"] .design-topbar__active-tool');
    expect(styles).toContain('.design-app[data-topbar-mode="wide"] .design-topbar__overflow');
    expect(styles).not.toContain(".design-toolpill");
  });

  test("routes connector inspector controls through the dedicated connector store mutation", () => {
    expect(main).toContain("onConnectorPatch: (patch) =>");
    expect(main).toContain("this.store.updateConnector(connector.id, patch);");
    expect(main).toContain("}, state.document, {");
  });

  test("keeps panel disclosure, object ordering, and Genie receipt recovery reachable", () => {
    expect(main).toContain("collapsed: this.collapsedPanelSections");
    expect(main).toContain("this.store.reorderNodes(this.store.getState().selection, direction)");
    expect(main).toContain('dismiss.textContent = "Dismiss"');
    expect(main).toContain('turnOff.textContent = "Turn off notices"');
    expect(main).toContain('`Genie receipts: ${this.receiptsEnabled ? "On" : "Off"}`');
    expect(styles).toContain(".design-disclosure__summary");
    expect(styles).toContain(".design-order-grid");
  });

  test("keeps menu recovery and intrinsic-width measurement independent of popup content", () => {
    expect(main).toContain('if (event.key === "Escape" && this.closeOpenMenuForEscape())');
    expect(main).toContain("this.shapeButton.focus();");
    expect(main).toContain("this.overflowButton.focus();");
    expect(main).toContain('document.addEventListener("pointerdown", this.onDocumentPointerDown);');
    expect(main).toContain("child.getBoundingClientRect().width");
    expect(main).toContain("Popups are\n    // absolutely positioned");
    expect(main).toContain('if (this.tool === "polygon") {\n      this.lastShape = "triangle";');
    expect(main).toContain('this.appEl.classList.toggle("has-unrepresented-active-tool", this.tool === "line");');
  });

  test("hidden creation popups have no rendered box until opened", () => {
    const window = new Window();
    const document = window.document;
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.appendChild(style);

    const shapes = document.createElement("div");
    shapes.className = "design-shapes__menu";
    shapes.hidden = true;
    document.body.appendChild(shapes);
    expect(window.getComputedStyle(shapes).display).toBe("none");
    shapes.hidden = false;
    expect(window.getComputedStyle(shapes).display).toBe("grid");

    const overflow = document.createElement("div");
    overflow.className = "design-topbar__overflow-menu";
    overflow.hidden = true;
    document.body.appendChild(overflow);
    expect(window.getComputedStyle(overflow).display).toBe("none");
    overflow.hidden = false;
    expect(window.getComputedStyle(overflow).display).not.toBe("none");
  });

  test("keeps zoom and viewport persistence as presentation-only state", () => {
    expect(main).toContain('const VIEWPORT_STATE_KEY = "nautilo-design.viewport.v1";');
    expect(main).toContain('this.zoomButton("Fit page", "Fit page", () => this.zoomToFit(true))');
    expect(main).toContain('this.fitSelectionBtn = this.zoomButton("Fit selection", "Fit selection", () => this.zoomToSelection());');
    expect(main).toContain("this.viewportWriteQueue.schedule(this.viewportState);");
    expect(main).toContain("isViewportStranded(saved, bounds, this.canvasSize())");
    expect(main).not.toContain("documentPath +");
  });

  test("uses an initial blank-only Frame decision and guards every document shortcut from editable targets", () => {
    const initialLoad = main.indexOf("initialToolForLoad({");
    const remoteReload = main.indexOf("private adoptRemoteEnvelope");
    expect(initialLoad).toBeGreaterThan(-1);
    expect(remoteReload).toBeGreaterThan(initialLoad);
    const keyboard = main.slice(main.indexOf("private readonly onKeyDown"));
    expect(keyboard.indexOf("if (!acceptsEditorShortcut(event.target)) return;")).toBeLessThan(keyboard.indexOf("const meta"));
  });

  test("gives Escape full-canvas and narrow-drawer recovery before canvas state", () => {
    const keyboard = main.slice(main.indexOf("private readonly onKeyDown"));
    const escape = keyboard.slice(keyboard.indexOf('if (event.key === "Escape")'));
    expect(escape.indexOf("this.layout.fullCanvas")).toBeLessThan(escape.indexOf("this.penPath"));
    expect(escape.indexOf("this.layout.narrowDrawer")).toBeLessThan(escape.indexOf("this.penPath"));
    expect(main).toContain("acceptsCanvasPanningShortcut(event.target)");
  });

  test("keeps Undo and Redo reachable while leaving artifact export to host chrome", () => {
    expect(main).toContain('this.undoBtn = this.topbarButton("Undo", "undo"');
    expect(main).toContain('this.redoBtn = this.topbarButton("Redo", "redo"');
    expect(main).toContain("this.syncHistoryControls();");
    expect(main).toContain("historyControlState(this.store.canUndo(), this.store.canRedo())");
    expect(main).not.toContain("openExport");
    expect(main).not.toContain("Export SVG");
    expect(main).not.toContain("URL.createObjectURL");
    expect(main).not.toContain("Copy SVG source");
    expect(styles).not.toContain(".design-modal");
  });

  test("uses current human primitive terminology in host-visible product copy", () => {
    expect(manifest.description).toContain("ellipses");
    expect(manifest.description).toContain("polygons");
    expect(manifest.description).toContain("Generate SVG artwork for use outside the canvas");
  });
});
