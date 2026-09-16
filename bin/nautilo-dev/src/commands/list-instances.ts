import { homedir } from "node:os";
import { basename } from "node:path";
import { listLocalInstances } from "@nautilo/instance-discovery/node";
import {
  formatAgeShort,
  probeManyInstanceProcessStates,
  type InstanceProcessState,
} from "../lib/process-state";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";

const LIST_INSTANCES_HELP: HelpSpec = {
  name: "list-instances",
  summary:
    "List every ~/.nautilo* instance dir with per-row process state (pid, cwd, age, STALE flag).",
  usage: "bun run dev:list-instances [--json]",
  flags: [
    { flag: "--json", description: "Emit JSON for AI-agent / machine consumption." },
    { flag: "--help, -h", description: "Show this help and exit." },
  ],
  examples: [
    {
      cmd: "bun run dev:list-instances",
      desc: "Human-readable table with instance / project / ports / state / pid / cwd / age / STALE / root.",
    },
    {
      cmd: "bun run dev:list-instances --json | jq '.[] | select(.isStale)'",
      desc: "Filter to just the stale rows.",
    },
  ],
  notes: [
    "STALE = age > NAUTILO_DEV_STALE_UPTIME_H (6h default) AND idle > NAUTILO_DEV_STALE_IDLE_H (6h default).",
    "Use `bun run dev:cleanup-instances` to classify candidates, then `dev:delete-instance <exact-id> --yes` for a proven-local named instance.",
  ],
};

function argvHasJsonFlag(): boolean {
  return process.argv.includes("--json");
}

type LocalInstanceRow = Awaited<ReturnType<typeof listLocalInstances>>[number];

function formatInstancesWithProcessTable(
  rows: LocalInstanceRow[],
  states: InstanceProcessState[],
): string {
  const merged = rows.map((r, i) => ({ row: r, st: states[i]! }));
  const idW = Math.max(12, ...merged.map((m) => m.row.displayId.length), "instance".length);
  const projW = Math.max(
    14,
    ...merged.map((m) => m.row.projectName.length),
    "compose-project".length,
  );
  const rootW = Math.max(24, ...merged.map((m) => m.row.root.length), "root".length);
  const cwdW = Math.max(10, ...merged.map((m) => (m.st.cwd ? basename(m.st.cwd).length : 1)), "cwd".length);

  const lines: string[] = [];
  lines.push(
    `${"instance".padEnd(idW)} ${"compose-project".padEnd(projW)} ${"srv".padStart(5)} ${"wb".padStart(5)} ${"state".padEnd(10)} ${"pid".padStart(6)} ${"cwd".padEnd(cwdW)} ${"age".padStart(8)} ${"stale".padEnd(5)} ${"root".padEnd(rootW)}`,
  );
  lines.push(
    `${"-".repeat(idW)} ${"-".repeat(projW)} ----- ----- ---------- ------ ${"-".repeat(cwdW)} -------- ----- ${"-".repeat(rootW)}`,
  );
  for (const { row: r, st } of merged) {
    const srv = r.serverPort > 0 ? String(r.serverPort) : "—";
    const wb = r.workbenchPort > 0 ? String(r.workbenchPort) : "—";
    const stCol = r.state.padEnd(10);
    const pid = st.serverPid !== null ? String(st.serverPid).padStart(6) : "     —";
    const cwdCell = st.cwd ? basename(st.cwd).padEnd(cwdW) : "—".padEnd(cwdW);
    const ageCell = formatAgeShort(st.ageSeconds).padStart(8);
    const staleCell = (st.isStale ? "STALE" : "—").padEnd(5);
    const note = r.detail ? `  # ${r.detail.slice(0, 80)}` : "";
    lines.push(
      `${r.displayId.padEnd(idW)} ${r.projectName.padEnd(projW)} ${srv.padStart(5)} ${wb.padStart(5)} ${stCol} ${pid} ${cwdCell} ${ageCell} ${staleCell} ${r.root.padEnd(rootW)}${note}`,
    );
  }
  return lines.join("\n");
}

/** Faster than `@nautilo/instance-discovery` default (1.5s) so `list-instances` + probes stay under ~1.5s wall. */
async function probeHealthQuick(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(250) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listInstancesCmd(): Promise<void> {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(formatHelp(LIST_INSTANCES_HELP));
    return;
  }
  const asJson = argvHasJsonFlag();
  const rows = await listLocalInstances(homedir(), { probeHealth: probeHealthQuick });
  const states = await probeManyInstanceProcessStates(
    rows.map((r) => ({ instanceId: r.instanceId, instanceRoot: r.root })),
  );

  if (asJson) {
    const payload = rows.map((r, i) => {
      const p = states[i]!;
      return {
        ...r,
        serverPid: p.serverPid,
        serverPortBound: p.serverPort,
        cwd: p.cwd,
        ageSeconds: p.ageSeconds,
        idleSeconds: p.idleSeconds,
        isStale: p.isStale,
        isRunning: p.isRunning,
      };
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatInstancesWithProcessTable(rows, states));
}
