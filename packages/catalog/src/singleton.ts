import { ToolCatalog } from "./tool-catalog";

let _catalog: ToolCatalog | null = null;

export function initToolCatalog(catalog: ToolCatalog): void {
  _catalog = catalog;
}

/** Clears the process-global catalog (tests that stub `initToolCatalog` must restore this when no prior catalog existed — never leave an empty `ToolCatalog` installed). */
export function clearToolCatalog(): void {
  _catalog = null;
}

export function getToolCatalog(): ToolCatalog | null {
  return _catalog;
}
