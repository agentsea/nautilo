import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createDefaultManifest, parseDesignHtml, serializeDesignHtml } from "../design-document";
import { appendChild, createEmptyDocument, createNode } from "../scene-graph";
import type { NautiloAppBridge, NautiloDocumentChangeEvent, NautiloDocumentEnvelope } from "../bridge";

const DOM_GLOBALS = [
  "window", "document", "HTMLElement", "SVGElement", "Node", "Event", "KeyboardEvent", "MouseEvent",
] as const;

function installDom(window: Window): () => void {
  const descriptors = new Map<string, PropertyDescriptor | undefined>(
    DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const replacements: Record<(typeof DOM_GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
  };
  for (const name of DOM_GLOBALS) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: replacements[name] });
  }
  return () => {
    for (const name of DOM_GLOBALS) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

function emptyEnvelope(content = serializeDesignHtml(createDefaultManifest(), createEmptyDocument())): NautiloDocumentEnvelope {
  return { content, path: "Acceptance.design.html", baseSha256: "base-sha", baseRevision: 1 };
}

function textEnvelope(): NautiloDocumentEnvelope {
  const text = createNode({ id: "text", type: "text", parentId: null, x: 10, y: 10, width: 180, height: 40, text: "Before delete" });
  const doc = appendChild({ ...createEmptyDocument(), nodes: { text } }, null, "text", "page-1");
  return emptyEnvelope(serializeDesignHtml(createDefaultManifest(), doc));
}

type BridgeHarness = {
  bridge: NautiloAppBridge;
  emit: (event: NautiloDocumentChangeEvent) => void;
  getPrepareClose: () => CloseHandler | null;
  writes: string[];
  saveCopies: string[];
};

type CloseHandler = Parameters<NonNullable<NonNullable<NautiloAppBridge["lifecycle"]>["onPrepareClose"]>>[0];

function bridgeHarness(read: () => Promise<NautiloDocumentEnvelope>): BridgeHarness {
  let onChange: ((event: NautiloDocumentChangeEvent) => void) | null = null;
  let onPrepareClose: CloseHandler | null = null;
  const writes: string[] = [];
  const saveCopies: string[] = [];
  const bridge: NautiloAppBridge = {
    document: {
      read,
      write: async (next) => {
        writes.push(typeof next === "string" ? next : next.content);
        return { kind: "saved", sha256: "saved-sha", revision: 2 };
      },
      saveCopy: async (next) => {
        saveCopies.push(typeof next === "string" ? next : next.content);
        return { path: "Recovery copy.design.html" };
      },
      onChange: (handler) => {
        onChange = handler;
        return () => { onChange = null; };
      },
    },
    context: { set: () => {} },
    lifecycle: {
      onPrepareClose: (handler) => {
        onPrepareClose = handler;
        return () => { onPrepareClose = null; };
      },
    },
  };
  return {
    bridge,
    emit: (event) => onChange?.(event),
    getPrepareClose: () => onPrepareClose,
    writes,
    saveCopies,
  };
}

async function createEditor(window: Window, bridge: NautiloAppBridge) {
  (window as unknown as { nautiloApp?: NautiloAppBridge }).nautiloApp = bridge;
  // The test document has no #app, so importing main.ts does not auto-mount.
  const { DesignEditor } = await import("../../main");
  const root = window.document.createElement("div");
  window.document.body.appendChild(root);
  return { root, editor: new DesignEditor(root as unknown as HTMLElement) };
}

function buttonByLabel(root: unknown, label: string): HTMLButtonElement {
  const queryRoot = root as ParentNode;
  const button = [...queryRoot.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);
  if (!button) throw new Error(`Missing ${label} button.`);
  return button as unknown as HTMLButtonElement;
}

function screenPointForCanvasPoint(root: unknown, point: { x: number; y: number }): { x: number; y: number } {
  const transform = (root as ParentNode).querySelector(".design-canvas__scene")?.getAttribute("transform") ?? "";
  const match = /translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)/.exec(transform);
  if (!match) throw new Error(`Unexpected canvas transform: ${transform}`);
  return { x: Number(match[1]) + point.x * Number(match[3]), y: Number(match[2]) + point.y * Number(match[3]) };
}

describe("DesignEditor lifecycle UI", () => {
  test("keeps a generic load failure inert, then Retry load restores ordinary editing", async () => {
    const window = new Window();
    const restore = installDom(window);
    try {
      let attempts = 0;
      const bridge = bridgeHarness(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Host temporarily unavailable.");
        return emptyEnvelope();
      });
      const { root, editor } = await createEditor(window, bridge.bridge);
      await editor.start();

      const app = root.querySelector(".design-app") as unknown as HTMLElement;
      const body = root.querySelector(".design-body") as unknown as HTMLElement;
      expect(app.querySelector('[data-kind="error"]')?.textContent).toContain("Host temporarily unavailable.");
      expect((app.querySelector(".design-topbar") as unknown as HTMLElement).inert).toBeTrue();
      expect(body.inert).toBeTrue();
      const prepareClose = bridge.getPrepareClose();
      if (!prepareClose) throw new Error("Missing lifecycle close handler.");
      expect(await prepareClose({ reason: "close", action: "prepare-close" })).toMatchObject({
        noLocalChanges: true,
        documentSaved: false,
        recoveryPersisted: false,
        recoverableDraftExact: false,
      });
      buttonByLabel(root, "Retry load").click();
      await settle();

      expect((app.querySelector(".design-topbar") as unknown as HTMLElement).inert).toBeFalse();
      expect(body.inert).toBeFalse();
      const frame = buttonByLabel(root, "Frame");
      frame.click();
      expect((root.querySelector("svg.design-canvas__svg") as unknown as SVGSVGElement).dataset["tool"]).toBe("frame");
      await editor.destroy();
    } finally {
      restore();
    }
  });

  test("freezes a deleted host document while preserving the latest inline draft for Save Copy and close", async () => {
    const window = new Window();
    const restore = installDom(window);
    try {
      const bridge = bridgeHarness(async () => textEnvelope());
      const { root, editor } = await createEditor(window, bridge.bridge);
      await editor.start();

      const svg = root.querySelector("svg.design-canvas__svg") as unknown as SVGSVGElement;
      const textPoint = screenPointForCanvasPoint(root, { x: 15, y: 15 });
      svg.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, clientX: textPoint.x, clientY: textPoint.y }) as unknown as Event);
      const inline = root.querySelector("textarea.design-text-editor") as unknown as HTMLTextAreaElement;
      expect(inline).toBeTruthy();
      inline.value = "Latest inline draft";
      bridge.emit({ type: "deleted", path: "Acceptance.design.html" });

      const app = root.querySelector(".design-app") as unknown as HTMLElement;
      const body = root.querySelector(".design-body") as unknown as HTMLElement;
      expect(app.querySelector('[data-kind="error"]')?.textContent).toContain("This document was deleted");
      expect((app.querySelector(".design-topbar") as unknown as HTMLElement).inert).toBeTrue();
      expect(body.inert).toBeTrue();
      buttonByLabel(root, "Save Copy").click();
      await settle();
      expect(bridge.writes).toEqual([]);
      expect(bridge.saveCopies).toHaveLength(1);
      const savedCopy = parseDesignHtml(bridge.saveCopies[0]!);
      expect(savedCopy.ok).toBeTrue();
      if (savedCopy.ok) expect(savedCopy.document.scene.nodes["text"]?.text).toBe("Latest inline draft");

      const prepareClose = bridge.getPrepareClose();
      if (!prepareClose) throw new Error("Missing lifecycle close handler.");
      const close = await prepareClose({ reason: "close", action: "prepare-close" });
      expect(close).toMatchObject({ documentSaved: false, recoveryPersisted: true, recoverableDraftExact: true });
      expect(bridge.saveCopies).toHaveLength(1);
      expect(bridge.writes).toEqual([]);
      await editor.destroy();
    } finally {
      restore();
    }
  });

  test("returns focus from Shapes and More tools, and closes a narrow drawer from an inspector input", async () => {
    const window = new Window();
    Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true }) });
    const restore = installDom(window);
    try {
      const bridge = bridgeHarness(async () => textEnvelope());
      const { root, editor } = await createEditor(window, bridge.bridge);
      await editor.start();

      const shapes = buttonByLabel(root, "Shapes — Rectangle");
      shapes.click();
      expect((root.querySelector('[role="menu"]') as unknown as HTMLElement).hidden).toBeFalse();
      expect(window.document.activeElement?.getAttribute("role")).toBe("menuitem");
      (window.document.activeElement as unknown as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
      expect(window.document.activeElement as unknown).toBe(shapes as unknown);

      const more = buttonByLabel(root, "More tools");
      more.click();
      const menus = [...(root as unknown as ParentNode).querySelectorAll('[role="menu"]')];
      expect((menus[1] as unknown as HTMLElement).hidden).toBeFalse();
      (window.document.activeElement as unknown as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
      expect(window.document.activeElement as unknown).toBe(more as unknown);

      const svg = root.querySelector("svg.design-canvas__svg") as unknown as SVGSVGElement;
      const textPoint = screenPointForCanvasPoint(root, { x: 15, y: 15 });
      svg.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, clientX: textPoint.x, clientY: textPoint.y }) as unknown as Event);
      buttonByLabel(root, "Inspector").click();
      const name = root.querySelector('input[aria-label="Name"]') as unknown as HTMLInputElement;
      name.focus();
      name.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
      expect((root.querySelector(".design-app") as unknown as HTMLElement).dataset["narrowDrawer"]).toBe("");
      expect(window.document.activeElement as unknown).toBe(buttonByLabel(root, "Inspector") as unknown);
      await editor.destroy();
    } finally {
      restore();
    }
  });
});
