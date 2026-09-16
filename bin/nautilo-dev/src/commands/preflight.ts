import {
  isUnhandledDataBearingDrift,
  preflight,
  type TablePreflight,
} from "../lib/preflight";

export async function preflightCmd(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: nautilo-dev preflight <name>");
    process.exit(1);
  }

  let report;
  try {
    report = await preflight(name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Preflight for snapshot "${name}"`);

  console.log("");
  const headerLine = `  ${"TABLE".padEnd(26)} ${"ROWS".padEnd(8)} ${"STATUS".padEnd(22)} NOTE`;
  console.log(headerLine);
  console.log(`  ${"-".repeat(26)} ${"-".repeat(8)} ${"-".repeat(22)} ${"-".repeat(40)}`);

  for (const t of report.tables) {
    console.log(
      `  ${t.table.padEnd(26)} ${String(t.rowCount).padEnd(8)} ${labelOf(t).padEnd(22)} ${t.note}`,
    );
    if (t.addedColumns.length > 0) {
      console.log(`    + added in current schema: ${t.addedColumns.join(", ")}`);
    }
    if (t.removedColumns.length > 0) {
      console.log(`    - missing in current schema: ${t.removedColumns.join(", ")}`);
    }
    if (t.nonNullableAdded.length > 0) {
      console.log(`    ! required with no default: ${t.nonNullableAdded.join(", ")}`);
    }
  }

  console.log("");
  console.log(
    `  TOTAL: ${report.totalRowsEstimatedRestored} / ${report.totalRowsDump} rows would restore cleanly.`,
  );

  const dataLoss = report.tables.filter(isUnhandledDataBearingDrift);
  const emptyDrift = report.tables.filter(
    (t) =>
      (t.status === "SKIP_TABLE_MISSING" ||
        t.status === "SKIP_COLUMN_DROPPED" ||
        t.status === "SKIP_COLUMN_REQUIRED") &&
      t.rowCount === 0,
  );

  if (emptyDrift.length > 0) {
    console.log("");
    console.log(
      `  ${emptyDrift.length} empty table(s) have schema drift (no data loss, but ` +
        `future snapshots with rows would fail):`,
    );
    for (const e of emptyDrift) {
      console.log(`    - public.${e.table} (${e.status}, 0 rows)`);
    }
  }

  if (dataLoss.length > 0) {
    console.log("");
    console.log(
      `  ${dataLoss.length} table(s) WITH DATA would fail restore — need a ` +
        `restore-migration rule:`,
    );
    for (const p of dataLoss) {
      console.log(`    - public.${p.table} (${p.status}, ${p.rowCount} rows)`);
    }
    console.log(
      "  Add an entry to bin/nautilo-dev/src/lib/restore-migrations.ts to handle them.",
    );
    process.exit(1);
  }
}

function labelOf(t: TablePreflight): string {
  switch (t.status) {
    case "OK":
      return "OK";
    case "OK_ADDITIVE":
      return "OK (additive)";
    case "REMAP":
      return "REMAP (registry)";
    case "SKIP_NOT_IN_TARGETS":
      return "SKIP (not targeted)";
    case "SKIP_INTENTIONAL":
      return "SKIP (intentional)";
    case "SKIP_TABLE_MISSING":
      return "SKIP (table gone)";
    case "SKIP_COLUMN_DROPPED":
      return "SKIP (col dropped)";
    case "SKIP_COLUMN_REQUIRED":
      return "SKIP (col required)";
  }
}
