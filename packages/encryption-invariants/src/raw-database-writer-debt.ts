function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stable identity shared by raw-writer discovery, debt, and frozen closure. */
export function rawDatabaseWriterDebtId(locator: string): string {
  return `debt.db.raw-writer.${fnv1a(locator)}`;
}
