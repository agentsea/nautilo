/**
 * App-owned declaration consumed by the trusted server boot registry.
 * Kept structurally compatible with LiveDirectMutationExtension without
 * importing server code into the isolated app package.
 */
export const spreadsheetLiveToolExtension = {
  appId: "nautilo-spreadsheet",
  mode: "direct_mutation",
  liveToolIds: ["inspect-open-sheet", "edit-open-sheet"],
  taskDelegation: { mode: "direct_only" },
  directMutationToolIds: ["edit-open-sheet"],
  hostOwnsSessionBinding: true,
  hostOwnsIdempotencyKey: true,
  guidance:
    "Inspect the exact requested range in the active Sheets session before editing, or add search to find values or formulas across the active sheet or workbook and follow its query-bound continuation. Inspection reports persisted filters and hidden rows. Copy the returned versionToken into expectedVersion. The host owns the active-document binding and idempotency key. A stale version is refused; inspect again and reconsider the edit. Edits apply atomically through the bound document write and accept no path or target fields. Sort-range moves whole worksheet rows within its row bounds, including row metadata, and requires an explicit header choice.",
} as const;

export type SpreadsheetLiveToolExtension = typeof spreadsheetLiveToolExtension;
