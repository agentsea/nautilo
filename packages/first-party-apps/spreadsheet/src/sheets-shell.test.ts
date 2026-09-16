import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createSheetsShell, type SheetDataSetup, type SheetsShellActions } from "./sheets-shell";

function installDom(): { document: Document; restore: () => void } {
  const window = new Window();
  const previous = new Map(
    ["window", "document", "HTMLElement", "KeyboardEvent"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperties(globalThis, {
    window: { value: window, configurable: true, writable: true },
    document: { value: window.document, configurable: true, writable: true },
    HTMLElement: { value: window.HTMLElement, configurable: true, writable: true },
    KeyboardEvent: { value: window.KeyboardEvent, configurable: true, writable: true },
  });
  return {
    document: window.document as unknown as Document,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function actions(
  overrides: Partial<SheetsShellActions> = {},
): SheetsShellActions {
  return {
    save: async () => undefined,
    addSheet: async () => undefined,
    renameSheet: async () => undefined,
    selectSheet: async () => undefined,
    editorAction: async () => undefined,
    reload: async () => undefined,
    saveCopy: async () => undefined,
    getDataSetup: (range) => ({ range: range ?? "A1:D20", columns: [{ column: 1, label: "A — Name" }, { column: 2, label: "B — Amount" }, { column: 3, label: "C" }, { column: 4, label: "D" }], conditions: {} }),
    applySort: async () => undefined,
    applyFilter: async () => undefined,
    removeFilter: async () => undefined,
    clearFilter: async () => undefined,
    search: async () => [],
    navigateSearch: async () => undefined,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Sheets shell", () => {
  let dom: ReturnType<typeof installDom>;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.restore();
  });

  test("renders selectable keyboard tabs and creates sheets through a non-submitting dialog", async () => {
    const { document } = dom;
    const selected: string[] = [];
    const added: string[] = [];
    const shell = createSheetsShell(
      document.body,
      actions({
        selectSheet: async (id) => {
          selected.push(id);
        },
        addSheet: async (name) => {
          added.push(name ?? "");
        },
      }),
    );
    shell.setSheets(
      [
        { id: "one", name: "Sheet 1" },
        { id: "two", name: "Budget" },
      ],
      "one",
    );

    const tabs = document.querySelectorAll<HTMLButtonElement>("[role=tab]");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    tabs[0]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await settle();
    expect(selected).toEqual(["two"]);

    document
      .querySelector<HTMLButtonElement>("[aria-label='Add sheet']")
      ?.click();
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    expect(dialog?.hidden).toBe(false);
    expect(dialog?.tagName).toBe("DIV");
    const input = document.querySelector<HTMLInputElement>(
      "[aria-label='Sheet name']",
    );
    if (!input || !dialog) throw new Error("sheet dialog missing");
    document
      .querySelector<HTMLButtonElement>("[role=dialog] button")
      ?.click();
    expect(input.validity.valid).toBe(false);
    expect(added).toEqual([]);
    input.value = "Forecast";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
    expect(added).toEqual(["Forecast"]);
    expect(dialog.hidden).toBe(true);
    expect(shell.gridHost.id).toBe("sheets-grid");
  });

  test("renames the active sheet through the dialog confirm button", async () => {
    const { document } = dom;
    const renamed: Array<[string, string]> = [];
    const shell = createSheetsShell(
      document.body,
      actions({
        renameSheet: async (id, name) => {
          renamed.push([id, name]);
        },
      }),
    );
    shell.setSheets([{ id: "one", name: "Sheet 1" }], "one");
    document
      .querySelector<HTMLButtonElement>("[aria-label='Rename active sheet']")
      ?.click();
    const input = document.querySelector<HTMLInputElement>("[aria-label='Sheet name']");
    if (!input) throw new Error("sheet input missing");
    input.value = "Renamed";
    document
      .querySelectorAll<HTMLButtonElement>("[role=dialog] button")[0]
      ?.click();
    await settle();
    expect(renamed).toEqual([["one", "Renamed"]]);
  });

  test("keeps structural actions in an accessible Cells menu that dismisses safely", async () => {
    const { document } = dom;
    const edits: string[] = [];
    createSheetsShell(
      document.body,
      actions({
        editorAction: async (action) => {
          edits.push(action.kind);
        },
      }),
    );
    const cells = document.querySelector<HTMLButtonElement>("[aria-label='Cells']");
    const menu = document.querySelector<HTMLElement>("[role=menu]");
    if (!cells || !menu) throw new Error("Cells menu missing");
    expect(menu.parentElement).toBe(document.body);

    cells.click();
    expect(menu.hidden).toBe(false);
    expect(menu.style.insetBlockStart).not.toBe("");
    document.body.dispatchEvent(new window.Event("mousedown", { bubbles: true }));
    expect(menu.hidden).toBe(true);

    cells.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu.hidden).toBe(false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(cells);

    cells.click();
    document.querySelector<HTMLButtonElement>("[role=menuitem][data-sheet-action='insert-row']")?.click();
    await settle();
    expect(edits).toEqual(["insert-row"]);
    expect(menu.hidden).toBe(true);
  });

  test("offers one compact Data panel and discloses whole-row sorting before apply", async () => {
    const { document } = dom;
    const sorts: Array<Record<string, unknown>> = [];
    const filters: Array<Record<string, unknown>> = [];
    createSheetsShell(document.body, actions({
      applySort: async (input) => { sorts.push(input); },
      applyFilter: async (input) => { filters.push(input); },
    }));
    document.querySelector<HTMLButtonElement>("[aria-label='Data']")?.click();
    await settle();
    const panel = document.querySelector<HTMLElement>("[aria-label='Sort and filter data']");
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain("Sort entire rows. All columns in these rows move together.");
    panel?.querySelectorAll<HTMLButtonElement>("button")[0]?.click();
    await settle();
    expect(sorts).toEqual([{ range: "A1:D20", column: 1, direction: "asc", header: true }]);
    panel?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await settle();
    expect(filters).toEqual([{ range: "A1:D20", column: 1, op: "contains", value: "" }]);
    expect(document.querySelector<HTMLSelectElement>("[aria-label='Data column']")?.textContent).toContain("A — Name");
  });

  test("reloads cleared filter controls from authoritative setup", async () => {
    const { document } = dom;
    let active = true;
    let clears = 0;
    createSheetsShell(document.body, actions({
      getDataSetup: async (range) => {
        const conditions: SheetDataSetup["conditions"] = active
          ? { "1": { op: "equals", value: "Alpha" } }
          : {};
        return {
          range: range ?? "A1:B4",
          columns: [{ column: 1, label: "A — Name" }, { column: 2, label: "B — Amount" }],
          conditions,
        };
      },
      clearFilter: async () => { clears += 1; active = false; },
    }));
    document.querySelector<HTMLButtonElement>("[aria-label='Data']")?.click();
    await settle();
    const value = document.querySelector<HTMLInputElement>("[aria-label='Filter value']");
    const remove = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Remove column filter");
    const clear = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Clear filter");
    expect(value?.value).toBe("Alpha");
    expect(remove?.disabled).toBe(false);
    clear?.click();
    await settle();
    expect(clears).toBe(1);
    expect(value?.value).toBe("");
    expect(remove?.disabled).toBe(true);
  });

  test("finds with the platform shortcut and keeps focus while navigating hidden matches", async () => {
    const { document } = dom;
    const navigated: string[] = [];
    createSheetsShell(document.body, actions({
      search: async ({ query }) => query ? [{ sheetId: "two", sheetName: "Budget", ref: "B4", value: "Needle", hidden: true }] : [],
      navigateSearch: async (match) => { navigated.push(match.ref); },
    }));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    const input = document.querySelector<HTMLInputElement>("[aria-label='Find in spreadsheet']");
    if (!input) throw new Error("search input missing");
    input.value = "Needle";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(navigated).toEqual(["B4"]);
    expect(document.body.textContent).toContain("hidden by filter");
    expect(document.activeElement).toBe(input);
  });

  test("clears stale search matches before a deferred request and after its error", async () => {
    const { document } = dom;
    const navigated: string[] = [];
    let rejectPending: (error: Error) => void = () => undefined;
    const pending = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
    createSheetsShell(document.body, actions({
      search: async ({ query }) => {
        if (query === "old") return [{ sheetId: "one", sheetName: "Sheet 1", ref: "A1", value: "old", hidden: false }];
        if (query === "new") return pending;
        return [];
      },
      navigateSearch: async (match) => { navigated.push(match.ref); },
    }));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    const input = document.querySelector<HTMLInputElement>("[aria-label='Find in spreadsheet']");
    const next = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Next");
    if (!input || !next) throw new Error("search controls missing");
    input.value = "old";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    expect(document.body.textContent).toContain("1 match");

    input.value = "new";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    next.click();
    expect(navigated).toEqual([]);
    expect(document.body.textContent).toContain("Searching…");
    rejectPending(new Error("Search failed"));
    await settle();
    expect(document.body.textContent).toContain("Search failed");
    next.click();
    expect(navigated).toEqual([]);
  });

  test("shows a human document name while retaining the full filename tooltip", () => {
    const { document } = dom;
    const shell = createSheetsShell(document.body, actions());
    shell.setDocumentLabel("Quarterly forecast.spreadsheet.html");
    const label = document.querySelector<HTMLElement>(".sheets-shell__document-label");
    expect(label?.textContent).toBe("Quarterly forecast");
    expect(label?.title).toBe("Quarterly forecast.spreadsheet.html");
  });

  test("renders controller-owned active selection formatting without optimistic toggles", () => {
    const { document } = dom;
    const shell = createSheetsShell(document.body, actions());
    const textColor = document.querySelector<HTMLInputElement>("[aria-label='Text color']");
    const fillColor = document.querySelector<HTMLInputElement>("[aria-label='Fill color']");
    if (!textColor || !fillColor) throw new Error("color controls missing");
    expect(textColor.value).toBe("#000000");
    expect(fillColor.value).toBe("#ffffff");

    shell.setActiveFormat({
      bold: true,
      italic: false,
      merged: true,
      align: "right",
      textColor: "#123456",
      fillColor: "#abcdef",
      numberFormat: "currency",
    });
    expect(document.querySelector("[aria-label='Bold']")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[aria-label='Italic']")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[aria-label='Merge cells']")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[aria-label='Align right']")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[aria-label='Align left']")?.getAttribute("aria-pressed")).toBe("false");
    expect(textColor.value).toBe("#123456");
    expect(fillColor.value).toBe("#abcdef");
    expect(document.querySelector<HTMLSelectElement>("[aria-label='Number format']")?.value).toBe("currency");
  });

  test("expands recovery statuses without truncating the controller message", () => {
    const { document } = dom;
    const shell = createSheetsShell(document.body, actions());
    const message = "The remote spreadsheet changed while this tab held local edits.";
    shell.setStatus("conflict", message);
    const header = document.querySelector<HTMLElement>(".sheets-shell__header");
    const status = document.querySelector<HTMLElement>("[role=status]");
    expect(header?.dataset.status).toBe("conflict");
    expect(status?.textContent).toContain(message);
    expect(status?.textContent).toContain("Save a copy");
    expect(status?.textContent).toContain("Reload latest");

    shell.setStatus("saved");
    expect(header?.dataset.status).toBe("saved");
  });

  test("reports rejected actions and never invents a saved status", async () => {
    const { document } = dom;
    const shell = createSheetsShell(
      document.body,
      actions({
        save: async () => {
          throw new Error("Network unavailable");
        },
      }),
    );
    shell.setStatus("unsaved");
    document
      .querySelector<HTMLButtonElement>("[aria-label='Save spreadsheet']")
      ?.click();
    await settle();
    const status = document.querySelector<HTMLElement>("[role=status]");
    expect(status?.dataset.status).toBe("error");
    expect(status?.textContent).toContain("Network unavailable");
  });

  test("requires an explicit discard confirmation before conflict reload and exposes save-copy", async () => {
    const { document } = dom;
    let reloads = 0;
    let copies = 0;
    const shell = createSheetsShell(
      document.body,
      actions({
        reload: async () => {
          reloads += 1;
        },
        saveCopy: async () => {
          copies += 1;
        },
      }),
    );
    shell.setStatus("conflict");
    const reload = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find((control) => control.textContent === "Reload latest");
    reload?.click();
    expect(document.body.textContent).toContain(
      "Reloading discards unsaved local edits.",
    );
    expect(reloads).toBe(0);
    const saveCopy = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find((control) => control.textContent === "Save a copy");
    saveCopy?.click();
    await settle();
    expect(copies).toBe(1);
    const discard = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find(
      (control) => control.textContent === "Discard local edits and reload",
    );
    discard?.click();
    await settle();
    expect(reloads).toBe(1);
  });

  test("rebuilds conflict recovery controls without duplicate confirmations", () => {
    const { document } = dom;
    const shell = createSheetsShell(document.body, actions());
    shell.setStatus("conflict");
    const reload = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find((control) => control.textContent === "Reload latest");
    reload?.click();
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find((control) => control.textContent === "Cancel");
    cancel?.click();
    const reloadAgain = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".sheets-shell__recovery-button",
      ),
    ).find((control) => control.textContent === "Reload latest");
    reloadAgain?.click();
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".sheets-shell__recovery-button",
        ),
      ).filter(
        (control) => control.textContent === "Discard local edits and reload",
      ),
    ).toHaveLength(1);
  });

  test("disables controls while a controller action is pending", async () => {
    const { document } = dom;
    const pending = deferred();
    createSheetsShell(document.body, actions({ save: () => pending.promise }));
    const save = document.querySelector<HTMLButtonElement>(
      "[aria-label='Save spreadsheet']",
    );
    save?.click();
    expect(save?.disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>("[data-sheet-action='undo']")
        ?.disabled,
    ).toBe(true);
    pending.resolve();
    await settle();
    expect(save?.disabled).toBe(false);
  });

  test("does not alter engine controls while busy and keeps new tabs disabled", () => {
    const { document } = dom;
    const shell = createSheetsShell(document.body, actions());
    const engineInput = document.createElement("input");
    shell.gridHost.append(engineInput);
    shell.setBusy(true);
    shell.setSheets([{ id: "one", name: "Sheet 1" }], "one");

    expect(engineInput.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("[role=tab]")?.disabled).toBe(true);
  });
});
