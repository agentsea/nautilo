import { inspectSnapshotTables, summarizeSnapshot } from "../lib/snapshots";
import { formatBytes } from "../lib/format-bytes";

export async function inspectCmd(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: nautilo-dev inspect <name>");
    process.exit(1);
  }

  const summary = await summarizeSnapshot(name);
  if (!summary) {
    console.error(`Snapshot "${name}" not found`);
    process.exit(1);
  }

  console.log(`Snapshot: ${summary.name}`);
  console.log(`  Path:        ${summary.dir}`);
  console.log(`  Created:     ${summary.createdAt ?? "unknown"}`);
  console.log(
    `  DB size:     ${summary.dbSizeBytes ? formatBytes(summary.dbSizeBytes) : "unknown"}`,
  );
  console.log(`  Mode:        ${summary.backupMode ?? "dump"}`);
  console.log(
    `  Logto DB:    ${
      summary.logtoDbSizeBytes
        ? formatBytes(summary.logtoDbSizeBytes)
        : "absent"
    }`,
  );
  console.log(`  Env keys:    ${summary.envKeyCount ?? "unknown"}`);
  console.log(`  Full:        ${summary.complete === true ? "yes" : "no"}`);
  console.log(`  Cloneable:   ${summary.cloneEligible === true ? "yes" : "no"}`);
  console.log(`  Source:      ${summary.sourceInstanceId ?? "unknown/legacy"}`);
  console.log(
    `  Migration:   ${summary.lastAppliedMigrationIndex ?? "unknown"}`,
  );
  console.log("");

  if (summary.backupMode === "basebackup") {
    console.log("  Physical basebackup snapshots are not table-inspectable.");
    console.log("  Use dump-mode snapshots when you need per-table row counts or restore preflight.");
    return;
  }

  const tables = await inspectSnapshotTables(name);
  if (tables.length === 0) {
    console.log("  No COPY blocks found in dump (empty database?).");
    return;
  }

  console.log(`  ${"TABLE".padEnd(26)} ${"ROWS".padEnd(8)} COLUMNS`);
  console.log(`  ${"-".repeat(26)} ${"-".repeat(8)} ${"-".repeat(40)}`);
  let total = 0;
  for (const t of tables) {
    total += t.rowCount;
    console.log(
      `  ${t.table.padEnd(26)} ${String(t.rowCount).padEnd(8)} ${t.columns.join(", ")}`,
    );
  }
  console.log("");
  console.log(`  TOTAL: ${total} rows across ${tables.length} table(s).`);
}
