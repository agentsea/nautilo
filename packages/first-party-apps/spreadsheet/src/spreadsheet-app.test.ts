import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Spreadsheet } from "../engine/browser.js";
import { writeWorksheetCell } from "../engine/node.js";
import type { SheetsBridge } from "./sheet-bridge";
import { parseSheetHtml, serializeSheetHtml } from "./sheet-document";
import { applySheetDataOperation } from "./sheet-data";
import { mountSpreadsheet } from "./spreadsheet-app";

type CandidateFailure = "none" | "initialize" | "recalculate" | "restore";

type StoreLike = {
  set?(ref: { r: number; c: number }, cell: { v: string }): Promise<unknown>;
};

type DomFixture = {
  document: Document;
  window: Window;
  restore(): void;
};

function installDom(): DomFixture {
  const window = new Window();
  const previous = new Map(
    ["window", "document", "HTMLElement", "MutationObserver", "KeyboardEvent", "matchMedia"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const media = {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  Object.defineProperties(globalThis, {
    window: { value: window, configurable: true, writable: true },
    document: { value: window.document, configurable: true, writable: true },
    HTMLElement: { value: window.HTMLElement, configurable: true, writable: true },
    MutationObserver: { value: window.MutationObserver, configurable: true, writable: true },
    KeyboardEvent: { value: window.KeyboardEvent, configurable: true, writable: true },
    matchMedia: { value: () => media, configurable: true, writable: true },
  });
  return {
    document: window.document as unknown as Document,
    window,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      window.close();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const emptyDocument = readFileSync(
  join(import.meta.dir, "..", "templates", "empty-spreadsheet.html"),
  "utf8",
);

class FakeEditor {
  readonly marker: HTMLDivElement;
  readonly selectionCallbacks: Array<() => void> = [];
  validationError: ((message: string) => void) | undefined;
  onValidationError(callback: (message: string) => void): void { this.validationError = callback; }
  cleanupCalls = 0;
  initializeCalls = 0;
  recalculateCalls = 0;
  setZoomCalls = 0;
  private store: StoreLike | undefined;

  constructor(
    host: HTMLDivElement,
    readonly id: string,
    private readonly failure: CandidateFailure,
  ) {
    this.marker = host.ownerDocument.createElement("div");
    this.marker.dataset.fakeEditor = id;
    this.marker.textContent = `editor ${id}`;
    host.append(this.marker);
  }

  async initialize(store: StoreLike): Promise<void> {
    this.initializeCalls += 1;
    this.store = store;
    if (this.failure === "initialize") throw new Error("candidate initialize failed");
  }

  setGridResolver(): void {}
  setFormulaResolver(): void {}

  async recalculateCrossSheetFormulas(): Promise<void> {
    this.recalculateCalls += 1;
    if (this.failure === "recalculate") throw new Error("candidate recalculate failed");
  }

  cleanup(): void {
    this.cleanupCalls += 1;
    this.marker.remove();
  }

  onSelectionChange(callback: () => void): () => void {
    this.selectionCallbacks.push(callback);
    return () => {
      const index = this.selectionCallbacks.indexOf(callback);
      if (index >= 0) this.selectionCallbacks.splice(index, 1);
    };
  }

  emitSelection(): void {
    for (const callback of this.selectionCallbacks) callback();
  }

  isSelectionMerged(): boolean { return false; }
  async getActiveStyle(): Promise<undefined> { return undefined; }
  async getActiveEffectiveAlign(): Promise<"left"> { return "left"; }
  getSelectionRangeOrActiveCell() { return [{ r: 1, c: 1 }, { r: 1, c: 1 }] as const; }

  getSelectionType(): "cell" { return "cell"; }
  getActiveCell() { return { r: 1, c: 1 }; }
  getSelectionRanges() { return []; }
  getSelectedIndices() { return null; }
  getScrollableGridViewportRect() { return { left: 0, top: 0, width: 640, height: 360 }; }
  cellRefFromPoint() { return { r: 10, c: 5 }; }
  getCellRect() { return { left: 40, top: 60, width: 80, height: 22 }; }
  getZoom() { return 1; }
  setZoom(): void {
    this.setZoomCalls += 1;
    if (this.failure === "restore") throw new Error("candidate view restore failed");
  }
  panBy(): void {}
  selectStart(): void {}
  selectEnd(): void {}
  addSelection(): void {}
  addSelectionEnd(): void {}
  selectRow(): void {}
  selectColumn(): void {}
  async focusCell(): Promise<void> {}
  render(): void {}

  async writeCell(ref: { r: number; c: number }, value: string): Promise<void> {
    await this.store?.set?.(ref, { v: value });
  }

  async toggleStyle(): Promise<void> {
    await this.store?.set?.({ r: 1, c: 1 }, { v: "old editor remains active" });
  }
  async toggleMergeCells(): Promise<void> {}
  async applyStyle(): Promise<void> {}
  async insertRows(): Promise<void> {}
  async deleteRows(): Promise<void> {}
  async insertColumns(): Promise<void> {}
  async deleteColumns(): Promise<void> {}
}

function bridgeFixture(content = emptyDocument) {
  const writes: Array<{ content: string; baseRevision: number | null }> = [];
  const contexts: Array<Record<string, unknown>> = [];
  const bridge: SheetsBridge = {
    document: {
      read: async () => ({
        content,
        path: "/workspace/Budget.spreadsheet.html",
        baseSha256: "sha-1",
        baseRevision: 1,
      }),
      write: async (content, base) => {
        writes.push({ content, baseRevision: base.baseRevision });
        return { kind: "saved" as const, sha256: "sha-2", revision: 2 };
      },
      downloadCopy: async () => {},
      onChange: () => () => {},
    },
    context: { set: (summary) => { contexts.push(summary); } },
  };
  return { bridge, contexts, writes };
}

function gridHost(root: HTMLElement): HTMLDivElement {
  const host = root.querySelector<HTMLDivElement>("#sheets-grid");
  if (!host) throw new Error("grid host missing");
  host.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500,
    toJSON: () => ({}),
  });
  return host;
}

describe("spreadsheet replacement mount failures", () => {
  let dom: DomFixture;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    dom = installDom();
    dom.document.documentElement.dataset.theme = "light";
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    dom.restore();
  });

  test("surfaces an engine refusal without changing the document", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const fixture = bridgeFixture();
    let editor: FakeEditor | undefined;
    dispose = await mountSpreadsheet(root, fixture.bridge, {
      createEditor(host) {
        editor = new FakeEditor(host, "validation", "none");
        return editor as unknown as Spreadsheet;
      },
    });
    editor?.validationError?.("Checkbox selection was not changed. Select a smaller range.");
    expect(root.textContent).toContain("Checkbox selection was not changed. Select a smaller range.");
    expect(fixture.writes).toEqual([]);
  });

  test("opens Data with fresh unsaved cell extent and headers", async () => {
    const root = dom.document.createElement("div"); dom.document.body.append(root);
    const fixture = bridgeFixture();
    let currentEditor!: FakeEditor;
    dispose = await mountSpreadsheet(root, fixture.bridge, { createEditor(host) {
      currentEditor = new FakeEditor(host, "editor", "none");
      return currentEditor as unknown as Spreadsheet;
    } });
    await currentEditor.writeCell({ r: 1, c: 2 }, "Amount");
    await currentEditor.writeCell({ r: 4, c: 2 }, "12");
    expect(fixture.writes).toHaveLength(0);
    root.querySelector<HTMLButtonElement>("[aria-label='Data']")?.click();
    await settle();
    expect(root.querySelector<HTMLInputElement>("[aria-label='Data range']")?.value).toBe("B1:B4");
    expect(root.querySelector<HTMLSelectElement>("[aria-label='Data column']")?.textContent).toContain("B — Amount");
  });

  test("applies a filter through a staged mount and restores it with one undo", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const seeded = parseSheetHtml(emptyDocument);
    writeWorksheetCell(seeded.sheets["tab-1"], { r: 1, c: 1 }, { v: "Name" });
    writeWorksheetCell(seeded.sheets["tab-1"], { r: 2, c: 1 }, { v: "keep" });
    const fixture = bridgeFixture(serializeSheetHtml(seeded));
    const editors: FakeEditor[] = [];
    dispose = await mountSpreadsheet(root, fixture.bridge, {
      createEditor(host) {
        const editor = new FakeEditor(host, `editor-${editors.length + 1}`, "none");
        editors.push(editor);
        return editor as unknown as Spreadsheet;
      },
    });
    gridHost(root);

    root.querySelector<HTMLButtonElement>("[aria-label='Data']")?.click();
    await settle();
    const range = root.querySelector<HTMLInputElement>("[aria-label='Data range']");
    if (!range) throw new Error("data range missing");
    range.value = "A1:A2";
    const filterValue = root.querySelector<HTMLInputElement>("[aria-label='Filter value']");
    if (!filterValue) throw new Error("filter value missing");
    filterValue.value = "keep";
    const panel = root.querySelector<HTMLElement>("[aria-label='Sort and filter data']");
    panel?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await settle();

    expect(editors).toHaveLength(2);
    expect(root.textContent).toContain("1 active filter");

    root.querySelector<HTMLButtonElement>("[aria-label='Find']")?.click();
    const search = root.querySelector<HTMLInputElement>("[aria-label='Find in spreadsheet']");
    search?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }) as unknown as KeyboardEvent);
    await settle();
    expect(editors).toHaveLength(2);

    root.querySelector<HTMLButtonElement>("[data-sheet-action='undo']")?.click();
    await settle();
    expect(editors).toHaveLength(3);
    expect(root.textContent).toContain("No active filter");
  });

  test("edits and removes one filter column without dropping the others", async () => {
    const root = dom.document.createElement("div"); dom.document.body.append(root);
    const seeded = parseSheetHtml(emptyDocument);
    const sheet = seeded.sheets["tab-1"];
    for (const [ref, value] of [[[1, 1], "Name"], [[1, 2], "Status"], [[2, 1], "Ada"], [[2, 2], "Open"]] as const) {
      writeWorksheetCell(sheet, { r: ref[0], c: ref[1] }, { v: value });
    }
    const filtered = await applySheetDataOperation(seeded, { op: "set-filter", sheetId: "tab-1", range: "A1:B2", columns: { "2": { op: "equals", value: "Open" } } });
    const fixture = bridgeFixture(serializeSheetHtml(filtered));
    const editors: FakeEditor[] = [];
    dispose = await mountSpreadsheet(root, fixture.bridge, { createEditor(host) { const editor = new FakeEditor(host, `editor-${editors.length + 1}`, "none"); editors.push(editor); return editor as unknown as Spreadsheet; } });
    gridHost(root);
    root.querySelector<HTMLButtonElement>("[aria-label='Data']")?.click();
    await settle();
    const column = root.querySelector<HTMLSelectElement>("[aria-label='Data column']");
    const value = root.querySelector<HTMLInputElement>("[aria-label='Filter value']");
    const panel = root.querySelector<HTMLElement>("[aria-label='Sort and filter data']");
    if (!column || !value || !panel) throw new Error("data controls missing");
    expect(column.textContent).toContain("A — Name");
    expect(column.textContent).toContain("B — Status");
    column.value = "1"; column.dispatchEvent(new dom.window.Event("change", { bubbles: true }) as unknown as Event);
    value.value = "Ada";
    panel.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await settle();
    expect(root.textContent).toContain("2 active filters");
    panel.querySelectorAll<HTMLButtonElement>("button")[2]?.click();
    await settle();
    expect(root.textContent).toContain("1 active filter");
  });

  for (const failure of ["initialize", "recalculate"] as const) {
    test(`keeps the live editor when an added-sheet candidate ${failure} fails`, async () => {
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      const fixture = bridgeFixture();
      const editors: FakeEditor[] = [];
      dispose = await mountSpreadsheet(root, fixture.bridge, {
        createEditor(host) {
          const editor = new FakeEditor(host, `editor-${editors.length + 1}`, editors.length === 0 ? "none" : failure);
          editors.push(editor);
          return editor as unknown as Spreadsheet;
        },
      });
      const host = gridHost(root);
      const live = editors[0];
      expect(host.querySelector("[data-fake-editor='editor-1']")).not.toBeNull();

      root.querySelector<HTMLButtonElement>("[aria-label='Add sheet']")?.click();
      const name = root.querySelector<HTMLInputElement>("[aria-label='Sheet name']");
      if (!name) throw new Error("sheet name dialog missing");
      name.value = "Failed replacement";
      name.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
      root.querySelector<HTMLButtonElement>("[role='dialog'] button")?.click();
      await settle();

      const candidate = editors[1];
      expect(candidate).toBeDefined();
      expect(candidate?.cleanupCalls).toBe(1);
      expect(live.cleanupCalls).toBe(0);
      expect(host.querySelector("[data-fake-editor='editor-1']")).not.toBeNull();
      expect(root.querySelectorAll("[role='tab']")).toHaveLength(1);
      expect(fixture.writes).toEqual([]);

      const contextsBefore = fixture.contexts.length;
      live.emitSelection();
      await settle();
      expect(fixture.contexts.length).toBeGreaterThan(contextsBefore);
      expect(root.querySelector<HTMLButtonElement>("[aria-label='Save spreadsheet']")?.disabled).toBe(false);
      root.querySelector<HTMLButtonElement>("[aria-label='Save spreadsheet']")?.click();
      await settle();
      expect(fixture.writes).toEqual([]);
    });
  }

  test("does not replace the light editor when dark-theme view restoration fails", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const fixture = bridgeFixture();
    const editors: FakeEditor[] = [];
    dispose = await mountSpreadsheet(root, fixture.bridge, {
      createEditor(host) {
        const editor = new FakeEditor(host, `editor-${editors.length + 1}`, editors.length === 0 ? "none" : "restore");
        editors.push(editor);
        return editor as unknown as Spreadsheet;
      },
    });
    const host = gridHost(root);
    const live = editors[0];
    expect(root.dataset.sheetsTheme).toBe("light");

    dom.document.documentElement.dataset.theme = "dark";
    await settle();

    const candidate = editors[1];
    expect(candidate).toBeDefined();
    expect(candidate?.setZoomCalls).toBe(1);
    expect(candidate?.cleanupCalls).toBe(1);
    expect(live.cleanupCalls).toBe(0);
    expect(root.dataset.sheetsTheme).toBe("light");
    expect(host.querySelector("[data-fake-editor='editor-1']")).not.toBeNull();
    expect(fixture.writes).toEqual([]);
  });
});
