// Modified by Nautilo: remove unused duplicate marker painter; GridCanvas owns paint.
/**
 * Build a per-cell key set (`${rowId}|${colId}`) from the open threads
 * so the renderer can do an O(1) check per cell.
 *
 * Only threads with `resolved: false` and `anchor.kind: 'sheet-cell'` are included.
 * This filters out resolved threads and non-cell anchors (if any).
 *
 * @param threads - Array of comment threads to scan
 * @returns Set of cell keys in format `${rowId}|${colId}`
 */
export function buildOpenThreadKeySet(
  threads: ReadonlyArray<{
    anchor: { kind: string; rowId?: string; colId?: string };
    resolved: boolean;
  }>,
): Set<string> {
  const keys = new Set<string>();
  for (const t of threads) {
    // Skip resolved threads
    if (t.resolved) continue;
    // Skip non-cell anchors
    if (t.anchor.kind !== 'sheet-cell') continue;
    // rowId and colId should be present for sheet-cell anchors, but be defensive
    if (!t.anchor.rowId || !t.anchor.colId) continue;
    keys.add(`${t.anchor.rowId}|${t.anchor.colId}`);
  }
  return keys;
}
