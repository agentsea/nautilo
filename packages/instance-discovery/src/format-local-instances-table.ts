import type { LocalInstanceRow } from "./types";

export function formatLocalInstancesTable(rows: LocalInstanceRow[]): string {
  const lines: string[] = [];
  const idW = Math.max(12, ...rows.map((r) => r.displayId.length), "instance".length);
  const projW = Math.max(14, ...rows.map((r) => r.projectName.length), "compose-project".length);
  const rootW = Math.max(24, ...rows.map((r) => r.root.length), "root".length);

  lines.push(
    `${"instance".padEnd(idW)} ${"compose-project".padEnd(projW)} ${"srv".padStart(5)} ${"wb".padStart(5)} ${"state".padEnd(10)} ${"root".padEnd(rootW)}`,
  );
  lines.push(
    `${"-".repeat(idW)} ${"-".repeat(projW)} ----- ----- ---------- ${"-".repeat(rootW)}`,
  );
  for (const r of rows) {
    const srv = r.serverPort > 0 ? String(r.serverPort) : "—";
    const wb = r.workbenchPort > 0 ? String(r.workbenchPort) : "—";
    const st = r.state.padEnd(10);
    const note = r.detail ? `  # ${r.detail.slice(0, 120)}` : "";
    lines.push(
      `${r.displayId.padEnd(idW)} ${r.projectName.padEnd(projW)} ${srv.padStart(5)} ${wb.padStart(5)} ${st} ${r.root.padEnd(rootW)}${note}`,
    );
  }
  return lines.join("\n");
}
