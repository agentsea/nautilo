export type SheetAction =
  | { kind: "undo" | "redo" | "bold" | "italic" | "merge" }
  | { kind: "align"; value: "left" | "center" | "right" }
  | { kind: "fill-color" | "text-color"; value: string }
  | {
      kind: "number-format";
      value: "plain" | "number" | "currency" | "percent" | "date";
    }
  | { kind: "insert-row" | "delete-row" | "insert-column" | "delete-column" };

export type SheetsShellActions = {
  save(): Promise<void>;
  addSheet(name?: string): Promise<void>;
  renameSheet(id: string, name: string): Promise<void>;
  selectSheet(id: string): Promise<void>;
  editorAction(action: SheetAction): Promise<void>;
  reload(): Promise<void>;
  saveCopy(): Promise<void>;
  getDataSetup(range?: string): SheetDataSetup | Promise<SheetDataSetup>;
  applySort(input: { range: string; column: number; direction: "asc" | "desc"; header: boolean }): Promise<void>;
  applyFilter(input: { range: string; column: number; op: SheetFilterOperator; value?: string }): Promise<void>;
  removeFilter(input: { range: string; column: number }): Promise<void>;
  clearFilter(): Promise<void>;
  search(input: SheetSearchInput): Promise<SheetSearchMatch[]>;
  navigateSearch(match: SheetSearchMatch): Promise<void>;
};

export type SheetFilterOperator = "contains" | "notContains" | "equals" | "notEquals" | "isEmpty" | "isNotEmpty" | "in";
export type SheetDataSetup = {
  range: string;
  columns: Array<{ column: number; label: string }>;
  conditions: Record<string, { op: SheetFilterOperator; value?: string; values?: string[] }>;
};
export type SheetSearchInput = { query: string; scope: "sheet" | "workbook"; caseSensitive: boolean; formulas: boolean };
export type SheetSearchMatch = { sheetId: string; sheetName: string; ref: string; value?: string; formula?: string; hidden: boolean };

export type SheetTab = { id: string; name: string };
export type SheetsShellStatus =
  "loading" | "saved" | "unsaved" | "saving" | "conflict" | "error" | "deleted";

export type SheetActiveFormat = {
  bold: boolean;
  italic: boolean;
  merged: boolean;
  align: "left" | "center" | "right";
  textColor: string;
  fillColor: string;
  numberFormat: "plain" | "number" | "currency" | "percent" | "date";
};

export type SheetsShell = {
  gridHost: HTMLDivElement;
  setDocumentLabel(label: string): void;
  setStatus(status: SheetsShellStatus, message?: string): void;
  setSheets(tabs: SheetTab[], activeId: string): void;
  setActiveFormat(format: SheetActiveFormat): void;
  setBusy(busy: boolean): void;
  setFilterStatus(message?: string): void;
  invalidateSearch(message?: string): void;
  dispose(): void;
};

const STATUS_LABELS: Record<SheetsShellStatus, string> = {
  loading: "Loading spreadsheet…",
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  conflict: "This spreadsheet changed elsewhere.",
  error: "Unable to complete that action.",
  deleted: "This spreadsheet was deleted.",
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function button(
  label: string,
  className = "sheets-shell__button",
): HTMLButtonElement {
  const node = element(
    "button",
    className === "sheets-shell__button"
      ? className
      : `sheets-shell__button ${className}`,
  );
  node.type = "button";
  node.textContent = label;
  return node;
}

function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function iconButton(
  label: string,
  paths: readonly string[],
  className = "sheets-shell__icon-button",
): HTMLButtonElement {
  const node = button("", className);
  node.setAttribute("aria-label", label);
  node.title = label;
  node.append(icon(paths));
  return node;
}

const ICONS = {
  sheet: ["M6 3.5h8.5L19 8v12.5H6z", "M14 3.5V8h5", "M9 12h6", "M9 15h6"],
  save: ["M5 4h12l2 2v14H5z", "M8 4v6h8V4", "M8 20v-6h8v6"],
  undo: ["M9 7 4 12l5 5", "M5 12h10a5 5 0 0 1 5 5"],
  redo: ["m15 7 5 5-5 5", "M19 12H9a5 5 0 0 0-5 5"],
  bold: ["M7 4h5a4 4 0 0 1 0 8H7z", "M7 12h6a4 4 0 0 1 0 8H7z"],
  italic: ["M14 4 10 20", "M8 4h8", "M6 20h8"],
  merge: ["M4 7h16v10H4z", "m9 10-3 2 3 2", "m15 10 3 2-3 2"],
  alignLeft: ["M5 6h14", "M5 10h9", "M5 14h14", "M5 18h9"],
  alignCenter: ["M5 6h14", "M8 10h8", "M5 14h14", "M8 18h8"],
  alignRight: ["M5 6h14", "M10 10h9", "M5 14h14", "M10 18h9"],
  textColor: ["M8 17 12 5l4 12", "M9.5 13h5", "M6 20h12"],
  fillColor: ["m8 5 8 8-5 5-8-8z", "M15 7l2-2", "M6 20h12"],
  cells: ["M5 4h14v16H5z", "M5 10h14", "M12 4v16"],
  chevron: ["m9 10 3 3 3-3"],
  plus: ["M12 5v14", "M5 12h14"],
  rename: ["M4 17.5V20h2.5L18 8.5 15.5 6z", "m14.5 7 2.5 2.5"],
  data: ["M5 6h14", "M8 11h8", "M10 16h4", "m16 14 3 3 3-3"],
  search: ["m20 20-4.4-4.4", "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0"],
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to complete that action.";
}

/**
 * Presentation-only shell around the Wafflebase DOM editor. The controller owns
 * document state, engine calls, persistence and all successful status changes.
 */
export function createSheetsShell(
  root: HTMLElement,
  actions: SheetsShellActions,
): SheetsShell {
  root.replaceChildren();
  root.classList.add("sheets-shell");

  let disposed = false;
  let busy = false;
  let tabs: SheetTab[] = [];
  let activeId = "";
  let renameTarget: SheetTab | null = null;
  let conflictConfirming = false;
  let cellsMenuOpen = false;
  let dataOpen = false;
  let dataLoading = false;
  let dataRequest = 0;
  let searchMatches: SheetSearchMatch[] = [];
  let searchIndex = -1;
  let searchRequest = 0;

  const header = element("header", "sheets-shell__header");
  const documentIdentity = element("div", "sheets-shell__document-identity");
  documentIdentity.append(icon(ICONS.sheet));
  const documentLabel = element("span", "sheets-shell__document-label");
  documentLabel.textContent = "Spreadsheet";
  documentLabel.title = "Spreadsheet";
  documentIdentity.append(documentLabel);
  const statusRegion = element("section", "sheets-shell__status");
  statusRegion.setAttribute("aria-live", "polite");
  statusRegion.setAttribute("role", "status");
  const statusText = element("span", "sheets-shell__status-text");
  statusRegion.append(statusText);
  const recovery = element("span", "sheets-shell__recovery");
  statusRegion.append(recovery);
  const saveButton = button("Save", "sheets-shell__save");
  saveButton.setAttribute("aria-label", "Save spreadsheet");
  saveButton.title = "Save spreadsheet";
  saveButton.prepend(icon(ICONS.save));
  header.append(documentIdentity, statusRegion, saveButton);

  const actionBar = element("div", "sheets-shell__actions");
  actionBar.setAttribute("aria-label", "Spreadsheet actions");
  actionBar.setAttribute("role", "toolbar");

  const gridRegion = element("main", "sheets-shell__grid-region");
  const gridHost = element("div", "sheets-shell__grid-host");
  gridHost.setAttribute("aria-label", "Spreadsheet grid");
  gridRegion.append(gridHost);

  const footer = element("footer", "sheets-shell__footer");
  const tabList = element("div", "sheets-shell__tabs");
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Sheet tabs");
  const addButton = iconButton("Add sheet", ICONS.plus, "sheets-shell__tab-action");
  const renameButton = iconButton("Rename active sheet", ICONS.rename, "sheets-shell__tab-action");
  footer.append(addButton, tabList, renameButton);

  const dialog = element("div", "sheets-shell__sheet-dialog");
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "false");
  const dialogTitle = element("label", "sheets-shell__dialog-label");
  const nameInput = element("input", "sheets-shell__name-input");
  nameInput.type = "text";
  nameInput.required = true;
  nameInput.setAttribute("aria-label", "Sheet name");
  const confirmName = button("Create sheet");
  const cancelName = button("Cancel");
  dialog.append(dialogTitle, nameInput, confirmName, cancelName);

  const dataPanel = element("section", "sheets-shell__data-panel");
  dataPanel.hidden = true;
  dataPanel.setAttribute("role", "dialog");
  dataPanel.setAttribute("aria-label", "Sort and filter data");
  const dataHeading = element("strong", "sheets-shell__panel-heading");
  dataHeading.textContent = "Data";
  const rangeInput = element("input", "sheets-shell__field");
  rangeInput.setAttribute("aria-label", "Data range");
  rangeInput.placeholder = "A1:D20";
  const columnInput = element("select", "sheets-shell__field sheets-shell__field--column");
  columnInput.setAttribute("aria-label", "Data column");
  const direction = element("select", "sheets-shell__field");
  direction.setAttribute("aria-label", "Sort direction");
  for (const [value, label] of [["asc", "A to Z"], ["desc", "Z to A"]] as const) {
    const option = element("option"); option.value = value; option.textContent = label; direction.append(option);
  }
  const headerCheck = element("input");
  headerCheck.type = "checkbox";
  headerCheck.checked = true;
  const headerLabel = element("label", "sheets-shell__check");
  headerLabel.append(headerCheck, " Header row");
  const sortHint = element("p", "sheets-shell__data-hint");
  sortHint.textContent = "Sort entire rows. All columns in these rows move together.";
  const applySort = button("Apply sort", "sheets-shell__panel-action");
  const condition = element("select", "sheets-shell__field");
  condition.setAttribute("aria-label", "Filter condition");
  for (const [value, label] of [["contains", "Contains"], ["notContains", "Does not contain"], ["equals", "Equals"], ["notEquals", "Does not equal"], ["isEmpty", "Is empty"], ["isNotEmpty", "Is not empty"], ["in", "Is one of"]] as const) {
    const option = element("option"); option.value = value; option.textContent = label; condition.append(option);
  }
  const filterValue = element("input", "sheets-shell__field");
  filterValue.setAttribute("aria-label", "Filter value");
  filterValue.placeholder = "Value";
  const applyFilter = button("Apply filter", "sheets-shell__panel-action");
  const clearFilter = button("Clear filter", "sheets-shell__panel-action");
  const removeFilter = button("Remove column filter", "sheets-shell__panel-action");
  const filterStatus = element("span", "sheets-shell__filter-status");
  filterStatus.setAttribute("role", "status");
  const dataClose = button("Close", "sheets-shell__panel-action");
  const dataFields = element("div", "sheets-shell__data-fields");
  dataFields.append(rangeInput, columnInput, direction, headerLabel, applySort, condition, filterValue, applyFilter, removeFilter, clearFilter);
  dataPanel.append(dataHeading, dataFields, sortHint, filterStatus, dataClose);

  const searchPanel = element("section", "sheets-shell__search-panel");
  searchPanel.hidden = true;
  searchPanel.setAttribute("role", "search");
  const searchInput = element("input", "sheets-shell__field sheets-shell__search-input");
  searchInput.type = "search";
  searchInput.setAttribute("aria-label", "Find in spreadsheet");
  searchInput.placeholder = "Find";
  const searchScope = element("select", "sheets-shell__field");
  searchScope.setAttribute("aria-label", "Search scope");
  for (const [value, label] of [["sheet", "This sheet"], ["workbook", "Workbook"]] as const) {
    const option = element("option"); option.value = value; option.textContent = label; searchScope.append(option);
  }
  const caseCheck = element("input"); caseCheck.type = "checkbox";
  const caseLabel = element("label", "sheets-shell__check"); caseLabel.append(caseCheck, " Match case");
  const formulaCheck = element("input"); formulaCheck.type = "checkbox"; formulaCheck.checked = true;
  const formulaLabel = element("label", "sheets-shell__check"); formulaLabel.append(formulaCheck, " Formulas");
  const previousMatch = button("Previous", "sheets-shell__panel-action");
  const nextMatch = button("Next", "sheets-shell__panel-action");
  const searchCount = element("span", "sheets-shell__search-count"); searchCount.setAttribute("aria-live", "polite");
  const searchClose = button("Close", "sheets-shell__panel-action");
  searchPanel.append(searchInput, searchScope, caseLabel, formulaLabel, previousMatch, nextMatch, searchCount, searchClose);

  root.append(header, actionBar, gridRegion, footer, dialog, dataPanel, searchPanel);

  const setControlBusyState = () => {
    for (const container of [header, actionBar, footer, dialog, recovery, cellsMenu, dataPanel, searchPanel]) {
      for (const control of Array.from(
        container.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >("button, input, select"),
      )) {
        control.disabled = busy || (dataLoading && container === dataPanel && control !== dataClose);
      }
    }
    renameButton.disabled = busy || !activeId;
    filterValue.disabled = busy || condition.value === "isEmpty" || condition.value === "isNotEmpty";
    removeFilter.disabled = busy || !filterConditions[columnInput.value];
  };

  const setStatus = (status: SheetsShellStatus, message?: string) => {
    header.dataset.status = status;
    statusRegion.dataset.status = status;
    statusText.textContent = message ?? STATUS_LABELS[status];
    recovery.replaceChildren();
    conflictConfirming = false;
    if (status === "conflict") renderConflictRecovery();
  };

  const run = async (work: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    setControlBusyState();
    try {
      await work();
    } catch (error) {
      setStatus("error", errorMessage(error));
    } finally {
      busy = false;
      setControlBusyState();
    }
  };

  const renderConflictRecovery = () => {
    recovery.replaceChildren();
    const saveCopy = button("Save a copy", "sheets-shell__recovery-button");
    saveCopy.addEventListener("click", () => void run(() => actions.saveCopy()));
    const reload = button("Reload latest", "sheets-shell__recovery-button");
    reload.addEventListener("click", () => {
      conflictConfirming = true;
      renderConflictRecovery();
    });
    recovery.append(saveCopy, reload);

    if (!conflictConfirming) return;
    const warning = element("span", "sheets-shell__reload-warning");
    warning.textContent = "Reloading discards unsaved local edits.";
    const confirmReload = button(
      "Discard local edits and reload",
      "sheets-shell__recovery-button",
    );
    confirmReload.addEventListener("click", () => void run(() => actions.reload()));
    const cancelReload = button("Cancel", "sheets-shell__recovery-button");
    cancelReload.addEventListener("click", () => {
      conflictConfirming = false;
      renderConflictRecovery();
    });
    recovery.append(warning, confirmReload, cancelReload);
  };

  const toolbarGroup = () => {
    const group = element("div", "sheets-shell__toolbar-group");
    actionBar.append(group);
    return group;
  };
  const editorButton = (
    group: HTMLDivElement,
    label: string,
    paths: readonly string[],
    action: SheetAction,
  ): HTMLButtonElement => {
    const control = iconButton(label, paths);
    control.dataset.sheetAction = action.kind;
    control.addEventListener(
      "click",
      () => void run(() => actions.editorAction(action)),
    );
    group.append(control);
    return control;
  };

  const historyGroup = toolbarGroup();
  editorButton(historyGroup, "Undo", ICONS.undo, { kind: "undo" });
  editorButton(historyGroup, "Redo", ICONS.redo, { kind: "redo" });

  const formatGroup = toolbarGroup();
  const boldButton = editorButton(formatGroup, "Bold", ICONS.bold, { kind: "bold" });
  const italicButton = editorButton(formatGroup, "Italic", ICONS.italic, { kind: "italic" });
  const mergeButton = editorButton(formatGroup, "Merge cells", ICONS.merge, { kind: "merge" });
  boldButton.setAttribute("aria-pressed", "false");
  italicButton.setAttribute("aria-pressed", "false");
  mergeButton.setAttribute("aria-pressed", "false");

  const alignmentGroup = toolbarGroup();
  const alignmentButtons = new Map<SheetActiveFormat["align"], HTMLButtonElement>();
  for (const value of ["left", "center", "right"] as const) {
    const paths = value === "left"
      ? ICONS.alignLeft
      : value === "center"
        ? ICONS.alignCenter
        : ICONS.alignRight;
    const control = editorButton(alignmentGroup, `Align ${value}`, paths, { kind: "align", value });
    control.setAttribute("aria-pressed", String(value === "left"));
    alignmentButtons.set(value, control);
  }

  const colorGroup = toolbarGroup();
  const colorControl = (
    label: string,
    paths: readonly string[],
    kind: "fill-color" | "text-color",
  ): HTMLInputElement => {
    const wrapper = element("label", "sheets-shell__color-control");
    wrapper.title = label;
    wrapper.append(icon(paths));
    const control = element("input", "sheets-shell__color");
    control.type = "color";
    control.value = kind === "text-color" ? "#000000" : "#ffffff";
    control.setAttribute("aria-label", label);
    control.addEventListener(
      "change",
      () =>
        void run(() => actions.editorAction({ kind, value: control.value })),
    );
    wrapper.append(control);
    colorGroup.append(wrapper);
    return control;
  };
  const textColorControl = colorControl("Text color", ICONS.textColor, "text-color");
  const fillColorControl = colorControl("Fill color", ICONS.fillColor, "fill-color");

  const numberGroup = toolbarGroup();
  const numberFormat = element("select", "sheets-shell__number-format");
  numberFormat.setAttribute("aria-label", "Number format");
  for (const [value, label] of [
    ["plain", "General"],
    ["number", "Number"],
    ["currency", "Currency"],
    ["percent", "Percent"],
    ["date", "Date"],
  ] as const) {
    const option = element("option");
    option.value = value;
    option.textContent = label;
    numberFormat.append(option);
  }
  numberFormat.addEventListener(
    "change",
    () =>
      void run(() =>
        actions.editorAction({
          kind: "number-format",
          value: numberFormat.value as
            "plain" | "number" | "currency" | "percent" | "date",
        }),
      ),
  );
  numberGroup.append(numberFormat);

  const cellsGroup = toolbarGroup();
  const cellsTrigger = button("Cells", "sheets-shell__cells-trigger");
  cellsTrigger.setAttribute("aria-label", "Cells");
  cellsTrigger.setAttribute("aria-haspopup", "menu");
  cellsTrigger.setAttribute("aria-expanded", "false");
  cellsTrigger.title = "Rows and columns";
  cellsTrigger.prepend(icon(ICONS.cells));
  cellsTrigger.append(icon(ICONS.chevron));
  const cellsMenu = element("div", "sheets-shell__cells-menu");
  cellsMenu.hidden = true;
  cellsMenu.setAttribute("role", "menu");
  cellsMenu.setAttribute("aria-label", "Cells actions");
  cellsGroup.append(cellsTrigger);
  root.append(cellsMenu);

  const setCellsMenuOpen = (open: boolean, focusFirst = false) => {
    cellsMenuOpen = open;
    cellsMenu.hidden = !open;
    cellsTrigger.setAttribute("aria-expanded", String(open));
    if (open) {
      const rootRect = root.getBoundingClientRect();
      const triggerRect = cellsTrigger.getBoundingClientRect();
      const menuWidth = cellsMenu.getBoundingClientRect().width || 156;
      const left = Math.max(4, Math.min(
        triggerRect.left - rootRect.left,
        rootRect.width - menuWidth - 4,
      ));
      cellsMenu.style.insetInlineStart = `${left}px`;
      cellsMenu.style.insetInlineEnd = "auto";
      cellsMenu.style.insetBlockStart = `${Math.max(4, triggerRect.bottom - rootRect.top + 4)}px`;
    }
    if (open && focusFirst) {
      cellsMenu.querySelector<HTMLButtonElement>("button")?.focus();
    }
  };
  const menuAction = (label: string, action: SheetAction) => {
    const control = button(label, "sheets-shell__cells-menu-item");
    control.setAttribute("role", "menuitem");
    control.dataset.sheetAction = action.kind;
    control.addEventListener("click", () => {
      setCellsMenuOpen(false);
      void run(() => actions.editorAction(action));
    });
    cellsMenu.append(control);
  };
  menuAction("Insert row", { kind: "insert-row" });
  menuAction("Delete row", { kind: "delete-row" });
  menuAction("Insert column", { kind: "insert-column" });
  menuAction("Delete column", { kind: "delete-column" });
  cellsTrigger.addEventListener("click", () => setCellsMenuOpen(!cellsMenuOpen));
  cellsTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setCellsMenuOpen(true, true);
  });
  const dismissCellsMenu = (event: MouseEvent) => {
    if (cellsMenuOpen && !cellsGroup.contains(event.target as Node) && !cellsMenu.contains(event.target as Node)) {
      setCellsMenuOpen(false);
    }
  };
  const dismissCellsMenuWithKeyboard = (event: KeyboardEvent) => {
    if (!cellsMenuOpen || event.key !== "Escape") return;
    event.preventDefault();
    setCellsMenuOpen(false);
    cellsTrigger.focus();
  };
  document.addEventListener("mousedown", dismissCellsMenu);
  document.addEventListener("keydown", dismissCellsMenuWithKeyboard);

  const dataGroup = toolbarGroup();
  const dataTrigger = iconButton("Data", ICONS.data);
  const searchTrigger = iconButton("Find", ICONS.search);
  dataTrigger.setAttribute("aria-haspopup", "dialog");
  dataTrigger.setAttribute("aria-expanded", "false");
  dataGroup.append(dataTrigger, searchTrigger);
  let filterConditions: SheetDataSetup["conditions"] = {};
  const loadSelectedCondition = () => {
    const current = filterConditions[columnInput.value];
    condition.value = current?.op ?? "contains";
    filterValue.value = current?.values?.join(", ") ?? current?.value ?? "";
    removeFilter.disabled = busy || !current;
    filterValue.disabled = busy || condition.value === "isEmpty" || condition.value === "isNotEmpty";
  };
  const loadDataSetup = async (range?: string): Promise<void> => {
    const request = ++dataRequest;
    dataLoading = true;
    setControlBusyState();
    try {
      const setup = await actions.getDataSetup(range);
      if (request !== dataRequest || !dataOpen) return;
      rangeInput.value = setup.range;
      rangeInput.setCustomValidity("");
      filterConditions = setup.conditions;
      const selected = Number(columnInput.value);
      columnInput.replaceChildren();
      for (const item of setup.columns) {
        const option = element("option"); option.value = String(item.column); option.textContent = item.label; columnInput.append(option);
      }
      columnInput.value = String(setup.columns.some(item => item.column === selected) ? selected : setup.columns[0]?.column ?? "");
      loadSelectedCondition();
    } catch (error) {
      if (request !== dataRequest || !dataOpen) return;
      const message = errorMessage(error);
      rangeInput.setCustomValidity(message);
      rangeInput.reportValidity();
      setStatus("error", message);
    } finally {
      if (request === dataRequest) {
        dataLoading = false;
        setControlBusyState();
      }
    }
  };
  const setDataOpen = (open: boolean) => {
    dataOpen = open;
    dataPanel.hidden = !open;
    dataTrigger.setAttribute("aria-expanded", String(open));
    if (open) {
      void loadDataSetup();
      rangeInput.focus();
    }
    else {
      dataRequest += 1;
      dataLoading = false;
      setControlBusyState();
      dataTrigger.focus();
    }
  };
  dataTrigger.addEventListener("click", () => setDataOpen(!dataOpen));
  dataClose.addEventListener("click", () => setDataOpen(false));
  const selectedColumn = () => {
    const value = Number(columnInput.value);
    if (!Number.isInteger(value) || value < 1) throw new Error("Enter a column number of 1 or greater.");
    return value;
  };
  rangeInput.addEventListener("change", () => {
    void loadDataSetup(rangeInput.value.trim());
  });
  columnInput.addEventListener("change", loadSelectedCondition);
  applySort.addEventListener("click", () => void run(() => actions.applySort({
    range: rangeInput.value.trim(), column: selectedColumn(),
    direction: direction.value as "asc" | "desc", header: headerCheck.checked,
  })));
  applyFilter.addEventListener("click", () => void run(async () => {
    await actions.applyFilter({ range: rangeInput.value.trim(), column: selectedColumn(), op: condition.value as SheetFilterOperator, value: filterValue.value });
    await loadDataSetup(rangeInput.value.trim());
  }));
  removeFilter.addEventListener("click", () => void run(async () => {
    await actions.removeFilter({ range: rangeInput.value.trim(), column: selectedColumn() });
    await loadDataSetup(rangeInput.value.trim());
  }));
  clearFilter.addEventListener("click", () => void run(async () => {
    await actions.clearFilter();
    await loadDataSetup(rangeInput.value.trim());
  }));
  condition.addEventListener("change", () => { filterValue.disabled = condition.value === "isEmpty" || condition.value === "isNotEmpty"; });

  const updateSearch = async () => {
    const request = ++searchRequest;
    const query = searchInput.value;
    searchMatches = [];
    searchIndex = -1;
    searchCount.textContent = query ? "Searching…" : "";
    try {
      const matches = await actions.search({ query, scope: searchScope.value as "sheet" | "workbook", caseSensitive: caseCheck.checked, formulas: formulaCheck.checked });
      if (request !== searchRequest || searchPanel.hidden) return;
      searchMatches = matches;
      searchIndex = -1;
      searchCount.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : query ? "No matches" : "";
    } catch (error) {
      if (request === searchRequest) {
        searchMatches = [];
        searchIndex = -1;
        searchCount.textContent = errorMessage(error);
      }
    }
  };
  const moveSearch = (step: number) => {
    if (!searchMatches.length) return;
    searchIndex = (searchIndex + step + searchMatches.length) % searchMatches.length;
    searchCount.textContent = `${searchIndex + 1} of ${searchMatches.length}${searchMatches[searchIndex].hidden ? " · hidden by filter" : ""}`;
    void run(() => actions.navigateSearch(searchMatches[searchIndex])).finally(() => searchInput.focus());
  };
  const openSearch = () => { searchPanel.hidden = false; searchInput.focus(); searchInput.select(); void updateSearch(); };
  const closeSearch = () => { searchPanel.hidden = true; searchMatches = []; searchIndex = -1; };
  searchInput.addEventListener("input", () => void updateSearch());
  searchScope.addEventListener("change", () => void updateSearch()); caseCheck.addEventListener("change", () => void updateSearch()); formulaCheck.addEventListener("change", () => void updateSearch());
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    if (searchMatches.length) moveSearch(step);
    else void updateSearch().then(() => moveSearch(step));
  });
  previousMatch.addEventListener("click", () => moveSearch(-1)); nextMatch.addEventListener("click", () => moveSearch(1)); searchClose.addEventListener("click", closeSearch);
  searchTrigger.addEventListener("click", openSearch);
  const searchShortcut = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopImmediatePropagation(); openSearch(); }
    else if (event.key === "Escape" && !searchPanel.hidden) { event.preventDefault(); closeSearch(); }
  };
  window.addEventListener("keydown", searchShortcut, true);

  const closeDialog = () => {
    dialog.hidden = true;
    renameTarget = null;
    nameInput.value = "";
  };

  const openDialog = (target: SheetTab | null) => {
    renameTarget = target;
    dialogTitle.textContent = target ? "Rename sheet" : "New sheet name";
    confirmName.textContent = target ? "Rename sheet" : "Create sheet";
    nameInput.value = target?.name ?? "";
    dialog.hidden = false;
    nameInput.focus();
  };

  const submitName = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity("Enter a sheet name.");
      nameInput.reportValidity();
      return;
    }
    nameInput.setCustomValidity("");
    void run(async () => {
      if (renameTarget) await actions.renameSheet(renameTarget.id, name);
      else await actions.addSheet(name);
      closeDialog();
    });
  };

  const renderTabs = () => {
    tabList.replaceChildren();
    for (const tab of tabs) {
      const control = button(tab.name, "sheets-shell__tab");
      control.id = `sheet-tab-${tab.id}`;
      control.setAttribute("role", "tab");
      control.setAttribute("aria-selected", String(tab.id === activeId));
      control.setAttribute("aria-controls", "sheets-grid");
      control.tabIndex = tab.id === activeId ? 0 : -1;
      control.dataset.sheetId = tab.id;
      control.addEventListener(
        "click",
        () => void run(() => actions.selectSheet(tab.id)),
      );
      control.addEventListener("keydown", (event) => {
        const index = tabs.findIndex(({ id }) => id === tab.id);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + tabs.length) % tabs.length
                  : -1;
        if (nextIndex < 0) return;
        event.preventDefault();
        const next = tabs[nextIndex];
        Array.from(
          tabList.querySelectorAll<HTMLButtonElement>("[role=tab]"),
        )[nextIndex]?.focus();
        void run(() => actions.selectSheet(next.id));
      });
      tabList.append(control);
    }
    renameButton.disabled = busy || !activeId;
    setControlBusyState();
  };

  saveButton.addEventListener("click", () => void run(() => actions.save()));
  addButton.addEventListener("click", () => openDialog(null));
  renameButton.addEventListener("click", () => {
    const active = tabs.find((tab) => tab.id === activeId);
    if (active) openDialog(active);
  });
  cancelName.addEventListener("click", closeDialog);
  confirmName.addEventListener("click", submitName);
  nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));
  nameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitName();
  });
  gridHost.id = "sheets-grid";

  setStatus("loading");

  return {
    gridHost,
    setDocumentLabel(label) {
      const fullLabel = label || "Spreadsheet";
      documentLabel.textContent = fullLabel.replace(/\.spreadsheet\.html$/i, "") || "Spreadsheet";
      documentLabel.title = fullLabel;
    },
    setStatus,
    setSheets(nextTabs, nextActiveId) {
      tabs = [...nextTabs];
      activeId = nextActiveId;
      renderTabs();
    },
    setActiveFormat(format) {
      boldButton.setAttribute("aria-pressed", String(format.bold));
      italicButton.setAttribute("aria-pressed", String(format.italic));
      mergeButton.setAttribute("aria-pressed", String(format.merged));
      for (const [alignment, control] of alignmentButtons) {
        control.setAttribute("aria-pressed", String(alignment === format.align));
      }
      textColorControl.value = format.textColor;
      fillColorControl.value = format.fillColor;
      numberFormat.value = format.numberFormat;
    },
    setBusy(nextBusy) {
      busy = nextBusy;
      setControlBusyState();
    },
    setFilterStatus(message) { filterStatus.textContent = message ?? ""; },
    invalidateSearch(message = "Sheet changed. Search again.") {
      searchMatches = [];
      searchIndex = -1;
      searchRequest += 1;
      if (!searchPanel.hidden && searchInput.value) searchCount.textContent = message;
    },
    dispose() {
      disposed = true;
      document.removeEventListener("mousedown", dismissCellsMenu);
      document.removeEventListener("keydown", dismissCellsMenuWithKeyboard);
      window.removeEventListener("keydown", searchShortcut, true);
      root.replaceChildren();
      root.classList.remove("sheets-shell");
    },
  };
}
