import { Spreadsheet, getWorksheetCell, getWorksheetEntries, parseRef, toSref, type Grid, type Sref } from "../engine/browser.js";
import { addSheet, renameSheet, parseSheetHtml, serializeSheetHtml, type SheetDocument } from "./sheet-document";
import { recalculateWorkbook } from "./sheet-calculation";
import { createSheetHistory, createSheetStore } from "./sheet-store";
import { createSheetsShell, type SheetAction, type SheetDataSetup } from "./sheets-shell";
import { SheetSession } from "./sheet-session";
import type { SheetsBridge } from "./sheet-bridge";
import { createEditorInputAdmission } from "./editor-input-admission";
import { captureSheetView, restoreSheetView, type SheetViewState } from "./sheet-view-state";
import { applySheetDataOperation, parseSheetDataRange, searchSheetDocument, sheetDataRange, type SheetDataOperation, type SheetFilterCondition, type SheetSearchMatch } from "./sheet-data";

export async function mountSpreadsheet(
  root: HTMLElement,
  bridge: SheetsBridge,
  options: { createEditor?: (host: HTMLDivElement, theme: "light" | "dark") => Spreadsheet } = {},
): Promise<() => void> {
  const createEditor = options.createEditor ?? ((host, theme) => new Spreadsheet(host, { theme }));
  let document: SheetDocument;
  const history = createSheetHistory();
  let activeId = "";
  let editor: Spreadsheet | undefined;
  let adapter: Awaited<ReturnType<typeof createSheetStore>> | undefined;
  let mounting = false;
  let disposed = false;
  let storeEditing = false;
  let rawEditing = false;
  let formatRead = 0;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const requestedTheme = (): "light" | "dark" => {
    const hostTheme = root.ownerDocument.documentElement.dataset["theme"];
    return hostTheme === "light" || hostTheme === "dark" ? hostTheme : systemTheme.matches ? "dark" : "light";
  };
  let activeTheme = requestedTheme();
  let themeScheduled = false;
  root.dataset["sheetsTheme"] = activeTheme;
  const shell = createSheetsShell(root, {
    save: async () => { await commitPendingInput(); await session.save(); },
    reload: async () => { inputAdmission.discard(); await session.reload(); },
    saveCopy: async () => { await commitPendingInput(); await session.downloadCopy(); },
    addSheet: async (name) => { await commitPendingInput(); await session.edit(async () => {
      shell.gridHost.inert = true;
      try {
        const before = await snapshot();
        const result = addSheet(before, name);
        await mount(result.document, result.tabId);
        history.record(before, result.document, result.tabId);
        shell.invalidateSearch();
      } finally { shell.gridHost.inert = false; }
    }); },
    renameSheet: async (id, name) => { await commitPendingInput(); await session.edit(async () => {
      shell.gridHost.inert = true;
      try {
        const before = await snapshot();
        const next = renameSheet(before, id, name);
        await mount(next);
        history.record(before, next, id);
        shell.invalidateSearch();
      } finally { shell.gridHost.inert = false; }
    }); },
    selectSheet: async (id) => { await commitPendingInput(); await session.run(async () => {
      if (id === activeId) return;
      shell.gridHost.inert = true;
      try {
        const next = await snapshot();
        if (!next.tabs[id]) throw new Error("That sheet no longer exists.");
        if (next.tabs[id].type !== "sheet") throw new Error("This source tab is read-only. Its cached values remain available to formulas.");
        await mount(next, id);
        shell.invalidateSearch("Sheet changed. Search again.");
      } finally { shell.gridHost.inert = false; }
    }); },
    getDataSetup: async (requestedRange) => {
      let setup!: SheetDataSetup;
      await session.run(async () => {
        shell.gridHost.inert = true;
        try {
          await commitPendingInput();
          const current = await snapshot();
          const range = requestedRange ?? sheetDataRange(current, activeId, editor?.getSelectionRangeOrActiveCell());
          const parsed = parseSheetDataRange(range);
          const sheet = current.sheets[activeId];
          if (!sheet || parsed[1].r > Math.max(1, sheet.rowOrder.length) || parsed[1].c > Math.max(1, sheet.colOrder.length)) throw new Error("Data range extends beyond this sheet's stored extent.");
          const canonical = `${toSref(parsed[0])}:${toSref(parsed[1])}`;
          const columnLabel = (column: number) => {
            let value = column, label = "";
            while (value > 0) { value -= 1; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
            return label;
          };
          const columns = Array.from({ length: parsed[1].c - parsed[0].c + 1 }, (_, index) => {
            const column = parsed[0].c + index;
            const header = getWorksheetCell(sheet, { r: parsed[0].r, c: column })?.v?.trim();
            const letter = columnLabel(column);
            return { column, label: header ? `${letter} — ${header}` : letter };
          });
          const filter = sheet.filter;
          const filterRange = filter ? `${toSref({ r: filter.startRow, c: filter.startCol })}:${toSref({ r: filter.endRow, c: filter.endCol })}` : undefined;
          setup = { range: canonical, columns, conditions: filterRange === canonical ? structuredClone(filter!.columns) : {} };
        } finally { shell.gridHost.inert = false; }
      });
      return setup;
    },
    applySort: async (input) => mutateData(() => ({ op: "sort-range", sheetId: activeId, ...input })),
    applyFilter: async ({ range, column, op, value }) => {
      const condition: SheetFilterCondition = op === "isEmpty" || op === "isNotEmpty"
        ? { op }
        : op === "in"
          ? { op, values: (value ?? "").split(",").map(item => item.trim()).filter(Boolean) }
          : { op, value: value ?? "" };
      await mutateData((before) => {
        const canonical = `${toSref(parseSheetDataRange(range)[0])}:${toSref(parseSheetDataRange(range)[1])}`;
        const filter = before.sheets[activeId]?.filter;
        const existingRange = filter ? `${toSref({ r: filter.startRow, c: filter.startCol })}:${toSref({ r: filter.endRow, c: filter.endCol })}` : undefined;
        return { op: "set-filter", sheetId: activeId, range: canonical, columns: { ...(existingRange === canonical ? filter!.columns : {}), [column]: condition } };
      });
    },
    removeFilter: async ({ range, column }) => mutateData((before) => {
      const parsed = parseSheetDataRange(range);
      const canonical = `${toSref(parsed[0])}:${toSref(parsed[1])}`;
      const filter = before.sheets[activeId]?.filter;
      const existingRange = filter ? `${toSref({ r: filter.startRow, c: filter.startCol })}:${toSref({ r: filter.endRow, c: filter.endCol })}` : undefined;
      if (!filter || existingRange !== canonical || !filter.columns[String(column)]) throw new Error("That column does not have an active filter.");
      const columns = structuredClone(filter.columns); delete columns[String(column)];
      return Object.keys(columns).length ? { op: "set-filter", sheetId: activeId, range: canonical, columns } : { op: "clear-filter", sheetId: activeId };
    }),
    clearFilter: async () => mutateData(() => ({ op: "clear-filter", sheetId: activeId })),
    search: async (input) => {
      let matches: SheetSearchMatch[] = [];
      await session.run(async () => {
        shell.gridHost.inert = true;
        try { await commitPendingInput(); matches = searchSheetDocument(await snapshot(), { ...input, sheetId: activeId }); }
        finally { shell.gridHost.inert = false; }
      });
      return matches;
    },
    navigateSearch: async (match) => navigateSearch(match),
    editorAction,
  });
  const inputAdmission = createEditorInputAdmission(shell.gridHost, (pending) => {
    rawEditing = pending;
    syncLocalEditing();
  }, () => editor?.getSelectionRangeOrActiveCell()?.[0]);
  const session = new SheetSession(bridge, {
    async snapshot() { return serializeSheetHtml(await snapshot()); },
    async replace(content) {
      // Freeze input before the first calculation await, not only when the
      // replacement editor is mounted. This closes the clean-refresh race.
      shell.gridHost.inert = true;
      try { await mount(await recalculateWorkbook(parseSheetHtml(content))); history.clear(); shell.invalidateSearch(); }
      finally { shell.gridHost.inert = false; }
    },
    status: (state, message) => shell.setStatus(state, message),
    label(path) { shell.setDocumentLabel(path?.split(/[\\/]/).pop() ?? "Spreadsheet"); },
  });

  function syncLocalEditing(): void {
    if (!mounting && !disposed) {
      session.setLocalEditing(rawEditing || storeEditing);
      if (!rawEditing && !storeEditing) refreshTheme();
    }
  }
  function refreshTheme(): void {
    if (disposed || !editor || mounting || rawEditing || storeEditing || themeScheduled || requestedTheme() === activeTheme) return;
    themeScheduled = true;
    let applied = false;
    void session.run(async () => {
      if (!editor || !adapter || rawEditing || storeEditing || disposed) return;
      const nextTheme = requestedTheme();
      if (nextTheme === activeTheme) return;
      const view = captureSheetView(editor, shell.gridHost);
      if (!view) return;
      // The pinned engine has no public theme setter. Recreate its view only
      // after text entry finishes, with input frozen across the snapshot await.
      shell.gridHost.inert = true;
      try {
        const next = await adapter.snapshot();
        await mount(next, activeId, nextTheme, view);
        applied = true;
      } finally { shell.gridHost.inert = false; }
    }).catch(() => { /* the session reports the failure without discarding edits */ })
      .finally(() => { themeScheduled = false; if (applied) refreshTheme(); });
  }
  async function commitPendingInput(): Promise<void> {
    if (!inputAdmission.pending) return;
    if (!editor) throw new Error("Spreadsheet is still loading.");
    await inputAdmission.commit(editor);
  }

  async function snapshot(): Promise<SheetDocument> {
    if (!adapter) throw new Error("Spreadsheet is still loading.");
    const currentAdapter = adapter;
    const base = await currentAdapter.snapshot();
    const calculated = await recalculateWorkbook(base);
    if (!await currentAdapter.adoptCalculated(base, calculated)) {
      throw new Error("The sheet changed during calculation. Your edits are kept; save again.");
    }
    document = calculated;
    if (!disposed) editor?.render();
    return calculated;
  }
  function context(): void {
    if (!editor || !document) return;
    inputAdmission.restoreAfterRender();
    refreshTheme();
    const currentEditor = editor;
    const request = ++formatRead;
    const merged = currentEditor.isSelectionMerged();
    void Promise.all([currentEditor.getActiveStyle(), currentEditor.getActiveEffectiveAlign()]).then(([style, align]) => {
      if (disposed || editor !== currentEditor || request !== formatRead) return;
      shell.setActiveFormat({
        bold: style?.b ?? false, italic: style?.i ?? false, merged, align,
        textColor: style?.tc ?? (activeTheme === "dark" ? "#ffffff" : "#000000"),
        fillColor: style?.bg ?? (activeTheme === "dark" ? "#1e1e1e" : "#ffffff"),
        numberFormat: style?.nf ?? "plain",
      });
    }).catch((error: unknown) => {
      if (!disposed && editor === currentEditor && request === formatRead) shell.setStatus("error", String(error));
    });
    bridge.context.set({
      selection: { sheetId: activeId, range: editor.getSelectionRangeOrActiveCell() },
      summary: { documentType: "spreadsheet", activeSheetId: activeId, activeSheetName: document.tabs[activeId]?.name, dirty: session.dirty,
        workflow: "This selection is advisory. Use inspect-open-sheet and edit-open-sheet only when the host supplies a separate trusted live mini-app session; otherwise inspect and edit the saved document target." },
    });
  }
  async function mount(
    next: SheetDocument,
    preferredId = activeId,
    theme = activeTheme,
    view?: SheetViewState,
  ): Promise<void> {
    mounting = true;
    shell.gridHost.inert = true;
    const stage = root.ownerDocument.createElement("div");
    stage.style.cssText = "position:absolute;inset:0;width:100%;height:100%;visibility:hidden";
    let prepared: Awaited<ReturnType<typeof createSheetStore>> | undefined;
    let candidate: Spreadsheet | undefined;
    let committed = false;
    try {
      const nextId = next.tabs[preferredId] ? preferredId : next.tabOrder.find(id => next.tabs[id].type === "sheet")!;
      if (disposed) return;
      prepared = await createSheetStore(next, nextId, () => {
        if (adapter === prepared && !mounting && !disposed) {
          inputAdmission.noteStoreChange();
          session.changed();
          shell.invalidateSearch();
          context();
        }
      }, history, (active) => {
        if (adapter !== prepared) return;
        storeEditing = active;
        syncLocalEditing();
      });
      if (disposed) return;
      // Prepare a complete replacement at the real viewport size while the
      // current editor and its draft stay intact. Failure removes only staging.
      shell.gridHost.append(stage);
      candidate = createEditor(stage, theme);
      stage.style.position = "absolute";
      await candidate.initialize(prepared.store);
      candidate.onValidationError((message) => {
        if (!disposed && editor === candidate) shell.setStatus("error", message);
      });
      if (disposed) return;
      const model = () => adapter === prepared ? document : next;
      candidate.setGridResolver((name, refs) => {
        const current = model();
        const id = current.tabOrder.find(id => current.tabs[id].name.toLocaleUpperCase() === name.toLocaleUpperCase());
        if (!id) return undefined;
        const grid: Grid = new Map();
        for (const [ref, cell] of getWorksheetEntries(current.sheets[id])) if (refs.has(ref)) grid.set(ref, cell);
        return grid;
      });
      candidate.setFormulaResolver((name) => {
        const current = model();
        const id = current.tabOrder.find(id => current.tabs[id].name.toLocaleUpperCase() === name.toLocaleUpperCase());
        if (!id) return undefined;
        const formulas = new Map<Sref, string>();
        for (const [ref, cell] of getWorksheetEntries(current.sheets[id])) if (cell.f) formulas.set(ref, cell.f);
        return formulas;
      }, next.tabs[nextId].name);
      await prepared.withoutHistory(async () => { await candidate!.recalculateCrossSheetFormulas(); });
      if (view) restoreSheetView(candidate, shell.gridHost, view);
      if (disposed) return;
      editor?.cleanup();
      adapter?.dispose();
      shell.gridHost.replaceChildren(stage);
      editor = candidate;
      adapter = prepared;
      document = next;
      activeId = nextId;
      activeTheme = theme;
      root.dataset["sheetsTheme"] = theme;
      inputAdmission.discard();
      storeEditing = false;
      stage.style.visibility = "visible";
      committed = true;
      editor.onSelectionChange(context);
      shell.setSheets(document.tabOrder.map(id => ({ id, name: document.tabs[id].name })), activeId);
      const filter = document.sheets[activeId]?.filter;
      shell.setFilterStatus(filter ? `${Object.keys(filter.columns).length} active ${Object.keys(filter.columns).length === 1 ? "filter" : "filters"}` : "No active filter");
      context();
    } finally {
      if (!committed) {
        candidate?.cleanup();
        prepared?.dispose();
        stage.remove();
      }
      mounting = false;
      shell.gridHost.inert = false;
    }
  }
  async function mutateData(operation: (before: SheetDocument) => SheetDataOperation): Promise<void> {
    await commitPendingInput();
    await session.edit(async () => {
      shell.gridHost.inert = true;
      try {
        const before = await snapshot();
        const resolved = operation(before);
        const next = await applySheetDataOperation(before, resolved);
        await mount(next, activeId);
        history.record(before, next, activeId, resolved.op === "clear-filter" ? undefined : parseSheetDataRange(resolved.range));
        shell.invalidateSearch();
      } finally { shell.gridHost.inert = false; }
    });
  }
  async function navigateSearch(match: SheetSearchMatch): Promise<void> {
    if (!editor) throw new Error("Spreadsheet is still loading.");
    await session.run(async () => {
      shell.gridHost.inert = true;
      try {
        await commitPendingInput();
        if (match.sheetId !== activeId) await mount(await snapshot(), match.sheetId);
        if (!editor) throw new Error("Spreadsheet is still loading.");
        await editor.focusCell(parseRef(match.ref));
      } finally { shell.gridHost.inert = false; }
    });
  }
  async function editorAction(action: SheetAction): Promise<void> {
    if (!editor) throw new Error("Spreadsheet is still loading.");
    await commitPendingInput();
    if (action.kind === "undo" || action.kind === "redo") {
      await session.edit(async () => {
        shell.gridHost.inert = true;
        try {
          const current = await snapshot();
          const change = action.kind === "undo" ? history.undo(current, activeId) : history.redo(current, activeId);
          if (!change.result.success) return false;
          await mount(await recalculateWorkbook(change.document));
          shell.invalidateSearch();
        } finally { shell.gridHost.inert = false; }
      });
      return;
    }
    await session.run(async () => {
    if (!editor || disposed) return;
    shell.gridHost.inert = true;
    try {
    const range = editor.getSelectionRangeOrActiveCell();
    switch (action.kind) {
      case "bold": await editor.toggleStyle("b"); break;
      case "italic": await editor.toggleStyle("i"); break;
      case "merge": await editor.toggleMergeCells(); break;
      case "align": await editor.applyStyle({ al: action.value }); break;
      case "fill-color": await editor.applyStyle({ bg: action.value }); break;
      case "text-color": await editor.applyStyle({ tc: action.value }); break;
      case "number-format": await editor.applyStyle({ nf: action.value }); break;
      case "insert-row": if (range) await editor.insertRows(range[0].r); break;
      case "delete-row": if (range) await editor.deleteRows(range[0].r, range[1].r - range[0].r + 1); break;
      case "insert-column": if (range) await editor.insertColumns(range[0].c); break;
      case "delete-column": if (range) await editor.deleteColumns(range[0].c, range[1].c - range[0].c + 1); break;
    }
    context();
    } finally { shell.gridHost.inert = false; }
    });
  }
  const saveShortcut = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && shell.gridHost.contains(event.target as Node)) {
      event.preventDefault(); event.stopImmediatePropagation();
      void editorAction({ kind: event.shiftKey ? "redo" : "undo" }).catch(error => shell.setStatus("error", String(error)));
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void commitPendingInput().then(() => session.save()).catch((error: unknown) => {
        shell.setStatus("error", error instanceof Error ? error.message : String(error));
      });
    }
  };
  const dispose = () => {
    disposed = true;
    session.dispose();
    inputAdmission.dispose();
    editor?.cleanup();
    adapter?.dispose();
    shell.dispose();
    window.removeEventListener("keydown", saveShortcut, true);
    window.removeEventListener("pagehide", dispose);
    themeObserver.disconnect();
    systemTheme.removeEventListener("change", refreshTheme);
  };
  const themeObserver = new MutationObserver(refreshTheme);
  themeObserver.observe(root.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  systemTheme.addEventListener("change", refreshTheme);
  window.addEventListener("keydown", saveShortcut, true);
  window.addEventListener("pagehide", dispose, { once: true });
  try { await session.start(); refreshTheme(); }
  catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
