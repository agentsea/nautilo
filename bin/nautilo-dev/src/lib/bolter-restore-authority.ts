import { inspectDatabaseDumpTables, type TableRowCount } from "./snapshots";

/** Durable history and execution tokens cannot be replayed as current authority. */
export const BOLTER_RESTORE_AUTHORITY_TABLES = [
  "public.bolter_connections",
  "public.bolter_room_bindings",
  "public.external_operator_sessions",
  "public.bolter_inbox_receipts",
  "public.bolter_explicit_shares",
  "public.bolter_outbox",
  "public.external_room_execution_claims",
] as const;

export function assertBolterRestoreTablesAllowed(tables: readonly TableRowCount[]): void {
  const authorityTables: ReadonlySet<string> = new Set(BOLTER_RESTORE_AUTHORITY_TABLES);
  if (tables.some(table => table.rowCount > 0 && authorityTables.has(`public.${table.table}`))) {
    throw new Error("Restore of populated Bolter connection, delivery or execution authority is not supported. "
      + "The target is unchanged. Retain this backup; restoring it requires explicit authority reconciliation "
      + "to prevent delivery replay and stale execution claims. Pausing or disconnecting does not remove this history.");
  }
}

/** Must run before target mutation; applies to full archives and legacy COPY. */
export async function assertBolterRestoreDumpAllowed(path: string): Promise<void> {
  assertBolterRestoreTablesAllowed(await inspectDatabaseDumpTables(path));
}
