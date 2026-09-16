/**
 * Left "structure" panel (pages + layers tree) and right inspector for the
 * selected node. The tree/inspector derivations are pure and testable; the DOM
 * builders read those derivations and emit elements with `textContent` (never
 * `innerHTML` of untrusted names) so nothing user- or agent-authored can inject
 * markup under the strict srcdoc CSP.
 */

import {
  findPage,
  type DesignBooleanOp,
  type ConnectorEndpoint,
  type DesignDocument,
  type DesignNode,
  type DesignNodeKind,
  type DesignStroke,
  type DesignStrokeCap,
  type DesignStrokeJoin,
  type DesignTextAlign,
} from "../scene-graph";
import {
  DESIGN_BUNDLED_FONT_CATALOG,
  designBundledFontWeights,
  isDesignBundledFontFamily,
} from "../bundled-fonts";
import { textRenderStyle } from "../text-layout";
import { createDesignIcon, type DesignIconName } from "../icons";
import { nodePaint } from "../render-style";
import type { OrganizationTransaction } from "../organization";
import type { ConnectorPatch } from "../transactions";
import type { NodePatch } from "./store";

export const STROKE_CAPS: readonly DesignStrokeCap[] = ["butt", "round", "square"];
export const STROKE_JOINS: readonly DesignStrokeJoin[] = ["miter", "round", "bevel"];
export const BOOLEAN_OPS: readonly DesignBooleanOp[] = ["union", "subtract", "intersect", "exclude"];

/** Node kinds that carry a paintable stroke (and thus show the stroke inspector). */
export function isStrokeCapable(node: DesignNode): boolean {
  return node.type === "rectangle" || node.type === "frame" || node.type === "vector";
}

/** Only node kinds with a visible fill in the current renderer expose Fill. */
export function isFillCapable(node: DesignNode): boolean {
  return node.type === "rectangle"
    || node.type === "frame"
    || (node.type === "vector" && (node.vectorNetwork?.regions.length ?? 0) > 0)
    || isBooleanNode(node);
}

/** A boolean node is one carrying a `booleanOp` (composites its children). */
export function isBooleanNode(node: DesignNode): boolean {
  return node.booleanOp !== undefined;
}

/**
 * Shown in the inspector in place of the stroke controls for a boolean node:
 * our dependency-free SVG compositing renders boolean shapes fill-only (see
 * render.ts / design-document.ts), so stroke is not yet editable for them.
 */
export const BOOLEAN_STROKE_NOTE = "Borders aren't supported on boolean shapes yet.";

export function strokeOrDefault(node: DesignNode): DesignStroke {
  if (node.stroke) return node.stroke;
  if (node.type === "frame") return { color: "#cbd5e1", width: 1 };
  return { color: "#0f172a", width: 1 };
}

/** The inspector must expose the same fill currently seen on the canvas. */
function effectiveFillColor(node: DesignNode): string | null {
  return nodePaint(node).fill;
}

/** The inspector must expose the same stroke currently seen on the canvas. */
function hasEffectiveStroke(node: DesignNode): boolean {
  return nodePaint(node).stroke !== undefined;
}

/** Parse a dash input ("4 2" or "4, 2") into a list of finite, non-negative numbers. */
export function parseDashInput(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map((token) => Number.parseFloat(token))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

export function formatDash(dash: number[] | undefined): string {
  return dash && dash.length > 0 ? dash.join(", ") : "";
}

/** Return a stroke with its `dash` removed (exactOptional-safe). */
function strokeWithoutDash(stroke: DesignStroke): DesignStroke {
  const { dash: _dash, ...rest } = stroke;
  return rest;
}

/** Boolean grouping is offered for 2+ nodes that share a single parent. */
export function canGroupAsBoolean(nodes: readonly DesignNode[]): boolean {
  if (nodes.length < 2) return false;
  const parent = nodes[0]!.parentId;
  return nodes.every((node) => node.parentId === parent);
}

export function booleanOpLabel(op: DesignBooleanOp): string {
  return op.charAt(0).toUpperCase() + op.slice(1);
}

export type LayerTreeNode = {
  id: string;
  name: string;
  type: DesignNodeKind;
  hidden: boolean;
  locked: boolean;
  children: LayerTreeNode[];
};

export type FlatLayer = {
  id: string;
  name: string;
  type: DesignNodeKind;
  depth: number;
};

export function buildLayerTree(doc: DesignDocument, pageId: string): LayerTreeNode[] {
  const page = findPage(doc, pageId);
  if (!page) return [];
  const build = (id: string): LayerTreeNode | null => {
    const node = doc.nodes[id];
    if (!node) return null;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      hidden: node.hidden ?? false,
      locked: node.locked ?? false,
      children: node.childIds
        .map(build)
        .filter((child): child is LayerTreeNode => child !== null),
    };
  };
  return page.children
    .map(build)
    .filter((node): node is LayerTreeNode => node !== null);
}

/** Depth-annotated pre-order flattening for a flat, indented layer list. */
export function flattenLayers(tree: readonly LayerTreeNode[], depth = 0): FlatLayer[] {
  const out: FlatLayer[] = [];
  for (const node of tree) {
    out.push({ id: node.id, name: node.name, type: node.type, depth });
    out.push(...flattenLayers(node.children, depth + 1));
  }
  return out;
}

export function primaryFillColor(node: DesignNode): string | null {
  const fill = node.fills?.[0];
  if (!fill || fill.kind !== "solid") return null;
  return fill.color;
}

/**
 * Collapse a list of values to a shared value or a "mixed" marker. Used by the
 * multi-selection inspector to decide whether a field shows a single value or a
 * mixed-state placeholder. Empty input yields `{ mixed: false, value: undefined }`.
 */
export type CommonValue<T> = { mixed: boolean; value: T | undefined };

export function commonValue<T>(values: readonly T[]): CommonValue<T> {
  if (values.length === 0) return { mixed: false, value: undefined };
  const first = values[0] as T;
  for (const value of values) {
    if (!Object.is(value, first)) return { mixed: true, value: undefined };
  }
  return { mixed: false, value: first };
}

/**
 * Move `sourceId` to sit before/after `targetId` within `order`, returning a new
 * array. No-ops (returning a copy) when source/target coincide or the target is
 * absent. Pure z-order reorder logic for the layers panel drag interaction.
 */
export function reorderList(
  order: readonly string[],
  sourceId: string,
  targetId: string,
  place: "before" | "after",
): string[] {
  if (sourceId === targetId) return [...order];
  const without = order.filter((id) => id !== sourceId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex === -1) return [...order];
  const insertAt = place === "before" ? targetIndex : targetIndex + 1;
  const next = [...without];
  next.splice(insertAt, 0, sourceId);
  return next;
}

export function selectionLabel(nodes: readonly DesignNode[]): string {
  if (nodes.length === 0) return "No selection";
  if (nodes.length === 1) {
    const node = nodes[0]!;
    return `${nodeKindLabel(node.type)} · ${node.name}`;
  }
  return `${nodes.length} nodes selected`;
}

export function nodeKindLabel(type: DesignNodeKind): string {
  switch (type) {
    case "frame":
      return "Frame";
    case "text":
      return "Text";
    case "rectangle":
      return "Rectangle";
    case "image":
      return "Image";
    case "group":
      return "Group";
    case "vector":
      return "Vector";
  }
}

// ----- DOM builders (invoked only at runtime; no top-level DOM access) -----

export type PageListItem = { id: string; name: string; active: boolean };

export function buildPageList(doc: DesignDocument, activePageId: string): PageListItem[] {
  return doc.pages.map((page) => ({
    id: page.id,
    name: page.name,
    active: page.id === activePageId,
  }));
}

export type LayersPanelHandlers = {
  onSelectNode: (id: string, additive: boolean) => void;
  onSelectPage: (id: string) => void;
  onAddPage: () => void;
  /** Commit a new top-level (page-child) z-order. */
  onReorderTopLevel: (orderedIds: string[]) => void;
  /** Send page, reparent, visibility, lock, and ordinary-group intents to the canonical organizer. */
  onOrganize?: (request: OrganizationTransaction) => void;
  /** Commit exact sibling order, including nested children, through the canonical reorder transaction. */
  onReorderSiblings?: (parentId: string | null, pageId: string, orderedIds: string[]) => void;
};

export type PanelDisclosureState = {
  collapsed: ReadonlySet<string>;
  onToggle: (sectionId: string, collapsed: boolean) => void;
};

function captureLayersFocus(container: HTMLElement): string | null {
  const active = container.ownerDocument.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) return null;
  return active.dataset["layersFocus"] ?? null;
}

function restoreLayersFocus(container: HTMLElement, focus: string | null): void {
  if (!focus) return;
  const replacement = Array.from(container.querySelectorAll<HTMLElement>("[data-layers-focus]"))
    .find((element) => element.dataset["layersFocus"] === focus);
  replacement?.focus();
}

export function renderLayersPanel(
  container: HTMLElement,
  args: { doc: DesignDocument; activePageId: string; selection: readonly string[] },
  handlers: LayersPanelHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const focusedControl = captureLayersFocus(container);
  // Nested disclosure changes need an immediate DOM update for both pointer
  // and keyboard users. The owner still receives the durable preference.
  const collapsedLayers = new Set(disclosure?.collapsed ?? []);
  const nestedDisclosure: PanelDisclosureState = {
    collapsed: collapsedLayers,
    onToggle: (sectionId, collapsed) => disclosure?.onToggle(sectionId, collapsed),
  };
  container.textContent = "";
  const pagesSection = disclosureGroup("layers.pages", "Pages", disclosure, "design-panel-section");
  const pagesHeader = pagesSection.querySelector("summary");
  if (!pagesHeader) throw new Error("Pages disclosure is missing its summary.");
  const addPageBtn = document.createElement("button");
  addPageBtn.type = "button";
  addPageBtn.className = "design-panel__add";
  addPageBtn.dataset["layersFocus"] = "page:add";
  addPageBtn.setAttribute("aria-label", "Add page");
  addPageBtn.appendChild(createDesignIcon(document, "plus"));
  addPageBtn.append("Page");
  addPageBtn.title = "Add a page";
  addPageBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.onAddPage();
  });
  pagesHeader.appendChild(addPageBtn);
  container.appendChild(pagesSection);

  const pages = buildPageList(args.doc, args.activePageId);
  const pageList = document.createElement("ul");
  pageList.className = "design-panel__list design-panel__pages";
  for (const [index, page] of pages.entries()) {
    const li = document.createElement("li");
    li.className = "design-page-row";
    let openRenameEditor: (() => void) | undefined;
    const selectPage = document.createElement("button");
    selectPage.type = "button";
    selectPage.className = "design-page-item" + (page.active ? " is-active" : "");
    selectPage.dataset["pageId"] = page.id;
    selectPage.dataset["layersFocus"] = `page:${page.id}`;
    selectPage.textContent = page.name;
    selectPage.setAttribute("aria-current", page.active ? "page" : "false");
    selectPage.addEventListener("click", () => handlers.onSelectPage(page.id));
    selectPage.addEventListener("keydown", (event) => {
      if (event.key === "F2" && openRenameEditor) {
        event.preventDefault();
        openRenameEditor();
        return;
      }
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= pages.length) return;
      event.preventDefault();
      const next = reorderList(pages.map((entry) => entry.id), page.id, pages[targetIndex]!.id, event.key === "ArrowUp" ? "before" : "after");
      handlers.onOrganize?.({ kind: "page-order", pageIds: next });
    });
    li.appendChild(selectPage);

    if (handlers.onOrganize) {
      const actions = document.createElement("span");
      actions.className = "design-page-actions";
      const order = pages.map((entry) => entry.id);
      openRenameEditor = () => {
        const existing = li.querySelector<HTMLElement>(".design-page-rename");
        if (existing) {
          existing.querySelector("input")?.focus();
          return;
        }
        const editor = document.createElement("form");
        editor.className = "design-page-rename";
        const pageName = document.createElement("input");
        pageName.type = "text";
        pageName.className = "design-page-name";
        pageName.value = page.name;
        pageName.dataset["layersFocus"] = `page:${page.id}`;
        pageName.setAttribute("aria-label", `New name for ${page.name}`);
        const close = () => editor.remove();
        const commit = () => {
          const name = pageName.value.trim();
          if (name && name !== page.name) handlers.onOrganize?.({ kind: "page-edit", action: "rename", pageId: page.id, name });
          close();
        };
        editor.addEventListener("submit", (event) => {
          event.preventDefault();
          commit();
        });
        pageName.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          close();
          selectPage.focus();
        });
        const save = panelAction("Save page name", "Save", false, commit);
        save.dataset["layersFocus"] = `page:${page.id}`;
        const cancel = panelAction("Cancel page rename", "Cancel", false, () => {
            close();
            selectPage.focus();
          });
        cancel.dataset["layersFocus"] = `page:${page.id}`;
        editor.append(pageName, save, cancel);
        li.appendChild(editor);
        pageName.focus();
        pageName.select();
      };
      const rename = panelAction("Rename page", "Rename", false, () => openRenameEditor?.());
      rename.dataset["layersFocus"] = `page:${page.id}:rename`;
      const moveUp = panelAction("Move page up", "Up", index === 0, () =>
          handlers.onOrganize?.({ kind: "page-order", pageIds: reorderList(order, page.id, order[index - 1]!, "before") }),
        );
      moveUp.dataset["layersFocus"] = `page:${page.id}:up`;
      const moveDown = panelAction("Move page down", "Down", index === pages.length - 1, () =>
          handlers.onOrganize?.({ kind: "page-order", pageIds: reorderList(order, page.id, order[index + 1]!, "after") }),
        );
      moveDown.dataset["layersFocus"] = `page:${page.id}:down`;
      const remove = panelAction("Delete page", "Delete", pages.length <= 1, () =>
          handlers.onOrganize?.({ kind: "page-edit", action: "delete", pageId: page.id }),
        );
      remove.dataset["layersFocus"] = `page:${page.id}:delete`;
      actions.append(rename, moveUp, moveDown, remove);
      li.appendChild(actions);
    }
    pageList.appendChild(li);
  }
  pagesSection.appendChild(pageList);

  const layersSection = disclosureGroup("layers.layers", "Layers", disclosure, "design-panel-section");
  container.appendChild(layersSection);
  const tree = buildLayerTree(args.doc, args.activePageId);
  const selection = new Set(args.selection);
  const layerList = document.createElement("ul");
  layerList.className = "design-panel__list design-panel__layers";
  layerList.setAttribute("role", "tree");
  if (tree.length === 0) {
    const empty = document.createElement("li");
    empty.className = "design-panel__empty";
    empty.textContent = "Pick Frame, then drag on the canvas.";
    layerList.appendChild(empty);
  }

  // Drag state is scoped to this render pass; renderLayersPanel rebuilds the DOM
  // on every store change, so nothing leaks across reorders.
  let dragSource: { id: string; parentId: string | null } | null = null;
  const visibleLayerIds: string[] = [];
  const clearDropMarkers = (): void => {
    for (const el of Array.from(layerList.querySelectorAll(".is-drop-before, .is-drop-after"))) {
      el.classList.remove("is-drop-before", "is-drop-after");
    }
  };

  const commitSiblingOrder = (parentId: string | null, orderedIds: string[]): void => {
    if (handlers.onReorderSiblings) {
      handlers.onReorderSiblings(parentId, args.activePageId, orderedIds);
      return;
    }
    if (parentId === null) handlers.onReorderTopLevel(orderedIds);
  };

  const focusLayer = (id: string): void => {
    const item = Array.from(layerList.querySelectorAll<HTMLButtonElement>(".design-layer-item"))
      .find((candidate) => candidate.dataset["nodeId"] === id);
    item?.focus();
  };

  const setLayerCollapsed = (sectionId: string, collapsed: boolean): void => {
    if (collapsed) collapsedLayers.add(sectionId);
    else collapsedLayers.delete(sectionId);
    nestedDisclosure.onToggle(sectionId, collapsed);
    renderLayersPanel(container, args, handlers, nestedDisclosure);
  };

  const renderLayer = (layer: LayerTreeNode, depth: number, siblingIds: readonly string[]): void => {
    const li = document.createElement("li");
    const parentId = args.doc.nodes[layer.id]?.parentId ?? null;
    li.className = "design-layer-row";
    li.style.setProperty("--design-layer-indent", `${depth * 12}px`);
    const hasChildren = layer.children.length > 0;
    const disclosureId = `layers.node.${layer.id}`;
    const collapsed = collapsedLayers.has(disclosureId);
    visibleLayerIds.push(layer.id);
    if (hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "design-layer-disclosure";
      toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${layer.name}`);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.dataset["layersFocus"] = `disclosure:${layer.id}`;
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.addEventListener("click", () => setLayerCollapsed(disclosureId, !collapsed));
      li.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "design-layer-disclosure design-layer-disclosure--spacer";
      spacer.setAttribute("aria-hidden", "true");
      li.appendChild(spacer);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "design-layer-item" + (selection.has(layer.id) ? " is-selected" : "");
    btn.dataset["nodeId"] = layer.id;
    btn.dataset["layersFocus"] = `layer:${layer.id}`;
    btn.setAttribute("role", "treeitem");
    btn.setAttribute("aria-level", String(depth + 1));
    btn.setAttribute("aria-selected", String(selection.has(layer.id)));
    if (hasChildren) btn.setAttribute("aria-expanded", String(!collapsed));
    const kind = document.createElement("span");
    kind.className = "design-layer-item__kind";
    kind.appendChild(createDesignIcon(document, kindIcon(layer.type)));
    const name = document.createElement("span");
    name.className = "design-layer-item__name";
    name.textContent = layer.name;
    btn.appendChild(kind);
    btn.appendChild(name);
    btn.addEventListener("click", (event) => {
      handlers.onSelectNode(layer.id, event.shiftKey || event.metaKey || event.ctrlKey);
    });

    if (siblingIds.length > 1) {
      btn.draggable = true;
      btn.addEventListener("dragstart", (event) => {
        dragSource = { id: layer.id, parentId };
        event.dataTransfer?.setData("text/plain", layer.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      btn.addEventListener("dragend", () => {
        dragSource = null;
        clearDropMarkers();
      });
      btn.addEventListener("dragover", (event) => {
        if (dragSource === null || dragSource.id === layer.id || dragSource.parentId !== parentId) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const rect = btn.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        clearDropMarkers();
        btn.classList.add(before ? "is-drop-before" : "is-drop-after");
      });
      btn.addEventListener("dragleave", () => {
        btn.classList.remove("is-drop-before", "is-drop-after");
      });
      btn.addEventListener("drop", (event) => {
        if (dragSource === null || dragSource.id === layer.id || dragSource.parentId !== parentId) return;
        event.preventDefault();
        const rect = btn.getBoundingClientRect();
        const place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        const next = reorderList(siblingIds, dragSource.id, layer.id, place);
        dragSource = null;
        clearDropMarkers();
        commitSiblingOrder(parentId, next);
      });
      // Keyboard-accessible reordering mirrors dragging in every sibling scope.
      btn.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        const index = siblingIds.indexOf(layer.id);
        if (index === -1) return;
        const target = event.key === "ArrowUp" ? index - 1 : index + 1;
        if (target < 0 || target >= siblingIds.length) return;
        event.preventDefault();
        const targetId = siblingIds[target]!;
        const place = event.key === "ArrowUp" ? "before" : "after";
        commitSiblingOrder(parentId, reorderList(siblingIds, layer.id, targetId, place));
      });
    }

    btn.addEventListener("keydown", (event) => {
      // Alt+Arrow is reserved above for explicit sibling reordering.
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const index = visibleLayerIds.indexOf(layer.id);
      const focusVisible = (nextIndex: number): void => {
        const next = visibleLayerIds[nextIndex];
        if (!next) return;
        event.preventDefault();
        focusLayer(next);
      };
      switch (event.key) {
        case "ArrowDown":
          focusVisible(index + 1);
          return;
        case "ArrowUp":
          focusVisible(index - 1);
          return;
        case "Home":
          focusVisible(0);
          return;
        case "End":
          focusVisible(visibleLayerIds.length - 1);
          return;
        case "ArrowRight":
          if (!hasChildren) return;
          event.preventDefault();
          if (collapsed) setLayerCollapsed(disclosureId, false);
          else focusLayer(layer.children[0]!.id);
          return;
        case "ArrowLeft":
          if (hasChildren && !collapsed) {
            event.preventDefault();
            setLayerCollapsed(disclosureId, true);
            return;
          }
          if (parentId !== null) {
            event.preventDefault();
            focusLayer(parentId);
          }
          return;
        default:
          return;
      }
    });

    li.appendChild(btn);
    if (handlers.onOrganize) {
      const actions = document.createElement("span");
      actions.className = "design-layer-actions";
      const visibility = panelAction(layer.hidden ? `Show ${layer.name}` : `Hide ${layer.name}`, layer.hidden ? "Show" : "Hide", false, () =>
          handlers.onOrganize?.({ kind: "flags", nodeIds: [layer.id], hidden: !layer.hidden }),
        );
      visibility.dataset["layersFocus"] = `visibility:${layer.id}`;
      const lock = panelAction(layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`, layer.locked ? "Unlock" : "Lock", false, () =>
          handlers.onOrganize?.({ kind: "flags", nodeIds: [layer.id], locked: !layer.locked }),
        );
      lock.dataset["layersFocus"] = `lock:${layer.id}`;
      actions.append(visibility, lock);
      li.appendChild(actions);
    }
    layerList.appendChild(li);
    if (!collapsed) {
      for (const child of layer.children) renderLayer(child, depth + 1, layer.children.map((entry) => entry.id));
    }
  };
  for (const layer of tree) renderLayer(layer, 0, tree.map((entry) => entry.id));
  layersSection.appendChild(layerList);

  const targets = reparentTargets(args.doc, args.selection);
  if (handlers.onOrganize && args.selection.length > 0 && targets.length > 0) {
    const move = document.createElement("select");
    move.className = "design-reparent-select";
    move.dataset["layersFocus"] = "layers:reparent";
    move.setAttribute("aria-label", "Move selected layers to");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Move selection to…";
    move.appendChild(placeholder);
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = target.value;
      option.textContent = target.label;
      move.appendChild(option);
    }
    move.addEventListener("change", () => {
      const target = targets.find((entry) => entry.value === move.value);
      if (!target) return;
      handlers.onOrganize?.({ kind: "reparent", nodeIds: [...args.selection], parentId: target.parentId, pageId: target.pageId });
      move.value = "";
    });
    layersSection.appendChild(move);
  }
  restoreLayersFocus(container, focusedControl);
}

type ReparentTarget = { value: string; label: string; parentId: string | null; pageId: string };

/** Existing pages and ordinary containers that can receive the current selection. */
export function reparentTargets(doc: DesignDocument, selection: readonly string[]): ReparentTarget[] {
  const selected = new Set(selection);
  const hasSelectedAncestor = (id: string): boolean => {
    let current = doc.nodes[id];
    while (current) {
      if (selected.has(current.id)) return true;
      current = current.parentId === null ? undefined : doc.nodes[current.parentId];
    }
    return false;
  };
  const out: ReparentTarget[] = doc.pages.map((page) => ({
    value: `page:${page.id}`,
    label: `Page: ${page.name}`,
    parentId: null,
    pageId: page.id,
  }));
  for (const page of doc.pages) {
    const visit = (id: string): void => {
      const node = doc.nodes[id];
      if (!node) return;
      if (!hasSelectedAncestor(id) && (node.type === "frame" || (node.type === "group" && node.booleanOp === undefined))) {
        out.push({ value: `node:${node.id}`, label: `${nodeKindLabel(node.type)}: ${node.name}`, parentId: node.id, pageId: page.id });
      }
      for (const childId of node.childIds) visit(childId);
    };
    for (const id of page.children) visit(id);
  }
  return out;
}

function panelAction(label: string, text: string, disabled: boolean, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "design-layer-action";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

export type InspectorHandlers = {
  onPatch: (patch: NodePatch) => void;
  /**
   * Apply selection edits whose value must retain per-node style details.
   * The store owns the atomic transaction; this panel only derives each patch.
   */
  onPatchEach?: (patches: Array<{ nodeId: string; patch: NodePatch }>) => void;
  /** Connector routing/arrow intent must stay on the connector transaction path. */
  onConnectorPatch?: (patch: ConnectorPatch) => void;
  /** Group the current selection into a boolean group node. */
  onBoolean: (op: DesignBooleanOp) => void;
  /** Intent only: canonical layout geometry is calculated by the transaction kernel. */
  onLayout: (intent: LayoutIntent) => void;
  /** Move the current same-parent selection through canonical z-order. */
  onStack?: (direction: StackDirection) => void;
  /** Send ordinary group and ungroup operations to the canonical organizer. */
  onOrganize?: (request: OrganizationTransaction) => void;
};

export type StackDirection = "forward" | "backward" | "front" | "back";

function renderStackControls(
  container: HTMLElement,
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  if (!handlers.onStack) return;
  const group = fieldGroup("Order", disclosure);
  const row = document.createElement("div");
  row.className = "design-order-grid";
  const actions: Array<[StackDirection, string]> = [
    ["forward", "Bring forward"],
    ["backward", "Send backward"],
    ["front", "Bring to front"],
    ["back", "Send to back"],
  ];
  for (const [direction, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-boolean-btn";
    button.textContent = label;
    button.addEventListener("click", () => handlers.onStack?.(direction));
    row.appendChild(button);
  }
  group.appendChild(row);
  container.appendChild(group);
}

export function connectorEndpointStatus(endpoint: ConnectorEndpoint, document?: DesignDocument): string {
  if (endpoint.detachedFromTargetId !== undefined) {
    return "Detached — target was deleted";
  }
  if (endpoint.targetId === undefined) return "Free";
  const targetName = document?.nodes[endpoint.targetId]?.name;
  return targetName === undefined ? "Attached" : `Attached to ${targetName}`;
}

export type LayoutIntent =
  | { kind: "align"; axis: "horizontal" | "vertical"; mode: "start" | "center" | "end"; label: string }
  | { kind: "distribute"; axis: "horizontal" | "vertical"; label: string };

/** Only same-parent selections have a meaningful layout space before world transforms exist. */
export function layoutControlsFor(nodes: readonly DesignNode[]): LayoutIntent[] {
  if (nodes.length < 2 || !nodes.every((node) => node.parentId === nodes[0]!.parentId)) return [];
  const controls: LayoutIntent[] = [
    { kind: "align", axis: "horizontal", mode: "start", label: "Align left" },
    { kind: "align", axis: "horizontal", mode: "center", label: "Align center" },
    { kind: "align", axis: "horizontal", mode: "end", label: "Align right" },
    { kind: "align", axis: "vertical", mode: "start", label: "Align top" },
    { kind: "align", axis: "vertical", mode: "center", label: "Align middle" },
    { kind: "align", axis: "vertical", mode: "end", label: "Align bottom" },
  ];
  if (nodes.length >= 3) {
    controls.push(
      { kind: "distribute", axis: "horizontal", label: "Distribute horizontally" },
      { kind: "distribute", axis: "vertical", label: "Distribute vertically" },
    );
  }
  return controls;
}

function renderLayoutControls(
  container: HTMLElement,
  nodes: readonly DesignNode[],
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const controls = layoutControlsFor(nodes);
  if (controls.length === 0) return;
  const group = fieldGroup("Arrange", disclosure);
  const row = document.createElement("div");
  row.className = "design-boolean-row";
  for (const intent of controls) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-boolean-btn";
    button.textContent = intent.label;
    button.addEventListener("click", () => handlers.onLayout(intent));
    row.appendChild(button);
  }
  group.appendChild(row);
  container.appendChild(group);
}

function strokeLabel(node: DesignNode): "Border" | "Stroke" {
  return node.type === "vector" && (node.vectorNetwork?.regions.length ?? 0) === 0 ? "Stroke" : "Border";
}

/** Build the explicit on/off border/stroke group for a single node. */
function renderStrokeControls(
  container: HTMLElement,
  node: DesignNode,
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const cur = strokeOrDefault(node);
  const label = strokeLabel(node);
  const group = fieldGroup(label, disclosure);
  group.appendChild(
    toggleField(`${label} enabled`, hasEffectiveStroke(node), (enabled) =>
      handlers.onPatch({ stroke: enabled ? cur : null }),
    ),
  );
  group.appendChild(
    paintField(label, cur.color, hasEffectiveStroke(node), (value) =>
      handlers.onPatch({ stroke: { ...cur, color: value } }),
    ),
  );
  group.appendChild(
    numberField(`${label} width`, cur.width, (v) => handlers.onPatch({ stroke: { ...cur, width: Math.max(0.1, v) } })),
  );
  group.appendChild(
    selectField(`${label} style`, cur.dash && cur.dash.length > 0 ? "dashed" : "solid", ["solid", "dashed"], (value) =>
      handlers.onPatch({ stroke: value === "dashed" ? { ...cur, dash: [4, 2] } : strokeWithoutDash(cur) }),
    ),
  );
  group.appendChild(
    selectField(`${label} cap`, cur.cap ?? "butt", STROKE_CAPS, (value) =>
      handlers.onPatch({ stroke: { ...cur, cap: value as DesignStrokeCap } }),
    ),
  );
  group.appendChild(
    selectField(`${label} join`, cur.join ?? "miter", STROKE_JOINS, (value) =>
      handlers.onPatch({ stroke: { ...cur, join: value as DesignStrokeJoin } }),
    ),
  );
  group.appendChild(
    textField(`${label} dash pattern`, formatDash(cur.dash), (value) => {
      const dash = parseDashInput(value);
      handlers.onPatch({ stroke: dash.length > 0 ? { ...cur, dash } : strokeWithoutDash(cur) });
    }),
  );
  container.appendChild(group);
}

function renderConnectorControls(
  container: HTMLElement,
  node: DesignNode,
  document: DesignDocument | undefined,
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const connector = node.connector;
  if (!connector) return;
  const group = fieldGroup("Connector", disclosure);
  group.appendChild(connectorRouteField(connector.route, (route) => handlers.onConnectorPatch?.({ route })));
  group.appendChild(
    toggleField("Start arrow enabled", connector.startArrow ?? false, (startArrow) =>
      handlers.onConnectorPatch?.({ startArrow }),
    ),
  );
  group.appendChild(
    toggleField("End arrow enabled", connector.endArrow ?? false, (endArrow) =>
      handlers.onConnectorPatch?.({ endArrow }),
    ),
  );
  group.appendChild(statusField("Start", connectorEndpointStatus(connector.start, document)));
  group.appendChild(statusField("End", connectorEndpointStatus(connector.end, document)));
  container.appendChild(group);
}

/** Fixed-footprint note replacing stroke controls for a boolean node. */
function booleanStrokeNote(disclosure?: PanelDisclosureState): HTMLElement {
  const group = fieldGroup("Boolean", disclosure);
  const note = document.createElement("p");
  // Reuse the existing muted-hint style so the note stays tasteful without new CSS.
  note.className = "design-panel__empty";
  note.textContent = BOOLEAN_STROKE_NOTE;
  group.appendChild(note);
  return group;
}

/** A row of Union/Subtract/Intersect/Exclude buttons for multi-selection. */
function renderBooleanRow(
  container: HTMLElement,
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const group = fieldGroup("Boolean", disclosure);
  const row = document.createElement("div");
  row.className = "design-boolean-row";
  for (const op of BOOLEAN_OPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "design-boolean-btn";
    btn.textContent = booleanOpLabel(op);
    btn.title = `${booleanOpLabel(op)} the selected nodes`;
    btn.addEventListener("click", () => handlers.onBoolean(op));
    row.appendChild(btn);
  }
  group.appendChild(row);
  container.appendChild(group);
}

function renderOrganizationControls(
  container: HTMLElement,
  nodes: readonly DesignNode[],
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  if (!handlers.onOrganize) return;
  const groupable = canGroupAsBoolean(nodes);
  const ungroupable = nodes.length === 1 && nodes[0]?.type === "group" && nodes[0].booleanOp === undefined;
  if (!groupable && !ungroupable) return;
  const group = fieldGroup("Group", disclosure);
  const row = document.createElement("div");
  row.className = "design-boolean-row";
  if (groupable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-boolean-btn";
    button.textContent = "Group";
    button.addEventListener("click", () => handlers.onOrganize?.({ kind: "group", nodeIds: nodes.map((node) => node.id) }));
    row.appendChild(button);
  }
  if (ungroupable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "design-boolean-btn";
    button.textContent = "Ungroup";
    button.addEventListener("click", () => handlers.onOrganize?.({ kind: "ungroup", nodeIds: [nodes[0]!.id] }));
    row.appendChild(button);
  }
  group.appendChild(row);
  container.appendChild(group);
}

export function renderInspector(
  container: HTMLElement,
  nodes: readonly DesignNode[],
  handlers: InspectorHandlers,
  designDocument?: DesignDocument,
  disclosure?: PanelDisclosureState,
): void {
  installInspectorTabNavigation(container);
  const focused = captureFocusedField(container);
  container.textContent = "";

  if (nodes.length === 0) {
    container.appendChild(sectionTitle("Inspector"));
    const hint = document.createElement("p");
    hint.className = "design-panel__empty";
    hint.textContent = "Pick a node to edit position, size, fill, stroke, text.";
    container.appendChild(hint);
    restoreFocusedField(container, focused);
    return;
  }

  if (nodes.length > 1) {
    const label = document.createElement("div");
    label.className = "design-inspector__selection";
    label.textContent = selectionLabel(nodes);
    container.appendChild(label);
    renderMultiInspector(container, nodes, handlers, disclosure);
    restoreFocusedField(container, focused);
    return;
  }

  const node = nodes[0]!;

  const objectHeader = document.createElement("div");
  objectHeader.className = "design-inspector__object-header";
  const kind = document.createElement("span");
  kind.className = "design-inspector__object-kind";
  kind.appendChild(createDesignIcon(document, kindIcon(node.type)));
  kind.append(node.connector ? "Connector" : nodeKindLabel(node.type));
  objectHeader.appendChild(kind);
  const name = document.createElement("input");
  name.type = "text";
  name.className = "design-field__input design-inspector__object-name";
  name.value = node.name;
  name.dataset["fieldId"] = "Name";
  name.setAttribute("aria-label", "Name");
  name.addEventListener("change", () => handlers.onPatch({ name: name.value }));
  objectHeader.appendChild(name);
  container.appendChild(objectHeader);

  renderStackControls(container, handlers, disclosure);
  renderOrganizationControls(container, [node], handlers, disclosure);

  if (!node.connector) {
    const geometry = fieldGroup("Layout", disclosure);
    geometry.appendChild(numberField("X", node.x, (v) => handlers.onPatch({ x: v })));
    geometry.appendChild(numberField("Y", node.y, (v) => handlers.onPatch({ y: v })));
    geometry.appendChild(numberField("W", node.width, (v) => handlers.onPatch({ width: Math.max(1, v) })));
    geometry.appendChild(numberField("H", node.height, (v) => handlers.onPatch({ height: Math.max(1, v) })));
    geometry.appendChild(numberField("Rotation", node.rotation ?? 0, (v) => handlers.onPatch({ rotation: v })));
    container.appendChild(geometry);
  }

  const appearance = fieldGroup("Appearance", disclosure);
  const fill = effectiveFillColor(node);
  if (isFillCapable(node)) {
    appearance.appendChild(
      toggleField("Fill enabled", fill !== null, (enabled) =>
        handlers.onPatch({ fills: enabled ? [{ kind: "solid", color: fill ?? "#3b82f6" }] : [] }),
      ),
    );
    appearance.appendChild(
      paintField("Fill", fill ?? "#3b82f6", fill !== null, (value) =>
        handlers.onPatch({ fills: [{ kind: "solid", color: value }] }),
      ),
    );
  }
  if (node.radius !== undefined || node.type === "rectangle" || node.type === "frame") {
    appearance.appendChild(
      numberField("Radius", node.radius ?? 0, (v) => handlers.onPatch({ radius: Math.max(0, v) })),
    );
  }
  appearance.appendChild(
    numberField("Opacity", node.opacity ?? 1, (v) =>
      handlers.onPatch({ opacity: Math.min(1, Math.max(0, v)) }),
    ),
  );
  container.appendChild(appearance);

  if (isBooleanNode(node)) {
    // Boolean shapes are composited fill-only; surface a fixed-footprint note
    // instead of stroke controls so we never render a wrong stroke.
    container.appendChild(booleanStrokeNote(disclosure));
  } else if (isStrokeCapable(node)) {
    renderStrokeControls(container, node, handlers, disclosure);
  }

  if (node.connector) renderConnectorControls(container, node, designDocument, handlers, disclosure);

  if (node.type === "text") {
    const text = fieldGroup("Text", disclosure);
    text.appendChild(
      textAreaField("Content", node.text ?? "", (value) => handlers.onPatch({ text: value })),
    );
    text.appendChild(
      numberField("Font size", node.fontSize ?? 14, (v) =>
        handlers.onPatch({ fontSize: Math.max(1, v) }),
      ),
    );
    const fontFamily = node.fontFamily ?? "system-ui, sans-serif";
    text.appendChild(fontFamilyField(fontFamily, (patch) => handlers.onPatch(patch)));
    text.appendChild(fontWeightField(node, (fontWeight) => handlers.onPatch({ fontWeight })));
    text.appendChild(
      selectField(
        "Align",
        node.textAlign ?? "left",
        ["left", "center", "right"],
        (value) => handlers.onPatch({ textAlign: value as DesignTextAlign }),
      ),
    );
    text.appendChild(
      positiveNumberField("Line height", node.lineHeight ?? 1.25, (lineHeight) =>
        handlers.onPatch({ lineHeight }),
      ),
    );
    text.appendChild(
      toggleField("Wrap text", node.textWrap ?? false, (textWrap) => handlers.onPatch({ textWrap })),
    );
    text.appendChild(paintField("Text color", node.color ?? "#0f172a", true, (value) => handlers.onPatch({ color: value })));
    container.appendChild(text);
  }
  restoreFocusedField(container, focused);
}

function renderMultiInspector(
  container: HTMLElement,
  nodes: readonly DesignNode[],
  handlers: InspectorHandlers,
  disclosure?: PanelDisclosureState,
): void {
  const style = fieldGroup("Appearance", disclosure);
  renderStackControls(container, handlers, disclosure);
  if (nodes.every(isFillCapable)) {
    const fill = commonValue(nodes.map((node) => effectiveFillColor(node)));
    const fillEnabled = commonValue(nodes.map((node) => effectiveFillColor(node) !== null));
    style.appendChild(
      toggleField(fillEnabled.mixed ? "Fill enabled (mixed)" : "Fill enabled", fillEnabled.value ?? false, (enabled) =>
        handlers.onPatch({ fills: enabled ? [{ kind: "solid", color: fill.value ?? "#3b82f6" }] : [] }),
      ),
    );
    style.appendChild(
      mixedPaintField("Fill", fill, fillEnabled.value ?? false, (value) =>
        handlers.onPatch({ fills: [{ kind: "solid", color: value }] }),
      ),
    );
  }
  const opacity = commonValue(nodes.map((node) => node.opacity ?? 1));
  style.appendChild(
    mixedNumberField("Opacity", opacity, (v) =>
      handlers.onPatch({ opacity: Math.min(1, Math.max(0, v)) }),
    ),
  );
  const radiusCapable = nodes.every((node) => node.type === "rectangle" || node.type === "frame");
  if (radiusCapable) {
    const radius = commonValue(nodes.map((node) => node.radius ?? 0));
    style.appendChild(
      mixedNumberField("Radius", radius, (v) => handlers.onPatch({ radius: Math.max(0, v) })),
    );
  }
  container.appendChild(style);

  if (nodes.every(isStrokeCapable)) {
    const strokeLabelForSelection = nodes.every((node) => strokeLabel(node) === "Border") ? "Border" : "Stroke";
    const stroke = fieldGroup(strokeLabelForSelection, disclosure);
    const strokeEnabled = commonValue(nodes.map(hasEffectiveStroke));
    stroke.appendChild(
      toggleField(
        strokeEnabled.mixed ? `${strokeLabelForSelection} enabled (mixed)` : `${strokeLabelForSelection} enabled`,
        strokeEnabled.value ?? false,
        (enabled) => patchEachStroke(nodes, handlers, (node) => ({ stroke: enabled ? strokeOrDefault(node) : null })),
      ),
    );
    const colorCommon = commonValue(nodes.map((n) => strokeOrDefault(n).color));
    stroke.appendChild(
      mixedPaintField(strokeLabelForSelection, colorCommon, strokeEnabled.value ?? false, (value) =>
        patchEachStroke(nodes, handlers, (node) => ({ stroke: { ...strokeOrDefault(node), color: value } })),
      ),
    );
    stroke.appendChild(
      mixedNumberField(`${strokeLabelForSelection} width`, commonValue(nodes.map((n) => strokeOrDefault(n).width)), (v) =>
        patchEachStroke(nodes, handlers, (node) => ({ stroke: { ...strokeOrDefault(node), width: Math.max(0.1, v) } })),
      ),
    );
    stroke.appendChild(
      selectField(`${strokeLabelForSelection} style`, commonValue(nodes.map((n) => (n.stroke?.dash?.length ?? 0) > 0 ? "dashed" : "solid")).value ?? "solid", ["solid", "dashed"], (value) =>
        patchEachStroke(nodes, handlers, (node) => {
          const current = strokeOrDefault(node);
          return { stroke: value === "dashed" ? { ...current, dash: [4, 2] } : strokeWithoutDash(current) };
        }),
      ),
    );
    stroke.appendChild(
      selectField(`${strokeLabelForSelection} cap`, commonValue(nodes.map((n) => strokeOrDefault(n).cap ?? "butt")).value ?? "butt", STROKE_CAPS, (value) =>
        patchEachStroke(nodes, handlers, (node) => ({ stroke: { ...strokeOrDefault(node), cap: value as DesignStrokeCap } })),
      ),
    );
    stroke.appendChild(
      selectField(`${strokeLabelForSelection} join`, commonValue(nodes.map((n) => strokeOrDefault(n).join ?? "miter")).value ?? "miter", STROKE_JOINS, (value) =>
        patchEachStroke(nodes, handlers, (node) => ({ stroke: { ...strokeOrDefault(node), join: value as DesignStrokeJoin } })),
      ),
    );
    container.appendChild(stroke);
  }

  renderLayoutControls(container, nodes, handlers, disclosure);
  renderOrganizationControls(container, nodes, handlers, disclosure);

  if (canGroupAsBoolean(nodes)) {
    renderBooleanRow(container, handlers, disclosure);
  }

  const note = document.createElement("p");
  note.className = "design-panel__empty";
  note.textContent = "Edits apply to all selected nodes.";
  container.appendChild(note);
}

/**
 * A multi-selection may have deliberately different stroke details. Apply a
 * derived patch for each object through the store's one atomic transaction
 * instead of turning a mixed selection into a synthetic shared stroke.
 */
function patchEachStroke(
  nodes: readonly DesignNode[],
  handlers: InspectorHandlers,
  makePatch: (node: DesignNode) => NodePatch,
): void {
  handlers.onPatchEach?.(nodes.map((node) => ({ nodeId: node.id, patch: makePatch(node) })));
}

type FocusedField = {
  id: string;
  selectionStart: number | null;
  selectionEnd: number | null;
} | null;

const INSPECTOR_FOCUSABLE = "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex='-1'])";

function inspectorFocusableControls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(INSPECTOR_FOCUSABLE)).filter((control) => {
    if (control.hidden || control.closest("[hidden]")) return false;
    for (let ancestor = control.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DETAILS" && !((ancestor as HTMLDetailsElement).open)) return false;
    }
    return true;
  });
}

/**
 * A native Tab first blurs the old control, which commits a changed field and
 * synchronously rebuilds this panel. Capture the intended destination before
 * that blur, then recover its semantic field identity from the rebuilt DOM.
 * Boundary Tabs remain native so focus can leave the inspector normally.
 */
function installInspectorTabNavigation(container: HTMLElement): void {
  container.onkeydown = (event) => {
    if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const current = event.target as HTMLElement | null;
    if (!current || typeof current.focus !== "function" || !container.contains(current)) return;
    const controls = inspectorFocusableControls(container);
    const currentIndex = controls.indexOf(current);
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
    const intended = controls[nextIndex];
    if (!intended) return;
    const fieldId = intended.dataset["fieldId"];
    event.preventDefault();
    // Do not synthesize change: the browser owns the commit that follows blur.
    current.blur();
    const rebuilt = inspectorFocusableControls(container);
    const next = fieldId === undefined
      ? rebuilt[nextIndex]
      : rebuilt.find((control) => control.dataset["fieldId"] === fieldId);
    next?.focus();
  };
}

/** Capture a focused inspector control before a store-driven DOM rebuild. */
function captureFocusedField(container: HTMLElement): FocusedField {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!active || !container.contains(active)) return null;
  const id = active.dataset["fieldId"];
  if (!id) return null;
  return { id, selectionStart: active.selectionStart, selectionEnd: active.selectionEnd };
}

/** Restore the same field and cursor range when that control still exists. */
function restoreFocusedField(container: HTMLElement, focused: FocusedField): void {
  if (!focused) return;
  const next = Array.from(container.querySelectorAll<HTMLElement>("[data-field-id]")).find(
    (element) => element.dataset["fieldId"] === focused.id,
  ) as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (!next) return;
  next.focus();
  if (typeof next.setSelectionRange !== "function" || focused.selectionStart === null || focused.selectionEnd === null) return;
  const length = next.value.length;
  next.setSelectionRange(Math.min(focused.selectionStart, length), Math.min(focused.selectionEnd, length));
}

function toggleField(label: string, checked: boolean, onCommit: (checked: boolean) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "design-field__toggle";
  input.checked = checked;
  input.addEventListener("change", () => onCommit(input.checked));
  return labeledRow(label, input);
}

function paintField(
  label: string,
  value: string,
  enabled: boolean,
  onCommit: (value: string) => void,
): HTMLElement {
  const control = document.createElement("div");
  control.className = "design-paint-control";
  const color = document.createElement("input");
  color.type = "color";
  color.className = "design-field__input design-field__color";
  color.value = normalizeColor(value);
  color.disabled = !enabled;
  color.dataset["fieldId"] = `${label}.color`;
  color.setAttribute("aria-label", `${label} color`);
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "design-field__input design-field__hex";
  hex.value = color.value;
  hex.disabled = !enabled;
  hex.dataset["fieldId"] = `${label}.hex`;
  hex.setAttribute("aria-label", `${label} hex value`);
  hex.setAttribute("spellcheck", "false");
  const commitHex = (): void => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex.value)) return;
    const normalized = normalizeColor(hex.value);
    color.value = normalized;
    hex.value = normalized;
    onCommit(normalized);
  };
  color.addEventListener("change", () => {
    hex.value = color.value;
    onCommit(color.value);
  });
  hex.addEventListener("change", commitHex);
  control.append(color, hex);
  return labeledRow(label, control);
}

function mixedPaintField(
  label: string,
  common: CommonValue<string | null>,
  enabled: boolean,
  onCommit: (value: string) => void,
): HTMLElement {
  const row = paintField(label, common.value ?? "#3b82f6", enabled, onCommit);
  if (common.mixed) {
    const hex = row.querySelector<HTMLInputElement>(".design-field__hex");
    if (hex) {
      hex.value = "Mixed";
      hex.placeholder = "Mixed";
    }
  }
  return row;
}

function mixedNumberField(
  label: string,
  common: CommonValue<number>,
  onCommit: (value: number) => void,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "design-field__input";
  if (common.mixed || common.value === undefined) {
    input.value = "";
    input.placeholder = "Mixed";
  } else {
    input.value = String(roundForDisplay(common.value));
  }
  input.addEventListener("change", () => {
    const parsed = Number.parseFloat(input.value);
    if (Number.isFinite(parsed)) onCommit(parsed);
  });
  return labeledRow(label, input);
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement("h2");
  el.className = "design-panel__title";
  el.textContent = text;
  return el;
}

function disclosureGroup(
  sectionId: string,
  title: string,
  disclosure: PanelDisclosureState | undefined,
  className: string,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = className;
  details.dataset["sectionId"] = sectionId;
  details.open = !(disclosure?.collapsed.has(sectionId) ?? false);

  const summary = document.createElement("summary");
  summary.className = "design-disclosure__summary";
  const chevron = createDesignIcon(document, "chevron");
  chevron.classList.add("design-disclosure__chevron");
  const label = document.createElement("span");
  label.className = "design-disclosure__label";
  label.textContent = title;
  summary.appendChild(chevron);
  summary.appendChild(label);
  details.appendChild(summary);
  details.addEventListener("toggle", () => disclosure?.onToggle(sectionId, !details.open));
  return details;
}

function kindIcon(type: DesignNodeKind): DesignIconName {
  switch (type) {
    case "frame":
      return "frame";
    case "text":
      return "text";
    case "rectangle":
      return "rectangle";
    case "image":
      return "image";
    case "group":
      return "group";
    case "vector":
      return "vector";
  }
}

function fieldGroup(title: string, disclosure?: PanelDisclosureState): HTMLElement {
  const sectionId = `inspector.${title.toLowerCase()}`;
  return disclosureGroup(sectionId, title, disclosure, "design-field-group");
}

function labeledRow(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "design-field";
  const span = document.createElement("span");
  span.className = "design-field__label";
  span.textContent = labelText;
  row.appendChild(span);
  row.appendChild(control);
  if (!control.dataset["fieldId"]) control.dataset["fieldId"] = labelText;
  return row;
}

function textField(label: string, value: string, onCommit: (value: string) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "design-field__input";
  input.value = value;
  input.addEventListener("change", () => onCommit(input.value));
  return labeledRow(label, input);
}

/** Pick a bundled text face, retaining an imported family as SVG-only evidence. */
function fontFamilyField(
  currentFamily: string,
  onCommit: (patch: Pick<NodePatch, "fontFamily" | "fontWeight">) => void,
): HTMLElement {
  const select = document.createElement("select");
  select.className = "design-field__input";
  if (!isDesignBundledFontFamily(currentFamily)) {
    const imported = document.createElement("option");
    imported.value = currentFamily;
    imported.textContent = `SVG-only: ${currentFamily}`;
    imported.selected = true;
    select.appendChild(imported);
  }
  for (const entry of DESIGN_BUNDLED_FONT_CATALOG) {
    const option = document.createElement("option");
    option.value = entry.family;
    option.textContent = entry.label;
    option.selected = entry.family === currentFamily;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    const family = select.value;
    if (!isDesignBundledFontFamily(family)) return;
    // One semantic text patch keeps a family and its exact available face in
    // sync; a change never leaves a bundled family with a synthetic weight.
    onCommit({ fontFamily: family, fontWeight: designBundledFontWeights(family)[0]! });
  });
  return labeledRow("Font family", select);
}

function fontWeightField(
  node: DesignNode,
  onCommit: (weight: number) => void,
): HTMLElement {
  const select = document.createElement("select");
  select.className = "design-field__input";
  const family = node.fontFamily ?? "system-ui, sans-serif";
  const weight = node.fontWeight;
  if (!isDesignBundledFontFamily(family)) {
    const imported = document.createElement("option");
    imported.value = String(weight ?? "normal");
    imported.textContent = `SVG-only: ${imported.value}`;
    imported.selected = true;
    select.appendChild(imported);
    select.disabled = true;
    return labeledRow("Font weight", select);
  }
  let selected: number | null = null;
  try {
    // Match the exact face the canvas and exporter resolve. In particular,
    // legacy unwrapped Sans 600 uses the 700 face rather than appearing 400.
    const resolved = textRenderStyle(node);
    if (resolved.bundled) selected = resolved.fontWeight as number;
  } catch {
    // Keep malformed legacy weights visible so the user can deliberately pick
    // a valid face instead of silently changing the document on inspection.
  }
  if (selected === null) {
    const unsupported = document.createElement("option");
    unsupported.value = `unsupported:${String(weight ?? "normal")}`;
    unsupported.textContent = `Unsupported: ${String(weight ?? "normal")}`;
    unsupported.selected = true;
    unsupported.disabled = true;
    select.appendChild(unsupported);
  }
  for (const supportedWeight of designBundledFontWeights(family)) {
    const option = document.createElement("option");
    option.value = String(supportedWeight);
    option.textContent = String(supportedWeight);
    option.selected = supportedWeight === selected;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onCommit(Number(select.value)));
  return labeledRow("Font weight", select);
}

function textAreaField(label: string, value: string, onCommit: (value: string) => void): HTMLElement {
  const input = document.createElement("textarea");
  input.className = "design-field__input design-field__textarea";
  input.rows = 3;
  input.value = value;
  input.addEventListener("change", () => onCommit(input.value));
  return labeledRow(label, input);
}

function numberField(label: string, value: number, onCommit: (value: number) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "design-field__input";
  input.value = String(roundForDisplay(value));
  input.addEventListener("change", () => {
    const parsed = Number.parseFloat(input.value);
    if (Number.isFinite(parsed)) onCommit(parsed);
  });
  return labeledRow(label, input);
}

function positiveNumberField(label: string, value: number, onCommit: (value: number) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(Number.MIN_VALUE);
  input.step = "any";
  input.className = "design-field__input";
  input.value = String(roundForDisplay(value));
  input.addEventListener("change", () => {
    const parsed = Number.parseFloat(input.value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      input.setCustomValidity("Line height must be positive.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    onCommit(parsed);
  });
  return labeledRow(label, input);
}

function connectorRouteField(
  value: "straight" | "elbow",
  onCommit: (value: "straight" | "elbow") => void,
): HTMLElement {
  const select = document.createElement("select");
  select.className = "design-field__input";
  for (const option of [
    { value: "straight", label: "Straight" },
    { value: "elbow", label: "Elbow" },
  ] as const) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    el.selected = option.value === value;
    select.appendChild(el);
  }
  select.addEventListener("change", () => onCommit(select.value as "straight" | "elbow"));
  return labeledRow("Routing", select);
}

function statusField(label: string, value: string): HTMLElement {
  const output = document.createElement("output");
  output.className = "design-connector-status";
  output.textContent = value;
  output.setAttribute("aria-label", `${label} endpoint: ${value}`);
  return labeledRow(label, output);
}

function selectField(
  label: string,
  value: string,
  options: readonly string[],
  onCommit: (value: string) => void,
): HTMLElement {
  const select = document.createElement("select");
  select.className = "design-field__input";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option;
    opt.textContent = option;
    if (option === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onCommit(select.value));
  return labeledRow(label, select);
}

function roundForDisplay(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `<input type=color>` requires a 6-digit hex; expand the common short form. */
export function normalizeColor(value: string): string {
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#3b82f6";
}
