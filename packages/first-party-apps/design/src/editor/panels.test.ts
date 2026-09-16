import { describe, expect, test } from "bun:test";
import { Window, type HTMLInputElement, type HTMLTextAreaElement, type HTMLSelectElement } from "happy-dom";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "../scene-graph";
import {
  DESIGN_BUNDLED_FONT_FAMILY,
  DESIGN_BUNDLED_SERIF_FONT_FAMILY,
} from "../bundled-fonts";
import {
  BOOLEAN_STROKE_NOTE,
  booleanOpLabel,
  buildLayerTree,
  buildPageList,
  canGroupAsBoolean,
  connectorEndpointStatus,
  commonValue,
  flattenLayers,
  formatDash,
  isFillCapable,
  isBooleanNode,
  isStrokeCapable,
  layoutControlsFor,
  nodeKindLabel,
  normalizeColor,
  parseDashInput,
  primaryFillColor,
  renderInspector,
  renderLayersPanel,
  reorderList,
  reparentTargets,
  selectionLabel,
  strokeOrDefault,
} from "./panels";

function nestedDoc(): DesignDocument {
  let doc = createEmptyDocument();
  const frame = createNode({ id: "node-1", type: "frame", parentId: null, name: "Frame A" });
  const child = createNode({ id: "node-2", type: "rectangle", parentId: "node-1", name: "Rect 1" });
  const text = createNode({ id: "node-3", type: "text", parentId: null, name: "Title" });
  doc = {
    ...doc,
    nodes: { ...doc.nodes, "node-1": { ...frame, childIds: ["node-2"] }, "node-2": child, "node-3": text },
  };
  doc = appendChild(doc, null, "node-1", "page-1");
  doc = appendChild(doc, null, "node-3", "page-1");
  return doc;
}

describe("buildLayerTree", () => {
  test("nests children under their parent in page order", () => {
    const tree = buildLayerTree(nestedDoc(), "page-1");
    expect(tree.map((n) => n.id)).toEqual(["node-1", "node-3"]);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(["node-2"]);
    expect(tree[1]?.children).toEqual([]);
  });

  test("returns empty for an unknown page", () => {
    expect(buildLayerTree(nestedDoc(), "missing")).toEqual([]);
  });
});

describe("flattenLayers", () => {
  test("produces a depth-annotated pre-order list", () => {
    const flat = flattenLayers(buildLayerTree(nestedDoc(), "page-1"));
    expect(flat).toEqual([
      { id: "node-1", name: "Frame A", type: "frame", depth: 0 },
      { id: "node-2", name: "Rect 1", type: "rectangle", depth: 1 },
      { id: "node-3", name: "Title", type: "text", depth: 0 },
    ]);
  });
});

describe("buildPageList", () => {
  test("marks the active page", () => {
    const pages = buildPageList(nestedDoc(), "page-1");
    expect(pages).toEqual([{ id: "page-1", name: "Page 1", active: true }]);
  });
});

describe("layers panel chrome", () => {
  test("uses bundled decorative SVGs while preserving readable button text", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc: nestedDoc(), activePageId: "page-1", selection: [] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
      });
      const addPage = window.document.querySelector(".design-panel__add") as unknown as HTMLElement | null;
      expect(addPage?.getAttribute("aria-label")).toBe("Add page");
      expect(addPage?.textContent).toBe("Page");
      expect(addPage?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(window.document.querySelectorAll(".design-layer-item__kind svg").length).toBe(3);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("restores collapsed Pages and Layers groups and reports disclosure changes", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const changes: Array<[string, boolean]> = [];
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc: nestedDoc(), activePageId: "page-1", selection: [] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
      }, {
        collapsed: new Set(["layers.pages"]),
        onToggle: (id, collapsed) => changes.push([id, collapsed]),
      });
      const groups = [...window.document.querySelectorAll("details")];
      expect(groups.map((group) => group.open)).toEqual([false, true]);
      groups[0]!.open = true;
      groups[0]!.dispatchEvent(new window.Event("toggle"));
      expect(changes).toContainEqual(["layers.pages", false]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("keeps nested disclosures, flags, page edits, and reparenting on canonical handlers", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const requests: unknown[] = [];
      const disclosureChanges: Array<[string, boolean]> = [];
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc: nestedDoc(), activePageId: "page-1", selection: ["node-3"] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
        onOrganize: (request) => requests.push(request),
      }, { collapsed: new Set(), onToggle: (id, collapsed) => disclosureChanges.push([id, collapsed]) });

      (window.document.querySelector('[aria-label="Collapse Frame A"]') as unknown as HTMLElement).click();
      (window.document.querySelector('[aria-label="Hide Frame A"]') as unknown as HTMLElement).click();
      (window.document.querySelector('[aria-label="Lock Frame A"]') as unknown as HTMLElement).click();
      (window.document.querySelector('[aria-label="Rename page"]') as unknown as HTMLElement).click();
      const pageName = window.document.querySelector('[aria-label="New name for Page 1"]') as HTMLInputElement;
      pageName.value = "Canvas";
      (window.document.querySelector('[aria-label="Save page name"]') as unknown as HTMLElement).click();
      const move = window.document.querySelector('[aria-label="Move selected layers to"]') as HTMLSelectElement;
      move.value = "node:node-1";
      move.dispatchEvent(new window.Event("change"));

      expect(disclosureChanges).toContainEqual(["layers.node.node-1", true]);
      expect(requests).toContainEqual({ kind: "flags", nodeIds: ["node-1"], hidden: true });
      expect(requests).toContainEqual({ kind: "flags", nodeIds: ["node-1"], locked: true });
      expect(requests).toContainEqual({ kind: "page-edit", action: "rename", pageId: "page-1", name: "Canvas" });
      expect(requests).toContainEqual({ kind: "reparent", nodeIds: ["node-3"], parentId: "node-1", pageId: "page-1" });
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("reorders nested siblings through an Alt+Arrow keyboard command", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const child = createNode({ id: "node-4", type: "rectangle", parentId: "node-1", name: "Rect 2" });
      const doc = nestedDoc();
      const nested = {
        ...doc,
        nodes: {
          ...doc.nodes,
          "node-1": { ...doc.nodes["node-1"]!, childIds: ["node-2", "node-4"] },
          "node-4": child,
        },
      };
      const reordered: Array<{ parentId: string | null; pageId: string; orderedIds: string[] }> = [];
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc: nested, activePageId: "page-1", selection: [] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
        onReorderSiblings: (parentId, pageId, orderedIds) => reordered.push({ parentId, pageId, orderedIds }),
      });
      const secondChild = window.document.querySelector('[data-node-id="node-4"]') as unknown as HTMLElement;
      secondChild.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }) as unknown as Event);
      expect(reordered).toEqual([{ parentId: "node-1", pageId: "page-1", orderedIds: ["node-4", "node-2"] }]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("retains page and layer focus while supporting visible tree navigation", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const collapsed = new Set<string>();
      const args = { doc: nestedDoc(), activePageId: "page-1", selection: ["node-2"] };
      const handlers = {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
      };
      const disclosure = {
        collapsed,
        onToggle: (id: string, next: boolean) => {
          if (next) collapsed.add(id);
          else collapsed.delete(id);
        },
      };
      const render = () => renderLayersPanel(window.document.body as unknown as HTMLElement, args, handlers, disclosure);
      render();

      const layer = (id: string) => window.document.querySelector(`[data-node-id="${id}"]`) as unknown as HTMLElement;
      const activeElement = () => window.document.activeElement as unknown as HTMLElement;
      layer("node-1").focus();
      layer("node-1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
      expect(activeElement()).toBe(layer("node-2"));
      layer("node-2").dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }) as unknown as Event);
      expect(activeElement()).toBe(layer("node-3"));
      layer("node-3").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }) as unknown as Event);
      expect(activeElement()).toBe(layer("node-1"));

      layer("node-1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event);
      expect(collapsed.has("layers.node.node-1")).toBeTrue();
      expect(window.document.querySelector('[data-node-id="node-2"]')).toBeNull();
      expect(activeElement()).toBe(layer("node-1"));
      layer("node-1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
      expect(activeElement()).toBe(layer("node-1"));
      layer("node-1").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
      expect(activeElement()).toBe(layer("node-2"));

      const page = window.document.querySelector('[data-page-id="page-1"]') as unknown as HTMLElement;
      page.focus();
      render();
      expect(activeElement()).toBe(window.document.querySelector('[data-page-id="page-1"]') as unknown as HTMLElement);
      expect(layer("node-2").getAttribute("aria-selected")).toBe("true");
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("offers direct page order and deletion actions without truncating the page list", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const doc = { ...nestedDoc(), pages: [...nestedDoc().pages, { id: "page-2", name: "Page 2", children: [] }] };
      const requests: unknown[] = [];
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc, activePageId: "page-1", selection: [] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {},
        onOrganize: (request) => requests.push(request),
      });
      const down = window.document.querySelector('[aria-label="Move page down"]') as unknown as HTMLElement;
      down.click();
      const deletePage = [...window.document.querySelectorAll('[aria-label="Delete page"]')][1] as unknown as HTMLElement;
      deletePage.click();
      expect(requests).toEqual([
        { kind: "page-order", pageIds: ["page-2", "page-1"] },
        { kind: "page-edit", action: "delete", pageId: "page-2" },
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("opens page rename deliberately and supports F2 from the page selection", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      renderLayersPanel(window.document.body as unknown as HTMLElement, { doc: nestedDoc(), activePageId: "page-1", selection: [] }, {
        onSelectNode: () => {}, onSelectPage: () => {}, onAddPage: () => {}, onReorderTopLevel: () => {}, onOrganize: () => {},
      });
      expect(window.document.querySelector('[aria-label="New name for Page 1"]')).toBeNull();
      const page = window.document.querySelector('.design-page-item') as unknown as HTMLButtonElement;
      page.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F2", bubbles: true }) as unknown as Event);
      expect(window.document.querySelector('[aria-label="New name for Page 1"]')).toBeTruthy();
      expect(window.document.querySelector('[aria-label="Save page name"]')).toBeTruthy();
      expect(window.document.querySelector('[aria-label="Cancel page rename"]')).toBeTruthy();
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });
});

describe("reparentTargets", () => {
  test("offers pages and ordinary containers while excluding a selected container and its descendants", () => {
    const targets = reparentTargets(nestedDoc(), ["node-1"]);
    expect(targets).toContainEqual({ value: "page:page-1", label: "Page: Page 1", parentId: null, pageId: "page-1" });
    expect(targets.some((target) => target.value === "node:node-1")).toBeFalse();
    expect(targets.some((target) => target.value === "node:node-2")).toBeFalse();
  });
});

describe("Inspector object order", () => {
  test("offers all four conventional stack commands", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const directions: string[] = [];
      const rectangle = createNode({ id: "a", type: "rectangle", parentId: null });
      renderInspector(window.document.body as unknown as HTMLElement, [rectangle], {
        onPatch: () => {}, onLayout: () => {}, onBoolean: () => {},
        onStack: (direction) => directions.push(direction),
      });
      for (const label of ["Bring forward", "Send backward", "Bring to front", "Send to back"]) {
        const button = [...window.document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
        expect(button).toBeDefined();
        (button as unknown as HTMLElement).click();
      }
      expect(directions).toEqual(["forward", "backward", "front", "back"]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("sends ordinary Group and Ungroup intents through the canonical organizer", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const requests: unknown[] = [];
      const handlers = {
        onPatch: () => {}, onLayout: () => {}, onBoolean: () => {},
        onOrganize: (request: unknown) => requests.push(request),
      };
      const a = createNode({ id: "a", type: "rectangle", parentId: null });
      const b = createNode({ id: "b", type: "rectangle", parentId: null });
      renderInspector(window.document.body as unknown as HTMLElement, [a, b], handlers);
      ([...window.document.querySelectorAll("button")].find((button) => button.textContent === "Group") as unknown as HTMLElement).click();
      const group = createNode({ id: "group", type: "group", parentId: null });
      renderInspector(window.document.body as unknown as HTMLElement, [group], handlers);
      ([...window.document.querySelectorAll("button")].find((button) => button.textContent === "Ungroup") as unknown as HTMLElement).click();
      expect(requests).toEqual([
        { kind: "group", nodeIds: ["a", "b"] },
        { kind: "ungroup", nodeIds: ["group"] },
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });
});

describe("Inspector rotation and layout controls", () => {
  test("offers only valid same-parent layout intents", () => {
    const a = createNode({ id: "a", type: "rectangle", parentId: null });
    const b = createNode({ id: "b", type: "rectangle", parentId: null });
    const child = createNode({ id: "child", type: "rectangle", parentId: "frame" });
    expect(layoutControlsFor([a, b]).map((control) => control.label)).toEqual([
      "Align left", "Align center", "Align right", "Align top", "Align middle", "Align bottom",
    ]);
    expect(layoutControlsFor([a, b, createNode({ id: "c", type: "rectangle", parentId: null })]).map((control) => control.label)).toContain("Distribute horizontally");
    expect(layoutControlsFor([a, child])).toEqual([]);
    expect(layoutControlsFor([a])).toEqual([]);
  });

  test("rotation field and layout buttons dispatch semantic inspector intents", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const patches: Array<{ rotation?: number }> = [];
      const intents: string[] = [];
      const a = createNode({ id: "a", type: "rectangle", parentId: null, rotation: 10 });
      const b = createNode({ id: "b", type: "rectangle", parentId: null });
      renderInspector(window.document.body as unknown as HTMLElement, [a, b], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: (intent) => intents.push(intent.label),
      });
      // Multi-select intentionally hides per-node rotation; the controls are layout-only.
      expect(window.document.body.textContent).not.toContain("Rotation");
      const firstLayout = window.document.querySelector(".design-boolean-btn") as unknown as HTMLElement;
      firstLayout.click();
      expect(intents).toEqual(["Align left"]);

      renderInspector(window.document.body as unknown as HTMLElement, [a], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: () => {},
      });
      const rotation = [...window.document.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Rotation"))?.querySelector("input") as unknown as HTMLInputElement;
      rotation.value = "45";
      rotation.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ rotation: 45 });
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });
});

describe("Inspector appearance controls", () => {
  test("keeps the object header and fill/border controls in the shared inspector inset", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const patches: Array<Record<string, unknown>> = [];
      const rectangle = createNode({
        id: "rectangle",
        type: "rectangle",
        parentId: null,
        name: "Card",
        fills: [{ kind: "solid", color: "#112233" }],
        stroke: { color: "#445566", width: 2 },
      });
      renderInspector(window.document.body as unknown as HTMLElement, [rectangle], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: () => {},
      });
      const header = window.document.querySelector(".design-inspector__object-header");
      expect(header?.textContent).toContain("Rectangle");
      expect(window.document.querySelectorAll("h2")).toHaveLength(0);
      expect(header?.querySelector('input[aria-label="Name"]')?.getAttribute("value")).toBeNull();
      const name = header?.querySelector('input[aria-label="Name"]') as HTMLInputElement;
      expect(name.value).toBe("Card");
      expect(window.document.body.textContent).toContain("Fill enabled");
      expect(window.document.body.textContent).toContain("Border enabled");
      expect((window.document.querySelector('input[aria-label="Fill hex value"]') as HTMLInputElement).value).toBe("#112233");
      expect((window.document.querySelector('input[aria-label="Border hex value"]') as HTMLInputElement).value).toBe("#445566");
      const fillToggle = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Fill enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fillToggle.checked = false;
      fillToggle.dispatchEvent(new window.Event("change"));
      fillToggle.checked = true;
      fillToggle.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ fills: [] });
      expect(patches).toContainEqual({ fills: [{ kind: "solid", color: "#112233" }] });
      const borderToggle = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Border enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      borderToggle.checked = false;
      borderToggle.dispatchEvent(new window.Event("change"));
      borderToggle.checked = true;
      borderToggle.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ stroke: null });
      expect(patches).toContainEqual({ stroke: { color: "#445566", width: 2 } });
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("matches Fill and paint controls to the actual rendered node kind", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const multiPatches: Array<Record<string, unknown>> = [];
      const multiPatchesEach: unknown[] = [];
      const handlers = { onPatch: () => {}, onBoolean: () => {}, onLayout: () => {} };
      const text = createNode({ id: "text", type: "text", parentId: null, color: "#f00" });
      renderInspector(window.document.body as unknown as HTMLElement, [text], handlers);
      expect(window.document.body.textContent).not.toContain("Fill enabled");
      expect((window.document.querySelector('input[aria-label="Text color hex value"]') as HTMLInputElement).value).toBe("#ff0000");

      const line = createNode({
        id: "line", type: "vector", parentId: null,
        vectorNetwork: {
          vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 20, y: 10 }],
          segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }],
          regions: [],
        },
      });
      renderInspector(window.document.body as unknown as HTMLElement, [line], handlers);
      expect(window.document.body.textContent).not.toContain("Fill enabled");
      expect(window.document.body.textContent).toContain("Stroke enabled");

      const second = createNode({ id: "second", type: "rectangle", parentId: null, stroke: { color: "#000000", width: 1 } });
      renderInspector(window.document.body as unknown as HTMLElement, [
        createNode({ id: "first", type: "rectangle", parentId: null, stroke: { color: "#000000", width: 1 } }), second,
      ], {
        onPatch: (patch) => multiPatches.push(patch),
        onPatchEach: (patches) => multiPatchesEach.push(patches),
        onBoolean: () => {}, onLayout: () => {},
      });
      const multiToggle = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Border enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      multiToggle.checked = false;
      multiToggle.dispatchEvent(new window.Event("change"));
      expect(multiPatches).toEqual([]);
      expect(multiPatchesEach).toContainEqual([
        { nodeId: "first", patch: { stroke: null } },
        { nodeId: "second", patch: { stroke: null } },
      ]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });
});

describe("Inspector paint and text editing", () => {
  test("patches each mixed stroke from its own existing style", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const patches: unknown[] = [];
      const first = createNode({
        id: "first", type: "rectangle", parentId: null,
        stroke: { color: "#111111", width: 2, dash: [3, 1], cap: "round", join: "bevel" },
      });
      const second = createNode({
        id: "second", type: "rectangle", parentId: null,
        stroke: { color: "#222222", width: 8, dash: [8, 2], cap: "square", join: "round" },
      });
      renderInspector(window.document.body as unknown as HTMLElement, [first, second], {
        onPatch: () => {},
        onPatchEach: (next) => patches.push(next),
        onBoolean: () => {}, onLayout: () => {},
      });
      const color = window.document.querySelector('input[aria-label="Border hex value"]') as HTMLInputElement;
      color.value = "#abcdef";
      color.dispatchEvent(new window.Event("change"));
      expect(patches).toEqual([[
        { nodeId: "first", patch: { stroke: { color: "#abcdef", width: 2, dash: [3, 1], cap: "round", join: "bevel" } } },
        { nodeId: "second", patch: { stroke: { color: "#abcdef", width: 8, dash: [8, 2], cap: "square", join: "round" } } },
      ]]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("shows defaults as enabled and preserves focus through an inspector rebuild", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const line = createNode({ id: "line", type: "vector", parentId: null });
      renderInspector(window.document.body as unknown as HTMLElement, [line], {
        onPatch: () => {}, onBoolean: () => {}, onLayout: () => {},
      });
      const strokeToggle = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Stroke enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(strokeToggle.checked).toBe(true);

      const text = createNode({ id: "text", type: "text", parentId: null, text: "hello" });
      renderInspector(window.document.body as unknown as HTMLElement, [text], {
        onPatch: () => {}, onBoolean: () => {}, onLayout: () => {},
      });
      const content = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Content"))
        ?.querySelector("textarea") as HTMLTextAreaElement;
      content.focus();
      content.setSelectionRange(1, 4);
      renderInspector(window.document.body as unknown as HTMLElement, [text], {
        onPatch: () => {}, onBoolean: () => {}, onLayout: () => {},
      });
      const rebuilt = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Content"))
        ?.querySelector("textarea") as HTMLTextAreaElement;
      expect(window.document.activeElement).toBe(rebuilt);
      expect([rebuilt.selectionStart, rebuilt.selectionEnd]).toEqual([1, 4]);
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("moves Tab to the rebuilt inspector control after a blur commit without trapping boundaries", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      let node = createNode({ id: "rectangle", type: "rectangle", parentId: null, width: 80, height: 60 });
      const patches: Array<Record<string, unknown>> = [];
      const render = () => renderInspector(window.document.body as unknown as HTMLElement, [node], handlers);
      const handlers = {
        onPatch: (patch: Record<string, unknown>) => {
          patches.push(patch);
          node = { ...node, ...patch };
          render();
        },
        onBoolean: () => {}, onLayout: () => {},
      };
      const control = (label: string) => [...window.document.querySelectorAll("label")]
        .find((candidate) => candidate.textContent?.startsWith(label))
        ?.querySelector("input, select, textarea") as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      render();

      const width = control("W");
      width.focus();
      width.value = "95";
      // Happy DOM does not model a native input's change-on-blur commit, so
      // emulate the browser's event order without having navigation synthesize
      // a duplicate change event itself.
      width.addEventListener("blur", () => width.dispatchEvent(new window.Event("change", { bubbles: true })));
      const forward = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      width.dispatchEvent(forward);
      expect(forward.defaultPrevented).toBeTrue();
      expect(patches).toEqual([{ width: 95 }]);
      const height = control("H");
      expect(window.document.activeElement).toBe(height);

      height.value = "72";
      height.addEventListener("blur", () => height.dispatchEvent(new window.Event("change", { bubbles: true })));
      const backward = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      height.dispatchEvent(backward);
      expect(backward.defaultPrevented).toBeTrue();
      expect(patches).toEqual([{ width: 95 }, { height: 72 }]);
      expect(window.document.activeElement).toBe(control("W"));

      const name = window.document.querySelector('input[aria-label="Name"]') as HTMLInputElement;
      name.focus();
      const beforeInspector = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      name.dispatchEvent(beforeInspector);
      expect(beforeInspector.defaultPrevented).toBeFalse();

      const borderDashPattern = control("Border dash pattern");
      borderDashPattern.focus();
      const afterInspector = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      borderDashPattern.dispatchEvent(afterInspector);
      expect(afterInspector.defaultPrevented).toBeFalse();
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("uses exact bundled font faces while retaining imported SVG-only text choices", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const patches: Array<Record<string, unknown>> = [];
      const text = createNode({
        id: "text", type: "text", parentId: null, lineHeight: 1.5, textWrap: true,
        fontFamily: "Inter", fontWeight: "600",
      });
      renderInspector(window.document.body as unknown as HTMLElement, [text], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: () => {},
      });
      const family = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Font family"))
        ?.querySelector("select") as HTMLSelectElement;
      expect(family.value).toBe("Inter");
      expect([...family.options].find((option) => option.value === "Inter")?.textContent).toBe("SVG-only: Inter");
      family.value = DESIGN_BUNDLED_SERIF_FONT_FAMILY;
      family.dispatchEvent(new window.Event("change"));
      const weight = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Font weight"))
        ?.querySelector("select") as HTMLSelectElement;
      expect(weight.disabled).toBeTrue();
      const lineHeight = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Line height"))
        ?.querySelector("input") as HTMLInputElement;
      lineHeight.value = "1.75";
      lineHeight.dispatchEvent(new window.Event("change"));
      const wrap = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Wrap text"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      wrap.checked = false;
      wrap.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ fontFamily: DESIGN_BUNDLED_SERIF_FONT_FAMILY, fontWeight: 400 });
      expect(patches).toContainEqual({ lineHeight: 1.75 });
      expect(patches).toContainEqual({ textWrap: false });

      renderInspector(window.document.body as unknown as HTMLElement, [createNode({
        id: "bundled", type: "text", parentId: null, fontFamily: DESIGN_BUNDLED_FONT_FAMILY, fontWeight: 600,
      })], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: () => {},
      });
      const bundledWeight = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Font weight"))
        ?.querySelector("select") as HTMLSelectElement;
      expect([...bundledWeight.options].map((option) => option.value)).toEqual(["400", "700"]);
      expect(bundledWeight.value).toBe("700");
      bundledWeight.value = "700";
      bundledWeight.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ fontWeight: 700 });

      renderInspector(window.document.body as unknown as HTMLElement, [createNode({
        id: "unsupported", type: "text", parentId: null, fontFamily: DESIGN_BUNDLED_SERIF_FONT_FAMILY, fontWeight: 700,
      })], {
        onPatch: (patch) => patches.push(patch), onBoolean: () => {}, onLayout: () => {},
      });
      const unsupportedWeight = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.startsWith("Font weight"))
        ?.querySelector("select") as HTMLSelectElement;
      expect(unsupportedWeight.value).toBe("unsupported:700");
      expect(unsupportedWeight.selectedOptions[0]?.textContent).toBe("Unsupported: 700");
      expect(unsupportedWeight.disabled).toBeFalse();
      unsupportedWeight.value = "400";
      unsupportedWeight.dispatchEvent(new window.Event("change"));
      expect(patches).toContainEqual({ fontWeight: 400 });
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });
});

describe("Connector inspector", () => {
  test("uses connector-specific labels, controls, callbacks, and endpoint status", () => {
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const target = createNode({ id: "target", type: "rectangle", parentId: null, name: "Hero card" });
      const connector = createNode({
        id: "connector",
        type: "vector",
        parentId: null,
        name: "Flow",
        vectorNetwork: {
          vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 50 }],
          segments: [{ id: "segment", startVertexId: "a", endVertexId: "b" }],
          regions: [],
        },
        connector: {
          route: "straight",
          start: { x: 10, y: 20, targetId: "target", anchor: { x: 0.5, y: 1 } },
          end: { x: 110, y: 70, detachedFromTargetId: "deleted-card" },
        },
      });
      const designDocument = { ...createEmptyDocument(), nodes: { target, connector } };
      const connectorPatches: Array<Record<string, unknown>> = [];
      renderInspector(window.document.body as unknown as HTMLElement, [connector], {
        onPatch: () => {}, onConnectorPatch: (patch) => connectorPatches.push(patch), onBoolean: () => {}, onLayout: () => {},
      }, designDocument);
      expect(window.document.querySelector(".design-inspector__object-kind")?.textContent).toContain("Connector");
      expect(window.document.body.textContent).not.toContain("Layout");
      expect(window.document.body.textContent).toContain("Stroke enabled");
      expect(window.document.body.textContent).toContain("Routing");
      expect(window.document.body.textContent).toContain("Attached to Hero card");
      expect(window.document.body.textContent).toContain("Detached — target was deleted");
      const route = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Routing"))
        ?.querySelector("select") as HTMLSelectElement;
      route.value = "elbow";
      route.dispatchEvent(new window.Event("change"));
      const startArrow = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Start arrow enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      startArrow.checked = true;
      startArrow.dispatchEvent(new window.Event("change"));
      const endArrow = [...window.document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("End arrow enabled"))
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      endArrow.checked = true;
      endArrow.dispatchEvent(new window.Event("change"));
      expect(connectorPatches).toContainEqual({ route: "elbow" });
      expect(connectorPatches).toContainEqual({ startArrow: true });
      expect(connectorPatches).toContainEqual({ endArrow: true });
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("reports free and detached endpoints without pretending either is attached", () => {
    expect(connectorEndpointStatus({ x: 0, y: 0 })).toBe("Free");
    expect(connectorEndpointStatus({ x: 0, y: 0, detachedFromTargetId: "gone" })).toBe("Detached — target was deleted");
    expect(connectorEndpointStatus({ x: 0, y: 0, targetId: "unavailable" })).toBe("Attached");
  });
});

describe("inspector derivations", () => {
  test("primaryFillColor reads the first solid fill", () => {
    const withFill = createNode({
      id: "n",
      type: "rectangle",
      parentId: null,
      fills: [{ kind: "solid", color: "#ff0000" }],
    });
    expect(primaryFillColor(withFill)).toBe("#ff0000");
    const noFill = createNode({ id: "n2", type: "rectangle", parentId: null });
    expect(primaryFillColor(noFill)).toBeNull();
  });

  test("selectionLabel describes 0, 1, and many nodes", () => {
    const node = createNode({ id: "n", type: "frame", parentId: null, name: "Hero" });
    expect(selectionLabel([])).toBe("No selection");
    expect(selectionLabel([node])).toBe("Frame · Hero");
    expect(selectionLabel([node, node])).toBe("2 nodes selected");
  });

  test("nodeKindLabel and normalizeColor produce safe values", () => {
    expect(nodeKindLabel("rectangle")).toBe("Rectangle");
    expect(normalizeColor("#abcdef")).toBe("#abcdef");
    expect(normalizeColor("#f00")).toBe("#ff0000");
    expect(normalizeColor("rgb(0,0,0)")).toBe("#3b82f6");
  });
});

describe("commonValue", () => {
  test("empty input is not mixed and has no value", () => {
    expect(commonValue([])).toEqual({ mixed: false, value: undefined });
  });

  test("uniform values collapse to a single value", () => {
    expect(commonValue([1, 1, 1])).toEqual({ mixed: false, value: 1 });
    expect(commonValue(["#fff"])).toEqual({ mixed: false, value: "#fff" });
  });

  test("differing values report mixed", () => {
    expect(commonValue([1, 2])).toEqual({ mixed: true, value: undefined });
    expect(commonValue(["#fff", null])).toEqual({ mixed: true, value: undefined });
  });
});

describe("reorderList", () => {
  test("moves a source before a target", () => {
    expect(reorderList(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  test("moves a source after a target", () => {
    expect(reorderList(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  test("moving before a later target lands just before it", () => {
    expect(reorderList(["a", "b", "c", "d"], "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
  });

  test("source equal to target is a no-op copy", () => {
    const order = ["a", "b", "c"];
    const result = reorderList(order, "b", "b", "before");
    expect(result).toEqual(order);
    expect(result).not.toBe(order);
  });

  test("absent target returns an unchanged copy", () => {
    expect(reorderList(["a", "b"], "a", "z", "after")).toEqual(["a", "b"]);
  });
});

describe("stroke inspector helpers", () => {
  test("parseDashInput accepts spaces and commas, drops invalid entries", () => {
    expect(parseDashInput("4 2")).toEqual([4, 2]);
    expect(parseDashInput("4, 2, 1")).toEqual([4, 2, 1]);
    expect(parseDashInput("")).toEqual([]);
    expect(parseDashInput("4 -1 abc 3")).toEqual([4, 3]);
  });

  test("formatDash round-trips a dash array to a display string", () => {
    expect(formatDash([4, 2])).toBe("4, 2");
    expect(formatDash([])).toBe("");
    expect(formatDash(undefined)).toBe("");
  });

  test("strokeOrDefault falls back when no stroke is present", () => {
    const withStroke = createNode({
      id: "n",
      type: "rectangle",
      parentId: null,
      stroke: { color: "#123456", width: 3, cap: "round" },
    });
    expect(strokeOrDefault(withStroke)).toEqual({ color: "#123456", width: 3, cap: "round" });
    const bare = createNode({ id: "n2", type: "rectangle", parentId: null });
    expect(strokeOrDefault(bare)).toEqual({ color: "#0f172a", width: 1 });
  });

  test("isStrokeCapable covers rectangle/frame/vector only", () => {
    const mk = (type: Parameters<typeof createNode>[0]["type"]) =>
      createNode({ id: type, type, parentId: null });
    expect(isStrokeCapable(mk("rectangle"))).toBe(true);
    expect(isStrokeCapable(mk("frame"))).toBe(true);
    expect(isStrokeCapable(mk("vector"))).toBe(true);
    expect(isStrokeCapable(mk("text"))).toBe(false);
    expect(isStrokeCapable(mk("image"))).toBe(false);
  });

  test("isFillCapable excludes text and open vectors while retaining closed shapes", () => {
    const rectangle = createNode({ id: "rectangle", type: "rectangle", parentId: null });
    const text = createNode({ id: "text", type: "text", parentId: null });
    const line = createNode({
      id: "line", type: "vector", parentId: null,
      vectorNetwork: { vertices: [], segments: [], regions: [] },
    });
    const closed = createNode({
      id: "closed", type: "vector", parentId: null,
      vectorNetwork: { vertices: [], segments: [], regions: [{ id: "region", vertexIds: [] }] },
    });
    expect(isFillCapable(rectangle)).toBe(true);
    expect(isFillCapable(text)).toBe(false);
    expect(isFillCapable(line)).toBe(false);
    expect(isFillCapable(closed)).toBe(true);
  });
});

describe("boolean grouping helpers", () => {
  test("canGroupAsBoolean requires 2+ nodes sharing one parent", () => {
    const a = createNode({ id: "a", type: "rectangle", parentId: null });
    const b = createNode({ id: "b", type: "rectangle", parentId: null });
    const c = createNode({ id: "c", type: "rectangle", parentId: "frame" });
    expect(canGroupAsBoolean([a])).toBe(false);
    expect(canGroupAsBoolean([a, b])).toBe(true);
    expect(canGroupAsBoolean([a, c])).toBe(false);
  });

  test("booleanOpLabel capitalizes the op name", () => {
    expect(booleanOpLabel("union")).toBe("Union");
    expect(booleanOpLabel("exclude")).toBe("Exclude");
  });

  test("isBooleanNode detects a group carrying a booleanOp", () => {
    const bool = createNode({ id: "b", type: "group", parentId: null, booleanOp: "union" });
    const plainGroup = createNode({ id: "g", type: "group", parentId: null });
    const rect = createNode({ id: "r", type: "rectangle", parentId: null });
    expect(isBooleanNode(bool)).toBe(true);
    expect(isBooleanNode(plainGroup)).toBe(false);
    expect(isBooleanNode(rect)).toBe(false);
  });

  test("a boolean node is not stroke-capable, so the inspector uses the boolean note", () => {
    const bool = createNode({ id: "b", type: "group", parentId: null, booleanOp: "subtract" });
    // The inspector gate: boolean → note instead of editable stroke controls.
    expect(isStrokeCapable(bool)).toBe(false);
    expect(isBooleanNode(bool)).toBe(true);
    expect(BOOLEAN_STROKE_NOTE).toContain("Borders");
    expect(BOOLEAN_STROKE_NOTE).toContain("boolean");
  });
});
