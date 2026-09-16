import { existsSync } from "node:fs";
import { resolveSnapshotsDir } from "../lib/paths";
import { formatBytes } from "../lib/format-bytes";
import { listSnapshots } from "../lib/snapshots";

export async function list(): Promise<void> {
  const dir = resolveSnapshotsDir();
  if (!existsSync(dir)) {
    console.log("No snapshots yet. Use `bun run dev:save <name>` to create one.");
    return;
  }

  const snapshots = await listSnapshots();

  if (snapshots.length === 0) {
    console.log("No snapshots yet. Use `bun run dev:save <name>` to create one.");
    return;
  }

  console.log(`Found ${snapshots.length} snapshot(s) in ${dir}\n`);

  const nameWidth = Math.max(6, ...snapshots.map((s) => s.name.length));
  console.log(
    `${"NAME".padEnd(nameWidth)}  ${"CREATED".padEnd(20)}  ${"MODE".padEnd(10)}  ${"DB SIZE".padEnd(10)}  ${"LOGTO DB".padEnd(10)}  ${"SOURCE".padEnd(12)}  ${"MIG".padEnd(5)}  CLONE`,
  );
  console.log(`${"-".repeat(nameWidth)}  ${"-".repeat(20)}  ${"-".repeat(10)}  ${"-".repeat(10)}  ${"-".repeat(10)}  ${"-".repeat(12)}  ${"-".repeat(5)}  -----`);

  for (const s of snapshots) {
    const created = s.createdAt
      ? new Date(s.createdAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })
      : "—";
    const db = s.dbSizeBytes ? formatBytes(s.dbSizeBytes) : "—";
    const logtoDb = s.logtoDbSizeBytes ? formatBytes(s.logtoDbSizeBytes) : "—";
    const mode = s.backupMode ?? "dump";
    const source = s.sourceInstanceId ?? "legacy";
    const migration =
      s.lastAppliedMigrationIndex === undefined
        ? "—"
        : String(s.lastAppliedMigrationIndex);
    const clone = s.complete === true && s.cloneEligible === true ? "yes" : "no";
    console.log(
      `${s.name.padEnd(nameWidth)}  ${created.padEnd(20)}  ${mode.padEnd(10)}  ${db.padEnd(10)}  ${logtoDb.padEnd(10)}  ${source.padEnd(12)}  ${migration.padEnd(5)}  ${clone}`,
    );
  }
}
